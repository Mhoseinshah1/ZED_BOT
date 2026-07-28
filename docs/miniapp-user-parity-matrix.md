# Mini App ↔ Bot USER parity matrix

The authoritative inventory of every **real** user-facing capability the
Telegram Bot has today, what implements it, and which Mini App stack layer is
responsible for reaching parity.

Built by inspection of the checkout at `6150a87` + `fafaacf`, not from memory:

- `docs/navigation-map.md` (the documented USER navigation tree);
- `apps/bot/src/core/callbacks.ts` (every registered `user:*` callback);
- `apps/bot/src/keyboards/user-menu-definition.ts` (`UserMainMenuAction`);
- `apps/bot/src/handlers/` (which handler owns which callback);
- `apps/bot/src/handlers/user-placeholders.handler.ts` (what is **not** real);
- `apps/bot/src/services/` (the authoritative domain per capability);
- `apps/api/src/miniapp/` (what the Mini App can already do).

## How "real" was decided

A registered callback does not prove a feature exists. `user-placeholders.handler.ts`
is the repository's own record of which buttons answer with
«این بخش هنوز فعال نشده است.» and it is kept honest by comments recording each
capability that graduated out of it. Anything still listed there is a
placeholder; anything with a dedicated `handlers/user-*` directory and a
service behind it is real.

### Placeholders — MUST NOT be built in the Mini App

| Capability | Callback | Evidence |
| --- | --- | --- |
| Lucky wheel | `user:wheel` | Still in `USER_SECTIONS` of `user-placeholders.handler.ts` |
| Tutorials | `user:tutorials` | Still in `USER_SECTIONS` of `user-placeholders.handler.ts` |

These are hidden from the main menu; the callbacks stay registered only so old
Telegram messages keep answering. Building either in the Mini App would be
inventing a feature, so both are out of scope for every layer.

### Resolved unverified assumptions

| Question | Answer | Evidence |
| --- | --- | --- |
| Is referral real? | **Yes** | `handlers/user-referral`, `services/referral*`; graduated out of the placeholder list in the referral affiliate phase |
| Is representative real? | **Yes** | `handlers/user-representative`, `services/representative*.service.ts`; graduated out of the placeholder list |
| Is tutorials real? | **No — placeholder** | Still in `USER_SECTIONS` |
| Is lucky wheel real? | **No — placeholder** | Still in `USER_SECTIONS` |
| Is there a user "emergency recharge"? | **No** | `emergency` appears only in `admin-service-operation.service.ts`, `admin-service-settings.service.ts` and settings/representative services — an **administrator** capability, excluded by the no-admin-in-Mini-App guardrail |
| Is there user "account management"? | Partially — profile/notification preferences only | `handlers/user-notifications/notification.handler.ts`; no separate account-management handler exists |

## The matrix

Layer key: **L1** commerce authority · **L2** payment parity · **L3** delivery &
Service management · **L4** remaining user features · **L5** final UI.
Rollout switches all default **false**.

