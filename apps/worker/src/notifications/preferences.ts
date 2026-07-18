import { UserStatus, prisma } from "@zedbot/database";
import {
  buildEffectiveDeliveryPreferences,
  isServiceKindGateOpen,
  isUserGateOpenForCategory,
  type EffectiveDeliveryPreferences,
  type NotificationCategory,
  type NotificationUserGates,
  type ServiceNotificationKind,
} from "@zedbot/shared";

import { getDailyLimitDefault, getDefaultQuietHours, getDefaultTimezone } from "./settings.js";

// =============================================================================
// Worker-side preference resolution (feat/notification-retention-engine, Phase
// 1). Reads the SAME rows the bot writes and applies the SAME pure @zedbot/
// shared gates, so a notification the bot's settings page would suppress is
// suppressed here too. All three layers are re-read at DELIVERY time (not just
// at scan time): the user could have toggled a switch or a service could have
// converted between scan and send.
// =============================================================================

/** The five authoritative user switches + status, mapped to the pure gates. */
export async function loadUserGates(userId: string): Promise<NotificationUserGates | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      status: true,
      cronNotificationsEnabled: true,
      serviceNotificationsEnabled: true,
      paymentNotificationsEnabled: true,
      marketingMessagesEnabled: true,
    },
  });
  if (user === null) {
    return null;
  }
  return {
    active: user.status === UserStatus.ACTIVE,
    cronNotificationsEnabled: user.cronNotificationsEnabled,
    serviceNotificationsEnabled: user.serviceNotificationsEnabled,
    paymentNotificationsEnabled: user.paymentNotificationsEnabled,
    marketingMessagesEnabled: user.marketingMessagesEnabled,
  };
}

export function userGateOpen(
  gates: NotificationUserGates,
  category: NotificationCategory,
): boolean {
  return isUserGateOpenForCategory(gates, category);
}

/** Per-service kind gate: user SERVICE opt-in AND the (optional) override row. */
export async function serviceKindGateOpen(
  gates: NotificationUserGates,
  serviceId: string,
  kind: ServiceNotificationKind,
): Promise<boolean> {
  const override = await prisma.serviceNotificationPreference.findUnique({
    where: { serviceId },
    select: { expiryEnabled: true, trafficEnabled: true, statusEnabled: true },
  });
  return isServiceKindGateOpen(gates, kind, override);
}

/** Effective timezone / quiet-hours / daily-limit for the user (row over defaults). */
export async function resolveEffectiveDeliveryPreferences(
  userId: string,
): Promise<EffectiveDeliveryPreferences> {
  const [pref, timezone, quietHours, dailyLimit] = await Promise.all([
    prisma.notificationPreference.findUnique({
      where: { userId },
      select: {
        timezone: true,
        quietHoursEnabled: true,
        quietHoursStartMinutes: true,
        quietHoursEndMinutes: true,
        dailyAutomatedLimit: true,
      },
    }),
    getDefaultTimezone(),
    getDefaultQuietHours(),
    getDailyLimitDefault(),
  ]);
  return buildEffectiveDeliveryPreferences(pref, { timezone, quietHours, dailyLimit });
}
