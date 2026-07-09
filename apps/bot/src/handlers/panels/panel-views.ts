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
  return "مدیریت پنل‌ها 🛠\n\nیک گزینه را انتخاب کنید:";
}

export function panelMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("افزودن پنل ➕", PANEL_CB.ADD)
    .text("لیست پنل‌ها 📋", cb.list(1))
    .row()
    .text("بازگشت", "admin:menu");
}

// --- Panel list --------------------------------------------------------------

export function panelListKeyboard(
  panels: Panel[],
  page: number,
  pages: number,
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const panel of panels) {
    const emoji = STATUS_EMOJI[panel.status];
    const hidden = panel.isVisible ? "" : " 🙈";
    kb.text(`${emoji} ${panel.name} | ${panel.type}${hidden}`, cb.view(panelShortId(panel))).row();
  }
  if (pages > 1) {
    if (page > 1) {
      kb.text("« قبلی", cb.list(page - 1));
    }
    kb.text(`${page}/${pages}`, "admin:panels:noop");
    if (page < pages) {
      kb.text("بعدی »", cb.list(page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت", PANEL_CB.MENU);
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
export function panelDetailText(panel: Panel): string {
  const lines = [
    `📋 <b>${escapeHtml(panel.name)}</b>`,
    "",
    `نوع پنل: ${panel.type}`,
    `آدرس: ${escapeHtml(panel.baseUrl)}`,
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

export function panelDetailKeyboard(panel: Panel): InlineKeyboard {
  const sid = panelShortId(panel);
  const credentialLabel = panel.type === "MARZBAN" ? "ویرایش رمز 🔑" : "ویرایش توکن 🔑";
  return new InlineKeyboard()
    .text("تست اتصال 🔌", cb.test(sid))
    .row()
    .text("ویرایش نام", cb.fieldEdit(sid, "nm"))
    .text("ویرایش آدرس", cb.fieldEdit(sid, "url"))
    .row()
    .text(credentialLabel, cb.fieldEdit(sid, "cred"))
    .text("تغییر وضعیت", cb.statusMenu(sid))
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
    .text("بازگشت به لیست", cb.list(1));
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
