import {
  UserStatus,
  prisma,
  type NotificationPreference,
  type ServiceNotificationPreference,
  type User,
} from "@zedbot/database";
import {
  buildEffectiveDeliveryPreferences as buildEffectiveDeliveryPreferencesShared,
  isServiceKindGateOpen,
  isUserGateOpenForCategory,
  isUserGateOpenForType,
  resolveTimezone,
  type EffectiveDeliveryPreferences,
  type NotificationCategory,
  type NotificationPreferenceView,
  type NotificationType,
  type NotificationUserGates,
  type ServiceKindOverrides,
  type ServiceNotificationKind,
} from "@zedbot/shared";

import { getDailyLimitDefault, getDefaultQuietHours, getDefaultTimezone } from "./notification-settings.service.js";

export type { EffectiveDeliveryPreferences, ServiceNotificationKind } from "@zedbot/shared";

// =============================================================================
// Preference hierarchy (feat/notification-retention-engine, Phase 1). The five
// authoritative User booleans stay the source of truth for their categories;
// NotificationPreference adds timezone/quiet-hours/daily-limit; a per-service
// ServiceNotificationPreference sub-gates a single service. cronNotificationsEnabled
// suppresses ALL automated notifications from this engine (direct transactional
// responses are unaffected - they never flow through here).
// =============================================================================

/** The User subset the category gate needs (works with a full row too). */
export interface UserPreferenceView {
  status: UserStatus;
  cronNotificationsEnabled: boolean;
  serviceNotificationsEnabled: boolean;
  paymentNotificationsEnabled: boolean;
  marketingMessagesEnabled: boolean;
}

/** Maps the DB-shaped view (UserStatus) to the pure shared gate booleans. */
function toGates(user: UserPreferenceView): NotificationUserGates {
  return {
    active: user.status === UserStatus.ACTIVE,
    cronNotificationsEnabled: user.cronNotificationsEnabled,
    serviceNotificationsEnabled: user.serviceNotificationsEnabled,
    paymentNotificationsEnabled: user.paymentNotificationsEnabled,
    marketingMessagesEnabled: user.marketingMessagesEnabled,
  };
}

/**
 * Whether the user may receive an automated notification of `category`:
 * ACTIVE user + cron master switch + the category-specific opt-in. This never
 * looks at quiet hours / daily limits (those are delivery-time concerns).
 */
export function isUserEligibleForCategory(
  user: UserPreferenceView,
  category: NotificationCategory,
): boolean {
  return isUserGateOpenForCategory(toGates(user), category);
}

export function isUserEligibleForType(user: UserPreferenceView, type: NotificationType): boolean {
  return isUserGateOpenForType(toGates(user), type);
}

/** Per-service override view (null field = inherit the user's global SERVICE opt-in). */
export type ServiceNotificationPreferenceView = ServiceKindOverrides;

/**
 * Effective per-service enable for a single kind: the user's global SERVICE
 * opt-in AND (the per-service override, or inherit when null). A service can
 * only ever TIGHTEN the user's global setting, never loosen it.
 */
export function isServiceKindEnabled(
  user: UserPreferenceView,
  kind: ServiceNotificationKind,
  servicePref: ServiceNotificationPreferenceView | null,
): boolean {
  return isServiceKindGateOpen(toGates(user), kind, servicePref);
}

// --- effective delivery preferences (timezone / quiet hours / daily limit) ---

/**
 * Resolves the user's effective quiet-hours / timezone / daily-limit by layering
 * their NotificationPreference row over the global defaults. A missing row means
 * "all defaults". Reads the global defaults from Settings.
 */
export async function resolveEffectiveDeliveryPreferences(
  userId: string,
): Promise<EffectiveDeliveryPreferences> {
  const [pref, defaultTimezone, defaultQuiet, defaultDailyLimit] = await Promise.all([
    prisma.notificationPreference.findUnique({ where: { userId } }),
    getDefaultTimezone(),
    getDefaultQuietHours(),
    getDailyLimitDefault(),
  ]);
  return buildEffectiveDeliveryPreferences(pref, {
    timezone: defaultTimezone,
    quietHours: defaultQuiet,
    dailyLimit: defaultDailyLimit,
  });
}

/**
 * Pure layering (unit-testable): user row over provided global defaults.
 * Thin adapter over the shared implementation so the bot and worker layer
 * preferences identically.
 */
