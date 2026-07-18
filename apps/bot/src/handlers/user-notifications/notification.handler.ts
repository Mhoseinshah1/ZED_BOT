import {
  NotificationInteractionType,
  type ServiceNotificationPreference,
} from "@zedbot/database";
import {
  ALLOWED_TIMEZONES,
  type ServiceKindOverrides,
  type ServiceNotificationKind,
} from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import {
  getOwnedNotificationByShortId,
  recordNotificationInteraction,
} from "../../services/notification/notification.service.js";
import {
  getOrCreateNotificationPreference,
  getServiceNotificationPreference,
  isServiceKindEnabled,
  resolveEffectiveDeliveryPreferences,
  setServiceNotificationKind,
  setUserDailyLimit,
  setUserQuietHoursEnabled,
  setUserTimezone,
  toggleUserCategory,
  USER_DAILY_LIMIT_MAX,
  USER_DAILY_LIMIT_MIN,
} from "../../services/notification/notification-preference.service.js";
import {
  getOwnedServiceById,
  getOwnedServiceByShortId,
  resolveServiceDetailActions,
  serviceShortId,
} from "../../services/user-services.service.js";
import { safeAnswerCallback, safeEditOrReply } from "../../utils/safe-reply.js";
import { renderExtraVolumeServicePage } from "../user-extra-volume/extra-volume.handler.js";
import { renderRenewalServicePage } from "../user-renewal/renewal.handler.js";
import { serviceAccountLabel, svcCb } from "../user-services/service-views.js";
import { renderServiceDetail } from "../user-services/services.handler.js";

// =============================================================================
// Notification-engine BOT UI (feat/notification-retention-engine, Phase 1) -
// the user-facing surfaces the delivery worker's notifications route into:
//
//   1. `ntf:<shortId>:<action>` - the notification button callbacks. The row
//      is resolved OWNER-scoped from the short id; the click is recorded once;
//      routing ALWAYS re-loads live state and lands on a real page (never a
//      dead button, never the snapshot).
//   2. `user:nset:*` - the per-USER notification settings page (entered from
//      «سرویس‌های من»), toggling the two category switches + quiet-hours and
//      cycling timezone / daily-limit.
//   3. `user:nsvc:*` - the per-SERVICE override page (entered from a service
//      detail), a three-state (inherit/on/off) override per notification kind.
//
// No secret ever appears here: callbacks carry only short ids + stable codes,
// and every page renders through the shared safe reply helpers.
// =============================================================================

export const userNotificationsHandler = new Composer<BotContext>();

const NTF_INVALID_TEXT = "این اعلان دیگر معتبر نیست.";
const SERVICE_GONE_TEXT = "سرویس یافت نشد";
const RENEW_UNAVAILABLE_NOTICE = "تمدید این سرویس در حال حاضر امکان‌پذیر نیست.";
const VOLUME_UNAVAILABLE_NOTICE = "خرید حجم اضافه برای این سرویس در حال حاضر امکان‌پذیر نیست.";
const DISMISS_TEXT = "بسته شد ✖️";

// =============================================================================
// 1. Notification action callbacks: ntf:<shortId>:<action>
// =============================================================================

/**
 * Action code -> recorded interaction. Only the four Phase-1 actions record;
 * c (continue-checkout) / p (view-products) have no Phase-1 flow of their own,
 * so they record nothing and fall through to opening the service (a safe,
 * always-real landing).
 */
const ACTION_INTERACTION: Record<string, NotificationInteractionType | undefined> = {
  s: NotificationInteractionType.OPEN_SERVICE,
  r: NotificationInteractionType.RENEW_SERVICE,
  v: NotificationInteractionType.BUY_EXTRA_VOLUME,
  x: NotificationInteractionType.DISMISS,
};

userNotificationsHandler.callbackQuery(/^ntf:([0-9a-f]{4,12}):([srvcpx])$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const shortId = ctx.match[1];
  const action = ctx.match[2];

  // OWNER-scoped resolve: a foreign/expired/absent notification is
  // indistinguishable - the same safe answer, never revealing existence.
  const notification = await getOwnedNotificationByShortId(shortId, user.id);
  if (notification === null) {
    await safeAnswerCallback(ctx, NTF_INVALID_TEXT);
    return;
  }

  // Record the click exactly once per (notification, type) - idempotent.
  const interaction = ACTION_INTERACTION[action];
  if (interaction !== undefined) {
    await recordNotificationInteraction(notification.id, user.id, interaction);
  }

  if (action === "x") {
    // Dismiss: drop the inline keyboard, keep the message text.
    try {
      await ctx.editMessageReplyMarkup();
    } catch {
      // Message deleted / not modifiable - the toast is still the real result.
    }
    await safeAnswerCallback(ctx, DISMISS_TEXT);
    return;
  }

  // Every remaining action needs the LIVE service, owner-scoped (never the
  // snapshot). The notification carries the FULL serviceId.
  const service =
    notification.serviceId === null
      ? null
      : await getOwnedServiceById(notification.serviceId, user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, SERVICE_GONE_TEXT);
    return;
  }

  if (action === "r") {
    // Re-validate renewal eligibility LIVE; never a dead button.
    const actions = await resolveServiceDetailActions(service);
    if (actions.canRenew) {
      await renderRenewalServicePage(ctx, serviceShortId(service));
      return;
    }
    await safeAnswerCallback(ctx);
    await renderServiceDetail(ctx, service, RENEW_UNAVAILABLE_NOTICE);
    return;
  }

  if (action === "v") {
    const actions = await resolveServiceDetailActions(service);
    if (actions.canBuyExtraVolume) {
      await renderExtraVolumeServicePage(ctx, serviceShortId(service));
      return;
    }
    await safeAnswerCallback(ctx);
    await renderServiceDetail(ctx, service, VOLUME_UNAVAILABLE_NOTICE);
    return;
  }

  // s / c / p -> open the service detail page.
  await safeAnswerCallback(ctx);
  await renderServiceDetail(ctx, service);
});

