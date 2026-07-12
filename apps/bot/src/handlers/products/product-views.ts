import type { Panel, ProductCategory, TrafficResetCycle } from "@zedbot/database";
import { InlineKeyboard } from "grammy";

import type { ProductAddState } from "../../core/session.js";
import { categoryShortId } from "../../services/category.service.js";
import { panelShortId } from "../../services/panel.service.js";
import { productShortId, type ProductWithRelations } from "../../services/product.service.js";
import { escapeHtml } from "../../utils/html.js";
import { pcb, PROD_CB } from "./product-cb.js";

const PANEL_STATUS_EMOJI: Record<string, string> = {
  ACTIVE: "🟢",
  INACTIVE: "⚪️",
  MAINTENANCE: "🟡",
  FAILED: "🔴",
};

export const LOCATION_LABEL: Record<string, string> = {
  MULTI_LOCATION: "مولتی لوکیشن 🚀",
  DEDICATED_LOCATION: "تک لوکیشن اختصاصی 🚀",
  TEST: "تست",
};

export const RESET_CYCLE_LABEL: Record<TrafficResetCycle, string> = {
  NO_RESET: "بدون ریست",
  DAY: "روزانه",
  WEEK: "هفتگی",
  MONTH: "ماهانه",
  YEAR: "سالانه",
};

export const DELIVERY_LABEL: Record<string, string> = {
  MANUAL_ADMIN: "تحویل دستی ادمین",
  STOCK_ITEM: "آیتم آماده/استوک",
};

export function groupsLabel(displayGroups: unknown): string {
  if (Array.isArray(displayGroups) && displayGroups.length > 0 && displayGroups.length < 3) {
    return displayGroups.join(", ");
  }
  return "همه گروه‌ها";
}

function activeEmoji(isActive: boolean): string {
  return isActive ? "🟢" : "⚪️";
}

// --- Root menu -----------------------------------------------------------------

export function productMenuText(): string {
  return "مدیریت محصولات و پلن‌ها 🛍\n\nیک گزینه را انتخاب کنید:";
}

/** Fix C root layout. Every destination is an existing flow. */
export function productMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("لیست محصولات 🧾", pcb.list("A", 1))
    .text("افزودن محصول ➕", PROD_CB.ADD)
    .row()
    .text("دسته‌بندی‌ها 🗂", PROD_CB.CAT_MENU)
    .text("افزودن دسته‌بندی ➕", PROD_CB.CAT_ADD)
    .row()
    .text("محصولات اشتراک VPN 🔐", pcb.list("S", 1))
    .text("محصولات دیگر 🛍", pcb.list("O", 1))
    .row()
    .text("بازگشت به پنل ادمین", "admin:menu");
}

/** «افزودن محصول ➕» type chooser (wizard step 1). */
export function productAddTypeKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("محصول اشتراک VPN 🔐", PROD_CB.ADD_SERVICE)
    .row()
    .text("محصول دیگر 🛍", PROD_CB.ADD_OTHER)
    .row()
    .text("بازگشت", PROD_CB.MENU);
}

// --- Categories ------------------------------------------------------------------

export function categoryMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("دسته‌بندی سرویس‌ها", pcb.catList("S", 1))
    .row()
    .text("دسته‌بندی محصولات دیگر", pcb.catList("O", 1))
    .row()
    .text("افزودن دسته‌بندی ➕", PROD_CB.CAT_ADD)
    .row()
    .text("بازگشت", PROD_CB.MENU);
}

