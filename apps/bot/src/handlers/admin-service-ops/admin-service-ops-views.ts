import type { AdminServiceOperation, Panel, Service, User } from "@zedbot/database";
import {
  ADMIN_SERVICE_VOLUME_PRESETS_GIB,
  ADMIN_SERVICE_TIME_PRESETS_DAYS,
  adminServiceShortId,
  type AdminServiceErrorCode,
  type AdminServiceOperationStatus,
  type AdminServiceOperationType,
} from "@zedbot/shared";
import { InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { AdminServiceMutationType } from "../../services/admin-service-operation.service.js";
import { escapeHtml } from "../../utils/html.js";
import { statusLabel as serviceStatusLabel } from "../user-services/service-views.js";

// =============================================================================
// Admin Service Operations — rendering (feat/admin-service-operations, §7/§8/
// §18/§19). Everything here is BOUNDED and SECRET-FREE: no subscription URL,
// config link, QR, panel URL/credentials, token, remote client id or raw panel
// response ever renders. Behaviour binds to machine codes, never Persian
// strings. Admin context only (mounted behind adminAuthMiddleware).
// =============================================================================

/** Callback namespace. Every payload is ≤64 bytes and carries only an 8-char
 * short id (an opaque prefix, never a secret) — never a full id/URL/token. */
export const ASO_CB = {
  view: (sid: string): string => `admin:svc:view:${sid}`,
  refresh: (sid: string): string => `admin:svc:refresh:${sid}`,
  hist: (sid: string, page: number): string => `admin:svc:hist:${sid}:${page}`,
  op: (opSid: string): string => `admin:svc:op:${opSid}`,
  toggle: (sid: string, enable: boolean): string => `admin:svc:tg:${sid}:${enable ? "e" : "d"}`,
  volMenu: (sid: string): string => `admin:svc:vol:${sid}`,
  volPreset: (sid: string, gib: number): string => `admin:svc:volp:${sid}:${gib}`,
  volCustom: (sid: string): string => `admin:svc:volc:${sid}`,
  timeMenu: (sid: string): string => `admin:svc:tm:${sid}`,
  timePreset: (sid: string, days: number): string => `admin:svc:tmp:${sid}:${days}`,
  timeCustom: (sid: string): string => `admin:svc:tmc:${sid}`,
  regenAsk: (sid: string): string => `admin:svc:rg:${sid}`,
  regenGo: (sid: string): string => `admin:svc:rg2:${sid}`,
  note: (sid: string): string => `admin:svc:note:${sid}`,
  confirm: "admin:svc:confirm",
  cancel: (sid: string): string => `admin:svc:cancel:${sid}`,
  // OWNER reconciliation dashboard + a single reconcile run.
  recon: (page: number): string => `admin:svc:recon:${page}`,
  reconRun: (opSid: string): string => `admin:svc:recrun:${opSid}`,
  // OWNER settings (the mutation master switch).
  settings: "admin:svc:settings",
  settingsToggle: "admin:svc:swtoggle",
} as const;

const OP_TYPE_LABEL: Record<AdminServiceOperationType, string> = {
  ENABLE: "فعال‌سازی ▶️",
  DISABLE: "غیرفعال‌سازی ⏸",
  ADD_VOLUME: "افزودن حجم 📦",
  ADD_TIME: "افزودن زمان ⏳",
  REGENERATE_LINK: "تغییر لینک اشتراک 🔄",
  ADD_NOTE: "یادداشت 📝",
};

const OP_STATUS_LABEL: Record<AdminServiceOperationStatus, string> = {
  PENDING: "در حال انجام ⏳",
  SUCCEEDED: "موفق ✅",
  FAILED: "ناموفق ❌",
  UNCERTAIN: "نامشخص ⚠️",
  RECONCILIATION_REQUIRED: "نیازمند بررسی ⚠️",
  RECONCILED: "بررسی و اصلاح شد ✅",
  CANCELLED: "لغو شد",
};

/** Safe, admin-facing Persian message per machine error code (§21 — never a raw
 * panel response). */
export const ADMIN_SERVICE_ERROR_TEXT: Record<AdminServiceErrorCode, string> = {
  MUTATIONS_DISABLED: "عملیات سرویس غیرفعال است. ابتدا باید از تنظیمات فعال شود.",
  NOT_OWNER: "این عملیات فقط برای مالک ربات در دسترس است.",
  SERVICE_NOT_FOUND: "سرویس یافت نشد.",
  STALE_PREVIEW: "وضعیت سرویس تغییر کرده است. لطفاً صفحه را تازه کرده و دوباره تلاش کنید.",
  LOCK_BUSY: "عملیات دیگری روی این سرویس در حال انجام است. کمی بعد دوباره تلاش کنید.",
  LOCK_UNAVAILABLE: "انجام عملیات موقتاً امکان‌پذیر نیست. کمی بعد دوباره تلاش کنید.",
  CAPABILITY_UNSUPPORTED: "این عملیات روی پنل این سرویس پشتیبانی نمی‌شود.",
  PANEL_INACTIVE: "پنل این سرویس غیرفعال است.",
  XUI_LEGACY_UNSUPPORTED: "این سرویس از نوع قدیمی است و این عملیات روی آن پشتیبانی نمی‌شود.",
  INELIGIBLE_STATUS: "وضعیت فعلی سرویس اجازه این عملیات را نمی‌دهد.",
  UNKNOWN_QUOTA: "حجم فعلی سرویس قابل تشخیص نیست.",
  UNLIMITED_BLOCKED: "این سرویس حجم نامحدود دارد و افزودن حجم روی آن ممکن نیست.",
  UNKNOWN_EXPIRY: "تاریخ انقضای فعلی سرویس قابل تشخیص نیست.",
  NEVER_EXPIRING_BLOCKED: "این سرویس تاریخ انقضا ندارد و افزودن زمان روی آن ممکن نیست.",
  VALUE_OUT_OF_RANGE: "مقدار واردشده معتبر نیست.",
  OVERFLOW: "مقدار درخواستی بیش از حد مجاز است.",
  INCONSISTENT_REMOTE_STATE:
    "نتیجه عملیات نامشخص ماند؛ وضعیت به‌صورت خودکار بررسی و اصلاح می‌شود.",
  PANEL_REJECTED: "عملیات روی پنل انجام نشد. لطفاً بعداً دوباره تلاش کنید.",
  PANEL_UNCERTAIN: "نتیجه عملیات نامشخص ماند؛ در صفحه بررسی قابل پیگیری است.",
  CONFLICTING_OPERATION: "یک عملیات حل‌نشده روی این سرویس وجود دارد. ابتدا آن را بررسی کنید.",
  VALIDATION: "درخواست معتبر نیست.",
};

export function adminServiceErrorText(code: AdminServiceErrorCode): string {
  return ADMIN_SERVICE_ERROR_TEXT[code] ?? "خطای نامشخص.";
}

const GIB = 1024n * 1024n * 1024n;

function formatBytes(bytes: bigint): string {
  if (bytes <= 0n) {
    return "نامحدود";
  }
  const gib = Number(bytes) / Number(GIB);
  return `${Math.round(gib * 100) / 100} گیگابایت`;
}

function formatDate(date: Date | null): string {
  return date === null ? "نامحدود" : `${date.toISOString().replace("T", " ").slice(0, 16)} (UTC)`;
}

function opLine(op: AdminServiceOperation): string {
  const label = OP_TYPE_LABEL[op.type as AdminServiceOperationType] ?? op.type;
  const status = OP_STATUS_LABEL[op.status as AdminServiceOperationStatus] ?? op.status;
  return `• ${label} | ${status} | ${op.createdAt.toISOString().slice(0, 16).replace("T", " ")}`;
}

/** Compact owner identity (no secrets — telegram id + optional @username). */
function ownerLabel(owner: User | null): string {
  if (owner === null) {
    return "-";
  }
  const handle = owner.username === null || owner.username === "" ? "" : ` (@${escapeHtml(owner.username)})`;
  return `<code>${owner.telegramId}</code>${handle}`;
}

export interface AdminServiceDetailView {
  service: Service;
  panel: Panel;
  owner: User | null;
  unresolvedCount: number;
  latestOps: AdminServiceOperation[];
  latestNote: AdminServiceOperation | null;
  freshnessNotice: string | null;
}

/**
 * The per-Service admin detail page (§8). Bounded + secret-free: shows the
 * account username, status, quota/usage/remaining, expiry, panel + capability
 * flags, the unresolved-operation count, the latest 3 operations and the latest
 * internal note — never a subscription URL, config, QR, token or panel
 * credential.
 */
export function adminServiceDetailText(view: AdminServiceDetailView): string {
  const { service, panel, owner } = view;
  const lines = [
    "مدیریت سرویس ⚙️",
    "",
    `سرویس: ${escapeHtml(service.productNameSnapshot ?? service.username)}`,
    `نام کاربری: <code>${escapeHtml(service.username)}</code>`,
    `کاربر: ${ownerLabel(owner)}`,
    `وضعیت: ${serviceStatusLabel(service.status)}`,
    "",
    `حجم کل: ${formatBytes(service.volumeBytes)}`,
    `مصرف‌شده: ${formatBytes(service.usedBytes)}`,
    `باقیمانده: ${formatBytes(service.remainingBytes)}`,
    `انقضا: ${formatDate(service.expiresAt)}`,
    "",
    `پنل: ${escapeHtml(service.panelNameSnapshot ?? panel.type)} (${panel.type})`,
    `وضعیت پنل: ${panel.status === "ACTIVE" ? "فعال ✅" : "غیرفعال ⛔"}`,
  ];
  if (view.unresolvedCount > 0) {
    lines.push("", `عملیات حل‌نشده روی این سرویس: ${view.unresolvedCount} ⚠️`);
  }
  lines.push("", "آخرین عملیات‌ها:");
  if (view.latestOps.length === 0) {
    lines.push("• موردی ثبت نشده است.");
  } else {
    for (const op of view.latestOps) {
      lines.push(opLine(op));
    }
  }
  if (view.latestNote !== null && view.latestNote.reason !== null) {
    lines.push("", `آخرین یادداشت: ${escapeHtml(view.latestNote.reason)}`);
  }
  if (view.freshnessNotice !== null) {
    lines.push("", view.freshnessNotice);
  }
  return lines.join("\n");
}

export interface AdminServiceDetailKeyboardOptions {
  ownerSid: string;
  isOwner: boolean;
  mutationsEnabled: boolean;
  eligible: AdminServiceMutationType[];
  hasConflict: boolean;
}

/**
 * The detail keyboard. Read-only refresh + history are ALWAYS available. Every
 * lifecycle-mutation button appears ONLY when the master switch is on, the
 * viewer is the OWNER, the operation is eligible, the adapter supports it and
 * there is no unresolved conflicting operation (§8). ADD_NOTE needs none of the
 * mutation gates but is still OWNER-scoped here for a single, simple surface.
 */
export function adminServiceDetailKeyboard(
  sid: string,
  opts: AdminServiceDetailKeyboardOptions,
): InlineKeyboard {
  const kb = new InlineKeyboard().text("بروزرسانی 🔄", ASO_CB.refresh(sid)).row();
  const canMutate = opts.isOwner && opts.mutationsEnabled && !opts.hasConflict;
  const has = (t: AdminServiceMutationType): boolean => opts.eligible.includes(t);
  if (canMutate) {
    const row: Array<{ text: string; cb: string }> = [];
    if (has("ENABLE")) row.push({ text: OP_TYPE_LABEL.ENABLE, cb: ASO_CB.toggle(sid, true) });
    if (has("DISABLE")) row.push({ text: OP_TYPE_LABEL.DISABLE, cb: ASO_CB.toggle(sid, false) });
    for (const b of row) {
      kb.text(b.text, b.cb);
    }
    if (row.length > 0) {
      kb.row();
    }
    if (has("ADD_VOLUME")) {
      kb.text(OP_TYPE_LABEL.ADD_VOLUME, ASO_CB.volMenu(sid));
    }
    if (has("ADD_TIME")) {
      kb.text(OP_TYPE_LABEL.ADD_TIME, ASO_CB.timeMenu(sid));
    }
    if (has("ADD_VOLUME") || has("ADD_TIME")) {
      kb.row();
    }
    if (has("REGENERATE_LINK")) {
      kb.text(OP_TYPE_LABEL.REGENERATE_LINK, ASO_CB.regenAsk(sid)).row();
    }
  }
  // Internal note — OWNER only, but independent of the mutation switch (§17).
  if (opts.isOwner) {
    kb.text("افزودن یادداشت 📝", ASO_CB.note(sid)).row();
  }
  kb.text("تاریخچه عملیات 📜", ASO_CB.hist(sid, 1)).row();
  kb.text("بازگشت به کاربر", `admin:users:svc:${opts.ownerSid}:1`);
  return kb;
}

/** The volume preset menu (§13). */
export function adminVolumeMenu(sid: string): { text: string; keyboard: InlineKeyboard } {
  const kb = new InlineKeyboard();
  for (const gib of ADMIN_SERVICE_VOLUME_PRESETS_GIB) {
    kb.text(`${gib} گیگ`, ASO_CB.volPreset(sid, gib));
  }
  kb.row().text("مقدار دلخواه ✍️", ASO_CB.volCustom(sid)).row().text("انصراف", ASO_CB.view(sid));
  return { text: "چه مقدار حجم به این سرویس اضافه شود؟", keyboard: kb };
}

/** The time preset menu (§15). */
export function adminTimeMenu(sid: string): { text: string; keyboard: InlineKeyboard } {
  const kb = new InlineKeyboard();
  for (const days of ADMIN_SERVICE_TIME_PRESETS_DAYS) {
    kb.text(`${days} روز`, ASO_CB.timePreset(sid, days));
  }
  kb.row().text("مقدار دلخواه ✍️", ASO_CB.timeCustom(sid)).row().text("انصراف", ASO_CB.view(sid));
  return { text: "چند روز به این سرویس اضافه شود؟", keyboard: kb };
}

/** The regeneration first-confirm (double-confirm step 1, §16). */
export function adminRegenAskText(service: Service): string {
  return [
    "تغییر لینک اشتراک 🔄",
    "",
    `نام کاربری: <code>${escapeHtml(service.username)}</code>`,
    "",
    "با این کار لینک اشتراک فعلی کاربر باطل می‌شود و لینک تازه ساخته می‌شود.",
    "آیا ادامه می‌دهید؟",
  ].join("\n");
}

export function adminRegenAskKeyboard(sid: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("بله، ادامه بده", ASO_CB.regenGo(sid))
    .row()
    .text("انصراف", ASO_CB.view(sid));
}

/** The final preview shown after the reason is entered (§20). */
export function adminOperationPreviewText(
  type: AdminServiceMutationType,
  service: Service,
  requestedCount: number | null,
  reason: string,
): string {
  const label = OP_TYPE_LABEL[type];
  const lines = [`تایید عملیات — ${label}`, "", `نام کاربری: <code>${escapeHtml(service.username)}</code>`];
  if (type === "ADD_VOLUME") {
    lines.push(`حجم افزوده: ${requestedCount} گیگابایت`, `حجم فعلی: ${formatBytes(service.volumeBytes)}`);
  } else if (type === "ADD_TIME") {
    lines.push(`زمان افزوده: ${requestedCount} روز`, `انقضای فعلی: ${formatDate(service.expiresAt)}`);
  } else if (type === "ENABLE") {
    lines.push("سرویس فعال خواهد شد.");
  } else if (type === "DISABLE") {
    lines.push("سرویس غیرفعال خواهد شد.");
  } else {
    lines.push("لینک اشتراک تازه ساخته می‌شود و لینک قبلی باطل خواهد شد.");
  }
  lines.push("", `دلیل: ${escapeHtml(reason)}`, "", "آیا این عملیات انجام شود؟");
  return lines.join("\n");
}

export function adminOperationConfirmKeyboard(sid: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("تایید و اجرا ✅", ASO_CB.confirm)
    .row()
    .text("انصراف", ASO_CB.cancel(sid));
}

/** Operation history page (§19). */
export function adminHistoryText(service: Service, ops: AdminServiceOperation[], total: number): string {
  const lines = [`تاریخچه عملیات سرویس 📜 (${total})`, `نام کاربری: <code>${escapeHtml(service.username)}</code>`, ""];
  if (ops.length === 0) {
    lines.push("عملیاتی ثبت نشده است.");
  } else {
    for (const op of ops) {
      lines.push(opLine(op));
    }
  }
  return lines.join("\n");
}

export function adminHistoryKeyboard(
  sid: string,
  page: number,
  pages: number,
  ops: AdminServiceOperation[],
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const op of ops) {
    kb.text(
      `${OP_TYPE_LABEL[op.type as AdminServiceOperationType] ?? op.type} · ${OP_STATUS_LABEL[op.status as AdminServiceOperationStatus] ?? op.status}`,
      ASO_CB.op(adminServiceShortId(op.id)),
    ).row();
  }
  if (pages > 1) {
    if (page > 1) {
      kb.text("« قبلی", ASO_CB.hist(sid, page - 1));
    }
    kb.text(`${page}/${pages}`, ASO_CB.hist(sid, page));
    if (page < pages) {
      kb.text("بعدی »", ASO_CB.hist(sid, page + 1));
    }
    kb.row();
  }
  return kb.text("بازگشت به سرویس", ASO_CB.view(sid));
}

