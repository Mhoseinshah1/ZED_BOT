# Service-checkout username selection + optional subscription note

`feat/service-checkout-username-note`

Every **paid VPN service purchase** now lets the buyer choose the **real remote
panel account username** and add an **optional private subscription note** before
the pre-invoice. This document is the contract for that flow: what it changes,
the durable data model, the reservation state machine, how each payment method
persists it, and how provisioning / recovery consume it.

The username chosen here **is** the account username created on the panel
(Marzban/XUI) — the same identity slot the naming pipeline calls
`resolvedRemoteUsername`. It is **not** a Persian display name, nickname, human
name, friendly title, or a post-provisioning rename, and it never replaces an
existing service's username.

---

## 1. Where it applies

Inserted for a **new paid SERVICE_PRODUCT purchase that provisions a normal VPN
Service**, across:

- normal retail checkout (`user:buy:prod:*`),
- the public Pricing catalog direct buy (`user:price:bs:*`),
- a representative-priced SERVICE purchase (`user:rep:*`),
- **all** payment methods: wallet, card-to-card receipt, gateway (Zarinpal /
  NOWPayments), and one-shot Telegram Stars.

**Not** applied to: OTHER_PRODUCT, renewals, extra volume, extra time, location
change, existing services, free trials, admin/manual creation, transfer, or
rename. Renewal / extra-time / extra-volume operations preserve the existing
username **and** note (they use their own draft types and never touch these
fields).

## 2. Flow

```
product selection
  → username method page      (choose: type my own | random)
     → custom text input       → validate + reserve → confirm
     → random                  → reserve → confirm (regenerate available)
  → username confirmation      → «تأیید و ادامه»
  → optional subscription note (type it | «رد کردن» to skip → stores null)
  → EXISTING pre-invoice        (now also shows «یوزرنیم» + «یادداشت»)
  → EXISTING payment flow
  → EXISTING provisioning pipeline
```

The single gate lives in `renderPreInvoice` (`checkout.handler.ts`): a SERVICE
draft whose `serviceCustomization.completed !== true` is diverted to the
username/note steps. Because all three entry points converge on
`renderPreInvoice`, this one check covers them all. `CO_CB.CONTINUE` re-guards
completeness as defense in depth.

Two bounded text-input flows — `checkout:service_username` and
`checkout:service_note` — are registered in `INTERRUPTIBLE_CHECKOUT_FLOWS` and
dispatched from `app.ts`, so navigating away cleanly abandons them.

## 3. Username rules

- Canonical regex: `^[a-z][a-z0-9_]{7,15}$` — 8–16 ASCII chars, first char a
  lowercase letter, the rest lowercase letters / digits / underscore.
- Normalization: trim edge whitespace, lowercase. **No** transliteration, **no**
  silent removal of invalid characters — an invalid value is rejected with a
  typed reason so the buyer sees a clear error.
- **Random**: opaque, `u_`-prefixed (e.g. `u_k7m4q2x9`), generated purely from
  `node:crypto` (rejection sampling; never `Math.random`). No human / dictionary
  / animal / place word, no Telegram id / db id / phone / order id / sequential
  counter / timestamp / other PII. Bounded retry (≤10 candidates). Random values
  also satisfy the canonical regex.

Pure helpers: `packages/shared/src/service-username.ts`
(`validateServiceUsername`, `generateRandomServiceUsername`).

## 4. Optional note rules

- Persian / English / digits / emoji allowed (ZWNJ `U+200C` and ZWJ `U+200D`
  are preserved for Persian text and emoji sequences).
- Normalization: unify CR/CRLF and `U+2028`/`U+2029` to `\n`, tabs → space, trim
  edges, collapse 3+ newlines to a paragraph break.
- Rejected (fail closed, never stripped): C0/C1 control characters and bidi /
  invisible formatting characters (`U+202A–202E`, `U+2066–2069`, LRM/RLM, ALM,
  ZWSP, BOM).
