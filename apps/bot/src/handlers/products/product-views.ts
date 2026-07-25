import type {
  OtherProductFulfillmentProfile,
  OtherProductKind,
  OtherProductStockParser,
  Panel,
  ProductCategory,
  TrafficResetCycle,
} from "@zedbot/database";
import { InlineKeyboard } from "grammy";

import type { ProductAddState } from "../../core/session.js";
import { categoryShortId } from "../../services/category.service.js";
import { OTHER_POLICY_INFO } from "../../services/other-product-naming.service.js";
import { kindLabel, profileLabel } from "../../services/other-product-profile.service.js";
import { panelShortId } from "../../services/panel.service.js";
import { productShortId, type ProductWithRelations } from "../../services/product.service.js";
import { escapeHtml } from "../../utils/html.js";
import { resolveProductInboundIds } from "../../services/panel-readiness.service.js";
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

// Specialized-workflows phase: kind/profile labels come from the shared
// other-product profile service (kindLabel/profileLabel). The parser labels
// live here - they double as the wizard/selector button captions.
export const STOCK_PARSER_LABEL: Record<OtherProductStockParser, string> = {
  SINGLE_LINE: "هر خط یک آیتم",
  EXPLICIT_SEPARATOR: "بلوک‌های جداشده با ---",
  EMAIL_BOUNDARY: "بلوک‌های ایمیل‌محور",
};

/** Stock-backed fulfillment profiles (drive stockEnabled + the parser UI). */
export function isStockProfile(
  profile: OtherProductFulfillmentProfile | null | undefined,
): boolean {
  return profile === "STOCK_CREDENTIAL" || profile === "STOCK_CODE";
}

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

