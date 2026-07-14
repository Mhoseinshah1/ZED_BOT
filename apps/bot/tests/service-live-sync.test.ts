import { readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prisma, type Panel, type Service, type User } from "@zedbot/database";
import {
  MarzbanAdapter,
  MarzbanClient,
  XuiAdapter,
  XuiClient,
} from "@zedbot/panel-adapters";
import { encryptSecret } from "@zedbot/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "service-live-sync-tests-secret-1";
// Keep panel HTTP bounded but ABOVE the hang delays used by the timeout
// tests, so a display-budget cutoff still lets the background sync finish.
process.env.PANEL_HTTP_TIMEOUT_MS ??= "1500";

import { serviceDetailText } from "../src/handlers/user-services/service-views.js";
import {
  SYNC_NOT_FOUND_TEXT,
  SYNC_PANEL_UNAVAILABLE_TEXT,
  SYNC_STALE_FALLBACK_TEXT,
  SYNC_TIMEOUT_FALLBACK_TEXT,
  serviceListSyncEnabled,
  serviceSyncDisplayTimeoutMs,
  serviceSyncTtlMs,
  syncServiceForDisplay,
} from "../src/services/service-sync.service.js";

// =============================================================================
// Service live-sync tests (service-live-sync phase): opening a service page
// synchronizes it from the panel BEFORE rendering.
//
//   MARZBAN        - open triggers sync, fresh traffic/expiry rendered, token
//                    extraction, API-failure fallback keeps stored values
//   XUI / SANAEI   - client+inbound lookup, traffic/expiry/status sync,
//                    subscription info incl. live config links
//   ADAPTER CONTRACT - syncService/getServiceStatus/getTrafficUsage/getExpiry/
//                    getSubscriptionInfo derive from ONE read; null on failure
//   DETAIL FLOW    - fresh data without manual refresh, unavailable-panel
//                    fallback, financial data untouched
//   PERFORMANCE    - display budget cutoff (background sync still lands),
//                    TTL cache, repeated opens hit the panel once
//   SECURITY       - sync logs carry serviceId/panelType/syncResult/duration
//                    and never credentials/tokens/links
//
// Panels are in-process node:http mocks (marzban-provisioning /
// xui-lifecycle patterns). E2E suites skip without DATABASE_URL/REDIS_URL.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";
const hasDeps = hasDb && hasRedis;

const GIB = 1024n * 1024n * 1024n;
const DAY_MS = 86_400_000;
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

// Distinctive secret literals - the SECURITY suite asserts they never leak.
const MZ_USER = "mzadmin";
const MZ_PASS = "mz-live-sync-secret-pass";
const MZ_TOKEN = "mz-live-sync-bearer-token";
const XUI_USER = "xadmin";
const XUI_PASS = "xui-live-sync-secret-pass";
const XUI_SESSION = "mock-3xui-live-sync-session";
/** Nothing listens on port 9 - a guaranteed connection failure. */
const DEAD_HOST = "http://127.0.0.1:9";

// --- mock Marzban panel -------------------------------------------------------------

interface MockMarzbanUser {
  status: string;
  data_limit: number | null;
  used_traffic: number;
  expire: number | null; // unix SECONDS
  subscription_url: string;
  links: string[];
  online_at?: string;
}

const mz = {
  users: new Map<string, MockMarzbanUser>(),
  tokenCalls: 0,
  getUserCalls: 0,
  failToken: false,
  /** Delay (ms) applied to GET /api/user responses; 0 = answer immediately. */
  getUserDelayMs: 0,
};

function seedMarzbanUser(username: string, partial: Partial<MockMarzbanUser> = {}): MockMarzbanUser {
  const user: MockMarzbanUser = {
    status: "active",
    data_limit: Number(20n * GIB),
    used_traffic: Number(2n * GIB),
    expire: Math.floor((Date.now() + 30 * DAY_MS) / 1000),
    subscription_url: `/sub/mztok-${username}/`,
    links: [`vless://${username}@mz.example.com:443`],
    ...partial,
  };
  mz.users.set(username, user);
  return user;
}