| # | Capability | Bot entry | Authoritative implementation | Models | Side effects | Notifications | Mini App today | Layer | Rollout setting | Tests required | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Public pricing catalog | `user:pricing` | `handlers/user-pricing`, `services/catalog.service.ts` | Product, Category, Panel | none (read) | none | ✗ | L1 | `miniapp_commerce_browse_enabled` | visibility, group filter, no UUID | TODO |
| 2 | Browse locations/categories/products | `user:buy` | `services/catalog.service.ts` (`isProductVisible`, `groupMatches`) | Product, Category, Panel | none | none | ✗ | L1 | same as #1 | hidden product excluded, disabled panel excluded | TODO |
| 3 | Product detail + pre-invoice | `user:buy` → product | `services/checkout.service.ts` (`buildProductSnapshot`) | CheckoutSession | PENDING checkout | none | ✗ | L1 | `miniapp_commerce_checkout_enabled` | frozen snapshot, expiry | TODO |
| 4 | Discount code | `checkout:discount` | `services/discount.service.ts` (`validateDiscountCode`, `claimDiscountUsage`) | DiscountCode, usage | usage claim at settlement | none | ✗ | L1 | same as #3 | invalid, expired, exhausted, changed-after-quote | TODO |
| 5 | New subscription purchase (wallet) | `user:buy` → wallet | `services/wallet-payment.service.ts` `payPurchaseDraftWithWallet` | User.balanceToman, Payment, Order, WalletTransaction, Service | debit + order + provisioning | purchase receipt | ✗ | L1 | `miniapp_wallet_purchase_enabled` | concurrency, exact/insufficient balance, idempotent replay | TODO |
| 6 | Renewal (wallet) | `user:renew` | `services/renewal-checkout.service.ts` + `payRenewalDraftWithWallet` + `service-renewal.service.ts` | CheckoutSession, Payment, Order, WalletTransaction, Service | debit + in-place renewal | renewal receipt | ✗ (gate only) | L1 | `miniapp_wallet_renewal_enabled` ✅ exists | full §15 matrix | IN PROGRESS |
| 7 | Extra volume | `user:extra_volume` | `services/extra-volume.service.ts` + `payExtraVolumeDraftWithWallet` | Service, Payment, Order, WalletTransaction | debit + quota grant | receipt | ✗ | L1 | `miniapp_wallet_addons_enabled` | grant once under concurrency | TODO |
| 8 | Extra time | `user:extra_time` | `services/extra-time.service.ts` + `payExtraTimeDraftWithWallet` | same as #7 | debit + expiry extension | receipt | ✗ | L1 | same as #7 | grant once under concurrency | TODO |
| 9 | Wallet balance + history | `user:wallet` | `services/wallet*`, existing Mini App wallet read | WalletTransaction | none (read) | none | ✅ read-only | L1 | n/a (already read-only) | owner scope | DONE (#143) |
| 10 | Wallet top-up amount entry | `user:wallet` → charge | `services/payment-settings.service.ts` (`walletTopupLimits`) | CheckoutSession (WALLET_CHARGE) | PENDING checkout | none | ✗ | L2 | `miniapp_wallet_topup_enabled` | min/max, cannot pay itself from wallet | TODO |
| 11 | Card-to-card + receipt upload | `payment:receipt` | `services/receipt-review.service.ts` | ManualReceipt, Payment | admin review queue | admin + user | ✗ | L2 | `miniapp_receipt_upload_enabled` | MIME allowlist, signature, size, dimensions, random identity | TODO |
| 12 | Zarinpal | payment method | `packages/payments` Zarinpal adapter, `services/gateway-payment.service.ts` | Payment | provider callback settles | receipt | ✗ | L2 | `miniapp_gateway_zarinpal_enabled` | duplicate callback, wrong amount, bad signature | TODO |
| 13 | NOWPayments | payment method | `packages/payments` NOWPayments adapter | Payment | provider callback settles | receipt | ✗ | L2 | `miniapp_gateway_nowpayments_enabled` | same as #12 | TODO |
| 14 | Telegram Stars | `stars-payment.handler.ts` | `services/stars-subscription.service.ts` | Payment, StarsSubscription | Telegram-side invoice | receipt | ✗ | L2 — **conditional** | `miniapp_stars_enabled` | see blocker below | TODO |
| 15 | Payment status / reconciliation | `user:orders` | `services/financial-reconciliation.service.ts` | Payment, Order | none (read) | none | ✗ | L2 | read-only | owner scope, no provider payload | TODO |
| 16 | Other products (catalog → purchase) | `user:other_products` | `handlers/user-other-products`, `services/other-product-*.service.ts` | Product, Order, Stock | stock delivery | delivery message | ✗ | L1/L3 | `miniapp_commerce_checkout_enabled` | stock, awaiting-stock, manual | TODO |
| 17 | Customer-input forms (`cinput:*`) | post/pre payment | `services/checkout-customer-input.service.ts`, `customer-input-schema.service.ts` | CheckoutCustomerInput | gates settlement/fulfilment | admin queue | ✗ | L3 | `miniapp_customer_input_enabled` | resumable, optional fields, masked review | TODO |
| 18 | My Services list + detail | `user:services` | `handlers/user-services`, `services/service-sync.service.ts` | Service | optional panel sync | none | ✅ read-only | L3 | n/a | owner scope | DONE (#143) |
| 19 | Subscription link / configs / QR | `user:services` → detail | `services/qr-code.service.ts`, `qr-delivery.service.ts` | Service | none | none | ✗ | L3 | `miniapp_service_links_enabled` | never in list responses, never logged | TODO |
| 20 | Service update / refresh | `user:services` | `services/service-sync.service.ts` | Service | panel read | none | ✗ | L3 | `miniapp_service_actions_enabled` | uncertain result → no blind retry | TODO |
| 21 | Enable / disable Service | `user:services` | `services/service-toggle.service.ts` | Service | panel mutation | none | ✗ | L3 | same as #20 | confirmation, lock, uncertain outcome | TODO |
| 22 | Link regeneration | `user:services` | `services/service-*` regen path | Service | panel mutation | none | ✗ | L3 | same as #20 | confirmation, idempotent | TODO |
| 23 | Connection guide | `user:services` → guide | `services/connection-guide.service.ts` | Guide settings | none | none | ✗ | L3 | `miniapp_guides_enabled` | readiness gate | TODO |
| 24 | Service diagnostics | `user:services` → diagnostics | `services/service-diagnostics.service.ts` | Service | panel read | none | ✗ | L3 | `miniapp_diagnostics_enabled` | privacy-safe snapshot only | TODO |
| 25 | Orders / payments history | `user:orders` | `handlers/user-orders` | Order, Payment | none | none | partial | L3 | read-only | owner scope, no delivered secrets in lists | TODO |
| 26 | Free trial | `user:free_test` | `services/free-trial*.service.ts`, `free-trial-entitlement.service.ts` | FreeTrial*, Entitlement | provisioning | delivery | ✗ | L4 | `miniapp_free_trial_enabled` | concurrency → at most one claim | TODO |
| 27 | Referral | `user:referral` | `handlers/user-referral`, referral services | Referral*, Commission | commission credit | notifications | ✗ | L4 | `miniapp_referral_enabled` | owner scope, no double credit | TODO |
| 28 | Representative program | `user:representative_request` | `handlers/user-representative`, `representative*.service.ts` | Representative* | application/purchase | notifications | ✗ | L4 | `miniapp_representative_enabled` | eligibility server-side | TODO |
| 29 | Notification preferences | `ntf:*` | `handlers/user-notifications` | NotificationPreference | none | none | ✗ | L4 | `miniapp_notification_prefs_enabled` | owner scope | TODO |
| 30 | Stars subscription management | `handlers/user-stars-subscription` | `stars-subscription.service.ts` | StarsSubscription | reactivate/refund | notifications | ✗ | L4 — conditional | `miniapp_stars_enabled` | see blocker | TODO |
| 31 | Support Center | `user:support` | `packages/support-tickets` | SupportTicket, SupportMessage | admin intents | admin + user | ✅ full | — | existing | regression only | DONE (#143) |
| 32 | Terms acceptance | `terms.handler.ts` | `services/terms*` | Terms | acceptance record | none | ✗ | L4 | `miniapp_terms_enabled` | versioned acceptance | TODO |
| 33 | Force-join gate | `force-join.handler.ts` | `packages/force-join` | ForceJoinChannel | none | none | ✅ evaluated | — | existing | regression only | DONE |
| 34 | Profile / account info | `user:menu` header | `services/user*` | User | none | none | ✅ read-only | L4 | n/a | no Telegram id leakage | DONE (#143) |

## Deliberately excluded

| Capability | Reason |
| --- | --- |
| Lucky wheel | Placeholder — no implementation exists |
| Tutorials | Placeholder — no implementation exists |
| Admin panel (`ADMIN_PANEL`, all `admin:*`) | Guardrail: the administrator panel stays in the Bot |
| Emergency Service actions | Administrator capability (`admin-service-operation.service.ts`), not a user flow |
| Mini App launcher button (`user:miniapp`) | It *is* the Mini App; nothing to port |

## Known external live-verification blocker

**Telegram Stars (#14, #30).** Stars invoices are created and paid through the
Telegram client, not through a browser payment page. Whether a Mini App can
initiate one without handing the user back into a Bot chat depends on the
Telegram WebApp API surface available to this bot, which cannot be verified
from the repository alone and needs a live bot token plus a real Telegram
client. Per §5: adapter-level and recorded-contract tests will be completed,
the blocker is recorded here, and no live success will be faked. Stars stays
gated behind `miniapp_stars_enabled` and ships disabled regardless.

## Pass condition status

- Every real USER capability appears exactly once: **yes** (34 rows).
- Every item assigned to a stack layer: **yes**.
- No placeholder marked implemented: **yes** — both placeholders are in the
  excluded table with evidence.
