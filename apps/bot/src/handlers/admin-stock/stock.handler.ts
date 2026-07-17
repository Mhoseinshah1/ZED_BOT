import type { OtherProductStockItem, OtherProductStockParser, Product } from "@zedbot/database";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { resolveEffectiveProfile } from "../../services/other-product-profile.service.js";
import {
  importStockItems,
  previewStockImport,
} from "../../services/other-product-stock-import.service.js";
import { retryAwaitingStockOrders } from "../../services/specialized-product-fulfillment.service.js";
import {
  addStockItem,
  addStockItemsBulk,
  disableReservedStockItem,
  disableStockItem,
  getStockCounts,
  getStockItemByShortId,
  getStockLowThreshold,
  getStockProductByShortId,
  INVALID_STOCK_CONTENT_TEXT,
  INVALID_STOCK_LABEL_TEXT,
  INVALID_THRESHOLD_TEXT,
  isStockDeliveryProduct,
  listStockItems,
  listStockProducts,
  parseBulkStockInput,
  parseThresholdInput,
  releaseReservedStockItem,
  setStockLowThreshold,
  STOCK_BULK_MAX_ITEMS,
  STOCK_CONTENT_MAX,
  STOCK_LABEL_MAX,
  STOCK_THRESHOLD_MAX,
  stockAlertLevel,
  stockContentPreview,
  toggleProductStockEnabled,
} from "../../services/other-product-stock.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

// =============================================================================
// «مدیریت موجودی محصولات 🎟» (Phase 25) - encrypted stock inventory for
// OTHER_PRODUCT products, reached from the manual-orders landing. Admins add
// single items or one-per-line batches (Phase 27; content shown back only as
// an 8-char masked preview), browse item lists (never the raw content),
// disable AVAILABLE items (no hard delete), recover stuck RESERVED items
// (Phase 26) and toggle per-product stock delivery. Pure configuration - no
// Payment/Order/CheckoutSession rows, nothing is sent to users from here.
// =============================================================================

const NOT_FOUND = "مورد یافت نشد.";
const DRAFT_EXPIRED_TEXT = "درخواست منقضی شده است. لطفاً دوباره شروع کنید.";
const HTML = { parseMode: "HTML" as const };
const CONTENT_FLOW = "admin_stock:content";
const LABEL_FLOW = "admin_stock:label";
const BULK_FLOW = "admin_stock:bulk_content";
const THRESHOLD_FLOW = "admin_stock:threshold";

/**
 * Fix B status aliases for the filtered item lists (kept to one byte so
 * every callback stays far under Telegram's 64-byte limit).
 */
export const STOCK_STATUS_ALIAS = {
  a: "AVAILABLE",
  r: "RESERVED",
  x: "DISABLED",
  d: "DELIVERED",
} as const;
export type StockStatusAlias = keyof typeof STOCK_STATUS_ALIAS;

/** Item-action callbacks carry `:<alias>:<page>` so actions return to the same list. */
const actionSuffix = (status?: StockStatusAlias, page?: number): string =>
  status === undefined ? "" : `:${status}:${page ?? 1}`;

/** Exported for tests (Fix B navigation locks). */
export const ST_CB = {
  products: "admin:stock:products",
  product: (sid: string): string => `admin:stock:p:${sid}`,
  toggle: (sid: string): string => `admin:stock:toggle:${sid}`,
  add: (sid: string): string => `admin:stock:add:${sid}`,
  addConfirm: "admin:stock:add_confirm",
  addCancel: "admin:stock:add_cancel",
  bulkAdd: (sid: string): string => `admin:stock:bulk_add:${sid}`,
  bulkConfirm: "admin:stock:bulk_confirm",
  bulkCancel: "admin:stock:bulk_cancel",
  // Specialized-workflows phase: parser-aware import confirm + the
  // awaiting-stock replenishment retry.
  importConfirm: "admin:stock:imp_confirm",
  retryAwaiting: (sid: string): string => `admin:stock:retry:${sid}`,
  threshold: (sid: string): string => `admin:stock:threshold:${sid}`,
  thresholdClear: (sid: string): string => `admin:stock:threshold_clear:${sid}`,
  // Old all-statuses list (kept working for old keyboards).
  items: (sid: string, page: number): string => `admin:stock:items:${sid}:${page}`,
  // Fix B: status-filtered lists.
  itemsFiltered: (sid: string, status: StockStatusAlias, page: number): string =>
    `admin:stock:items:${sid}:${status}:${page}`,
  disableItem: (itemSid: string, status?: StockStatusAlias, page?: number): string =>
    `admin:stock:item_off:${itemSid}${actionSuffix(status, page)}`,
  releaseReserved: (itemSid: string, status?: StockStatusAlias, page?: number): string =>
    `admin:stock:item_release:${itemSid}${actionSuffix(status, page)}`,
  disableReserved: (itemSid: string, status?: StockStatusAlias, page?: number): string =>
    `admin:stock:item_disable_reserved:${itemSid}${actionSuffix(status, page)}`,
} as const;

