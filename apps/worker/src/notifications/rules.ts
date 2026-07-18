import {
  NOTIF_BUTTON_KEYS,
  NOTIF_TEMPLATE_KEYS,
  NTF_ACTION_CODES,
  computeTrafficUsage,
  expiryDedupeKey,
  maskServiceName,
  quotaCycleFingerprint,
  expiryCycleFingerprint,
  statusDedupeKey,
  trafficDedupeKey,
  type ExpiryThreshold,
  type NotificationButtonSpec,
  type NotificationPayloadSnapshot,
  type NotificationType,
} from "@zedbot/shared";

// =============================================================================
// Pure notification RULES (feat/notification-retention-engine, Phase 1). Given
// a service's live state + the operator thresholds, decides the ONE currently-
// applicable notification (bucket) per rule and builds its dedupe key + safe
// payload snapshot. No prisma / Redis / Telegram here - every rule is unit-
// testable in isolation. The scan binds these to the DB; the delivery worker
// re-derives buttons from live state via the same builders.
// =============================================================================

/** The minimal service state the rules read (BigInt-safe byte fields). */
export interface RuleServiceState {
  id: string;
  username: string;
  note: string | null;
  productNameSnapshot: string | null;
  status: string;
  volumeBytes: bigint;
  usedBytes: bigint;
  expiresAt: Date | null;
}

/** Panel facts the button builder needs (never secrets). */
export interface RulePanelState {
  status: string;
  renewalEnabled: boolean;
}

export type ServiceNotificationKind = "expiry" | "traffic" | "status";

export interface NotificationPlan {
  type: NotificationType;
  serviceKind: ServiceNotificationKind;
  dedupeKey: string;
  availableUntil: Date | null;
  payload: NotificationPayloadSnapshot;
}

const RENEWABLE_STATUSES = new Set(["ACTIVE", "EXPIRED", "LIMITED", "DISABLED"]);
const EXTRA_VOLUME_STATUSES = new Set(["ACTIVE", "LIMITED"]);

const DAY_MS = 24 * 60 * 60_000;

// --- display helpers ---------------------------------------------------------

const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

/** Latin -> Persian digits for user-facing numbers. */
export function toFaDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (d) => FA_DIGITS[Number(d)]);
}

/**
 * Safe user-facing service name: the operator/user friendly name if present,
 * else a MASKED remote username (never the raw technical identity in a stored
 * snapshot). Always non-empty.
 */
export function serviceDisplayName(service: RuleServiceState): string {
  const friendly = (service.productNameSnapshot ?? "").trim() || (service.note ?? "").trim();
  if (friendly !== "") {
    return friendly;
  }
  const masked = maskServiceName(service.username);
  return masked === "" ? "سرویس شما" : masked;
}

/** Humanized Persian remaining-time from a threshold's minutesBefore. */
export function formatTimeLeftFa(minutesBefore: number): string {
  if (minutesBefore % 1440 === 0) {
    return `${toFaDigits(minutesBefore / 1440)} روز`;
  }
  if (minutesBefore % 60 === 0) {
    return `${toFaDigits(minutesBefore / 60)} ساعت`;
  }
  return `${toFaDigits(minutesBefore)} دقیقه`;
}

// --- bucket selection --------------------------------------------------------

/**
 * The single currently-applicable expiry bucket. For a not-yet-expired service
 * that is the threshold with the SMALLEST minutesBefore still >= the minutes
 * remaining (the tightest window already entered); earlier windows are never
 * back-filled. `minutesToExpiry <= 0` selects the `expired` threshold. Returns
 * null when it is too early for any threshold.
 */
export function pickExpiryBucket(
  minutesToExpiry: number,
  thresholds: ExpiryThreshold[],
): ExpiryThreshold | null {
  if (minutesToExpiry <= 0) {
    return thresholds.find((t) => t.minutesBefore === null) ?? null;
  }
  let best: ExpiryThreshold | null = null;
  for (const t of thresholds) {
    if (t.minutesBefore === null || t.minutesBefore < minutesToExpiry) {
      continue;
    }
    if (best === null || t.minutesBefore < (best.minutesBefore as number)) {
      best = t;
    }
  }
  return best;
}

