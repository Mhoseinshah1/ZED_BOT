import {
  NotificationInteractionType,
  type AutomatedNotification,
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
import { suppressCheckoutReminders } from "../../services/checkout-notification.service.js";
import { resumeCheckoutForUser } from "../../services/checkout-resume.service.js";
import { getOwnedCheckout } from "../../services/checkout.service.js";
import { getWinbackConfig } from "../../services/notification/notification-settings.service.js";
import {
  getOwnedNotificationByShortId,
  notificationShortId,
  recordNotificationInteraction,
} from "../../services/notification/notification.service.js";
import {
  clearWinbackSnooze,
  getActiveWinbackSnooze,
  optOutMarketing,
  snoozeWinback,
} from "../../services/winback.service.js";
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
import { renderCheckoutView, startBuyFlow } from "../user-checkout/checkout.handler.js";
import { renderWallet } from "../user-wallet/wallet.handler.js";
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
const CHECKOUT_SUPPRESS_TEXT = "دیگر برای این سفارش یادآوری ارسال نمی‌شود.";

// Win-back (Phase 3, MARKETING) confirm/result copy + callback namespace. The
// snooze/opt-out buttons open a confirmation first; the actual state change only
// happens on the wb:snz / wb:opt confirm callback (owner-scoped, short id only).
const WINBACK_SNOOZE_CONFIRM_TEXT = (days: number): string =>
  `یادآوری‌های بازگشت برای ${faDigits(days)} روز متوقف شود؟`;
const WINBACK_OPT_OUT_CONFIRM_TEXT =
  "آیا دریافت پیشنهادها و پیام‌های بازاریابی غیرفعال شود؟";
const WINBACK_SNOOZED_TEXT = "یادآوری‌های بازگشت به‌صورت موقت متوقف شد.";
const WINBACK_OPTED_OUT_TEXT = "پیشنهادها و پیام‌های بازاریابی غیرفعال شد.";
const WINBACK_CANCELLED_TEXT = "لغو شد.";
const WINBACK_CONFIRM_YES_SNOOZE = "تایید توقف موقت";
const WINBACK_CONFIRM_YES_OPT_OUT = "غیرفعال کردن پیشنهادها";
const WINBACK_CONFIRM_NO = "انصراف";

const WB_CB = {
  snooze: (sid: string): string => `wb:snz:${sid}`,
  opt: (sid: string): string => `wb:opt:${sid}`,
  cancel: (sid: string): string => `wb:cancel:${sid}`,
} as const;

/** Latin -> Persian digits for user-facing counts/dates. */
function faDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
}

// =============================================================================
// 1. Notification action callbacks: ntf:<shortId>:<action>
// =============================================================================

/**
 * Action code -> recorded interaction for the SERVICE actions. The checkout
 * actions (c/d/n) record inside handleCheckoutNotificationAction and never reach
 * this map; p (view-products) has no Phase-1 flow of its own, so it records
 * nothing and falls through to opening the service (a safe, always-real landing).
 */
const ACTION_INTERACTION: Record<string, NotificationInteractionType | undefined> = {
  s: NotificationInteractionType.OPEN_SERVICE,
  r: NotificationInteractionType.RENEW_SERVICE,
  v: NotificationInteractionType.BUY_EXTRA_VOLUME,
  x: NotificationInteractionType.DISMISS,
};

/**
 * Checkout-payment reminder actions (Phase 2): c = continue/reselect payment,
 * d = view the checkout detail page, n = suppress THIS checkout's future reminders
 * of this kind. Every path re-resolves ownership + LIVE financial state (via the
 * resume service / owner-scoped loads), never trusting the notification snapshot,
 * and records the click idempotently. A notification with no checkout attached is
 * treated as an unknown/expired notification (no leak).
 */
async function handleCheckoutNotificationAction(
  ctx: BotContext,
  notification: AutomatedNotification,
  userId: string,
  action: "c" | "d" | "n",
): Promise<void> {
  const checkoutId = notification.checkoutSessionId;
  if (checkoutId === null) {
    await safeAnswerCallback(ctx, NTF_INVALID_TEXT);
    return;
  }
  // Idempotent per (notification, type): continue/view -> CONTINUE_CHECKOUT,
  // suppress -> DISMISS.
  const interaction =
    action === "n"
      ? NotificationInteractionType.DISMISS
      : NotificationInteractionType.CONTINUE_CHECKOUT;
  await recordNotificationInteraction(notification.id, userId, interaction);

  if (action === "c") {
    await resumeCheckoutForUser(ctx, checkoutId);
    return;
  }
  if (action === "d") {
    const checkout = await getOwnedCheckout(checkoutId, userId);
    if (checkout === null) {
      await safeAnswerCallback(ctx, NTF_INVALID_TEXT);
      return;
    }
    await safeAnswerCallback(ctx);
    await renderCheckoutView(ctx, checkout);
    return;
  }
  // action === "n": suppress only this checkout's reminders of this kind.
  const kind = notification.type === "PAYMENT_RETRY" ? "payment" : "abandoned";
  await suppressCheckoutReminders(checkoutId, kind, notification.id);
  try {
    // Strip the inline keyboard so the buttons cannot be clicked again.
    await ctx.editMessageReplyMarkup();
  } catch {
    // Message deleted / not modifiable - the toast is still the real result.
  }
  await safeAnswerCallback(ctx, CHECKOUT_SUPPRESS_TEXT);
}

