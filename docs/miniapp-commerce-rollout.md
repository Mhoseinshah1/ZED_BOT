# Mini App commerce — rollout, operations and rollback

Phase 1 of `miniapp-commerce-parity`: the complete commerce and delivery
lifecycle inside the Mini App, sharing ONE authority with the bot
(`docs/telegram-miniapp-foundation.md` §4.9 documents the architecture;
`docs/miniapp-user-parity-matrix.md` maps every capability).

## 1. The nine switches

All stored in `Setting`, all seeded `"false"`, all toggled from the bot:
**پنل ادمین → تنظیمات مینی اپ ⚙️** (OWNER only, atomic CAS toggles). The API
re-reads the relevant switch FRESH and FAIL-CLOSED at every commerce
boundary; a database read failure blocks exactly like a disabled switch.

| Key | Gates |
| --- | --- |
| `miniapp_commerce_enabled` | master: catalog, drafts, quotes, checkouts, history surfaces, the two new tabs |
| `miniapp_wallet_topup_enabled` | top-up checkout creation |
| `miniapp_card_to_card_enabled` | card method offer + browser receipt upload |
| `miniapp_online_payments_enabled` | Zarinpal / NOWPayments / Stars initiation |
| `miniapp_service_delivery_enabled` | subscription URL / configs / QR exposure |
| `miniapp_service_renewal_enabled` | renewal quotes/checkouts |
| `miniapp_extra_volume_enabled` | extra-volume quotes/checkouts |
| `miniapp_extra_time_enabled` | extra-time quotes/checkouts |
| `miniapp_other_products_enabled` | other-product catalog, checkout, input forms |

Provider-level settings stay authoritative: a payment method is offered only
when the existing provider gating (gateway row enabled, adapter configured,
per-user rules) AND the Mini App switch are both on. Wallet payment
additionally honours `wallet_payment_enabled`, top-up honours
`wallet_topup_enabled` and its min/max settings — the same rows the bot uses.

## 2. Staged rollout (recommended order)

1. **Internal OWNER accounts** — enable `miniapp_commerce_enabled` only.
   Browse the catalog, quote, confirm; verify pre-invoices match the bot's
   for the same products and users. No payment method is on yet, so no money
   can move.
2. **Selected test users** — keep only the master switch on; have testers
   walk catalog → username → quote → confirm (checkouts expire naturally).
3. **Wallet purchases only** — enable nothing else; wallet pay uses the
   bot's own settlement transaction. Watch order fulfilment latency (the
   follow-up queue consumer in the bot logs `miniapp commerce follow-up`).
4. **Card-to-card** — enable `miniapp_card_to_card_enabled`. Browser
   receipts land in the SAME admin review queue; verify an approval from the
   bot updates the Mini App status page.
5. **Online gateways** — enable `miniapp_online_payments_enabled` after
   verifying callback URLs in production; the status page settles on poll
   exactly like the bot's check button.
6. **Renewal / add-ons** — enable the three service-add-on switches.
7. **Full rollout** — enable delivery + other products; announce.

Each step is independently reversible; disable order is simply the reverse.

## 3. Disabling and rollback

- Flipping any switch OFF blocks NEW work at the next request (fresh reads;
  no cache to wait out) and hides the UI on the next flags fetch. Stale
  browser state gets `403 FEATURE_DISABLED`.
- Already-settled operations are never corrupted: settled payments stay
  settled, paid orders keep fulfilling through the bot, delivered content
  stays readable on the owner's detail route, pending admin receipt reviews
  stay reviewable in the bot.
- Full rollback = all nine switches off. The bot flows are untouched — they
  never depended on any of this. No migration rollback is needed: the Phase-1
  migration (`20260728211529_miniapp_commerce_parity`) is additive (nullable
  columns + one new table).
- A Redis outage degrades only follow-up latency: the bot's settlement sweep
  (60 s) fulfils Mini-App-initiated settlements as fallback, including
  wallet-paid orders (the sweep's recovery pass was widened for this).

## 4. Receipt storage and retention (§13)

Browser card-to-card receipts are stored as verified bytes in
`MiniAppReceiptUpload` (sniffed MIME allowlist jpeg/png/pdf, 5 MiB cap,
bounded image dimensions, uuid identity, SHA-256 recorded; no filesystem
path, no public URL, never logged). `ManualReceipt.uploadId` links the row
into the existing review pipeline; admins see the bytes re-sent as media in
the bot. Retention (worker sweep, 15-min cadence):

- **abandoned** uploads (never consumed) are deleted after their 24 h TTL;
- **consumed** evidence is deleted 30 days after the linked payment reaches
  a terminal state. The `ManualReceipt` financial record itself is never
  deleted — only the bytes age out, like an expiring Telegram file_id.

## 5. Monitoring and safe log codes

- API commerce failures log through the privacy-safe classifier only:
  `{operation: "commerce-*", code: db-*|unexpected}` — never bodies, ids
  beyond the operation, or raw errors.
- Boot report: `MINIAPP_COMMERCE_RATE_LIMIT` joins the per-knob startup
  lines (error level when unusable).
- Bot consumer: `bot:miniapp-consumer` logs job outcomes
  (`dispatched|not-paid|fulfilled|not-settled|notified:N|payment-missing`).
- Worker sweep: `worker:receipt-upload-cleanup` logs counts only.
- Financial invariants to watch are unchanged from the bot: the wallet
  ledger suites' invariants, `FinancialReconciliationCase` OPEN counts, and
  the settlement sweep's logs.

## 6. Notifications (§18)

Fulfilment messages, receipt notices and all durable notifications keep
their existing bot/worker origin regardless of the initiating transport;
the Mini App additionally shows the same outcome on its status screens.
Checkouts created from the Mini App carry `origin = "MINIAPP"` (bookkeeping
only — financial meaning identical).

## 7. Environment

One new optional knob: `MINIAPP_COMMERCE_RATE_LIMIT` (default 30/min/user,
per-client ×3, clamped 1..10000, soft-fail like every Mini App knob). No new
required environment. Stars initiation from the Mini App uses
`createInvoiceLink` against the Bot API over plain HTTPS with the existing
`TELEGRAM_BOT_TOKEN`; settlement still arrives as bot updates.
