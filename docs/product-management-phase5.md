# ZED_BOT product management (Phase 5)

Phase 5 replaces the `admin:products` placeholder with real category and
product management for both product types (VPN service products and other
digital products). **No purchasing, checkout, payments, orders or
provisioning** — this phase only manages the catalog that later phases sell
from.

Source: `apps/bot/src/handlers/products/`,
`apps/bot/src/services/{category,product}.service.ts`.

## Admin callbacks

Entry: `admin:products` (admin menu button «مدیریت محصولات/پلن‌ها») →
product management menu, also reachable as `admin:prod:menu`.

| Callback | Action |
| --- | --- |
| `admin:prod:cat` | Category menu |
| `admin:prod:cat:add[:S\|:O]` | Add category (choose type → name → position) |
| `admin:prod:cat:ls:<S\|O>:<page>` | Category list by type (paginated) |
| `admin:prod:cat:view:<sid>` | Category detail (incl. product count) |
| `admin:prod:cat:en/or/tg:<sid>` | Edit name / change position / toggle active |
| `admin:prod:cat:del:<sid>[:yes]` | Soft-disable confirm/execute |
| `admin:prod:adds` / `addo` | Add service / other product wizard |
| `admin:prod:ls` / `ls:<S\|O\|A>:<page>` | Product list filter menu / paginated list |
| `admin:prod:view:<sid>` | Product detail |
| `admin:prod:fe:<sid>:<key>` | Text edits: `nm` name, `pr` price, `inv` invoice text, `dur` duration, `vol` volume, `ord` position, `ruip` user-info prompt |
| `admin:prod:tgl:<sid>` | Enable/disable |
| `admin:prod:del:<sid>[:yes]` | Soft-delete confirm/execute |
| `admin:prod:cats/setcat`, `grp/setgrp`, `pnl/setpnl`, `loc/setloc`, `trc/settrc`, `rui`, `dlv/setdlv` | Pickers: category, display groups, panel, location, traffic reset cycle, user-info toggle, delivery type |
| `admin:prod:f:*` | Add-wizard step callbacks (`pnl`, `grp`, `loc`, `cat`, `newcat`, `trc`, `rui`, `dlv`, `save`) |
| `admin:prod:cancel` | Cancel any product/category flow |

All entity references use 8-char UUID-prefix short ids (resolved by unique
prefix; ambiguous/unknown → «مورد یافت نشد.») keeping callback data far below
Telegram's 64-byte limit.

## Category management

CRUD on `ProductCategory` per type (SERVICE_PRODUCT / OTHER_PRODUCT):
paginated lists, detail with product count, rename, repositioning,
activate/deactivate. **Delete never removes the row** — it deactivates, and
when products exist the admin sees «این دسته‌بندی محصول دارد؛ حذف فیزیکی
انجام نشد و فقط غیرفعال شد.»

## Categories are never created automatically (Phase 7.1)

**Fresh installs have an empty catalog**: the seed intentionally creates no
`ProductCategory` and no `Product` rows — the operator creates every
category manually (with their own names) via «مدیریت دسته‌بندی‌ها» →
«افزودن دسته‌بندی». Product creation **requires an existing active
category**: when none exists for the product type, the add-product wizard
stops, clears its flow and shows «ابتدا باید از بخش مدیریت دسته‌بندی‌ها یک
دسته‌بندی بسازید.» with a button to category management. The old inline
«ساخت دسته‌بندی جدید» shortcut was removed (its legacy callback answers with
a disabled notice and never creates anything), and no fallback-named category
can ever be created — a broken flow state aborts instead.

## Add service product wizard (panel-first since Phase 11.1)

SERVICE_PRODUCT creation selects a **real panel first** — there is no fake
"service type" step, and the no-auto-category rule above still applies.
Panel (picker with status emoji; when none exists: «ابتدا باید از بخش
مدیریت پنل‌ها یک پنل اضافه کنید.» with a «رفتن به مدیریت پنل‌ها» button) →
category (picker of existing active categories only — see above) → name →
display groups (F/N/N2/ALL stored as Json array; ALL = `["F","N","N2"]`) →
location metadata (multi / dedicated / test / all — "all" stores
`allLocations=true, serviceLocation=null`; product metadata, not a purchase
step) → volume GB (0 = unlimited) → duration days (0 = unlimited) → price →
traffic reset cycle (**Marzban panels only**; XUI stores null) → invoice
description (`-` = empty) → display position (0 = end) → confirmation page
→ save → detail.

## Add other product wizard

Name → groups → category → duration (0 = none) → price → invoice description
→ required-user-info yes/no (+ prompt text when yes) → delivery type
(MANUAL_ADMIN, or STOCK_ITEM with the warning «استوک فعلاً فقط در دیتابیس
آماده است...») → position → confirmation → save. `stockEnabled` stays false —
stock delivery is schema-ready only.

## Editing

Detail pages show type-appropriate fields only (escaped HTML per Phase 4.1)
and offer: text edits (name/price/invoice/duration/volume/position/user-info
prompt), pickers (category — product re-appends to the end of its new
category; groups; panel — **switching to an XUI panel clears
trafficResetCycle**; location; reset cycle; delivery), toggles (active,
required-user-info) and soft delete («محصول غیرفعال شد و حذف فیزیکی انجام
نشد.»).

## Ordering behavior

`setCategoryDisplayOrder` / `setProductDisplayOrder`: position N inserts at
slot N among siblings (same type for categories, same category for
products); `0` or beyond-the-end appends; afterwards **all siblings are
renumbered 1..n**, so duplicates and gaps cannot survive. Wizard creation
uses the same helpers (`createCategoryAtOrder` / `createProductAtOrder`).

## Validation

Names 1–120 chars; invoice description 0–1000 (`-` clears); user-info prompt
1–1000; all numbers are integers 0..2,000,000,000; display groups only from
the fixed picker (never free JSON from admins).

## Flow state

`session.currentFlow`: `category:add`, `category:edit`, `product:add`,
`product:edit` with typed state in `session.temp`. Only active admins in one
of these flows have their text consumed; `/start`, `/menu`, `/admin` cancel
the flow and behave normally; the cancel button returns to the product menu.

## Intentionally NOT implemented

User-facing product browsing/purchase, checkout sessions, payments, wallet,
orders, provisioning, Marzban/XUI API calls, stock-item delivery, role-based
admin restrictions, multi-select display groups (single pick per spec). All
other admin sections stay placeholders; panel management is untouched.
