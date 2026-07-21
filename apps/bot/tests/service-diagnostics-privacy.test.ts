import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { prisma, type Panel, type Service, type User } from "@zedbot/database";
import { encryptSecret } from "@zedbot/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// encryptSecret reads APP_SECRET at call time (see service-diagnostics-flow).
process.env.APP_SECRET ??= "service-diagnostics-privacy-secret-1";

// A raw adapter error that embeds a subscription URL, token and a free-form
// fragment — exactly the kind of string §3 forbids from ever reaching a log.
const RAW_THROW =
  "panel 500 at https://sub.example.com/SUBSCRIPTIONSECRET?token=DEADBEEF failed RAWTHROWNSECRET";

const adapterState = vi.hoisted(() => ({
  mode: "ok" as "ok" | "throw" | "fail",
  account: {} as Record<string, unknown>,
}));
vi.mock("../src/services/panel-adapter-factory.js", () => ({
  buildAdapterForPanel: () => ({
    getServiceAccount: async () => {
      if (adapterState.mode === "throw") {
        throw new Error(RAW_THROW);
      }
      if (adapterState.mode === "fail") {
        return { ok: false, errorMessage: RAW_THROW, diagnostic: { code: "unreachable" } };
      }
      return adapterState.account;
    },
  }),
  normalizeSubscriptionBase: () => null,
}));

import { logger } from "../src/core/logger.js";
import { runServiceDiagnostics } from "../src/services/service-diagnostics.service.js";
import {
  readServiceForDiagnostics,
  scrubErrorCategory,
  type ServiceReadLogContext,
} from "../src/services/service-sync.service.js";
import { clearCooldown, serviceDiagnosticsCooldownKey } from "../src/services/service-lock.service.js";

// =============================================================================
// §3 privacy-safe logging + §4 never-throw for the diagnostics read primitive.
// A diagnostics run must NEVER log a service UUID / panel UUID / user UUID /
// username / subscription URL / config link / token / panel base URL / raw
// thrown error; the read primitive must never reject. DB + Redis gated.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";
const d = hasDb && hasRedis ? describe : describe.skip;

const GIB = 1024n * 1024n * 1024n;
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

const SUB_URL = "https://sub.example.com/SUBSCRIPTIONSECRET?token=DEADBEEF";
const SUB_TOKEN = "TOKENSECRET123456";
const CONFIG_LINK = "vless://CONFIGSECRETUUID@node.example:443?type=tcp#svc";
const PANEL_BASE = "http://panel-secret-host.example:2053/PANELSECRETPATH";
const USERNAME = `diaguserSECRETNAME-${runTag}`;

let panel: Panel;
let owner: User;
let service: Service;

// --- log capture -------------------------------------------------------------
const captured: string[] = [];
const spies: Array<ReturnType<typeof vi.spyOn>> = [];
function startCapture(): void {
  captured.length = 0;
  for (const level of ["debug", "info", "warn", "error"] as const) {
    spies.push(
      vi.spyOn(logger, level).mockImplementation((message: string, meta?: Record<string, unknown>) => {
        captured.push(JSON.stringify({ message, meta: meta ?? {} }));
      }),
    );
  }
}
function stopCapture(): string {
  const joined = captured.join("\n");
  while (spies.length > 0) {
    spies.pop()?.mockRestore();
  }
  return joined;
}

/** Every reversible identifier / secret that a diagnostics run must never log. */
function forbiddenTokens(): string[] {
  return [
    service.id,
    panel.id,
    owner.id,
    USERNAME,
    "SUBSCRIPTIONSECRET",
    "DEADBEEF",
    SUB_TOKEN,
    "CONFIGSECRETUUID",
    "panel-secret-host",
    "PANELSECRETPATH",
    "RAWTHROWNSECRET",
  ];
}
function expectNoLeak(logs: string): void {
  for (const token of forbiddenTokens()) {
    expect(logs.includes(token), `logs must not contain ${token}`).toBe(false);
  }
}

