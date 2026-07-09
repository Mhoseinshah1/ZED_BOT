import {
  PanelStatus,
  prisma,
  type OtherProductDeliveryType,
  type ProductCategory,
  type ServiceLocation,
  type TrafficResetCycle,
} from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import type { ProductAddState } from "../../core/session.js";
import {
  activeCategories,
  categoryProductCount,
  categoryShortId,
  createCategoryAtOrder,
  getCategoryByShortId,
  listCategories,
  setCategoryDisplayOrder,
  updateCategory,
} from "../../services/category.service.js";
import { getPanelByShortId } from "../../services/panel.service.js";
import {
  createProductAtOrder,
  getProductByShortId,
  listProducts,
  productShortId,
  productTypeOf,
  setProductDisplayOrder,
  softDeleteProduct,
  updateProduct,
  type ProductWithRelations,
} from "../../services/product.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import { pcb, PROD_CB } from "./product-cb.js";
import {
  addConfirmationKeyboard,
  addConfirmationText,
  categoryDetailKeyboard,
  categoryDetailText,
  categoryListKeyboard,
  categoryMenuKeyboard,
  categoryPickerKeyboard,
  deliveryKeyboard,
  groupsKeyboard,
  locationKeyboard,
  panelPickerKeyboard,
  productDetailKeyboard,
  productDetailText,
  productListKeyboard,
  productListMenuKeyboard,
  productMenuText,
  productMenuKeyboard,
  resetCycleKeyboard,
} from "./product-views.js";

const HTML = { parseMode: "HTML" as const };
const STOCK_WARNING = "استوک فعلاً فقط در دیتابیس آماده است و تحویل خودکار بعداً پیاده می‌شود.";

export const productHandler = new Composer<BotContext>();

// --- helpers -------------------------------------------------------------------

function clearProductFlows(ctx: BotContext): void {
  ctx.session.currentFlow = null;
  ctx.session.temp.categoryAdd = undefined;
  ctx.session.temp.editingCategoryId = undefined;
  ctx.session.temp.editingCategoryField = undefined;
  ctx.session.temp.productAdd = undefined;
  ctx.session.temp.editingProductId = undefined;
  ctx.session.temp.editingProductField = undefined;
}

function cancelKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("لغو ❌", PROD_CB.CANCEL);
}

async function showProductMenu(ctx: BotContext): Promise<void> {
  await safeEditOrReply(ctx, productMenuText(), productMenuKeyboard());
}

async function showProductDetail(ctx: BotContext, product: ProductWithRelations): Promise<void> {
  await safeEditOrReply(ctx, productDetailText(product), productDetailKeyboard(product), HTML);
}

async function showCategoryDetail(ctx: BotContext, category: ProductCategory): Promise<void> {
  const count = await categoryProductCount(category.id);
  await safeEditOrReply(ctx, categoryDetailText(category, count), categoryDetailKeyboard(category), HTML);
}

async function resolveProduct(ctx: BotContext, sid: string): Promise<ProductWithRelations | null> {
  const product = await getProductByShortId(sid);
  if (product === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
  }
  return product;
}

async function resolveCategory(ctx: BotContext, sid: string): Promise<ProductCategory | null> {
  const category = await getCategoryByShortId(sid);
  if (category === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
  }
  return category;
}

// --- input validation ------------------------------------------------------------

const MAX_INT = 2_000_000_000;

function parseNonNegativeInt(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    return null;
  }
  const value = Number.parseInt(text, 10);
  return value > MAX_INT ? null : value;
}

function validName(raw: string): string | null {
  const text = raw.trim();
  return text.length >= 1 && text.length <= 120 ? text : null;
}

// --- root menu + cancel ------------------------------------------------------------

productHandler.callbackQuery([CB.ADMIN_PRODUCTS, PROD_CB.MENU], async (ctx) => {
  clearProductFlows(ctx);
  await safeAnswerCallback(ctx);
  await showProductMenu(ctx);
});

productHandler.callbackQuery(PROD_CB.NOOP, async (ctx) => {
  await safeAnswerCallback(ctx);
});

productHandler.callbackQuery(PROD_CB.CANCEL, async (ctx) => {
  clearProductFlows(ctx);
  await safeAnswerCallback(ctx, "لغو شد.");
  await showProductMenu(ctx);
});

// --- category management ------------------------------------------------------------

productHandler.callbackQuery(PROD_CB.CAT_MENU, async (ctx) => {
  clearProductFlows(ctx);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, "مدیریت دسته‌بندی‌ها 📂", categoryMenuKeyboard());
});

productHandler.callbackQuery(PROD_CB.CAT_ADD, async (ctx) => {
  await safeAnswerCallback(ctx);
  const kb = new InlineKeyboard()
    .text("سرویس VPN", pcb.catAddType("S"))
    .text("محصولات دیگر", pcb.catAddType("O"))
    .row()
    .text("بازگشت", PROD_CB.CAT_MENU);
  await safeEditOrReply(ctx, "نوع دسته‌بندی را انتخاب کنید:", kb);
});

productHandler.callbackQuery(/^admin:prod:cat:add:(S|O)$/, async (ctx) => {
  clearProductFlows(ctx);
  ctx.session.currentFlow = "category:add";
  ctx.session.temp.categoryAdd = { step: "name", type: productTypeOf(ctx.match[1] as "S" | "O") };
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, "نام دسته‌بندی را وارد کنید.", cancelKeyboard());
});

