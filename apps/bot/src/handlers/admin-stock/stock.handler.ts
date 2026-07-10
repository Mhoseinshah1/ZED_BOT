import type { OtherProductStockItem, Product } from "@zedbot/database";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import {
  addStockItem,
  disableStockItem,
  getStockCounts,
  getStockItemByShortId,
  getStockProductByShortId,
  INVALID_STOCK_CONTENT_TEXT,
  INVALID_STOCK_LABEL_TEXT,
  isStockDeliveryProduct,
  listStockItems,
  listStockProducts,
  STOCK_CONTENT_MAX,
  STOCK_LABEL_MAX,
  stockContentPreview,
  toggleProductStockEnabled,
} from "../../services/other-product-stock.service.js";
import { escapeHtml } from "../../utils/html.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

// =============================================================================
// «مدیریت موجودی محصولات 🎟» (Phase 25) - encrypted stock inventory for
// OTHER_PRODUCT products, reached from the manual-orders landing. Admins add
// single items (content shown back only as an 8-char masked preview), browse
// item lists (never the raw content), disable AVAILABLE items (no hard
// delete) and toggle per-product stock delivery. Pure configuration - no
// Payment/Order/CheckoutSession rows, nothing is sent to users from here.
// =============================================================================

const NOT_FOUND = "مورد یافت نشد.";
const DRAFT_EXPIRED_TEXT = "درخواست منقضی شده است. لطفاً دوباره شروع کنید.";
const HTML = { parseMode: "HTML" as const };
const CONTENT_FLOW = "admin_stock:content";
const LABEL_FLOW = "admin_stock:label";

const ST_CB = {
  products: "admin:stock:products",
  product: (sid: string): string => `admin:stock:p:${sid}`,
  toggle: (sid: string): string => `admin:stock:toggle:${sid}`,
  add: (sid: string): string => `admin:stock:add:${sid}`,
  addConfirm: "admin:stock:add_confirm",
  addCancel: "admin:stock:add_cancel",
  items: (sid: string, page: number): string => `admin:stock:items:${sid}:${page}`,
  disableItem: (itemSid: string): string => `admin:stock:item_off:${itemSid}`,
} as const;

export const stockHandler = new Composer<BotContext>();

/** Full Phase 25 admin-stock state cleanup (flow + draft). */
export function clearAdminStockState(ctx: BotContext): void {
  if (ctx.session.currentFlow === CONTENT_FLOW || ctx.session.currentFlow === LABEL_FLOW) {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.adminStockDraft;
}

function productShortId(product: Pick<Product, "id">): string {
  return product.id.slice(0, 8);
}

async function renderProducts(ctx: BotContext): Promise<void> {
  clearAdminStockState(ctx);
  const rows = await listStockProducts();
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard();
  for (const row of rows.slice(0, 30)) {
    kb.text(
      `${isStockDeliveryProduct(row) ? "🎟" : "📦"} ${row.name} | ${row.isActive ? "فعال" : "غیرفعال"} | موجود: ${row.counts.available}`,
      ST_CB.product(productShortId(row)),
    ).row();
  }
  kb.text("بازگشت", CB.ADMIN_OTHER_PRODUCTS);
  await safeEditOrReply(
    ctx,
    rows.length === 0
      ? "مدیریت موجودی محصولات 🎟\n\nمحصولی از نوع «محصولات دیگر» وجود ندارد."
      : "مدیریت موجودی محصولات 🎟\n\nیک محصول را انتخاب کنید:",
    kb,
  );
}

async function renderProductPage(ctx: BotContext, product: Product): Promise<void> {
  const counts = await getStockCounts(product.id);
  const sid = productShortId(product);
  const lines = [
    `مدیریت موجودی 🎟 (${escapeHtml(product.name)})`,
    "",
    `وضعیت محصول: ${product.isActive ? "فعال ✅" : "غیرفعال ⏸"}`,
    `نوع تحویل: ${product.deliveryType ?? "-"}`,
    `تحویل استاک: ${isStockDeliveryProduct(product) ? "روشن ✅" : "خاموش ⏸"}`,
    `موجود: ${counts.available} | تحویل‌شده: ${counts.delivered} | غیرفعال: ${counts.disabled}`,
  ];
  if (counts.reserved > 0) {
    lines.push(`رزروشده (در حال تحویل): ${counts.reserved}`);
  }
  if (isStockDeliveryProduct(product) && counts.available === 0) {
    lines.push("", "⚠️ موجودی خودکار تمام شده است؛ سفارش‌های جدید به تحویل دستی می‌روند.");
  }
  const kb = new InlineKeyboard()
    .text("افزودن آیتم موجودی ➕", ST_CB.add(sid))
    .row()
    .text("مشاهده آیتم‌های موجودی", ST_CB.items(sid, 1))
    .row()
    .text(
      product.stockEnabled ? "خاموش کردن تحویل استاک ⏸" : "روشن کردن تحویل استاک ✅",
      ST_CB.toggle(sid),
    )
    .row()
    .text("بازگشت", ST_CB.products);
  await safeEditOrReply(ctx, lines.join("\n"), kb, HTML);
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
  if (item.status === "DELIVERED") {
    if (item.deliveredAt !== null) {
      parts.push(`تحویل: ${item.deliveredAt.toISOString().slice(0, 10)}`);
    }
    if (item.deliveredOrderId !== null) {
      parts.push(`سفارش: ${item.deliveredOrderId.slice(0, 8)}`);
    }
  }
  return parts.join(" | ");
}

async function renderItems(ctx: BotContext, product: Product, page: number): Promise<void> {
  const pageData = await listStockItems(product.id, page);
  const sid = productShortId(product);
  const lines = [`آیتم‌های موجودی (${escapeHtml(product.name)}) — ${pageData.total} آیتم`, ""];
  for (const item of pageData.items) {
    lines.push(`• ${itemLine(item)}`);
  }
  if (pageData.items.length === 0) {
    lines.push("آیتمی ثبت نشده است.");
  }
  const kb = new InlineKeyboard();
  for (const item of pageData.items) {
    if (item.status === "AVAILABLE") {
      kb.text(
        `غیرفعال کردن ${item.label === null || item.label === "" ? item.id.slice(0, 8) : item.label}`,
        ST_CB.disableItem(item.id.slice(0, 8)),
      ).row();
    }
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", ST_CB.items(sid, pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, ST_CB.items(sid, pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", ST_CB.items(sid, pageData.page + 1));
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

stockHandler.callbackQuery(/^admin:stock:item_off:([0-9a-f-]+)$/, async (ctx) => {
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
  await renderItems(ctx, item.product, 1);
});

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

stockHandler.callbackQuery(ST_CB.addCancel, async (ctx) => {
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
  await safeAnswerCallback(ctx, "آیتم موجودی ثبت شد ✅");
  const product = await getStockProductByShortId(draft.productId.slice(0, 8));
  if (product !== null) {
    await renderProductPage(ctx, product);
  }
});

// --- text inputs (content / label) ----------------------------------------------------------

export const stockTextHandler = new Composer<BotContext>();

stockTextHandler.on("message:text", async (ctx, next) => {
  const flow = ctx.session.currentFlow;
  if (ctx.admin === null || (flow !== CONTENT_FLOW && flow !== LABEL_FLOW)) {
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