// --- mock 3X-UI panel ---------------------------------------------------------------

interface MockXuiClient {
  email: string;
  subId: string;
  uuid: string;
  totalGB: number;
  expiryTime: number;
  enable: boolean;
  up: number;
  down: number;
  inboundIds: number[];
  lastOnline: number;
}

const xui = {
  clients: [] as MockXuiClient[],
  listCalls: 0,
  linksCalls: 0,
  /** Delay (ms) applied to clients/list responses; 0 = answer immediately. */
  listDelayMs: 0,
  links: new Map<string, string[]>(),
};

function seedXuiClient(partial: Partial<MockXuiClient> & { email: string }): MockXuiClient {
  const row: MockXuiClient = {
    subId: `sub-${partial.email}`,
    uuid: `uuid-${partial.email}`,
    totalGB: Number(20n * GIB),
    expiryTime: Date.now() + 30 * DAY_MS,
    enable: true,
    up: 0,
    down: 0,
    inboundIds: [1],
    lastOnline: 0,
    ...partial,
  };
  xui.clients.push(row);
  xui.links.set(row.email, [`vless://${row.uuid}@xui.example.com:443?remark=${row.email}`]);
  return row;
}

function xuiClientJson(row: MockXuiClient): Record<string, unknown> {
  return {
    id: xui.clients.indexOf(row) + 1,
    email: row.email,
    subId: row.subId,
    uuid: row.uuid,
    password: "",
    flow: "",
    totalGB: row.totalGB,
    expiryTime: row.expiryTime,
    enable: row.enable,
    inboundIds: row.inboundIds,
    traffic: {
      email: row.email,
      up: row.up,
      down: row.down,
      total: row.totalGB,
      expiryTime: row.expiryTime,
      enable: row.enable,
      lastOnline: row.lastOnline,
    },
  };
}

let mzServer: http.Server;
let xuiServer: http.Server;
let mzHost = "";
let xuiHost = "";

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resetMockFlags(): void {
  mz.tokenCalls = 0;
  mz.getUserCalls = 0;
  mz.failToken = false;
  mz.getUserDelayMs = 0;
  xui.listCalls = 0;
  xui.linksCalls = 0;
  xui.listDelayMs = 0;
}

const SYNC_ENV_KEYS = [
  "SERVICE_SYNC_TTL_SECONDS",
  "SERVICE_SYNC_DISPLAY_TIMEOUT_MS",
  "SERVICE_LIST_SYNC_ENABLED",
] as const;

