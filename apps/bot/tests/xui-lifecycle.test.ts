import { randomUUID } from "node:crypto";
import http from "node:http";

import { prisma, type Panel, type Product, type Service, type User } from "@zedbot/database";
import { encryptSecret } from "@zedbot/shared";
import type { InlineKeyboard } from "grammy";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// Short panel HTTP timeout so timeout tests finish quickly. Must be set
// before the adapters module is imported.
process.env.PANEL_HTTP_TIMEOUT_MS = "700";
process.env.APP_SECRET ??= "zedbot-panel-tests-shared-secret-00001";

import { XuiAdapter, XuiClient } from "@zedbot/panel-adapters";

import { CB } from "../src/core/callbacks.js";
import { isProductVisible } from "../src/services/catalog.service.js";
import {
  EXTRA_TIME_EVENT_TYPE,
  executeExtraTimeOrder,
  getExtraTimeServiceByShortId,
  isExtraTimePackageValid,
  listExtraTimeServices,
} from "../src/services/extra-time.service.js";
import {
  EXTRA_VOLUME_EVENT_TYPE,
  executeExtraVolumeOrder,
  getExtraVolumeServiceByShortId,
  isExtraVolumePackageValid,
  listExtraVolumeServices,
} from "../src/services/extra-volume.service.js";
import {
  CAPABILITY_STATUS_TEXT,
  classifyXuiRemoteModel,
  panelCapabilityStatusLines,
  serviceSupportsGlobalLifecycle,
  XUI_LEGACY_OPERATION_TEXT,
} from "../src/services/panel-readiness.service.js";
import { REFUND_PROVISIONING_REASON } from "../src/services/provisioning.service.js";
import {
  getRenewableServiceByShortId,
  isRenewalPlanValid,
  listRenewableServices,
} from "../src/services/renewal-checkout.service.js";
import {
  regenerateServiceSubscription,
  SERVICE_SUBSCRIPTION_REGENERATED_EVENT_TYPE,
} from "../src/services/service-link.service.js";
import {
  resetServiceLockClientForTests,
  SERVICE_LOCK_LOST_TEXT,
} from "../src/services/service-lock.service.js";
import {
  executeRenewalOrder,
  RENEWAL_EVENT_TYPE,
} from "../src/services/service-renewal.service.js";
import {
  SYNC_FAILED_USER_TEXT,
  SYNC_NOT_FOUND_TEXT,
  syncServiceFromPanel,
} from "../src/services/service-sync.service.js";
import { toggleServiceStatus } from "../src/services/service-toggle.service.js";
import {
  recoverStaleProvisioningOrders,
  STALE_PIPELINE_MINUTES,
} from "../src/services/startup-recovery.service.js";
import { resolveServiceDetailActions } from "../src/services/user-services.service.js";
import { payRenewalDraftWithWallet } from "../src/services/wallet-payment.service.js";
import { serviceDetailKeyboard } from "../src/handlers/user-services/service-views.js";
import type { ProductWithRelations } from "../src/services/product.service.js";

// =============================================================================
// XUI global-client LIFECYCLE operations against a stateful mock 3X-UI server
// reproducing the API pinned at MHSanaei/3x-ui commit
// 4e928a1ce0945a6e956aa63365034ec24d2b1387:
//
//   POST {base}/login                                 form-encoded, cookie
//   GET  {base}/panel/api/inbounds/list
//   GET  {base}/panel/api/clients/list                rows + inboundIds + traffic
//   GET  {base}/panel/api/clients/get/{email}
//   POST {base}/panel/api/clients/add                 {client, inboundIds}
//   POST {base}/panel/api/clients/update/{email}      bare model.Client body;
//        REPLACES the row but PRESERVES omitted credentials and preserves the
//        subId when the body carries an empty one; a non-empty subId change
//        is honored after a panel-wide uniqueness check (client_crud.go)
//   POST {base}/panel/api/clients/resetTraffic/{email} zeroes up/down and
//        AUTO-ENABLES the client (client_crud.go ResetClientTrafficByEmail)
//   POST {base}/panel/api/clients/del/{email}
//   GET  {base}/panel/api/clients/links/{email}
//
// Suites: adapter contract, E2E pipelines (real PostgreSQL + Redis),
// concurrency, reconciliation, capability gates + UI. E2E suites skip
// themselves without DATABASE_URL/REDIS_URL (docs/testing.md).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";
const hasDeps = hasDb && hasRedis;

const XUI_USER = "xadmin";
const XUI_PASS = "xui-secret-pass";
const SESSION = "mock-3xui-lifecycle-session-1";
const GIB = 1024n * 1024n * 1024n;
const DAY_MS = 86_400_000;
const PRICE = 40_000;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

// --- stateful mock 3X-UI panel -------------------------------------------------------

interface MockClientRow {
  email: string;
  subId: string;
  uuid?: string;
  password?: string;
  totalGB: number;
  expiryTime: number;
  enable: boolean;
  comment?: string;
  flow?: string;
  reset: number;
  limitIp: number;
  tgId: number;
  group: string;
  adTag: string;
}

const mock = {
  inbounds: [{ id: 1, enable: true, protocol: "vless", remark: "in-1", port: 10001 }],
  clients: [] as MockClientRow[],
  attachments: new Map<string, Set<number>>(),
  traffic: new Map<string, { up: number; down: number }>(),
  wrongCredentials: false,
  listCalls: 0,
  /** Fail clients/list once this many list calls have already answered. */
  listFailAfter: null as number | null,
  hangList: false,
  updateCalls: [] as Array<{ email: string; body: Record<string, unknown> }>,
  resetCalls: [] as string[],
  updateFail: false,
  hangUpdate: false,
  updateDelayMs: 0,
  legacyEndpointCalls: 0,
};

function resetMockFlags(): void {
  mock.wrongCredentials = false;
  mock.listCalls = 0;
  mock.listFailAfter = null;
  mock.hangList = false;
  mock.updateCalls = [];
  mock.resetCalls = [];
  mock.updateFail = false;
  mock.hangUpdate = false;
  mock.updateDelayMs = 0;
  mock.legacyEndpointCalls = 0;
}

function seedClient(
  partial: Partial<MockClientRow> & { email: string },
  inboundIds: number[] = [1],
): MockClientRow {
  const row: MockClientRow = {
    subId: `sub${(++seq).toString().padStart(6, "0")}xxxx`,
    uuid: randomUUID(),
    totalGB: Number(20n * GIB),
    expiryTime: Date.now() + 30 * DAY_MS,
    enable: true,
    reset: 0,
    limitIp: 0,
    tgId: 0,
    group: "",
    adTag: "",
    ...partial,
  };
  mock.clients.push(row);
  mock.attachments.set(row.email, new Set(inboundIds));
  mock.traffic.set(row.email, { up: 0, down: 0 });
  return row;
}

function dropClient(email: string): void {
  mock.clients = mock.clients.filter((r) => r.email !== email);
  mock.attachments.delete(email);
  mock.traffic.delete(email);
}

function clientJson(row: MockClientRow): Record<string, unknown> {
  const t = mock.traffic.get(row.email);
  return {
    id: mock.clients.indexOf(row) + 1,
    email: row.email,
    subId: row.subId,
    uuid: row.uuid ?? "",
    password: row.password ?? "",
    auth: "",
    flow: row.flow ?? "",
    totalGB: row.totalGB,
    expiryTime: row.expiryTime,
    enable: row.enable,
    comment: row.comment ?? "",
    reset: row.reset,
    limitIp: row.limitIp,
    tgId: row.tgId,
    group: row.group,
    adTag: row.adTag,
    inboundIds: [...(mock.attachments.get(row.email) ?? [])].sort((a, b) => a - b),
    traffic:
      t === undefined
        ? null
        : {
            email: row.email,
            up: t.up,
            down: t.down,
            total: row.totalGB,
            expiryTime: row.expiryTime,
            enable: row.enable,
            lastOnline: 0,
          },
  };
}

