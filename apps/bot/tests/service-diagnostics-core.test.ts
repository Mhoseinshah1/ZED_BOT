import type { Panel, Service } from "@zedbot/database";
import {
  buildDiagnosticSnapshot,
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_SNAPSHOT_MAX_CHECKS,
  DIAGNOSTIC_SNAPSHOT_VERSION,
  resolveDiagnosticsCooldownSeconds,
  resolveDiagnosticsReadTimeoutMs,
  resolveDiagnosticsRecentConnectionHours,
  SERVICE_DIAGNOSTIC_CHECK_KEYS,
  SERVICE_DIAGNOSTICS_COOLDOWN_DEFAULT,
  SERVICE_DIAGNOSTICS_COOLDOWN_MAX,
  SERVICE_DIAGNOSTICS_COOLDOWN_MIN,
  SERVICE_DIAGNOSTICS_RECENT_CONNECTION_DEFAULT,
  validateDiagnosticSnapshot,
  worstOverall,
  worstOverallOf,
  type ServiceDiagnosticReport,
} from "@zedbot/shared";
import { describe, expect, it } from "vitest";

import {
  type DiagnosticCheckResult,
  type DiagnosticEvidence,
  diagnosticCheckMessage,
  evaluateDiagnosticChecks,
  primaryRecommendation,
  resolveRecommendedActions,
} from "../src/services/service-diagnostics.service.js";
import type { PanelReadOutcome } from "../src/services/service-sync.service.js";
import type { ServiceDetailActions } from "../src/services/user-services.service.js";

// =============================================================================
// Service self-diagnostics — PURE rule-engine tests (no DB). Covers every check
// rule, the deterministic overall precedence, action generation, the strict
// snapshot schema, and the bounded setting resolvers.
// =============================================================================

const GIB = 1024n * 1024n * 1024n;
const NOW = new Date("2026-07-21T12:00:00.000Z");
const c = DIAGNOSTIC_CODES;

function svc(overrides: Partial<Service> = {}): Service {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    userId: "user-1",
    status: "ACTIVE",
    volumeBytes: 10n * GIB,
    usedBytes: 1n * GIB,
    remainingBytes: 9n * GIB,
    expiresAt: new Date(NOW.getTime() + 30 * 86_400_000),
    firstConnectedAt: new Date(NOW.getTime() - 3 * 86_400_000),
    lastConnectedAt: new Date(NOW.getTime() - 3_600_000),
    lastSubscriptionUpdateAt: NOW,
    subscriptionUrl: "https://sub.example.com/token",
    configLinks: ["vmess://x"],
    ...overrides,
  } as unknown as Service;
}

function panel(status = "ACTIVE"): Panel {
  return { id: "panel-1", status, type: "marzban" } as unknown as Panel;
}

interface AccountShape {
  ok: boolean;
  notFound?: boolean;
  totalBytes?: bigint | null;
  remainingBytes?: bigint | null;
  expiresAt?: Date | null;
  lastConnectedAt?: Date | null;
  firstConnectedAt?: Date | null;
}

function readOk(account: AccountShape = { ok: true }): PanelReadOutcome {
  return {
    kind: "read-ok",
    service: null,
    panelType: "marzban",
    account: account as never,
    diagnosticCode: null,
  };
}

function readOutcome(
  kind: PanelReadOutcome["kind"],
  diagnosticCode: string | null = null,
): PanelReadOutcome {
  return { kind, service: null, panelType: "marzban", account: null, diagnosticCode };
}

function evidence(overrides: Partial<DiagnosticEvidence> = {}): DiagnosticEvidence {
  return {
    service: svc(),
    panel: panel(),
    read: readOk(),
    evidenceSource: "LIVE_PANEL",
    readSupported: true,
    recentConnectionHours: 72,
    now: NOW,
    ...overrides,
  };
}

function codeOf(checks: DiagnosticCheckResult[], key: string): string {
  return checks.find((ck) => ck.key === key)?.code ?? "MISSING";
}
function statusOf(checks: DiagnosticCheckResult[], key: string): string {
  return checks.find((ck) => ck.key === key)?.status ?? "MISSING";
}

