# ZED_BOT database schema

Phase 2 delivers the complete Prisma schema for the Telegram VPN sales bot.
The schema is the contract for all later phases — bot menus, payments, panel
provisioning and the admin UI all build on these tables without changing
their meaning.

Source of truth: [`packages/database/prisma/schema.prisma`](../packages/database/prisma/schema.prisma)

## Conventions and money rules

- **Money is TOMAN as `Int`** — every amount field ends in `Toman`. No
  floats, no decimals, one consistent unit everywhere.
- **Data volumes are bytes as `BigInt`** (`volumeBytes`, `usedBytes`,
  `remainingBytes`).
- **Telegram IDs are `BigInt`** (`telegramId`, `sourceChatId`,
  `telegramChatId`).
- **Enums over strings** for every known status/type.
- **IDs are UUID strings.**
- **`...ByAdminId` audit fields are soft references** (plain strings without
  FK constraints): audit history must survive admin-row changes, and log
  writes must never fail on referential integrity. Structural ownership
  (user → order, order → payment, panel → service, ...) uses real relations.
- **Financial and service history is never hard-deleted**: payments, orders,
  services, wallet transactions, receipts, referral records and logs use
  status values and soft-delete timestamps (`deletedAt`, `DELETED` states).
  Only temporary artifacts (expired `CheckoutSession`s) may be cleaned by a
  future worker job.
- **Snapshot fields** (`productNameSnapshot`, `panelNameSnapshot`,
  `productPriceSnapshot`, ...) freeze what was sold at purchase time, so
  renaming or repricing products/panels never rewrites history.

## Main entities

| Area | Models |
| --- | --- |
| Access | `Admin` (roles: OWNER / SELLER / SUPPORT / RECEIPT_REVIEWER), `AdminPermission` (fine-grained permissions, future) |
| Users | `User` (groups F / N / N2, wallet totals, referral stats, test-account limits, message preferences, security/KYC state) |
| Wallet | `WalletTransaction` — immutable ledger with `balanceBefore/AfterToman`; `User.balanceToman` is the cached materialization |
| Panels | `Panel` (Marzban/XUI connection, feature toggles, pricing, test settings, username patterns, capacity), `UserHiddenPanel` |
| Catalog | `ProductCategory`, `Product` (SERVICE_PRODUCT / OTHER_PRODUCT) |
| Discounts | `DiscountCode`, `DiscountCodeUsage` |
| Checkout | `CheckoutSession` — the pre-order invoice (see below) |
| Orders | `Order` with full snapshots, `OtherProductOrder` for non-VPN products |
| Payments | `PaymentGateway`, `CardToCardAccount`, `Payment`, `ManualReceipt`, `UserHiddenPaymentGateway`, `StarsPricingSetting` |
| Services | `Service` (provisioned VPN account), `ServiceRating`, `ServiceEventLog` |
| Referrals | `Referral` (one row per referred user), `ReferralCommission` |
| Engagement | `TestAccountHistory`, `WheelSpinHistory` |
| Support | `SupportTicket`, `SupportMessage` (schema-ready; UI currently uses private-chat mode) |
| Content | `TutorialCategory`, `Tutorial`, `TutorialMedia`, `MessageTemplate`, `ButtonText` (locale `fa`) |
| Broadcast | `Broadcast`, `BroadcastRecipient` |
| Observability | `LogTopic` (Telegram log-group topics), `SystemLog`, `AuditLog` |
| Config | `Setting` — flexible key/value store for global configuration |

## Why CheckoutSession exists before Order

Showing an invoice must **not** create a final `Order`. The flow is:

```
user picks product
      │
      ▼
CheckoutSession (PENDING, holds product snapshot + prices + discount)
      │  payment succeeds
      ▼
Payment (APPROVED)  ──►  Order (PAID → PROVISIONING)
      │  provisioning succeeds                │ provisioning fails
      ▼                                       ▼
Order COMPLETED + Service ACTIVE     Order FAILED + wallet refund
```

- Abandoned invoices stay as `CheckoutSession` rows (`PENDING` → `EXPIRED`)
  and never pollute order history; a future worker may clean sessions older
  than ~5 days (not implemented yet).
- An `Order` is only created around payment/fulfilment, so every order row
  represents real intent-to-buy — and failed provisioning is preserved as a
  `FAILED` order with the refund recorded in the wallet ledger.

## Important status flows

- **Payment**: `PENDING → PENDING_REVIEW (card-to-card receipt) → APPROVED /
  REJECTED`, or `PENDING → APPROVED / FAILED / EXPIRED` for gateways.
  `DELETED` is a soft-hide for review lists.
- **Order**: `PENDING_PAYMENT / WAITING_RECEIPT / PENDING_REVIEW → PAID →
  PROVISIONING → COMPLETED`, with `FAILED / CANCELLED / REFUNDED` as terminal
  branches.
- **Service**: `CREATING → ACTIVE → (DISABLED / LIMITED / EXPIRED) →
  DELETED`, `FAILED` when provisioning never succeeded. `panelDeletedAt`
  tracks deletion on the panel side separately from bot-side soft deletion.
  `Service.expiresAt` is **nullable**: services with unlimited time
  (`durationDays = 0`) have no expiration date at all.
- **Wallet**: `WalletTransaction` rows are append-only; every row records the
  balance before and after, so the ledger can always be replayed and audited.
- **Referral**: `Referral` links referrer→referred once (unique
  `referredUserId`); each qualifying order creates a `ReferralCommission`
  (`PENDING → PAID / CANCELLED`) optionally linked to the payout
  `WalletTransaction`.

## Support mode

The `SupportMode` enum (`PRIVATE_CHAT` / `TICKET`) is schema-ready, but the
**active** support mode is stored as the `Setting` key `support_mode`
(seeded as `PRIVATE_CHAT`). The `SupportTicket` / `SupportMessage` tables
exist so the ticket mode can be switched on in a later phase without a
migration.

## Seed baselines (never overwritten)

The seed is idempotent and only creates what is missing — operator edits are
never clobbered:

- **Settings**: `bot_name`, `maintenance_mode`, `support_username`,
  `force_join_enabled`, `support_mode`.
- **Log topics**: 13 rows with stable keys and Persian titles.
- **Message templates**: `start_text`, `bot_off_text`, `support_text`,
  `faq_text`.
- **Button texts**: a 16-key baseline for the future main menu and
  navigation (`buy_subscription`, `renew_service`, `my_services`, `wallet`,
  `support`, `tutorials`, `free_test`, `referral`, `other_products`,
  `pricing`, `representative_request`, `lucky_wheel`, `back`, `main_menu`,
  `cancel`, `confirm`). `currentText` starts equal to `defaultText`; only
  `currentText` is meant to be edited by operators.
- **Stars pricing**: one `StarsPricingSetting` row (`singletonKey =
  "default"`) so later phases can read/update the single global row without
  existence checks.

## Intentionally NOT implemented in Phase 2

- No bot menus, API business routes, or admin UI.
- No payment gateway API logic (schema only — gateways, receipts, Stars
  pricing are tables, not integrations).
- No Marzban/XUI API calls (panel connection settings are stored, unused).
- No purchase/renewal/provisioning flows.
- No checkout-session cleanup worker.
- No stock-item implementation for OTHER_PRODUCT (`stockEnabled` is
  schema-ready only).
- No ticket UI (support stays in private-chat mode; tables are ready).
- Seed intentionally ships only minimal Persian template/button baselines —
  final copy arrives with the bot-menu phase.