/** The largest traffic threshold <= rawPercent, or null when under the lowest. */
export function pickTrafficBucket(rawPercent: number, thresholds: number[]): number | null {
  let best: number | null = null;
  for (const pct of thresholds) {
    if (rawPercent >= pct && (best === null || pct > best)) {
      best = pct;
    }
  }
  return best;
}

// --- button building (shared by scan + delivery) -----------------------------

function openButton(): NotificationButtonSpec {
  return { action: NTF_ACTION_CODES.OPEN_SERVICE, buttonTextKey: NOTIF_BUTTON_KEYS.OPEN_SERVICE };
}
function dismissButton(): NotificationButtonSpec {
  return { action: NTF_ACTION_CODES.DISMISS, buttonTextKey: NOTIF_BUTTON_KEYS.DISMISS };
}

function canRenew(service: RuleServiceState, panel: RulePanelState): boolean {
  return (
    panel.status === "ACTIVE" && panel.renewalEnabled && RENEWABLE_STATUSES.has(service.status)
  );
}

function canBuyExtraVolume(service: RuleServiceState, panel: RulePanelState): boolean {
  return (
    panel.status === "ACTIVE" &&
    EXTRA_VOLUME_STATUSES.has(service.status) &&
    service.volumeBytes > 0n
  );
}

/**
 * The eligible buttons for a notification, given the CURRENT service + panel
 * state. Trials only ever offer open/dismiss (a trial is converted, not
 * renewed - the detail page surfaces its conversion options). Every other
 * button is capability-gated here AND re-validated by the bot on click, so a
 * button never performs an action the user is not entitled to.
 */
export function buildNotificationButtons(
  type: NotificationType,
  service: RuleServiceState,
  panel: RulePanelState,
  trial: boolean,
): NotificationButtonSpec[] {
  const buttons: NotificationButtonSpec[] = [openButton()];
  if (!trial) {
    if (type === "SERVICE_TRAFFIC" && canBuyExtraVolume(service, panel)) {
      buttons.push({
        action: NTF_ACTION_CODES.BUY_EXTRA_VOLUME,
        buttonTextKey: NOTIF_BUTTON_KEYS.BUY_EXTRA_VOLUME,
      });
    } else if (
      (type === "SERVICE_EXPIRY" || type === "SERVICE_EXPIRED" || type === "SERVICE_LIMITED") &&
      canRenew(service, panel)
    ) {
      buttons.push({
        action: NTF_ACTION_CODES.RENEW_SERVICE,
        buttonTextKey: NOTIF_BUTTON_KEYS.RENEW_SERVICE,
      });
    }
  }
  buttons.push(dismissButton());
  return buttons;
}

// --- plan builders -----------------------------------------------------------

function baseMeta(serviceShort: string, extra: Record<string, string | number>): Record<string, string | number> {
  return { svc: serviceShort, ...extra };
}

/**
 * Expiry / expired plan (paid) or trial near-expiry / expired plan. Returns the
 * single applicable plan, or null when no bucket is currently applicable.
 */
