# ZED_BOT payment methods foundation (Phase 7)

Phase 7 wires payment-method selection after checkout creation, the
card-to-card screen with receipt upload, and the read-only admin receipts
list.

**Core rule — no approval, no Order, no Service, no provisioning.** The only
writes are one `Payment` (status `PENDING_REVIEW`) plus its `ManualReceipt`
when the user submits a receipt. The checkout stays `PENDING`, wallets are
untouched, discount usage is not finalized, panels are never called.

> **Phase 8 update:** approval/rejection now exists on top of this
> foundation — see `docs/receipt-review-phase8.md`. Phase 7 itself still
> only creates the `PENDING_REVIEW` Payment/ManualReceipt; approving a
> payment creates the `PAID` Order but still provisions no Service until
> Phase 9.

Source: `apps/bot/src/services/payment-method.service.ts`,
`apps/bot/src/handlers/user-checkout/{payment-views,payment.handler}.ts`,
`apps/bot/src/handlers/admin-receipts/receipts.handler.ts`.

## User flow

After «ادامه و انتخاب روش پرداخت ✅» (checkout created), the bot now shows
«پیش‌فاکتور ثبت شد ✅ / روش پرداخت را انتخاب کنید:» with the available
gateway buttons (+ view invoice, main menu). Selecting:

- **CARD_TO_CARD** → the card screen (below).
- Any other enabled gateway → «این روش پرداخت در فاز بعدی فعال می‌شود.»
- No eligible gateway → «فعلاً روش پرداختی برای این مبلغ فعال نیست...»

«مشاهده دوباره پیش‌فاکتور» now reflects payment state: a live
`PENDING_REVIEW` payment shows «رسید شما در انتظار بررسی است.», a valid
PENDING checkout offers «انتخاب روش پرداخت 💳», and an expired one shows the
expiry notice (expiry is compared in the UI; no worker yet).

## Gateway filtering

Adapted to the actual schema (`isEnabled`/`isHidden`, not
isActive/isVisible): enabled, not hidden, **not hidden per-user**
(`UserHiddenPaymentGateway`), `minAmountToman`/`maxAmountToman` versus
`checkout.finalPriceToman`, `allowedGroups` (null/empty/"ALL" = everyone),
and `user.paidOrdersCount >= activateAfterSuccessfulPaymentsCount`. Sorted by
`displayOrder`, `createdAt`. Eligibility is re-validated when a gateway
button is clicked, so stale buttons cannot bypass the filters. Buttons show
the operator-defined `gateway.name`.

## Card-to-card behavior

- **Rotation (never random)**: the schema has no `lastUsedAt` and `Payment`
  has no card column, so per the fallback rules the pick is the ACTIVE
  account with the fewest Payments created **today** that reference it
  (`cardAccountId` stored in `Payment.callbackPayload`), ties broken by
  `displayOrder` then `createdAt`. Usage increments when the receipt's
  Payment row is created, which naturally round-robins the cards.
- The card number is stored encrypted (`cardNumberEncrypted`) and decrypted
  only for the paying user's screen; it is never logged. 16-digit numbers are
  displayed grouped (`6037-99...`). There is no bank field in the schema, so
  no bank line is shown.
- The screen shows the **exact** amount (not editable), owner name, the
  checkout deadline, and the gateway's `instructionText` when set.
- «کپی شماره کارت / کپی مبلغ» (behavior changed in Phase 21.1): both are
  Telegram `InlineKeyboardButton.copy_text` buttons — the client writes the
  value straight to the clipboard. «کپی شماره کارت» copies the RAW 16-digit
  card number (the visible message still shows it dashed), «کپی مبلغ» copies
  the plain numeric amount (e.g. `5000000`). **No callback fires and no
  extra chat message is sent.** The legacy `user:pay:copycard` /
  `user:pay:copyamount` callbacks remain registered ONLY for old keyboards
  and answer with a callback popup — never a chat message.

## Receipt upload