export function categoryListKeyboard(
  categories: ProductCategory[],
  type: "S" | "O",
  page: number,
  pages: number,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const category of categories) {
    kb.text(`${activeEmoji(category.isActive)} ${category.name}`, pcb.catView(categoryShortId(category))).row();
  }
  if (pages > 1) {
    if (page > 1) {
      kb.text("« قبلی", pcb.catList(type, page - 1));
    }
    kb.text(`${page}/${pages}`, PROD_CB.NOOP);
    if (page < pages) {
      kb.text("بعدی »", pcb.catList(type, page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت", PROD_CB.CAT_MENU);
  return kb;
}

export function categoryDetailText(category: ProductCategory, productCount: number): string {
  return [
    `📂 <b>${escapeHtml(category.name)}</b>`,
    "",
    `نوع: ${category.type === "SERVICE_PRODUCT" ? "سرویس VPN" : "محصولات دیگر"}`,
    `جایگاه نمایش: ${category.displayOrder}`,
    `وضعیت: ${category.isActive ? "فعال 🟢" : "غیرفعال ⚪️"}`,
    `تعداد محصولات: ${productCount}`,
    `ایجاد: ${category.createdAt.toISOString().slice(0, 10)}`,
    `بروزرسانی: ${category.updatedAt.toISOString().slice(0, 10)}`,
  ].join("\n");
}

export function categoryDetailKeyboard(category: ProductCategory): InlineKeyboard {
  const sid = categoryShortId(category);
  return new InlineKeyboard()
    .text("ویرایش نام", pcb.catEditName(sid))
    .text("تغییر جایگاه", pcb.catEditOrder(sid))
    .row()
    .text(category.isActive ? "غیرفعال کردن ⚪️" : "فعال کردن 🟢", pcb.catToggle(sid))
    .text("حذف دسته‌بندی 🗑", pcb.catDeleteAsk(sid))
    .row()
    .text("بازگشت", pcb.catList(category.type === "SERVICE_PRODUCT" ? "S" : "O", 1));
}

// --- Product list ------------------------------------------------------------------

export function productListMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("سرویس‌ها", pcb.list("S", 1))
    .text("محصولات دیگر", pcb.list("O", 1))
    .row()
    .text("همه", pcb.list("A", 1))
    .row()
    // Fix C: status filters over the same list.
    .text("فعال‌ها ✅", pcb.list("V", 1))
    .text("غیرفعال‌ها ⏸", pcb.list("X", 1))
    .row()
    .text("بازگشت", PROD_CB.MENU);
}

export type ProductListFilterKey = "S" | "O" | "A" | "V" | "X";

function productTypeSuffix(product: ProductWithRelations, filter: ProductListFilterKey): string {
  return filter === "S" || filter === "O"
    ? ""
    : product.type === "SERVICE_PRODUCT"
      ? " | سرویس"
      : " | دیگر";
}

export function productListKeyboard(
  products: ProductWithRelations[],
  filter: ProductListFilterKey,
  page: number,
  pages: number,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const product of products) {
    const category =
      product.category.name.length > 14
        ? `${product.category.name.slice(0, 14)}…`
        : product.category.name;
    kb.text(
      `${activeEmoji(product.isActive)} ${product.name} | ${product.priceToman} تومان | ${category}${productTypeSuffix(product, filter)}`,
      pcb.view(productShortId(product)),
    ).row();
  }
  if (pages > 1) {
    if (page > 1) {
      kb.text("« قبلی", pcb.list(filter, page - 1));
    }
    kb.text(`${page}/${pages}`, PROD_CB.NOOP);
    if (page < pages) {
      kb.text("بعدی »", pcb.list(filter, page + 1));
    }
    kb.row();
  }
  kb.text("افزودن محصول ➕", PROD_CB.ADD).text("دسته‌بندی‌ها 🗂", PROD_CB.CAT_MENU).row();
  kb.text("بازگشت به مدیریت محصولات", PROD_CB.MENU);
  return kb;
}

// --- Product detail ------------------------------------------------------------------

export function productDetailText(product: ProductWithRelations): string {
  const lines = [
    `🛍 <b>${escapeHtml(product.name)}</b>`,
    "",
    `نوع: ${product.type === "SERVICE_PRODUCT" ? "سرویس VPN" : "محصول دیگر"}`,
    `وضعیت: ${product.isActive ? "فعال 🟢" : "غیرفعال ⚪️"}`,
    `دسته‌بندی: ${escapeHtml(product.category.name)}`,
    `گروه‌های نمایش: ${escapeHtml(groupsLabel(product.displayGroups))}`,
    `قیمت: ${product.priceToman} تومان`,
    `مدت: ${product.durationDays === 0 ? "نامحدود" : `${product.durationDays ?? "-"} روز`}`,
    `توضیحات پیش‌فاکتور: ${escapeHtml(product.invoiceDescription === null || product.invoiceDescription === "" ? "-" : product.invoiceDescription)}`,
    `جایگاه نمایش: ${product.displayOrder}`,
  ];

  if (product.type === "SERVICE_PRODUCT") {
    lines.push(
      `پنل: ${product.panel === null ? "-" : `${escapeHtml(product.panel.name)} (${product.panel.type})`}`,
      `موقعیت: ${product.allLocations ? "همه موقعیت‌ها" : (LOCATION_LABEL[product.serviceLocation ?? ""] ?? "-")}`,
      `حجم: ${product.volumeGb === 0 ? "نامحدود" : `${product.volumeGb ?? "-"} گیگ`}`,
    );
    if (product.panel?.type === "MARZBAN") {
      lines.push(
        `ریست ترافیک: ${product.trafficResetCycle === null ? "-" : RESET_CYCLE_LABEL[product.trafficResetCycle]}`,
      );
    }
  } else {
    lines.push(
      `اطلاعات از کاربر: ${product.requiredUserInfoEnabled ? "✅" : "❌"}`,
      `متن درخواست اطلاعات: ${escapeHtml(product.requiredUserInfoPromptText ?? "-")}`,
      `نوع تحویل: ${product.deliveryType === null ? "-" : DELIVERY_LABEL[product.deliveryType]}`,
      `استوک: ${product.stockEnabled ? "✅" : "❌"}`,
    );
  }

  lines.push(
    `ایجاد: ${product.createdAt.toISOString().slice(0, 10)}`,
    `بروزرسانی: ${product.updatedAt.toISOString().slice(0, 10)}`,
  );
  return lines.join("\n");
}

/**
 * Fix C: `backList` returns to the SAME filter/page the admin came from
 * (session context); OTHER_PRODUCT links straight to its Fix B stock page.
 * «حذف محصول 🗑» stays a soft-deactivate (no hard delete exists).
 */
export function productDetailKeyboard(
  product: ProductWithRelations,
  backList?: { filter: ProductListFilterKey; page: number },
): InlineKeyboard {
  const sid = productShortId(product);
  const kb = new InlineKeyboard()
    .text("ویرایش نام", pcb.fieldEdit(sid, "nm"))
    .text("ویرایش قیمت", pcb.fieldEdit(sid, "pr"))
    .row()
    .text("ویرایش توضیحات پیش‌فاکتور", pcb.fieldEdit(sid, "inv"))
    .row()
    .text("ویرایش مدت", pcb.fieldEdit(sid, "dur"))
    .text("تغییر جایگاه", pcb.fieldEdit(sid, "ord"))
    .row()
    .text("تغییر دسته‌بندی", pcb.pickCategory(sid))
    .text("تغییر گروه نمایش", pcb.pickGroups(sid))
    .row();

  if (product.type === "SERVICE_PRODUCT") {
    kb.text("ویرایش حجم", pcb.fieldEdit(sid, "vol"))
      .text("تغییر پنل", pcb.pickPanel(sid))
      .row()
      .text("تغییر موقعیت", pcb.pickLocation(sid));
    if (product.panel?.type === "MARZBAN") {
      kb.text("ریست ترافیک", pcb.pickResetCycle(sid));
    }
    kb.row();
  } else {
    kb.text(
      product.requiredUserInfoEnabled ? "اطلاعات کاربر: ✅" : "اطلاعات کاربر: ❌",
      pcb.toggleUserInfo(sid),
    )
      .text("متن درخواست اطلاعات", pcb.fieldEdit(sid, "ruip"))
      .row()
      .text("نوع تحویل", pcb.pickDelivery(sid))
      // Existing Fix B stock page - resolved by the same product short id.
      .text("مدیریت موجودی استاک 🎟", `admin:stock:p:${sid}`)
      .row();
  }

  kb.text(product.isActive ? "غیرفعال کردن ⚪️" : "فعال کردن 🟢", pcb.toggle(sid))
    .text("حذف محصول 🗑", pcb.deleteAsk(sid))
    .row()
    .text(
      "بازگشت به لیست محصولات",
      pcb.list(
        backList?.filter ?? (product.type === "SERVICE_PRODUCT" ? "S" : "O"),
        backList?.page ?? 1,
      ),
    )
    .row()
    .text("بازگشت به مدیریت محصولات", PROD_CB.MENU);
  return kb;
}

// --- Pickers ------------------------------------------------------------------

export function groupsKeyboard(build: (g: string) => string, backCb: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("F", build("F"))
    .text("N", build("N"))
    .text("N2", build("N2"))
    .row()
    .text("همه گروه‌ها", build("ALL"))
    .row()
    .text("لغو ❌", backCb);
}

export function locationKeyboard(build: (l: string) => string, backCb: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("مولتی لوکیشن 🚀", build("M"))
    .row()
    .text("تک لوکیشن اختصاصی 🚀", build("D"))
    .row()
    .text("تست", build("T"))
    .row()
    .text("همه موقعیت‌ها", build("A"))
    .row()
    .text("لغو ❌", backCb);
}

export function resetCycleKeyboard(build: (c: string) => string, backCb: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("بدون ریست", build("NO_RESET"))
    .row()
    .text("روزانه", build("DAY"))
    .text("هفتگی", build("WEEK"))
    .row()
    .text("ماهانه", build("MONTH"))
    .text("سالانه", build("YEAR"))
    .row()
    .text("لغو ❌", backCb);
}

export function deliveryKeyboard(build: (d: string) => string, backCb: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("تحویل دستی ادمین", build("M"))
    .row()
    .text("آیتم آماده/استوک", build("S"))
    .row()
    .text("لغو ❌", backCb);
}

// Deliberately offers NO "create new category" shortcut: categories are
// created only through the category-management section.
export function categoryPickerKeyboard(
  categories: ProductCategory[],
  build: (catSid: string) => string,
  options: { backCb: string },
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const category of categories) {
    kb.text(category.name, build(categoryShortId(category))).row();
  }
  kb.text("لغو ❌", options.backCb);
  return kb;
}

