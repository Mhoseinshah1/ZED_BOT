import { PanelStatus, type Panel } from "@zedbot/database";
import { InlineKeyboard } from "grammy";

import { cb, PANEL_CB } from "./panel-cb.js";
import { fieldsForPage, togglesForPage, type PanelPage } from "./panel-fields.js";
import {
  formatTrialDuration,
  formatTrialTraffic,
  type TrialPanelAssessment,
  type TrialPanelStats,
} from "../../services/free-trial.service.js";
import { panelCapabilityStatusLines } from "../../services/panel-readiness.service.js";
import { panelShortId } from "../../services/panel.service.js";
import { resolveXuiAuthMode } from "../../services/panel-adapter-factory.js";
import {
  NAMING_INCOMPLETE_TEXT,
  namingConfigFromPanel,
  previewNamingStrategy,
  USERNAME_STRATEGY_INFO,
  validateNamingConfig,
} from "../../services/service-naming.service.js";
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
  // Credential completeness depends on the panel's auth mode:
  // Marzban + XUI SESSION_COOKIE need username/password; XUI API_TOKEN
  // needs the stored token.
  const tokenMode = panel.type === "XUI" && resolveXuiAuthMode(panel) === "API_TOKEN";
  const credentialSet = tokenMode
    ? panel.tokenEncrypted !== null && panel.tokenEncrypted !== ""
    : panel.username !== null &&
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
    ...(panel.type === "XUI"
      ? [`روش احراز هویت: ${tokenMode ? "توکن API" : "نام کاربری و رمز عبور"}`]
      : []),
    `آمادگی ساخت سرویس: ${readinessLine}`,
    // XUI: per-operation capability statuses (static Persian labels; a
    // capability only reads supported after a passing readiness test).
    ...(panel.type === "XUI"
      ? ["", "قابلیت‌های عملیات سرویس:", ...panelCapabilityStatusLines(panel), ""]
      : []),
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
  const kb = new InlineKeyboard()
    .text("تست اتصال 🩺", cb.test(sid))
    .text("تغییر وضعیت", cb.statusMenu(sid))
    .row()
    .text("ویرایش نام", cb.fieldEdit(sid, "nm"))
    .text("ویرایش آدرس", cb.fieldEdit(sid, "url"))
    .row()
    .text(credentialLabel, cb.fieldEdit(sid, "cred"));
  if (panel.type === "XUI") {
    kb.text("روش احراز هویت 🔐", cb.authModeMenu(sid));
  }
  return kb
    .row()
    .text("محصولات متصل 🛍", cb.products(sid))
    .row()
    .text(panel.isVisible ? "مخفی کردن 🙈" : "نمایش 👁", cb.visibility(sid))
    .text("قابلیت‌ها", cb.features(sid))
    .row()
    .text("قیمت‌ها 💵", cb.pricing(sid))
    .text("اکانت تست 🎁", cb.trial(sid))
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
  // The trial page renders through panelTrialText, never panelPageView.
  trial: "اکانت تست 🎁",
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

/**
 * Naming phase: the selector shows the PERSIAN strategy labels; callback
 * data stays the stable strategy INDEX into USERNAME_PATTERNS - labels are
 * cosmetic and can never redirect a selection.
 */
