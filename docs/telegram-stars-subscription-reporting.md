# Telegram Stars Subscription — Financial Reporting (Phase 2.1)

The OWNER-only Stars subscription financial report (Parts U/V), reached through the
admin dashboard `admin:starsrep:*` (see `telegram-stars-subscription-recovery.md`
and `-operations.md`). It keeps **Stars accounting strictly separate from Toman**
and uses precise, non-inflating definitions.

## Stars are separate from Toman

Stars totals are reported **separately from Toman** and are **never converted** by
default. Stars renewal Orders carry **0 Toman** (Phase 2), so Stars revenue never
inflates Toman revenue reports and the two ledgers never mix. This report reads the
Stars amounts recorded on `TelegramStarsSubscriptionCharge` rows.

## Definitions (exact, non-inflating)

| Metric | Definition |
| --- | --- |
| **Gross** | received charges — `COMPLETED` + `REFUND_PENDING` + `REFUNDED` |
| **Refunded** | `REFUNDED` **only** (never `REFUND_PENDING`) |
| **Net** | `gross − refunded` — labeled **net**, **NOT** "profit" |

`REFUND_PENDING` is deliberately counted in **gross** (Telegram did charge the
user) but **not** in refunded (the refund is not yet confirmed) — so a refund in
flight never double-discounts the totals.

## Breakdown metrics

Alongside gross / refunded / net the report shows:

- **initial** charges (first recurring),
- **recurring** charges,
- **completed renewals**,
- **requires-action** subscriptions,
- **refund-pending** charges.

## Ranges

Selectable ranges: **today**, **7d**, **30d**, **all**.

## CSV export

An **OWNER-only**, **PII-free aggregate** CSV export. It carries aggregate figures
only — no user id, charge id, payload, service username, or any raw identifier —
consistent with the masked-only policy used across Phase 2.1 (`-support.md`).

## Refund-status distinctions (why they matter)

| Status | In gross? | In refunded? | Notes |
| --- | --- | --- | --- |
| `COMPLETED` | ✅ | — | a settled renewal |
| `REFUND_PENDING` | ✅ | — | charged, refund not yet confirmed |
| `REFUNDED` | ✅ | ✅ | charged and refund confirmed |

Because `REFUNDED` rows appear in **both** gross and refunded, **net** correctly
nets them out. `REFUND_PENDING` counts toward gross only until the refund confirms
(via the `refunded_payment` update or refund reconciliation, see `-refunds.md` and
`-recovery.md`), at which point it becomes `REFUNDED` and enters the refunded total.
