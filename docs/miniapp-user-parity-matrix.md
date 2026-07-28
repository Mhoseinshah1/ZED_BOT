# Mini App user-parity matrix — inventory before implementation

Status date: matches `main` at commit `6150a87` (merge of PR #143, Mini App
Support Center). This document is the Phase-1 pre-implementation inventory
required before any commerce code lands: every currently-implemented USER
capability of the Telegram bot, its authoritative domain function, its data
model, its dependencies, and its Mini App rollout plan.

Placeholders and dead callbacks are listed in §5 and are **not** treated as
features.

Phases:

- **Phase 1 (this program):** the complete commerce + delivery lifecycle
  (catalog → checkout → discount → payment → settlement → provisioning /
  fulfilment → delivery → renewal / extra volume / extra time → history).
- **Phase 2 (explicitly deferred):** free trial, service toggle /
  link-regeneration / diagnostics / connection guides, notifications
  preferences, referral / representative surfaces, Stars monthly
  subscriptions, auto-renewal mandates, support attachments, ticket
  close/rating. Admin surfaces stay in the bot indefinitely.

---

## 1. Architecture decision — one authority, two transports

The authoritative commerce layer already exists and is transport-independent
in all money paths: it lives in `apps/bot/src/services/*` and never renders
Telegram UI itself (handlers do). The Mini App API therefore **reuses those
modules directly** instead of growing a second commerce system:

1. `apps/bot` exposes its service layer through a package `exports` map
   (`@zedbot/bot/services/*`, `@zedbot/bot/core/*`). `apps/api` declares a
   workspace dependency on `@zedbot/bot`.
2. The API's import graph must stay free of Telegram transport. The one
   fusion point — `gateway-payment.service.ts` also containing
   `fulfillSettledGatewayOrder` / the settlement sweep (which import
   `order-fulfillment.service` and its grammY senders) — is split: the
   settlement runner moves to a bot-only module; the grammY-free
   create/record/settle core stays importable by the API.
3. A static contract test (pattern of the existing SL-6 logging test) walks
   the resolved import graph of `apps/api/src` and fails if `grammy`,
   `apps/bot/src/handlers/**`, `apps/bot/src/keyboards/**`, or any
   `*-views.ts` module appears. §4 of the program is enforced mechanically,
   not by convention.
4. Fulfilment and user notification always execute in the **bot process**
   (it owns the grammY `Api`, panel adapters, Redis service locks). The
   established precedent is the wallet auto-renewal engine: another process
   signals work through BullMQ and the bot runs the consumer
   (`startAutoRenewalConsumer(bot.api)`). Mini-App-initiated wallet
   settlements enqueue a fulfilment job the bot consumes; online-gateway
   settlements keep flowing through the existing 60-second settlement sweep.
   The sweep's crash-recovery pass remains the fallback for both, so a lost
   queue message can delay but never lose fulfilment.
5. The frontend computes nothing financial. Every price, discount,
   affordability, grant, expiry, stock and status decision is produced
   server-side by the same functions the bot uses, and rendered by the Mini
   App from stable machine codes through Persian i18n.

Public identifiers: the repo's existing opaque scheme (8-hex uuid prefix,
`packages/shared/src/public-ids.ts`, owner-scoped `startsWith` resolution
with `take: 2` ambiguity → 404) is extended to checkouts, payments, orders
and other-product orders. Database UUIDs never cross the wire; cursors stay
AES-256-GCM-sealed (`apps/api/src/miniapp/cursor.ts`).

Client idempotency: the existing `MiniAppRequestIdempotency` model
(`@@unique([userId, clientRequestId])` + SHA-256 payload fingerprint,
`schema.prisma:2158`) is extended to commerce operations; a replay returns
the original result, a same-key/different-payload request is rejected as a
conflict. Underneath, the domain's own idempotency
(`Payment.idempotencyKey`, `CheckoutSession.settledByPaymentId @unique`,
`Order.checkoutSessionId @unique`, CAS transitions) stays the real guarantee.

## 2. Rollout switches (all default **false**, owner-controlled)