- Max **120 code points** (emoji count as their code points).
- Skip stores an explicit `null`.
- Stored in a clearly-named field, HTML-escaped at every render. It is **never**
  the internal `zedbot order:…` panel marker and is **never** pushed to the panel.

Pure helper: `normalizeServiceNote`.

## 5. Data model (one forward-only migration)

`20260724202030_service_checkout_username_note` — fully additive:

- `ServiceUsernameMode` enum: `CUSTOM | RANDOM`.
- `ServiceUsernameReservationStatus` enum: `HELD | BOUND | CONSUMED | RELEASED | EXPIRED`.
- `Order.serviceNoteSnapshot String?` — the immutable buyer note captured at checkout.
- `Service.userNote String?` — the buyer note copied onto the provisioned service.
- `ServiceUsernameReservation` — the durable reservation (see §6).

`Order.namingSnapshot` (the existing immutable identity contract) gains an
optional `selectionSource` (`USER_CUSTOM | USER_RANDOM | STRATEGY`) and
`selectedAt` — additive, so legacy snapshots parse unchanged.

## 6. Reservation state machine (DB-authoritative)

`ServiceUsernameReservation` is the **single authority** for the invariant
"one active reservation per `(panelId, normalizedUsername)`" — never an in-memory
Set, Redis-only lock, or Telegram-session flag.

Uniqueness is a **filtered unique index**: `@@unique([panelId, activeUsernameKey])`
where the app keeps `activeUsernameKey = normalizedUsername` while
`HELD/BOUND/CONSUMED` and NULLs it on `RELEASED/EXPIRED`. Because Postgres treats
NULLs as distinct, a released username's slot frees for re-use while two live
holders are forbidden; a check-then-insert race surfaces as `P2002` and is
resolved by re-reading the winner. `Service.username @unique` (global) plus a
service-layer availability check additionally block cross-panel collisions.

```
HELD  ── bindReservationToCheckout ──▶ BOUND ── consumeReservationForOrder ──▶ CONSUMED
  │                                      │
  └── release / TTL expiry ──────────────┴──▶ RELEASED / EXPIRED
```

- **HELD** — short TTL (30 min) while the buyer decides. Reclaimed by the sweep
  once the TTL passes.
- **BOUND** — attached to a durable `CheckoutSession` (at `createCheckoutSession`)
  and the settled `Order` (at settlement). TTL cleared; expiry then derives from
  the linked checkout/order state.
- **CONSUMED** — a `Service` was created; terminal success, never reclaimed.
- **RELEASED / EXPIRED** — freed; slot re-usable.

All transitions are CAS `updateMany` with a status guard. Same `(userId,
draftNonce, username)` idempotently refreshes the hold; changing the username
inserts the new hold **before** releasing the old one (never loses the hold on a
`P2002`).

Service: `apps/bot/src/services/service-username-selection.service.ts`.

## 7. Availability check (read-only, pre-payment)

`checkServiceUsernameAvailability` returns a typed outcome and **never mutates a
panel** — the only remote call is the read-only `getServiceAccount` probe:

| Outcome | Meaning |
|---|---|
| `AVAILABLE` | free locally + remotely (`notFound`) |
| `TAKEN_LOCAL` | a `Service.username` already holds it (global) |
| `TAKEN_REMOTE` | the panel reports the account exists |
| `RESERVED` | an active reservation holds it |
| `PANEL_UNAVAILABLE` | panel not ACTIVE |
| `UNVERIFIABLE` | remote read inconclusive / failed |
| `INVALID` | fails the canonical regex |

A remote/panel failure is **never** reported as `AVAILABLE`. No panel account is
ever created to test a name; no account is created+deleted.

## 8. Checkout draft + snapshot

`CheckoutDraft.serviceCustomization` (session-only UI state):
`{ usernameMode, normalizedUsername, reservationId, note | null,
usernameConfirmedAt, completed }`. The durable authority is the DB reservation +
`CheckoutSession.productSnapshot`.

`buildProductSnapshot` freezes `serviceUsername`, `serviceUsernameMode`,
`serviceUsernameSelectionSource`, `serviceUsernameReservationId`, and
`serviceUserNote` into `productSnapshot` **while the Telegram session is alive**,
so every payment method provisions from the same immutable copy. The username/note
never travel in a callback payload.