export const stockHandler = new Composer<BotContext>();

/** Full admin-stock state cleanup (Phase 25 wizard, Phase 27 bulk, Phase 28 threshold). */
export function clearAdminStockState(ctx: BotContext): void {
  if (
    ctx.session.currentFlow === CONTENT_FLOW ||
    ctx.session.currentFlow === LABEL_FLOW ||
    ctx.session.currentFlow === BULK_FLOW ||
    ctx.session.currentFlow === THRESHOLD_FLOW
  ) {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.adminStockDraft;
}

function productShortId(product: Pick<Product, "id">): string {
  return product.id.slice(0, 8);
}

/**
 * The effective inventory parser of one product (specialized-workflows
 * phase): resolved from the kind/profile columns with the kind defaults.
 * Misconfigured or non-stock products fall back to SINGLE_LINE - i.e. the
 * legacy bulk flow, which is also the pinned behavior for GENERIC products.
 */
function effectiveImportParser(product: Product): OtherProductStockParser {
  try {
    return resolveEffectiveProfile(product).stockParser ?? "SINGLE_LINE";
  } catch {
    return "SINGLE_LINE";
  }
}

/**
 * Runs the awaiting-stock replenishment retry after a successful inventory
 * addition and reports completions (silent when nothing was waiting, so the
 * legacy flows keep their exact pinned messages).
 */
async function reportAwaitingRetryAfterImport(
  ctx: BotContext,
  productId: string,
  always = false,
): Promise<void> {
  const { completed, remaining } = await retryAwaitingStockOrders(ctx.api, productId);
  if (!always && completed === 0) {
    return;
  }
  const lines = [`سفارش‌های در انتظار موجودی تکمیل‌شده: ${completed}`];
  if (remaining > 0) {
    lines.push(`هنوز در انتظار موجودی: ${remaining}`);
  }
  await safeReply(ctx, lines.join("\n"));
}

async function renderProducts(ctx: BotContext): Promise<void> {
  clearAdminStockState(ctx);
  const rows = await listStockProducts();
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard();
  for (const row of rows.slice(0, 30)) {
    // Badge (Phase 28): 🚨 out / ⚠️ low / 🎟 stock-eligible / 📦 manual.
    const level = stockAlertLevel(row, row.counts.available, row.lowThreshold);
    const badge = !isStockDeliveryProduct(row)
      ? "📦"
      : level === "out"
        ? "🚨"
        : level === "low"
          ? "⚠️"
          : "🎟";
    const thresholdPart = row.lowThreshold === null ? "" : ` | حد: ${row.lowThreshold}`;
    kb.text(
      `${badge} ${row.name} | ${row.isActive ? "فعال" : "غیرفعال"} | موجود: ${row.counts.available}${thresholdPart}`,
      ST_CB.product(productShortId(row)),
    ).row();
  }
  kb.text("بازگشت به محصولات دیگر", CB.ADMIN_OTHER_PRODUCTS);
  await safeEditOrReply(
    ctx,
    rows.length === 0
      ? "مدیریت موجودی استاک 🎟\n\nمحصولی از نوع «محصولات دیگر» وجود ندارد."
      : "مدیریت موجودی استاک 🎟\n\nیک محصول را انتخاب کنید:",
    kb,
  );
}

async function renderProductPage(ctx: BotContext, product: Product): Promise<void> {
  const [counts, threshold] = await Promise.all([
    getStockCounts(product.id),
    getStockLowThreshold(product.id),
  ]);
  const lines = [
    `مدیریت موجودی استاک 🎟 (${escapeHtml(product.name)})`,
    "",
    `وضعیت محصول: ${product.isActive ? "فعال ✅" : "غیرفعال ⏸"}`,
    `نوع تحویل: ${product.deliveryType ?? "-"}`,
    `تحویل استاک: ${isStockDeliveryProduct(product) ? "روشن ✅" : "خاموش ⏸"}`,
    `موجود: ${counts.available} | تحویل‌شده: ${counts.delivered} | غیرفعال: ${counts.disabled}`,
    `رزروشده/گیرکرده: ${counts.reserved}`,
    `حد هشدار کمبود: ${threshold === null ? "تنظیم نشده" : threshold === 0 ? "فقط صفر" : `≤ ${threshold}`}`,
  ];
  // Phase 28 warnings: 🚨 exhausted / ⚠️ at-or-below threshold.
  const level = stockAlertLevel(product, counts.available, threshold);
  if (level === "out") {
    lines.push("", "🚨 موجودی این محصول به پایان رسیده است.");
    if (isStockDeliveryProduct(product)) {
      lines.push("سفارش‌های جدید به تحویل دستی می‌روند.");
    }
  } else if (level === "low") {
    lines.push("", "⚠️ موجودی این محصول کم شده است.");
  }
  await safeEditOrReply(ctx, lines.join("\n"), stockProductKeyboard(product, threshold), HTML);
}

/** Stock product page keyboard (Fix B layout). Exported for tests. */
export function stockProductKeyboard(product: Product, threshold: number | null): InlineKeyboard {
  const sid = productShortId(product);
  const kb = new InlineKeyboard()
    .text("افزودن آیتم تکی ➕", ST_CB.add(sid))
    .text("افزودن گروهی آیتم‌ها ➕➕", ST_CB.bulkAdd(sid))
    .row()
    .text("آیتم‌های موجود ✅", ST_CB.itemsFiltered(sid, "a", 1))
    .text("آیتم‌های رزروشده ⏳", ST_CB.itemsFiltered(sid, "r", 1))
    .row()
    .text("آیتم‌های غیرفعال ⏸", ST_CB.itemsFiltered(sid, "x", 1))
    .text("تاریخچه تحویل 📦", ST_CB.itemsFiltered(sid, "d", 1))
    .row()
    .text("تنظیم حد هشدار 🔔", ST_CB.threshold(sid))
    .row()
    // Specialized-workflows phase: manual replenishment retry for paid
    // orders parked as AWAITING_STOCK.
    .text("تکمیل سفارش‌های در انتظار 🔁", ST_CB.retryAwaiting(sid))
    .row();
  if (threshold !== null) {
    kb.text("پاک کردن حد هشدار", ST_CB.thresholdClear(sid)).row();
  }
  kb.text(
    product.stockEnabled ? "خاموش کردن تحویل استاک ⏸" : "روشن کردن تحویل استاک ✅",
    ST_CB.toggle(sid),
  )
    .row()
    .text("بازگشت به لیست محصولات استاک", ST_CB.products)
    .row()
    .text("بازگشت به محصولات دیگر", CB.ADMIN_OTHER_PRODUCTS);
  return kb;
}

function itemLine(item: OtherProductStockItem): string {
  const status =
    item.status === "AVAILABLE"
      ? "موجود ✅"
      : item.status === "DELIVERED"
        ? "تحویل‌شده 📦"
        : item.status === "DISABLED"
          ? "غیرفعال ⏸"
          : "رزروشده ⏳";
  const parts = [status];
  if (item.label !== null && item.label !== "") {
    parts.push(escapeHtml(item.label));
  }
  parts.push(item.createdAt.toISOString().slice(0, 10));
  if (item.status === "DELIVERED" && item.deliveredAt !== null) {
    parts.push(`تحویل: ${item.deliveredAt.toISOString().slice(0, 10)}`);
  }
  // Claim context for RESERVED (stuck) and DELIVERED items alike.
  if (
    (item.status === "DELIVERED" || item.status === "RESERVED") &&
    item.deliveredOrderId !== null
  ) {
    parts.push(`سفارش: ${item.deliveredOrderId.slice(0, 8)}`);
  }
  if (
    (item.status === "DELIVERED" || item.status === "RESERVED") &&
    item.deliveredToUserId !== null
  ) {
    parts.push(`کاربر: ${item.deliveredToUserId.slice(0, 8)}`);
  }
  return parts.join(" | ");
}

const STATUS_LIST_TITLES: Record<StockStatusAlias, string> = {
  a: "آیتم‌های موجود ✅",
  r: "آیتم‌های رزروشده ⏳",
  x: "آیتم‌های غیرفعال ⏸",
  d: "تاریخچه تحویل 📦",
};

/**
 * Action buttons one item may show (Fix B, exported for tests). Existing
 * rules only: AVAILABLE may be disabled; stuck RESERVED may be released or
 * disabled (Phase 26); DISABLED and DELIVERED are immutable here (no
 * re-enable is invented, delivered history stays read-only). Actions carry
 * the current status/page so they return to the same list.
 */
export function stockItemActions(
  item: OtherProductStockItem,
  status?: StockStatusAlias,
  page?: number,
): Array<{ label: string; callback: string }> {
  const itemSid = item.id.slice(0, 8);
  const name = item.label === null || item.label === "" ? itemSid : item.label;
  if (item.status === "AVAILABLE") {
    return [{ label: `غیرفعال کردن ${name}`, callback: ST_CB.disableItem(itemSid, status, page) }];
  }
  if (item.status === "RESERVED") {
    return [
      { label: `آزادسازی رزرو ${name}`, callback: ST_CB.releaseReserved(itemSid, status, page) },
      { label: `غیرفعال کردن رزرو ${name}`, callback: ST_CB.disableReserved(itemSid, status, page) },
    ];
  }
  return [];
}

async function renderItems(
  ctx: BotContext,
  product: Product,
  page: number,
  status?: StockStatusAlias,
): Promise<void> {
  const pageData = await listStockItems(
    product.id,
    page,
    status === undefined ? undefined : STOCK_STATUS_ALIAS[status],
  );
  const sid = productShortId(product);
  const title = status === undefined ? "همه آیتم‌های موجودی" : STATUS_LIST_TITLES[status];
  const lines = [`${title} (${escapeHtml(product.name)}) — ${pageData.total} آیتم`, ""];
  for (const item of pageData.items) {
    lines.push(`• ${itemLine(item)}`);
  }
  if (pageData.items.length === 0) {
    lines.push("آیتمی ثبت نشده است.");
  }
  const kb = new InlineKeyboard();
  for (const item of pageData.items) {
    const actions = stockItemActions(item, status, pageData.page);
    if (actions.length > 0) {
      for (const action of actions) {
        kb.text(action.label, action.callback);
      }
      kb.row();
    }
  }
  const pageCb = (p: number): string =>
    status === undefined ? ST_CB.items(sid, p) : ST_CB.itemsFiltered(sid, status, p);
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", pageCb(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, pageCb(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", pageCb(pageData.page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت", ST_CB.product(sid));
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
}

stockHandler.callbackQuery(ST_CB.products, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  await renderProducts(ctx);
});

stockHandler.callbackQuery(/^admin:stock:p:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminStockState(ctx);
  const product = await getStockProductByShortId(ctx.match[1]);
  if (product === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderProductPage(ctx, product);
});

stockHandler.callbackQuery(/^admin:stock:toggle:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminStockState(ctx);
  const product = await getStockProductByShortId(ctx.match[1]);
  if (product === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const updated = await toggleProductStockEnabled(product.id);
  await safeAnswerCallback(
    ctx,
    updated?.stockEnabled === true ? "تحویل استاک روشن شد ✅" : "تحویل استاک خاموش شد ⏸",
  );
  if (updated !== null) {
    await renderProductPage(ctx, updated);
  }
});

// Old all-statuses list - kept working for old keyboards.
stockHandler.callbackQuery(/^admin:stock:items:([0-9a-f-]+):(\d+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminStockState(ctx);
  const product = await getStockProductByShortId(ctx.match[1]);
  if (product === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderItems(ctx, product, Number.parseInt(ctx.match[2], 10));
});

// Fix B: status-filtered lists (a=available, r=reserved, x=disabled, d=delivered).
stockHandler.callbackQuery(/^admin:stock:items:([0-9a-f-]+):([arxd]):(\d+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminStockState(ctx);
  const product = await getStockProductByShortId(ctx.match[1]);
  if (product === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await safeAnswerCallback(ctx);
  await renderItems(
    ctx,
    product,
    Number.parseInt(ctx.match[3], 10),
    ctx.match[2] as StockStatusAlias,
  );
});

/** Fix B: optional `:<alias>:<page>` on item actions -> back to the same list. */
function actionListContext(ctx: BotContext): { status?: StockStatusAlias; page: number } {
  const match = ctx.match as RegExpMatchArray;
  return match[2] !== undefined
    ? { status: match[2] as StockStatusAlias, page: Number.parseInt(match[3], 10) }
    : { page: 1 };
}

stockHandler.callbackQuery(/^admin:stock:item_off:([0-9a-f-]+)(?::([arxd]):(\d+))?$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const item = await getStockItemByShortId(ctx.match[1]);
  if (item === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const disabled = await disableStockItem(item.id);
  await safeAnswerCallback(
    ctx,
    disabled ? "آیتم غیرفعال شد ⏸" : "این آیتم قابل غیرفعال کردن نیست.",
  );
  const back = actionListContext(ctx);
  await renderItems(ctx, item.product, back.page, back.status);
});

// --- stuck-RESERVED recovery (Phase 26) ------------------------------------------------------

async function handleReservedAction(
  ctx: BotContext,
  itemSid: string,
  action: (itemId: string) => Promise<{ ok: boolean; safeMessage: string; productId?: string }>,
): Promise<void> {
  const item = await getStockItemByShortId(itemSid);
  if (item === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const result = await action(item.id);
  await safeAnswerCallback(ctx, result.safeMessage);
  const back = actionListContext(ctx);
  await renderItems(ctx, item.product, back.page, back.status);
}

stockHandler.callbackQuery(
  /^admin:stock:item_release:([0-9a-f-]+)(?::([arxd]):(\d+))?$/,
  async (ctx) => {
    if (ctx.admin === null) {
      return;
    }
    await handleReservedAction(ctx, ctx.match[1], releaseReservedStockItem);
  },
);

stockHandler.callbackQuery(
  /^admin:stock:item_disable_reserved:([0-9a-f-]+)(?::([arxd]):(\d+))?$/,
  async (ctx) => {
    if (ctx.admin === null) {
      return;
    }
    await handleReservedAction(ctx, ctx.match[1], disableReservedStockItem);
  },
);

// --- add-item wizard -----------------------------------------------------------------------

stockHandler.callbackQuery(/^admin:stock:add:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const product = await getStockProductByShortId(ctx.match[1]);
  if (product === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  ctx.session.temp.adminStockDraft = { productId: product.id };
  ctx.session.currentFlow = CONTENT_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    `محتوای آیتم را وارد کنید. (حداکثر ${STOCK_CONTENT_MAX} کاراکتر - مثل کد، لایسنس یا اطلاعات اکانت)`,
    new InlineKeyboard().text("انصراف", ST_CB.product(ctx.match[1])),
  );
});

stockHandler.callbackQuery([ST_CB.addCancel, ST_CB.bulkCancel], async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const productId = ctx.session.temp.adminStockDraft?.productId;
  clearAdminStockState(ctx);
  await safeAnswerCallback(ctx, "لغو شد.");
  const product =
    productId === undefined ? null : await getStockProductByShortId(productId.slice(0, 8));
  if (product === null) {
    await renderProducts(ctx);
    return;
  }
  await renderProductPage(ctx, product);
});

stockHandler.callbackQuery(ST_CB.addConfirm, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  const draft = ctx.session.temp.adminStockDraft;
  // Consumed BEFORE creating: a double-clicked confirm cannot store twice.
  clearAdminStockState(ctx);
  if (draft === undefined || draft.content === undefined || draft.label === undefined) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const outcome = await addStockItem({
    productId: draft.productId,
    content: draft.content,
    label: draft.label,
    createdByAdminId: admin.id,
  });
  if (!outcome.ok) {
    await safeAnswerCallback(ctx, outcome.safeMessage);
    return;
  }
  await safeAnswerCallback(ctx, "آیتم با موفقیت و به‌صورت رمزنگاری‌شده ذخیره شد ✅");
  // Replenishment retry: a fresh item may complete parked AWAITING_STOCK
  // orders (silent when nothing was waiting - legacy flow stays identical).
  await reportAwaitingRetryAfterImport(ctx, draft.productId);
  const product = await getStockProductByShortId(draft.productId.slice(0, 8));
  if (product !== null) {
    await renderProductPage(ctx, product);
  }
});

// --- bulk-add wizard (Phase 27) --------------------------------------------------------------

/** Parser-specific paste instructions (never echoes any content back). */
function bulkIntroLines(parser: OtherProductStockParser): string[] {
  switch (parser) {
    case "EMAIL_BOUNDARY":
      return [
        "افزودن گروهی موجودی 🎟",
        "",
        "کل موجودی را در یک پیام ارسال کنید.",
        "هر حساب باید با یک خط ایمیل شروع شود؛ خط‌های بعدی تا ایمیل بعدی به همان حساب تعلق می‌گیرند.",
        "پیش از ثبت، پیش‌نمایش شمارش نمایش داده می‌شود.",
      ];
    case "EXPLICIT_SEPARATOR":
      return [
        "افزودن گروهی موجودی 🎟",
        "",
        "کل موجودی را در یک پیام ارسال کنید.",
        "بلاک‌های هر آیتم را با یک خط «---» از هم جدا کنید.",
        "پیش از ثبت، پیش‌نمایش شمارش نمایش داده می‌شود.",
      ];
    case "SINGLE_LINE":
      return [
        "افزودن گروهی موجودی 🎟",
        "",
        "هر خط باید شامل یک آیتم باشد.",
        "خط‌های خالی نادیده گرفته می‌شوند.",
        `(حداکثر ${STOCK_BULK_MAX_ITEMS} آیتم در هر مرحله)`,
      ];
  }
}

stockHandler.callbackQuery(/^admin:stock:bulk_add:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const product = await getStockProductByShortId(ctx.match[1]);
  if (product === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  ctx.session.temp.adminStockDraft = { productId: product.id };
  ctx.session.currentFlow = BULK_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    bulkIntroLines(effectiveImportParser(product)).join("\n"),
    new InlineKeyboard().text("انصراف", ST_CB.bulkCancel),
  );
});