beforeAll(async () => {
  mzServer = http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/api/admin/token") {
        mz.tokenCalls += 1;
        if (mz.failToken) {
          json(res, 401, { detail: "invalid credentials" });
          return;
        }
        json(res, 200, { access_token: MZ_TOKEN, token_type: "bearer" });
        return;
      }
      if (req.method === "GET" && url.startsWith("/api/user/")) {
        if ((req.headers.authorization ?? "") !== `Bearer ${MZ_TOKEN}`) {
          json(res, 401, { detail: "unauthorized" });
          return;
        }
        if (mz.getUserDelayMs > 0) {
          await delay(mz.getUserDelayMs);
        }
        mz.getUserCalls += 1;
        const username = decodeURIComponent(url.slice("/api/user/".length));
        const user = mz.users.get(username);
        if (user === undefined) {
          json(res, 404, { detail: "User not found" });
          return;
        }
        json(res, 200, { username, ...user });
        return;
      }
      json(res, 404, { detail: "not found" });
    })();
  });
  await new Promise<void>((resolve) => {
    mzServer.listen(0, "127.0.0.1", () => {
      mzHost = `http://127.0.0.1:${(mzServer.address() as { port: number }).port}`;
      resolve();
    });
  });

  xuiServer = http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/login") {
        json(
          res,
          200,
          { success: true, msg: "Login Successfully", obj: null },
          { "Set-Cookie": `3x-ui=${XUI_SESSION}; Path=/; HttpOnly` },
        );
        return;
      }
      if ((req.headers.cookie ?? "") !== `3x-ui=${XUI_SESSION}`) {
        res.writeHead(302, { Location: "/" });
        res.end();
        return;
      }
      if (req.method === "GET" && url === "/panel/api/inbounds/list") {
        json(res, 200, { success: true, msg: "", obj: [{ id: 1, enable: true, protocol: "vless" }] });
        return;
      }
      if (req.method === "GET" && url === "/panel/api/clients/list") {
        if (xui.listDelayMs > 0) {
          await delay(xui.listDelayMs);
        }
        xui.listCalls += 1;
        json(res, 200, { success: true, msg: "", obj: xui.clients.map(xuiClientJson) });
        return;
      }
      if (req.method === "GET" && url.startsWith("/panel/api/clients/links/")) {
        xui.linksCalls += 1;
        const email = decodeURIComponent(url.slice("/panel/api/clients/links/".length));
        json(res, 200, { success: true, msg: "", obj: xui.links.get(email) ?? [] });
        return;
      }
      json(res, 404, { success: false, msg: "not found" });
    })();
  });
  await new Promise<void>((resolve) => {
    xuiServer.listen(0, "127.0.0.1", () => {
      xuiHost = `http://127.0.0.1:${(xuiServer.address() as { port: number }).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  mzServer?.close();
  xuiServer?.close();
  if (hasDeps) {
    await prisma.$disconnect();
  }
});

afterEach(() => {
  resetMockFlags();
  for (const key of SYNC_ENV_KEYS) {
    delete process.env[key];
  }
});

// --- adapter factories for the contract tests (no DB needed) --------------------------

function marzbanAdapter(baseUrl = mzHost): MarzbanAdapter {
  return new MarzbanAdapter(new MarzbanClient({ baseUrl, username: MZ_USER, password: MZ_PASS }));
}

function xuiAdapter(baseUrl = xuiHost): XuiAdapter {
  return new XuiAdapter(
    new XuiClient({ baseUrl, username: XUI_USER, password: XUI_PASS, apiVariant: "SANAEI" }),
  );
}

// --- DB fixtures ----------------------------------------------------------------------

let mzPanel: Panel;
let xuiPanel: Panel;

beforeAll(async () => {
  if (!hasDeps) {
    return;
  }
  mzPanel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `live-sync-mz-${runTag}`,
      baseUrl: mzHost,
      username: MZ_USER,
      passwordEncrypted: encryptSecret(MZ_PASS),
      status: "ACTIVE",
      provisioningReady: true,
    },
  });
  xuiPanel = await prisma.panel.create({
    data: {
      type: "XUI",
      name: `live-sync-xui-${runTag}`,
      baseUrl: xuiHost,
      username: XUI_USER,
      passwordEncrypted: encryptSecret(XUI_PASS),
      inboundIds: [1],
      status: "ACTIVE",
      provisioningReady: true,
    },
  });
});

async function createUser(balanceToman = 0): Promise<User> {
  seq += 1;
  return prisma.user.create({ data: { telegramId: runTag + BigInt(seq), balanceToman } });
}

/**
 * A STALE service row (never synced, zeroed usage) so tests can prove the
 * fresh values came from the panel, not from the fixture.
 */
async function createServiceRow(
  user: User,
  panel: Panel,
  username: string,
  overrides: Partial<Parameters<typeof prisma.service.create>[0]["data"]> = {},
): Promise<Service> {
  return prisma.service.create({
    data: {
      userId: user.id,
      panelId: panel.id,
      panelType: panel.type,
      username,
      status: "ACTIVE",
      volumeBytes: 10n * GIB,
      usedBytes: 0n,
      remainingBytes: 10n * GIB,
      expiresAt: new Date(Date.now() + 5 * DAY_MS),
      startsAt: new Date(),
      lastSubscriptionUpdateAt: null,
      ...overrides,
    },
  });
}

function mzUsername(): string {
  seq += 1;
  return `mzsync-${runTag}-${seq}`;
}

function xuiUsername(): string {
  seq += 1;
  return `xsync-${runTag}-${seq}`;
}

// =============================================================================
// MARZBAN
// =============================================================================

describe.runIf(hasDeps)("MARZBAN: opening a service syncs live panel state (1-4)", () => {
  it("1. opening the service triggers the sync and renders LIVE traffic and expiry", async () => {
    const user = await createUser();
    const username = mzUsername();
    const freshExpire = Math.floor((Date.now() + 42 * DAY_MS) / 1000);
    seedMarzbanUser(username, {
      data_limit: Number(30n * GIB),
      used_traffic: Number(7n * GIB),
      expire: freshExpire,
    });
    const stale = await createServiceRow(user, mzPanel, username);

    const display = await syncServiceForDisplay(stale, user.id);

    expect(display.outcome).toBe("synced");
    expect(display.fresh).toBe(true);
    expect(display.notice).toBeNull();
    expect(mz.getUserCalls).toBe(1); // the open itself hit the panel
    // The row was UPDATED from the panel...
    expect(display.service.usedBytes).toBe(7n * GIB);
    expect(display.service.volumeBytes).toBe(30n * GIB);
    expect(display.service.remainingBytes).toBe(23n * GIB);
    expect(display.service.expiresAt?.getTime()).toBe(freshExpire * 1000);
    expect(display.service.lastSubscriptionUpdateAt).not.toBeNull();
    // ...and the rendered detail page shows the LIVE numbers, no refresh press.
    const text = serviceDetailText(display.service, display.notice);
    expect(text).toContain("ترافیک مصرف‌شده: 7 گیگابایت");
    expect(text).toContain("ترافیک باقی‌مانده: 23 گیگابایت");
    expect(text).not.toContain(SYNC_STALE_FALLBACK_TEXT);
  });

  it("2. a second open outside the TTL picks up NEW panel numbers", async () => {
    const user = await createUser();
    const username = mzUsername();
    const remote = seedMarzbanUser(username, { used_traffic: Number(1n * GIB) });
    const stale = await createServiceRow(user, mzPanel, username);

    const first = await syncServiceForDisplay(stale, user.id);
    expect(first.service.usedBytes).toBe(1n * GIB);

    // Usage moved on the panel; TTL 0 = every open re-syncs.
    remote.used_traffic = Number(3n * GIB);
    process.env.SERVICE_SYNC_TTL_SECONDS = "0";
    const second = await syncServiceForDisplay(first.service, user.id);
    expect(second.outcome).toBe("synced");
    expect(second.service.usedBytes).toBe(3n * GIB);
    expect(mz.getUserCalls).toBe(2);
  });

  it("3. Marzban subscription token is extracted from the documented /sub/ URL shape", async () => {
    const user = await createUser();
    const username = mzUsername();
    seedMarzbanUser(username, { subscription_url: `/sub/mztok-${username}/` });
    const stale = await createServiceRow(user, mzPanel, username);

    const display = await syncServiceForDisplay(stale, user.id);
    expect(display.outcome).toBe("synced");
    expect(display.service.subscriptionToken).toBe(`mztok-${username}`);
    expect(display.service.subscriptionUrl).toContain(`/sub/mztok-${username}`);
  });

  it("4. API failure falls back to the stored values with a safe Persian notice", async () => {
    const user = await createUser();
    const username = mzUsername();
    seedMarzbanUser(username);
    const stale = await createServiceRow(user, mzPanel, username, { usedBytes: 4n * GIB });

    mz.failToken = true; // auth failure = the panel is unreachable for us
    const display = await syncServiceForDisplay(stale, user.id);

    expect(display.outcome).toBe("panel-unavailable");
    expect(display.fresh).toBe(false);
    expect(display.notice).toBe(SYNC_PANEL_UNAVAILABLE_TEXT);
    // Stored values stay on screen - the row was NOT touched.
    expect(display.service.usedBytes).toBe(4n * GIB);
    expect(display.service.lastSubscriptionUpdateAt).toBeNull();
    const text = serviceDetailText(display.service, display.notice);
    expect(text).toContain("ترافیک مصرف‌شده: 4 گیگابایت");
    expect(text).toContain(`⚠️ ${SYNC_PANEL_UNAVAILABLE_TEXT}`);
    // No technical error reaches the rendered page.
    expect(text).not.toContain("unauthorized");
    expect(text).not.toContain("invalid credentials");
    expect(text).not.toContain("Marzban");
  });
});

// =============================================================================
// XUI / SANAEI
// =============================================================================

describe.runIf(hasDeps)("XUI: client lookup and live normalization (5-9)", () => {
  it("5. client + inbound lookup: the global client is found by email with its inbounds", async () => {
    const user = await createUser();
    const username = xuiUsername();
    seedXuiClient({ email: username, inboundIds: [1, 3] });
    const stale = await createServiceRow(user, xuiPanel, username);

    const display = await syncServiceForDisplay(stale, user.id);
    expect(display.outcome).toBe("synced");
    expect(xui.listCalls).toBe(1);
    const metadata = display.service.remoteMetadata as {
      clients?: Array<{ email: string; inboundIds: number[] }>;
    };
    expect(metadata.clients).toEqual([{ email: username, inboundIds: [1, 3] }]);
  });

  it("6. traffic sync: up+down usage, limit and remaining land on the row", async () => {
    const user = await createUser();
    const username = xuiUsername();
    seedXuiClient({
      email: username,
      totalGB: Number(50n * GIB),
      up: Number(2n * GIB),
      down: Number(8n * GIB),
    });
    const stale = await createServiceRow(user, xuiPanel, username);

    const display = await syncServiceForDisplay(stale, user.id);
    expect(display.service.usedBytes).toBe(10n * GIB);
    expect(display.service.volumeBytes).toBe(50n * GIB);
    expect(display.service.remainingBytes).toBe(40n * GIB);
    const text = serviceDetailText(display.service, display.notice);
    expect(text).toContain("ترافیک مصرف‌شده: 10 گیگابایت");
    expect(text).toContain("ترافیک باقی‌مانده: 40 گیگابایت");
  });

  it("7. expiry sync: the panel's expiryTime replaces the stored expiry", async () => {
    const user = await createUser();
    const username = xuiUsername();
    const expiryMs = Date.now() + 77 * DAY_MS;
    seedXuiClient({ email: username, expiryTime: expiryMs });
    const stale = await createServiceRow(user, xuiPanel, username);

    const display = await syncServiceForDisplay(stale, user.id);
    expect(display.service.expiresAt?.getTime()).toBe(expiryMs);
  });

  it("8. status sync: enable=false -> DISABLED; past expiry -> EXPIRED", async () => {
    const user = await createUser();
    const disabledName = xuiUsername();
    seedXuiClient({ email: disabledName, enable: false });
    const disabledStale = await createServiceRow(user, xuiPanel, disabledName);
    const disabled = await syncServiceForDisplay(disabledStale, user.id);
    expect(disabled.service.status).toBe("DISABLED");

    const expiredName = xuiUsername();
    seedXuiClient({ email: expiredName, expiryTime: Date.now() - DAY_MS });
    const expiredStale = await createServiceRow(user, xuiPanel, expiredName);
    const expired = await syncServiceForDisplay(expiredStale, user.id);
    expect(expired.service.status).toBe("EXPIRED");
  });

  it("9. subscription sync: subId token + LIVE config links from the panel's link builder", async () => {
    const user = await createUser();
    const username = xuiUsername();
    const row = seedXuiClient({ email: username });
    const stale = await createServiceRow(user, xuiPanel, username);

    const display = await syncServiceForDisplay(stale, user.id);
    expect(display.service.subscriptionToken).toBe(row.subId);
    expect(xui.linksCalls).toBe(1);
    expect(display.service.configLinks).toEqual([
      `vless://uuid-${username}@xui.example.com:443?remark=${username}`,
    ]);
  });
});

