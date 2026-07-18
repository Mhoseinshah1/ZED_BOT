import {
  DEFAULT_EXPIRY_THRESHOLDS,
  DEFAULT_QUIET_HOURS,
  DEFAULT_TRAFFIC_THRESHOLDS,
  DEFAULT_TRIAL_THRESHOLDS,
  buildEffectiveDeliveryPreferences,
  computeTrafficUsage,
  evaluateQuietHours,
  expiryCycleFingerprint,
  expiryDedupeKey,
  isServiceKindGateOpen,
  isUserGateOpenForCategory,
  isWithinQuietWindow,
  parseExpiryThresholds,
  parseTrafficThresholds,
  quotaCycleFingerprint,
  resolveTimezone,
  trafficDedupeKey,
  type NotificationUserGates,
} from "@zedbot/shared";
import { describe, expect, it } from "vitest";

import {
  buildNotificationButtons,
  pickExpiryBucket,
  pickTrafficBucket,
  planExpiry,
  planStatus,
  planTraffic,
  serviceDisplayName,
  type RulePanelState,
  type RuleServiceState,
} from "../../worker/src/notifications/rules.js";
import {
  buildServiceSyncUpdate,
  isServiceStateFresh,
} from "../../worker/src/notifications/service-sync.js";

// =============================================================================
// Pure notification-engine logic (no DB / Redis / Telegram). Covers the
// completion-gate rules that MUST be exact: every expiry/traffic/trial
// threshold bucket, BigInt-safe percentage, expiry/quota dedupe cycles, quiet
// hours, the preference gates, freshness and the safe sync mapper.
// =============================================================================

const ACTIVE_PANEL: RulePanelState = { status: "ACTIVE", renewalEnabled: true };

function service(overrides: Partial<RuleServiceState> = {}): RuleServiceState {
  return {
    id: "11112222-3333-4444-5555-666677778888",
    username: "svc-user-01",
    note: null,
    productNameSnapshot: null,
    status: "ACTIVE",
    volumeBytes: 100n * 1024n * 1024n * 1024n,
    usedBytes: 0n,
    expiresAt: null,
    ...overrides,
  };
}

const MIN = 60_000;

describe("expiry bucket selection (7d/3d/1d/12h/3h/expired)", () => {
  const T = DEFAULT_EXPIRY_THRESHOLDS;
  it("selects the tightest window already entered", () => {
    expect(pickExpiryBucket(8 * 24 * 60, T)).toBeNull(); // 8d: too early
    expect(pickExpiryBucket(7 * 24 * 60 - 1, T)?.key).toBe("7d");
    expect(pickExpiryBucket(3 * 24 * 60 - 1, T)?.key).toBe("3d");
    expect(pickExpiryBucket(24 * 60 - 1, T)?.key).toBe("1d");
    expect(pickExpiryBucket(12 * 60 - 1, T)?.key).toBe("12h");
    expect(pickExpiryBucket(3 * 60 - 1, T)?.key).toBe("3h");
    expect(pickExpiryBucket(120, T)?.key).toBe("3h");
  });
  it("selects the expired bucket at/after expiry", () => {
    expect(pickExpiryBucket(0, T)?.key).toBe("expired");
    expect(pickExpiryBucket(-500, T)?.key).toBe("expired");
  });
  it("exactly at a boundary picks that bucket", () => {
    expect(pickExpiryBucket(7 * 24 * 60, T)?.key).toBe("7d");
    expect(pickExpiryBucket(3 * 60, T)?.key).toBe("3h");
  });
});

describe("trial bucket selection (30m/10m/expired)", () => {
  const T = DEFAULT_TRIAL_THRESHOLDS;
  it("maps remaining minutes to the right trial bucket", () => {
    expect(pickExpiryBucket(31, T)).toBeNull();
    expect(pickExpiryBucket(30, T)?.key).toBe("30m");
    expect(pickExpiryBucket(11, T)?.key).toBe("30m"); // 11m left: 30m window entered, 10m not yet
    expect(pickExpiryBucket(10, T)?.key).toBe("10m");
    expect(pickExpiryBucket(0, T)?.key).toBe("expired");
  });
});

describe("traffic bucket selection (80/90/100)", () => {
  const T = DEFAULT_TRAFFIC_THRESHOLDS;
  it("selects the largest crossed threshold", () => {
    expect(pickTrafficBucket(79, T)).toBeNull();
    expect(pickTrafficBucket(80, T)).toBe(80);
    expect(pickTrafficBucket(85, T)).toBe(80);
    expect(pickTrafficBucket(90, T)).toBe(90);
    expect(pickTrafficBucket(99, T)).toBe(90);
    expect(pickTrafficBucket(100, T)).toBe(100);
    expect(pickTrafficBucket(150, T)).toBe(100);
  });
});