beforeAll(async () => {
  if (!hasDb || !hasRedis) {
    return;
  }
  panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `diag-priv-${runTag}`,
      baseUrl: PANEL_BASE,
      username: "u",
      passwordEncrypted: encryptSecret("p"),
      status: "ACTIVE",
      provisioningReady: true,
    },
  });
  owner = await prisma.user.create({ data: { telegramId: runTag } });
  service = await prisma.service.create({
    data: {
      userId: owner.id,
      panelId: panel.id,
      panelType: "MARZBAN",
      username: USERNAME,
      status: "ACTIVE",
      volumeBytes: 10n * GIB,
      usedBytes: 0n,
      remainingBytes: 10n * GIB,
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      subscriptionUrl: SUB_URL,
      subscriptionToken: SUB_TOKEN,
      configLinks: [CONFIG_LINK],
      lastSubscriptionUpdateAt: new Date(Date.now() - 3_600_000),
    },
  });
});

afterEach(async () => {
  if (!hasDb || !hasRedis) {
    return;
  }
  stopCapture();
  adapterState.mode = "ok";
  await clearCooldown(serviceDiagnosticsCooldownKey(owner.id, service.id)).catch(() => undefined);
});

afterAll(async () => {
  if (!hasDb || !hasRedis) {
    return;
  }
  await clearCooldown(serviceDiagnosticsCooldownKey(owner.id, service.id)).catch(() => undefined);
});

const okAccount = {
  ok: true,
  status: "active",
  usedBytes: 5n * GIB,
  totalBytes: 10n * GIB,
  remainingBytes: 5n * GIB,
};

d("service-diagnostics privacy: §3 the read path never logs identifiers or secrets", () => {
  it("a SUCCESSFUL diagnosis logs only operation/panelType/correlation", async () => {
    adapterState.mode = "ok";
    adapterState.account = { ...okAccount };
    startCapture();
    await runServiceDiagnostics(service, owner.id);
    const logs = stopCapture();
    expectNoLeak(logs);
    expect(logs).toContain("service diagnostics read");
    expect(logs).toContain('"operation":"DIAGNOSTICS"');
    expect(logs).toContain('"correlation":');
    // The NORMAL_SYNC message name must NOT appear for a diagnosis.
    expect(logs).not.toContain("service sync started");
  });

  it("a FAILED read logs the sanitized code + bounded category, never the raw error/URL", async () => {
    adapterState.mode = "fail";
    startCapture();
    await runServiceDiagnostics(service, owner.id);
    const logs = stopCapture();
    expectNoLeak(logs);
    expect(logs).toContain('"code":"unreachable"');
    // RAW_THROW carries "500" → the scrubbed category is server-error.
    expect(logs).toContain('"category":"server-error"');
    expect(logs).not.toContain("failed RAWTHROWNSECRET");
  });

  it("a THROWN adapter error is classified but never logged raw", async () => {
    adapterState.mode = "throw";
    startCapture();
    await runServiceDiagnostics(service, owner.id);
    const logs = stopCapture();
    expectNoLeak(logs);
    expect(logs).not.toContain("RAWTHROWNSECRET");
  });

  it("the OWNER read-only preview (persist:false) also logs nothing reversible", async () => {
    adapterState.mode = "ok";
    adapterState.account = { ...okAccount };
    startCapture();
    await runServiceDiagnostics(service, owner.id, { persist: false });
    const logs = stopCapture();
    expectNoLeak(logs);
    expect(logs).toContain('"operation":"OWNER_PREVIEW"');
  });
});