Defined in `@zedbot/shared` beside the other feature-switch keys, seeded
`"false"` by `seedSettings()`, toggled from the bot admin settings area, and
**re-read fresh (uncached, fail-closed) at every authoritative mutation
boundary** in the API — the same discipline as
`tryGetBooleanSettingFresh()`. A provider is usable in the Mini App only when
its existing provider gating (gateway row enabled + adapter available +
provider env/config) **and** the relevant Mini App switch are both on.

| Setting key | Gates |
| --- | --- |
| `miniapp_commerce_enabled` | master: catalog browse, checkout draft, discount apply, pre-invoice, orders/payments history surfaces |
| `miniapp_wallet_topup_enabled` | wallet top-up checkout creation from the Mini App |
| `miniapp_card_to_card_enabled` | card-to-card method offer + browser receipt upload |
| `miniapp_online_payments_enabled` | Zarinpal / NOWPayments (/ Stars where safe) initiation from the Mini App |
| `miniapp_service_delivery_enabled` | delivery surface: subscription URL / configs / QR exposure in the Mini App |
| `miniapp_service_renewal_enabled` | renewal checkout from service detail |
| `miniapp_extra_volume_enabled` | extra-volume checkout from service detail |
| `miniapp_extra_time_enabled` | extra-time checkout from service detail |
| `miniapp_other_products_enabled` | other-product catalog, checkout, customer-input forms, delivered-content reveal |

Fail-closed rules each switch must satisfy (tested): hidden UI when off,
`403 FEATURE_DISABLED` (stable code) on stale browser state, no effect on
already-settled operations, and mutation boundaries re-check on every
request — a switch flipped mid-flow blocks the *next* mutation.

## 3. Capability matrix — Bot user surface vs Mini App

Columns: **Bot entry** (callback/handler), **Authority** (domain function),
**Models**, **Pay/prov deps**, **Notifications**, **Mini App today**,
**Target**, **Switch**, **Required tests**.

### 3.1 Entry & access gates

| Capability | Bot entry | Authority | Models | Pay/prov deps | Notifications | Mini App today | Target | Switch | Required tests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Start / registration / referral attach | `/start` `start.handler.ts:24` | `registerOrUpdateUser`, `applyReferralIfEligible` (`referral.service.ts:53`) | User, Referral | — | — | n/a (bot-native) | stays bot | — | existing |
| Access gates (maintenance → status → terms → force-join) | `ensureUserAccess` (`user-access.middleware.ts:79`) | same + `@zedbot/force-join` | Setting, TermsDocument/Acceptance, ForceJoinChannel | — | ops log on misconfig | ✅ `evaluateMiniAppAccess` re-run per request (`access-policy.ts:112`) | done | — | existing (`miniapp-force-join`, `miniapp-api`) |
| Session auth (initData → cookie) | n/a | `validateMiniAppInitData`, `issueMiniAppSession` (shared) | — | — | — | ✅ | done | — | existing (`miniapp-initdata`, `miniapp-session`) |

### 3.2 Catalog & pricing

| Capability | Bot entry | Authority | Models | Pay/prov deps | Notifications | Mini App today | Target | Switch | Required tests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Pricing catalog «تعرفه‌ها» | `user:pricing` → `pricing.handler.ts:614`, routes `user:price:*` | `loadUserRetailCatalog` (`catalog.service.ts:207`), `minRetailPrice`, `isProductVisible:154`, templates `pricing_page_*` | Product, ProductCategory, Panel, MessageTemplate | — | — | ❌ | **Phase 1** | `miniapp_commerce_enabled` | visibility parity with bot incl. group rules; disabled product/panel/category hidden; rep-surface pricing |
| Service-purchase browse (panel → category → product) | `user:buy` → `checkout.handler.ts:288`; `user:buy:panel/cat/prod` | `purchasablePanels:39`, `visibleServiceProducts:59`, `getProductByShortId` | Product, Panel, ProductCategory | `isPanelSellable`, XUI inbound validation | — | ❌ | **Phase 1** | `miniapp_commerce_enabled` | ordering parity; stale/foreign/malformed public id → 404; single-panel auto-skip parity |
| Other-products browse | `user:other_products` → `checkout.handler.ts:377` | `visibleOtherProducts` (`catalog.service.ts:88`) | Product | — | — | ❌ | **Phase 1** | `miniapp_other_products_enabled` (+ master) | visibility parity; kind/profile surfaced safely |