/**
 * Customer win-back reminder actions (Phase 3, MARKETING). g = open the plans
 * storefront (creates NO checkout); w = open the wallet (never charges); z =
 * confirm-then-snooze win-back reminders; o = confirm-then opt out of marketing.
 * The snooze/opt-out state changes happen ONLY on the wb:* confirm callbacks, so
 * a single click can never silently mutate a preference. Every path records the
 * click idempotently and carries only the short id in follow-up callback data.
 */
async function handleWinbackNotificationAction(
  ctx: BotContext,
  notification: AutomatedNotification,
  userId: string,
  action: "g" | "w" | "z" | "o",
): Promise<void> {
  const sid = notificationShortId(notification.id);

  if (action === "g") {
    // View plans: reuse the VIEW_PRODUCTS interaction; open the live storefront.
    await recordNotificationInteraction(notification.id, userId, NotificationInteractionType.VIEW_PRODUCTS);
    await safeAnswerCallback(ctx);
    await startBuyFlow(ctx);
    return;
  }
  if (action === "w") {
    await recordNotificationInteraction(notification.id, userId, NotificationInteractionType.VIEW_WALLET);
    await safeAnswerCallback(ctx);
    await renderWallet(ctx);
    return;
  }
  if (action === "z") {
    // Confirm first; the actual snooze happens on wb:snz.
    await recordNotificationInteraction(notification.id, userId, NotificationInteractionType.SNOOZE_WINBACK);
    const config = await getWinbackConfig();
    const kb = new InlineKeyboard()
      .text(WINBACK_CONFIRM_YES_SNOOZE, WB_CB.snooze(sid))
      .text(WINBACK_CONFIRM_NO, WB_CB.cancel(sid));
    await safeAnswerCallback(ctx);
    await safeEditOrReply(ctx, WINBACK_SNOOZE_CONFIRM_TEXT(config.snoozeDays), kb);
    return;
  }
  // action === "o": confirm first; the opt-out happens on wb:opt.
  await recordNotificationInteraction(notification.id, userId, NotificationInteractionType.MARKETING_OPT_OUT);
  const kb = new InlineKeyboard()
    .text(WINBACK_CONFIRM_YES_OPT_OUT, WB_CB.opt(sid))
    .text(WINBACK_CONFIRM_NO, WB_CB.cancel(sid));
  await safeAnswerCallback(ctx);
  await safeEditOrReply(ctx, WINBACK_OPT_OUT_CONFIRM_TEXT, kb);
}

userNotificationsHandler.callbackQuery(/^ntf:([0-9a-f]{4,12}):([srvcpxdngwzo])$/, async (ctx) => {
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

  // Win-back (MARKETING) actions are routed by TYPE first, before the service /
  // checkout branches, so a win-back letter can never fall through to them and a
  // service/checkout notification can never trigger a win-back mutation.
  if (notification.type === "CUSTOMER_WINBACK") {
    if (action === "g" || action === "w" || action === "z" || action === "o") {
      await handleWinbackNotificationAction(ctx, notification, user.id, action);
    } else {
      await safeAnswerCallback(ctx, NTF_INVALID_TEXT);
    }
    return;
  }
  // A win-back-only letter on a non-win-back notification is invalid.
  if (action === "g" || action === "w" || action === "z" || action === "o") {
    await safeAnswerCallback(ctx, NTF_INVALID_TEXT);
    return;
  }

  // Checkout-payment reminder actions own their recording + routing.
  if (action === "c" || action === "d" || action === "n") {
    await handleCheckoutNotificationAction(ctx, notification, user.id, action);
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

// --- win-back confirm callbacks: wb:<verb>:<shortId> -------------------------
// Every one resolves the notification OWNER-scoped from the short id; a foreign/
// absent id gets the SAME safe invalid toast (no existence reveal). The keyboard
// is stripped on completion so the confirm cannot be re-fired, and the answer is
// a toast (never a keyboard-less full-page edit).

userNotificationsHandler.callbackQuery(/^wb:snz:([0-9a-f]{4,12})$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const notification = await getOwnedNotificationByShortId(ctx.match[1], user.id);
  if (notification === null || notification.type !== "CUSTOMER_WINBACK") {
    await safeAnswerCallback(ctx, NTF_INVALID_TEXT);
    return;
  }
  const config = await getWinbackConfig();
  await snoozeWinback(user.id, config.snoozeDays, notification.id);
  try {
    await ctx.editMessageReplyMarkup();
  } catch {
    // Message deleted / not modifiable - the toast is still the real result.
  }
  await safeAnswerCallback(ctx, WINBACK_SNOOZED_TEXT);
});

userNotificationsHandler.callbackQuery(/^wb:opt:([0-9a-f]{4,12})$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const notification = await getOwnedNotificationByShortId(ctx.match[1], user.id);
  if (notification === null || notification.type !== "CUSTOMER_WINBACK") {
    await safeAnswerCallback(ctx, NTF_INVALID_TEXT);
    return;
  }
  await optOutMarketing(user.id);
  try {
    await ctx.editMessageReplyMarkup();
  } catch {
    // Message deleted / not modifiable - the toast is still the real result.
  }
  await safeAnswerCallback(ctx, WINBACK_OPTED_OUT_TEXT);
});

userNotificationsHandler.callbackQuery(/^wb:cancel:([0-9a-f]{4,12})$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const notification = await getOwnedNotificationByShortId(ctx.match[1], user.id);
  if (notification === null || notification.type !== "CUSTOMER_WINBACK") {
    await safeAnswerCallback(ctx, NTF_INVALID_TEXT);
    return;
  }
  // Cancel: drop the confirm keyboard, keep the original message text (not a
  // dead-end - the message + its win-back buttons context remains visible).
  try {
    await ctx.editMessageReplyMarkup();
  } catch {
    // Message deleted / not modifiable - the toast is still the real result.
  }
  await safeAnswerCallback(ctx, WINBACK_CANCELLED_TEXT);
});

