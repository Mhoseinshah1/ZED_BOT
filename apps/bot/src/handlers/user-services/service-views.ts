import type { Service, ServiceLocation, ServiceStatus } from "@zedbot/database";
import { InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import {
  serviceSupportsGlobalLifecycle,
  XUI_LEGACY_SERVICE_TEXT,
} from "../../services/panel-readiness.service.js";
import type { ToggleAction } from "../../services/service-toggle.service.js";
import {
  serviceShortId,
  type ServiceDetailActions,
  type ServiceListPage,
} from "../../services/user-services.service.js";
import { escapeHtml } from "../../utils/html.js";
import { etcb } from "../user-extra-time/extra-time-views.js";
import { evcb } from "../user-extra-volume/extra-volume-views.js";
import { rncb } from "../user-renewal/renewal-views.js";

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
  qrSub: (sid: string): string => `user:svc:qr_sub:${sid}`,
  qrConfigs: (sid: string): string => `user:svc:qr_configs:${sid}`,
  disable: (sid: string): string => `user:svc:disable:${sid}`,
  disableYes: (sid: string): string => `user:svc:disable:${sid}:yes`,
  enable: (sid: string): string => `user:svc:enable:${sid}`,
  enableYes: (sid: string): string => `user:svc:enable:${sid}:yes`,
  regenLink: (sid: string): string => `user:svc:regen_link:${sid}`,
  regenLinkYes: (sid: string): string => `user:svc:regen_link:${sid}:yes`,
  // Device connection guides (feat/device-connection-guides). Progressive routes,
  // all emitting the single prefix `user:svc:guide:` (the nav-integrity scan stops
  // at the first `${`). `p` is a compact platform code, `slug` a bounded app slug.
  guide: (sid: string): string => `user:svc:guide:${sid}`,
  guidePlatform: (sid: string, p: string): string => `user:svc:guide:${sid}:${p}`,
  guideApp: (sid: string, p: string, slug: string): string => `user:svc:guide:${sid}:${p}:${slug}`,
  guideSupport: (sid: string, p: string, slug: string): string =>
    `user:svc:gsup:${sid}:${p}:${slug}`,
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

/** Safe fallback when no account identity is stored (defensive - `username` is required). */
export const UNNAMED_SERVICE_TEXT = "سرویس بدون نام";

/**
 * The customer's VPN ACCOUNT identity (account-display phase) - what the
 * panel actually created, resolved in priority order:
 *
 *   1. Service.username - the stored remote identity for BOTH panels (the
 *      Marzban username / the XUI global-client email; the naming-phase
 *      snapshot's resolvedRemoteUsername is persisted here). The schema has
 *      no separate remoteUsername/panelUsername columns - this IS that field.
 *   2. XUI stored client identity from the sync-refreshed remoteMetadata
 *      (client email) when the username is somehow empty.
 *   3. «سرویس بدون نام».
 *
 * NEVER the product name, category, volume/duration specs, or any secret
 * (remoteClientId - the XUI UUID/Trojan password - is deliberately excluded).
 */
export function serviceAccountLabel(service: Service): string {
  const username = service.username.trim();
  if (username !== "") {
    return username;
  }
  const metadata = service.remoteMetadata as {
    email?: unknown;
    clients?: Array<{ email?: unknown }>;
  } | null;
  const storedEmail =
    typeof metadata?.email === "string" && metadata.email !== ""
      ? metadata.email
      : Array.isArray(metadata?.clients) &&
          typeof metadata.clients[0]?.email === "string" &&
          metadata.clients[0].email !== ""
        ? metadata.clients[0].email
        : null;
  return storedEmail ?? UNNAMED_SERVICE_TEXT;
}

/**
 * Account-display phase: the list shows the ACCOUNT username + status - the
 * identity the panel created - never product names or volume/duration specs.
 */
function listButtonLabel(service: Service): string {
  return `${serviceAccountLabel(service)} ${statusEmoji(service.status)}`;
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
  // Notification-engine phase: user notification settings live UNDER My Services
  // (not a top-level menu button). Callback owned by user-notifications/
  // notification.handler.ts - a literal here avoids a keyboard<->handler import
  // cycle (the handler imports the detail renderer from services.handler.ts).
  kb.text("تنظیمات اعلان‌ها 🔔", "user:nset:root").row();
  kb.text("بازگشت به منو", CB.USER_MENU);
  return kb;
}

/**
 * Detail text - the Service row's values only (never note/failureReason/raw
 * panel data). With the live-sync phase the row is refreshed from the panel
 * BEFORE rendering; staleNotice carries the safe Persian fallback line when
 * that refresh could not deliver live data (stored values stay on screen).
 */
export function serviceDetailText(service: Service, staleNotice: string | null = null): string {
  const days = remainingDays(service.expiresAt);
  const unlimitedVolume = service.volumeBytes === 0n;
  // Account-display phase: the header IS the account identity - the username
  // created on the panel - never the product name. Specs follow as fields.
  const lines = [
    `نام سرویس: <code>${escapeHtml(serviceAccountLabel(service))}</code>`,
    "",
  ];
  // Trial-lifecycle phase: the ORIGIN stays visible forever. Before the
  // first verified paid operation the service is a free trial; after
  // conversion the label switches but never disappears - `source` is
  // immutable and only convertedToPaidAt distinguishes the two.
  if (service.source === "FREE_TRIAL") {
    lines.push(
      service.convertedToPaidAt === null
        ? "نوع سرویس:\nاکانت تست رایگان"
        : "نوع سرویس:\nشروع‌شده با اکانت تست",
    );
  }
  if (service.productNameSnapshot !== null) {
    lines.push(`نام محصول: ${escapeHtml(service.productNameSnapshot)}`);
  }
  lines.push(
    `وضعیت: ${statusLabel(service.status)}`,
    `لوکیشن / پنل: ${escapeHtml(locationLabel(service.serviceLocation))} — ${escapeHtml(service.panelNameSnapshot ?? "-")}`,
    "",
    `ترافیک کل: ${unlimitedVolume ? "نامحدود" : `${formatGb(service.volumeBytes)} گیگابایت`}`,
    `ترافیک مصرف‌شده: ${formatGb(service.usedBytes)} گیگابایت`,
    `ترافیک باقی‌مانده: ${unlimitedVolume ? "نامحدود" : `${formatGb(service.remainingBytes)} گیگابایت`}`,
    "",
    `مدت: ${service.durationDays > 0 ? `${service.durationDays} روز` : "نامحدود"}`,
    `شروع: ${formatDate(service.startsAt)}`,
    `تاریخ اتمام: ${service.expiresAt === null ? "نامحدود" : formatDate(service.expiresAt)}`,
    `روزهای باقی‌مانده: ${days === null ? "نامحدود" : `${days} روز`}`,
  );
  if (service.lastConnectedAt !== null) {
    lines.push(`آخرین اتصال: ${formatDate(service.lastConnectedAt)}`);
  }
  lines.push(`تاریخ ساخت: ${formatDate(service.createdAt)}`);
  if (service.lastSubscriptionUpdateAt !== null) {
    lines.push(`آخرین بروزرسانی: ${formatDate(service.lastSubscriptionUpdateAt)}`);
  }
  if (!serviceSupportsGlobalLifecycle(service)) {
    // Legacy per-inbound XUI service: says WHY the mutating buttons are
    // hidden (renew/extras/toggle/regenerate need the global-client model).
    lines.push("", XUI_LEGACY_SERVICE_TEXT);
  }
  if (staleNotice !== null && staleNotice !== "") {
    lines.push("", `⚠️ ${escapeHtml(staleNotice)}`);
  }
  return lines.join("\n");
}

const NO_DETAIL_ACTIONS: ServiceDetailActions = {
  toggleAction: null,
  canBuyExtraVolume: false,
  canBuyExtraTime: false,
  canRegenerateLink: false,
  canRenew: false,
};

/**
 * Master-requirements arrangement (Section 8): fixed row slots with every
 * unimplemented capability HIDDEN instead of rendered dead - note editing and
 * service transfer are outside this phase, so their slots collapse. The
 * connection-tutorial slot IS implemented (feat/device-connection-guides): the
 * «آموزش اتصال 📱» entry renders when `guide` is non-null (the async gate passed).
 * The QR-code slots ARE implemented (service-config-qrcode phase):
 * a «QR اشتراک 📷» / «QR کانفیگ‌ها 📷» button renders next to each text link,
 * but only when its stored payload exists. Action buttons render only when the
 * capability model + remote-model classification allow them (the routes
 * re-validate on click, so a stale button still fails safely).
 */
export function serviceDetailKeyboard(
  service: Service,
  actions: ServiceDetailActions = NO_DETAIL_ACTIONS,
  guide: { label: string } | null = null,
): InlineKeyboard {
  const sid = serviceShortId(service);
  // Row 1: refresh.
  const kb = new InlineKeyboard().text("بروزرسانی اطلاعات ♻️", svcCb.refresh(sid)).row();
  // Row 2: subscription link + its QR (only when the payload is actually stored).
  // The QR button is ADDITIVE - the copyable text link button always stays.
  const hasLink = service.subscriptionUrl !== null && service.subscriptionUrl !== "";
  const hasConfigs = serviceConfigLinks(service).length > 0;
  if (hasLink) {
    kb.text("لینک اشتراک 🔗", svcCb.link(sid)).text("QR اشتراک 📷", svcCb.qrSub(sid)).row();
  }
  // Row 3: configs + their QR (only when at least one config is stored).
  if (hasConfigs) {
    kb.text("کانفیگ‌ها 📄", svcCb.configs(sid)).text("QR کانفیگ‌ها 📷", svcCb.qrConfigs(sid)).row();
  }
  // Row 4: link regeneration (QR Code slot now implemented above).
  if (actions.canRegenerateLink) {
    kb.text("تغییر لینک 🔄", svcCb.regenLink(sid)).row();
  }
  // Row 4b: device connection guide (feat/device-connection-guides). Rendered
  // AFTER the link/config/QR rows and BEFORE the financial actions, ONLY when the
  // async entry gate passed (master switch on + >=1 active app + usable payload);
  // `guide` is null otherwise. The route re-validates everything on click.
  if (guide !== null) {
    kb.text(guide.label, svcCb.guide(sid)).row();
  }
  // Row 5: renewal + extra volume - both routes re-validate on click.
  if (actions.canRenew) {
    kb.text("تمدید سرویس ♻️", rncb.service(sid));
  }
  if (actions.canBuyExtraVolume) {
    kb.text("خرید حجم اضافه ➕", evcb.service(sid));
  }
  if (actions.canBuyExtraVolume || actions.canRenew) {
    kb.row();
  }
  // Row 5: extra time (note-editing slot hidden - not implemented).
  if (actions.canBuyExtraTime) {
    kb.text("خرید زمان اضافه ⏳", etcb.service(sid)).row();
  }
  // Row 5b: wallet auto-renewal (Phase 1). Offered for finite-expiry services
  // that qualify for manual renewal; the route re-validates on click and shows
  // the intro/consent or the existing mandate's status. Literal callback here
  // (same import-cycle reason as the notification buttons above).
  if (actions.canRenew && service.expiresAt !== null) {
    kb.text("تمدید خودکار 🔁", `user:arn:svc:${sid}`).row();
    // Stars monthly subscription (Phase 2). Same finite-expiry renewal gate; the
    // route re-validates operational state + subscription-enabled 30-day plans on
    // click and shows the intro/status. Literal callback (import-cycle reason).
    kb.text("اشتراک ماهانه Stars ⭐", `user:sub:svc:${sid}`).row();
  }
  // Row 6: enable/disable, labeled by the direction that currently applies
  // (transfer slot hidden - not implemented).
  if (actions.toggleAction === "DISABLE") {
    kb.text("خاموش کردن سرویس ⏸", svcCb.disable(sid)).row();
  } else if (actions.toggleAction === "ENABLE") {
    kb.text("روشن کردن سرویس ▶️", svcCb.enable(sid)).row();
  }
  // Row 7a: per-service notification settings (notification-engine phase).
  // Callback owned by user-notifications/notification.handler.ts; literal here
  // for the same import-cycle reason as the list keyboard above.
  kb.text("اعلان‌های این سرویس 🔔", `user:nsvc:${sid}`).row();
  // Row 7: support entry - routes into the existing ticket flow.
  kb.text("مشکل دارم", CB.USER_SUPPORT).row();
  // Row 8: back navigation (doc right/left order).
  kb.text("بازگشت به لیست", svcCb.list(1)).text("بازگشت به منوی اصلی", CB.USER_MENU);
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

/** Phase 19 confirmation keyboard - the panel is only called after «yes». */
export function regenLinkConfirmKeyboard(sid: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("تایید تغییر لینک ✅", svcCb.regenLinkYes(sid))
    .row()
    .text("انصراف", svcCb.view(sid));
}