### 3.3 Checkout, discount, pre-invoice

| Capability | Bot entry | Authority | Models | Pay/prov deps | Notifications | Mini App today | Target | Switch | Required tests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Service username / note customization | nonce routes `user:co:un/nt:*` (`checkout.handler.ts:527`) | `reserveServiceUsername` / `reserveRandomServiceUsername` / `releaseHeldReservationForDraft` (`service-username-selection.service.ts`), `validateServiceUsername` (shared) | ServiceUsernameReservation | naming config gate `validateNamingConfig` | — | ❌ | **Phase 1** | `miniapp_commerce_enabled` | reservation HELD→claim lifecycle; global uniqueness; abandonment release |
| Checkout draft + frozen snapshot | «ادامه خرید» `user:co:continue` → `createCheckoutSession` (`checkout.service.ts:139`) | `buildProductSnapshot:49` (frozen product/price/naming/inbound/rep marker), reservation claim in-tx `:238` | CheckoutSession, RepresentativePurchase | — | — | ❌ | **Phase 1** | `miniapp_commerce_enabled` | immutable snapshot; price change before settlement uses frozen price; superseded PENDING cancel parity |
| Discount apply/clear | `user:co:discount` (+ renew/ev/et variants) | `validateDiscountCode:47` (UX), `calculateDiscountAmount:32`, `claimDiscountUsage:149` (in-tx, `FOR NO KEY UPDATE`) | DiscountCode, DiscountCodeUsage | — | — | ❌ | **Phase 1** | `miniapp_commerce_enabled` | valid/invalid/expired/exhausted/per-user; same frozen snapshot & payable as bot; no internal ids returned; rep stacking rule |
| Pre-invoice (authoritative amounts) | `renderPreInvoice` (`checkout.handler.ts:148`) | `resolveEffectiveProductPrice` (`representative-pricing.service.ts:204`) + snapshot fields | CheckoutSession | — | — | ❌ | **Phase 1** | `miniapp_commerce_enabled` | server-computed amounts only; representative price honored identically |

### 3.4 Payment methods

