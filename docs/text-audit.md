# Text audit (final production audit)

Classification of every user-facing text by storage class. Rule applied:
operator-facing copy that a bot owner may want to reword lives in the
database (MessageTemplate / ButtonText / Setting); technical, admin-only
and safety-critical strings stay STATIC in code deliberately.

## MESSAGETEMPLATE (20 seeded, operator-editable via «مدیریت متن‌ها ✍️»)

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
| `no_tickets_text` | legacy tickets empty key (superseded on the page by `support_empty_tickets_text`) |
| `support_landing_text` / `support_subject_prompt` / `support_message_prompt` / `support_reply_prompt` / `support_empty_tickets_text` / `support_ticket_created_text` | Fix D support pages ({min}/{max} rendered in code) |
| `history_landing_text` / `no_payments_text` / `no_other_product_orders_text` | Fix D history landing + empty states |

All template values rendered into HTML-parse-mode messages are escaped at
the interpolation point (Fix A review finding) — a broken operator edit
renders literally instead of silently killing the page.

## SETTING (operator-editable, Phase 22 finance settings pages)

`payment.card.instruction` / payment-page notice, wallet top-up
enable/min/max/instruction, `stock.low_threshold.<productId>` plus the
seeded bot-wide flags (`bot_name`, `maintenance_mode`,
`support_username`, `force_join_enabled`, `support_mode`). Deliberately
NOT duplicated into MessageTemplate (single source of truth).

## BUTTONTEXT (32 seeded, operator-editable)

The 13 user main-menu labels + commons (`back`, `main_menu`, `cancel`,
`confirm`, `next`, `previous`) + `extra_volume`/`extra_time` + the 11 Fix D
support/history buttons (`new_ticket`, `my_tickets`, `reply_ticket`,
`refresh`, `all_orders`, `subscription_orders`, `other_product_orders`,
`payments`, `wallet_transactions`, `back_to_support`, `back_to_history`).
Wired: the user main menu, the services/renewal empty-state buy buttons,
the placeholder page titles, the Fix D support/history landings and their
pagination (`next`/`previous`).

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
- Pagination labels («بعدی »» / «« قبلی») — wired via ButtonText in the
  Fix D support/history lists; the remaining hardcoded call sites in older
  flows stay a mechanical deferred follow-up.

## Verdict

Fix D moved the support/history copy into MessageTemplate/ButtonText;
everything else operator-worthy was already DB-backed, and the remaining static strings are static by design. No
mixed-source duplicates exist (each text has exactly one home).
