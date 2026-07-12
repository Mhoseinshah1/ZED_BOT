import { PanelStatus, type Panel } from "@zedbot/database";
import { InlineKeyboard } from "grammy";

import { cb, PANEL_CB } from "./panel-cb.js";
import { fieldsForPage, togglesForPage, type PanelPage } from "./panel-fields.js";
import { panelShortId } from "../../services/panel.service.js";
import { escapeHtml } from "../../utils/html.js";

const STATUS_EMOJI: Record<PanelStatus, string> = {
  ACTIVE: "🟢",
  INACTIVE: "⚪️",
  MAINTENANCE: "🟡",
  FAILED: "🔴",
};

const STATUS_LABEL: Record<PanelStatus, string> = {
  ACTIVE: "فعال",
  INACTIVE: "غیرفعال",
  MAINTENANCE: "تعمیرات",
  FAILED: "خطا",
};

function yesNo(value: boolean): string {
  return value ? "✅" : "❌";
}

// --- Panel management root menu ----------------------------------------------

export function panelMenuText(): string {
  return "مدیریت پنل‌ها 🖥\n\nیک گزینه را انتخاب کنید:";
}

/**
 * Fix C root. «تست همه پنل‌های فعال» is deliberately NOT offered - no
 * existing bulk-test helper exists and inventing one is out of scope
 * (documented deferral; per-panel «تست اتصال 🩺» covers the need).
 */
export function panelMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("لیست پنل‌ها 🧾", cb.list(1))
    .text("افزودن پنل ➕", PANEL_CB.ADD)
    .row()
    .text("پنل‌های فعال ✅", cb.listFiltered("a", 1))
    .text("پنل‌های غیرفعال ⏸", cb.listFiltered("i", 1))
    .row()
    .text("بازگشت به پنل ادمین", "admin:menu");
}

// --- Panel list --------------------------------------------------------------

/** Hostname only - the full URL (and never credentials) stays off the list. */
export function panelHostname(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "-";
  }
}