| Capability | Bot entry | Authority | Models | Pay/prov deps | Notifications | Mini App today | Target | Switch | Required tests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Method eligibility list | `showPaymentMethods` (`payment.handler.ts:86`) | `getAvailablePaymentMethods` (`payment-method.service.ts:44`) — enabled/hidden/per-user/min-max/groups/activate-after/cards/adapter | PaymentGateway, CardToCardAccount, UserHiddenPaymentGateway | provider env/config | — | ❌ | **Phase 1** | per-method switches AND provider settings | provider offered only when provider-enabled AND miniapp switch on; no fake providers |
| Wallet payment | `user:co:wallet(:yes)` → `payPurchaseDraftWithWallet` (`wallet-payment.service.ts:619`) | `executeWalletOrderPayment:227` — one tx: CAS deduct `balanceToman ≥ amount`, Payment(APPROVED)+Order(PAID)+ledger+discount claim; key `wallet:<uid>:<nonce>` | Payment, Order, CheckoutSession, WalletTransaction, User | fulfilment dispatch post-commit | low-balance hook; delivery messages from bot | ❌ | **Phase 1** | `miniapp_commerce_enabled` (+ `wallet_payment_enabled`) | sufficient/exact/insufficient; concurrent double-confirm → one effect; replay returns original; conflicting idempotency payload → 409; one ledger row; no negative balance; failed settlement writes nothing |
| Card-to-card + receipt | `user:pay:g:*` → card screen; flow `payment:receipt` → `submitReceipt` (`payment-method.service.ts:180`) | round-robin `pickCardAccountForGateway:123`; Payment(PENDING_REVIEW)+ManualReceipt in tx; approval `approveReceiptPayment` (`receipt-review.service.ts:223`) | Payment, ManualReceipt, CardToCardAccount | admin review; fulfilment on approve | `notifyAdminsAboutReceipt`; user notices | ❌ | **Phase 1** — browser upload (stored bytes, not Telegram file_id) feeding the SAME ManualReceipt/review flow | `miniapp_card_to_card_enabled` | MIME/signature/size caps; spoofed MIME; duplicate upload idempotent; bot-approval visible in Mini App status; rejection path; abandoned-upload cleanup; no path/bytes in logs |
| Zarinpal | `startOnlineGatewayPayment` (`payment.handler.ts:253`) → redirect URL | `getOrCreateGatewayPayment` (`gateway-payment.service.ts:297`), callback `GET /payments/zarinpal/callback`, settle `settleGatewayPayment:611` | Payment, CheckoutSession | server verify.json; sweep settles | bot sends outcome | ❌ | **Phase 1** — API initiation returns safe redirect URL; return lands on Mini App status page | `miniapp_online_payments_enabled` | valid/duplicate callback; wrong amount; wrong checkout; callback-before-return and return-before-callback; pending/failed provider states; browser return never marks success |
| NOWPayments | same | same + IPN `POST /payments/nowpayments/ipn` (HMAC-SHA512) | same | IPN sole truth | same | ❌ | **Phase 1** | `miniapp_online_payments_enabled` | invalid signature 401; duplicate IPN; out-of-order invoice_id; UNKNOWN status stored-only |
| Telegram Stars (one-time) | invoice via `ctx.api.sendInvoice` XTR; pre-gate `stars-payment.handler.ts` | adapter `telegram-stars.ts`; settle path unchanged (bot updates) | Payment, StarsPricingSetting | `createInvoiceLink` needed for web | — | ❌ | **Phase 1 conditional** — only via `createInvoiceLink` (plain Bot-API HTTPS call, no grammY) + `openInvoice` binding; settlement stays bot-side. If not landed safely, explicitly deferred, never faked | `miniapp_online_payments_enabled` | pre-checkout owner/amount/currency guards unchanged; link initiation owner-scoped |
| Payment status observation | «بررسی وضعیت» `user:pay:chk:*` | read of Payment/Checkout/Order/Service + `settleGatewayPayment` idempotent re-check | all above | — | — | ❌ | **Phase 1** — owner-scoped status endpoint + polling screen | master | status machine mapping (§16 of the program); polling never mutates; owner isolation |

### 3.5 Wallet & top-up

| Capability | Bot entry | Authority | Models | Pay/prov deps | Notifications | Mini App today | Target | Switch | Required tests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Balance + ledger view | `user:wallet`, `user:wallet:tx:*` | `getWalletSummary` / `listWalletTransactions` (`wallet.service.ts:42/57`) | User, WalletTransaction | — | — | ✅ read-only | done | — | existing |
| Wallet top-up | `user:wallet:topup` flow → `createWalletTopupCheckout` (`wallet-topup.service.ts:78`) | limits `walletTopupLimits:31` (`wallet_topup_min/max_toman`), fa-digit parsing; purpose WALLET_CHARGE; credit exactly-once on settle (`gateway-payment.service.ts:799` / `approveWalletTopup`) | CheckoutSession, Payment, WalletTransaction | non-wallet providers only | success notice; low-balance hook | ❌ | **Phase 1** | `miniapp_wallet_topup_enabled` (+ `wallet_topup_enabled`) | min/max parity; wallet never offered for its own top-up; exact whole-Toman; pending/success/failure display; resulting ledger row shown |

### 3.6 Provisioning, delivery, other products