«ارسال رسید» sets `session.currentFlow = "payment:receipt"` with a
`paymentDraft` (checkout, gateway, card account, decrypted card, amount).
Accepted: **photo** (largest size `file_id`), **document** (`file_id`, with
caption as text), **plain text** (trimmed, ≤1000 chars). Anything else gets
«لطفاً رسید را به صورت عکس، فایل یا متن ارسال کنید.» `/`-commands abandon the
flow and run normally; `/start`, `/menu`, `/admin` and the main menu clear
the payment draft via the shared `clearCheckoutState` helper.

Submission re-checks ownership + PENDING + unexpired, then creates (in one
transaction) the `PENDING_REVIEW` Payment (`purpose ORDER_PAYMENT`,
`amountToman = payableAmountToman = checkout.finalPriceToman`, card metadata
in `callbackPayload`, `expiresAt` from the checkout) and its `ManualReceipt`
(`fileId`/`text`). **Duplicates are rejected**: a checkout that already has a
`PENDING_REVIEW` payment answers «برای این پیش‌فاکتور قبلاً رسید ثبت شده و در
انتظار بررسی است.» Success shows «رسید شما ثبت شد و در انتظار بررسی است ✅».
A payment is never created as APPROVED.

## Admin receipts (read-only foundation)

`admin:receipts` («رسیدهای تایید نشده 💵») lists `PENDING_REVIEW` payments
newest-first, paginated, labeled `مبلغ | کاربر | تاریخ`. The detail view
shows payment short id, user (username/name/telegram id), amount, gateway
name+type, checkout short id, product name from the snapshot, receipt kind,
receipt text, and creation time — and since Phase 21.1 it also forwards the
actual receipt media (photo first, document fallback). As of Phase 8 the
detail view also carries approve/reject buttons
(`docs/receipt-review-phase8.md`), and since Phase 21.1 every ACTIVE admin
is additionally notified with the receipt right when it is submitted. The
section is behind admin auth like every admin route.

## Callbacks

`user:pay:m:<coSid>`, `user:pay:g:<coSid>:<gwSid>`, `user:pay:receipt` (the
receipt flow works from the session draft to keep callback data tiny),
`admin:receipts`, `admin:rec:list:<page>`, `admin:rec:view:<paymentSid>` —
all 8-char short-id based. `user:pay:copycard`/`user:pay:copyamount` are
LEGACY-only (Phase 21.1): new keyboards use `copy_text` buttons that fire no
callback at all.

## Intentionally NOT implemented (in Phase 7)

Receipt approval/rejection, Order creation and discount usage finalization
arrived in Phase 8 (`docs/receipt-review-phase8.md`). Still missing after
Phase 8: automatic verification, wallet deduction,
Service creation, online gateways (Plisio,
NowPayments, آقای پرداخت, زرین‌پال), Telegram Stars, provisioning, media
forwarding to admins/log groups, checkout/payment expiry worker, and admin
management of gateways/card accounts. Nothing payment-related is seeded:
gateway and card-account rows are configured separately by the operator
(admin UI for them is a later phase).

> **Phase 21 update:** the admin UI arrived — «پنل مدیریت 🛠 → مالی 💎 →
> روش‌های پرداخت 💳 → کارت‌به‌کارت» creates/toggles the CARD_TO_CARD
> gateway, edits its min/max/instruction text and manages encrypted card
> accounts (`docs/admin-payment-methods-phase21.md`). One selection
> refinement landed with it: a CARD_TO_CARD gateway is only offered when it
> has at least one ACTIVE card account. Everything else in this phase
> (rotation, receipt submission, review) is unchanged.

> **Phase 21.1 update:**
> - «کپی شماره کارت»/«کپی مبلغ» are now Telegram **`copy_text`** buttons:
>   the client copies the RAW card digits / plain numeric amount straight
>   to the clipboard — no callback, **no extra chat message**. The old
>   `user:pay:copycard`/`user:pay:copyamount` callbacks stay registered
>   ONLY for old keyboards and answer with a popup, never a message.
> - Submitting a receipt now **notifies every ACTIVE admin** with the
>   actual receipt (photo/document forwarded by file_id, or the text),
>   full masked review context and a «بررسی رسید 🧾» button into the
>   existing `admin:rec:view` detail (approve/reject unchanged). A failed
>   notification never rolls back the submitted receipt. The admin detail
>   page also forwards the receipt media when opened.