export function planExpiry(
  service: RuleServiceState,
  panel: RulePanelState,
  thresholds: ExpiryThreshold[],
  now: Date,
  trial: boolean,
): NotificationPlan | null {
  if (service.expiresAt === null) {
    return null; // never-expiring service: expiry rule does not apply.
  }
  const minutesToExpiry = Math.floor((service.expiresAt.getTime() - now.getTime()) / 60_000);
  const bucket = pickExpiryBucket(minutesToExpiry, thresholds);
  if (bucket === null) {
    return null;
  }
  const expired = bucket.minutesBefore === null;
  const type: NotificationType = expired
    ? trial
      ? "TRIAL_EXPIRED"
      : "SERVICE_EXPIRED"
    : trial
      ? "TRIAL_NEAR_EXPIRY"
      : "SERVICE_EXPIRY";
  const cycle = expiryCycleFingerprint(service.expiresAt);
  const name = serviceDisplayName(service);
  const variables: Record<string, string | number> = { service_name: name };
  if (!expired && bucket.minutesBefore !== null) {
    variables.time_left = formatTimeLeftFa(bucket.minutesBefore);
  }
  const templateKey = expired
    ? trial
      ? NOTIF_TEMPLATE_KEYS.TRIAL_EXPIRED
      : NOTIF_TEMPLATE_KEYS.SERVICE_EXPIRED
    : trial
      ? NOTIF_TEMPLATE_KEYS.TRIAL_NEAR_EXPIRY
      : NOTIF_TEMPLATE_KEYS.SERVICE_EXPIRY;
  // pre-expiry: moot once the service actually expires; expired: keep a small
  // window so a late-delivered notice is not sent days later.
  const availableUntil = expired
    ? new Date(now.getTime() + (trial ? DAY_MS : 3 * DAY_MS))
    : service.expiresAt;
  return {
    type,
    serviceKind: "expiry",
    dedupeKey: expiryDedupeKey(service.id, bucket.key, service.expiresAt, trial),
    availableUntil,
    payload: {
      templateKey,
      variables,
      buttons: buildNotificationButtons(type, service, panel, trial),
      meta: baseMeta(service.id.slice(0, 8), { kind: expired ? "expired" : "expiry", cycle, trial: trial ? 1 : 0 }),
    },
  };
}

/** Traffic plan (paid, metered services only). */
export function planTraffic(
  service: RuleServiceState,
  panel: RulePanelState,
  thresholds: number[],
  now: Date,
): NotificationPlan | null {
  const usage = computeTrafficUsage(service.usedBytes, service.volumeBytes);
  if (usage.unlimited) {
    return null;
  }
  const bucket = pickTrafficBucket(usage.rawPercent, thresholds);
  if (bucket === null) {
    return null;
  }
  const cycle = quotaCycleFingerprint(service.volumeBytes, service.expiresAt);
  const name = serviceDisplayName(service);
  const type: NotificationType = "SERVICE_TRAFFIC";
  return {
    type,
    serviceKind: "traffic",
    dedupeKey: trafficDedupeKey(service.id, bucket, service.volumeBytes, service.expiresAt),
    // moot once the service expires (a new quota cycle re-alerts anyway).
    availableUntil: service.expiresAt ?? new Date(now.getTime() + 3 * DAY_MS),
    payload: {
      templateKey: NOTIF_TEMPLATE_KEYS.SERVICE_TRAFFIC,
      variables: { service_name: name, percent: toFaDigits(bucket) },
      buttons: buildNotificationButtons(type, service, panel, false),
      meta: baseMeta(service.id.slice(0, 8), { kind: "traffic", cycle, percent: bucket, raw: usage.rawPercent }),
    },
  };
}

/** Status plan: currently only SERVICE_LIMITED (quota-limited). */
export function planStatus(
  service: RuleServiceState,
  panel: RulePanelState,
  now: Date,
): NotificationPlan | null {
  if (service.status !== "LIMITED") {
    return null;
  }
  const cycle = expiryCycleFingerprint(service.expiresAt);
  const name = serviceDisplayName(service);
  const type: NotificationType = "SERVICE_LIMITED";
  return {
    type,
    serviceKind: "status",
    dedupeKey: statusDedupeKey(service.id, "limited", service.expiresAt),
    availableUntil: new Date(now.getTime() + 3 * DAY_MS),
    payload: {
      templateKey: NOTIF_TEMPLATE_KEYS.SERVICE_LIMITED,
      variables: { service_name: name },
      buttons: buildNotificationButtons(type, service, panel, false),
      meta: baseMeta(service.id.slice(0, 8), { kind: "limited", cycle }),
    },
  };
}
