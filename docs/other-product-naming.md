# Other-product naming policies (naming phase)

OTHER_PRODUCT orders get a **delivery reference** — a safe, deterministic,
user- and admin-facing identifier for manual and stock deliveries. It is an
order-facing identifier ONLY: no VPN Service row is ever created for an
OTHER_PRODUCT order (unchanged invariant, still guarded at dispatch and
inside `provisionPaidOrder`), it is never an authorization mechanism
(ownership stays database-scoped), and it never replaces the Order id.

Source: `apps/bot/src/services/other-product-naming.service.ts`;
wiring in `other-product-delivery.service.ts` (manual),
`other-product-stock.service.ts` (stock), the manual-orders admin handler
and the user order/history handlers.
Tests: `apps/bot/tests/other-product-naming.test.ts`.

## Policies

`Product.otherNamingPolicy` (nullable; null = the `ORDER_SHORT_ID`
default) with `Product.otherNamingTemplate` for the template policy:

| Enum value | Persian label | Shape |
| --- | --- | --- |
| `ORDER_SHORT_ID` (default) | شناسه کوتاه سفارش | `ord-{order_short}` |
| `TELEGRAM_ID` | آیدی عددی تلگرام | `tg{telegram_id}-{order_short}` |
| `TELEGRAM_USERNAME_WITH_FALLBACK` | نام کاربری تلگرام با جایگزین | `{tg_username\|u<id>}-{order_short}` |
| `PRODUCT_CODE_AND_ORDER` | کد محصول و شناسه سفارش | `{product_slug}-{order_short}` |
| `CUSTOM_TEMPLATE` | قالب سفارشی | rendered template (order-short enforced) |

Every reference embeds the order short id, so uniqueness holds by
construction under every policy. There is no product "code" column — the
code is the normalized product-name slug (documented behavior).

### Custom template

Strict variable registry — anything else is rejected at save time
(«قالب نام‌گذاری نامعتبر است. فقط متغیرهای مجاز را استفاده کنید.»):

```
{order_short_id} {telegram_id} {telegram_username}
{user_short_id} {product_name} {date}
```

`{date}` is the ORDER's creation date (immutable), never "now". Raw stock
content, passwords, panel tokens, payment secrets, delivery text and any
other value are unrepresentable: the renderer only substitutes the
registry. A stored template that later fails validation falls back to the
`ORDER_SHORT_ID` shape rather than blocking a delivery.

## Determinism and persistence

`ensureOrderDeliveryReference(orderId)` resolves once and persists with a
compare-and-set on `Order.deliveryReference IS NULL` — retries, concurrent
deliveries and admin re-entries converge on one value, and it is never
altered after delivery. Normalization
(`OTHER_PRODUCT_PUBLIC_REFERENCE` profile): lowercase `[a-z0-9-]`,
collapsed separators, 40-char cap preserving the order-short tail, never
empty.

## Where it applies

- **Manual delivery**: generated when the order enters the admin queue
  (`initManualDelivery`), shown in the admin order detail, included in the
  user delivery message («شناسه تحویل: …»). The admin's secret delivery
  text never enters naming metadata or logs.
- **Stock delivery**: generated BEFORE the stock claim — a naming failure
  cannot reserve stock, and the atomic claim/rollback semantics are
  untouched. The reference derives only from order/user/product values,
  NEVER from the encrypted stock content, and appears in the delivery
  message and safe admin audit.
- **User pages**: the OTHER_PRODUCT order detail and the unified history
  detail render «شناسه تحویل:» when present.
- **Admin search**: «جستجوی سفارش 🔎» additionally matches the delivery
  reference (exact + contains, `Order.deliveryReference` is indexed,
  results stay bounded).

## Legacy orders

Existing OTHER_PRODUCT orders keep `deliveryReference = null`; a reference
is generated lazily the next time a delivery flow touches them (manual
queue entry / stock delivery / already-delivered orders stay null). No
backfill migration mutates rows, so no user-visible entitlement or audit
meaning can change retroactively.