let server: http.Server;
let host = "";
const hanging: http.ServerResponse[] = [];

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString()));
    req.on("end", () => resolve(data));
  });
}

function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** update/{email} semantics per the pinned client_crud.go UpdateClientByEmail. */
function handleUpdate(res: http.ServerResponse, email: string, body: Record<string, unknown>): void {
  mock.updateCalls.push({ email, body });
  if (mock.updateFail) {
    json(res, 200, { success: false, msg: "injected update failure" });
    return;
  }
  const row = mock.clients.find((r) => r.email === email);
  if (row === undefined) {
    json(res, 200, { success: false, msg: "record not found" });
    return;
  }
  const nextSubId = typeof body["subId"] === "string" ? (body["subId"] as string) : "";
  if (nextSubId !== "" && nextSubId !== row.subId) {
    if (mock.clients.some((r) => r.subId === nextSubId && r.email !== email)) {
      json(res, 200, { success: false, msg: `subId already in use: ${nextSubId}` });
      return;
    }
    row.subId = nextSubId; // subscription identity re-key (uniqueness passed)
  }
  // Full replace of the non-credential fields, exactly as sent...
  row.flow = typeof body["flow"] === "string" ? (body["flow"] as string) : "";
  row.totalGB = typeof body["totalGB"] === "number" ? (body["totalGB"] as number) : 0;
  row.expiryTime = typeof body["expiryTime"] === "number" ? (body["expiryTime"] as number) : 0;
  row.enable = body["enable"] !== false;
  row.comment = typeof body["comment"] === "string" ? (body["comment"] as string) : "";
  row.reset = typeof body["reset"] === "number" ? (body["reset"] as number) : 0;
  row.limitIp = typeof body["limitIp"] === "number" ? (body["limitIp"] as number) : 0;
  row.tgId = typeof body["tgId"] === "number" ? (body["tgId"] as number) : 0;
  row.group = typeof body["group"] === "string" ? (body["group"] as string) : "";
  row.adTag = typeof body["adTag"] === "string" ? (body["adTag"] as string) : "";
  // ...while omitted credentials are PRESERVED server-side.
  if (typeof body["id"] === "string" && body["id"] !== "") {
    row.uuid = body["id"] as string;
  }
  if (typeof body["password"] === "string" && body["password"] !== "") {
    row.password = body["password"] as string;
  }
  json(res, 200, { success: true, msg: "Client updated" });
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    void (async () => {
      const path = req.url ?? "";

      if (req.method === "POST" && path === "/login") {
        const params = new URLSearchParams(await readBody(req));
        if (
          mock.wrongCredentials ||
          params.get("username") !== XUI_USER ||
          params.get("password") !== XUI_PASS
        ) {
          json(res, 200, { success: false, msg: "Invalid username or password" });
          return;
        }
        json(
          res,
          200,
          { success: true, msg: "Login Successfully", obj: null },
          { "Set-Cookie": `3x-ui=${SESSION}; Path=/; HttpOnly` },
        );
        return;
      }

      if ((req.headers.cookie ?? "") !== `3x-ui=${SESSION}`) {
        res.writeHead(302, { Location: "/" });
        res.end();
        return;
      }

      if (req.method === "GET" && path === "/panel/api/inbounds/list") {
        json(res, 200, { success: true, msg: "", obj: mock.inbounds });
        return;
      }

      // Legacy per-inbound client endpoints were REMOVED upstream -> 404.
      if (path.startsWith("/panel/api/inbounds/addClient") || /\/delClient\//.test(path)) {
        mock.legacyEndpointCalls += 1;
        res.writeHead(404, { "Content-Type": "text/html" });
        res.end("<html>not found</html>");
        return;
      }

      if (req.method === "GET" && path === "/panel/api/clients/list") {
        if (mock.hangList) {
          hanging.push(res);
          return;
        }
        mock.listCalls += 1;
        if (mock.listFailAfter !== null && mock.listCalls > mock.listFailAfter) {
          json(res, 500, { success: false, msg: "internal error" });
          return;
        }
        json(res, 200, { success: true, msg: "", obj: mock.clients.map(clientJson) });
        return;
      }

      const getMatch = /^\/panel\/api\/clients\/get\/([^/]+)$/.exec(path);
      if (req.method === "GET" && getMatch !== null) {
        const email = decodeURIComponent(getMatch[1]);
        const row = mock.clients.find((r) => r.email === email);
        if (row === undefined) {
          json(res, 200, { success: false, msg: "record not found" });
          return;
        }
        const t = mock.traffic.get(email);
        json(res, 200, {
          success: true,
          msg: "",
          obj: {
            client: clientJson(row),
            inboundIds: [...(mock.attachments.get(email) ?? [])].sort((a, b) => a - b),
            usedTraffic: (t?.up ?? 0) + (t?.down ?? 0),
          },
        });
        return;
      }

      const updateMatch = /^\/panel\/api\/clients\/update\/([^/]+)$/.exec(path);
      if (req.method === "POST" && updateMatch !== null) {
        const body = JSON.parse(await readBody(req)) as Record<string, unknown>;
        if (mock.hangUpdate) {
          mock.updateCalls.push({ email: decodeURIComponent(updateMatch[1]), body });
          hanging.push(res);
          return;
        }
        if (mock.updateDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, mock.updateDelayMs));
        }
        handleUpdate(res, decodeURIComponent(updateMatch[1]), body);
        return;
      }

      const resetMatch = /^\/panel\/api\/clients\/resetTraffic\/([^/]+)$/.exec(path);
      if (req.method === "POST" && resetMatch !== null) {
        const email = decodeURIComponent(resetMatch[1]);
        mock.resetCalls.push(email);
        const row = mock.clients.find((r) => r.email === email);
        if (row === undefined) {
          json(res, 200, { success: false, msg: "record not found" });
          return;
        }
        mock.traffic.set(email, { up: 0, down: 0 });
        row.enable = true; // upstream auto-enables on traffic reset
        json(res, 200, { success: true, msg: "Traffic reset" });
        return;
      }

      const linksMatch = /^\/panel\/api\/clients\/links\/([^/]+)$/.exec(path);
      if (req.method === "GET" && linksMatch !== null) {
        const email = decodeURIComponent(linksMatch[1]);
        const row = mock.clients.find((r) => r.email === email);
        const ids = [...(mock.attachments.get(email) ?? [])];
        const urls = ids.map((id) => `vless://${row?.uuid ?? ""}@panel.example:${10_000 + id}#${email}`);
        json(res, 200, { success: true, msg: "", obj: urls });
        return;
      }

      res.writeHead(404, { "Content-Type": "text/html" });
      res.end("<html>not found</html>");
    })();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      host = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
});

afterAll(() => {
  for (const res of hanging) {
    res.destroy();
  }
  server?.close();
  resetServiceLockClientForTests();
});

afterEach(() => {
  resetMockFlags();
});

function adapter(): XuiAdapter {
  return new XuiAdapter(
    new XuiClient({ baseUrl: host, username: XUI_USER, password: XUI_PASS, apiVariant: "SANAEI" }),
  );
}

/** ms-aligned future expiry: XUI stores unix milliseconds verbatim. */
function futureMs(daysFromNow: number): number {
  return Date.now() + daysFromNow * DAY_MS;
}

