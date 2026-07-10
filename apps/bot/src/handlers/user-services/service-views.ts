import type { Service, ServiceLocation, ServiceStatus } from "@zedbot/database";
import { InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { ToggleAction } from "../../services/service-toggle.service.js";
import {
  serviceShortId,
  type ServiceDetailActions,
  type ServiceListPage,
} from "../../services/user-services.service.js";
import { escapeHtml } from "../../utils/html.js";
import { etcb } from "../user-extra-time/extra-time-views.js";
import { evcb } from "../user-extra-volume/extra-volume-views.js";

// =============================================================================
// "My Services" rendering (Phase 10) - read-only views over stored Service
// rows. No panel data, no actions beyond opening stored links. Phase 18
// added the enable/disable toggle button + confirmation keyboard; Phase 18.1
// moved «خرید حجم اضافه ➕»/«خرید زمان اضافه ⏳» here from the main menu
// (they route straight into the existing Phase 16/17 selected-service flows).
// =============================================================================

export const svcCb = {
  list: (page: number): string => `user:svc:list:${page}`,
  view: (sid: string): string => `user:svc:view:${sid}`,
  refresh: (sid: string): string => `user:svc:refresh:${sid}`,
  link: (sid: string): string => `user:svc:link:${sid}`,
  configs: (sid: string): string => `user:svc:configs:${sid}`,
  disable: (sid: string): string => `user:svc:disable:${sid}`,
  disableYes: (sid: string): string => `user:svc:disable:${sid}:yes`,
  enable: (sid: string): string => `user:svc:enable:${sid}`,
  enableYes: (sid: string): string => `user:svc:enable:${sid}:yes`,
} as const;

const STATUS_LABELS: Record<ServiceStatus, string> = {
  ACTIVE: "فعال ✅",
  DISABLED: "غیرفعال ⏸",
  EXPIRED: "منقضی ⌛",
  LIMITED: "اتمام حجم 📦",
  FAILED: "ناموفق ❌",
  CREATING: "در حال ساخت ⏳",
  DELETED: "حذف‌شده 🗑",
};

export function statusLabel(status: ServiceStatus): string {
  return STATUS_LABELS[status] ?? status;
}

const LOCATION_LABELS: Record<ServiceLocation, string> = {
  MULTI_LOCATION: "چند لوکیشن",
  DEDICATED_LOCATION: "لوکیشن اختصاصی",
  TEST: "تست",
};

function locationLabel(location: ServiceLocation): string {
  return LOCATION_LABELS[location] ?? location;
}

function statusEmoji(status: ServiceStatus): string {
  const label = statusLabel(status);
  return label.split(" ").pop() ?? "•";
}

const GIB = 1024n * 1024n * 1024n;

/** Bytes -> GB with at most 2 decimals ("12.5GB"-style number part). */
export function formatGb(bytes: bigint): string {
  const gb = Number(bytes) / Number(GIB);
  const rounded = Math.round(gb * 100) / 100;
  return `${rounded}`;
}

/** Days left until expiry; null = unlimited, 0 = already expired. */
export function remainingDays(expiresAt: Date | null): number | null {
  if (expiresAt === null) {
    return null;
  }
  const ms = expiresAt.getTime() - Date.now();
  return ms <= 0 ? 0 : Math.ceil(ms / 86_400_000);
}

function formatDate(date: Date | null): string {
  return date === null ? "-" : `${date.toISOString().replace("T", " ").slice(0, 16)} (UTC)`;
}

/** Strings-only view of the stored configLinks Json (malformed data ignored). */
export function serviceConfigLinks(service: Service): string[] {
  if (!Array.isArray(service.configLinks)) {
    return [];
  }
  return service.configLinks.filter((l): l is string => typeof l === "string" && l !== "");
}

function listButtonLabel(service: Service): string {
  const name = service.productNameSnapshot ?? service.username;
  const days = remainingDays(service.expiresAt);
  const time = days === null ? "نامحدود" : `${days} روز`;
  const volume = service.volumeBytes === 0n ? "نامحدود" : `${formatGb(service.remainingBytes)}GB`;
  return `${statusEmoji(service.status)} ${name} | ${time} | ${volume}`;
}

export function serviceListKeyboard(pageData: ServiceListPage): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const service of pageData.services) {
    kb.text(listButtonLabel(service), svcCb.view(serviceShortId(service))).row();
  }
  if (pageData.pages > 1) {
    if (pageData.page > 1) {
      kb.text("« قبلی", svcCb.list(pageData.page - 1));
    }
    kb.text(`${pageData.page}/${pageData.pages}`, svcCb.list(pageData.page));
    if (pageData.page < pageData.pages) {
      kb.text("بعدی »", svcCb.list(pageData.page + 1));
    }
    kb.row();
  }
  kb.text("بازگشت به منو", CB.USER_MENU);
  return kb;
}