export function buildEffectiveDeliveryPreferences(
  pref: NotificationPreferenceView | null,
  defaults: EffectiveDeliveryPreferences,
): EffectiveDeliveryPreferences {
  return buildEffectiveDeliveryPreferencesShared(pref, defaults);
}

// --- preference row helpers (user-facing settings UI writes through these) ----

export async function getOrCreateNotificationPreference(userId: string): Promise<NotificationPreference> {
  const existing = await prisma.notificationPreference.findUnique({ where: { userId } });
  if (existing !== null) {
    return existing;
  }
  return prisma.notificationPreference.upsert({
    where: { userId },
    create: { userId },
    update: {},
  });
}

export async function toggleUserCategory(
  userId: string,
  field:
    | "serviceNotificationsEnabled"
    | "paymentNotificationsEnabled"
    | "marketingMessagesEnabled"
    | "cronNotificationsEnabled"
    // Focused low-balance opt-out: silencing this one alert must not require
    // silencing every payment notice, so it is its own boolean.
    | "lowBalanceNotificationsEnabled",
): Promise<User> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return prisma.user.update({
    where: { id: userId },
    data: { [field]: !user[field] },
  });
}

/** Daily-limit bounds the user-facing cycle enforces (matches the setting UI). */
export const USER_DAILY_LIMIT_MIN = 1;
export const USER_DAILY_LIMIT_MAX = 10;

/** Sets the user's timezone override to an allowlisted IANA zone (invalid -> default). */
export async function setUserTimezone(userId: string, timezone: string): Promise<NotificationPreference> {
  await getOrCreateNotificationPreference(userId);
  return prisma.notificationPreference.update({
    where: { userId },
    data: { timezone: resolveTimezone(timezone) },
  });
}

/**
 * Enables/disables the user's quiet-hours. Enabling for the first time seeds the
 * window from the global default (a NotificationPreference with a null window is
 * ignored by buildEffectiveDeliveryPreferences), so the toggle actually takes
 * effect without a separate window-editing surface in Phase 1.
 */
export async function setUserQuietHoursEnabled(
  userId: string,
  enabled: boolean,
): Promise<NotificationPreference> {
  const pref = await getOrCreateNotificationPreference(userId);
  const data: {
    quietHoursEnabled: boolean;
    quietHoursStartMinutes?: number;
    quietHoursEndMinutes?: number;
  } = { quietHoursEnabled: enabled };
  if (enabled && (pref.quietHoursStartMinutes === null || pref.quietHoursEndMinutes === null)) {
    const defaults = await getDefaultQuietHours();
    data.quietHoursStartMinutes = defaults.startMinutes;
    data.quietHoursEndMinutes = defaults.endMinutes;
  }
  return prisma.notificationPreference.update({ where: { userId }, data });
}

/** Sets the user's daily automated-notification cap, clamped to [1, 10]. */
export async function setUserDailyLimit(userId: string, limit: number): Promise<NotificationPreference> {
  await getOrCreateNotificationPreference(userId);
  const bounded = Math.min(
    Math.max(USER_DAILY_LIMIT_MIN, Math.trunc(limit)),
    USER_DAILY_LIMIT_MAX,
  );
  return prisma.notificationPreference.update({
    where: { userId },
    data: { dailyAutomatedLimit: bounded },
  });
}

// --- per-service overrides (three-state: null=inherit, true=on, false=off) ----

/** The single override field a ServiceNotificationKind maps to. */
const SERVICE_KIND_FIELD: Record<
  ServiceNotificationKind,
  "expiryEnabled" | "trafficEnabled" | "statusEnabled"
> = {
  expiry: "expiryEnabled",
  traffic: "trafficEnabled",
  status: "statusEnabled",
};

/** Reads a service's override row (null when no override has ever been set). */
export async function getServiceNotificationPreference(
  serviceId: string,
): Promise<ServiceNotificationPreference | null> {
  return prisma.serviceNotificationPreference.findUnique({ where: { serviceId } });
}

/**
 * Upserts one per-service override kind to on/off/inherit (null). serviceId is
 * unique, so this is idempotent; the caller has already resolved the service
 * owner-scoped, so no user id is needed here.
 */
export async function setServiceNotificationKind(
  serviceId: string,
  kind: ServiceNotificationKind,
  value: boolean | null,
): Promise<ServiceNotificationPreference> {
  const field = SERVICE_KIND_FIELD[kind];
  return prisma.serviceNotificationPreference.upsert({
    where: { serviceId },
    create: { serviceId, [field]: value },
    update: { [field]: value },
  });
}
