# Text audit (final production audit)

Classification of every user-facing text by storage class. Rule applied:
operator-facing copy that a bot owner may want to reword lives in the
database (MessageTemplate / ButtonText / Setting); technical, admin-only
and safety-critical strings stay STATIC in code deliberately.

## MESSAGETEMPLATE (11 seeded, operator-editable via «مدیریت متن‌ها ✍️»)

| key | used by |
| --- | --- |
| `start_text` | main menu |
| `bot_off_text` | maintenance gate |
| `support_text` | ticket landing |
| `faq_text` | FAQ placeholder |
| `wallet_header_text` | wallet landing heading (Fix A) |
| `wallet_topup_amount_prompt` | top-up amount prompt (Fix A) |
| `wallet_topup_preview_note` | top-up pre-invoice note (Fix A) |
| `wallet_empty_transactions_text` | empty transaction history (Fix A) |
| `no_services_text` | services empty state |
| `no_orders_text` | OTHER_PRODUCT orders empty state |
| `no_tickets_text` | tickets empty state |

All template values rendered into HTML-parse-mode messages are escaped at
the interpolation point (Fix A review finding) — a broken operator edit
renders literally instead of silently killing the page.

## SETTING (operator-editable, Phase 22 finance settings pages)

`payment.card.instruction` / payment-page notice, wallet top-up
enable/min/max/instruction, `stock.low_threshold.<productId>` plus the
seeded bot-wide flags (`bot_name`, `maintenance_mode`,
`support_username`, `force_join_enabled`, `support_mode`). Deliberately
NOT duplicated into MessageTemplate (single source of truth).

## BUTTONTEXT (21 seeded, operator-editable)

The 13 user main-menu labels + commons (`back`, `main_menu`, `cancel`,
`confirm`, `next`, `previous`) + `extra_volume`/`extra_time`. Wired: the
user main menu, the services/renewal empty-state buy buttons and the
placeholder page titles read them at render time.

## STATIC (deliberate, in code)

- Admin page titles/labels (finance, receipts, users, products, panels,
  stock, broadcast, backup) — technical operator UI, not end-user copy.
- Flow prompts, validation errors and confirmation questions — wording is
  coupled to validation constants (lengths/limits) and safety semantics.
- Success/failure notices tied to transactions (approval, delivery,
  refund) — changing them must go through code review, not a bot admin.
- Pre-invoice rendering (`preInvoiceText`) — heavily conditional with
  per-field escaping; templating deferred with documented reasoning
  (Phase 39 note) to protect the LOCKED checkout.
- Pagination labels («بعدی »» / «« قبلی») — ButtonText keys exist
  (`next`/`previous`); swapping ~12 hardcoded call sites for async lookups
  remains a mechanical deferred follow-up.

## Verdict

No text was moved in this audit: everything operator-worthy is already
DB-backed, and the remaining static strings are static by design. No
mixed-source duplicates exist (each text has exactly one home).