/** Detail text - stored DB values only (never note/failureReason/panel data). */
export function serviceDetailText(service: Service): string {
  const days = remainingDays(service.expiresAt);
  const unlimitedVolume = service.volumeBytes === 0n;
  const lines = [
    `🛍 <b>${escapeHtml(service.productNameSnapshot ?? service.username)}</b>`,
    "",
    `وضعیت: ${statusLabel(service.status)}`,
    `نام کاربری: <code>${escapeHtml(service.username)}</code>`,
    `پنل: ${escapeHtml(service.panelNameSnapshot ?? "-")}`,
    `موقعیت: ${escapeHtml(locationLabel(service.serviceLocation))}`,
    "",
    `حجم کل: ${unlimitedVolume ? "نامحدود" : `${formatGb(service.volumeBytes)} گیگابایت`}`,
    `مصرف‌شده: ${formatGb(service.usedBytes)} گیگابایت`,
    `باقی‌مانده: ${unlimitedVolume ? "نامحدود" : `${formatGb(service.remainingBytes)} گیگابایت`}`,
    "",
    `مدت: ${service.durationDays > 0 ? `${service.durationDays} روز` : "نامحدود"}`,
    `شروع: ${formatDate(service.startsAt)}`,
    `انقضا: ${service.expiresAt === null ? "نامحدود" : formatDate(service.expiresAt)}`,
    `روز باقی‌مانده: ${days === null ? "نامحدود" : `${days} روز`}`,
  ];
  if (service.lastConnectedAt !== null) {
    lines.push(`آخرین اتصال: ${formatDate(service.lastConnectedAt)}`);
  }
  lines.push(`تاریخ ساخت: ${formatDate(service.createdAt)}`);
  if (service.lastSubscriptionUpdateAt !== null) {
    lines.push(`آخرین بروزرسانی: ${formatDate(service.lastSubscriptionUpdateAt)}`);
  }
  return lines.join("\n");
}

const NO_DETAIL_ACTIONS: ServiceDetailActions = {
  toggleAction: null,
  canBuyExtraVolume: false,
  canBuyExtraTime: false,
};

export function serviceDetailKeyboard(
  service: Service,
  actions: ServiceDetailActions = NO_DETAIL_ACTIONS,
): InlineKeyboard {
  const sid = serviceShortId(service);
  const kb = new InlineKeyboard().text("بروزرسانی اطلاعات ♻️", svcCb.refresh(sid)).row();
  const hasLink = service.subscriptionUrl !== null && service.subscriptionUrl !== "";
  const hasConfigs = serviceConfigLinks(service).length > 0;
  if (hasLink) {
    kb.text("لینک اشتراک 🔗", svcCb.link(sid));
  }
  if (hasConfigs) {
    kb.text("کانفیگ‌ها 📄", svcCb.configs(sid));
  }
  if (hasLink || hasConfigs) {
    kb.row();
  }
  // Phase 18.1: straight into the existing Phase 16/17 selected-service
  // flows - those routes re-validate eligibility on click.
  if (actions.canBuyExtraVolume) {
    kb.text("خرید حجم اضافه ➕", evcb.service(sid));
  }
  if (actions.canBuyExtraTime) {
    kb.text("خرید زمان اضافه ⏳", etcb.service(sid));
  }
  if (actions.canBuyExtraVolume || actions.canBuyExtraTime) {
    kb.row();
  }
  // Phase 18: shown ONLY when the service/panel state actually allows it.
  if (actions.toggleAction === "DISABLE") {
    kb.text("خاموش کردن سرویس ⏸", svcCb.disable(sid)).row();
  } else if (actions.toggleAction === "ENABLE") {
    kb.text("روشن کردن سرویس ▶️", svcCb.enable(sid)).row();
  }
  kb.text("بازگشت به لیست", svcCb.list(1)).row().text("بازگشت به منو", CB.USER_MENU);
  return kb;
}

/** Phase 18 confirmation keyboard - the panel is only called after «yes». */
export function toggleConfirmKeyboard(sid: string, action: ToggleAction): InlineKeyboard {
  const confirm =
    action === "DISABLE"
      ? { label: "بله، خاموش کن ⏸", cb: svcCb.disableYes(sid) }
      : { label: "بله، روشن کن ▶️", cb: svcCb.enableYes(sid) };
  return new InlineKeyboard()
    .text(confirm.label, confirm.cb)
    .row()
    .text("انصراف", svcCb.view(sid));
}