/** Shown on a personalized Apple ID product (edit screen + mode picker). */
export const APPLE_PERSONALIZED_NOTE =
  "این محصول پس از پرداخت وارد صف تحویل دستی می‌شود و به موجودی نیاز ندارد.";

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
      // Representative-program opt-in state (§8). Shown to every admin (read-only
      // for non-OWNER); only the OWNER sees the toggle button (see keyboard).
      `فروش در بخش نمایندگی: ${product.representativeEligible ? "فعال ✅" : "غیرفعال ❌"}`,
    );
    if (product.panel?.type === "MARZBAN") {
      lines.push(
        `ریست ترافیک: ${product.trafficResetCycle === null ? "-" : RESET_CYCLE_LABEL[product.trafficResetCycle]}`,
      );
    }
    if (product.panel?.type === "XUI") {
      const resolution = resolveProductInboundIds(product.panel, product.inboundIds);
      lines.push(
        `اینباندها: ${
          !resolution.ok
            ? `نامعتبر ❌ (${resolution.reason === "panel-allowlist-empty" ? "پنل اینباند مجاز ندارد" : `خارج از لیست مجاز: ${(resolution.invalidIds ?? []).join(", ")}`})`
            : resolution.inherited
              ? `همه اینباندهای مجاز پنل (${resolution.inboundIds.join(", ")})`
              : resolution.inboundIds.join(", ")
        }`,
      );
    }
  } else {
    lines.push(
      // Missing kind = legacy row backfilled to GENERIC (behavior unchanged).
      `نوع محصول: ${kindLabel(product.otherProductKind ?? "GENERIC")}`,
      `پروفایل تحویل: ${product.otherProductFulfillmentProfile == null ? "-" : profileLabel(product.otherProductFulfillmentProfile)}`,
      `فرمت موجودی: ${product.otherProductStockParser == null ? "-" : STOCK_PARSER_LABEL[product.otherProductStockParser]}`,
      `دریافت اطلاعات قبل از تایید رسید: ${product.collectInfoBeforeManualApproval === true ? "فعال" : "غیرفعال"}`,
      `پیام تکمیل سفارش: ${escapeHtml(product.completionMessageTemplate == null || product.completionMessageTemplate === "" ? "-" : product.completionMessageTemplate)}`,
      `اطلاعات از کاربر: ${product.requiredUserInfoEnabled ? "✅" : "❌"}`,
      `متن درخواست اطلاعات: ${escapeHtml(product.requiredUserInfoPromptText ?? "-")}`,
      `نوع تحویل: ${product.deliveryType === null ? "-" : DELIVERY_LABEL[product.deliveryType]}`,
      `استوک: ${product.stockEnabled ? "✅" : "❌"}`,
      // Missing policy = the default ORDER_SHORT_ID (naming phase).
      `روش نام‌گذاری محصول دیگر: ${OTHER_POLICY_INFO[product.otherNamingPolicy ?? "ORDER_SHORT_ID"].fa}`,
    );
    if (product.otherNamingPolicy === "CUSTOM_TEMPLATE") {
      lines.push(`قالب نام‌گذاری: ${escapeHtml(product.otherNamingTemplate ?? "-")}`);
    }
    if (
      product.otherProductKind === "APPLE_ID" &&
      product.otherProductFulfillmentProfile === "PERSONALIZED_SERVICE"
    ) {
      lines.push("", APPLE_PERSONALIZED_NOTE);
    }
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
  isOwner = false,
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
    if (product.panel?.type === "XUI") {
      kb.text("انتخاب اینباند XUI", pcb.fieldEdit(sid, "inb"));
    }
    kb.row();
    // Representative-eligibility opt-in — OWNER-only, SERVICE_PRODUCT-only (§8).
    // Regular admins see the state line in the text but never this button; the
    // callback re-validates the OWNER server-side regardless.
    if (isOwner) {
      kb.text(
        product.representativeEligible
          ? "غیرفعال‌کردن فروش نمایندگی 🤝"
          : "فعال‌کردن فروش نمایندگی 🤝",
        pcb.repEligibleAsk(sid),
      ).row();
    }
  } else {
    // Specialized-workflows phase: kind selector + per-profile controls.
    // Apple ID exposes an explicit fulfillment-mode toggle (تحویل آماده vs
    // ساخت شخصی); the personalized mode hides all stock controls and shows the
    // customer-information settings, the stock mode does the reverse. Other
    // OTHER_PRODUCT kinds keep their existing control set exactly.
    const isApple = product.otherProductKind === "APPLE_ID";
    const personalized = product.otherProductFulfillmentProfile === "PERSONALIZED_SERVICE";
    kb.text("نوع محصول", pcb.pickKind(sid));
    if (isApple) {
      kb.text(
        personalized ? "روش تحویل: ساخت شخصی 👤" : "روش تحویل: تحویل آماده 📦",
        pcb.pickAppleMode(sid),
      );
    }
    if (isStockProfile(product.otherProductFulfillmentProfile)) {
      kb.text("فرمت موجودی", pcb.pickStockParser(sid));
    }
    kb.row();
    if (personalized || product.requiredUserInfoEnabled) {
      kb.text(
        product.collectInfoBeforeManualApproval === true
          ? "دریافت اطلاعات قبل از تایید رسید: فعال ✅"
          : "دریافت اطلاعات قبل از تایید رسید: غیرفعال ❌",
        pcb.toggleCollectBefore(sid),
      ).row();
    }
    kb.text("پیام تکمیل سفارش", pcb.fieldEdit(sid, "cmt")).row();
    // Legacy free-text customer-info settings (toggle + prompt): hidden for a
    // ready-from-stock Apple product (تحویل آماده collects no info) AND for any
    // PERSONALIZED_SERVICE product. A personalized profile ALWAYS requires the
    // structured form (resolveEffectiveProfile forces requiresCustomerInfo=true),
    // so the legacy toggle would falsely report info as disabled and the
    // free-text prompt has no effect on the structured fields buyers receive.
    // Shown only for the legacy free-text kinds (e.g. GENERIC manual delivery).
    if (!personalized && !(isApple && !personalized)) {
      kb.text(
        product.requiredUserInfoEnabled ? "اطلاعات کاربر: ✅" : "اطلاعات کاربر: ❌",
        pcb.toggleUserInfo(sid),
      )
        .text("متن درخواست اطلاعات", pcb.fieldEdit(sid, "ruip"))
        .row();
    }
    kb.text("نوع تحویل", pcb.pickDelivery(sid))
      .text("روش نام‌گذاری محصول دیگر", pcb.pickNaming(sid))
      .row();
    // Stock management: hidden for a personalized Apple product (no inventory).
    if (!(isApple && personalized)) {
      // Existing Fix B stock page - resolved by the same product short id.
      kb.text("مدیریت موجودی استاک 🎟", `admin:stock:p:${sid}`).row();
    }
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

/**
 * OWNER confirmation page for flipping `representativeEligible`. The confirm
 * button carries the EXPECTED current state ("1"/"0") so a stale/duplicate tap
 * converges atomically instead of double-flipping. The «انصراف» button returns
 * to the exact product detail page. Shows the safe warning that eligibility
 * alone does not make a product sellable.
 */
export function representativeEligibilityConfirmView(product: ProductWithRelations): {
  text: string;
  keyboard: InlineKeyboard;
} {
  const sid = productShortId(product);
  const enabling = !product.representativeEligible;
  const expected: "0" | "1" = product.representativeEligible ? "1" : "0";
  const text = [
    "🤝 <b>فروش نمایندگی</b>",
    "",
    `محصول: <b>${escapeHtml(product.name)}</b>`,
    `وضعیت فعلی: ${product.representativeEligible ? "فعال ✅" : "غیرفعال ❌"}`,
    "",
    enabling
      ? "می‌خواهید فروش نمایندگی این محصول را «فعال» کنید؟"
      : "می‌خواهید فروش نمایندگی این محصول را «غیرفعال» کنید؟",
    "",
    "⚠️ فعال‌بودن فروش نمایندگی به‌تنهایی کافی نیست؛ محصول باید فعال، قابل‌نمایش، دارای پنل آماده و دارای قیمت فعال در سطح نمایندگی باشد.",
  ].join("\n");
  const keyboard = new InlineKeyboard()
    .text(
      enabling ? "بله، فعال کن ✅" : "بله، غیرفعال کن ❌",
      pcb.repEligibleConfirm(sid, expected),
    )
    .row()
    .text("انصراف", pcb.view(sid));
  return { text, keyboard };
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

// Specialized-workflows phase: compact callback codes for the kind/parser
// pickers (shared between the add wizard and the detail-page selectors).
export const OTHER_KIND_BY_CODE: Record<string, OtherProductKind> = {
  APPLE: "APPLE_ID",
  AI: "AI_ACCOUNT",
  TGP: "TELEGRAM_PREMIUM",
  GIFT: "GIFT_CARD",
  GEN: "GENERIC",
};

export const STOCK_PARSER_BY_CODE: Record<string, OtherProductStockParser> = {
  SL: "SINGLE_LINE",
  SEP: "EXPLICIT_SEPARATOR",
  EB: "EMAIL_BOUNDARY",
};

/** One kind per row, wizard order; `back` covers cancel (wizard) or return (edit). */
export function otherKindKeyboard(
  build: (code: string) => string,
  back: { label: string; cb: string },
): InlineKeyboard {
  return new InlineKeyboard()
    .text(kindLabel("APPLE_ID"), build("APPLE"))
    .row()
    .text(kindLabel("AI_ACCOUNT"), build("AI"))
    .row()
    .text(kindLabel("TELEGRAM_PREMIUM"), build("TGP"))
    .row()
    .text(kindLabel("GIFT_CARD"), build("GIFT"))
    .row()
    .text(kindLabel("GENERIC"), build("GEN"))
    .row()
    .text(back.label, back.cb);
}

export function stockParserKeyboard(
  build: (code: string) => string,
  back: { label: string; cb: string },
): InlineKeyboard {
  return new InlineKeyboard()
    .text(STOCK_PARSER_LABEL.SINGLE_LINE, build("SL"))
    .row()
    .text(STOCK_PARSER_LABEL.EXPLICIT_SEPARATOR, build("SEP"))
    .row()
    .text(STOCK_PARSER_LABEL.EMAIL_BOUNDARY, build("EB"))
    .row()
    .text(back.label, back.cb);
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
      `نوع محصول: ${kindLabel(state.otherProductKind ?? "GENERIC")}`,
      `پروفایل تحویل: ${state.otherProductFulfillmentProfile === undefined ? "-" : profileLabel(state.otherProductFulfillmentProfile)}`,
    );
    if (state.otherProductStockParser !== undefined) {
      lines.push(`فرمت موجودی: ${STOCK_PARSER_LABEL[state.otherProductStockParser]}`);
    }
    if (state.collectInfoBeforeManualApproval === true) {
      lines.push("دریافت اطلاعات قبل از تایید رسید: فعال");
    }
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