const NO_ACTIONS: ServiceDetailActions = {
  toggleAction: null,
  canBuyExtraVolume: false,
  canBuyExtraTime: false,
  canRegenerateLink: false,
  canRenew: false,
};

describe("service-diagnostics: SERVICE_STATE", () => {
  it("ACTIVE + healthy live read → HEALTHY", () => {
    const { checks, overall } = evaluateDiagnosticChecks(evidence());
    expect(overall).toBe("HEALTHY");
    expect(codeOf(checks, "SERVICE_STATE")).toBe(c.SERVICE_STATE_ACTIVE);
    expect(checks).toHaveLength(SERVICE_DIAGNOSTIC_CHECK_KEYS.length);
  });

  it("DISABLED → ACTION_REQUIRED", () => {
    const { checks, overall } = evaluateDiagnosticChecks(
      evidence({ service: svc({ status: "DISABLED" }) }),
    );
    expect(overall).toBe("ACTION_REQUIRED");
    expect(codeOf(checks, "SERVICE_STATE")).toBe(c.SERVICE_STATE_DISABLED);
  });

  it("EXPIRED → ACTION_REQUIRED even with a healthy payload", () => {
    const { overall } = evaluateDiagnosticChecks(
      evidence({ service: svc({ status: "EXPIRED", expiresAt: new Date(NOW.getTime() - 86_400_000) }) }),
    );
    expect(overall).toBe("ACTION_REQUIRED");
  });

  it("LIMITED → ACTION_REQUIRED", () => {
    const { overall } = evaluateDiagnosticChecks(
      evidence({ service: svc({ status: "LIMITED", remainingBytes: 0n }) }),
    );
    expect(overall).toBe("ACTION_REQUIRED");
  });

  it("CREATING → DEGRADED", () => {
    const { checks, overall } = evaluateDiagnosticChecks(
      evidence({ service: svc({ status: "CREATING" }) }),
    );
    expect(overall).toBe("DEGRADED");
    expect(codeOf(checks, "SERVICE_STATE")).toBe(c.SERVICE_STATE_CREATING);
  });

  it("FAILED → NEEDS_SUPPORT", () => {
    const { checks, overall } = evaluateDiagnosticChecks(
      evidence({ service: svc({ status: "FAILED" }) }),
    );
    expect(overall).toBe("NEEDS_SUPPORT");
    expect(codeOf(checks, "SERVICE_STATE")).toBe(c.SERVICE_STATE_FAILED);
  });
});