// =============================================================================
// 2. User notification settings page: user:nset:*
// =============================================================================

const NSET_CB = {
  root: "user:nset:root",
  toggle: (field: "cron" | "svc" | "quiet"): string => `user:nset:toggle:${field}`,
  tz: "user:nset:tz",
  limit: "user:nset:limit",
} as const;

function onOff(on: boolean): string {
  return on ? "فعال ✅" : "غیرفعال ❌";
}

/** minutes-since-midnight -> HH:MM (24h). */
function formatMinutes(total: number): string {
  const hours = Math.floor(total / 60) % 24;
  const minutes = total % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

async function renderUserNotificationSettings(ctx: BotContext): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const [pref, effective] = await Promise.all([
    getOrCreateNotificationPreference(user.id),
    resolveEffectiveDeliveryPreferences(user.id),
  ]);
  const lines = [
    "🔔 تنظیمات اعلان‌ها",
    "",
    "مشخص کنید کدام یادآوری‌های خودکار را دریافت کنید. این تنظیمات فقط روی اعلان‌های خودکار اثر دارد.",
    "",
    `اعلان‌های خودکار: ${onOff(user.cronNotificationsEnabled)}`,
    `اعلان سرویس‌ها: ${onOff(user.serviceNotificationsEnabled)}`,
    `ساعات سکوت: ${onOff(pref.quietHoursEnabled)}`,
    "",
    `منطقه زمانی: ${effective.timezone}`,
    `سقف روزانه اعلان: ${effective.dailyLimit}`,
  ];
  lines.push(
    "",
    effective.quietHours.enabled
      ? `پنجره سکوت مؤثر: از ${formatMinutes(effective.quietHours.startMinutes)} تا ${formatMinutes(effective.quietHours.endMinutes)} (${effective.timezone})`
      : "پنجره سکوت مؤثر: غیرفعال",
  );
  const kb = new InlineKeyboard()
    .text(`اعلان‌های خودکار: ${user.cronNotificationsEnabled ? "✅" : "❌"}`, NSET_CB.toggle("cron"))
    .row()
    .text(`اعلان سرویس‌ها: ${user.serviceNotificationsEnabled ? "✅" : "❌"}`, NSET_CB.toggle("svc"))
    .row()
    .text(`ساعات سکوت: ${pref.quietHoursEnabled ? "✅" : "❌"}`, NSET_CB.toggle("quiet"))
    .row()
    .text(`منطقه زمانی: ${effective.timezone}`, NSET_CB.tz)
    .row()
    .text(`سقف روزانه: ${effective.dailyLimit}`, NSET_CB.limit)
    .row()
    .text("بازگشت به سرویس‌های من", CB.USER_SERVICES);
  await safeEditOrReply(ctx, lines.join("\n"), kb);
}

userNotificationsHandler.callbackQuery(NSET_CB.root, async (ctx) => {
  await safeAnswerCallback(ctx);
  await renderUserNotificationSettings(ctx);
});

userNotificationsHandler.callbackQuery(/^user:nset:toggle:(cron|svc|quiet)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const field = ctx.match[1];
  if (field === "cron") {
    // Keep ctx.dbUser fresh so the immediate re-render shows the new state.
    ctx.dbUser = await toggleUserCategory(user.id, "cronNotificationsEnabled");
  } else if (field === "svc") {
    ctx.dbUser = await toggleUserCategory(user.id, "serviceNotificationsEnabled");
  } else {
    const pref = await getOrCreateNotificationPreference(user.id);
    await setUserQuietHoursEnabled(user.id, !pref.quietHoursEnabled);
  }
  await safeAnswerCallback(ctx);
  await renderUserNotificationSettings(ctx);
});

userNotificationsHandler.callbackQuery(NSET_CB.tz, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const effective = await resolveEffectiveDeliveryPreferences(user.id);
  const index = ALLOWED_TIMEZONES.indexOf(effective.timezone);
  const next = ALLOWED_TIMEZONES[(index + 1) % ALLOWED_TIMEZONES.length];
  await setUserTimezone(user.id, next);
  await safeAnswerCallback(ctx, `منطقه زمانی: ${next}`);
  await renderUserNotificationSettings(ctx);
});