// =============================================================================
// ADAPTER CONTRACT (mock servers only - no DB)
// =============================================================================

describe("ADAPTER CONTRACT: unified sync surface derives from ONE read (10-12)", () => {
  it("10. Marzban accessors return live values; nulls are never invented", async () => {
    const username = mzUsername();
    const expire = Math.floor((Date.now() + 10 * DAY_MS) / 1000);
    seedMarzbanUser(username, {
      data_limit: Number(20n * GIB),
      used_traffic: Number(5n * GIB),
      expire,
    });
    const adapter = marzbanAdapter();
    const input = { username };

    expect(await adapter.getServiceStatus(input)).toBe("active");
    expect(await adapter.getTrafficUsage(input)).toEqual({
      usedBytes: 5n * GIB,
      totalBytes: 20n * GIB,
      remainingBytes: 15n * GIB,
    });
    expect((await adapter.getExpiry(input))?.getTime()).toBe(expire * 1000);
    const subscription = await adapter.getSubscriptionInfo(input);
    expect(subscription?.subscriptionToken).toBe(`mztok-${username}`);
    const snapshot = await adapter.syncService(input);
    expect(snapshot.ok).toBe(true);
    expect(snapshot.usedBytes).toBe(5n * GIB);

    // Unlimited/never-expires stays null - not a fabricated number/date.
    const unlimitedName = mzUsername();
    seedMarzbanUser(unlimitedName, { data_limit: null, expire: null });
    expect(await adapter.getExpiry({ username: unlimitedName })).toBeNull();
    expect((await adapter.getTrafficUsage({ username: unlimitedName }))?.totalBytes).toBeNull();
  });

  it("11. XUI accessors return live values from the global-client inventory", async () => {
    const username = xuiUsername();
    const expiryMs = Date.now() + 12 * DAY_MS;
    const row = seedXuiClient({
      email: username,
      totalGB: Number(40n * GIB),
      up: Number(1n * GIB),
      down: Number(3n * GIB),
      expiryTime: expiryMs,
    });
    const adapter = xuiAdapter();
    const input = { username, subscriptionBaseUrl: "https://sub.example.com" };

    expect(await adapter.getServiceStatus(input)).toBe("active");
    expect(await adapter.getTrafficUsage(input)).toEqual({
      usedBytes: 4n * GIB,
      totalBytes: 40n * GIB,
      remainingBytes: 36n * GIB,
    });
    expect((await adapter.getExpiry(input))?.getTime()).toBe(expiryMs);
    const subscription = await adapter.getSubscriptionInfo(input);
    expect(subscription?.subscriptionToken).toBe(row.subId);
    expect(subscription?.subscriptionUrl).toContain(row.subId);
    expect(subscription?.configLinks).toHaveLength(1);
  });

  it("12. every accessor answers null on an unreachable panel - no value is invented", async () => {
    for (const adapter of [marzbanAdapter(DEAD_HOST), xuiAdapter(DEAD_HOST)]) {
      const input = { username: "whoever" };
      expect(await adapter.getServiceStatus(input)).toBeNull();
      expect(await adapter.getTrafficUsage(input)).toBeNull();
      expect(await adapter.getExpiry(input)).toBeNull();
      expect(await adapter.getSubscriptionInfo(input)).toBeNull();
      const snapshot = await adapter.syncService(input);
      expect(snapshot.ok).toBe(false);
    }
  });
});