describe("service-diagnostics: PANEL_STATE + PANEL_ACCOUNT", () => {
  it("missing panel → NEEDS_SUPPORT", () => {
    const { checks, overall } = evaluateDiagnosticChecks(evidence({ panel: null, read: null }));
    expect(overall).toBe("NEEDS_SUPPORT");
    expect(codeOf(checks, "PANEL_STATE")).toBe(c.PANEL_MISSING);
  });

  it("inactive panel → UNAVAILABLE", () => {
    const { checks, overall } = evaluateDiagnosticChecks(
      evidence({ panel: panel("MAINTENANCE"), read: readOutcome("panel-inactive"), readSupported: false }),
    );
    expect(overall).toBe("UNAVAILABLE");
    expect(codeOf(checks, "PANEL_STATE")).toBe(c.PANEL_INACTIVE);
  });

  it("adapter without readService → PANEL_READ_UNSUPPORTED + ACCOUNT_UNVERIFIED, stored-only degrades", () => {
    const { checks, overall } = evaluateDiagnosticChecks(
      evidence({ read: null, readSupported: false, evidenceSource: "STORED_ONLY" }),
    );
    expect(codeOf(checks, "PANEL_STATE")).toBe(c.PANEL_READ_UNSUPPORTED);
    expect(codeOf(checks, "PANEL_ACCOUNT")).toBe(c.ACCOUNT_UNVERIFIED);
    // Stored-only evidence degrades an otherwise-healthy service.
    expect(overall).toBe("DEGRADED");
  });

  it("read-unsupported but FRESH_CACHE does NOT degrade a healthy service", () => {
    const { overall } = evaluateDiagnosticChecks(
      evidence({ read: null, readSupported: false, evidenceSource: "FRESH_CACHE" }),
    );
    expect(overall).toBe("HEALTHY");
  });

  it("unreachable → UNAVAILABLE, timeout → PANEL_TIMEOUT", () => {
    const unreachable = evaluateDiagnosticChecks(
      evidence({ read: readOutcome("unreachable", "unreachable"), evidenceSource: "STORED_ONLY" }),
    );
    expect(unreachable.overall).toBe("UNAVAILABLE");
    expect(codeOf(unreachable.checks, "PANEL_STATE")).toBe(c.PANEL_UNREACHABLE);

    const timeout = evaluateDiagnosticChecks(
      evidence({ read: readOutcome("unreachable", "timeout"), evidenceSource: "STORED_ONLY" }),
    );
    expect(codeOf(timeout.checks, "PANEL_STATE")).toBe(c.PANEL_TIMEOUT);
  });

  it("auth failure → NEEDS_SUPPORT (overrides local ACTIVE)", () => {
    const { checks, overall } = evaluateDiagnosticChecks(
      evidence({ read: readOutcome("auth-failed", "auth-failed"), evidenceSource: "STORED_ONLY" }),
    );
    expect(overall).toBe("NEEDS_SUPPORT");
    expect(codeOf(checks, "PANEL_STATE")).toBe(c.PANEL_AUTH_FAILED);
  });

  it("lock contention → PANEL_BUSY / DEGRADED (retryable, never an exception)", () => {
    const { checks, overall } = evaluateDiagnosticChecks(
      evidence({ read: readOutcome("read-error", "locked"), evidenceSource: "FRESH_CACHE" }),
    );
    expect(codeOf(checks, "PANEL_STATE")).toBe(c.PANEL_BUSY);
    expect(overall).toBe("DEGRADED");
  });

  it("positive notFound → NEEDS_SUPPORT and overrides valid local quota", () => {
    const { checks, overall } = evaluateDiagnosticChecks(
      evidence({ read: readOutcome("not-found"), evidenceSource: "LIVE_PANEL" }),
    );
    expect(overall).toBe("NEEDS_SUPPORT");
    expect(codeOf(checks, "PANEL_ACCOUNT")).toBe(c.ACCOUNT_NOT_FOUND);
    // Panel answered (it reported absence), so PANEL_STATE is OK.
    expect(codeOf(checks, "PANEL_STATE")).toBe(c.PANEL_OK);
  });
});

describe("service-diagnostics: QUOTA", () => {
  it("unlimited (totalBytes null) is INFO, never zero", () => {
    const { checks } = evaluateDiagnosticChecks(evidence({ read: readOk({ ok: true, totalBytes: null }) }));
    expect(codeOf(checks, "QUOTA")).toBe(c.QUOTA_UNLIMITED);
    expect(statusOf(checks, "QUOTA")).toBe("INFO");
  });

  it("finite remaining <= 0 → QUOTA_EXHAUSTED / ACTION_REQUIRED", () => {
    const { checks, overall } = evaluateDiagnosticChecks(
      evidence({ read: readOk({ ok: true, totalBytes: 10n * GIB, remainingBytes: 0n }) }),
    );
    expect(codeOf(checks, "QUOTA")).toBe(c.QUOTA_EXHAUSTED);
    expect(overall).toBe("ACTION_REQUIRED");
  });

  it("missing panel quota (totalBytes undefined) stays UNKNOWN, not zero", () => {
    const { checks } = evaluateDiagnosticChecks(evidence({ read: readOk({ ok: true }) }));
    expect(codeOf(checks, "QUOTA")).toBe(c.QUOTA_UNKNOWN);
  });

  it("stored volumeBytes 0 (unlimited convention) is not exhausted", () => {
    const { checks } = evaluateDiagnosticChecks(
      evidence({ read: null, readSupported: false, service: svc({ volumeBytes: 0n, remainingBytes: 0n }) }),
    );
    expect(codeOf(checks, "QUOTA")).toBe(c.QUOTA_UNLIMITED);
  });
});