export function usernamePatternKeyboard(panel: Panel): InlineKeyboard {
  const sid = panelShortId(panel);
  const kb = new InlineKeyboard();
  USERNAME_PATTERNS.forEach((pattern, index) => {
    const mark = panel.usernamePatternType === pattern ? "• " : "";
    kb.text(`${mark}${USERNAME_STRATEGY_INFO[pattern].fa}`, cb.usernamePattern(sid, index)).row();
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
    // Naming phase: «روش نام‌گذاری سرویس» - current strategy (Persian),
    // semantics, required fields, fallback and a live sample preview.
    const info = USERNAME_STRATEGY_INFO[panel.usernamePatternType];
    const validation = validateNamingConfig(namingConfigFromPanel(panel));
    const preview = previewNamingStrategy(panel, panel.usernamePatternType);
    lines.push(
      "روش نام‌گذاری سرویس",
      "",
      `روش فعلی:\n${info.fa}`,
      `توضیح: ${info.descriptionFa}`,
      ...(info.requiresFa.length > 0 ? [`فیلدهای موردنیاز: ${info.requiresFa.join("، ")}`] : []),
      "جایگزین بدون نام کاربری تلگرام: u + آیدی عددی",
      `حداکثر طول نام: 32 نویسه (برش با پسوند شناسه سفارش)`,
      "",
      validation.ok
        ? `نمونه نام ساخته‌شده:\n<code>${escapeHtml(preview.preview)}</code>`
        : `⚠️ ${NAMING_INCOMPLETE_TEXT} (${validation.missingFa.join("، ")})`,
      "",
    );
    kb.text("تغییر روش نام‌گذاری", cb.usernamePattern(sid, -1)).row();
    kb.text("پیش‌نمایش نام‌گذاری", cb.usernamePreview(sid)).row();
  }
  for (const field of fields) {
    lines.push(`• ${field.label}: ${formatValue(panel[field.column])}`);
    kb.text(`ویرایش: ${field.label}`, cb.fieldEdit(sid, field.key)).row();
  }
  kb.text("بازگشت", cb.view(sid));

  return { text: lines.join("\n"), keyboard: kb };
}

// --- Free-trial admin page (OWNER-only; the gate lives in panel.handler) -----

export const TRIAL_NOT_SET_TEXT = "تنظیم نشده";
export const TRIAL_ENABLE_ASK_TEXT =
  "آیا از فعال کردن اکانت تست برای این پنل مطمئن هستید؟";
export const TRIAL_DISABLE_ASK_TEXT =
  "آیا از غیرفعال کردن اکانت تست برای این پنل مطمئن هستید؟";
export const TRIAL_ENABLED_TEXT = "اکانت تست برای این پنل فعال شد ✅";
export const TRIAL_DISABLED_TEXT = "اکانت تست برای این پنل غیرفعال شد.";
export const TRIAL_CONFIG_INCOMPLETE_TEXT = "تنظیمات اکانت تست این پنل کامل نیست.";

/**
 * The «اکانت تست 🎁» detail page. Pure: assessment/stats come from the
 * handler (assessTrialPanelConfig / trialStatsForPanel). Renders config and
 * counters ONLY - never credentials, subscription URLs or claim payloads.
 */
export function panelTrialText(
  panel: Panel,
  assessment: TrialPanelAssessment,
  stats: TrialPanelStats,
): string {
  const duration =
    panel.testDurationMinutes !== null && panel.testDurationMinutes > 0
      ? formatTrialDuration(panel.testDurationMinutes)
      : TRIAL_NOT_SET_TEXT;
  const traffic =
    panel.testVolumeMb !== null && panel.testVolumeMb > 0
      ? formatTrialTraffic(panel.testVolumeMb)
      : TRIAL_NOT_SET_TEXT;
  const capacity = `${stats.capacityUsed}${stats.capacityLimit !== null ? ` / ${stats.capacityLimit}` : ""}`;
  return [
    "🎁 تنظیمات اکانت تست",
    "",
    "پنل:",
    escapeHtml(panel.name),
    "",
    "وضعیت:",
    panel.testEnabled ? "فعال ✅" : "غیرفعال ❌",
    "",
    "مدت تست:",
    duration,
    "",
    "حجم تست:",
    traffic,
    "",
    "تعداد تست‌های فعال:",
    capacity,
    "",
    "آمادگی ساخت:",
    assessment.ok ? "آماده ✅" : "ناقص ❌",
  ].join("\n");
}

/** Trial-page keyboard: rows of <= 2, every callback far under 64 bytes. */
export function panelTrialKeyboard(panel: Panel): InlineKeyboard {
  const sid = panelShortId(panel);
  const kb = new InlineKeyboard()
    .text(
      panel.testEnabled ? "غیرفعال کردن" : "فعال کردن",
      panel.testEnabled ? cb.trialDisableAsk(sid) : cb.trialEnableAsk(sid),
    )
    .row()
    .text("تنظیم مدت", cb.fieldEdit(sid, "tdm"))
    .text("تنظیم حجم", cb.fieldEdit(sid, "tvm"))
    .row();
  if (panel.type === "XUI") {
    kb.text("تنظیم اینباندهای تست", cb.fieldEdit(sid, "tib"));
  }
  kb.text("ظرفیت تست", cb.fieldEdit(sid, "tmc")).row();
  kb.text(
    `${panel.testAutoDisableAfterExpiry ? "✅" : "❌"} غیرفعال‌سازی خودکار بعد از انقضا`,
    cb.toggle(sid, "tade"),
  ).row();
  kb.text("پیش‌نمایش نام", cb.trialNamePreview(sid))
    .text("آمار اکانت‌های تست", cb.trialStats(sid))
    .row();
  kb.text("بازگشت به جزئیات پنل", cb.view(sid));
  return kb;
}

/** Two-step enable confirmation (same shape as the delete flow). */
export function trialEnableAskView(panel: Panel): { text: string; keyboard: InlineKeyboard } {
  const sid = panelShortId(panel);
  return {
    text: TRIAL_ENABLE_ASK_TEXT,
    keyboard: new InlineKeyboard()
      .text("بله، فعال کن", cb.trialEnableConfirm(sid))
      .row()
      .text("انصراف", cb.trial(sid)),
  };
}

/** Two-step disable confirmation. Disabling never touches existing claims. */
export function trialDisableAskView(panel: Panel): { text: string; keyboard: InlineKeyboard } {
  const sid = panelShortId(panel);
  return {
    text: TRIAL_DISABLE_ASK_TEXT,
    keyboard: new InlineKeyboard()
      .text("بله، غیرفعال کن", cb.trialDisableConfirm(sid))
      .row()
      .text("انصراف", cb.trial(sid)),
  };
}

/** «آمار اکانت‌های تست»: counters and dates only - no URLs, no credentials. */
export function panelTrialStatsText(panel: Panel, stats: TrialPanelStats): string {
  return [
    "📊 آمار اکانت‌های تست",
    "",
    "پنل:",
    escapeHtml(panel.name),
    "",
    `کل تست‌ها: ${stats.total}`,
    `فعال: ${stats.active}`,
    `در حال ساخت: ${stats.provisioning}`,
    `منقضی‌شده: ${stats.expired}`,
    `ناموفق/لغوشده: ${stats.failed}`,
    `نیازمند بررسی: ${stats.manualReview}`,
    `آخرین ساخت: ${stats.lastCreatedAt === null ? "-" : stats.lastCreatedAt.toISOString().replace("T", " ").slice(0, 16)}`,
    `ظرفیت: ${stats.capacityLimit === null ? `${stats.capacityUsed} (بدون سقف)` : `${stats.capacityUsed} / ${stats.capacityLimit}`}`,
  ].join("\n");
}