d("service-diagnostics privacy: §4 readServiceForDiagnostics never throws", () => {
  const diagCtx: ServiceReadLogContext = { mode: "DIAGNOSTICS", correlation: "testcorrhash1" };

  it("resolves to a classified outcome when the adapter THROWS (never rejects)", async () => {
    adapterState.mode = "throw";
    const outcome = await readServiceForDiagnostics(service.id, owner.id, {
      persist: true,
      logContext: diagCtx,
    });
    // A thrown adapter error becomes a classified read-error, not a rejection.
    expect(["read-error", "unreachable"]).toContain(outcome.kind);
    expect(outcome.account?.ok).not.toBe(true);
  });

  it("resolves to read-ok on a good read and persists", async () => {
    adapterState.mode = "ok";
    adapterState.account = { ...okAccount };
    const outcome = await readServiceForDiagnostics(service.id, owner.id, {
      persist: true,
      logContext: diagCtx,
    });
    expect(outcome.kind).toBe("read-ok");
    expect(outcome.service?.usedBytes).toBe(5n * GIB);
  });

  it("persist:false returns a live projection and never writes the row", async () => {
    adapterState.mode = "ok";
    adapterState.account = { ...okAccount, usedBytes: 7n * GIB, remainingBytes: 3n * GIB };
    const before = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    const outcome = await readServiceForDiagnostics(service.id, owner.id, {
      persist: false,
      logContext: { mode: "OWNER_PREVIEW", correlation: "testcorrhash2" },
    });
    expect(outcome.kind).toBe("read-ok");
    expect(outcome.service?.usedBytes).toBe(7n * GIB);
    const after = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(after.usedBytes).toBe(before.usedBytes);
  });

  it("returns service-missing (never throws) for an unknown/foreign service", async () => {
    const outcome = await readServiceForDiagnostics(
      "00000000-0000-0000-0000-000000000000",
      owner.id,
      { persist: true, logContext: diagCtx },
    );
    expect(outcome.kind).toBe("service-missing");
  });
});

describe("service-diagnostics privacy: scrubErrorCategory is bounded + non-echoing", () => {
  it("maps raw strings to a fixed vocabulary and never echoes the input", () => {
    const vocab = new Set([
      "none",
      "timeout",
      "conn-refused",
      "dns",
      "conn-reset",
      "tls",
      "auth",
      "not-found",
      "rate-limited",
      "server-error",
      "malformed",
      "other",
    ]);
    const samples = [
      undefined,
      null,
      "",
      "request ETIMEDOUT after 8000ms",
      "connect ECONNREFUSED 10.0.0.1:2053",
      "getaddrinfo ENOTFOUND panel.example",
      "socket hang up",
      "self-signed certificate",
      "401 Unauthorized at https://panel/api",
      "HTTP 404 not found",
      "429 too many requests",
      "502 Bad Gateway",
      "Unexpected token < in JSON at position 0",
      "some totally novel failure",
      RAW_THROW,
    ];
    for (const sample of samples) {
      const cat = scrubErrorCategory(sample);
      expect(vocab.has(cat)).toBe(true);
      // The category must never contain a URL/token fragment from the input.
      expect(cat).not.toContain("SUBSCRIPTIONSECRET");
      expect(cat).not.toContain("http");
    }
    expect(scrubErrorCategory(RAW_THROW)).toBe("server-error");
    expect(scrubErrorCategory(undefined)).toBe("none");
  });
});

describe("service-diagnostics privacy: §3 source-scan of the read primitive", () => {
  it("never logs a raw adapter error — the raw message only flows through scrubErrorCategory", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/services/service-sync.service.ts", import.meta.url)),
      "utf8",
    );
    // The OLD raw-error log pattern (logger.warn(..., { error: result.errorMessage }))
    // must be gone from the read primitive.
    expect(src).not.toMatch(/error:\s*result\.errorMessage/);
    // The raw message is only ever passed to the scrubber for logging.
    expect(src).toContain("scrubErrorCategory(result.errorMessage)");
    // No logger.* statement may carry a raw errorMessage. Scan each logger call
    // and its argument object (the call can span several lines), but allow the
    // SANITIZED path scrubErrorCategory(result.errorMessage) — strip it first.
    const loggerCalls = src.match(/logger\.(?:debug|info|warn|error)\([\s\S]*?\)\s*;/g) ?? [];
    for (const call of loggerCalls) {
      const withoutScrubber = call.replace(/scrubErrorCategory\([^)]*\)/g, "SANITIZED");
      expect(
        withoutScrubber.includes("errorMessage"),
        `raw errorMessage must never be logged: ${call}`,
      ).toBe(false);
    }
  });
});
