import type { Panel, Service } from "@zedbot/database";
import {
  buildDiagnosticSnapshot,
  DIAGNOSTIC_CODE_CONTRACT,
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_SNAPSHOT_MAX_CHECKS,
  DIAGNOSTIC_SNAPSHOT_REQUIRED_KEYS,
  DIAGNOSTIC_SNAPSHOT_VERSION,
  diagnosticCodeSpec,
  KNOWN_DIAGNOSTIC_CODES,
  resolveDiagnosticsCooldownSeconds,
  resolveDiagnosticsReadTimeoutMs,
  resolveDiagnosticsRecentConnectionHours,
  SERVICE_DIAGNOSTIC_CHECK_KEYS,
  SERVICE_DIAGNOSTIC_CHECK_STATUSES,
  SERVICE_DIAGNOSTICS_COOLDOWN_DEFAULT,
  SERVICE_DIAGNOSTICS_COOLDOWN_MAX,
  SERVICE_DIAGNOSTICS_COOLDOWN_MIN,
  SERVICE_DIAGNOSTICS_RECENT_CONNECTION_DEFAULT,
  validateDiagnosticSnapshot,
  worstOverall,
  worstOverallOf,
  type DiagnosticSnapshotCheck,
  type ServiceDiagnosticCheck,
  type ServiceDiagnosticReport,
} from "@zedbot/shared";
import { describe, expect, it } from "vitest";