describe("service-diagnostics: EXPIRY", () => {
  it("never-expiring (null) is not expired", () => {
    const { checks } = evaluateDiagnosticChecks(evidence({ read: readOk({ ok: true, expiresAt: null }) }));
    expect(codeOf(checks, "EXPIRY")).toBe(c.EXPIRY_NONE);
  });

  it("live expired → ACTION_REQUIRED", () => {
    const { checks, overall } = evaluateDiagnosticChecks(
      evidence({ read: readOk({ ok: true, expiresAt: new Date(NOW.getTime() - 3_600_000) }) }),
    );
    expect(codeOf(checks, "EXPIRY")).toBe(c.EXPIRY_EXPIRED);
    expect(overall).toBe("ACTION_REQUIRED");
  });

  it("near-expiry is an advisory WARNING, not a state change", () => {
    const { checks, overall } = evaluateDiagnosticChecks(
      evidence({ read: readOk({ ok: true, expiresAt: new Date(NOW.getTime() + 2 * 86_400_000) }) }),
    );
    expect(codeOf(checks, "EXPIRY")).toBe(c.EXPIRY_NEAR);
    expect(overall).toBe("HEALTHY");
  });

  it("missing panel expiry stays UNKNOWN", () => {
    const { checks } = evaluateDiagnosticChecks(
      evidence({ read: readOk({ ok: true, totalBytes: null }) }),
    );
    expect(codeOf(checks, "EXPIRY")).toBe(c.EXPIRY_UNKNOWN);
  });
});

describe("service-diagnostics: CONNECTION_PAYLOAD", () => {
  it("subscription url present → PASS", () => {
    const { checks } = evaluateDiagnosticChecks(evidence());
    expect(codeOf(checks, "CONNECTION_PAYLOAD")).toBe(c.PAYLOAD_PRESENT);
  });

  it("no url and no configs → FAIL / ACTION_REQUIRED", () => {
    const { checks, overall } = evaluateDiagnosticChecks(
      evidence({ service: svc({ subscriptionUrl: null, configLinks: [] }) }),
    );
    expect(codeOf(checks, "CONNECTION_PAYLOAD")).toBe(c.PAYLOAD_MISSING);
    expect(overall).toBe("ACTION_REQUIRED");
  });
});

describe("service-diagnostics: CONNECTION_HISTORY", () => {
  it("recent lastConnectedAt → PASS", () => {
    const { checks } = evaluateDiagnosticChecks(evidence());
    expect(codeOf(checks, "CONNECTION_HISTORY")).toBe(c.HISTORY_RECENT);
  });

  it("old lastConnectedAt is a WARNING, not proof of failure (stays HEALTHY)", () => {
    const { checks, overall } = evaluateDiagnosticChecks(
      evidence({ service: svc({ lastConnectedAt: new Date(NOW.getTime() - 30 * 86_400_000) }) }),
    );
    expect(codeOf(checks, "CONNECTION_HISTORY")).toBe(c.HISTORY_OLD);
    expect(overall).toBe("HEALTHY");
  });

  it("never connected with reported history fields → HISTORY_NONE / DEGRADED", () => {
    const { checks, overall } = evaluateDiagnosticChecks(
      evidence({
        service: svc({ firstConnectedAt: null, lastConnectedAt: null }),
        read: readOk({ ok: true, totalBytes: 10n * GIB, remainingBytes: 9n * GIB, lastConnectedAt: null }),
      }),
    );
    expect(codeOf(checks, "CONNECTION_HISTORY")).toBe(c.HISTORY_NONE);
    expect(overall).toBe("DEGRADED");
  });

  it("unsupported connection-history evidence stays UNKNOWN and does NOT degrade", () => {
    const { checks, overall } = evaluateDiagnosticChecks(
      evidence({
        service: svc({ firstConnectedAt: null, lastConnectedAt: null }),
        read: readOk({ ok: true, totalBytes: 10n * GIB, remainingBytes: 9n * GIB }),
      }),
    );
    expect(codeOf(checks, "CONNECTION_HISTORY")).toBe(c.HISTORY_UNKNOWN);
    expect(overall).toBe("HEALTHY");
  });
});

