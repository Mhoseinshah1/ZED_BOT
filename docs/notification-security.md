# Notification Engine — Security Guarantees (Phase 1)

The notification engine handles a bot token, user Telegram ids, subscription
tokens/links and panel credentials. None of them may leak into a queue payload,
a database snapshot, a log line, or a Telegram message.

## Secrets never leave their boundary

- **Bot token** — read from `BOT_TOKEN` in `apps/worker/src/config.ts`, used only
  to build the `https://api.telegram.org/bot<token>/…` request URL in
  `telegram.ts`. It never appears in a log, error, return value, queue payload,
  or DB row. Every Telegram failure is collapsed to a short safe code
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