describe("BigInt-safe traffic percentage", () => {
  it("never coerces multi-TB bytes to float before dividing", () => {
    const volume = 10n * 1024n ** 4n; // 10 TiB
    const used = 9n * 1024n ** 4n; // 9 TiB
    const usage = computeTrafficUsage(used, volume);
    expect(usage.rawPercent).toBe(90);
    expect(usage.unlimited).toBe(false);
  });
  it("clamps display to 100 but keeps raw uncapped", () => {
    const usage = computeTrafficUsage(150n, 100n);
    expect(usage.displayPercent).toBe(100);
    expect(usage.rawPercent).toBe(150);
  });
  it("treats volume<=0 as unlimited", () => {
    expect(computeTrafficUsage(5n, 0n).unlimited).toBe(true);
    expect(computeTrafficUsage(5n, -1n).unlimited).toBe(true);
  });
  it("floors, never rounds up (79.9% stays 79)", () => {
    expect(computeTrafficUsage(799n, 1000n).rawPercent).toBe(79);
  });
});

describe("dedupe cycles", () => {
  const a = new Date("2026-07-20T00:00:00Z");
  const b = new Date("2026-08-20T00:00:00Z");
  it("expiry cycle changes when expiry instant changes (renewal re-alerts)", () => {
    expect(expiryCycleFingerprint(a)).toBe(expiryCycleFingerprint(a));
    expect(expiryCycleFingerprint(a)).not.toBe(expiryCycleFingerprint(b));
    expect(expiryCycleFingerprint(null)).toBe(expiryCycleFingerprint(null));
  });
  it("expiry dedupe key is stable within a cycle and per threshold", () => {
    const k1 = expiryDedupeKey("svc1", "3d", a, false);
    expect(k1).toBe(expiryDedupeKey("svc1", "3d", a, false));
    expect(k1).not.toBe(expiryDedupeKey("svc1", "1d", a, false));
    expect(k1).not.toBe(expiryDedupeKey("svc1", "3d", b, false));
    expect(k1).not.toBe(expiryDedupeKey("svc1", "3d", a, true)); // trial vs paid
  });
  it("quota cycle changes on volume OR expiry change (renew/extra-volume)", () => {
    const base = quotaCycleFingerprint(100n, a);
    expect(base).toBe(quotaCycleFingerprint(100n, a));
    expect(base).not.toBe(quotaCycleFingerprint(200n, a)); // extra volume
    expect(base).not.toBe(quotaCycleFingerprint(100n, b)); // renewal
    expect(trafficDedupeKey("s", 90, 100n, a)).not.toBe(trafficDedupeKey("s", 100, 100n, a));
  });
});

describe("quiet hours (wrap-aware, timezone)", () => {
  it("detects inside a midnight-wrapping window", () => {
    const q = { enabled: true, startMinutes: 23 * 60, endMinutes: 9 * 60 };
    expect(isWithinQuietWindow(23 * 60 + 30, q)).toBe(true);
    expect(isWithinQuietWindow(2 * 60, q)).toBe(true);
    expect(isWithinQuietWindow(10 * 60, q)).toBe(false);
  });
  it("disabled window never triggers", () => {
    const q = { enabled: false, startMinutes: 0, endMinutes: 600 };
    expect(isWithinQuietWindow(300, q)).toBe(false);
  });
  it("evaluateQuietHours postpones to the local end boundary", () => {
    // 04:00 UTC == 07:30 Asia/Tehran (UTC+3:30) -> inside 23:00-09:00 window.
    const now = new Date("2026-07-20T04:00:00Z");
    const q = { enabled: true, startMinutes: 23 * 60, endMinutes: 9 * 60 };
    const decision = evaluateQuietHours(now, q, "Asia/Tehran");
    expect(decision.quiet).toBe(true);
    expect(decision.nextAllowedAt).not.toBeNull();
    // resumes at 09:00 local == 05:30 UTC -> 90 minutes later.
    expect(decision.nextAllowedAt!.getTime() - now.getTime()).toBe(90 * MIN);
  });
  it("outside the window is not quiet", () => {
    const now = new Date("2026-07-20T12:00:00Z"); // 15:30 Tehran
    const q = { enabled: true, startMinutes: 23 * 60, endMinutes: 9 * 60 };
    expect(evaluateQuietHours(now, q, "Asia/Tehran").quiet).toBe(false);
  });
});