/** Single operation detail (safe — no snapshots' secrets, snapshots have none). */
export function adminOperationDetailText(op: AdminServiceOperation): string {
  const label = OP_TYPE_LABEL[op.type as AdminServiceOperationType] ?? op.type;
  const status = OP_STATUS_LABEL[op.status as AdminServiceOperationStatus] ?? op.status;
  const lines = [
    `عملیات — ${label}`,
    "",
    `وضعیت: ${status}`,
    `زمان ثبت: ${op.createdAt.toISOString().slice(0, 16).replace("T", " ")} (UTC)`,
  ];
  if (op.requestedValue !== null && op.requestedUnit !== null) {
    const unit = op.requestedUnit === "GIB" ? "گیگابایت" : "روز";
    lines.push(`مقدار درخواستی: ${op.requestedValue.toString()} ${unit}`);
  }
  if (op.reason !== null && op.reason !== "") {
    lines.push(`دلیل/یادداشت: ${escapeHtml(op.reason)}`);
  }
  if (op.safeErrorCode !== null) {
    lines.push(`کد نتیجه: ${escapeHtml(op.safeErrorCode)}`);
  }
  if (op.completedAt !== null) {
    lines.push(`زمان اتمام: ${op.completedAt.toISOString().slice(0, 16).replace("T", " ")} (UTC)`);
  }
  if (op.reconciledAt !== null) {
    lines.push(`زمان بررسی: ${op.reconciledAt.toISOString().slice(0, 16).replace("T", " ")} (UTC)`);
  }
  return lines.join("\n");
}

