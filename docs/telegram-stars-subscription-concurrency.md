# Telegram Stars Subscription — Concurrency & Invariants

## Idempotency spine

```
one Service              → one automation funding method   (mandate serviceId @unique)
one telegram_charge_id   → one charge row                  (@unique)
one charge               → one Payment                     (@unique)
one charge               → one CheckoutSession              (@unique)
one charge               → one Order                        (@unique)
one charge               → at most one applied renewal
one failed charge        → at most one Stars refund
no charged cycle silently disappears
```

## Race handling

| Race | Resolution |
| --- | --- |
| Two initial `successful_payment` updates | charge id `@unique` + CAS RECEIVED→SETTLING; one settles, the other returns the existing result |
| Two recurring updates for the same charge | same charge id → idempotent replay |
| Manual renewal vs. recurring renewal | the per-service Redis lock inside `executeRenewalOrder` serialises both; each unique charge applies exactly one renewal from the authoritative current expiry |
| Wallet mandate vs. Stars enrollment | mandate `serviceId @unique` — one wins; a Stars enrollment flips the mandate only with explicit supersede consent |
| Two enrollment confirmations | `upsert` on the mandate + a live-pending reuse — never two subscriptions/mandates |
| Duplicate refund calls | compare-and-set on the charge status — one refund only |
| Restart after charge, before local Payment | the charge id arrives again (or worker recovery replays) and settles once |
| Restart after settlement, before fulfilment | the charge is `FULFILLING` with an Order; re-drive dispatches fulfilment idempotently |

Database constraints and compare-and-set transitions are authoritative; Redis
locks are coordination only.

## Phase 2.1 — recovery & Update races

The same `telegramPaymentChargeId @unique` spine keeps the new recovery and
Bot API 10.2 Update paths idempotent. See
`telegram-stars-subscription-recovery.md` for the full engine.

| Race | Resolution |
| --- | --- |
| Recovered charge vs. live `successful_payment` for the same charge id | charge id `@unique` — one settles; the live path only **upgrades** `periodEndSource RECOVERED_DERIVED → LIVE_EXACT`, with **no** second charge/Payment/Order/renewal (convergence) |
| Two recovery scans finding the same transaction | `SETTLE_RECOVERED_CHARGE` is idempotent on the charge id; the second is an "already" no-op |
| Live `failed` update vs. worker EXPIRATIONS both marking PAST_DUE | idempotent state write + dedup key on the notification — one PAST_DUE, one notice |
| PAST_DUE vs. a delayed charge settling | the settled charge wins: `PAST_DUE → ACTIVE`, and the stale PAST_DUE/REQUIRES_ACTION notification is cancelled by delivery revalidation |
| `refunded_payment` Update vs. `RETRY_REFUND` job | CAS on the charge status `REFUND_PENDING → REFUNDED`; whichever confirms first wins, the other is an idempotent no-op (never a second `refundStarPayment`) |
| Cursor advance vs. API error mid-run | progress persists **per page**; an error never resets the offset — the next run resumes from the persisted position |
| Reactivation vs. an open refund/reconciliation or a wallet mandate | reactivation is **blocked** (never creates a Payment/Order); the mandate `serviceId @unique` remains the exclusivity authority |