describe("service-diagnostics: DATA_FRESHNESS", () => {
  it("live / cache / stored map to the right codes", () => {
    expect(codeOf(evaluateDiagnosticChecks(evidence({ evidenceSource: "LIVE_PANEL" })).checks, "DATA_FRESHNESS")).toBe(
      c.FRESHNESS_LIVE,
    );
    expect(codeOf(evaluateDiagnosticChecks(evidence({ evidenceSource: "FRESH_CACHE" })).checks, "DATA_FRESHNESS")).toBe(
      c.FRESHNESS_CACHE,
    );
    expect(
      codeOf(
        evaluateDiagnosticChecks(evidence({ read: null, readSupported: false, evidenceSource: "STORED_ONLY" })).checks,
        "DATA_FRESHNESS",
      ),
    ).toBe(c.FRESHNESS_STORED);
  });
});

describe("service-diagnostics: overall precedence", () => {
  it("worstOverall ranks NEEDS_SUPPORT > UNAVAILABLE > ACTION_REQUIRED > DEGRADED > HEALTHY", () => {
    expect(worstOverall("HEALTHY", "DEGRADED")).toBe("DEGRADED");
    expect(worstOverall("ACTION_REQUIRED", "UNAVAILABLE")).toBe("UNAVAILABLE");
    expect(worstOverall("UNAVAILABLE", "NEEDS_SUPPORT")).toBe("NEEDS_SUPPORT");
    expect(worstOverallOf(["HEALTHY", "ACTION_REQUIRED", "DEGRADED"])).toBe("ACTION_REQUIRED");
    expect(worstOverallOf([])).toBe("HEALTHY");
  });

  it("HEALTHY only when every authoritative check passes", () => {
    const { overall } = evaluateDiagnosticChecks(
      evidence({ read: readOk({ ok: true, totalBytes: 10n * GIB, remainingBytes: 9n * GIB, expiresAt: new Date(NOW.getTime() + 30 * 86_400_000), lastConnectedAt: new Date(NOW.getTime() - 3_600_000) }) }),
    );
    expect(overall).toBe("HEALTHY");
  });
});