// =============================================================================
// SERVICE DETAIL FLOW
// =============================================================================

describe.runIf(hasDeps)("DETAIL FLOW: auto-sync wiring, fallbacks, finances untouched (13-15)", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const handlerSrc = readFileSync(
    path.join(repoRoot, "apps/bot/src/handlers/user-services/services.handler.ts"),
    "utf8",
  );

  it("13. the detail route syncs BEFORE rendering; manual refresh stays available", () => {
    // Opening user:svc:view runs the display sync first...
    const viewRoute = handlerSrc.slice(handlerSrc.indexOf("user:svc:view"));
    expect(viewRoute).toContain("syncServiceForDisplay");
    expect(viewRoute.indexOf("syncServiceForDisplay")).toBeLessThan(
      viewRoute.indexOf("renderDetail"),
    );
    // ...while the manual refresh route keeps its force-sync path (the TTL
    // never swallows an explicit refresh press).
    expect(handlerSrc).toContain("user:svc:refresh");
    const refreshRoute = handlerSrc.slice(handlerSrc.indexOf("user:svc:refresh"));
    expect(refreshRoute).toContain("syncServiceFromPanel(owned.id, user.id)");
    // The list page syncs only when the operator opted in.
    expect(handlerSrc).toContain("serviceListSyncEnabled()");
  });

  it("14. a service missing on the panel renders stored values with the not-found notice", async () => {
    const user = await createUser();
    const username = mzUsername(); // never seeded on the mock -> 404
    const stale = await createServiceRow(user, mzPanel, username, { usedBytes: 1n * GIB });

    const display = await syncServiceForDisplay(stale, user.id);
    expect(display.outcome).toBe("not-found");
    expect(display.notice).toBe(SYNC_NOT_FOUND_TEXT);
    expect(display.service.usedBytes).toBe(1n * GIB); // untouched
    expect(serviceDetailText(display.service, display.notice)).toContain(SYNC_NOT_FOUND_TEXT);
  });

  it("15. sync never touches financial records", async () => {
    const user = await createUser(150_000);
    const username = mzUsername();
    seedMarzbanUser(username);
    const stale = await createServiceRow(user, mzPanel, username);
    const payment = await prisma.payment.create({
      data: {
        userId: user.id,
        purpose: "WALLET_CHARGE",
        status: "APPROVED",
        amountToman: 150_000,
        payableAmountToman: 150_000,
      },
    });
    const ordersBefore = await prisma.order.count();
    const walletTxBefore = await prisma.walletTransaction.count();

    // One successful sync + one failed sync (panel unavailable).
    const synced = await syncServiceForDisplay(stale, user.id);
    expect(synced.outcome).toBe("synced");
    mz.failToken = true;
    process.env.SERVICE_SYNC_TTL_SECONDS = "0";
    const failed = await syncServiceForDisplay(synced.service, user.id);
    expect(failed.outcome).toBe("panel-unavailable");

    const paymentAfter = await prisma.payment.findUnique({ where: { id: payment.id } });
    expect(paymentAfter?.status).toBe("APPROVED");
    expect(paymentAfter?.updatedAt.getTime()).toBe(payment.updatedAt.getTime());
    expect((await prisma.user.findUnique({ where: { id: user.id } }))?.balanceToman).toBe(150_000);
    expect(await prisma.order.count()).toBe(ordersBefore);
    expect(await prisma.walletTransaction.count()).toBe(walletTxBefore);
  });
});