| Capability | Bot entry | Authority | Models | Pay/prov deps | Notifications | Mini App today | Target | Switch | Required tests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Service provisioning | post-settle `dispatchPaidOrderFulfillment` (`order-fulfillment.service.ts:364`) → `provisionPaidOrder` (`provisioning.service.ts:279`) | Redis service lock; CAS PAID→PROVISIONING; uncertain never refunds; `failOrderWithRefund:165` | Order, Service, ServiceUsernameReservation, FinancialReconciliationCase | `@zedbot/panel-adapters` | user delivery message + QR + guide entry; ops events | ❌ (no delivery surface) | **Phase 1** — bot process still provisions; Mini App observes + renders delivery | `miniapp_service_delivery_enabled` for links/configs/QR | success; definite panel failure → refund; uncertain → reconciliation, no blind duplicate grant; no duplicate Service |
| Delivery page (owner-safe) | `buildServiceInfoMessage` (`provisioning.service.ts:795`), `user:svc:link/configs/qr_*` | `getOwnedServiceByShortId` (`user-services.service.ts:56`), `generateQrPng` (`qr-code.service.ts`) | Service | — | — | ⚠️ detail exists **without** subscriptionUrl/configs/QR | **Phase 1** — add gated link/config/QR exposure + copy | `miniapp_service_delivery_enabled` | never leaks UUID/panel creds/admin URL/raw adapter data/foreign service; no-store |
| Other-product fulfilment (stock/manual/awaiting/specialized) | `fulfillOtherProduct` (`order-fulfillment.service.ts:216`) | `autoDeliverStockOrder`, `reserveStockItemForOrder` (CAS AVAILABLE→RESERVED), `initManualDelivery:97`, AWAITING_STOCK parking | OtherProductOrder, OtherProductStockItem | — | admin manual-order/stock alerts; user texts | ❌ | **Phase 1** — Mini App observes states + reveals delivered content owner-only | `miniapp_other_products_enabled` | stock delivery; awaiting stock; manual delivery; ALREADY_DELIVERED idempotence; owner isolation of delivered content; no-store; not in list endpoints |
| Customer-input forms (pre-settlement + post-payment) | `cinput:*` (`customer-input-form.handler.ts`), `user:op:info:*` | `getOrCreateCheckoutInput:60`, `submitCheckoutInput:155`, `isMandatoryCustomerInfoMissing:120` (settlement gate), `consumeCheckoutInputForOrder:244`, AES-GCM values | CheckoutCustomerInput, OtherProductOrder | blocks settlement when required | admin notify on submit | ❌ | **Phase 1** — form navigation fwd/back/skip/masked review/confirm/resume | `miniapp_other_products_enabled` | mandatory gate parity across wallet/card/gateway; resume; masked values; retention/redaction untouched |

### 3.7 Renewal & add-ons

| Capability | Bot entry | Authority | Models | Pay/prov deps | Notifications | Mini App today | Target | Switch | Required tests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Renewal | `user:renew*` → `createRenewalCheckoutSession` (`renewal-checkout.service.ts`); execute `executeRenewalOrder` (`service-renewal.service.ts:162`) | eligibility `listRenewableServices` / `isRenewalPlanValid`; `calculateRenewal:80`; idempotency anchor ServiceEventLog RENEWAL_APPLIED | CheckoutSession, Order, Service, ServiceEventLog | panel `renewServiceAccount`; uncertain → startup-recovery classification | success message; trial-conversion notice | ❌ | **Phase 1** — from service detail | `miniapp_service_renewal_enabled` | eligible/ineligible; concurrent confirmations single grant; panel timeout → reconciliation, no double grant; bot/Mini App parity |
| Extra volume | `user:ev:*` → `createExtraVolumeCheckout` (`extra-volume.service.ts:212`); execute `:289` | packages/validity/calc; EXTRA_VOLUME_APPLIED anchor | same | panel `addServiceVolume` | same | ❌ | **Phase 1** | `miniapp_extra_volume_enabled` | same battery as renewal |
| Extra time | `user:et:*` → `createExtraTimeCheckout` (`extra-time.service.ts:219`); execute `:291` | same shape; EXTRA_TIME_APPLIED | same | panel `addServiceTime` | same | ❌ | **Phase 1** | `miniapp_extra_time_enabled` | same battery as renewal |