describe("service-diagnostics: recommended actions", () => {
  function actionsFor(overrides: Partial<DiagnosticEvidence>, detail: ServiceDetailActions = NO_ACTIONS, guide = false) {
    const ev = evidence(overrides);
    const { checks, overall } = evaluateDiagnosticChecks(ev);
    return resolveRecommendedActions(overall, checks, {
      service: ev.service,
      actions: detail,
      guideAvailable: guide,
      hasSubscriptionUrl: ev.service.subscriptionUrl !== null && ev.service.subscriptionUrl !== "",
      hasConfigs: Array.isArray(ev.service.configLinks) && ev.service.configLinks.length > 0,
    });
  }

  it("DISABLED recommends enable ONLY when eligible", () => {
    const eligible = actionsFor({ service: svc({ status: "DISABLED" }) }, { ...NO_ACTIONS, toggleAction: "ENABLE" });
    expect(eligible[0]).toBe("ENABLE_SERVICE");
    const ineligible = actionsFor({ service: svc({ status: "DISABLED" }) }, NO_ACTIONS);
    expect(ineligible).not.toContain("ENABLE_SERVICE");
    expect(ineligible[0]).toBe("OPEN_SUPPORT");
  });

  it("EXPIRED recommends renewal only when eligible", () => {
    const eligible = actionsFor(
      { service: svc({ status: "EXPIRED", expiresAt: new Date(NOW.getTime() - 86_400_000) }) },
      { ...NO_ACTIONS, canRenew: true },
    );
    expect(eligible[0]).toBe("RENEW_SERVICE");
  });

  it("LIMITED recommends volume/renewal per eligibility", () => {
    const actions = actionsFor(
      { service: svc({ status: "LIMITED", remainingBytes: 0n }) },
      { ...NO_ACTIONS, canBuyExtraVolume: true, canRenew: true },
    );
    expect(actions[0]).toBe("BUY_EXTRA_VOLUME");
    expect(actions).toContain("RENEW_SERVICE");
  });

  it("no payload recommends regeneration only when eligible, else support", () => {
    const regen = actionsFor(
      { service: svc({ subscriptionUrl: null, configLinks: [] }) },
      { ...NO_ACTIONS, canRegenerateLink: true },
    );
    expect(regen[0]).toBe("REGENERATE_LINK");
    const noRegen = actionsFor({ service: svc({ subscriptionUrl: null, configLinks: [] }) }, NO_ACTIONS);
    expect(noRegen).not.toContain("REGENERATE_LINK");
    expect(noRegen[0]).toBe("OPEN_SUPPORT");
  });

  it("never-connected recommends guide/link/QR", () => {
    const actions = actionsFor(
      {
        service: svc({ firstConnectedAt: null, lastConnectedAt: null }),
        read: readOk({ ok: true, totalBytes: 10n * GIB, remainingBytes: 9n * GIB, lastConnectedAt: null }),
      },
      NO_ACTIONS,
      true,
    );
    expect(actions[0]).toBe("OPEN_CONNECTION_GUIDE");
    expect(actions).toContain("SHOW_SUBSCRIPTION_LINK");
  });

  it("NEEDS_SUPPORT leads with support and never a mutation", () => {
    const actions = actionsFor({ read: readOutcome("not-found") }, { ...NO_ACTIONS, canRenew: true });
    expect(actions[0]).toBe("OPEN_SUPPORT");
    expect(actions).not.toContain("REGENERATE_LINK");
  });

  it("UNAVAILABLE leads with retry, never a panel mutation", () => {
    const actions = actionsFor(
      { read: readOutcome("unreachable", "unreachable"), evidenceSource: "STORED_ONLY" },
      { ...NO_ACTIONS, canRenew: true },
    );
    expect(actions[0]).toBe("RETRY_DIAGNOSTIC");
    expect(actions).not.toContain("RENEW_SERVICE");
  });

  it("retry + support are always present", () => {
    const actions = actionsFor({});
    expect(actions).toContain("RETRY_DIAGNOSTIC");
    expect(actions).toContain("OPEN_SUPPORT");
  });

  it("primaryRecommendation is the first action", () => {
    expect(primaryRecommendation(["RENEW_SERVICE", "OPEN_SUPPORT"])).toBe("RENEW_SERVICE");
    expect(primaryRecommendation([])).toBeUndefined();
  });
});

describe("service-diagnostics: snapshot schema", () => {
  function report(overrides: Partial<ServiceDiagnosticReport> = {}): ServiceDiagnosticReport {
    return {
      overall: "ACTION_REQUIRED",
      evidenceSource: "LIVE_PANEL",
      checkedAt: NOW,
      checks: [
        { key: "QUOTA", status: "FAIL", code: c.QUOTA_EXHAUSTED, userMessage: "x" },
        { key: "EXPIRY", status: "PASS", code: c.EXPIRY_OK, userMessage: "y" },
      ],
      recommendedActions: ["RENEW_SERVICE", "OPEN_SUPPORT"],
      ...overrides,
    };
  }

  it("builds a valid snapshot that round-trips through the validator", () => {
    const snap = buildDiagnosticSnapshot(report(), "RENEW_SERVICE");
    expect(snap.version).toBe(DIAGNOSTIC_SNAPSHOT_VERSION);
    expect(snap.primaryRecommendation).toBe("RENEW_SERVICE");
    const validated = validateDiagnosticSnapshot(snap);
    expect(validated).not.toBeNull();
    expect(validated?.checks).toHaveLength(2);
  });

  it("carries only key/status/code per check — no free-form or secret fields", () => {
    const snap = buildDiagnosticSnapshot(report());
    for (const check of snap.checks) {
      expect(Object.keys(check).sort()).toEqual(["code", "key", "status"]);
    }
    expect(JSON.stringify(snap)).not.toContain("userMessage");
  });

  it("rejects unknown enum members, over-length codes and too many checks", () => {
    expect(validateDiagnosticSnapshot({ ...buildDiagnosticSnapshot(report()), overall: "BOGUS" })).toBeNull();
    expect(
      validateDiagnosticSnapshot({
        ...buildDiagnosticSnapshot(report()),
        checks: [{ key: "QUOTA", status: "FAIL", code: "x".repeat(60) }],
      }),
    ).toBeNull();
    expect(
      validateDiagnosticSnapshot({
        ...buildDiagnosticSnapshot(report()),
        checks: Array.from({ length: DIAGNOSTIC_SNAPSHOT_MAX_CHECKS + 1 }, () => ({
          key: "QUOTA",
          status: "FAIL",
          code: c.QUOTA_EXHAUSTED,
        })),
      }),
    ).toBeNull();
  });

  it("rejects a wrong version and non-object input", () => {
    expect(validateDiagnosticSnapshot({ ...buildDiagnosticSnapshot(report()), version: 2 })).toBeNull();
    expect(validateDiagnosticSnapshot(null)).toBeNull();
    expect(validateDiagnosticSnapshot("nope")).toBeNull();
    expect(validateDiagnosticSnapshot(42)).toBeNull();
  });

  it("rejects an injected secret-shaped field inside a check", () => {
    const snap = buildDiagnosticSnapshot(report()) as unknown as Record<string, unknown>;
    (snap.checks as Array<Record<string, unknown>>)[0].token = "https://sub.example.com/SECRET";
    const validated = validateDiagnosticSnapshot(snap);
    // The validator strips unknown fields — the round-trip never carries `token`.
    expect(JSON.stringify(validated)).not.toContain("SECRET");
    expect(JSON.stringify(validated)).not.toContain("token");
  });
});

