import { UserStatus, prisma, type NotificationPreference, type User } from "@zedbot/database";
import {
  buildEffectiveDeliveryPreferences as buildEffectiveDeliveryPreferencesShared,
  isServiceKindGateOpen,
  isUserGateOpenForCategory,
  isUserGateOpenForType,
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
  field: "serviceNotificationsEnabled" | "paymentNotificationsEnabled" | "marketingMessagesEnabled" | "cronNotificationsEnabled",
): Promise<User> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  return prisma.user.update({
    where: { id: userId },
    data: { [field]: !user[field] },
  });
}