// =============================================================================
// A. Adapter contract (mock HTTP server only - no DB required)
// =============================================================================

describe("XUI lifecycle adapter contract (pinned 4e928a1c)", () => {
  it("A1. refresh reads the CENTRAL client and normalizes every field", async () => {
    const expiry = futureMs(10);
    const row = seedClient(
      { email: "life-read-1", totalGB: Number(20n * GIB), expiryTime: expiry },
      [1],
    );
    mock.traffic.set(row.email, { up: Number(1n * GIB), down: Number(2n * GIB) });

    const read = await adapter().getServiceAccount({
      username: row.email,
      subscriptionBaseUrl: "https://sub.example.com/sub",
    });
    expect(read.ok).toBe(true);
    expect(read.totalBytes).toBe(20n * GIB);
    expect(read.usedBytes).toBe(3n * GIB);
    expect(read.remainingBytes).toBe(17n * GIB);
    expect(read.expiresAt?.getTime()).toBe(expiry);
    expect(read.status).toBe("active");
    expect(read.subscriptionToken).toBe(row.subId);
    expect(read.subscriptionUrl).toBe(`https://sub.example.com/sub/${row.subId}`);
    const metadata = read.remoteMetadata as { clients: Array<{ email: string; inboundIds: number[] }> };
    expect(metadata.clients).toEqual([{ email: row.email, inboundIds: [1] }]);
  });

  it("A2. positive absence is notFound; an unreadable inventory is NOT", async () => {
    const missing = await adapter().getServiceAccount({ username: "life-ghost-1" });
    expect(missing.ok).toBe(false);
    expect(missing.notFound).toBe(true);

    mock.listFailAfter = 0; // inventory unreadable
    const unreadable = await adapter().getServiceAccount({ username: "life-ghost-1" });
    expect(unreadable.ok).toBe(false);
    expect(unreadable.notFound).toBeUndefined(); // could-not-check != does-not-exist
  });

  it("A3. a read timeout is a plain failure (UNKNOWN) - never notFound", async () => {
    mock.hangList = true;
    const timedOut = await adapter().getServiceAccount({ username: "life-timeout-1" });
    expect(timedOut.ok).toBe(false);
    expect(timedOut.notFound).toBeUndefined();
  });

  it("A4. renewal: traffic reset + ONE central update + exact verification", async () => {
    const row = seedClient({ email: "life-renew-1", totalGB: Number(20n * GIB) });
    mock.traffic.set(row.email, { up: Number(5n * GIB), down: 0 });
    const newExpiry = futureMs(40);

    const result = await adapter().renewServiceAccount({
      username: row.email,
      totalBytes: 35n * GIB,
      expiresAt: new Date(newExpiry),
      subscriptionBaseUrl: "https://sub.example.com/sub",
    });
    expect(result.ok).toBe(true);
    expect(mock.resetCalls).toEqual([row.email]); // usage reset exactly once
    expect(mock.updateCalls).toHaveLength(1); // ONE central update
    expect(mock.legacyEndpointCalls).toBe(0);
    expect(row.totalGB).toBe(Number(35n * GIB)); // bytes despite the name
    expect(row.expiryTime).toBe(newExpiry); // unix ms, exact
    expect(row.enable).toBe(true);
    expect(result.totalBytes).toBe(35n * GIB);
    expect(result.usedBytes).toBe(0n);
    expect(result.expiresAt?.getTime()).toBe(newExpiry);
    expect(result.subscriptionToken).toBe(row.subId);
  });

  it("A5. the full-replace payload round-trips every unchanged field", async () => {
    const row = seedClient({
      email: "life-preserve-1",
      flow: "xtls-rprx-vision",
      comment: "keep-me",
      limitIp: 3,
      tgId: 777,
      group: "gold",
      adTag: "tag-1",
      uuid: "11111111-2222-3333-4444-555555555555",
      password: "trojan-secret-1",
    });
    const subIdBefore = row.subId;

    const result = await adapter().addServiceTime({
      username: row.email,
      totalBytes: 20n * GIB,
      expiresAt: new Date(futureMs(60)),
    });
    expect(result.ok).toBe(true);
    // Unchanged fields survived the full replace...
    expect(row.flow).toBe("xtls-rprx-vision");
    expect(row.comment).toBe("keep-me");
    expect(row.limitIp).toBe(3);
    expect(row.tgId).toBe(777);
    expect(row.group).toBe("gold");
    expect(row.adTag).toBe("tag-1");
    expect(row.subId).toBe(subIdBefore);
    // ...and the credentials were never re-sent (server-side preserve).
    const sent = mock.updateCalls[0].body;
    expect(sent["id"]).toBeUndefined();
    expect(sent["password"]).toBeUndefined();
    expect(sent["uuid"]).toBeUndefined();
    expect(row.uuid).toBe("11111111-2222-3333-4444-555555555555");
    expect(row.password).toBe("trojan-secret-1");
  });

  it("A6. extra volume: ONE update, no per-inbound loop, expiry untouched", async () => {
    const expiry = futureMs(15);
    const row = seedClient(
      { email: "life-vol-1", totalGB: Number(20n * GIB), expiryTime: expiry },
      [1],
    );
    mock.attachments.set(row.email, new Set([1, 2, 3])); // many attachments

    const result = await adapter().addServiceVolume({
      username: row.email,
      totalBytes: 30n * GIB,
      expiresAt: new Date(expiry),
    });
    expect(result.ok).toBe(true);
    expect(mock.updateCalls).toHaveLength(1); // never one call per inbound
    expect(mock.legacyEndpointCalls).toBe(0);
    expect(row.totalGB).toBe(Number(30n * GIB));
    expect(row.expiryTime).toBe(expiry); // unchanged
  });

  it("A7. unlimited quota stays the explicit 0 sentinel - no arithmetic", async () => {
    const row = seedClient({ email: "life-unlim-1", totalGB: Number(10n * GIB) });
    const result = await adapter().renewServiceAccount({
      username: row.email,
      totalBytes: null, // unlimited plan
      expiresAt: new Date(futureMs(30)),
    });
    expect(result.ok).toBe(true);
    expect(row.totalGB).toBe(0); // upstream sentinel for unlimited
    expect(result.totalBytes).toBeNull();
    expect(result.remainingBytes).toBeNull();
  });

  it("A8. extra time: exact ms expiry, quota AND usage untouched", async () => {
    const row = seedClient({ email: "life-time-1", totalGB: Number(20n * GIB) });
    mock.traffic.set(row.email, { up: Number(4n * GIB), down: 0 });
    const newExpiry = futureMs(45);

    const result = await adapter().addServiceTime({
      username: row.email,
      totalBytes: 20n * GIB,
      expiresAt: new Date(newExpiry),
    });
    expect(result.ok).toBe(true);
    expect(mock.resetCalls).toHaveLength(0); // extra time NEVER resets usage
    expect(row.expiryTime).toBe(newExpiry); // ms-exact (no tolerance needed)
    expect(row.totalGB).toBe(Number(20n * GIB));
    expect(result.usedBytes).toBe(4n * GIB); // usage preserved
  });

  it("A9. toggle flips ONLY the enable flag and verifies it", async () => {
    const expiry = futureMs(20);
    const row = seedClient({ email: "life-toggle-1", totalGB: Number(20n * GIB), expiryTime: expiry });
    mock.traffic.set(row.email, { up: Number(1n * GIB), down: 0 });

    const disabled = await adapter().setServiceStatus({ username: row.email, enabled: false });
    expect(disabled.ok).toBe(true);
    expect(row.enable).toBe(false);
    expect(row.totalGB).toBe(Number(20n * GIB)); // untouched
    expect(row.expiryTime).toBe(expiry); // untouched
    expect(mock.traffic.get(row.email)).toEqual({ up: Number(1n * GIB), down: 0 }); // NO reset

    const enabled = await adapter().setServiceStatus({ username: row.email, enabled: true });
    expect(enabled.ok).toBe(true);
    expect(row.enable).toBe(true);
  });

  it("A10. repeated toggle is idempotent - already-applied skips the update", async () => {
    const row = seedClient({ email: "life-toggle-2", enable: true });
    const first = await adapter().setServiceStatus({ username: row.email, enabled: false });
    expect(first.ok).toBe(true);
    const updatesAfterFirst = mock.updateCalls.length;

    const repeat = await adapter().setServiceStatus({ username: row.email, enabled: false });
    expect(repeat.ok).toBe(true);
    expect(mock.updateCalls.length).toBe(updatesAfterFirst); // no second mutation
  });

  it("A11. update failure/timeout/unverifiable post-state are UNKNOWN; absence is definite", async () => {
    const row = seedClient({ email: "life-unknown-1" });

    mock.updateFail = true;
    const refused = await adapter().addServiceTime({
      username: row.email,
      totalBytes: 20n * GIB,
      expiresAt: new Date(futureMs(30)),
    });
    expect(refused.ok).toBe(false);
    expect(refused.uncertain).toBe(true);
    mock.updateFail = false;

    mock.hangUpdate = true;
    const timedOut = await adapter().addServiceTime({
      username: row.email,
      totalBytes: 20n * GIB,
      expiresAt: new Date(futureMs(30)),
    });
    expect(timedOut.ok).toBe(false);
    expect(timedOut.uncertain).toBe(true);
    mock.hangUpdate = false;

    mock.listCalls = 0;
    mock.listFailAfter = 1; // initial read passes, verification read fails
    const unverified = await adapter().addServiceTime({
      username: row.email,
      totalBytes: 20n * GIB,
      expiresAt: new Date(futureMs(31)),
    });
    expect(unverified.ok).toBe(false);
    expect(unverified.uncertain).toBe(true);
    mock.listFailAfter = null;

    const gone = await adapter().addServiceTime({
      username: "life-absent-1",
      totalBytes: 20n * GIB,
      expiresAt: new Date(futureMs(30)),
    });
    expect(gone.ok).toBe(false);
    expect(gone.uncertain).toBeUndefined(); // positive absence = definite
    expect(gone.errorMessage).toBe("Panel account not found.");
  });

  it("A12. regeneration re-keys the subId: old identity dies, new one verified", async () => {
    const row = seedClient({ email: "life-regen-1" });
    const oldSubId = row.subId;

    const result = await adapter().regenerateSubscription({
      username: row.email,
      subscriptionBaseUrl: "https://sub.example.com/sub",
    });
    expect(result.ok).toBe(true);
    expect(row.subId).not.toBe(oldSubId);
    expect(row.subId).toMatch(/^[a-z0-9]{16}$/); // the shape 3x-ui generates
    expect(result.subscriptionToken).toBe(row.subId);
    expect(result.subscriptionUrl).toBe(`https://sub.example.com/sub/${row.subId}`);
    // The subscription resolves BY subId: no client carries the old identity.
    expect(mock.clients.some((r) => r.subId === oldSubId)).toBe(false);
    expect(mock.updateCalls).toHaveLength(1);
  });

  it("A13. failure messages never leak credentials, cookies or subIds", async () => {
    const row = seedClient({ email: "life-secrets-1" });
    mock.updateFail = true;
    const failed = await adapter().renewServiceAccount({
      username: row.email,
      totalBytes: 30n * GIB,
      expiresAt: new Date(futureMs(30)),
    });
    expect(failed.ok).toBe(false);
    const text = JSON.stringify(failed);
    expect(text).not.toContain(XUI_PASS);
    expect(text).not.toContain(SESSION);
    expect(text).not.toContain(row.subId);
    expect(text).not.toContain(row.uuid ?? "no-uuid");
  });
});

