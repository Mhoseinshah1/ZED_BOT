# ZED_BOT payment & wallet settings (Phase 22)

Phase 22 gives the operator runtime control over wallet behavior from the
bot — no code edits, no deploys. A new settings page lives under the Phase
21 finance section:

پنل مدیریت 🛠 → «مالی 💎» → «تنظیمات پرداخت و کیف پول ⚙️»
(`admin:finance:settings`, admin-only like the whole finance area).

## Setting keys & defaults

Stored in the existing `Setting` model (key/value rows). **Nothing is
seeded** — every read falls back to a safe default when the row is missing,
so a fresh install behaves exactly like before this phase. Key names follow
the repo's snake_case convention (the spec's dotted names map 1:1); the
top-up min/max keys are the **pre-existing Phase 14 keys**, so operator
values stored before this phase keep working unchanged.

| Setting | Key | Default |
| --- | --- | --- |
| Wallet top-up enabled | `wallet_topup_enabled` | `true` |
| Wallet payment enabled | `wallet_payment_enabled` | `true` |
| Top-up minimum (Toman) | `wallet_topup_min_toman` (Phase 14 key) | 10,000 |
| Top-up maximum (Toman) | `wallet_topup_max_toman` (Phase 14 key) | 50,000,000 |
| Top-up instruction text | `wallet_topup_instruction_text` | unset |
| Payment page notice | `payment_page_notice_text` | unset |

Source: `apps/bot/src/services/payment-settings.service.ts` (typed reads/
writes on top of the cached `settings.service`, which gained a `setSetting`
upsert that refreshes the cache immediately).

## Admin page

Shows شارژ کیف پول روشن/خاموش, پرداخت با کیف پول روشن/خاموش, حداقل/حداکثر
شارژ, and set/not-set previews for both texts. Buttons: the two toggles,
«تنظیم حداقل شارژ» / «تنظیم حداکثر شارژ» (text flows
`admin_payment_settings:min_topup` / `max_topup` — Persian digits accepted,
integer ≥ 0, **`0` resets the limit to the built-in default**, min ≤ max
enforced both ways), «تنظیم متن راهنمای شارژ» / «تنظیم پیام صفحه پرداخت»
(`admin_payment_settings:topup_instruction` / `payment_notice` — «-» or
«حذف» clears, 1000-char cap), «بازگشت». State is cleared on
landing/settings/menu/cancel like the other Phase 21 flows.

## User top-up behavior (Phase 14 flow, now operator-controlled)

- **Disabled**: pressing «شارژ کیف پول» answers «شارژ کیف پول در حال حاضر
  غیرفعال است.» — no draft, no amount prompt, no CheckoutSession. The
  «ادامه» button of a stale pre-invoice re-checks at ACTION time and
  refuses too, and `createWalletTopupCheckout` itself throws while disabled
  (belt-and-braces), so no `WALLET_CHARGE` checkout can be written.
- **Min/max**: the existing Phase 14 validation already reads these keys —
  «حداقل/حداکثر مبلغ شارژ کیف پول X تومان است.» now reflects whatever the
  admin configured.
- **Instruction text**: when set, appended to the amount prompt. It is
  display-only — never written into Payment rows.

## Wallet payment behavior (Phase 15/16/17 flows)

When `wallet_payment_enabled` is false:

- «پرداخت با کیف پول 🏦» disappears from all four pre-invoices (purchase,
  renewal, extra volume, extra time) — the keyboards take a
  `walletPaymentEnabled` flag resolved at render time.
- A stale/old wallet button answers «پرداخت با کیف پول در حال حاضر غیرفعال
  است.» at the ask step, and `executeWalletOrderPayment` enforces it at the
  SERVICE level before any write. The guard sits **after** the idempotent
  replay lookup: an already-settled payment still returns its settled
  result, but no NEW money can move. The atomic conditional-updateMany race
  fix, idempotency keys and price/discount revalidation are untouched.

## Payment page notice

When `payment_page_notice_text` is set, the Phase 7 payment-method list
shows it (HTML-escaped) under the amount/method prompt for every checkout
type, including top-ups. Never shown on admin screens.

## Testing

`apps/bot/tests/payment-settings.test.ts`: defaults with missing rows;
toggle persistence; min/max set/validate/reset-to-default; text set/clear/
1000-cap; disabled top-up rejecting checkout creation with zero rows;
disabled wallet payment blocked at the service with zero financial rows and
working again after re-enable; button visibility; escaped notice rendering.
Because these settings are GLOBAL, vitest now runs test files sequentially
(`fileParallelism: false`) and the suite restores defaults in `afterAll`.

## Intentionally NOT implemented

Online gateways, Telegram Stars, receipt approval/rejection changes,
order/provisioning/renewal/extra execution changes, card-to-card gateway
management changes (Phase 21 owns it; the min/max there are per-gateway and
separate from these global top-up limits), reports, per-group settings,
checkout-expiry configuration UI (`checkout_expiry_minutes` stays a raw
setting), Phase 23+.