describe("preference gates", () => {
  const base: NotificationUserGates = {
    active: true,
    cronNotificationsEnabled: true,
    serviceNotificationsEnabled: true,
    paymentNotificationsEnabled: true,
    marketingMessagesEnabled: true,
  };
  it("cron master switch gates every category", () => {
    expect(isUserGateOpenForCategory({ ...base, cronNotificationsEnabled: false }, "SERVICE")).toBe(false);
  });
  it("inactive user is never eligible", () => {
    expect(isUserGateOpenForCategory({ ...base, active: false }, "SERVICE")).toBe(false);
  });
  it("category opt-out only affects that category", () => {
    expect(isUserGateOpenForCategory({ ...base, serviceNotificationsEnabled: false }, "SERVICE")).toBe(false);
    expect(isUserGateOpenForCategory({ ...base, serviceNotificationsEnabled: false }, "PAYMENT")).toBe(true);
  });
  it("per-service override can only tighten, and null inherits", () => {
    expect(isServiceKindGateOpen(base, "expiry", null)).toBe(true);
    expect(isServiceKindGateOpen(base, "expiry", { expiryEnabled: false, trafficEnabled: null, statusEnabled: null })).toBe(false);
    expect(isServiceKindGateOpen(base, "traffic", { expiryEnabled: false, trafficEnabled: null, statusEnabled: null })).toBe(true);
    // a disabled global SERVICE gate cannot be re-opened by a service override.
    expect(
      isServiceKindGateOpen({ ...base, serviceNotificationsEnabled: false }, "expiry", {
        expiryEnabled: true,
        trafficEnabled: true,
        statusEnabled: true,
      }),
    ).toBe(false);
  });
});

describe("effective delivery preferences layering", () => {
  const defaults = { timezone: "Asia/Tehran", quietHours: DEFAULT_QUIET_HOURS, dailyLimit: 3 };
  it("null row -> all defaults", () => {
    expect(buildEffectiveDeliveryPreferences(null, defaults)).toEqual(defaults);
  });
  it("user row overrides tz + daily limit + quiet window", () => {
    const eff = buildEffectiveDeliveryPreferences(
      {
        timezone: "Europe/Berlin",
        quietHoursEnabled: true,
        quietHoursStartMinutes: 60,
        quietHoursEndMinutes: 120,
        dailyAutomatedLimit: 7,
      },
      defaults,
    );
    expect(eff.timezone).toBe("Europe/Berlin");
    expect(eff.dailyLimit).toBe(7);
    expect(eff.quietHours).toEqual({ enabled: true, startMinutes: 60, endMinutes: 120 });
  });
  it("invalid tz falls back to the default", () => {
    expect(resolveTimezone("Mars/Phobos", "Asia/Tehran")).toBe("Asia/Tehran");
  });
});

describe("threshold parsing validation", () => {
  it("rejects malformed and keeps the fallback", () => {
    expect(parseExpiryThresholds("not json", DEFAULT_EXPIRY_THRESHOLDS)).toBe(DEFAULT_EXPIRY_THRESHOLDS);
    expect(parseTrafficThresholds("[0,101]", DEFAULT_TRAFFIC_THRESHOLDS)).toBe(DEFAULT_TRAFFIC_THRESHOLDS);
  });
  it("parses + sorts valid thresholds", () => {
    expect(parseTrafficThresholds("[100,80,90]", DEFAULT_TRAFFIC_THRESHOLDS)).toEqual([80, 90, 100]);
  });
});

