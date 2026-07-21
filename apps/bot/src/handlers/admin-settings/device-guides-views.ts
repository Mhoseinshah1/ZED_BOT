import type { ConnectionGuideApp } from "@zedbot/database";
import {
  GUIDE_DISPLAY_NAME_MAX,
  GUIDE_INSTRUCTIONS_MAX,
  GUIDE_PLATFORM_CODE,
  GUIDE_PLATFORM_NEUTRAL_LABEL,
  GUIDE_PLATFORMS,
  GUIDE_TROUBLESHOOTING_MAX,
  type GuidePlatform,
} from "@zedbot/shared";
import { InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { GuideReadiness } from "../../services/connection-guide.service.js";
import { guideAppInvalidReasons } from "../../services/connection-guide.service.js";
import { escapeHtml } from "../../utils/html.js";

// =============================================================================
// Device connection guides — OWNER admin views (feat/device-connection-guides).
// Pure text/keyboard builders + the callback map. Admin-facing copy is code
// constants (Persian). Download URLs / instruction bodies are NEVER logged; here
// they render only inside the OWNER's own editor/preview. Callbacks are stable,
// namespaced, colon-delimited and carry only compact codes / 8-char short ids.
// =============================================================================

const HTML = { parseMode: "HTML" as const };
export { HTML as DEV_GUIDE_HTML };

export const DEV_GUIDE_CB = {
  root: "admin:devguide:root",
  enable: "admin:devguide:enable",
  enableYes: "admin:devguide:enable:yes",
  disable: "admin:devguide:disable",
  disableYes: "admin:devguide:disable:yes",
  platform: (pcode: string): string => `admin:devguide:p:${pcode}`,
  add: (pcode: string): string => `admin:devguide:add:${pcode}`,
  app: (sid: string): string => `admin:devguide:app:${sid}`,
  edit: (sid: string, field: string): string => `admin:devguide:edit:${sid}:${field}`,
  method: (sid: string, m: string): string => `admin:devguide:m:${sid}:${m}`,
  toggle: (sid: string): string => `admin:devguide:tg:${sid}`,
  toggleConfirm: (sid: string, on: boolean): string =>
    `admin:devguide:tg:${sid}:${on ? "on" : "off"}`,
  up: (sid: string): string => `admin:devguide:up:${sid}`,
  down: (sid: string): string => `admin:devguide:down:${sid}`,
  archive: (sid: string): string => `admin:devguide:arch:${sid}`,
  archiveYes: (sid: string): string => `admin:devguide:arch:${sid}:yes`,
  preview: (sid: string): string => `admin:devguide:prev:${sid}`,
} as const;

/** Editable-field codes carried in the edit callback (bounded `[a-z_]`). */
export const GUIDE_EDIT_FIELDS = {
  name: "name",
  icon: "icon",
  primary: "primary",
  alternate: "alt",
  instructions: "instr",
  troubleshooting: "trouble",
  sort: "sort",
} as const;
export type GuideEditField = (typeof GUIDE_EDIT_FIELDS)[keyof typeof GUIDE_EDIT_FIELDS];

/** Supported-method toggle codes. */
export const GUIDE_METHOD_CODES = { subscription: "sub", qr: "qr", configs: "cfg" } as const;

function sid(app: Pick<ConnectionGuideApp, "id">): string {
  return app.id.slice(0, 8);
}

function yesNo(v: boolean): string {
  return v ? "✅" : "❌";
}

export function devGuideLandingText(
  readiness: GuideReadiness,
  counts: Record<GuidePlatform, { total: number; active: number }>,
): string {
  const lines = [
    "راهنمای اتصال دستگاه‌ها 📱",
    "",
    `وضعیت سیستم: ${readiness.masterEnabled ? "فعال ✅" : "غیرفعال ⛔️"}`,
    `برنامه‌های فعال: ${readiness.activeCount}`,
    `پلتفرم‌های فعال: ${readiness.activePlatformCount}`,
    `برنامه‌های ناقص/نامعتبر: ${readiness.invalidActiveCount}`,
    `کل برنامه‌ها: ${readiness.totalCount}${readiness.archivedCount > 0 ? ` (${readiness.archivedCount} آرشیو)` : ""}`,
    `آخرین به‌روزرسانی: ${readiness.lastUpdatedAt === null ? "-" : readiness.lastUpdatedAt.toISOString().slice(0, 16).replace("T", " ")}`,
    "",
    "پلتفرم‌ها:",
  ];
  for (const p of GUIDE_PLATFORMS) {
    lines.push(`• ${GUIDE_PLATFORM_NEUTRAL_LABEL[p]} — ${counts[p].active}/${counts[p].total} فعال`);
  }
  if (!readiness.ready) {
    lines.push("", "برای فعال‌سازی، حداقل یک برنامهٔ فعال و معتبر لازم است.");
  }
  return lines.join("\n");
}

export function devGuideLandingKeyboard(readiness: GuideReadiness): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const p of GUIDE_PLATFORMS) {
    kb.text(GUIDE_PLATFORM_NEUTRAL_LABEL[p], DEV_GUIDE_CB.platform(GUIDE_PLATFORM_CODE[p])).row();
  }
  if (readiness.masterEnabled) {
    kb.text("غیرفعال کردن سیستم ⛔️", DEV_GUIDE_CB.disable).row();
  } else {
    kb.text("فعال کردن سیستم ✅", DEV_GUIDE_CB.enable).row();
  }
  kb.text("بازگشت به تنظیمات عمومی", CB.ADMIN_GENERAL_SETTINGS);
  return kb;
}