productHandler.callbackQuery(/^admin:prod:cat:ls:(S|O):(\d+)$/, async (ctx) => {
  const type = ctx.match[1] as "S" | "O";
  const { categories, page, pages, total } = await listCategories(
    productTypeOf(type),
    Number.parseInt(ctx.match[2], 10),
  );
  await safeAnswerCallback(ctx);
  const title =
    total === 0
      ? "هیچ دسته‌بندی‌ای ثبت نشده است."
      : `دسته‌بندی‌های ${type === "S" ? "سرویس‌ها" : "محصولات دیگر"} (${total})`;
  await safeEditOrReply(ctx, title, categoryListKeyboard(categories, type, page, pages));
});

productHandler.callbackQuery(/^admin:prod:cat:view:(.+)$/, async (ctx) => {
  const category = await resolveCategory(ctx, ctx.match[1]);
  if (category === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  await showCategoryDetail(ctx, category);
});

productHandler.callbackQuery(/^admin:prod:cat:en:(.+)$/, async (ctx) => {
  const category = await resolveCategory(ctx, ctx.match[1]);
  if (category === null) {
    return;
  }
  clearProductFlows(ctx);
  ctx.session.currentFlow = "category:edit";
  ctx.session.temp.editingCategoryId = category.id;
  ctx.session.temp.editingCategoryField = "name";
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, "نام جدید دسته‌بندی را وارد کنید.", cancelKeyboard());
});

productHandler.callbackQuery(/^admin:prod:cat:or:(.+)$/, async (ctx) => {
  const category = await resolveCategory(ctx, ctx.match[1]);
  if (category === null) {
    return;
  }
  clearProductFlows(ctx);
  ctx.session.currentFlow = "category:edit";
  ctx.session.temp.editingCategoryId = category.id;
  ctx.session.temp.editingCategoryField = "order";
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    "این دسته‌بندی در جایگاه چندم نمایش داده شود؟ عدد بفرستید یا برای انتهای لیست 0 بفرستید.",
    cancelKeyboard(),
  );
});

productHandler.callbackQuery(/^admin:prod:cat:tg:(.+)$/, async (ctx) => {
  const category = await resolveCategory(ctx, ctx.match[1]);
  if (category === null) {
    return;
  }
  const updated = await updateCategory(category.id, { isActive: !category.isActive });
  await safeAnswerCallback(ctx, updated.isActive ? "فعال شد 🟢" : "غیرفعال شد ⚪️");
  await showCategoryDetail(ctx, updated);
});

productHandler.callbackQuery(/^admin:prod:cat:del:([^:]+)$/, async (ctx) => {
  const category = await resolveCategory(ctx, ctx.match[1]);
  if (category === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const sid = categoryShortId(category);
  const kb = new InlineKeyboard()
    .text("بله، غیرفعال کن", pcb.catDeleteConfirm(sid))
    .row()
    .text("انصراف", pcb.catView(sid));
  await safeEditOrReply(
    ctx,
    "حذف فیزیکی انجام نمی‌شود؛ دسته‌بندی فقط غیرفعال خواهد شد. ادامه؟",
    kb,
  );
});

productHandler.callbackQuery(/^admin:prod:cat:del:([^:]+):yes$/, async (ctx) => {
  const category = await resolveCategory(ctx, ctx.match[1]);
  if (category === null) {
    return;
  }
  const count = await categoryProductCount(category.id);
  const updated = await updateCategory(category.id, { isActive: false });
  await safeAnswerCallback(ctx, "انجام شد.");
  const message =
    count > 0
      ? "این دسته‌بندی محصول دارد؛ حذف فیزیکی انجام نشد و فقط غیرفعال شد."
      : "دسته‌بندی غیرفعال شد (حذف فیزیکی انجام نمی‌شود).";
  await safeEditOrReply(
    ctx,
    message,
    new InlineKeyboard().text("بازگشت", pcb.catView(categoryShortId(updated))),
  );
});

// --- product list ------------------------------------------------------------------

productHandler.callbackQuery(PROD_CB.LIST_MENU, async (ctx) => {
  clearProductFlows(ctx);
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, "لیست محصولات 📋\n\nکدام دسته؟", productListMenuKeyboard());
});

productHandler.callbackQuery(/^admin:prod:ls:(S|O|A):(\d+)$/, async (ctx) => {
  const filter = ctx.match[1] as "S" | "O" | "A";
  const { products, page, pages, total } = await listProducts(
    filter,
    Number.parseInt(ctx.match[2], 10),
  );
  await safeAnswerCallback(ctx);
  const title = total === 0 ? "محصولی ثبت نشده است." : `محصولات (${total})`;
  await safeEditOrReply(ctx, title, productListKeyboard(products, filter, page, pages));
});