// =============================================================================
// PERFORMANCE (TTL cache + display budget)
// =============================================================================

describe.runIf(hasDeps)("PERFORMANCE: cache, repeated opens and the display budget (16-18)", () => {
  it("16. repeated opens within the TTL hit the panel exactly ONCE", async () => {
    const user = await createUser();
    const username = mzUsername();
    seedMarzbanUser(username);
    const stale = await createServiceRow(user, mzPanel, username);

    const first = await syncServiceForDisplay(stale, user.id);
    expect(first.outcome).toBe("synced");
    let current = first.service;
    for (let i = 0; i < 4; i += 1) {
      const again = await syncServiceForDisplay(current, user.id);
      expect(again.outcome).toBe("cache-fresh"); // default 60s TTL
      expect(again.fresh).toBe(true);
      current = again.service;
    }
    expect(mz.getUserCalls).toBe(1);

    // TTL 0 disables the cache: the next open hits the panel again.
    process.env.SERVICE_SYNC_TTL_SECONDS = "0";
    expect((await syncServiceForDisplay(current, user.id)).outcome).toBe("synced");
    expect(mz.getUserCalls).toBe(2);
  });

  it("17. a slow panel is cut off at the display budget; the sync lands in the background", async () => {
    const user = await createUser();
    const username = xuiUsername();
    seedXuiClient({ email: username, up: Number(6n * GIB) });
    const stale = await createServiceRow(user, xuiPanel, username);

    xui.listDelayMs = 700; // slower than the budget, faster than PANEL_HTTP_TIMEOUT_MS
    process.env.SERVICE_SYNC_DISPLAY_TIMEOUT_MS = "120";
    const startedAt = Date.now();
    const display = await syncServiceForDisplay(stale, user.id);
    const waited = Date.now() - startedAt;

    // The page did NOT wait for the slow panel...
    expect(display.outcome).toBe("timeout");
    expect(waited).toBeLessThan(600);
    expect(display.notice).toBe(SYNC_TIMEOUT_FALLBACK_TEXT);
    expect(display.service.usedBytes).toBe(0n); // stored values rendered
    expect(serviceDetailText(display.service, display.notice)).toContain(
      SYNC_TIMEOUT_FALLBACK_TEXT,
    );

    // ...but the abandoned sync finished in the background and persisted.
    let updated: Service | null = null;
    for (let i = 0; i < 40; i += 1) {
      updated = await prisma.service.findUnique({ where: { id: stale.id } });
      if (updated?.lastSubscriptionUpdateAt !== null) {
        break;
      }
      await delay(100);
    }
    expect(updated?.lastSubscriptionUpdateAt).not.toBeNull();
    expect(updated?.usedBytes).toBe(6n * GIB);
  });

  it("18. env knobs parse with safe defaults", () => {
    expect(serviceSyncTtlMs()).toBe(60_000);
    expect(serviceSyncDisplayTimeoutMs()).toBe(8_000);
    expect(serviceListSyncEnabled()).toBe(false);
    process.env.SERVICE_SYNC_TTL_SECONDS = "5";
    process.env.SERVICE_SYNC_DISPLAY_TIMEOUT_MS = "2500";
    process.env.SERVICE_LIST_SYNC_ENABLED = "true";
    expect(serviceSyncTtlMs()).toBe(5_000);
    expect(serviceSyncDisplayTimeoutMs()).toBe(2_500);
    expect(serviceListSyncEnabled()).toBe(true);
    process.env.SERVICE_SYNC_TTL_SECONDS = "garbage";
    expect(serviceSyncTtlMs()).toBe(60_000);
  });
});