import { detailText } from "../src/handlers/admin-support/support-admin.handler.js";
import {
  type DiagnosticCheckResult,
  type DiagnosticEvidence,
  diagnosticCheckMessage,
  evaluateDiagnosticChecks,
  primaryRecommendation,
  resolveRecommendedActions,
} from "../src/services/service-diagnostics.service.js";
import type { PanelReadOutcome } from "../src/services/service-sync.service.js";
import { TICKET_MESSAGE_MAX } from "../src/services/support-ticket.service.js";
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

  it("finite total but omitted remaining stays UNKNOWN, never a reassuring PASS", () => {
    const { checks } = evaluateDiagnosticChecks(
      evidence({ read: readOk({ ok: true, totalBytes: 10n * GIB }) }),
    );
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
  // A full, canonical, VALID report — one check per authoritative key (a real
  // report always emits all of them). Strict validation requires the EXACT set.
  const FULL_CHECKS: ServiceDiagnosticCheck[] = [
    { key: "SERVICE_STATE", status: "PASS", code: c.SERVICE_STATE_ACTIVE, userMessage: "a" },
    { key: "PANEL_STATE", status: "PASS", code: c.PANEL_OK, userMessage: "b" },
    { key: "PANEL_ACCOUNT", status: "PASS", code: c.ACCOUNT_PRESENT, userMessage: "c" },
    { key: "QUOTA", status: "PASS", code: c.QUOTA_OK, userMessage: "d" },
    { key: "EXPIRY", status: "PASS", code: c.EXPIRY_OK, userMessage: "e" },
    { key: "CONNECTION_PAYLOAD", status: "PASS", code: c.PAYLOAD_PRESENT, userMessage: "f" },
    { key: "CONNECTION_HISTORY", status: "PASS", code: c.HISTORY_RECENT, userMessage: "g" },
    { key: "DATA_FRESHNESS", status: "INFO", code: c.FRESHNESS_LIVE, userMessage: "h" },
  ];
  function report(overrides: Partial<ServiceDiagnosticReport> = {}): ServiceDiagnosticReport {
    return {
      overall: "HEALTHY",
      evidenceSource: "LIVE_PANEL",
      checkedAt: NOW,
      checks: FULL_CHECKS.map((ck) => ({ ...ck })),
      recommendedActions: ["RETRY_DIAGNOSTIC", "OPEN_SUPPORT"],
      ...overrides,
    };
  }
  /** A validator-shaped snapshot check (key/status/code only). */
  function snapCheck(
    key: (typeof SERVICE_DIAGNOSTIC_CHECK_KEYS)[number],
    status: string,
    code: string,
  ): DiagnosticSnapshotCheck {
    return { key, status: status as DiagnosticSnapshotCheck["status"], code };
  }
  /** The canonical, fully-valid v1 snapshot as a plain record for mutation. */
  function validSnap(): Record<string, unknown> {
    return buildDiagnosticSnapshot(report(), "RETRY_DIAGNOSTIC") as unknown as Record<string, unknown>;
  }

  it("builds a valid snapshot that round-trips through the validator", () => {
    const snap = buildDiagnosticSnapshot(report(), "RETRY_DIAGNOSTIC");
    expect(snap.version).toBe(DIAGNOSTIC_SNAPSHOT_VERSION);
    expect(snap.primaryRecommendation).toBe("RETRY_DIAGNOSTIC");
    const validated = validateDiagnosticSnapshot(snap);
    expect(validated).not.toBeNull();
    expect(validated?.checks).toHaveLength(SERVICE_DIAGNOSTIC_CHECK_KEYS.length);
  });

  it("carries only key/status/code per check — no free-form or secret fields", () => {
    const snap = buildDiagnosticSnapshot(report());
    for (const check of snap.checks) {
      expect(Object.keys(check).sort()).toEqual(["code", "key", "status"]);
    }
    expect(JSON.stringify(snap)).not.toContain("userMessage");
  });

  // --- §2 contract completeness -------------------------------------------------

  it("the code contract covers EXACTLY the known codes (no missing, no extra)", () => {
    const contractCodes = Object.keys(DIAGNOSTIC_CODE_CONTRACT).sort();
    const knownCodes = [...KNOWN_DIAGNOSTIC_CODES].sort();
    expect(contractCodes).toEqual(knownCodes);
  });

  it("every code's contract key + statuses are members of the typed enums", () => {
    for (const [code, spec] of Object.entries(DIAGNOSTIC_CODE_CONTRACT)) {
      expect(SERVICE_DIAGNOSTIC_CHECK_KEYS).toContain(spec.key);
      expect(spec.statuses.length).toBeGreaterThan(0);
      for (const status of spec.statuses) {
        expect(SERVICE_DIAGNOSTIC_CHECK_STATUSES).toContain(status);
      }
      expect(diagnosticCodeSpec(code)).toBe(spec);
    }
    expect(diagnosticCodeSpec("NOT_A_REAL_CODE")).toBeNull();
    // Prototype pollution guard: `toString`/`constructor` are not "known" codes.
    expect(diagnosticCodeSpec("toString")).toBeNull();
    expect(diagnosticCodeSpec("constructor")).toBeNull();
  });

  it("the evaluator only ever emits codes/statuses that satisfy the contract", () => {
    // Cross-check the deterministic engine against the contract over many inputs.
    for (const key of SERVICE_DIAGNOSTIC_CHECK_KEYS) {
      const codesForKey = Object.entries(DIAGNOSTIC_CODE_CONTRACT)
        .filter(([, spec]) => spec.key === key)
        .map(([code]) => code);
      expect(codesForKey.length).toBeGreaterThan(0);
    }
  });

  // --- §2 strict acceptance -----------------------------------------------------

  it("normalizes checks to canonical order regardless of input ordering", () => {
    const snap = validSnap();
    snap.checks = [...(snap.checks as unknown[])].reverse();
    const validated = validateDiagnosticSnapshot(snap);
    expect(validated).not.toBeNull();
    expect(validated?.checks.map((ck) => ck.key)).toEqual([...SERVICE_DIAGNOSTIC_CHECK_KEYS]);
  });

  it("accepts an optional primaryRecommendation only when it is a known action", () => {
    expect(validateDiagnosticSnapshot({ ...validSnap(), primaryRecommendation: "OPEN_SUPPORT" })).not.toBeNull();
    expect(validateDiagnosticSnapshot({ ...validSnap(), primaryRecommendation: "NOPE" })).toBeNull();
  });

  // --- §2 strict rejection ------------------------------------------------------

  it("rejects an unknown overall / evidenceSource", () => {
    expect(validateDiagnosticSnapshot({ ...validSnap(), overall: "BOGUS" })).toBeNull();
    expect(validateDiagnosticSnapshot({ ...validSnap(), evidenceSource: "BOGUS" })).toBeNull();
  });

  it("rejects a missing required check (fewer than the version's set)", () => {
    const snap = validSnap();
    snap.checks = (snap.checks as unknown[]).slice(0, SERVICE_DIAGNOSTIC_CHECK_KEYS.length - 1);
    expect(validateDiagnosticSnapshot(snap)).toBeNull();
  });

  it("rejects an extra / too-many checks", () => {
    const snap = validSnap();
    snap.checks = [
      ...(snap.checks as unknown[]),
      snapCheck("QUOTA", "PASS", c.QUOTA_OK),
    ];
    expect(validateDiagnosticSnapshot(snap)).toBeNull();
    expect(
      validateDiagnosticSnapshot({
        ...validSnap(),
        checks: Array.from({ length: DIAGNOSTIC_SNAPSHOT_MAX_CHECKS + 1 }, () =>
          snapCheck("QUOTA", "PASS", c.QUOTA_OK),
        ),
      }),
    ).toBeNull();
  });

  it("rejects a duplicate key (even if it displaces a required one)", () => {
    const snap = validSnap();
    const checks = [...(snap.checks as DiagnosticSnapshotCheck[])];
    // Replace EXPIRY with a second QUOTA → duplicate key, still 8 entries.
    checks[4] = snapCheck("QUOTA", "WARNING", c.QUOTA_LOW);
    snap.checks = checks;
    expect(validateDiagnosticSnapshot(snap)).toBeNull();
  });

  it("rejects a duplicate code across two keys", () => {
    const snap = validSnap();
    const checks = [...(snap.checks as DiagnosticSnapshotCheck[])];
    // Give EXPIRY the QUOTA_OK code → duplicate code AND code↔key mismatch.
    checks[4] = snapCheck("EXPIRY", "PASS", c.QUOTA_OK);
    snap.checks = checks;
    expect(validateDiagnosticSnapshot(snap)).toBeNull();
  });

  it("rejects an unknown code", () => {
    const snap = validSnap();
    const checks = [...(snap.checks as DiagnosticSnapshotCheck[])];
    checks[3] = snapCheck("QUOTA", "PASS", "QUOTA_TOTALLY_MADE_UP");
    snap.checks = checks;
    expect(validateDiagnosticSnapshot(snap)).toBeNull();
  });

  it("rejects a code that does not belong to its stated key", () => {
    const snap = validSnap();
    const checks = [...(snap.checks as DiagnosticSnapshotCheck[])];
    // QUOTA_OK is valid, but attached to EXPIRY it violates code↔key.
    checks[4] = snapCheck("EXPIRY", "PASS", c.QUOTA_OK);
    snap.checks = checks;
    expect(validateDiagnosticSnapshot(snap)).toBeNull();
  });

  it("rejects a status not allowed for the code (contract-driven, not prefix)", () => {
    const snap = validSnap();
    const checks = [...(snap.checks as DiagnosticSnapshotCheck[])];
    // QUOTA_OK's only allowed status is PASS — FAIL must be rejected.
    checks[3] = snapCheck("QUOTA", "FAIL", c.QUOTA_OK);
    snap.checks = checks;
    expect(validateDiagnosticSnapshot(snap)).toBeNull();
  });

  it("rejects an over-length / malformed code shape", () => {
    const snap = validSnap();
    const checks = [...(snap.checks as DiagnosticSnapshotCheck[])];
    checks[3] = snapCheck("QUOTA", "PASS", "x".repeat(60));
    snap.checks = checks;
    expect(validateDiagnosticSnapshot(snap)).toBeNull();
  });

  it("rejects a wrong version and non-object input", () => {
    expect(validateDiagnosticSnapshot({ ...validSnap(), version: 2 })).toBeNull();
    expect(validateDiagnosticSnapshot({ ...validSnap(), version: "1" })).toBeNull();
    expect(validateDiagnosticSnapshot(null)).toBeNull();
    expect(validateDiagnosticSnapshot("nope")).toBeNull();
    expect(validateDiagnosticSnapshot(42)).toBeNull();
    expect(validateDiagnosticSnapshot([])).toBeNull();
  });

  it("only version 1 has a required-key set today (migration surface)", () => {
    expect(DIAGNOSTIC_SNAPSHOT_REQUIRED_KEYS[DIAGNOSTIC_SNAPSHOT_VERSION]).toEqual([
      ...SERVICE_DIAGNOSTIC_CHECK_KEYS,
    ]);
    expect(DIAGNOSTIC_SNAPSHOT_REQUIRED_KEYS[2]).toBeUndefined();
  });

  it("rejects an injected secret-shaped field inside a check", () => {
    const snap = validSnap();
    (snap.checks as Array<Record<string, unknown>>)[0].token = "https://sub.example.com/SECRET";
    const validated = validateDiagnosticSnapshot(snap);
    // The validator strips unknown fields — the round-trip never carries `token`.
    expect(validated).not.toBeNull();
    expect(JSON.stringify(validated)).not.toContain("SECRET");
    expect(JSON.stringify(validated)).not.toContain("token");
  });
});