/** Persian readiness report — safe app NAMES + reason counts only. */
export function devGuideReadinessReport(readiness: GuideReadiness): string {
  const lines = ["گزارش آمادگی فعال‌سازی 🧭", ""];
  lines.push(`برنامه‌های فعال: ${readiness.activeCount}`);
  lines.push(`نامعتبر: ${readiness.invalidActiveCount}`);
  lines.push(`اسلاگ تکراری: ${readiness.duplicateSlugs.length}`);
  if (readiness.invalidApps.length > 0) {
    lines.push("", "برنامه‌های نیازمند اصلاح:");
    for (const a of readiness.invalidApps.slice(0, 12)) {
      lines.push(`• ${escapeHtml(a.displayName)} (${a.reasons.length} مورد)`);
    }
  }
  lines.push("", readiness.ready ? "آماده فعال‌سازی است ✅" : "هنوز آماده نیست ❌");
  return lines.join("\n");
}

export function devGuidePlatformText(
  platform: GuidePlatform,
  apps: ConnectionGuideApp[],
): string {
  const lines = [`برنامه‌های ${GUIDE_PLATFORM_NEUTRAL_LABEL[platform]} 📱`, ""];
  if (apps.length === 0) {
    lines.push("هنوز برنامه‌ای برای این پلتفرم ثبت نشده است.");
  } else {
    for (const a of apps) {
      const invalid = guideAppInvalidReasons(a).length > 0;
      lines.push(
        `${a.isActive ? "✅" : "⏸"} ${escapeHtml(a.iconEmoji)} ${escapeHtml(a.displayName)}${invalid ? " ⚠️" : ""}`,
      );
    }
  }
  return lines.join("\n");
}

export function devGuidePlatformKeyboard(
  platform: GuidePlatform,
  apps: ConnectionGuideApp[],
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const a of apps) {
    kb.text(`${a.iconEmoji} ${a.displayName}`, DEV_GUIDE_CB.app(sid(a))).row();
  }
  kb.text("افزودن برنامه ➕", DEV_GUIDE_CB.add(GUIDE_PLATFORM_CODE[platform])).row();
  kb.text("بازگشت به راهنمای اتصال", DEV_GUIDE_CB.root);
  return kb;
}

export function devGuideAppEditorText(app: ConnectionGuideApp): string {
  const reasons = guideAppInvalidReasons(app);
  const lines = [
    `ویرایش برنامه: ${escapeHtml(app.displayName)} ${escapeHtml(app.iconEmoji)}`,
    "",
    `پلتفرم: ${GUIDE_PLATFORM_NEUTRAL_LABEL[app.platform as GuidePlatform] ?? escapeHtml(app.platform)}`,
    `اسلاگ: <code>${escapeHtml(app.slug)}</code>`,
    `وضعیت: ${app.isActive ? "فعال ✅" : "غیرفعال ⏸"}`,
    `ترتیب: ${app.sortOrder}`,
    "",
    `روش‌ها: اشتراک ${yesNo(app.supportsSubscription)} | کانفیگ ${yesNo(app.supportsIndividualConfigs)} | QR ${yesNo(app.supportsQr)}`,
    `لینک اصلی: ${app.primaryDownloadUrl === "" ? "-" : "ثبت شده ✅"}`,
    `لینک جایگزین: ${app.alternateDownloadUrl === null || app.alternateDownloadUrl === "" ? "-" : "ثبت شده ✅"}`,
    `آموزش: ${app.instructions.trim().length} کاراکتر`,
    `رفع اشکال: ${app.troubleshooting.trim().length} کاراکتر`,
  ];
  if (reasons.length > 0) {
    lines.push("", `⚠️ برای فعال‌سازی این موارد باید اصلاح شوند (${reasons.length}).`);
  }
  return lines.join("\n");
}