stockHandler.callbackQuery(ST_CB.bulkConfirm, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  const draft = ctx.session.temp.adminStockDraft;
  // Consumed BEFORE creating: a double-clicked confirm cannot store twice.
  clearAdminStockState(ctx);
  if (draft === undefined || draft.bulkItems === undefined || draft.bulkItems.length === 0) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const outcome = await addStockItemsBulk({
    productId: draft.productId,
    contents: draft.bulkItems,
    createdByAdminId: admin.id,
  });
  if (!outcome.ok) {
    await safeAnswerCallback(ctx, outcome.safeMessage);
    return;
  }
  await safeAnswerCallback(
    ctx,
    `${outcome.createdCount} آیتم با موفقیت و به‌صورت رمزنگاری‌شده ذخیره شد ✅`,
  );
  // Replenishment retry after the legacy bulk add (silent when idle).
  await reportAwaitingRetryAfterImport(ctx, draft.productId);
  const product = await getStockProductByShortId(draft.productId.slice(0, 8));
  if (product !== null) {
    await renderProductPage(ctx, product);
  }
});

// --- parser-aware import (specialized-workflows phase) ---------------------------------------
//
// EMAIL_BOUNDARY / EXPLICIT_SEPARATOR products route the bulk paste through
// previewStockImport (counts + masked identifiers, NEVER content) and this
// confirm re-runs importStockItems from the session draft - stateless
// re-validation, one all-or-nothing createMany, fingerprint dedup.