// =============================================================================
// SECURITY
// =============================================================================

describe.runIf(hasDeps)("SECURITY: sync logs carry safe fields only (19)", () => {
  it("19. display-sync logs contain serviceId/panelType/syncResult/duration and no secrets", async () => {
    const user = await createUser();
    const username = mzUsername();
    seedMarzbanUser(username);
    const stale = await createServiceRow(user, mzPanel, username);

    const savedLogLevel = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "info";
    const written: string[] = [];
    const stdoutWrite = process.stdout.write;
    const stderrWrite = process.stderr.write;
    const capture = ((chunk: unknown): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    process.stdout.write = capture;
    process.stderr.write = capture;
    try {
      const synced = await syncServiceForDisplay(stale, user.id);
      expect(synced.outcome).toBe("synced");
      mz.failToken = true;
      process.env.SERVICE_SYNC_TTL_SECONDS = "0";
      const failed = await syncServiceForDisplay(synced.service, user.id);
      expect(failed.outcome).toBe("panel-unavailable");
    } finally {
      process.stdout.write = stdoutWrite;
      process.stderr.write = stderrWrite;
      if (savedLogLevel === undefined) {
        delete process.env.LOG_LEVEL;
      } else {
        process.env.LOG_LEVEL = savedLogLevel;
      }
    }

    const output = written.join("");
    // The audit fields are there...
    expect(output).toContain("service display sync");
    expect(output).toContain(stale.id);
    expect(output).toContain("MARZBAN");
    expect(output).toContain('"syncResult":"synced"');
    expect(output).toContain('"syncResult":"panel-unavailable"');
    expect(output).toContain("durationMs");
    // ...and no credential, token, cookie or subscription link ever is.
    expect(output).not.toContain(MZ_PASS);
    expect(output).not.toContain(MZ_TOKEN);
    expect(output).not.toContain(XUI_PASS);
    expect(output).not.toContain(XUI_SESSION);
    expect(output).not.toContain("mztok-");
    expect(output).not.toContain("Bearer");
  });
});

describe.skipIf(hasDeps)("service live sync (skipped)", () => {
  it("live-sync E2E tests require DATABASE_URL and REDIS_URL - see docs/testing.md", () => {
    expect(hasDeps).toBe(false);
  });
});