export function devGuideAppEditorKeyboard(app: ConnectionGuideApp): InlineKeyboard {
  const s = sid(app);
  const kb = new InlineKeyboard()
    .text("نام", DEV_GUIDE_CB.edit(s, GUIDE_EDIT_FIELDS.name))
    .text("آیکون", DEV_GUIDE_CB.edit(s, GUIDE_EDIT_FIELDS.icon))
    .row()
    .text("لینک اصلی", DEV_GUIDE_CB.edit(s, GUIDE_EDIT_FIELDS.primary))
    .text("لینک جایگزین", DEV_GUIDE_CB.edit(s, GUIDE_EDIT_FIELDS.alternate))
    .row()
    .text("آموزش", DEV_GUIDE_CB.edit(s, GUIDE_EDIT_FIELDS.instructions))
    .text("رفع اشکال", DEV_GUIDE_CB.edit(s, GUIDE_EDIT_FIELDS.troubleshooting))
    .row()
    .text("ترتیب", DEV_GUIDE_CB.edit(s, GUIDE_EDIT_FIELDS.sort))
    .row()
    .text(
      `اشتراک ${yesNo(app.supportsSubscription)}`,
      DEV_GUIDE_CB.method(s, GUIDE_METHOD_CODES.subscription),
    )
    .text(`کانفیگ ${yesNo(app.supportsIndividualConfigs)}`, DEV_GUIDE_CB.method(s, GUIDE_METHOD_CODES.configs))
    .text(`QR ${yesNo(app.supportsQr)}`, DEV_GUIDE_CB.method(s, GUIDE_METHOD_CODES.qr))
    .row()
    .text("بالا ⬆️", DEV_GUIDE_CB.up(s))
    .text("پایین ⬇️", DEV_GUIDE_CB.down(s))
    .row()
    .text("پیش‌نمایش 👁", DEV_GUIDE_CB.preview(s))
    .row();
  kb.text(app.isActive ? "غیرفعال کردن ⏸" : "فعال کردن ✅", DEV_GUIDE_CB.toggle(s)).row();
  kb.text("آرشیو 🗄", DEV_GUIDE_CB.archive(s)).row();
  kb.text("بازگشت به پلتفرم", DEV_GUIDE_CB.platform(GUIDE_PLATFORM_CODE[app.platform as GuidePlatform]));
  return kb;
}

/** Admin-facing preview of what the user guide page will show (safe dump). */
export function devGuidePreviewText(app: ConnectionGuideApp): string {
  const lines = [
    "پیش‌نمایش راهنما 👁",
    "",
    `آموزش اتصال با ${escapeHtml(app.displayName)} ${escapeHtml(app.iconEmoji)}`,
    "",
    escapeHtml(app.instructions.trim() === "" ? "(آموزش خالی است)" : app.instructions.trim()),
  ];
  if (app.troubleshooting.trim() !== "") {
    lines.push("", "رفع اشکال:", escapeHtml(app.troubleshooting.trim()));
  }
  lines.push(
    "",
    `روش‌ها: اشتراک ${yesNo(app.supportsSubscription)} | کانفیگ ${yesNo(app.supportsIndividualConfigs)} | QR ${yesNo(app.supportsQr)}`,
  );
  return lines.join("\n");
}

export function devGuidePreviewKeyboard(app: ConnectionGuideApp): InlineKeyboard {
  return new InlineKeyboard().text("بازگشت به ویرایش", DEV_GUIDE_CB.app(sid(app)));
}

export function devGuideConfirmKeyboard(confirmCb: string, cancelCb: string, label: string): InlineKeyboard {
  return new InlineKeyboard().text(label, confirmCb).row().text("انصراف", cancelCb);
}

/** Field prompt copy + bound hints for the editor's text-input steps. */
export const GUIDE_FIELD_PROMPT: Record<GuideEditField, string> = {
  name: `نام برنامه را وارد کنید (حداکثر ${GUIDE_DISPLAY_NAME_MAX} کاراکتر):`,
  icon: "یک ایموجی به‌عنوان آیکون برنامه بفرستید:",
  primary: "لینک دانلود اصلی (فقط HTTPS) را وارد کنید:",
  alt: "لینک دانلود جایگزین (HTTPS) را وارد کنید یا «-» برای حذف:",
  instr: `متن آموزش اتصال را وارد کنید (حداکثر ${GUIDE_INSTRUCTIONS_MAX} کاراکتر):`,
  trouble: `متن رفع اشکال را وارد کنید (حداکثر ${GUIDE_TROUBLESHOOTING_MAX} کاراکتر) یا «-» برای حذف:`,
  sort: "عدد ترتیب نمایش را وارد کنید:",
};