// =============================================================================
// B. E2E fixtures (real PostgreSQL + Redis + the mock panel)
// =============================================================================

let xuiPanel: Panel;
let category: { id: string };
let product: Product;

beforeAll(async () => {
  if (!hasDeps) return;
  xuiPanel = await prisma.panel.create({
    data: {
      type: "XUI",
      name: `xui-life-panel-${runTag}`,
      baseUrl: host,
      username: XUI_USER,
      passwordEncrypted: encryptSecret(XUI_PASS),
      inboundIds: [1],
      status: "ACTIVE",
      provisioningReady: true,
    },
  });
  category = await prisma.productCategory.create({
    data: { type: "SERVICE_PRODUCT", name: `xui-life-cat-${runTag}`, isActive: true },
  });
  product = await prisma.product.create({
    data: {
      type: "SERVICE_PRODUCT",
      categoryId: category.id,
      panelId: xuiPanel.id,
      name: `xui-life-prod-${runTag}`,
      priceToman: PRICE,
      volumeGb: 10,
      durationDays: 30,
      isActive: true,
    },
  });
});

async function createUser(balanceToman = 0): Promise<User> {
  seq += 1;
  return prisma.user.create({ data: { telegramId: runTag + BigInt(seq), balanceToman } });
}

interface GlobalServiceFixture {
  service: Service;
  row: MockClientRow;
  expiryMs: number;
}

/** GLOBAL_CLIENT service: DB row + matching central mock client. */
async function createGlobalService(
  user: User,
  opts: { volumeGb: number; expireDays: number } = { volumeGb: 20, expireDays: 30 },
): Promise<GlobalServiceFixture> {
  seq += 1;
  const username = `xlife-${runTag}-${seq}`;
  const expiryMs = futureMs(opts.expireDays);
  const volumeBytes = BigInt(opts.volumeGb) * GIB;
  const row = seedClient({
    email: username,
    totalGB: Number(volumeBytes),
    expiryTime: expiryMs,
  });
  const service = await prisma.service.create({
    data: {
      userId: user.id,
      panelId: xuiPanel.id,
      productId: product.id,
      panelType: "XUI",
      username,
      status: "ACTIVE",
      volumeBytes,
      usedBytes: 0n,
      remainingBytes: volumeBytes,
      expiresAt: new Date(expiryMs),
      startsAt: new Date(),
      subscriptionToken: row.subId,
      remoteMetadata: { subId: row.subId, email: username, inboundIds: [1] },
    },
  });
  return { service, row, expiryMs };
}

/** LEGACY_PER_INBOUND service: per-inbound client labels, no central client. */
async function createLegacyService(user: User): Promise<Service> {
  seq += 1;
  const username = `xleg-${runTag}-${seq}`;
  seedClient({ email: `${username}-1` }, [1]);
  const volumeBytes = 20n * GIB;
  return prisma.service.create({
    data: {
      userId: user.id,
      panelId: xuiPanel.id,
      productId: product.id,
      panelType: "XUI",
      username,
      status: "ACTIVE",
      volumeBytes,
      usedBytes: 0n,
      remainingBytes: volumeBytes,
      expiresAt: new Date(futureMs(30)),
      startsAt: new Date(),
      remoteMetadata: { clients: [{ email: `${username}-1`, inboundIds: [1] }] },
    },
  });
}