// --- OWNER reconciliation dashboard (§18) ------------------------------------

export function adminReconDashboardText(ops: AdminServiceOperation[], total: number): string {
  const lines = ["عملیات سرویس نیازمند بررسی ⚠️", `تعداد کل: ${total}`, ""];
  if (ops.length === 0) {
    lines.push("موردی برای بررسی وجود ندارد ✅");
  } else {
    for (const op of ops) {
      lines.push(opLine(op));
    }
  }
  return lines.join("\n");
}

export function adminReconDashboardKeyboard(
  page: number,
  pages: number,
  ops: AdminServiceOperation[],
): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const op of ops) {
    kb.text(
      `${OP_TYPE_LABEL[op.type as AdminServiceOperationType] ?? op.type} · بررسی`,
      ASO_CB.reconRun(adminServiceShortId(op.id)),
    ).row();
  }
  if (pages > 1) {
    if (page > 1) {
      kb.text("« قبلی", ASO_CB.recon(page - 1));
    }
    kb.text(`${page}/${pages}`, ASO_CB.recon(page));
    if (page < pages) {
      kb.text("بعدی »", ASO_CB.recon(page + 1));
    }
    kb.row();
  }
  return kb.text("بازگشت به تنظیمات", ASO_CB.settings);
}

// --- OWNER settings (the mutation master switch, §3) -------------------------