export function panelPickerKeyboard(
  panels: Panel[],
  build: (panelSid: string) => string,
  backCb: string,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const panel of panels) {
    kb.text(
      `${PANEL_STATUS_EMOJI[panel.status] ?? ""} ${panel.name} | ${panel.type}`,
      build(panelShortId(panel)),
    ).row();
  }
  kb.text("لغو ❌", backCb);
  return kb;
}

// --- Add-wizard confirmation ----------------------------------------------------

export function addConfirmationText(state: ProductAddState): string {
  const lines = ["<b>تایید اطلاعات محصول</b>", ""];
  if (state.kind === "SERVICE_PRODUCT") {
    lines.push(`پنل: ${escapeHtml(state.panelName ?? "-")} (${state.panelType ?? "-"})`);
  }
  lines.push(
    `نام: ${escapeHtml(state.name ?? "-")}`,
    `گروه‌های نمایش: ${escapeHtml(groupsLabel(state.groups))}`,
  );
  if (state.kind === "SERVICE_PRODUCT") {
    lines.push(
      `موقعیت: ${state.allLocations === true ? "همه موقعیت‌ها" : (LOCATION_LABEL[state.serviceLocation ?? ""] ?? "-")}`,
      `حجم: ${state.volumeGb === 0 ? "نامحدود" : `${state.volumeGb ?? "-"} گیگ`}`,
    );
  }
  lines.push(
    `دسته‌بندی: ${escapeHtml(state.categoryName ?? "-")}`,
    `مدت: ${state.durationDays === 0 ? "نامحدود" : `${state.durationDays ?? "-"} روز`}`,
    `قیمت: ${state.priceToman ?? "-"} تومان`,
  );
  if (state.kind === "SERVICE_PRODUCT" && state.panelType === "MARZBAN") {
    lines.push(
      `ریست ترافیک: ${state.trafficResetCycle == null ? "-" : RESET_CYCLE_LABEL[state.trafficResetCycle]}`,
    );
  }
  if (state.kind === "OTHER_PRODUCT") {
    lines.push(
      `اطلاعات از کاربر: ${state.requiredUserInfoEnabled === true ? "✅" : "❌"}`,
      `متن درخواست اطلاعات: ${escapeHtml(state.requiredUserInfoPromptText ?? "-")}`,
      `نوع تحویل: ${state.deliveryType === undefined ? "-" : DELIVERY_LABEL[state.deliveryType]}`,
    );
  }
  lines.push(
    `توضیحات پیش‌فاکتور: ${escapeHtml(state.invoiceDescription === "" ? "-" : (state.invoiceDescription ?? "-"))}`,
    `جایگاه نمایش: ${state.displayOrder === 0 ? "انتهای لیست" : (state.displayOrder ?? "-")}`,
  );
  return lines.join("\n");
}

export function addConfirmationKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("ذخیره ✅", pcb.flowSave()).text("لغو ❌", PROD_CB.CANCEL);
}