describe("plan builders", () => {
  it("planExpiry produces the right type + template + buttons per bucket", () => {
    const now = new Date("2026-07-20T00:00:00Z");
    const near = service({ expiresAt: new Date(now.getTime() + 2 * 60 * MIN) }); // ~2h left -> 3h bucket
    const plan = planExpiry(near, ACTIVE_PANEL, DEFAULT_EXPIRY_THRESHOLDS, now, false);
    expect(plan?.type).toBe("SERVICE_EXPIRY");
    expect(plan?.serviceKind).toBe("expiry");
    expect(plan?.payload.templateKey).toBe("notif_service_expiry");
    expect(plan?.payload.buttons.some((b) => b.action === "r")).toBe(true); // renew (capable)
    const expired = service({ status: "EXPIRED", expiresAt: new Date(now.getTime() - MIN) });
    expect(planExpiry(expired, ACTIVE_PANEL, DEFAULT_EXPIRY_THRESHOLDS, now, false)?.type).toBe("SERVICE_EXPIRED");
  });
  it("trial plan yields TRIAL_* types and no renew button", () => {
    const now = new Date("2026-07-20T00:00:00Z");
    const trial = service({ expiresAt: new Date(now.getTime() + 9 * MIN) }); // 9m -> 10m bucket
    const plan = planExpiry(trial, ACTIVE_PANEL, DEFAULT_TRIAL_THRESHOLDS, now, true);
    expect(plan?.type).toBe("TRIAL_NEAR_EXPIRY");
    expect(plan?.payload.templateKey).toBe("notif_trial_near_expiry");
    expect(plan?.payload.buttons.some((b) => b.action === "r" || b.action === "v")).toBe(false);
  });
  it("planTraffic skips unlimited and fires at a crossed bucket", () => {
    const now = new Date();
    const unlimited = service({ volumeBytes: 0n, usedBytes: 5n });
    expect(planTraffic(unlimited, ACTIVE_PANEL, DEFAULT_TRAFFIC_THRESHOLDS, now)).toBeNull();
    const at90 = service({ volumeBytes: 100n, usedBytes: 92n });
    const plan = planTraffic(at90, ACTIVE_PANEL, DEFAULT_TRAFFIC_THRESHOLDS, now);
    expect(plan?.type).toBe("SERVICE_TRAFFIC");
    expect(plan?.payload.meta?.percent).toBe(90);
    expect(plan?.payload.buttons.some((b) => b.action === "v")).toBe(true); // extra-volume
  });
  it("planStatus fires only for LIMITED", () => {
    const now = new Date();
    expect(planStatus(service({ status: "ACTIVE" }), ACTIVE_PANEL, now)).toBeNull();
    expect(planStatus(service({ status: "LIMITED" }), ACTIVE_PANEL, now)?.type).toBe("SERVICE_LIMITED");
  });
});

describe("capability-aware buttons (no dead buttons)", () => {
  it("hides renew when the panel disables renewal", () => {
    const buttons = buildNotificationButtons("SERVICE_EXPIRED", service({ status: "EXPIRED" }), { status: "ACTIVE", renewalEnabled: false }, false);
    expect(buttons.some((b) => b.action === "r")).toBe(false);
    expect(buttons.some((b) => b.action === "s")).toBe(true); // always openable
    expect(buttons.some((b) => b.action === "x")).toBe(true); // dismiss
  });
  it("hides extra-volume on an unlimited service", () => {
    const buttons = buildNotificationButtons("SERVICE_TRAFFIC", service({ volumeBytes: 0n }), ACTIVE_PANEL, false);
    expect(buttons.some((b) => b.action === "v")).toBe(false);
  });
});

describe("service display name never leaks the raw remote username", () => {
  it("prefers a friendly name, else masks the username", () => {
    expect(serviceDisplayName(service({ productNameSnapshot: "پلن طلایی" }))).toBe("پلن طلایی");
    const masked = serviceDisplayName(service({ username: "abcdef-remote-technical-id" }));
    expect(masked).not.toContain("remote-technical-id");
  });
});

describe("service-state freshness + safe sync mapper", () => {
  it("freshness respects the max-age window", () => {
    const now = new Date();
    expect(isServiceStateFresh({ lastSubscriptionUpdateAt: null }, 20, now)).toBe(false);
    expect(isServiceStateFresh({ lastSubscriptionUpdateAt: new Date(now.getTime() - 5 * MIN) }, 20, now)).toBe(true);
    expect(isServiceStateFresh({ lastSubscriptionUpdateAt: new Date(now.getTime() - 25 * MIN) }, 20, now)).toBe(false);
  });
  it("sync mapper returns null on a failed read (row untouched)", () => {
    expect(buildServiceSyncUpdate({ ok: false, errorMessage: "x" })).toBeNull();
  });
  it("sync mapper stores unlimited as 0n and never blanks the sub url", () => {
    const update = buildServiceSyncUpdate({ ok: true, usedBytes: 10n, totalBytes: null, subscriptionUrl: "" });
    expect(update).not.toBeNull();
    expect(update?.volumeBytes).toBe(0n);
    expect(update?.subscriptionUrl).toBeUndefined();
    expect(update?.lastSubscriptionUpdateAt).toBeInstanceOf(Date);
  });
});