async function createPaidOrder(
  user: User,
  serviceId: string,
  type: "SERVICE_RENEWAL" | "EXTRA_VOLUME" | "EXTRA_TIME",
  plan: { volumeGb?: number; durationDays?: number },
): Promise<string> {
  const order = await prisma.order.create({
    data: {
      userId: user.id,
      type,
      status: "PAID",
      productId: product.id,
      serviceId,
      originalPriceToman: PRICE,
      discountAmountToman: 0,
      finalPriceToman: PRICE,
      volumeGbSnapshot: plan.volumeGb ?? 0,
      durationDaysSnapshot: plan.durationDays ?? 0,
      paidAt: new Date(),
    },
  });
  return order.id;
}

async function ageOrder(orderId: string): Promise<void> {
  await prisma.$executeRaw`UPDATE "Order" SET "updatedAt" = now() - (${STALE_PIPELINE_MINUTES + 10} * interval '1 minute') WHERE "id" = ${orderId}`;
}

async function markProvisioning(orderId: string): Promise<void> {
  await prisma.order.update({ where: { id: orderId }, data: { status: "PROVISIONING" } });
}

function staleCutoff(): Date {
  return new Date(Date.now() - STALE_PIPELINE_MINUTES * 60_000);
}

async function eventCount(serviceId: string, eventType: string): Promise<number> {
  return prisma.serviceEventLog.count({ where: { serviceId, eventType } });
}

async function refundCount(orderId: string): Promise<number> {
  return prisma.walletTransaction.count({
    where: { relatedOrderId: orderId, reason: REFUND_PROVISIONING_REASON },
  });
}

async function productWithRelations(): Promise<ProductWithRelations> {
  return (await prisma.product.findUniqueOrThrow({
    where: { id: product.id },
    include: { category: true, panel: true },
  })) as ProductWithRelations;
}

// =============================================================================
// C. E2E pipelines
// =============================================================================