export function adminServiceSettingsText(mutationsEnabled: boolean, reconcileCount: number): string {
  return [
    "عملیات سرویس (ادمین) ⚙️",
    "",
    `وضعیت مجوز عملیات: ${mutationsEnabled ? "فعال ✅" : "غیرفعال ⛔"}`,
    "",
    "با فعال بودن این گزینه، مالک ربات می‌تواند از صفحه هر سرویس عملیات فعال/غیرفعال، افزودن حجم/زمان و تغییر لینک را انجام دهد.",
    "صفحه سرویس و بروزرسانی لحظه‌ای مستقل از این گزینه همیشه در دسترس است.",
    "",
    `عملیات نیازمند بررسی: ${reconcileCount} ⚠️`,
  ].join("\n");
}

export function adminServiceSettingsKeyboard(mutationsEnabled: boolean): InlineKeyboard {
  return new InlineKeyboard()
    .text(mutationsEnabled ? "غیرفعال کردن عملیات ⛔" : "فعال کردن عملیات ✅", ASO_CB.settingsToggle)
    .row()
    .text("عملیات نیازمند بررسی ⚠️", ASO_CB.recon(1))
    .row()
    .text("بازگشت به تنظیمات عمومی", CB.ADMIN_GENERAL_SETTINGS);
}
