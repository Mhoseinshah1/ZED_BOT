# Notification Engine — Security Guarantees (Phase 1)

The notification engine handles a bot token, user Telegram ids, subscription
tokens/links and panel credentials. None of them may leak into a queue payload,
a database snapshot, a log line, or a Telegram message.

## Secrets never leave their boundary

- **Bot token** — `apps/worker/src/config.ts` `botToken()` resolves it through the
  ONE shared contract `resolveTelegramBotTokenFromEnv` (canonical
  `TELEGRAM_BOT_TOKEN`, legacy `BOT_TOKEN` fallback, conflicting pair fails
  closed; see `docs/telegram-bot-token.md`), IDENTICAL to the bot. It is used only
  to build the `https://api.telegram.org/bot<token>/…` request URL in
  `telegram.ts` and never appears in a log, error, return value, queue payload,
  or DB row (worker diagnostics expose only the token SOURCE key-name, never
  bytes). Every Telegram failure is collapsed to a short safe code
  (`rate-limited`, `forbidden`, `chat-not-found`, `network-error`, …).
- **Subscription url / token, panel credentials, provider payloads, prices** —
  never read into a notification. The scan writes a `payloadSnapshot` with ONLY:
  a `MessageTemplate` key, allowlisted display variables (a friendly or **masked**
  service name, a remaining-time label, a percentage) and button specs. Delivery
  renders strictly from that snapshot, so a rendered message *cannot* contain a
  secret it never received. (`notification-delivery.test.ts` asserts a service's
  subscription token/url appear in neither the sent body nor the stored
  snapshot.)
- **Service display name** — `serviceDisplayName` prefers a friendly product/
  note name; otherwise it **masks** the raw remote username (`maskServiceName`,
  4-char head + ellipsis), so the technical remote identity is never stored in a
  snapshot or log.

## Callback data carries no identifiers

Notification buttons use `ntf:<shortId>:<action>`:
- `shortId` = the notification id's first 8 hex chars (never the full uuid);
- `action` = a one-letter code (`s` open, `r` renew, `v` extra-volume, `x`
  dismiss).

It never contains a full service id, user id, product id, panel id, Telegram id,
price, or credential. On click the bot:
1. resolves the notification **owner-scoped** (`getOwnedNotificationByShortId`,
   which requires `userId` match) — a foreign or expired notification is
   indistinguishable (no existence oracle);
2. reloads the service and re-validates its current state + capability;
3. records the interaction idempotently (a unique `(notification, type)` makes a
   retry a no-op — no metric inflation);
4. invokes the existing Service entry flow.

## Preference & disable safety

- The engine is **globally disabled by default** (`automated_notifications_enabled`
  seeds `false`, and every reader defaults to `false`). No migration, seed,
  deploy, or test setup ever sends a real notification.
- Delivery re-checks the master switch, the user category gate, and the
  per-service gate *at send time*; a notification whose preferences changed
  after scheduling is CANCELLED before sending.
- Direct/transactional messages (receipts, support answers, explicitly requested
  sends) do not flow through this engine and are never suppressed by its
  switches.

## Admin authority

All admin mutations on the notification page (enable/disable master, toggle
rules, run the Telegram test) are **OWNER-only** (`ctx.admin?.role === "OWNER"`).
Enabling the master switch passes a fail-safe activation gate (Redis reachable,
worker heartbeat + notification status fresh, ≥1 rule enabled, a live Telegram
test to the acting owner succeeds); any failure keeps the engine disabled with a
specific reason. Disabling is always allowed.

## Operational logging

Worker logs use the structured logger with safe fields only — short entity id
prefixes, status codes, counts, durations. No usernames, links, tokens,
credentials, message bodies, or full ids. The anti-recursion discipline of the
log-delivery pipeline is preserved (the notification engine never writes
SystemLog rows about its own delivery).

## Checkout-payment reminders (Phase 2)

Same guarantees extended to the two new rules:

- Payload snapshots + callbacks carry only safe display values (product name,
  payable amount, a short checkout reference, a payment-method LABEL) — never a
  full checkout/payment/user/product/panel/Telegram id, provider authority,
  external reference, callback payload, receipt content, card data, customer-form
  values or a per-user price. (`checkout-notification-delivery.test.ts` asserts a
  provider authority appears in neither the sent body nor the snapshot.)
- Callback data is `ntf:<shortId>:<action>` with `c` (continue/reselect), `d`
  (view checkout), `n` (suppress this checkout). Every click re-resolves the
  notification owner-scoped, reloads the checkout owner-scoped, and re-validates
  live financial state — visibility is never authorization, the snapshot is
  never financial truth.
- Notification handlers NEVER settle a payment, create an Order, approve a
  receipt, spend Wallet, provision, or alter reconciliation. A retry is a NEW
  Payment created only by the existing method-selection flow. Failed Payments are
  immutable. An open reconciliation case blocks retry navigation.
- Both rules are OWNER-only to mutate and disabled by default; enabling passes a
  fail-safe activation gate. Raw gateway errors never reach users.

## Customer win-back (Phase 3)

Same guarantees extended to the MARKETING rule:

- Payload snapshots + callbacks carry only safe display values (`inactive_days`,
  an optional safe `last_service_name` = the user's own service note, an optional
  `last_product_name` snapshot) — never a subscription URL/token, panel data,
  price, **lifetime spend**, internal customer-value/segment, provider payload,
  receipt content, Telegram id, or full user/order id. The lapse-cycle fingerprint
  is HASHED before it enters the dedupe key, payload meta or any log
  (`winback-delivery.test.ts` asserts neither the anchor order id nor the raw
  fingerprint appears in the sent body).
- Callback data is `ntf:<shortId>:<action>` with `g` (view plans → the existing
  storefront), `w` (wallet → the existing wallet page), `z` (snooze), `o`
  (marketing opt-out); confirmations use `wb:<verb>:<shortId>`. Every click
  re-resolves the notification owner-scoped — a foreign/absent short id gets the
  same safe toast (no existence reveal). Persian labels are never action ids.
- Navigation NEVER creates a payment, checkout, order or service, spends the
  wallet, or starts auto-renewal. Snooze writes ONLY
  `CustomerRetentionPreference.winbackSnoozedUntil` (win-back only, idempotent);
  the permanent opt-out writes ONLY `User.marketingMessagesEnabled` and leaves
  service/payment/support notifications untouched.
- Current eligibility is re-checked from authoritative rows at delivery — the
  snapshot is never trusted for it; opt-out, snooze and fresh service state are
  all re-validated before send. The admin preview and test-send create no audience
  notification, no dedupe, no lifecycle history; the test-send goes only to the
  requesting OWNER with sample values. The rule is OWNER-only to mutate, disabled
  by default, behind a fail-safe activation gate.

## Phase 4 — analytics & attribution

- **No fabricated engagement**: no open/read/impression is ever recorded or
  reported. The strongest delivery fact is `status = SENT`. Every attribution
  requires a persisted `NotificationInteraction` (click) — proximity alone never
  attributes.
- **No PII in analytics output**: reports and the CSV contain only aggregate
  counts, type/kind labels and Toman sums — never a user id, order id,
  notification id, service name or Telegram id.
- **`evidenceSnapshot` is safe**: only types, kind, four timestamps,
  entity-equality booleans and window seconds — never a price beyond the order's
  own `finalPriceToman`, a subscription link, credential or provider payload.
- **CSV export** is OWNER-only + separately switchable; it neutralises formula
  injection (`= + - @` / control-char prefixes), RFC-4180 quotes, and is written
  to a `0600` temp file removed after send.
- **After-commit hook** carries only `orderId`, is fail-soft and non-blocking —
  analytics can never delay or fail a payment fulfillment.
- **Attribution table** uses soft references (no FK), so retention cleanup never
  cascades between notification/financial rows and analytics.