// =============================================================================
// 2. User notification settings page: user:nset:*
// =============================================================================

const NSET_CB = {
  root: "user:nset:root",
  toggle: (field: "cron" | "svc" | "quiet" | "mkt"): string => `user:nset:toggle:${field}`,
  tz: "user:nset:tz",
  limit: "user:nset:limit",
  unsnooze: "user:nset:unsnooze",
} as const;

/** Persian short date for the snooze line; falls back to the ISO date slice. */
function formatSnoozeDate(date: Date): string {
  try {
    return new Intl.DateTimeFormat("fa-IR", { dateStyle: "short" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

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
  const [pref, effective, snoozedUntil] = await Promise.all([
    getOrCreateNotificationPreference(user.id),
    resolveEffectiveDeliveryPreferences(user.id),
    getActiveWinbackSnooze(user.id),
  ]);
  const lines = [
    "🔔 تنظیمات اعلان‌ها",
    "",
    "مشخص کنید کدام یادآوری‌های خودکار را دریافت کنید. این تنظیمات فقط روی اعلان‌های خودکار اثر دارد.",
    "یادآوری پرداخت شامل سفارش‌های ناقص و پرداخت‌های ناموفق است.",
    "پیشنهادها و پیام‌های بازگشت فقط برای معرفی دوباره پلن‌ها ارسال می‌شوند و هیچ پرداختی به‌صورت خودکار انجام نمی‌شود.",
    "",
    `اعلان‌های خودکار: ${onOff(user.cronNotificationsEnabled)}`,
    `اعلان سرویس‌ها: ${onOff(user.serviceNotificationsEnabled)}`,
    `ساعات سکوت: ${onOff(pref.quietHoursEnabled)}`,
    `پیشنهادها و پیام‌های بازگشت: ${onOff(user.marketingMessagesEnabled)}`,
    `توقف موقت پیام‌های بازگشت: ${snoozedUntil === null ? "غیرفعال" : `تا ${formatSnoozeDate(snoozedUntil)}`}`,
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
    .text(
      `پیشنهادها و پیام‌های بازگشت: ${user.marketingMessagesEnabled ? "✅" : "❌"}`,
      NSET_CB.toggle("mkt"),
    )
    .row();
  if (snoozedUntil !== null) {
    kb.text("لغو توقف موقت پیام‌های بازگشت", NSET_CB.unsnooze).row();
  }
  kb.text(`منطقه زمانی: ${effective.timezone}`, NSET_CB.tz)
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

userNotificationsHandler.callbackQuery(/^user:nset:toggle:(cron|svc|quiet|mkt)$/, async (ctx) => {
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
  } else if (field === "mkt") {
    // Marketing (win-back) opt-in/out: touches ONLY marketingMessagesEnabled.
    ctx.dbUser = await toggleUserCategory(user.id, "marketingMessagesEnabled");
  } else {
    const pref = await getOrCreateNotificationPreference(user.id);
    await setUserQuietHoursEnabled(user.id, !pref.quietHoursEnabled);
  }
  await safeAnswerCallback(ctx);
  await renderUserNotificationSettings(ctx);
});

userNotificationsHandler.callbackQuery(NSET_CB.unsnooze, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  // Clears ONLY the win-back snooze window; no other preference is touched.
  await clearWinbackSnooze(user.id);
  await safeAnswerCallback(ctx, "توقف موقت پیام‌های بازگشت لغو شد.");
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