describe("service-diagnostics: admin ticket detail stays under Telegram's limit (§6/#11)", () => {
  const validSnapshot = {
    version: 1,
    overall: "NEEDS_SUPPORT",
    evidenceSource: "LIVE_PANEL",
    checkedAt: NOW.toISOString(),
    checks: [
      { key: "SERVICE_STATE", status: "PASS", code: c.SERVICE_STATE_ACTIVE },
      { key: "PANEL_STATE", status: "FAIL", code: c.PANEL_AUTH_FAILED },
      { key: "PANEL_ACCOUNT", status: "FAIL", code: c.ACCOUNT_NOT_FOUND },
      { key: "QUOTA", status: "UNKNOWN", code: c.QUOTA_UNKNOWN },
      { key: "EXPIRY", status: "PASS", code: c.EXPIRY_OK },
      { key: "CONNECTION_PAYLOAD", status: "FAIL", code: c.PAYLOAD_MISSING },
      { key: "CONNECTION_HISTORY", status: "WARNING", code: c.HISTORY_OLD },
      { key: "DATA_FRESHNESS", status: "INFO", code: c.FRESHNESS_LIVE },
    ],
  };

  /** A worst-case diagnostic ticket: a long linked service username, a full
   * snapshot, and ten maximum-length message previews. */
  function worstCaseTicket() {
    const messages = Array.from({ length: 10 }, (_unused, i) => ({
      senderType: i % 2 === 0 ? "USER" : "ADMIN",
      text: "م".repeat(TICKET_MESSAGE_MAX),
    }));
    return {
      id: "abcdef01-2345-6789-abcd-ef0123456789",
      user: { telegramId: 123456789012345n, username: "a".repeat(32) },
      subject: "س".repeat(100),
      status: "WAITING_ADMIN",
      createdAt: NOW,
      updatedAt: NOW,
      closedAt: null,
      closedByAdminId: null,
      diagnosticSnapshot: validSnapshot,
      service: { username: "ب".repeat(300), status: "ACTIVE" },
      messages,
    } as unknown as Parameters<typeof detailText>[0];
  }

  it("clamps the assembled detail to under 4096 chars while keeping the header + summary", () => {
    const text = detailText(worstCaseTicket());
    expect(text.length).toBeLessThanOrEqual(4096);
    // The header (never truncated) and the diagnostic summary header survive.
    expect(text).toContain("تیکت 🎫");
    expect(text).toContain("گزارش عیب‌یابی");
    // No unbalanced <code> tag was cut (equal open/close counts).
    const opens = (text.match(/<code>/g) ?? []).length;
    const closes = (text.match(/<\/code>/g) ?? []).length;
    expect(opens).toBe(closes);
  });

  it("leaves a small ordinary ticket unchanged (no needless truncation)", () => {
    const small = {
      id: "00000000-1111-2222-3333-444444444444",
      user: { telegramId: 55n, username: null },
      subject: "سوال کوتاه",
      status: "WAITING_ADMIN",
      createdAt: NOW,
      updatedAt: NOW,
      closedAt: null,
      closedByAdminId: null,
      diagnosticSnapshot: null,
      service: null,
      messages: [{ senderType: "USER", text: "سلام" }],
    } as unknown as Parameters<typeof detailText>[0];
    const text = detailText(small);
    expect(text.length).toBeLessThan(500);
    expect(text).not.toContain("…");
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