stockHandler.callbackQuery(ST_CB.importConfirm, async (ctx) => {
  const admin = ctx.admin;
  if (admin === null) {
    return;
  }
  const draft = ctx.session.temp.adminStockDraft;
  // Consumed BEFORE importing: a double-clicked confirm cannot import twice.
  clearAdminStockState(ctx);
  if (draft === undefined || draft.parserRaw === undefined) {
    await safeAnswerCallback(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const product = await getStockProductByShortId(draft.productId.slice(0, 8));
  if (product === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const parser = effectiveImportParser(product);
  const result = await importStockItems(product.id, admin.id, parser, draft.parserRaw);
  if (!result.ok) {
    await safeAnswerCallback(ctx, "ثبت انجام نشد ❌");
    await safeEditOrReply(
      ctx,
      ["ثبت گروهی موجودی ناموفق بود ❌", "", ...result.errors.map((e) => `• ${escapeHtml(e)}`)].join(
        "\n",
      ),
      new InlineKeyboard()
        .text("تلاش دوباره ➕➕", ST_CB.bulkAdd(productShortId(product)))
        .row()
        .text("بازگشت", ST_CB.product(productShortId(product))),
      HTML,
    );
    return;
  }
  await safeAnswerCallback(ctx, "آیتم‌ها به‌صورت رمزنگاری‌شده ذخیره شدند ✅");
  const { completed, remaining } = await retryAwaitingStockOrders(ctx.api, product.id);
  const lines = [
    "نتیجه افزودن گروهی موجودی 🎟",
    "",
    `محصول: ${escapeHtml(product.name)}`,
    `آیتم‌های افزوده‌شده: ${result.importedCount}`,
    `سفارش‌های در انتظار موجودی تکمیل‌شده: ${completed}`,
  ];
  if (remaining > 0) {
    lines.push(`هنوز در انتظار موجودی: ${remaining}`);
  }
  await safeEditOrReply(
    ctx,
    lines.join("\n"),
    new InlineKeyboard().text("بازگشت به محصول", ST_CB.product(productShortId(product))),
    HTML,
  );
});

// Manual replenishment retry («تکمیل سفارش‌های در انتظار 🔁»).
stockHandler.callbackQuery(/^admin:stock:retry:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminStockState(ctx);
  const product = await getStockProductByShortId(ctx.match[1]);
  if (product === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  const { completed, remaining } = await retryAwaitingStockOrders(ctx.api, product.id);
  await safeAnswerCallback(ctx, `تکمیل‌شده: ${completed} | هنوز در انتظار: ${remaining}`);
  await renderProductPage(ctx, product);
});

// --- low-stock threshold (Phase 28) ----------------------------------------------------------

stockHandler.callbackQuery(/^admin:stock:threshold:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  const product = await getStockProductByShortId(ctx.match[1]);
  if (product === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  ctx.session.temp.adminStockDraft = { productId: product.id, thresholdEditing: true };
  ctx.session.currentFlow = THRESHOLD_FLOW;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    [
      "هشدار کمبود موجودی 🔔",
      "",
      "حد آلارم موجودی را وارد کنید.",
      "برای هشدار فقط هنگام صفر شدن، عدد 0 را وارد کنید.",
      "برای حذف، - را بزنید.",
      `(عدد صحیح 0 تا ${STOCK_THRESHOLD_MAX})`,
    ].join("\n"),
    new InlineKeyboard().text("انصراف", ST_CB.product(ctx.match[1])),
  );
});

stockHandler.callbackQuery(/^admin:stock:threshold_clear:([0-9a-f-]+)$/, async (ctx) => {
  if (ctx.admin === null) {
    return;
  }
  clearAdminStockState(ctx);
  const product = await getStockProductByShortId(ctx.match[1]);
  if (product === null) {
    await safeAnswerCallback(ctx, NOT_FOUND);
    return;
  }
  await setStockLowThreshold(product.id, null);
  await safeAnswerCallback(ctx, "هشدار کمبود موجودی حذف شد.");
  await renderProductPage(ctx, product);
});

// --- text inputs (content / label) ----------------------------------------------------------

export const stockTextHandler = new Composer<BotContext>();

stockTextHandler.on("message:text", async (ctx, next) => {
  const flow = ctx.session.currentFlow;
  if (
    ctx.admin === null ||
    (flow !== CONTENT_FLOW && flow !== LABEL_FLOW && flow !== BULK_FLOW && flow !== THRESHOLD_FLOW)
  ) {
    return next();
  }
  const text = ctx.message.text;
  // Commands cancel the flow and continue normally.
  if (text.startsWith("/")) {
    clearAdminStockState(ctx);
    return next();
  }
  const draft = ctx.session.temp.adminStockDraft;
  if (draft === undefined) {
    clearAdminStockState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  const cancelKb = new InlineKeyboard().text("انصراف", ST_CB.addCancel);

  if (flow === THRESHOLD_FLOW) {
    const parsed = parseThresholdInput(text);
    if (parsed.kind === "invalid") {
      // Flow stays active so the admin can resend a corrected value.
      await safeReply(
        ctx,
        INVALID_THRESHOLD_TEXT,
        new InlineKeyboard().text("انصراف", ST_CB.product(draft.productId.slice(0, 8))),
      );
      return;
    }
    const product = await getStockProductByShortId(draft.productId.slice(0, 8));
    clearAdminStockState(ctx);
    if (product === null) {
      await safeReply(ctx, DRAFT_EXPIRED_TEXT);
      return;
    }
    await setStockLowThreshold(product.id, parsed.kind === "clear" ? null : parsed.value);
    await safeReply(
      ctx,
      parsed.kind === "clear"
        ? "هشدار کمبود موجودی حذف شد."
        : "حد هشدار کمبود موجودی ثبت شد ✅",
    );
    await renderProductPage(ctx, product);
    return;
  }

  if (flow === BULK_FLOW) {
    const bulkCancelKb = new InlineKeyboard().text("انصراف", ST_CB.bulkCancel);
    // Parser-aware routing (specialized-workflows phase): EMAIL_BOUNDARY /
    // EXPLICIT_SEPARATOR products preview via the fingerprint-dedup import;
    // SINGLE_LINE products continue on the exact legacy flow below.
    const importProduct = await getStockProductByShortId(draft.productId.slice(0, 8));
    const importParser =
      importProduct === null ? "SINGLE_LINE" : effectiveImportParser(importProduct);
    if (importProduct !== null && importParser !== "SINGLE_LINE") {
      const preview = await previewStockImport(importProduct.id, importParser, text);
      if (!preview.ok) {
        // Flow stays active so the admin can resend a corrected paste.
        const errorLines = [
          "ثبت ممکن نیست ❌",
          "",
          ...preview.errors.map((error) => `• ${escapeHtml(error)}`),
        ];
        if (preview.warnings.length > 0) {
          errorLines.push("", "هشدارها:", ...preview.warnings.map((w) => `• ${escapeHtml(w)}`));
        }
        await safeReply(ctx, errorLines.join("\n"), bulkCancelKb, HTML);
        return;
      }
      // The raw paste stays ONLY in the session draft; the confirm re-parses
      // and re-validates it from scratch (stateless preview by design).
      draft.parserRaw = text;
      ctx.session.currentFlow = null;
      const lines = [
        "پیش‌نمایش افزودن گروهی موجودی 🎟",
        "",
        `محصول: ${escapeHtml(importProduct.name)}`,
        `تعداد شناسایی‌شده: ${preview.itemCount}`,
        ...(preview.maskedFirst !== null
          ? [`اولین مورد: ${escapeHtml(preview.maskedFirst)}`]
          : []),
        ...(preview.maskedLast !== null && preview.itemCount > 1
          ? [`آخرین مورد: ${escapeHtml(preview.maskedLast)}`]
          : []),
        `خطوط نامعتبر: ${preview.invalidLineCount}`,
        `تکراری در متن: ${preview.batchDuplicateCount}`,
        `تکراری در موجودی: ${preview.existingDuplicateCount}`,
      ];
      if (preview.warnings.length > 0) {
        lines.push("", "هشدارها:", ...preview.warnings.map((w) => `• ${escapeHtml(w)}`));
      }
      lines.push(
        "",
        "محتوای کامل هرگز نمایش داده نمی‌شود.",
        "",
        "آیا از افزودن این آیتم‌ها مطمئن هستید؟",
      );
      await safeReply(
        ctx,
        lines.join("\n"),
        new InlineKeyboard()
          .text("تایید و افزودن ✅", ST_CB.importConfirm)
          .row()
          .text("انصراف", ST_CB.bulkCancel),
        HTML,
      );
      return;
    }
    const parsed = parseBulkStockInput(text);
    if (!parsed.ok) {
      // Flow stays active so the admin can resend a corrected list.
      await safeReply(ctx, parsed.safeMessage, bulkCancelKb);
      return;
    }
    const product = await getStockProductByShortId(draft.productId.slice(0, 8));
    if (product === null) {
      clearAdminStockState(ctx);
      await safeReply(ctx, DRAFT_EXPIRED_TEXT);
      return;
    }
    draft.bulkItems = parsed.items;
    draft.invalidCount = parsed.invalidCount;
    draft.duplicateCount = parsed.duplicateCount;
    ctx.session.currentFlow = null;
    await safeReply(
      ctx,
      [
        "افزودن گروهی موجودی 🎟",
        "",
        `محصول: ${escapeHtml(product.name)}`,
        `آیتم‌های معتبر برای ثبت: ${parsed.items.length}`,
        `آیتم‌های تکراری حذف شدند: ${parsed.duplicateCount}`,
        `نامعتبر (نادیده گرفته‌شده): ${parsed.invalidCount}`,
        "",
        "پیش‌نمایش:",
        ...parsed.items
          .slice(0, 5)
          .map((item) => `• <code>${escapeHtml(stockContentPreview(item))}</code>`),
        "",
        "محتوای کامل بعد از ثبت نمایش داده نمی‌شود.",
        "",
        "آیا از افزودن این آیتم‌ها مطمئن هستید؟",
      ].join("\n"),
      new InlineKeyboard()
        .text("تایید افزودن گروهی ✅", ST_CB.bulkConfirm)
        .row()
        .text("انصراف", ST_CB.bulkCancel),
      HTML,
    );
    return;
  }

  if (flow === CONTENT_FLOW) {
    const content = text.trim();
    if (content.length === 0 || content.length > STOCK_CONTENT_MAX) {
      await safeReply(ctx, INVALID_STOCK_CONTENT_TEXT, cancelKb);
      return;
    }
    draft.content = content;
    ctx.session.currentFlow = LABEL_FLOW;
    await safeReply(
      ctx,
      `برچسب اختیاری را وارد کنید یا - بزنید. (حداکثر ${STOCK_LABEL_MAX} کاراکتر)`,
      cancelKb,
    );
    return;
  }

  // LABEL_FLOW
  const rawLabel = text.trim();
  if (rawLabel.length > STOCK_LABEL_MAX) {
    await safeReply(ctx, INVALID_STOCK_LABEL_TEXT, cancelKb);
    return;
  }
  draft.label = rawLabel === "-" || rawLabel === "" ? null : rawLabel;
  ctx.session.currentFlow = null;
  const product = await getStockProductByShortId(draft.productId.slice(0, 8));
  if (product === null || draft.content === undefined) {
    clearAdminStockState(ctx);
    await safeReply(ctx, DRAFT_EXPIRED_TEXT);
    return;
  }
  await safeReply(
    ctx,
    [
      "افزودن آیتم موجودی 🎟",
      "",
      `محصول: ${escapeHtml(product.name)}`,
      `برچسب: ${draft.label === null ? "-" : escapeHtml(draft.label)}`,
      `پیش‌نمایش محتوا: <code>${escapeHtml(stockContentPreview(draft.content))}</code>`,
      "",
      "آیا از افزودن این آیتم مطمئن هستید؟",
    ].join("\n"),
    new InlineKeyboard().text("تایید افزودن ✅", ST_CB.addConfirm).row().text("انصراف", ST_CB.addCancel),
    HTML,
  );
});