productHandler.callbackQuery(/^admin:prod:view:(.+)$/, async (ctx) => {
  clearProductFlows(ctx);
  const product = await resolveProduct(ctx, ctx.match[1]);
  if (product === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  await showProductDetail(ctx, product);
});

// --- product simple actions ---------------------------------------------------------

productHandler.callbackQuery(/^admin:prod:tgl:(.+)$/, async (ctx) => {
  const product = await resolveProduct(ctx, ctx.match[1]);
  if (product === null) {
    return;
  }
  const updated = await updateProduct(product.id, { isActive: !product.isActive });
  await safeAnswerCallback(ctx, updated.isActive ? "فعال شد 🟢" : "غیرفعال شد ⚪️");
  await showProductDetail(ctx, updated);
});

productHandler.callbackQuery(/^admin:prod:del:([^:]+)$/, async (ctx) => {
  const product = await resolveProduct(ctx, ctx.match[1]);
  if (product === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const sid = productShortId(product);
  const kb = new InlineKeyboard()
    .text("بله، غیرفعال کن", pcb.deleteConfirm(sid))
    .row()
    .text("انصراف", pcb.view(sid));
  await safeEditOrReply(ctx, "حذف فیزیکی انجام نمی‌شود؛ محصول فقط غیرفعال خواهد شد. ادامه؟", kb);
});

productHandler.callbackQuery(/^admin:prod:del:([^:]+):yes$/, async (ctx) => {
  const product = await resolveProduct(ctx, ctx.match[1]);
  if (product === null) {
    return;
  }
  const updated = await softDeleteProduct(product.id);
  await safeAnswerCallback(ctx, "انجام شد.");
  await safeEditOrReply(
    ctx,
    "محصول غیرفعال شد و حذف فیزیکی انجام نشد.",
    new InlineKeyboard().text("بازگشت", pcb.view(productShortId(updated))),
  );
});

// --- product pickers (edit) ----------------------------------------------------------

productHandler.callbackQuery(/^admin:prod:cats:(.+)$/, async (ctx) => {
  const product = await resolveProduct(ctx, ctx.match[1]);
  if (product === null) {
    return;
  }
  const categories = await activeCategories(product.type);
  await safeAnswerCallback(ctx);
  const sid = productShortId(product);
  await safeEditOrReply(
    ctx,
    "دسته‌بندی جدید را انتخاب کنید:",
    categoryPickerKeyboard(categories, (catSid) => pcb.setCategory(sid, catSid), {
      backCb: pcb.view(sid),
    }),
  );
});

productHandler.callbackQuery(/^admin:prod:setcat:([^:]+):([^:]+)$/, async (ctx) => {
  const product = await resolveProduct(ctx, ctx.match[1]);
  if (product === null) {
    return;
  }
  const category = await resolveCategory(ctx, ctx.match[2]);
  if (category === null) {
    return;
  }
  await updateProduct(product.id, { categoryId: category.id });
  // Append to the end of the new category so orders stay clean.
  await setProductDisplayOrder(product.id, 0);
  const updated = await getProductByShortId(ctx.match[1]);
  await safeAnswerCallback(ctx, "دسته‌بندی بروزرسانی شد ✅");
  if (updated !== null) {
    await showProductDetail(ctx, updated);
  }
});

productHandler.callbackQuery(/^admin:prod:grp:(.+)$/, async (ctx) => {
  const product = await resolveProduct(ctx, ctx.match[1]);
  if (product === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const sid = productShortId(product);
  await safeEditOrReply(
    ctx,
    "گروه نمایش را انتخاب کنید:",
    groupsKeyboard((g) => pcb.setGroups(sid, g), pcb.view(sid)),
  );
});

function groupsFromCode(code: string): string[] {
  return code === "ALL" ? ["F", "N", "N2"] : [code];
}

productHandler.callbackQuery(/^admin:prod:setgrp:([^:]+):(F|N|N2|ALL)$/, async (ctx) => {
  const product = await resolveProduct(ctx, ctx.match[1]);
  if (product === null) {
    return;
  }
  const updated = await updateProduct(product.id, { displayGroups: groupsFromCode(ctx.match[2]) });
  await safeAnswerCallback(ctx, "گروه نمایش بروزرسانی شد ✅");
  await showProductDetail(ctx, updated);
});

productHandler.callbackQuery(/^admin:prod:pnl:(.+)$/, async (ctx) => {
  const product = await resolveProduct(ctx, ctx.match[1]);
  if (product === null) {
    return;
  }
  const panels = await prisma.panel.findMany({
    orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
  });
  await safeAnswerCallback(ctx);
  const sid = productShortId(product);
  await safeEditOrReply(
    ctx,
    "پنل جدید را انتخاب کنید:",
    panelPickerKeyboard(panels, (panelSid) => pcb.setPanel(sid, panelSid), pcb.view(sid)),
  );
});

productHandler.callbackQuery(/^admin:prod:setpnl:([^:]+):([^:]+)$/, async (ctx) => {
  const product = await resolveProduct(ctx, ctx.match[1]);
  if (product === null) {
    return;
  }
  const panel = await getPanelByShortId(ctx.match[2]);
  if (panel === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }
  // XUI products never carry a traffic reset cycle.
  const updated = await updateProduct(product.id, {
    panelId: panel.id,
    ...(panel.type === "XUI" ? { trafficResetCycle: null } : {}),
  });
  await safeAnswerCallback(ctx, "پنل بروزرسانی شد ✅");
  await showProductDetail(ctx, updated);
});

productHandler.callbackQuery(/^admin:prod:loc:(.+)$/, async (ctx) => {
  const product = await resolveProduct(ctx, ctx.match[1]);
  if (product === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const sid = productShortId(product);
  await safeEditOrReply(
    ctx,
    "موقعیت سرویس را انتخاب کنید:",
    locationKeyboard((l) => pcb.setLocation(sid, l), pcb.view(sid)),
  );
});

const LOCATION_CODE: Record<string, ServiceLocation> = {
  M: "MULTI_LOCATION",
  D: "DEDICATED_LOCATION",
  T: "TEST",
};

productHandler.callbackQuery(/^admin:prod:setloc:([^:]+):(M|D|T|A)$/, async (ctx) => {
  const product = await resolveProduct(ctx, ctx.match[1]);
  if (product === null) {
    return;
  }
  const code = ctx.match[2];
  const updated = await updateProduct(
    product.id,
    code === "A"
      ? { allLocations: true, serviceLocation: null }
      : { allLocations: false, serviceLocation: LOCATION_CODE[code] },
  );
  await safeAnswerCallback(ctx, "موقعیت بروزرسانی شد ✅");
  await showProductDetail(ctx, updated);
});

productHandler.callbackQuery(/^admin:prod:trc:(.+)$/, async (ctx) => {
  const product = await resolveProduct(ctx, ctx.match[1]);
  if (product === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const sid = productShortId(product);
  await safeEditOrReply(
    ctx,
    "دوره ریست ترافیک را انتخاب کنید:",
    resetCycleKeyboard((c) => pcb.setResetCycle(sid, c), pcb.view(sid)),
  );
});

productHandler.callbackQuery(
  /^admin:prod:settrc:([^:]+):(NO_RESET|DAY|WEEK|MONTH|YEAR)$/,
  async (ctx) => {
    const product = await resolveProduct(ctx, ctx.match[1]);
    if (product === null) {
      return;
    }
    const updated = await updateProduct(product.id, {
      trafficResetCycle: ctx.match[2] as TrafficResetCycle,
    });
    await safeAnswerCallback(ctx, "ریست ترافیک بروزرسانی شد ✅");
    await showProductDetail(ctx, updated);
  },
);

productHandler.callbackQuery(/^admin:prod:rui:(.+)$/, async (ctx) => {
  const product = await resolveProduct(ctx, ctx.match[1]);
  if (product === null) {
    return;
  }
  const enabling = !product.requiredUserInfoEnabled;
  const updated = await updateProduct(product.id, { requiredUserInfoEnabled: enabling });
  await safeAnswerCallback(
    ctx,
    enabling ? "فعال شد ✅ (متن درخواست اطلاعات را هم تنظیم کنید)" : "غیرفعال شد ❌",
  );
  await showProductDetail(ctx, updated);
});

productHandler.callbackQuery(/^admin:prod:dlv:(.+)$/, async (ctx) => {
  const product = await resolveProduct(ctx, ctx.match[1]);
  if (product === null) {
    return;
  }
  await safeAnswerCallback(ctx);
  const sid = productShortId(product);
  await safeEditOrReply(
    ctx,
    "نوع تحویل را انتخاب کنید:",
    deliveryKeyboard((d) => pcb.setDelivery(sid, d), pcb.view(sid)),
  );
});

productHandler.callbackQuery(/^admin:prod:setdlv:([^:]+):(M|S)$/, async (ctx) => {
  const product = await resolveProduct(ctx, ctx.match[1]);
  if (product === null) {
    return;
  }
  const delivery: OtherProductDeliveryType = ctx.match[2] === "M" ? "MANUAL_ADMIN" : "STOCK_ITEM";
  const updated = await updateProduct(product.id, { deliveryType: delivery });
  await safeAnswerCallback(ctx, delivery === "STOCK_ITEM" ? STOCK_WARNING : "بروزرسانی شد ✅");
  await showProductDetail(ctx, updated);
});

// --- product text-field edits ---------------------------------------------------------

const PRODUCT_TEXT_FIELDS: Record<string, { prompt: string; serviceOnly?: boolean; otherOnly?: boolean }> = {
  nm: { prompt: "نام جدید محصول را وارد کنید." },
  pr: { prompt: "قیمت را به تومان وارد کنید." },
  inv: { prompt: "توضیحات محصول برای پیش‌فاکتور را وارد کنید. (برای خالی کردن «-» بفرستید)" },
  dur: { prompt: "مدت زمان را به روز وارد کنید. برای نامحدود عدد 0 را بفرستید." },
  vol: { prompt: "حجم را به گیگ وارد کنید. برای نامحدود عدد 0 را بفرستید.", serviceOnly: true },
  ord: {
    prompt: "این محصول در جایگاه چندم نمایش داده شود؟ عدد بفرستید یا برای انتهای لیست 0 بفرستید.",
  },
  ruip: { prompt: "متنی که بعد از پرداخت از کاربر پرسیده می‌شود را وارد کنید.", otherOnly: true },
};

productHandler.callbackQuery(/^admin:prod:fe:([^:]+):([a-z]+)$/, async (ctx) => {
  const product = await resolveProduct(ctx, ctx.match[1]);
  if (product === null) {
    return;
  }
  const fieldKey = ctx.match[2];
  const field = PRODUCT_TEXT_FIELDS[fieldKey];
  if (
    field === undefined ||
    (field.serviceOnly === true && product.type !== "SERVICE_PRODUCT") ||
    (field.otherOnly === true && product.type !== "OTHER_PRODUCT")
  ) {
    await safeAnswerCallback(ctx, "فیلد نامعتبر است.");
    return;
  }
  clearProductFlows(ctx);
  ctx.session.currentFlow = "product:edit";
  ctx.session.temp.editingProductId = product.id;
  ctx.session.temp.editingProductField = fieldKey;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, field.prompt, cancelKeyboard());
});

// --- add-wizard entry + callback steps -------------------------------------------------

productHandler.callbackQuery(PROD_CB.ADD_SERVICE, async (ctx) => {
  clearProductFlows(ctx);
  const panels = await prisma.panel.findMany({
    orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
  });
  await safeAnswerCallback(ctx);
  if (panels.length === 0) {
    await safeEditOrReply(
      ctx,
      "ابتدا از مدیریت پنل‌ها یک پنل اضافه کنید.",
      new InlineKeyboard().text("بازگشت", PROD_CB.MENU),
    );
    return;
  }
  ctx.session.currentFlow = "product:add";
  ctx.session.temp.productAdd = { kind: "SERVICE_PRODUCT", step: "panel" };
  await safeEditOrReply(
    ctx,
    "پنل این محصول را انتخاب کنید:",
    panelPickerKeyboard(panels, (panelSid) => pcb.flowPanel(panelSid), PROD_CB.CANCEL),
  );
});

productHandler.callbackQuery(PROD_CB.ADD_OTHER, async (ctx) => {
  clearProductFlows(ctx);
  ctx.session.currentFlow = "product:add";
  ctx.session.temp.productAdd = { kind: "OTHER_PRODUCT", step: "name" };
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, "نام محصول را وارد کنید.", cancelKeyboard());
});

function addState(ctx: BotContext, step: ProductAddState["step"]): ProductAddState | null {
  const state = ctx.session.temp.productAdd;
  if (ctx.session.currentFlow !== "product:add" || state === undefined || state.step !== step) {
    return null;
  }
  return state;
}

async function askCategoryStep(ctx: BotContext, state: ProductAddState): Promise<void> {
  state.step = "category";
  const categories = await activeCategories(state.kind);
  if (categories.length === 0) {
    state.step = "newcatName";
    await safeEditOrReply(
      ctx,
      "هیچ دسته‌بندی فعالی وجود ندارد. نام دسته‌بندی جدید را وارد کنید.",
      cancelKeyboard(),
    );
    return;
  }
  await safeEditOrReply(
    ctx,
    "دسته‌بندی محصول را انتخاب کنید:",
    categoryPickerKeyboard(categories, (catSid) => pcb.flowCategory(catSid), {
      newCategoryCb: pcb.flowNewCategory(),
      backCb: PROD_CB.CANCEL,
    }),
  );
}

productHandler.callbackQuery(/^admin:prod:f:pnl:(.+)$/, async (ctx) => {
  const state = addState(ctx, "panel");
  if (state === null) {
    await safeAnswerCallback(ctx, "این مرحله معتبر نیست.");
    return;
  }
  const panel = await getPanelByShortId(ctx.match[1]);
  if (panel === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }
  state.panelId = panel.id;
  state.panelType = panel.type;
  state.panelName = panel.name;
  state.step = "name";
  await safeAnswerCallback(ctx, panel.status !== PanelStatus.ACTIVE ? "توجه: این پنل فعال نیست." : undefined);
  await safeEditOrReply(
    ctx,
    "نام اشتراک را وارد کنید. بهتر است قیمت و زمان در نام قابل فهم باشد.",
    cancelKeyboard(),
  );
});

productHandler.callbackQuery(/^admin:prod:f:grp:(F|N|N2|ALL)$/, async (ctx) => {
  const state = addState(ctx, "groups");
  if (state === null) {
    await safeAnswerCallback(ctx, "این مرحله معتبر نیست.");
    return;
  }
  state.groups = groupsFromCode(ctx.match[1]);
  await safeAnswerCallback(ctx);
  if (state.kind === "SERVICE_PRODUCT") {
    state.step = "location";
    await safeEditOrReply(
      ctx,
      "موقعیت سرویس را انتخاب کنید:",
      locationKeyboard((l) => pcb.flowLocation(l), PROD_CB.CANCEL),
    );
  } else {
    await askCategoryStep(ctx, state);
  }
});

productHandler.callbackQuery(/^admin:prod:f:loc:(M|D|T|A)$/, async (ctx) => {
  const state = addState(ctx, "location");
  if (state === null) {
    await safeAnswerCallback(ctx, "این مرحله معتبر نیست.");
    return;
  }
  const code = ctx.match[1];
  if (code === "A") {
    state.allLocations = true;
    state.serviceLocation = null;
  } else {
    state.allLocations = false;
    state.serviceLocation = LOCATION_CODE[code];
  }
  await safeAnswerCallback(ctx);
  await askCategoryStep(ctx, state);
});

productHandler.callbackQuery(/^admin:prod:f:cat:(.+)$/, async (ctx) => {
  const state = addState(ctx, "category");
  if (state === null) {
    await safeAnswerCallback(ctx, "این مرحله معتبر نیست.");
    return;
  }
  const category = await getCategoryByShortId(ctx.match[1]);
  if (category === null) {
    await safeAnswerCallback(ctx, "مورد یافت نشد.");
    return;
  }
  state.categoryId = category.id;
  state.categoryName = category.name;
  await safeAnswerCallback(ctx);
  if (state.kind === "SERVICE_PRODUCT") {
    state.step = "volume";
    await safeEditOrReply(ctx, "حجم را به گیگ وارد کنید. برای نامحدود عدد 0 را بفرستید.", cancelKeyboard());
  } else {
    state.step = "duration";
    await safeEditOrReply(ctx, "مدت/اعتبار محصول را به روز وارد کنید. اگر ندارد 0 بفرستید.", cancelKeyboard());
  }
});

productHandler.callbackQuery("admin:prod:f:newcat", async (ctx) => {
  const state = addState(ctx, "category");
  if (state === null) {
    await safeAnswerCallback(ctx, "این مرحله معتبر نیست.");
    return;
  }
  state.step = "newcatName";
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, "نام دسته‌بندی جدید را وارد کنید.", cancelKeyboard());
});

productHandler.callbackQuery(/^admin:prod:f:trc:(NO_RESET|DAY|WEEK|MONTH|YEAR)$/, async (ctx) => {
  const state = addState(ctx, "resetCycle");
  if (state === null) {
    await safeAnswerCallback(ctx, "این مرحله معتبر نیست.");
    return;
  }
  state.trafficResetCycle = ctx.match[1] as TrafficResetCycle;
  state.step = "invoice";
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    "توضیحات محصول برای پیش‌فاکتور را وارد کنید. (برای خالی «-» بفرستید)",
    cancelKeyboard(),
  );
});

productHandler.callbackQuery(/^admin:prod:f:rui:(y|n)$/, async (ctx) => {
  const state = addState(ctx, "userInfo");
  if (state === null) {
    await safeAnswerCallback(ctx, "این مرحله معتبر نیست.");
    return;
  }
  await safeAnswerCallback(ctx);
  if (ctx.match[1] === "y") {
    state.requiredUserInfoEnabled = true;
    state.step = "userInfoPrompt";
    await safeEditOrReply(
      ctx,
      "متنی که بعد از پرداخت از کاربر پرسیده می‌شود را وارد کنید.",
      cancelKeyboard(),
    );
  } else {
    state.requiredUserInfoEnabled = false;
    state.requiredUserInfoPromptText = null;
    state.step = "delivery";
    await safeEditOrReply(
      ctx,
      "نوع تحویل را انتخاب کنید:",
      deliveryKeyboard((d) => pcb.flowDelivery(d), PROD_CB.CANCEL),
    );
  }
});

productHandler.callbackQuery(/^admin:prod:f:dlv:(M|S)$/, async (ctx) => {
  const state = addState(ctx, "delivery");
  if (state === null) {
    await safeAnswerCallback(ctx, "این مرحله معتبر نیست.");
    return;
  }
  state.deliveryType = ctx.match[1] === "M" ? "MANUAL_ADMIN" : "STOCK_ITEM";
  state.step = "order";
  await safeAnswerCallback(ctx, state.deliveryType === "STOCK_ITEM" ? STOCK_WARNING : undefined);
  await safeEditOrReply(
    ctx,
    "این محصول در جایگاه چندم نمایش داده شود؟ عدد بفرستید یا برای انتهای لیست 0 بفرستید.",
    cancelKeyboard(),
  );
});

productHandler.callbackQuery("admin:prod:f:save", async (ctx) => {
  const state = addState(ctx, "confirm");
  if (state === null) {
    await safeAnswerCallback(ctx, "این مرحله معتبر نیست.");
    return;
  }
  if (state.name === undefined || state.categoryId === undefined || state.priceToman === undefined) {
    clearProductFlows(ctx);
    await safeAnswerCallback(ctx, "اطلاعات ناقص است؛ دوباره شروع کنید.");
    await showProductMenu(ctx);
    return;
  }
  try {
    const product = await createProductAtOrder(
      {
        type: state.kind,
        categoryId: state.categoryId,
        panelId: state.kind === "SERVICE_PRODUCT" ? (state.panelId ?? null) : null,
        name: state.name,
        displayGroups: state.groups ?? ["F", "N", "N2"],
        serviceLocation: state.kind === "SERVICE_PRODUCT" ? (state.serviceLocation ?? null) : null,
        allLocations: state.kind === "SERVICE_PRODUCT" ? (state.allLocations ?? false) : false,
        volumeGb: state.kind === "SERVICE_PRODUCT" ? (state.volumeGb ?? 0) : null,
        durationDays: state.durationDays ?? 0,
        priceToman: state.priceToman,
        invoiceDescription: state.invoiceDescription ?? "",
        trafficResetCycle:
          state.kind === "SERVICE_PRODUCT" && state.panelType === "MARZBAN"
            ? (state.trafficResetCycle ?? null)
            : null,
        requiredUserInfoEnabled:
          state.kind === "OTHER_PRODUCT" ? (state.requiredUserInfoEnabled ?? false) : false,
        requiredUserInfoPromptText:
          state.kind === "OTHER_PRODUCT" ? (state.requiredUserInfoPromptText ?? null) : null,
        deliveryType: state.kind === "OTHER_PRODUCT" ? (state.deliveryType ?? null) : null,
        stockEnabled: false,
        isActive: true,
      },
      state.displayOrder ?? 0,
    );
    clearProductFlows(ctx);
    await safeAnswerCallback(ctx, "ذخیره شد ✅");
    await safeReply(ctx, "محصول با موفقیت ذخیره شد ✅");
    await safeReply(ctx, productDetailText(product), productDetailKeyboard(product), HTML);
  } catch (err) {
    logger.error("product creation failed", { error: errorMessage(err) });
    clearProductFlows(ctx);
    await safeAnswerCallback(ctx);
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.");
  }
});

// =====================================================================================
// Text input for category/product flows (wired behind admin auth in app.ts).
// =====================================================================================

export const productTextHandler = new Composer<BotContext>();

productTextHandler.on("message:text", async (ctx, next) => {
  const flow = ctx.session.currentFlow;
  if (flow === null || !(flow.startsWith("product:") || flow.startsWith("category:"))) {
    return next();
  }
  const text = ctx.message.text;
  // Commands cancel the flow and continue normally.
  if (text.startsWith("/")) {
    clearProductFlows(ctx);
    return next();
  }
  try {
    if (flow === "category:add") {
      await handleCategoryAddText(ctx, text);
    } else if (flow === "category:edit") {
      await handleCategoryEditText(ctx, text);
    } else if (flow === "product:add") {
      await handleProductAddText(ctx, text);
    } else if (flow === "product:edit") {
      await handleProductEditText(ctx, text);
    }
  } catch (err) {
    logger.error("product flow step failed", { flow, error: errorMessage(err) });
    clearProductFlows(ctx);
    await safeReply(ctx, "خطایی رخ داد. لطفاً دوباره تلاش کنید.");
  }
});

async function handleCategoryAddText(ctx: BotContext, text: string): Promise<void> {
  const state = ctx.session.temp.categoryAdd;
  if (state === undefined) {
    clearProductFlows(ctx);
    return;
  }
  if (state.step === "name") {
    const name = validName(text);
    if (name === null) {
      await safeReply(ctx, "نام باید بین ۱ تا ۱۲۰ کاراکتر باشد. دوباره وارد کنید.");
      return;
    }
    state.name = name;
    state.step = "order";
    await safeReply(
      ctx,
      "این دسته‌بندی در جایگاه چندم نمایش داده شود؟ عدد بفرستید یا برای انتهای لیست 0 بفرستید.",
      cancelKeyboard(),
    );
    return;
  }
  const order = parseNonNegativeInt(text);
  if (order === null) {
    await safeReply(ctx, "لطفاً فقط یک عدد صحیح (۰ یا بیشتر) وارد کنید.");
    return;
  }
  const category = await createCategoryAtOrder(state.type, state.name ?? "دسته‌بندی", order);
  clearProductFlows(ctx);
  await safeReply(ctx, "دسته‌بندی ذخیره شد ✅");
  await showCategoryDetail(ctx, category);
}

async function handleCategoryEditText(ctx: BotContext, text: string): Promise<void> {
  const categoryId = ctx.session.temp.editingCategoryId;
  const field = ctx.session.temp.editingCategoryField;
  if (categoryId === undefined || field === undefined) {
    clearProductFlows(ctx);
    return;
  }
  if (field === "name") {
    const name = validName(text);
    if (name === null) {
      await safeReply(ctx, "نام باید بین ۱ تا ۱۲۰ کاراکتر باشد. دوباره وارد کنید.");
      return;
    }
    const updated = await updateCategory(categoryId, { name });
    clearProductFlows(ctx);
    await safeReply(ctx, "نام بروزرسانی شد ✅");
    await showCategoryDetail(ctx, updated);
    return;
  }
  const order = parseNonNegativeInt(text);
  if (order === null) {
    await safeReply(ctx, "لطفاً فقط یک عدد صحیح (۰ یا بیشتر) وارد کنید.");
    return;
  }
  await setCategoryDisplayOrder(categoryId, order);
  const updated = await prisma.productCategory.findUnique({ where: { id: categoryId } });
  clearProductFlows(ctx);
  await safeReply(ctx, "جایگاه بروزرسانی شد ✅");
  if (updated !== null) {
    await showCategoryDetail(ctx, updated);
  }
}

async function handleProductAddText(ctx: BotContext, text: string): Promise<void> {
  const state = ctx.session.temp.productAdd;
  if (state === undefined) {
    clearProductFlows(ctx);
    return;
  }
  const value = text.trim();

  switch (state.step) {
    case "name": {
      const name = validName(value);
      if (name === null) {
        await safeReply(ctx, "نام باید بین ۱ تا ۱۲۰ کاراکتر باشد. دوباره وارد کنید.");
        return;
      }
      state.name = name;
      state.step = "groups";
      await safeReply(
        ctx,
        "گروه نمایش محصول را انتخاب کنید:",
        groupsKeyboard((g) => pcb.flowGroups(g), PROD_CB.CANCEL),
      );
      return;
    }
    case "newcatName": {
      const name = validName(value);
      if (name === null) {
        await safeReply(ctx, "نام باید بین ۱ تا ۱۲۰ کاراکتر باشد. دوباره وارد کنید.");
        return;
      }
      const category = await createCategoryAtOrder(state.kind, name, 0);
      state.categoryId = category.id;
      state.categoryName = category.name;
      if (state.kind === "SERVICE_PRODUCT") {
        state.step = "volume";
        await safeReply(ctx, "حجم را به گیگ وارد کنید. برای نامحدود عدد 0 را بفرستید.", cancelKeyboard());
      } else {
        state.step = "duration";
        await safeReply(ctx, "مدت/اعتبار محصول را به روز وارد کنید. اگر ندارد 0 بفرستید.", cancelKeyboard());
      }
      return;
    }
    case "volume": {
      const volume = parseNonNegativeInt(value);
      if (volume === null) {
        await safeReply(ctx, "لطفاً فقط یک عدد صحیح (۰ یا بیشتر) وارد کنید.");
        return;
      }
      state.volumeGb = volume;
      state.step = "duration";
      await safeReply(ctx, "مدت زمان را به روز وارد کنید. برای نامحدود عدد 0 را بفرستید.", cancelKeyboard());
      return;
    }
    case "duration": {
      const duration = parseNonNegativeInt(value);
      if (duration === null) {
        await safeReply(ctx, "لطفاً فقط یک عدد صحیح (۰ یا بیشتر) وارد کنید.");
        return;
      }
      state.durationDays = duration;
      state.step = "price";
      await safeReply(ctx, "قیمت را به تومان وارد کنید.", cancelKeyboard());
      return;
    }
    case "price": {
      const price = parseNonNegativeInt(value);
      if (price === null) {
        await safeReply(ctx, "لطفاً فقط یک عدد صحیح (۰ یا بیشتر) وارد کنید.");
        return;
      }
      state.priceToman = price;
      if (state.kind === "SERVICE_PRODUCT" && state.panelType === "MARZBAN") {
        state.step = "resetCycle";
        await safeReply(
          ctx,
          "دوره ریست ترافیک را انتخاب کنید:",
          resetCycleKeyboard((c) => pcb.flowResetCycle(c), PROD_CB.CANCEL),
        );
      } else {
        state.trafficResetCycle = null;
        state.step = "invoice";
        await safeReply(
          ctx,
          "توضیحات محصول برای پیش‌فاکتور را وارد کنید. (برای خالی «-» بفرستید)",
          cancelKeyboard(),
        );
      }
      return;
    }
    case "invoice": {
      const description = value === "-" ? "" : value;
      if (description.length > 1000) {
        await safeReply(ctx, "توضیحات حداکثر ۱۰۰۰ کاراکتر است. دوباره وارد کنید.");
        return;
      }
      state.invoiceDescription = description;
      if (state.kind === "OTHER_PRODUCT") {
        state.step = "userInfo";
        const kb = new InlineKeyboard()
          .text("اطلاعات از کاربر لازم است ✅", pcb.flowUserInfo("y"))
          .row()
          .text("اطلاعات لازم نیست ❌", pcb.flowUserInfo("n"))
          .row()
          .text("لغو ❌", PROD_CB.CANCEL);
        await safeReply(ctx, "آیا بعد از خرید باید اطلاعاتی از کاربر گرفته شود؟", kb);
      } else {
        state.step = "order";
        await safeReply(
          ctx,
          "این محصول در جایگاه چندم نمایش داده شود؟ عدد بفرستید یا برای انتهای لیست 0 بفرستید.",
          cancelKeyboard(),
        );
      }
      return;
    }
    case "userInfoPrompt": {
      if (value.length === 0 || value.length > 1000) {
        await safeReply(ctx, "متن باید بین ۱ تا ۱۰۰۰ کاراکتر باشد. دوباره وارد کنید.");
        return;
      }
      state.requiredUserInfoPromptText = value;
      state.step = "delivery";
      await safeReply(
        ctx,
        "نوع تحویل را انتخاب کنید:",
        deliveryKeyboard((d) => pcb.flowDelivery(d), PROD_CB.CANCEL),
      );
      return;
    }
    case "order": {
      const order = parseNonNegativeInt(value);
      if (order === null) {
        await safeReply(ctx, "لطفاً فقط یک عدد صحیح (۰ یا بیشتر) وارد کنید.");
        return;
      }
      state.displayOrder = order;
      state.step = "confirm";
      await safeReply(ctx, addConfirmationText(state), addConfirmationKeyboard(), HTML);
      return;
    }
    default:
      await safeReply(ctx, "در این مرحله ورودی متنی لازم نیست؛ از دکمه‌ها استفاده کنید.");
  }
}

async function handleProductEditText(ctx: BotContext, text: string): Promise<void> {
  const productId = ctx.session.temp.editingProductId;
  const fieldKey = ctx.session.temp.editingProductField;
  if (productId === undefined || fieldKey === undefined) {
    clearProductFlows(ctx);
    return;
  }
  const value = text.trim();

  if (fieldKey === "nm") {
    const name = validName(value);
    if (name === null) {
      await safeReply(ctx, "نام باید بین ۱ تا ۱۲۰ کاراکتر باشد. دوباره وارد کنید.");
      return;
    }
    await finishProductEdit(ctx, productId, { name });
    return;
  }
  if (fieldKey === "inv") {
    const description = value === "-" ? "" : value;
    if (description.length > 1000) {
      await safeReply(ctx, "توضیحات حداکثر ۱۰۰۰ کاراکتر است. دوباره وارد کنید.");
      return;
    }
    await finishProductEdit(ctx, productId, { invoiceDescription: description });
    return;
  }
  if (fieldKey === "ruip") {
    if (value.length === 0 || value.length > 1000) {
      await safeReply(ctx, "متن باید بین ۱ تا ۱۰۰۰ کاراکتر باشد. دوباره وارد کنید.");
      return;
    }
    await finishProductEdit(ctx, productId, { requiredUserInfoPromptText: value });
    return;
  }

  const num = parseNonNegativeInt(value);
  if (num === null) {
    await safeReply(ctx, "لطفاً فقط یک عدد صحیح (۰ یا بیشتر) وارد کنید.");
    return;
  }
  if (fieldKey === "pr") {
    await finishProductEdit(ctx, productId, { priceToman: num });
  } else if (fieldKey === "dur") {
    await finishProductEdit(ctx, productId, { durationDays: num });
  } else if (fieldKey === "vol") {
    await finishProductEdit(ctx, productId, { volumeGb: num });
  } else if (fieldKey === "ord") {
    await setProductDisplayOrder(productId, num);
    const updated = await prisma.product.findUnique({
      where: { id: productId },
      include: { category: true, panel: true },
    });
    clearProductFlows(ctx);
    await safeReply(ctx, "جایگاه بروزرسانی شد ✅");
    if (updated !== null) {
      await safeReply(ctx, productDetailText(updated), productDetailKeyboard(updated), HTML);
    }
  } else {
    clearProductFlows(ctx);
  }
}

async function finishProductEdit(
  ctx: BotContext,
  productId: string,
  data: Parameters<typeof updateProduct>[1],
): Promise<void> {
  const updated = await updateProduct(productId, data);
  clearProductFlows(ctx);
  await safeReply(ctx, "بروزرسانی شد ✅");
  await safeReply(ctx, productDetailText(updated), productDetailKeyboard(updated), HTML);
}