export function panelListKeyboard(
  panels: Panel[],
  page: number,
  pages: number,
  filter?: "a" | "i",
): InlineKeyboard {
  const pageCb = (p: number): string => (filter === undefined ? cb.list(p) : cb.listFiltered(filter, p));
  const kb = new InlineKeyboard();
  for (const panel of panels) {
    const emoji = STATUS_EMOJI[panel.status];
    const hidden = panel.isVisible ? "" : " 🙈";
    kb.text(
      `${emoji} ${panel.name} | ${panel.type} | ${panelHostname(panel.baseUrl)}${hidden}`,
      cb.view(panelShortId(panel)),
    ).row();
  }
  if (pages > 1) {
    if (page > 1) {
      kb.text("« قبلی", pageCb(page - 1));
    }
    kb.text(`${page}/${pages}`, "admin:panels:noop");
    if (page < pages) {
      kb.text("بعدی »", pageCb(page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت به مدیریت پنل‌ها", PANEL_CB.MENU);
  return kb;
}

export function panelListText(total: number): string {
  if (total === 0) {
    return "هیچ پنلی ثبت نشده است. با «افزودن پنل ➕» شروع کنید.";
  }
  return `لیست پنل‌ها 📋 (${total} پنل)\n\nبرای مشاهده جزئیات یک پنل را انتخاب کنید:`;
}

// --- Panel detail ------------------------------------------------------------

function groupsText(value: unknown): string {
  if (Array.isArray(value) && value.length > 0) {
    return value.join(", ");
  }
  return "همه گروه‌ها";
}

// HTML parse mode: every dynamic (operator-entered) value must be escaped.
// Credentials NEVER render - only a set/not-set marker (Fix C).
export function panelDetailText(panel: Panel, linkedProductCount?: number): string {
  // Both panel families authenticate with username + password now.
  const credentialSet =
    panel.username !== null &&
    panel.username !== "" &&
    panel.passwordEncrypted !== null &&
    panel.passwordEncrypted !== "";
  const readinessLine =
    panel.provisioningReady === true
      ? "آماده ساخت سرویس ✅"
      : panel.provisioningReady === false
        ? "ساخت سرویس آماده نیست ❌ (تست اتصال را اجرا کنید)"
        : "تست نشده ➖ (تست اتصال را اجرا کنید)";
  const lines = [
    `📋 <b>${escapeHtml(panel.name)}</b>`,
    "",
    `شناسه: <code>${panelShortId(panel)}</code>`,
    `نوع پنل: ${panel.type}`,
    `هاست: ${escapeHtml(panelHostname(panel.baseUrl))}`,
    `اطلاعات ورود: ${credentialSet ? "تنظیم شده ✅" : "تنظیم نشده ❌"}`,
    `آمادگی ساخت سرویس: ${readinessLine}`,
    ...(linkedProductCount === undefined ? [] : [`محصولات متصل: ${linkedProductCount}`]),
    `ایجاد: ${panel.createdAt.toISOString().slice(0, 10)}`,
    `وضعیت: ${STATUS_EMOJI[panel.status]} ${STATUS_LABEL[panel.status]}`,
    `نمایش: ${panel.isVisible ? "قابل نمایش 👁" : "مخفی 🙈"}`,
    `گروه‌های قابل نمایش: ${escapeHtml(groupsText(panel.visibleForGroups))}`,
    `روش تمدید: ${panel.renewalMethod}`,
    `ظرفیت ساخت اکانت: ${panel.accountLimitEnabled ? (panel.accountLimitCount ?? "-") : "نامحدود"}`,
    `تعداد ساخته‌شده: ${panel.createdAccountsCount}`,
    `تعداد فعال: ${panel.activeAccountsCount}`,
    `دامنه ساب: ${escapeHtml(panel.subscriptionDomain ?? "-")}`,
    `روش ساخت username: ${panel.usernamePatternType}`,
    `تست رایگان: ${yesNo(panel.testEnabled)}`,
    `تمدید: ${yesNo(panel.renewalEnabled)}`,
    `سرویس دلخواه F/N/N2: ${yesNo(panel.customServiceForF)}/${yesNo(panel.customServiceForN)}/${yesNo(panel.customServiceForN2)}`,
    `قیمت حجم اضافه: ${panel.pricePerExtraGbToman} تومان`,
    `قیمت زمان اضافه: ${panel.pricePerExtraDayToman} تومان`,
    `قیمت تغییر لوکیشن: ${panel.locationChangePriceToman} تومان`,
    `آخرین بروزرسانی: ${panel.updatedAt.toISOString().replace("T", " ").slice(0, 16)}`,
  ];
  return lines.join("\n");
}

/** Fix C: `backList` returns to the same list/filter/page (session context). */
export function panelDetailKeyboard(
  panel: Panel,
  backList?: { filter?: "a" | "i"; page: number },
): InlineKeyboard {
  const sid = panelShortId(panel);
  const credentialLabel = "ویرایش اطلاعات ورود 🔑";
  const listBack =
    backList?.filter === undefined ? cb.list(backList?.page ?? 1) : cb.listFiltered(backList.filter, backList.page);
  return new InlineKeyboard()
    .text("تست اتصال 🩺", cb.test(sid))
    .text("تغییر وضعیت", cb.statusMenu(sid))
    .row()
    .text("ویرایش نام", cb.fieldEdit(sid, "nm"))
    .text("ویرایش آدرس", cb.fieldEdit(sid, "url"))
    .row()
    .text(credentialLabel, cb.fieldEdit(sid, "cred"))
    .text("محصولات متصل 🛍", cb.products(sid))
    .row()
    .text(panel.isVisible ? "مخفی کردن 🙈" : "نمایش 👁", cb.visibility(sid))
    .text("قابلیت‌ها", cb.features(sid))
    .row()
    .text("قیمت‌ها 💵", cb.pricing(sid))
    .text("تنظیمات تست 🧪", cb.testSettings(sid))
    .row()
    .text("تنظیمات username", cb.usernameSettings(sid))
    .text("تنظیمات پنل ⚙️", cb.typeSettings(sid))
    .row()
    .text("حذف پنل 🗑", cb.deleteAsk(sid))
    .row()
    .text("بازگشت به لیست پنل‌ها", listBack)
    .row()
    .text("بازگشت به مدیریت پنل‌ها", PANEL_CB.MENU);
}

// --- Status menu -------------------------------------------------------------

export function statusMenuKeyboard(panel: Panel): InlineKeyboard {
  const sid = panelShortId(panel);
  const kb = new InlineKeyboard();
  for (const status of Object.values(PanelStatus)) {
    const mark = panel.status === status ? "• " : "";
    kb.text(`${mark}${STATUS_EMOJI[status]} ${STATUS_LABEL[status]}`, cb.statusSet(sid, status)).row();
  }
  kb.text("بازگشت", cb.view(sid));
  return kb;
}

// --- Generic toggle / field pages --------------------------------------------

const PAGE_TITLE: Record<PanelPage, string> = {
  detail: "جزئیات پنل",
  features: "قابلیت‌ها 🛠",
  pricing: "قیمت‌ها 💵",
  test: "تنظیمات تست 🧪",
  username: "تنظیمات username",
  cfg: "تنظیمات پنل ⚙️",
};

// Output is embedded in HTML parse mode - everything dynamic gets escaped.
function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "-";
  }
  if (typeof value === "object") {
    return `<code>${escapeHtml(JSON.stringify(value))}</code>`;
  }
  return escapeHtml(value);
}

export const USERNAME_PATTERNS = [
  "TELEGRAM_USERNAME_SEQUENCE",
  "TELEGRAM_ID_RANDOM",
  "CUSTOM",
  "CUSTOM_RANDOM",
  "CUSTOM_TEXT_RANDOM",
  "CUSTOM_TEXT_SEQUENCE",
  "TELEGRAM_ID_SEQUENCE",
  "REPRESENTATIVE_TEXT_SEQUENCE",
] as const;

/** The username-settings page adds a pattern-type selector above the fields. */
export function usernamePatternKeyboard(panel: Panel): InlineKeyboard {
  const sid = panelShortId(panel);
  const kb = new InlineKeyboard();
  USERNAME_PATTERNS.forEach((pattern, index) => {
    const mark = panel.usernamePatternType === pattern ? "• " : "";
    kb.text(`${mark}${pattern}`, cb.usernamePattern(sid, index)).row();
  });
  kb.text("بازگشت", cb.usernameSettings(sid));
  return kb;
}

/**
 * Renders a page that mixes toggles (features/test) and editable fields
 * (pricing/test/username/cfg). Toggle buttons flip in place; field buttons
 * open a text-input step.
 */
export function panelPageView(
  panel: Panel,
  page: PanelPage,
): { text: string; keyboard: InlineKeyboard } {
  const sid = panelShortId(panel);
  const toggles = togglesForPage(page);
  const fields = fieldsForPage(page, panel.type);
  const kb = new InlineKeyboard();

  for (const toggle of toggles) {
    const on = panel[toggle.column] === true;
    kb.text(`${on ? "✅" : "❌"} ${toggle.label}`, cb.toggle(sid, toggle.key)).row();
  }

  const lines = [`<b>${PAGE_TITLE[page]}</b> — ${escapeHtml(panel.name)}`, ""];
  if (page === "username") {
    lines.push(`روش فعلی ساخت username: ${panel.usernamePatternType}`, "");
    kb.text("تغییر روش ساخت username", cb.usernamePattern(sid, -1)).row();
  }
  for (const field of fields) {
    lines.push(`• ${field.label}: ${formatValue(panel[field.column])}`);
    kb.text(`ویرایش: ${field.label}`, cb.fieldEdit(sid, field.key)).row();
  }
  kb.text("بازگشت", cb.view(sid));

  return { text: lines.join("\n"), keyboard: kb };
}