## 9. Payment-method persistence

- Session-alive capture: `buildProductSnapshot` (`checkout.service.ts`).
- Reservation → BOUND at checkout creation: `createCheckoutSession`.
- Each Order-create site copies `Order.serviceNoteSnapshot` and attaches the
  reservation to the settled order:
  - wallet — `wallet-payment.service.ts` (`executeWalletOrderPayment`),
  - card-to-card — `receipt-review.service.ts` (`approveReceiptPayment`),
  - gateway + one-shot Stars — `gateway-payment.service.ts` (`settleGatewayPayment`).

The username identity is frozen onto `Order.namingSnapshot` exactly once by
`ensureOrderNamingSnapshot`, which reads the user selection from the durable
snapshot via `checkoutNamingCapture` and resolves it verbatim.

## 10. Provisioning + recovery

- **Provisioning** (`provisioning.service.ts`): resolves the username from the
  immutable `Order.namingSnapshot` (a user-selected username is used verbatim —
  the panel strategy/counter is **not** run), acquires the existing
  provisioning lock, uses the existing adapter create + idempotency ladder, and in
  the persist transaction creates the `Service` with the exact username, copies
  `Order.serviceNoteSnapshot → Service.userNote`, and marks the reservation
  `CONSUMED`. A username **collision** (an external actor took it) flows through
  the existing adapter-conflict → refund path — no silent replacement.
- **Startup recovery** (`startup-recovery.service.ts`): `adoptPanelAccount` reads
  the exact username from the immutable snapshot, copies
  `serviceNoteSnapshot → userNote`, and marks the reservation `CONSUMED` under the
  original owner — no recompute, no refund. A positively-proven absent account
  routes to the existing refund path.

## 11. Cleanup

`apps/worker/src/reservations/cleanup.ts` — `startReservationCleanupLoop` runs an
unconditional, bounded (`SCAN_BATCH × MAX_BATCHES`), idempotent, race-safe DB
sweep (reusing the worker's interval pattern):

1. `HELD` past its TTL → `EXPIRED` (frees the slot).
2. `BOUND` whose linked checkout is dead (`EXPIRED/CANCELLED/FAILED_REFUNDED`),
   with no surviving `PAID/PROVISIONING/COMPLETED` order and no `Service` →
   `EXPIRED`.

`CONSUMED` reservations are never touched. Every transition is a CAS on the prior
status, so a concurrent settlement/provisioning path always wins the race.

## 12. Display

The service detail page shows «یادداشت:» (the `userNote`, or «ندارد»), HTML-escaped;
the account username appears as the «نام سرویس» header. The pre-invoice shows both
the chosen username and the note. Reservation ids, nonces, `namingSnapshot` JSON,
the internal panel marker, tokens, and db ids are never rendered.

## 13. Privacy / logging

The raw note is never written to app logs, operational Telegram logs, `SystemLog`,
`AuditLog`, exception messages, queue job names, or callback data. Reservation /
cleanup code logs only safe categories (panel id/type, error category, counts) —
never a raw username, note, Telegram id, or reservation ownership token.

## 14. Text registry

Operator-editable copy is seeded (create-if-missing, never overwriting operator
edits): message templates `svc_username_method`, `svc_username_custom_prompt`,
`svc_note_prompt`; button texts `svc_username_custom`, `svc_username_random`,
`svc_username_regen`, `svc_username_method_back`, `svc_username_confirm`,
`svc_note_skip`. Routing binds to `CO_CB.*` constants, never to a label.

## 15. Transfer-future invariant

If service transfer is added later: the username is unchanged, the note moves with
the service, and ownership transfer never recomputes the identity snapshot. No
speculative transfer tables are added now.

## 16. Tests

`apps/bot/tests/service-checkout-username-note.test.ts` — validation, crypto
random, note normalization, reservation lifecycle + filtered-unique, availability
outcomes, the naming short-circuit, and the cleanup sweep.
