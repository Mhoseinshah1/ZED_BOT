import { UserStatus, prisma, type NotificationPreference, type User } from "@zedbot/database";
import {
  NOTIFICATION_TYPE_CATEGORY,
  resolveTimezone,
  type NotificationCategory,
  type NotificationType,
  type QuietHoursConfig,
} from "@zedbot/shared";

import { getDailyLimitDefault, getDefaultQuietHours, getDefaultTimezone } from "./notification-settings.service.js";

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

function categoryBoolean(user: UserPreferenceView, category: NotificationCategory): boolean {
  switch (category) {
    case "SERVICE":
      return user.serviceNotificationsEnabled;
    case "PAYMENT":
      return user.paymentNotificationsEnabled;
    case "MARKETING":
      return user.marketingMessagesEnabled;
    default:
      return false;
  }
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
  if (user.status !== UserStatus.ACTIVE) {
    return false;
  }
  if (!user.cronNotificationsEnabled) {
    return false;
  }
  return categoryBoolean(user, category);
}

export function isUserEligibleForType(user: UserPreferenceView, type: NotificationType): boolean {
  return isUserEligibleForCategory(user, NOTIFICATION_TYPE_CATEGORY[type]);
}

export type ServiceNotificationKind = "expiry" | "traffic" | "status";

/** Per-service override view (null field = inherit the user's global SERVICE opt-in). */
export interface ServiceNotificationPreferenceView {
  expiryEnabled: boolean | null;
  trafficEnabled: boolean | null;
  statusEnabled: boolean | null;
}

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
  if (!isUserEligibleForCategory(user, "SERVICE")) {
    return false;
  }
  if (servicePref === null) {
    return true; // no override row -> inherit (enabled)
  }
  const override =
    kind === "expiry"
      ? servicePref.expiryEnabled
      : kind === "traffic"
        ? servicePref.trafficEnabled
        : servicePref.statusEnabled;
  return override === null || override === undefined ? true : override;
}

// --- effective delivery preferences (timezone / quiet hours / daily limit) ---

export interface EffectiveDeliveryPreferences {
  timezone: string;
  quietHours: QuietHoursConfig;
  dailyLimit: number;
}

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

/** Pure layering (unit-testable): user row over provided global defaults. */
export function buildEffectiveDeliveryPreferences(
  pref: Pick<
    NotificationPreference,
    "timezone" | "quietHoursEnabled" | "quietHoursStartMinutes" | "quietHoursEndMinutes" | "dailyAutomatedLimit"
  > | null,
  defaults: EffectiveDeliveryPreferences,
): EffectiveDeliveryPreferences {
  if (pref === null) {
    return defaults;
  }
  const timezone = resolveTimezone(pref.timezone, defaults.timezone);
  const hasUserQuiet =
    pref.quietHoursStartMinutes !== null && pref.quietHoursEndMinutes !== null;
  const quietHours: QuietHoursConfig = hasUserQuiet
    ? {
        enabled: pref.quietHoursEnabled,
        startMinutes: pref.quietHoursStartMinutes as number,
        endMinutes: pref.quietHoursEndMinutes as number,
      }
    : defaults.quietHours;
  const dailyLimit =
    pref.dailyAutomatedLimit !== null && pref.dailyAutomatedLimit > 0
      ? pref.dailyAutomatedLimit
      : defaults.dailyLimit;
  return { timezone, quietHours, dailyLimit };
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
  field: "serviceNotificationsEnabled" | "paymentNotificationsEnabled" | "marketingMessagesEnabled" | "cronNotificationsEnabled",
): Promise<User> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return prisma.user.update({
    where: { id: userId },
    data: { [field]: !user[field] },
  });
}