describe("service-diagnostics: bounded setting resolvers", () => {
  it("cooldown clamps to [min,max] with the right default", () => {
    expect(resolveDiagnosticsCooldownSeconds(null)).toBe(SERVICE_DIAGNOSTICS_COOLDOWN_DEFAULT);
    expect(resolveDiagnosticsCooldownSeconds("1")).toBe(SERVICE_DIAGNOSTICS_COOLDOWN_DEFAULT);
    expect(resolveDiagnosticsCooldownSeconds("99999")).toBe(SERVICE_DIAGNOSTICS_COOLDOWN_DEFAULT);
    expect(resolveDiagnosticsCooldownSeconds(String(SERVICE_DIAGNOSTICS_COOLDOWN_MIN))).toBe(
      SERVICE_DIAGNOSTICS_COOLDOWN_MIN,
    );
    expect(resolveDiagnosticsCooldownSeconds(String(SERVICE_DIAGNOSTICS_COOLDOWN_MAX))).toBe(
      SERVICE_DIAGNOSTICS_COOLDOWN_MAX,
    );
    expect(resolveDiagnosticsCooldownSeconds("45")).toBe(45);
  });

  it("recent-connection clamps to bounds", () => {
    expect(resolveDiagnosticsRecentConnectionHours(null)).toBe(SERVICE_DIAGNOSTICS_RECENT_CONNECTION_DEFAULT);
    expect(resolveDiagnosticsRecentConnectionHours("0")).toBe(SERVICE_DIAGNOSTICS_RECENT_CONNECTION_DEFAULT);
    expect(resolveDiagnosticsRecentConnectionHours("100000")).toBe(SERVICE_DIAGNOSTICS_RECENT_CONNECTION_DEFAULT);
    expect(resolveDiagnosticsRecentConnectionHours("48")).toBe(48);
  });

  it("read timeout clamps to bounds", () => {
    expect(resolveDiagnosticsReadTimeoutMs(undefined)).toBeGreaterThan(0);
    expect(resolveDiagnosticsReadTimeoutMs("999999")).toBeLessThanOrEqual(30_000);
    expect(resolveDiagnosticsReadTimeoutMs("1")).toBeGreaterThanOrEqual(1_000);
  });
});

describe("service-diagnostics: Persian rendering is code-driven", () => {
  it("every known check code maps to a non-empty Persian line", () => {
    for (const code of Object.values(DIAGNOSTIC_CODES)) {
      const msg = diagnosticCheckMessage(code);
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).not.toBe(code); // a real translation, not the raw code
    }
  });
});