userNotificationsHandler.callbackQuery(NSET_CB.limit, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const effective = await resolveEffectiveDeliveryPreferences(user.id);
  const current = Math.min(
    Math.max(USER_DAILY_LIMIT_MIN, effective.dailyLimit),
    USER_DAILY_LIMIT_MAX,
  );
  const next = current >= USER_DAILY_LIMIT_MAX ? USER_DAILY_LIMIT_MIN : current + 1;
  await setUserDailyLimit(user.id, next);
  await safeAnswerCallback(ctx, `سقف روزانه: ${next}`);
  await renderUserNotificationSettings(ctx);
});

// =============================================================================
// 3. Per-service notification override page: user:nsvc:*
// =============================================================================

const NSVC_CB = {
  toggle: (sid: string, kind: ServiceNotificationKind): string => `user:nsvc:tg:${sid}:${kind}`,
} as const;

const KINDS: readonly ServiceNotificationKind[] = ["expiry", "traffic", "status"];

const KIND_TITLES: Record<ServiceNotificationKind, string> = {
  expiry: "یادآوری انقضا",
  traffic: "هشدار ترافیک",
  status: "تغییر وضعیت",
};

/** Reads the null=inherit / true=on / false=off value stored for one kind. */
function overrideValue(
  overrides: ServiceKindOverrides,
  kind: ServiceNotificationKind,
): boolean | null {
  if (kind === "expiry") {
    return overrides.expiryEnabled;
  }
  if (kind === "traffic") {
    return overrides.trafficEnabled;
  }
  return overrides.statusEnabled;
}

/** Three-state advance: inherit(null) -> on(true) -> off(false) -> inherit. */
function cycleOverride(value: boolean | null): boolean | null {
  if (value === null) {
    return true;
  }
  return value ? false : null;
}

function overrideLabel(value: boolean | null): string {
  if (value === null) {
    return "پیرو تنظیمات کلی";
  }
  return value ? "فعال ✅" : "غیرفعال ❌";
}

function toOverrides(pref: ServiceNotificationPreference | null): ServiceKindOverrides {
  return {
    expiryEnabled: pref?.expiryEnabled ?? null,
    trafficEnabled: pref?.trafficEnabled ?? null,
    statusEnabled: pref?.statusEnabled ?? null,
  };
}

async function renderServiceNotificationSettings(ctx: BotContext, sid: string): Promise<void> {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const service = await getOwnedServiceByShortId(sid, user.id);
  if (service === null) {
    await safeAnswerCallback(ctx, SERVICE_GONE_TEXT);
    return;
  }
  const overrides = toOverrides(await getServiceNotificationPreference(service.id));
  const lines = [
    "🔔 اعلان‌های این سرویس",
    "",
    `سرویس: ${serviceAccountLabel(service)}`,
    "",
    "برای هر مورد یکی از سه حالت را انتخاب کنید: پیرو تنظیمات کلی، فعال یا غیرفعال. «نتیجه» با در نظر گرفتن تنظیمات کلی شما محاسبه می‌شود.",
    "",
  ];
  const kb = new InlineKeyboard();
  for (const kind of KINDS) {
    const value = overrideValue(overrides, kind);
    const effective = isServiceKindEnabled(user, kind, overrides);
    lines.push(
      `${KIND_TITLES[kind]}: ${overrideLabel(value)} (نتیجه: ${effective ? "فعال" : "غیرفعال"})`,
    );
    kb.text(`${KIND_TITLES[kind]}: ${overrideLabel(value)}`, NSVC_CB.toggle(sid, kind)).row();
  }
  kb.text("بازگشت به سرویس", svcCb.view(sid));
  await safeEditOrReply(ctx, lines.join("\n"), kb);
}

userNotificationsHandler.callbackQuery(
  /^user:nsvc:tg:([0-9a-f-]{4,32}):(expiry|traffic|status)$/,
  async (ctx) => {
    const user = ctx.dbUser;
    if (user === null) {
      return;
    }
    const sid = ctx.match[1];
    const kind = ctx.match[2] as ServiceNotificationKind;
    const service = await getOwnedServiceByShortId(sid, user.id);
    if (service === null) {
      await safeAnswerCallback(ctx, SERVICE_GONE_TEXT);
      return;
    }
    const overrides = toOverrides(await getServiceNotificationPreference(service.id));
    const next = cycleOverride(overrideValue(overrides, kind));
    await setServiceNotificationKind(service.id, kind, next);
    await safeAnswerCallback(ctx);
    await renderServiceNotificationSettings(ctx, sid);
  },
);

userNotificationsHandler.callbackQuery(/^user:nsvc:([0-9a-f-]{4,32})$/, async (ctx) => {
  await safeAnswerCallback(ctx);
  await renderServiceNotificationSettings(ctx, ctx.match[1]);
});