### 3.8 History & status

| Capability | Bot entry | Authority | Models | Pay/prov deps | Notifications | Mini App today | Target | Switch | Required tests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Orders hub / unified history / payments / wallet tx / other-product orders | `user:orders`, `user:hist:*`, `user:payhist:*` (`orders.handler.ts`) | `user-history.service.ts` (`listUserHistory`, `listUserPayments`, detail fns, status label authorities), `user-other-product-orders.service.ts` (incl. `getDeliveredStockContentForUser` owner re-decrypt) | Order, Payment, ManualReceipt, WalletTransaction, OtherProductOrder, CheckoutSession | — | — | ⚠️ wallet tx only | **Phase 1** — paginated, owner-scoped, DTO-allowlisted; detail links to payment/service/delivery/input-resume/receipt/reconciliation | `miniapp_commerce_enabled` | pagination; owner isolation; no UUIDs; delivered content only in owner detail; pending-operations list |
| Status state machine | bot texts per status | real statuses only: CheckoutStatus / PaymentStatus / OrderStatus / OtherProductOrderStatus / ServiceStatus (+ reconciliation flags) | — | — | — | ❌ | **Phase 1** — stable machine codes → Persian i18n; no invented second machine | master | every mapped code has i18n; unknown → safe fallback |

### 3.9 Existing Mini App surfaces (unchanged by Phase 1)

Dashboard, services list/detail (16 safe rows), wallet ledger, profile,
Support Center (create/reply/list/thread, idempotent) — all remain as on
`main`; Phase 1 only adds to them.

### 3.10 Phase 2 (deferred user features)

| Capability | Bot entry | Authority | Why deferred |
| --- | --- | --- | --- |
| Free trial claim | `user:ft:*` (`free-trial.handler.ts`) | `claimFreeTrial` (`free-trial.service.ts:541`), Redis lock, uncertain policy | listed in final target, not in Phase-1 scope §2 |
| Enable/disable service | `user:svc:disable/enable` | `service-toggle.service.ts` | service management beyond §15 |
| Subscription-link regeneration | `user:svc:regen_link` | `service-link.service.ts` | same |
| Diagnostics | `user:svc:diag:*` | `service-diagnostics.service.ts` | same |
| Connection guides | `user:svc:guide:*` | `connection-guide.service.ts` | same (guide *entry* shown on delivery page links to bot) |
| Notification settings | `user:nset:*` | `notification-preference.service.ts` | not commerce |
| Referral page | `user:referral` | `referral.service.ts` (attribution/payout stay live server-side in Phase 1) | UI only deferred |
| Representative program UI | `user:rep:*` | `representative.service.ts` (rep **pricing** is honored in Phase-1 checkouts via `resolveEffectiveProductPrice`) | UI deferred |
| Stars monthly subscriptions | `user:sub:*` | stars-subscription services | separate subsystem |
| Auto-renewal mandates | `user:arn:*` | `auto-renewal.service.ts` | separate subsystem |
| Support attachments up/download | bot flows | `@zedbot/support-tickets` | existing Mini App gap |

## 4. Notifications (§18 of the program)

All durable notifications keep their existing origin: fulfilment messages,
receipt notices, low-balance alerts and automated notifications are sent by
the bot/worker regardless of which transport initiated the operation. The
Mini App additionally renders the same outcome from status endpoints, so the
Telegram message is a receipt, not the delivery channel. Where origin is
recorded (support tickets today, commerce mutations in Phase 1), the value
`MINIAPP` is stored without changing financial meaning.

## 5. Placeholders / dead callbacks — excluded from parity

`user:wheel`, `user:tutorials` (placeholder text, hidden); legacy
`terms:accept` (inert); legacy `user:buy:loc|cat|p:(M|D|T|A)` redirects;
legacy `user:pay:copycard/copyamount`; PLISIO / AGHAYEPARDAKHT / CUSTOM
gateway enum members (no adapter — never offered, never faked in the Mini
App); service note-editing and service transfer (deliberately collapsed in
bot views, not implemented anywhere).
