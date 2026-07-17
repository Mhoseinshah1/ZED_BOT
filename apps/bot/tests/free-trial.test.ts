import http from "node:http";

import {
  FreeTrialClaimStatus,
  prisma,
  type Panel,
  type User,
} from "@zedbot/database";
import { encryptSecret } from "@zedbot/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "zedbot-free-trial-tests-secret-0001";
process.env.PANEL_HTTP_TIMEOUT_MS = "800";

import { buildUserMainKeyboard } from "../src/keyboards/user-main.keyboard.js";
import {
  setFreeTrialEnabled,
  FREE_TRIAL_ONCE_PER_USER_KEY,
  FREE_TRIAL_COOLDOWN_DAYS_KEY,
  FREE_TRIAL_REQUIRE_NO_PURCHASE_KEY,
} from "../src/services/free-trial-settings.service.js";
import {
  assessTrialPanelConfig,
  checkTrialEligibility,
  claimFreeTrial,
  reconcileTrialClaim,
  buildTrialSuccessMessage,
  trialOwnershipMarker,
  TRIAL_ALREADY_USED_TEXT,
  TRIAL_CAPACITY_FULL_TEXT,
  TRIAL_IN_PROGRESS_TEXT,
  TRIAL_NO_PURCHASE_ONLY_TEXT,
} from "../src/services/free-trial.service.js";
import { ftCb } from "../src/handlers/user-free-trial/free-trial.handler.js";
import { buildAdapterForPanel } from "../src/services/panel-adapter-factory.js";
import { setSetting, clearSettingsCache } from "../src/services/settings.service.js";
import { resolveServiceDetailActions } from "../src/services/user-services.service.js";
import {
  serviceAccountLabel,
  serviceDetailText,
} from "../src/handlers/user-services/service-views.js";

// =============================================================================
// Free-trial integration tests: real PostgreSQL + real Redis (claim guard +
// provisioning lock) + mock HTTP panels matching the real Marzban and
// pinned XUI (Sanaei global-client) contracts. Covers the atomic claim
// under concurrency, exact remote quotas/expiry, financial isolation,
// service representation and reconciliation of uncertain outcomes.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis =
  (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";
const hasDeps = hasDb && hasRedis;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let tgSeq = 0;

const TRIAL_MINUTES = 120;
const TRIAL_MB = 512;
const TRIAL_BYTES = BigInt(TRIAL_MB) * 1024n * 1024n;

// --- mock Marzban ---------------------------------------------------------------------------

interface MarzbanMockUser {
  data_limit: number;
  expire: number;
  note: string;
}
const marzbanUsers = new Map<string, MarzbanMockUser>();
let marzbanCreateCount = 0;
let marzbanFailNextCreate = false;
let marzbanStoreThenHang = false;
// Usernames whose reads hang while marzbanStoreThenHang is on: the adapter's
// post-timeout verification probe must ALSO fail to produce a true UNKNOWN.
const marzbanHungUsernames = new Set<string>();
let marzbanServer: http.Server;
let marzbanUrl = "";
const hanging: http.ServerResponse[] = [];

function startMarzbanMock(): Promise<void> {
  marzbanServer = http.createServer((req, res) => {
    const url = req.url ?? "";
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && url === "/api/admin/token") {
      send(200, { access_token: "ft-token" });
      return;
    }
    const match = /^\/api\/user\/([^/]+)$/.exec(url);
    if (req.method === "GET" && match !== null) {
      const username = decodeURIComponent(match[1]);
      if (username === "tpl") {
        send(200, {
          username: "tpl",
          status: "active",
          proxies: { vless: { id: "tpl-uuid" } },
          inbounds: { vless: ["VLESS"] },
        });
        return;
      }
      if (marzbanStoreThenHang && marzbanHungUsernames.has(username)) {
        hanging.push(res);
        return;
      }
      const user = marzbanUsers.get(username);
      if (user === undefined) {
        send(404, { detail: "User not found" });
        return;
      }
      send(200, {
        username,
        status: "active",
        proxies: { vless: {} },
        inbounds: { vless: ["VLESS"] },
        data_limit: user.data_limit,
        expire: user.expire,
        used_traffic: 0,
        note: user.note,
        subscription_url: `/sub/${username}`,
      });
      return;
    }
    if (req.method === "POST" && url === "/api/user") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const payload = JSON.parse(body) as {
          username: string;
          data_limit: number;
          expire: number;
          note: string;
        };
        if (marzbanFailNextCreate) {
          marzbanFailNextCreate = false;
          send(422, { detail: "validation failed" });
          return;
        }
        marzbanCreateCount += 1;
        if (marzbanUsers.has(payload.username)) {
          send(409, { detail: "User already exists" });
          return;
        }
        marzbanUsers.set(payload.username, {
          data_limit: payload.data_limit,
          expire: payload.expire,
          note: payload.note,
        });
        if (marzbanStoreThenHang) {
          // Remote mutation APPLIED but the caller never sees the response -
          // and the verification probe hangs too: the classic UNKNOWN window.
          marzbanHungUsernames.add(payload.username);
          hanging.push(res);
          return;
        }
        send(200, {
          username: payload.username,
          status: "active",
          proxies: { vless: {} },
          data_limit: payload.data_limit,
          expire: payload.expire,
          note: payload.note,
          subscription_url: `/sub/${payload.username}`,
        });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    marzbanServer.listen(0, "127.0.0.1", () => {
      marzbanUrl = `http://127.0.0.1:${(marzbanServer.address() as { port: number }).port}`;
      resolve();
    });
  });
}