describe.runIf(hasDeps)("XUI lifecycle pipelines (E2E)", () => {
  it("B1. renewal: exact quota/expiry on the central client, one event, retry applies once", async () => {
    const user = await createUser();
    const fx = await createGlobalService(user, { volumeGb: 20, expireDays: 10 });
    // 5 GB used, both panel-side and in the stored row (the calculation
    // works from the STORED remaining per the renewal method).
    mock.traffic.set(fx.row.email, { up: Number(5n * GIB), down: 0 });
    await prisma.service.update({
      where: { id: fx.service.id },
      data: { usedBytes: 5n * GIB, remainingBytes: 15n * GIB },
    });
    const orderId = await createPaidOrder(user, fx.service.id, "SERVICE_RENEWAL", {
      volumeGb: 15,
      durationDays: 30,
    });

    const outcome = await executeRenewalOrder(orderId);
    expect(outcome.ok).toBe(true);

    // remaining(20-5=15) + purchased(15) = 30 GiB; expiry = old + 30d exact ms.
    const expectedExpiry = fx.expiryMs + 30 * DAY_MS;
    expect(fx.row.totalGB).toBe(Number(30n * GIB));
    expect(fx.row.expiryTime).toBe(expectedExpiry);
    expect(fx.row.enable).toBe(true);
    expect(mock.traffic.get(fx.row.email)).toEqual({ up: 0, down: 0 }); // usage reset

    const service = await prisma.service.findUniqueOrThrow({ where: { id: fx.service.id } });
    expect(service.volumeBytes).toBe(30n * GIB);
    expect(service.usedBytes).toBe(0n);
    expect(service.expiresAt?.getTime()).toBe(expectedExpiry);
    expect(await eventCount(fx.service.id, RENEWAL_EVENT_TYPE)).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
      "COMPLETED",
    );

    // Retry after completion: alreadyApplied, zero additional remote mutations.
    const updatesBefore = mock.updateCalls.length;
    const retry = await executeRenewalOrder(orderId);
    expect(retry.ok).toBe(true);
    expect(retry.ok && retry.alreadyApplied).toBe(true);
    expect(mock.updateCalls.length).toBe(updatesBefore);
    expect(await eventCount(fx.service.id, RENEWAL_EVENT_TYPE)).toBe(1);
  });

  it("B2. extra volume: +10 and +20 concurrently produce +30 exactly (no lost update)", async () => {
    const user = await createUser();
    const fx = await createGlobalService(user, { volumeGb: 20, expireDays: 30 });
    const [a, b] = await Promise.all([
      createPaidOrder(user, fx.service.id, "EXTRA_VOLUME", { volumeGb: 10 }),
      createPaidOrder(user, fx.service.id, "EXTRA_VOLUME", { volumeGb: 20 }),
    ]);

    mock.updateDelayMs = 60; // widen the would-be race window
    try {
      const [ra, rb] = await Promise.all([executeExtraVolumeOrder(a), executeExtraVolumeOrder(b)]);
      expect(ra.ok).toBe(true);
      expect(rb.ok).toBe(true);
    } finally {
      mock.updateDelayMs = 0;
    }

    expect(fx.row.totalGB).toBe(Number(50n * GIB)); // 20 + 10 + 20, NEVER 30/40
    expect(fx.row.expiryTime).toBe(fx.expiryMs); // extra volume never moves expiry
    const service = await prisma.service.findUniqueOrThrow({ where: { id: fx.service.id } });
    expect(service.volumeBytes).toBe(50n * GIB);
    expect(await eventCount(fx.service.id, EXTRA_VOLUME_EVENT_TYPE)).toBe(2);
    expect(await refundCount(a)).toBe(0);
    expect(await refundCount(b)).toBe(0);
  });

  it("B3. the same extra-volume order retried concurrently mutates once", async () => {
    const user = await createUser();
    const fx = await createGlobalService(user, { volumeGb: 20, expireDays: 30 });
    const orderId = await createPaidOrder(user, fx.service.id, "EXTRA_VOLUME", { volumeGb: 10 });

    const updatesBefore = mock.updateCalls.length;
    const [ra, rb] = await Promise.all([
      executeExtraVolumeOrder(orderId),
      executeExtraVolumeOrder(orderId),
    ]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(mock.updateCalls.length - updatesBefore).toBe(1); // ONE remote mutation
    expect(fx.row.totalGB).toBe(Number(30n * GIB));
    expect(await eventCount(fx.service.id, EXTRA_VOLUME_EVENT_TYPE)).toBe(1);
  });

  it("B4. extra time: +10d and +20d concurrently produce +30d, ms-exact", async () => {
    const user = await createUser();
    const fx = await createGlobalService(user, { volumeGb: 20, expireDays: 5 });
    const [a, b] = await Promise.all([
      createPaidOrder(user, fx.service.id, "EXTRA_TIME", { durationDays: 10 }),
      createPaidOrder(user, fx.service.id, "EXTRA_TIME", { durationDays: 20 }),
    ]);

    const [ra, rb] = await Promise.all([executeExtraTimeOrder(a), executeExtraTimeOrder(b)]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);

    const expected = fx.expiryMs + 30 * DAY_MS; // ms-exact - no tolerance needed
    expect(fx.row.expiryTime).toBe(expected);
    expect(fx.row.totalGB).toBe(Number(20n * GIB)); // quota untouched
    const service = await prisma.service.findUniqueOrThrow({ where: { id: fx.service.id } });
    expect(service.expiresAt?.getTime()).toBe(expected);
    expect(await eventCount(fx.service.id, EXTRA_TIME_EVENT_TYPE)).toBe(2);
  });

  it("B5. the same extra-time order retried concurrently mutates once", async () => {
    const user = await createUser();
    const fx = await createGlobalService(user, { volumeGb: 20, expireDays: 5 });
    const orderId = await createPaidOrder(user, fx.service.id, "EXTRA_TIME", { durationDays: 10 });

    const updatesBefore = mock.updateCalls.length;
    const [ra, rb] = await Promise.all([
      executeExtraTimeOrder(orderId),
      executeExtraTimeOrder(orderId),
    ]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(mock.updateCalls.length - updatesBefore).toBe(1);
    expect(fx.row.expiryTime).toBe(fx.expiryMs + 10 * DAY_MS);
    expect(await eventCount(fx.service.id, EXTRA_TIME_EVENT_TYPE)).toBe(1);
  });

  it("B6. an UNKNOWN panel outcome defers: order stays PROVISIONING, never refunded", async () => {
    const user = await createUser();
    const fx = await createGlobalService(user, { volumeGb: 20, expireDays: 30 });
    const orderId = await createPaidOrder(user, fx.service.id, "EXTRA_VOLUME", { volumeGb: 10 });

    mock.hangUpdate = true; // update times out mid-flight -> outcome unknown
    try {
      const outcome = await executeExtraVolumeOrder(orderId);
      expect(outcome.ok).toBe(false);
      expect(!outcome.ok && outcome.refunded).toBe(false);
      expect(!outcome.ok && outcome.error).toBe(SERVICE_LOCK_LOST_TEXT);
    } finally {
      mock.hangUpdate = false;
    }

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("PROVISIONING"); // left for reconciliation
    expect(await refundCount(orderId)).toBe(0); // NEVER refund on uncertainty
    expect(await eventCount(fx.service.id, EXTRA_VOLUME_EVENT_TYPE)).toBe(0);
  });

  it("B7. toggle: panel-first disable/enable, idempotent repeats, zero financial rows", async () => {
    const user = await createUser();
    const fx = await createGlobalService(user, { volumeGb: 20, expireDays: 30 });
    const financialCounts = async () => ({
      orders: await prisma.order.count({ where: { userId: user.id } }),
      payments: await prisma.payment.count({ where: { userId: user.id } }),
      wallet: await prisma.walletTransaction.count({ where: { userId: user.id } }),
    });
    const before = await financialCounts();

    const disabled = await toggleServiceStatus(user.id, fx.service.id, "DISABLE");
    expect(disabled.ok).toBe(true);
    expect(fx.row.enable).toBe(false);
    expect(
      (await prisma.service.findUniqueOrThrow({ where: { id: fx.service.id } })).status,
    ).toBe("DISABLED");

    const repeat = await toggleServiceStatus(user.id, fx.service.id, "DISABLE");
    expect(repeat.ok).toBe(true);
    expect(repeat.ok && repeat.alreadyDone).toBe(true); // stale click absorbed

    const enabled = await toggleServiceStatus(user.id, fx.service.id, "ENABLE");
    expect(enabled.ok).toBe(true);
    expect(fx.row.enable).toBe(true);
    expect(
      (await prisma.service.findUniqueOrThrow({ where: { id: fx.service.id } })).status,
    ).toBe("ACTIVE");

    const repeatEnable = await toggleServiceStatus(user.id, fx.service.id, "ENABLE");
    expect(repeatEnable.ok).toBe(true);
    expect(repeatEnable.ok && repeatEnable.alreadyDone).toBe(true);

    expect(await financialCounts()).toEqual(before); // no Order/Payment/Wallet rows
    expect(await eventCount(fx.service.id, "SERVICE_DISABLED_BY_USER")).toBe(1);
    expect(await eventCount(fx.service.id, "SERVICE_ENABLED_BY_USER")).toBe(1);
  });

  it("B8. a failed remote toggle leaves the local status untouched", async () => {
    const user = await createUser();
    const fx = await createGlobalService(user, { volumeGb: 20, expireDays: 30 });

    mock.updateFail = true;
    try {
      const outcome = await toggleServiceStatus(user.id, fx.service.id, "DISABLE");
      expect(outcome.ok).toBe(false);
    } finally {
      mock.updateFail = false;
    }
    expect(
      (await prisma.service.findUniqueOrThrow({ where: { id: fx.service.id } })).status,
    ).toBe("ACTIVE"); // unchanged
    expect(await eventCount(fx.service.id, "SERVICE_DISABLED_BY_USER")).toBe(0);
  });

  it("B9. refresh syncs mutable state only, owner-scoped, with clear not-found", async () => {
    const user = await createUser();
    const fx = await createGlobalService(user, { volumeGb: 20, expireDays: 30 });
    const before = await prisma.service.findUniqueOrThrow({ where: { id: fx.service.id } });

    // Remote truth moved: used 6 GB, disabled, +5d expiry.
    mock.traffic.set(fx.row.email, { up: Number(6n * GIB), down: 0 });
    fx.row.enable = false;
    fx.row.expiryTime = fx.expiryMs + 5 * DAY_MS;

    const sync = await syncServiceFromPanel(fx.service.id, user.id);
    expect(sync.ok).toBe(true);
    const after = await prisma.service.findUniqueOrThrow({ where: { id: fx.service.id } });
    expect(after.usedBytes).toBe(6n * GIB);
    expect(after.status).toBe("DISABLED");
    expect(after.expiresAt?.getTime()).toBe(fx.expiryMs + 5 * DAY_MS);
    const metadata = after.remoteMetadata as { clients?: Array<{ email: string }> };
    expect(metadata.clients?.[0]?.email).toBe(fx.row.email); // evidence refreshed
    // Immutable ownership/snapshot state is untouched.
    expect(after.userId).toBe(before.userId);
    expect(after.orderId).toBe(before.orderId);
    expect(after.productId).toBe(before.productId);
    expect(after.username).toBe(before.username);
    expect(after.startsAt.getTime()).toBe(before.startsAt.getTime());

    // Owner scope: a foreign user reaches nothing.
    const stranger = await createUser();
    const foreign = await syncServiceFromPanel(fx.service.id, stranger.id);
    expect(foreign.ok).toBe(false);
    expect(!foreign.ok && foreign.service).toBeNull();

    // Positive absence answers the specified not-found text, row untouched.
    dropClient(fx.row.email);
    const gone = await syncServiceFromPanel(fx.service.id, user.id);
    expect(gone.ok).toBe(false);
    expect(!gone.ok && gone.safeUserMessage).toBe(SYNC_NOT_FOUND_TEXT);
    const untouched = await prisma.service.findUniqueOrThrow({ where: { id: fx.service.id } });
    expect(untouched.usedBytes).toBe(6n * GIB); // last stored values kept
  });

  it("B10. an unreadable panel keeps refresh failing safely (UNKNOWN, no write)", async () => {
    const user = await createUser();
    const fx = await createGlobalService(user, { volumeGb: 20, expireDays: 30 });
    mock.listFailAfter = 0;
    const sync = await syncServiceFromPanel(fx.service.id, user.id);
    expect(sync.ok).toBe(false);
    expect(!sync.ok && sync.safeUserMessage).toBe(SYNC_FAILED_USER_TEXT);
    const row = await prisma.service.findUniqueOrThrow({ where: { id: fx.service.id } });
    expect(row.usedBytes).toBe(0n); // untouched
  });

  it("B11. regeneration stores the new identity and logs booleans only", async () => {
    const user = await createUser();
    const fx = await createGlobalService(user, { volumeGb: 20, expireDays: 30 });
    const oldSubId = fx.row.subId;

    const outcome = await regenerateServiceSubscription(user.id, fx.service.id);
    expect(outcome.ok).toBe(true);
    const service = await prisma.service.findUniqueOrThrow({ where: { id: fx.service.id } });
    expect(service.subscriptionToken).toBe(fx.row.subId);
    expect(service.subscriptionToken).not.toBe(oldSubId);
    expect(mock.clients.some((r) => r.subId === oldSubId)).toBe(false); // old identity dead

    const events = await prisma.serviceEventLog.findMany({
      where: { serviceId: fx.service.id, eventType: SERVICE_SUBSCRIPTION_REGENERATED_EVENT_TYPE },
    });
    expect(events).toHaveLength(1);
    const metadata = JSON.stringify(events[0].metadata);
    expect(metadata).not.toContain(oldSubId); // NEVER old/new identities in logs
    expect(metadata).not.toContain(fx.row.subId);
  });
});

// =============================================================================
// D. Reconciliation (exact expected-state attribution)
// =============================================================================

describe.runIf(hasDeps)("XUI lifecycle reconciliation", () => {
  it("R1. APPLIED: panel already shows the exact post-state -> complete, no refund", async () => {
    const user = await createUser();
    const fx = await createGlobalService(user, { volumeGb: 20, expireDays: 30 });
    const orderId = await createPaidOrder(user, fx.service.id, "EXTRA_VOLUME", { volumeGb: 10 });
    await markProvisioning(orderId);
    await ageOrder(orderId);
    // Simulate "panel mutated, DB commit lost": remote at the exact expected
    // post-state (remaining 20 + 10 = 30 GiB, expiry unchanged, usage 0).
    fx.row.totalGB = Number(30n * GIB);
    mock.traffic.set(fx.row.email, { up: 0, down: 0 });

    const report = await recoverStaleProvisioningOrders(staleCutoff());
    expect(report.completedOrders).toBeGreaterThanOrEqual(1);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("COMPLETED");
    expect(await refundCount(orderId)).toBe(0);
    expect(await eventCount(fx.service.id, EXTRA_VOLUME_EVENT_TYPE)).toBe(1); // anchor created once
    const service = await prisma.service.findUniqueOrThrow({ where: { id: fx.service.id } });
    expect(service.volumeBytes).toBe(30n * GIB); // repaired from panel truth
  });

  it("R2. NOT_APPLIED: panel matches the exact pre-state -> refund exactly once", async () => {
    const user = await createUser();
    const fx = await createGlobalService(user, { volumeGb: 20, expireDays: 30 });
    const orderId = await createPaidOrder(user, fx.service.id, "EXTRA_VOLUME", { volumeGb: 10 });
    await markProvisioning(orderId);
    await ageOrder(orderId);
    // Panel still equals the stored pre-state - positively unapplied.

    await recoverStaleProvisioningOrders(staleCutoff());
    await recoverStaleProvisioningOrders(staleCutoff()); // idempotent re-run

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("FAILED");
    expect(await refundCount(orderId)).toBe(1); // NEVER twice
    expect(await eventCount(fx.service.id, EXTRA_VOLUME_EVENT_TYPE)).toBe(0);
    expect(fx.row.totalGB).toBe(Number(20n * GIB)); // reconciliation never mutates the panel
  });

  it("R3. UNKNOWN: unreadable panel defers - no refund, no completion", async () => {
    const user = await createUser();
    const fx = await createGlobalService(user, { volumeGb: 20, expireDays: 30 });
    const orderId = await createPaidOrder(user, fx.service.id, "EXTRA_VOLUME", { volumeGb: 10 });
    await markProvisioning(orderId);
    await ageOrder(orderId);

    mock.wrongCredentials = true; // auth failure -> cannot check
    try {
      const report = await recoverStaleProvisioningOrders(staleCutoff());
      expect(report.deferredOrders).toBeGreaterThanOrEqual(1);
    } finally {
      mock.wrongCredentials = false;
    }
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("PROVISIONING");
    expect(await refundCount(orderId)).toBe(0);
    expect(await eventCount(fx.service.id, EXTRA_VOLUME_EVENT_TYPE)).toBe(0);
  });

  it("R4. concurrent sweeps settle one stale order exactly once", async () => {
    const user = await createUser();
    const fx = await createGlobalService(user, { volumeGb: 20, expireDays: 30 });
    const orderId = await createPaidOrder(user, fx.service.id, "EXTRA_VOLUME", { volumeGb: 10 });
    await markProvisioning(orderId);
    await ageOrder(orderId);

    await Promise.all([
      recoverStaleProvisioningOrders(staleCutoff()),
      recoverStaleProvisioningOrders(staleCutoff()),
    ]);
    await recoverStaleProvisioningOrders(staleCutoff()); // deferred loser retries

    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("FAILED"); // pre-state match -> refund path
    expect(await refundCount(orderId)).toBe(1);
    expect(await eventCount(fx.service.id, EXTRA_VOLUME_EVENT_TYPE)).toBe(0);
  });

  it("R5. a remote value explainable only by another operation stays UNKNOWN", async () => {
    const user = await createUser();
    const fx = await createGlobalService(user, { volumeGb: 20, expireDays: 30 });
    const orderId = await createPaidOrder(user, fx.service.id, "EXTRA_VOLUME", { volumeGb: 10 });
    await markProvisioning(orderId);
    await ageOrder(orderId);
    // 35 GiB is neither the pre-state (20) nor this order's expected (30).
    fx.row.totalGB = Number(35n * GIB);

    const report = await recoverStaleProvisioningOrders(staleCutoff());
    expect(report.deferredOrders).toBeGreaterThanOrEqual(1);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("PROVISIONING"); // never misattributed as APPLIED
    expect(await refundCount(orderId)).toBe(0);
  });
});

// =============================================================================
// E. Capability gates, legacy compatibility, menu/UI
// =============================================================================

type KeyboardButton = { text: string; callback_data?: string };

function keyboardRows(kb: InlineKeyboard): KeyboardButton[][] {
  return kb.inline_keyboard as KeyboardButton[][];
}

describe.runIf(hasDeps)("XUI capability gates, legacy compatibility and menu", () => {
  it("G1. remote-model classification is explicit and never guesses", async () => {
    const user = await createUser();
    const fx = await createGlobalService(user);
    const legacy = await createLegacyService(user);
    expect(classifyXuiRemoteModel(fx.service)).toBe("GLOBAL_CLIENT");
    expect(classifyXuiRemoteModel(legacy)).toBe("LEGACY_PER_INBOUND");
    const unknown = { ...legacy, remoteMetadata: null };
    expect(classifyXuiRemoteModel(unknown)).toBe("UNKNOWN");
    expect(serviceSupportsGlobalLifecycle(fx.service)).toBe(true);
    expect(serviceSupportsGlobalLifecycle(legacy)).toBe(false);
    expect(serviceSupportsGlobalLifecycle(unknown)).toBe(false); // unprovable = blocked
  });

  it("G2. detail actions: all shown for GLOBAL_CLIENT, all mutating hidden for legacy", async () => {
    const user = await createUser();
    const fx = await createGlobalService(user);
    const actions = await resolveServiceDetailActions(fx.service);
    expect(actions.canRenew).toBe(true);
    expect(actions.canBuyExtraVolume).toBe(true);
    expect(actions.canBuyExtraTime).toBe(true);
    expect(actions.canRegenerateLink).toBe(true);
    expect(actions.toggleAction).toBe("DISABLE");

    const legacy = await createLegacyService(user);
    const legacyActions = await resolveServiceDetailActions(legacy);
    expect(legacyActions.canRenew).toBe(false);
    expect(legacyActions.canBuyExtraVolume).toBe(false);
    expect(legacyActions.canBuyExtraTime).toBe(false);
    expect(legacyActions.canRegenerateLink).toBe(false);
    expect(legacyActions.toggleAction).toBeNull();
  });

  it("G3. the detail keyboard exposes no dead buttons and keeps back navigation", async () => {
    const user = await createUser();
    const fx = await createGlobalService(user);
    const service = await prisma.service.findUniqueOrThrow({ where: { id: fx.service.id } });
    const actions = await resolveServiceDetailActions(service);
    const rows = keyboardRows(serviceDetailKeyboard(service, actions));
    const buttons = rows.flat();

    // Every visible button routes to a REAL handler namespace.
    const realRoutes = new RegExp(
      `^(user:svc:|user:nsvc:|user:renew:svc:|user:ev:svc:|user:et:svc:|${CB.USER_MENU}$|${CB.USER_SUPPORT}$)`,
    );
    for (const button of buttons) {
      expect(button.callback_data).toMatch(realRoutes);
    }
    // Unimplemented master-menu slots stay hidden - never placeholders.
    const labels = buttons.map((b) => b.text);
    for (const dead of ["QR Code", "تغییر یادداشت ✏️", "انتقال سرویس", "آموزش اتصال"]) {
      expect(labels).not.toContain(dead);
    }
    // Row 8 back navigation: list + main menu on the final row (doc order).
    const lastRow = rows.at(-1) ?? [];
    expect(lastRow[0]?.text).toBe("بازگشت به لیست");
    expect(lastRow[1]?.text).toBe("بازگشت به منوی اصلی");
    // Row 7 support entry routes into the existing ticket flow.
    expect(buttons.some((b) => b.text === "مشکل دارم" && b.callback_data === CB.USER_SUPPORT)).toBe(
      true,
    );
  });

  it("G4. admin capability page: verified statuses per specification", async () => {
    const ready = await prisma.panel.findUniqueOrThrow({ where: { id: xuiPanel.id } });
    const readyLines = panelCapabilityStatusLines(ready);
    expect(readyLines).toHaveLength(8);
    for (const line of readyLines) {
      expect(line.endsWith(CAPABILITY_STATUS_TEXT.supported)).toBe(true);
    }
    expect(readyLines[0]).toBe(`ساخت سرویس: ${CAPABILITY_STATUS_TEXT.supported}`);
    expect(readyLines[6]).toBe(`تغییر لینک: ${CAPABILITY_STATUS_TEXT.supported}`);

    const untested = { ...ready, provisioningReady: null } as Panel;
    for (const line of panelCapabilityStatusLines(untested)) {
      expect(line.endsWith(CAPABILITY_STATUS_TEXT.retestNeeded)).toBe(true); // never doc-enabled
    }

    const incompatible = { ...ready, apiVariant: "LEGACY_MHSANAEI_V1" } as Panel;
    for (const line of panelCapabilityStatusLines(incompatible)) {
      expect(line.endsWith(CAPABILITY_STATUS_TEXT.incompatibleApi)).toBe(true);
    }
  });

  it("G5. legacy services vanish from every paid-operation eligibility path", async () => {
    const user = await createUser();
    const legacy = await createLegacyService(user);
    const shortId = legacy.id.slice(0, 8);

    expect((await listRenewableServices(user.id, 1)).total).toBe(0);
    expect((await listExtraVolumeServices(user.id, 1)).total).toBe(0);
    expect((await listExtraTimeServices(user.id, 1)).total).toBe(0);
    expect(await getRenewableServiceByShortId(shortId, user.id)).toBeNull();
    expect(await getExtraVolumeServiceByShortId(shortId, user.id)).toBeNull();
    expect(await getExtraTimeServiceByShortId(shortId, user.id)).toBeNull();

    const plan = await productWithRelations();
    expect(isRenewalPlanValid(plan, legacy, "F")).toBe(false);
    expect(isExtraVolumePackageValid(plan, legacy, "F")).toBe(false);
    expect(isExtraTimePackageValid(plan, legacy, "F")).toBe(false);

    // A GLOBAL_CLIENT sibling stays fully eligible through the same paths.
    const fx = await createGlobalService(user);
    expect((await listRenewableServices(user.id, 1)).total).toBe(1);
    expect(await getRenewableServiceByShortId(fx.service.id.slice(0, 8), user.id)).not.toBeNull();
    expect(isRenewalPlanValid(plan, fx.service, "F")).toBe(true);
  });

  it("G6. wallet payment refuses a legacy target BEFORE any debit", async () => {
    const user = await createUser(1_000_000);
    const legacy = await createLegacyService(user);

    const { result } = await payRenewalDraftWithWallet(user, {
      serviceId: legacy.id,
      productId: product.id,
      panelId: xuiPanel.id,
      categoryId: category.id,
      originalPriceToman: PRICE,
      discountAmountToman: 0,
      finalPriceToman: PRICE,
      draftNonce: randomUUID(),
    });
    expect(result.ok).toBe(false);

    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(fresh.balanceToman).toBe(1_000_000); // wallet untouched
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0); // no payable order
    expect(await prisma.walletTransaction.count({ where: { userId: user.id } })).toBe(0);
  });

  it("G7. a paid order that reaches a legacy service refunds without touching the panel", async () => {
    const user = await createUser();
    const legacy = await createLegacyService(user);
    const orderId = await createPaidOrder(user, legacy.id, "SERVICE_RENEWAL", {
      volumeGb: 10,
      durationDays: 30,
    });

    const updatesBefore = mock.updateCalls.length;
    const outcome = await executeRenewalOrder(orderId);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toBe(XUI_LEGACY_OPERATION_TEXT); // clear unsupported result
    expect(mock.updateCalls.length).toBe(updatesBefore); // global endpoints never touched
    expect(mock.legacyEndpointCalls).toBe(0); // and never "migrated"
    expect(await refundCount(orderId)).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe(
      "FAILED",
    );
  });

  it("G8. toggle and regeneration block legacy services with the specified text", async () => {
    const user = await createUser();
    const legacy = await createLegacyService(user);

    const toggled = await toggleServiceStatus(user.id, legacy.id, "DISABLE");
    expect(toggled.ok).toBe(false);
    expect(!toggled.ok && toggled.safeUserMessage).toBe(XUI_LEGACY_OPERATION_TEXT);

    const regenerated = await regenerateServiceSubscription(user.id, legacy.id);
    expect(regenerated.ok).toBe(false);
    expect(!regenerated.ok && regenerated.safeUserMessage).toBe(XUI_LEGACY_OPERATION_TEXT);

    expect(mock.updateCalls).toHaveLength(0); // nothing reached the panel
    expect((await prisma.service.findUniqueOrThrow({ where: { id: legacy.id } })).status).toBe(
      "ACTIVE",
    );
  });

  it("G9. legacy services stay READABLE: refresh keeps working via safe aggregation", async () => {
    const user = await createUser();
    const legacy = await createLegacyService(user);
    const sync = await syncServiceFromPanel(legacy.id, user.id);
    expect(sync.ok).toBe(true); // read-only aggregation over per-inbound labels
    expect(mock.updateCalls).toHaveLength(0); // reading never mutates
  });

  it("G10. stale readiness blocks sellability before payment", async () => {
    const plan = await productWithRelations();
    expect(isProductVisible(plan, "F")).toBe(true);

    await prisma.panel.update({ where: { id: xuiPanel.id }, data: { provisioningReady: false } });
    try {
      const stale = await productWithRelations();
      expect(isProductVisible(stale, "F")).toBe(false); // blocked before checkout
    } finally {
      await prisma.panel.update({ where: { id: xuiPanel.id }, data: { provisioningReady: true } });
    }
  });
});

describe.runIf(!hasDeps)("XUI lifecycle (skipped)", () => {
  it("requires DATABASE_URL and REDIS_URL - see docs/testing.md", () => {
    expect(hasDeps).toBe(false);
  });
});