// --- mock XUI (pinned Sanaei global-client contract) ------------------------------------------

interface XuiMockClient {
  uuid: string;
  email: string;
  subId: string;
  totalGB: number;
  expiryTime: number;
  enable: boolean;
  inboundIds: number[];
}
const xuiClients: XuiMockClient[] = [];
let xuiAddCount = 0;
let xuiServer: http.Server;
let xuiUrl = "";
const XUI_SESSION = "ft-session";

function startXuiMock(): Promise<void> {
  xuiServer = http.createServer((req, res) => {
    const url = req.url ?? "";
    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { "Content-Type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.method === "POST" && url === "/login") {
      send(200, { success: true, msg: "Login Successfully" }, {
        "Set-Cookie": `3x-ui=${XUI_SESSION}; Path=/`,
      });
      return;
    }
    if ((req.headers.cookie ?? "") !== `3x-ui=${XUI_SESSION}`) {
      res.writeHead(302, { Location: "/" });
      res.end();
      return;
    }
    if (req.method === "GET" && url === "/panel/api/inbounds/list") {
      send(200, {
        success: true,
        obj: [
          { id: 1, enable: true, protocol: "vless", remark: "ft-1", port: 443 },
          { id: 2, enable: true, protocol: "vless", remark: "ft-2", port: 444 },
        ],
      });
      return;
    }
    if (req.method === "GET" && url === "/panel/api/clients/list") {
      send(200, {
        success: true,
        obj: xuiClients.map((c) => ({
          email: c.email,
          subId: c.subId,
          uuid: c.uuid,
          totalGB: c.totalGB,
          expiryTime: c.expiryTime,
          enable: c.enable,
          inboundIds: c.inboundIds,
          traffic: {
            email: c.email,
            up: 0,
            down: 0,
            total: c.totalGB,
            expiryTime: c.expiryTime,
            enable: true,
          },
        })),
      });
      return;
    }
    const getMatch = /^\/panel\/api\/clients\/get\/([^/]+)$/.exec(url);
    if (req.method === "GET" && getMatch !== null) {
      const email = decodeURIComponent(getMatch[1]);
      const row = xuiClients.find((c) => c.email === email);
      if (row === undefined) {
        send(200, { success: false, msg: "record not found" });
        return;
      }
      send(200, {
        success: true,
        obj: {
          client: { email: row.email, subId: row.subId, uuid: row.uuid },
          inboundIds: row.inboundIds,
          usedTraffic: 0,
        },
      });
      return;
    }
    if (req.method === "POST" && url === "/panel/api/clients/add") {
      let body = "";
      req.on("data", (c: Buffer) => (body += c.toString()));
      req.on("end", () => {
        const payload = JSON.parse(body) as {
          client: { email: string; subId: string; totalGB?: number; expiryTime?: number };
          inboundIds: number[];
        };
        xuiAddCount += 1;
        let row = xuiClients.find((c) => c.email === payload.client.email);
        if (row === undefined) {
          row = {
            email: payload.client.email,
            subId: payload.client.subId,
            uuid: `ft-uuid-${xuiAddCount}`,
            totalGB: payload.client.totalGB ?? 0,
            expiryTime: payload.client.expiryTime ?? 0,
            enable: true,
            inboundIds: [],
          };
          xuiClients.push(row);
        }
        for (const id of payload.inboundIds) {
          if (!row.inboundIds.includes(id)) {
            row.inboundIds.push(id);
          }
        }
        send(200, { success: true, msg: "Client added" });
      });
      return;
    }
    const linksMatch = /^\/panel\/api\/clients\/links\/([^/]+)$/.exec(url);
    if (req.method === "GET" && linksMatch !== null) {
      const email = decodeURIComponent(linksMatch[1]);
      const row = xuiClients.find((c) => c.email === email);
      send(200, {
        success: true,
        obj: row === undefined ? [] : [`vless://${row.uuid}@ft.example:443#${email}`],
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    xuiServer.listen(0, "127.0.0.1", () => {
      xuiUrl = `http://127.0.0.1:${(xuiServer.address() as { port: number }).port}`;
      resolve();
    });
  });
}

// --- fixtures -----------------------------------------------------------------------------------

let marzbanPanel: Panel;
let xuiPanel: Panel;

async function createUser(overrides: Record<string, unknown> = {}): Promise<User> {
  tgSeq += 1;
  return prisma.user.create({
    data: { telegramId: runTag + BigInt(tgSeq), ...overrides },
  });
}

async function makeTrialPanel(
  type: "MARZBAN" | "XUI",
  overrides: Record<string, unknown> = {},
): Promise<Panel> {
  tgSeq += 1;
  return prisma.panel.create({
    data: {
      type,
      name: `ft-${type.toLowerCase()}-${runTag}-${tgSeq}`,
      baseUrl: type === "MARZBAN" ? marzbanUrl : xuiUrl,
      username: "admin",
      passwordEncrypted: encryptSecret(`${type}-pass`),
      status: "ACTIVE",
      testEnabled: true,
      testDurationMinutes: TRIAL_MINUTES,
      testVolumeMb: TRIAL_MB,
      ...(type === "MARZBAN"
        ? { templateUsername: "tpl" }
        : { inboundIds: [1, 2], testInboundIds: [2] }),
      ...overrides,
    },
  });
}

async function resetGlobalSettings(): Promise<void> {
  await setFreeTrialEnabled(true);
  await setSetting(FREE_TRIAL_ONCE_PER_USER_KEY, "true", "BOOLEAN");
  await setSetting(FREE_TRIAL_COOLDOWN_DAYS_KEY, "", "STRING");
  await setSetting(FREE_TRIAL_REQUIRE_NO_PURCHASE_KEY, "false", "BOOLEAN");
  clearSettingsCache();
}

describe.runIf(hasDeps)("free trial accounts", () => {
  beforeAll(async () => {
    await Promise.all([startMarzbanMock(), startXuiMock()]);
    marzbanPanel = await makeTrialPanel("MARZBAN");
    xuiPanel = await makeTrialPanel("XUI");
    await resetGlobalSettings();
  });

  beforeEach(async () => {
    await resetGlobalSettings();
  });

  afterAll(async () => {
    for (const res of hanging) {
      res.destroy();
    }
    marzbanServer?.close();
    xuiServer?.close();
    await setFreeTrialEnabled(false);
    await prisma.$disconnect();
  });

  // --- visibility + eligibility (13-20) ---------------------------------------------------------

  it("menu button hidden when globally disabled, visible when enabled with a ready panel", async () => {
    await setFreeTrialEnabled(false);
    clearSettingsCache();
    const hidden = JSON.stringify((await buildUserMainKeyboard()).inline_keyboard);
    expect(hidden).not.toContain("user:free_test");

    await setFreeTrialEnabled(true);
    clearSettingsCache();
    const shown = JSON.stringify((await buildUserMainKeyboard()).inline_keyboard);
    expect(shown).toContain("user:free_test");
  });

  it("trial-ready assessment: incomplete configs never pass", async () => {
    expect(assessTrialPanelConfig(marzbanPanel).ok).toBe(true);
    expect(assessTrialPanelConfig(xuiPanel).ok).toBe(true);
    // Missing duration / traffic / inbounds are each fatal.
    expect(
      assessTrialPanelConfig({ ...marzbanPanel, testDurationMinutes: 0 }).reasons,
    ).toContain("trial-duration-missing");
    expect(
      assessTrialPanelConfig({ ...marzbanPanel, testVolumeMb: null }).reasons,
    ).toContain("trial-traffic-missing");
    expect(assessTrialPanelConfig({ ...xuiPanel, testInboundIds: [] }).reasons).toContain(
      "trial-inbounds-missing",
    );
    expect(
      assessTrialPanelConfig({ ...xuiPanel, testInboundIds: [7] }).reasons,
    ).toContain("trial-inbounds-outside-allowlist");
    expect(
      assessTrialPanelConfig({ ...marzbanPanel, status: "INACTIVE" }).reasons,
    ).toContain("panel-not-active");
  });

  it("blocked users, previous buyers (when restricted) and repeat users are denied", async () => {
    const blocked = await createUser({ status: "BLOCKED" });
    expect((await checkTrialEligibility(blocked)).ok).toBe(false);

    await setSetting(FREE_TRIAL_REQUIRE_NO_PURCHASE_KEY, "true", "BOOLEAN");
    clearSettingsCache();
    const buyer = await createUser({ paidOrdersCount: 2 });
    const denied = await checkTrialEligibility(buyer);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.text).toBe(TRIAL_NO_PURCHASE_ONLY_TEXT);
    }
  });

  it("forged/foreign panel selection never claims (only trial-ready panels resolve)", async () => {
    const user = await createUser();
    const paidOnly = await prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: `ft-paid-only-${runTag}`,
        baseUrl: marzbanUrl,
        username: "admin",
        passwordEncrypted: encryptSecret("x"),
        templateUsername: "tpl",
        status: "ACTIVE",
        testEnabled: false,
      },
    });
    const outcome = await claimFreeTrial(user, paidOnly.id);
    expect(outcome.kind).toBe("denied");
    expect(await prisma.freeTrialClaim.count({ where: { userId: user.id } })).toBe(0);
  });

  it("trial callback data stays far below Telegram's 64-byte limit", () => {
    const sid = "0123456789abcdef".slice(0, 8);
    for (const cb of [ftCb.root, ftCb.panel(sid), ftCb.confirm(sid)]) {
      expect(Buffer.byteLength(cb, "utf8")).toBeLessThan(64);
    }
  });

  // --- Marzban provisioning (26-32) + financial isolation (41-47) + service (48-54) -------------

  it("Marzban trial: exact quota/expiry/note, real Service, zero financial writes", async () => {
    const user = await createUser();
    const before = Date.now();
    const outcome = await claimFreeTrial(user, marzbanPanel.id);
    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") {
      return;
    }
    const { claim, service } = outcome;

    // Remote truth: one user, exact bytes, exact unix-seconds expiry, marker.
    const remote = marzbanUsers.get(service.username);
    expect(remote).toBeDefined();
    expect(remote?.data_limit).toBe(Number(TRIAL_BYTES));
    const expectedExpire = Math.floor((before + TRIAL_MINUTES * 60_000) / 1000);
    expect(Math.abs((remote?.expire ?? 0) - expectedExpire)).toBeLessThan(180);
    expect(remote?.note).toBe(trialOwnershipMarker(claim.id, user.telegramId));

    // Claim + naming snapshot.
    expect(claim.status).toBe(FreeTrialClaimStatus.ACTIVE);
    expect(claim.usernameSnapshot).toBe(service.username);
    expect(claim.serviceId).toBe(service.id);

    // Local Service: trial-market, order-less, subscription persisted.
    expect(service.source).toBe("FREE_TRIAL");
    expect(service.serviceLocation).toBe("TEST");
    expect(service.orderId).toBeNull();
    expect(service.productId).toBeNull();
    expect(service.status).toBe("ACTIVE");
    expect(service.volumeBytes).toBe(TRIAL_BYTES);
    expect(service.subscriptionUrl).toContain(`/sub/${service.username}`);
    expect(service.expiresAt).not.toBeNull();

    // FINANCIAL ISOLATION: no payment, no wallet, no order, no discount, no
    // referral, no paid counters - only the trial counters move.
    expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.walletTransaction.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.discountCodeUsage.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.referralCommission.count({ where: { referrerUserId: user.id } })).toBe(0);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(fresh.balanceToman).toBe(0);
    expect(fresh.ordersCount).toBe(0);
    expect(fresh.paidOrdersCount).toBe(0);
    expect(fresh.totalPurchaseAmountToman).toBe(0);
    expect(fresh.testAccountsCreatedCount).toBe(1);
    expect(fresh.lastTestAccountCreatedAt).not.toBeNull();

    // Service representation: My Services shows the username; the detail
    // page marks the trial; owner-scoped. Trial-lifecycle phase: the
    // FREE_TRIAL source is no longer a capability blocker - an active
    // Marzban trial on a capable ACTIVE panel gets the FULL paid-lifecycle
    // action set (renewal/extras/toggle/regenerate), same rules as paid.
    expect(serviceAccountLabel(service)).toBe(service.username);
    const detail = serviceDetailText(service);
    expect(detail).toContain("نوع سرویس:\nاکانت تست رایگان");
    const actions = await resolveServiceDetailActions(service);
    expect(actions).toEqual({
      toggleAction: "DISABLE",
      canBuyExtraVolume: true,
      canBuyExtraTime: true,
      canRegenerateLink: true,
      canRenew: true,
    });

    // Live sync path stays available for the trial account.
    const adapter = buildAdapterForPanel(marzbanPanel);
    const live = await adapter.getServiceAccount({ username: service.username });
    expect(live.ok).toBe(true);

    // Success message: username + duration + traffic + the subscription
    // link (owner-only) - never credentials.
    const message = buildTrialSuccessMessage(service, TRIAL_MINUTES);
    expect(message).toContain(service.username);
    expect(message).toContain("لینک اشتراک");
    expect(message).not.toContain("MARZBAN-pass");
    expect(message).not.toContain(encryptSecret("MARZBAN-pass").slice(0, 12));

    // Once-per-user: the second attempt is denied.
    const again = await claimFreeTrial(user, marzbanPanel.id);
    expect(again.kind).toBe("denied");
    if (again.kind === "denied") {
      expect(again.text).toBe(TRIAL_ALREADY_USED_TEXT);
    }
  });

  // --- XUI provisioning (33-40) ------------------------------------------------------------------

  it("XUI trial: ONE global client with exact trial inbounds, quota and expiry", async () => {
    const user = await createUser();
    const addBefore = xuiAddCount;
    const before = Date.now();
    const outcome = await claimFreeTrial(user, xuiPanel.id);
    expect(outcome.kind).toBe("created");
    if (outcome.kind !== "created") {
      return;
    }
    const { service } = outcome;

    // Exactly ONE add-client call, one row, email === subId === username.
    expect(xuiAddCount - addBefore).toBe(1);
    const client = xuiClients.find((c) => c.email === service.username);
    expect(client).toBeDefined();
    expect(client?.subId).toBe(service.username);
    expect(client?.inboundIds).toEqual([2]); // the SELECTED trial inbounds only
    expect(client?.totalGB).toBe(Number(TRIAL_BYTES)); // bytes despite the name
    const expectedExpiry = before + TRIAL_MINUTES * 60_000;
    expect(Math.abs((client?.expiryTime ?? 0) - expectedExpiry)).toBeLessThan(180_000);
    expect(client?.enable).toBe(true);

    expect(service.source).toBe("FREE_TRIAL");
    expect(service.remoteInboundIds).toEqual([2]);

    // Foreign users never see the trial service.
    const stranger = await createUser();
    const foreign = await prisma.service.findFirst({
      where: { id: service.id, userId: stranger.id },
    });
    expect(foreign).toBeNull();
  });

  // --- concurrency (21-25) -------------------------------------------------------------------------

  it(
    "21. twenty simultaneous confirms create ONE claim, ONE remote account, ONE service",
    { timeout: 60_000 },
    async () => {
      const user = await createUser();
      const createBefore = marzbanCreateCount;
      const outcomes = await Promise.all(
        Array.from({ length: 20 }, () => claimFreeTrial(user, marzbanPanel.id)),
      );
      const created = outcomes.filter((o) => o.kind === "created");
      expect(created).toHaveLength(1);
      // Every loser is a clean denial (in-progress/already) - never an error
      // and never a second account.
      for (const o of outcomes) {
        if (o.kind === "denied") {
          expect([TRIAL_IN_PROGRESS_TEXT, TRIAL_ALREADY_USED_TEXT]).toContain(o.text);
        }
      }
      expect(marzbanCreateCount - createBefore).toBe(1);
      expect(
        await prisma.freeTrialClaim.count({
          where: { userId: user.id, status: FreeTrialClaimStatus.ACTIVE },
        }),
      ).toBe(1);
      expect(await prisma.freeTrialClaim.count({ where: { userId: user.id } })).toBe(1);
      expect(
        await prisma.service.count({ where: { userId: user.id, source: "FREE_TRIAL" } }),
      ).toBe(1);
    },
  );

  it(
    "22. two users race the last capacity slot: exactly one wins",
    { timeout: 60_000 },
    async () => {
      const capacityPanel = await makeTrialPanel("MARZBAN", { testMaxConcurrentAccounts: 1 });
      const [userA, userB] = await Promise.all([createUser(), createUser()]);
      const [a, b] = await Promise.all([
        claimFreeTrial(userA, capacityPanel.id),
        claimFreeTrial(userB, capacityPanel.id),
      ]);
      const kinds = [a.kind, b.kind].sort();
      expect(kinds).toEqual(["created", "denied"]);
      const loser = [a, b].find((o) => o.kind === "denied");
      if (loser !== undefined && loser.kind === "denied") {
        expect(loser.text).toBe(TRIAL_CAPACITY_FULL_TEXT);
      }
      expect(
        await prisma.freeTrialClaim.count({
          where: { panelId: capacityPanel.id, status: FreeTrialClaimStatus.ACTIVE },
        }),
      ).toBe(1);
    },
  );

  it("23. a definite remote failure releases the claim; the retry mints ONE account", async () => {
    const user = await createUser();
    marzbanFailNextCreate = true;
    const first = await claimFreeTrial(user, marzbanPanel.id);
    expect(first.kind).toBe("denied");
    const failedClaim = await prisma.freeTrialClaim.findFirst({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    expect(failedClaim?.status).toBe(FreeTrialClaimStatus.FAILED);

    // FAILED never blocks: the user retries and exactly one account exists.
    const second = await claimFreeTrial(user, marzbanPanel.id);
    expect(second.kind).toBe("created");
    expect(
      await prisma.service.count({ where: { userId: user.id, source: "FREE_TRIAL" } }),
    ).toBe(1);
  });

  it(
    "24/25. timeout AFTER remote success reconciles to ONE service; repeats create no duplicate",
    { timeout: 60_000 },
    async () => {
      const user = await createUser();
      marzbanStoreThenHang = true;
      const outcome = await claimFreeTrial(user, marzbanPanel.id);
      marzbanStoreThenHang = false;
      expect(outcome.kind).toBe("uncertain");
      const claim = await prisma.freeTrialClaim.findFirstOrThrow({
        where: { userId: user.id },
      });
      expect(claim.status).toBe(FreeTrialClaimStatus.PROVISIONING);

      // No repeated retry during UNKNOWN: the user cannot claim again.
      const retry = await claimFreeTrial(user, marzbanPanel.id);
      expect(retry.kind).toBe("denied");
      if (retry.kind === "denied") {
        expect(retry.text).toBe(TRIAL_IN_PROGRESS_TEXT);
      }

      // Reconciliation finds the applied remote mutation and recovers it.
      expect(await reconcileTrialClaim(claim.id)).toBe("APPLIED");
      const recovered = await prisma.freeTrialClaim.findUniqueOrThrow({
        where: { id: claim.id },
      });
      expect(recovered.status).toBe(FreeTrialClaimStatus.ACTIVE);
      expect(recovered.serviceId).not.toBeNull();

      // Repeated reconciliation converges - still exactly one Service.
      expect(await reconcileTrialClaim(claim.id)).toBe("UNKNOWN"); // already ACTIVE -> no-op
      expect(
        await prisma.service.count({ where: { userId: user.id, source: "FREE_TRIAL" } }),
      ).toBe(1);
    },
  );

  it("reconciliation of a never-applied claim releases it as FAILED", async () => {
    const user = await createUser();
    const claim = await prisma.freeTrialClaim.create({
      data: {
        userId: user.id,
        panelId: marzbanPanel.id,
        status: FreeTrialClaimStatus.PROVISIONING,
        usernameSnapshot: `ft_ghost_${runTag}`,
        durationMinutes: TRIAL_MINUTES,
        trafficBytes: TRIAL_BYTES,
        attemptCount: 1,
      },
    });
    expect(await reconcileTrialClaim(claim.id)).toBe("NOT_APPLIED");
    const fresh = await prisma.freeTrialClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(fresh.status).toBe(FreeTrialClaimStatus.FAILED);
  });

  it("cooldown policy: with once-per-user off, EXPIRED consumes until the window passes", async () => {
    await setSetting(FREE_TRIAL_ONCE_PER_USER_KEY, "false", "BOOLEAN");
    await setSetting(FREE_TRIAL_COOLDOWN_DAYS_KEY, "7", "NUMBER");
    clearSettingsCache();
    const user = await createUser();
    await prisma.freeTrialClaim.create({
      data: {
        userId: user.id,
        panelId: marzbanPanel.id,
        status: FreeTrialClaimStatus.EXPIRED,
        createdAt: new Date(Date.now() - 2 * 86_400_000), // 2 days ago < 7
      },
    });
    const denied = await checkTrialEligibility(user);
    expect(denied.ok).toBe(false);

    await prisma.freeTrialClaim.updateMany({
      where: { userId: user.id },
      data: { createdAt: new Date(Date.now() - 8 * 86_400_000) }, // past cooldown
    });
    expect((await checkTrialEligibility(user)).ok).toBe(true);
  });
});

describe.skipIf(hasDeps)("free trial accounts (skipped)", () => {
  it("requires DATABASE_URL + Redis - see docs/testing.md", () => {
    expect(hasDeps).toBe(false);
  });
});
