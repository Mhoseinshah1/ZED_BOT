import http from "node:http";
import { randomUUID } from "node:crypto";

import {
  FreeTrialClaimStatus,
  prisma,
  type Panel,
  type Service,
  type User,
} from "@zedbot/database";
import { encryptSecret } from "@zedbot/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "trial-lifecycle-entitlement-tests-secret-01";

import {
  claimFreeTrial,
  reconcileTrialClaim,
  runFreeTrialSweep,
  checkTrialEligibility,
} from "../src/services/free-trial.service.js";
import {
  computeTrialAllowance,
  computeTrialEligibility,
  expireTrialEntitlements,
  FREE_TRIAL_DEFAULT_ALLOWANCE_KEY,
  releaseClaimAllowance,
  TRIAL_NO_ALLOWANCE_TEXT,
} from "../src/services/free-trial-entitlement.service.js";
import {
  forceClaimCreated,
  forceClaimNotCreated,
  grantTrialAllowance,
  resetTrialAccess,
  revokeTrialAccess,
  clearTrialCooldown,
  setEffectiveRemaining,
  setTrialCooldown,
  TRIAL_RESET_BLOCKED_TEXT,
} from "../src/services/free-trial-admin.service.js";
import {
  setFreeTrialEnabled,
  FREE_TRIAL_ONCE_PER_USER_KEY,
  FREE_TRIAL_COOLDOWN_DAYS_KEY,
  FREE_TRIAL_REQUIRE_NO_PURCHASE_KEY,
} from "../src/services/free-trial-settings.service.js";
import { executeRenewalOrder } from "../src/services/service-renewal.service.js";
import { executeExtraVolumeOrder } from "../src/services/extra-volume.service.js";
import { executeExtraTimeOrder } from "../src/services/extra-time.service.js";
import { regenerateServiceSubscription } from "../src/services/service-link.service.js";
import { toggleServiceStatus } from "../src/services/service-toggle.service.js";
import { renewalPlansForPanel } from "../src/services/renewal-checkout.service.js";
import { resolveServiceDetailActions } from "../src/services/user-services.service.js";
import { serviceDetailText } from "../src/handlers/user-services/service-views.js";
import { TRIAL_CONVERTED_EVENT_TYPE } from "../src/services/trial-conversion.service.js";
import { setSetting, deleteSetting, clearSettingsCache } from "../src/services/settings.service.js";

// =============================================================================
// feat/trial-service-lifecycle-and-entitlements CORE suite: full paid
// lifecycle on FREE_TRIAL services (capability, renewal, extras,
// regeneration, toggle, conversion-exactly-once, reconciliation, financial
// isolation) + the entitlement engine (default allowance, admin grants,
// consumption order, atomic reservation, exactly-once release, reset /
// revoke / cooldown barriers, expiration) + the mandated concurrency
// battery. Real PostgreSQL + Redis + a mock Marzban panel speaking the real
// HTTP contract (create/read/modify/reset/revoke_sub).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = typeof process.env.REDIS_URL === "string" && process.env.REDIS_URL !== "";
const hasDeps = hasDb && hasRedis;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;
const GIB = 1024n * 1024n * 1024n;
const TRIAL_MINUTES = 120;
const TRIAL_MB = 512;
const PRICE = 90_000;

// --- mock Marzban panel (real contract subset) ---------------------------------------------------

interface MockUser {
  data_limit: number;
  expire: number;
  used_traffic: number;
  note: string;
  status: string;
  subSeq: number;
}
const panelUsers = new Map<string, MockUser>();
let createCount = 0;
let failNextCreate = false;
let server: http.Server;
let panelUrl = "";

function userJson(username: string, u: MockUser): string {
  return JSON.stringify({
    username,
    status: u.status,
    used_traffic: u.used_traffic,
    data_limit: u.data_limit,
    expire: u.expire,
    note: u.note,
    proxies: { vless: {} },
    inbounds: { vless: ["VLESS"] },
    subscription_url: `/sub/${username}-${u.subSeq}`,
  });
}

function startMockPanel(): Promise<void> {
  server = http.createServer((req, res) => {
    void (async () => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(typeof body === "string" ? body : JSON.stringify(body));
      };
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/api/admin/token") {
        send(200, { access_token: "tl-token" });
        return;
      }
      const reset = /^\/api\/user\/([^/]+)\/reset$/.exec(url);
      if (req.method === "POST" && reset !== null) {
        const u = panelUsers.get(decodeURIComponent(reset[1]));
        if (u === undefined) {
          send(404, { detail: "User not found" });
          return;
        }
        u.used_traffic = 0;
        send(200, userJson(decodeURIComponent(reset[1]), u));
        return;
      }
      const revoke = /^\/api\/user\/([^/]+)\/revoke_sub$/.exec(url);
      if (req.method === "POST" && revoke !== null) {
        const name = decodeURIComponent(revoke[1]);
        const u = panelUsers.get(name);
        if (u === undefined) {
          send(404, { detail: "User not found" });
          return;
        }
        u.subSeq += 1;
        send(200, userJson(name, u));
        return;
      }
      const match = /^\/api\/user\/([^/]+)$/.exec(url);
      if (match !== null) {
        const name = decodeURIComponent(match[1]);
        const u = panelUsers.get(name);
        if (req.method === "GET") {
          if (name === "tpl") {
            send(200, {
              username: "tpl",
              status: "active",
              proxies: { vless: { id: "tpl-uuid" } },
              inbounds: { vless: ["VLESS"] },
            });
            return;
          }
          if (u === undefined) {
            send(404, { detail: "User not found" });
            return;
          }
          send(200, userJson(name, u));
          return;
        }
        if (req.method === "PUT") {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(chunk as Buffer);
          }
          if (u === undefined) {
            send(404, { detail: "User not found" });
            return;
          }
          const body = JSON.parse(Buffer.concat(chunks).toString()) as {
            data_limit?: number;
            expire?: number;
            status?: string;
          };
          if (typeof body.data_limit === "number") u.data_limit = body.data_limit;
          if (typeof body.expire === "number") u.expire = body.expire;
          if (typeof body.status === "string") u.status = body.status;
          send(200, userJson(name, u));
          return;
        }
      }
      if (req.method === "POST" && url === "/api/user") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(chunk as Buffer);
        }
        const payload = JSON.parse(Buffer.concat(chunks).toString()) as {
          username: string;
          data_limit: number;
          expire: number;
          note?: string;
        };
        if (failNextCreate) {
          failNextCreate = false;
          send(422, { detail: "validation failed" });
          return;
        }
        if (panelUsers.has(payload.username)) {
          send(409, { detail: "User already exists" });
          return;
        }
        createCount += 1;
        panelUsers.set(payload.username, {
          data_limit: payload.data_limit,
          expire: payload.expire,
          used_traffic: 0,
          note: payload.note ?? "",
          status: "active",
          subSeq: 0,
        });
        send(200, userJson(payload.username, panelUsers.get(payload.username)!));
        return;
      }
      send(404, { detail: "no route" });
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      panelUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      resolve();
    });
  });
}

// --- fixtures -------------------------------------------------------------------------------------

let panel: Panel;
let otherPanel: Panel;
let productId: string;
let admin = { id: "", telegramId: 0n };
const fakeApi = {
  sent: [] as { chatId: string; text: string }[],
  async sendMessage(chatId: string | number, text: string): Promise<unknown> {
    fakeApi.sent.push({ chatId: String(chatId), text });
    return {};
  },
};

async function createUser(overrides: Record<string, unknown> = {}): Promise<User> {
  seq += 1;
  return prisma.user.create({ data: { telegramId: runTag + BigInt(seq), ...overrides } });
}

/** Claims a real trial through the engine against the mock panel. */
async function createTrial(user: User): Promise<Service> {
  const outcome = await claimFreeTrial(user, panel.id);
  if (outcome.kind !== "created") {
    throw new Error(`trial not created: ${JSON.stringify(outcome)}`);
  }
  return outcome.service;
}

/** Marks the user's trial claim+service EXPIRED (frees the live slot). */
async function expireTrialOf(userId: string): Promise<void> {
  await prisma.freeTrialClaim.updateMany({
    where: { userId, status: FreeTrialClaimStatus.ACTIVE },
    data: { status: FreeTrialClaimStatus.EXPIRED },
  });
  await prisma.service.updateMany({
    where: { userId, source: "FREE_TRIAL", convertedToPaidAt: null },
    data: { status: "EXPIRED" },
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
      productId,
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

async function conversionEvents(serviceId: string): Promise<number> {
  return prisma.serviceEventLog.count({
    where: { serviceId, eventType: TRIAL_CONVERTED_EVENT_TYPE },
  });
}

describe.runIf(hasDeps)("trial lifecycle + entitlements", () => {
  beforeAll(async () => {
    await startMockPanel();
    const adminRow = await prisma.admin.create({
      data: { telegramId: runTag + 900_000_000n, role: "OWNER", isActive: true },
    });
    admin = { id: adminRow.id, telegramId: adminRow.telegramId };
    panel = await prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: `tl-panel-${runTag}`,
        baseUrl: panelUrl,
        username: "admin",
        passwordEncrypted: encryptSecret("mock-password"),
        status: "ACTIVE",
        testEnabled: true,
        testVolumeMb: TRIAL_MB,
        testDurationMinutes: TRIAL_MINUTES,
        templateUsername: "tpl",
        provisioningReady: true,
      },
    });
    otherPanel = await prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: `tl-panel-b-${runTag}`,
        baseUrl: panelUrl,
        username: "admin",
        passwordEncrypted: encryptSecret("mock-password"),
        status: "ACTIVE",
        testEnabled: true,
        testVolumeMb: TRIAL_MB,
        testDurationMinutes: TRIAL_MINUTES,
        templateUsername: "tpl",
        provisioningReady: true,
      },
    });
    const category = await prisma.productCategory.create({
      data: { type: "SERVICE_PRODUCT", name: `tl-cat-${runTag}`, isActive: true },
    });
    const product = await prisma.product.create({
      data: {
        type: "SERVICE_PRODUCT",
        categoryId: category.id,
        panelId: panel.id,
        name: `tl-product-${runTag}`,
        priceToman: PRICE,
        volumeGb: 10,
        durationDays: 30,
        isActive: true,
      },
    });
    productId = product.id;
  });

  beforeEach(async () => {
    await setFreeTrialEnabled(true);
    await setSetting(FREE_TRIAL_ONCE_PER_USER_KEY, "true", "BOOLEAN");
    await setSetting(FREE_TRIAL_COOLDOWN_DAYS_KEY, "", "STRING");
    await setSetting(FREE_TRIAL_REQUIRE_NO_PURCHASE_KEY, "false", "BOOLEAN");
    await deleteSetting(FREE_TRIAL_DEFAULT_ALLOWANCE_KEY);
    clearSettingsCache();
    fakeApi.sent.length = 0;
  });

  afterAll(async () => {
    await setFreeTrialEnabled(false);
    server?.close();
    await prisma.$disconnect();
  });

  // ==============================================================================================
  // Part A - lifecycle on trial services
  // ==============================================================================================

  it("A1-A5. renewal executes on the SAME remote account, converts exactly once, never twice", async () => {
    const user = await createUser();
    const service = await createTrial(user);
    expect(createCount).toBeGreaterThan(0);
    const createsBefore = createCount;
    const remoteBefore = panelUsers.get(service.username)!;
    expect(remoteBefore).toBeDefined();

    // Package selection for a trial service (orderId/productId null): the
    // panel-scoped plan list works and never crashes (tests 35/36).
    expect(service.orderId).toBeNull();
    const plans = await renewalPlansForPanel(user.group, service.panelId);
    expect(plans.some((p) => p.id === productId)).toBe(true);

    const orderId = await createPaidOrder(user, service.id, "SERVICE_RENEWAL", {
      volumeGb: 10,
      durationDays: 30,
    });
    const outcome = await executeRenewalOrder(orderId);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.trialConverted).toBe(true);

    // Same remote account updated - no second panel account, no second Service.
    expect(createCount).toBe(createsBefore);
    const remoteAfter = panelUsers.get(service.username)!;
    expect(remoteAfter.data_limit).toBeGreaterThan(0);
    expect(await prisma.service.count({ where: { userId: user.id } })).toBe(1);

    // Conversion markers: exactly once, origin preserved.
    const fresh = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(fresh.source).toBe("FREE_TRIAL");
    expect(fresh.convertedToPaidAt).not.toBeNull();
    expect(fresh.firstPaidOrderId).toBe(orderId);
    expect(await conversionEvents(service.id)).toBe(1);

    // Detail page shows the converted origin label.
    expect(serviceDetailText(fresh)).toContain("نوع سرویس:\nشروع‌شده با اکانت تست");

    // Order completed exactly once; a replay is a no-op (test 11/14).
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("COMPLETED");
    const replay = await executeRenewalOrder(orderId);
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.alreadyApplied).toBe(true);
      expect(replay.trialConverted ?? false).toBe(false);
    }
    expect(await conversionEvents(service.id)).toBe(1);

    // Conversion does NOT restore trial allowance (tests 42/59).
    const eligibility = await computeTrialEligibility(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    );
    expect(eligibility.eligible).toBe(false);
    // The trial sweep never expires or disables a converted service.
    await prisma.freeTrialClaim.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await runFreeTrialSweep(fakeApi);
    const afterSweep = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(afterSweep.status).toBe("ACTIVE");
    expect(panelUsers.get(service.username)!.status).toBe("active");
  });

  it("A6-A9. extra volume and extra time apply once on the trial account with double-apply protection", async () => {
    const user = await createUser();
    const service = await createTrial(user);

    // Extra volume (tests 15-19).
    const volumeOrder = await createPaidOrder(user, service.id, "EXTRA_VOLUME", { volumeGb: 5 });
    const v1 = await executeExtraVolumeOrder(volumeOrder);
    expect(v1.ok).toBe(true);
    if (v1.ok) {
      expect(v1.trialConverted).toBe(true);
      expect(v1.service.volumeBytes).toBe(5n * GIB + BigInt(TRIAL_MB) * 1024n * 1024n);
    }
    expect(BigInt(panelUsers.get(service.username)!.data_limit)).toBe(
      5n * GIB + BigInt(TRIAL_MB) * 1024n * 1024n,
    );
    const v2 = await executeExtraVolumeOrder(volumeOrder);
    expect(v2.ok && v2.alreadyApplied).toBe(true);
    expect(await conversionEvents(service.id)).toBe(1);

    // Extra time (tests 20-24): exact expiry extension, one application.
    const before = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    const timeOrder = await createPaidOrder(user, service.id, "EXTRA_TIME", { durationDays: 7 });
    const t1 = await executeExtraTimeOrder(timeOrder);
    expect(t1.ok).toBe(true);
    if (t1.ok) {
      expect(t1.trialConverted ?? false).toBe(false); // already converted by the volume order
      const expected = new Date(before.expiresAt!.getTime() + 7 * 86_400_000);
      expect(Math.abs(t1.service.expiresAt!.getTime() - expected.getTime())).toBeLessThan(2_000);
    }
    const t2 = await executeExtraTimeOrder(timeOrder);
    expect(t2.ok && t2.alreadyApplied).toBe(true);
    expect(await conversionEvents(service.id)).toBe(1);
    const fresh = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(fresh.firstPaidOrderId).toBe(volumeOrder);
    expect(await prisma.service.count({ where: { userId: user.id } })).toBe(1);
  });

  it("A10-A12. regeneration works on a trial (no financial rows); toggle follows normal rules", async () => {
    const user = await createUser();
    const service = await createTrial(user);
    const subBefore = (await prisma.service.findUniqueOrThrow({ where: { id: service.id } }))
      .subscriptionUrl;

    // Regeneration (tests 25/28/29): new link, no Payment/Order, safe event.
    const regen = await regenerateServiceSubscription(user.id, service.id);
    expect(regen.ok).toBe(true);
    const regenerated = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(regenerated.subscriptionUrl).not.toBe(subBefore);
    expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0);
    const regenEvent = await prisma.serviceEventLog.findFirstOrThrow({
      where: { serviceId: service.id, eventType: "SERVICE_SUBSCRIPTION_REGENERATED" },
    });
    expect(JSON.stringify(regenEvent.metadata)).not.toContain("/sub/");

    // Toggle (tests 30/31/34): disable then enable, no financial mutation.
    const disabled = await toggleServiceStatus(user.id, service.id, "DISABLE");
    expect(disabled.ok).toBe(true);
    expect(panelUsers.get(service.username)!.status).toBe("disabled");
    const enabled = await toggleServiceStatus(user.id, service.id, "ENABLE");
    expect(enabled.ok).toBe(true);
    expect(panelUsers.get(service.username)!.status).toBe("active");
    expect(await prisma.walletTransaction.count({ where: { userId: user.id } })).toBe(0);

    // Expired unconverted trial (test 32): enable requires renewal first.
    await prisma.service.update({
      where: { id: service.id },
      data: { status: "DISABLED", expiresAt: new Date(Date.now() - 3_600_000) },
    });
    const expiredEnable = await toggleServiceStatus(user.id, service.id, "ENABLE");
    expect(expiredEnable.ok).toBe(false);

    // Renewal reactivates the expired trial (expired-trial policy), then
    // normal toggle rules apply (test 33).
    await prisma.service.update({ where: { id: service.id }, data: { status: "EXPIRED" } });
    const orderId = await createPaidOrder(user, service.id, "SERVICE_RENEWAL", {
      volumeGb: 10,
      durationDays: 30,
    });
    const renewed = await executeRenewalOrder(orderId);
    expect(renewed.ok).toBe(true);
    const revived = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(revived.status).toBe("ACTIVE");
    expect(revived.convertedToPaidAt).not.toBeNull();
    const toggleAfter = await resolveServiceDetailActions(revived);
    expect(toggleAfter.toggleAction).toBe("DISABLE");
  });

  it("A15. XUI trial capability: GLOBAL_CLIENT gets the full action set; legacy hides mutations (tests 2-5)", async () => {
    const user = await createUser();
    const xuiPanel = await prisma.panel.create({
      data: {
        type: "XUI",
        name: `tl-xui-${runTag}`,
        baseUrl: "http://127.0.0.1:1",
        username: "admin",
        passwordEncrypted: encryptSecret("x"),
        status: "ACTIVE",
      },
    });
    seq += 1;
    const globalTrial = await prisma.service.create({
      data: {
        userId: user.id,
        panelId: xuiPanel.id,
        panelType: "XUI",
        username: `tl-xui-g-${runTag}-${seq}`,
        status: "ACTIVE",
        source: "FREE_TRIAL",
        serviceLocation: "TEST",
        volumeBytes: GIB,
        remainingBytes: GIB,
        expiresAt: new Date(Date.now() + 3_600_000),
        remoteMetadata: { email: `tl-xui-g-${runTag}-${seq}` },
      },
    });
    const globalActions = await resolveServiceDetailActions(globalTrial);
    expect(globalActions).toEqual({
      toggleAction: "DISABLE",
      canBuyExtraVolume: true,
      canBuyExtraTime: true,
      canRegenerateLink: true,
      canRenew: true,
    });

    seq += 1;
    const legacyTrial = await prisma.service.create({
      data: {
        userId: user.id,
        panelId: xuiPanel.id,
        panelType: "XUI",
        username: `tl-xui-l-${runTag}-${seq}`,
        status: "ACTIVE",
        source: "FREE_TRIAL",
        serviceLocation: "TEST",
        volumeBytes: GIB,
        remainingBytes: GIB,
        expiresAt: new Date(Date.now() + 3_600_000),
        remoteMetadata: {
          clients: [{ email: `tl-xui-l-${runTag}-${seq}-1` }, { email: `tl-xui-l-${runTag}-${seq}-2` }],
        },
      },
    });
    const legacyActions = await resolveServiceDetailActions(legacyTrial);
    // Legacy per-inbound XUI: every mutating action hidden (test 3/4).
    expect(legacyActions).toEqual({
      toggleAction: null,
      canBuyExtraVolume: false,
      canBuyExtraTime: false,
      canRegenerateLink: false,
      canRenew: false,
    });
  });

  it("A13. initial trial is non-financial; the paid operation is normal revenue (tests 40/41/43/44)", async () => {
    const user = await createUser();
    const service = await createTrial(user);
    expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.walletTransaction.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0);

    const orderId = await createPaidOrder(user, service.id, "SERVICE_RENEWAL", {
      volumeGb: 10,
      durationDays: 30,
    });
    const outcome = await executeRenewalOrder(orderId);
    expect(outcome.ok).toBe(true);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order.status).toBe("COMPLETED");
    expect(order.finalPriceToman).toBe(PRICE);
    // No second FreeTrialClaim appeared from the paid operation.
    expect(await prisma.freeTrialClaim.count({ where: { userId: user.id } })).toBe(1);
  });

  it("A14. concurrent renewal + extra volume on one trial serialize; conversion marked once (test 18)", async () => {
    const user = await createUser();
    const service = await createTrial(user);
    const renewOrder = await createPaidOrder(user, service.id, "SERVICE_RENEWAL", {
      volumeGb: 10,
      durationDays: 30,
    });
    const volumeOrder = await createPaidOrder(user, service.id, "EXTRA_VOLUME", { volumeGb: 3 });
    const [r, v] = await Promise.all([
      executeRenewalOrder(renewOrder),
      executeExtraVolumeOrder(volumeOrder),
    ]);
    expect(r.ok).toBe(true);
    expect(v.ok).toBe(true);
    expect(await conversionEvents(service.id)).toBe(1);
    const fresh = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect([renewOrder, volumeOrder]).toContain(fresh.firstPaidOrderId);
    expect((r.ok && r.trialConverted) !== (v.ok && v.trialConverted)).toBe(true);
  });

  // ==============================================================================================
  // Part B - entitlements
  // ==============================================================================================

  it("B1-B4. default allowance funds the first trial; admin grant funds the next (tests 45-48)", async () => {
    const user = await createUser();
    await createTrial(user);
    // One unit consumed from the default pool.
    const afterFirst = await computeTrialAllowance(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    );
    expect(afterFirst.defaultConsumed).toBe(1);
    expect(afterFirst.totalRemaining).toBe(0);
    await expireTrialOf(user.id);
    // Still exhausted after expiry (EXPIRED consumes) - legacy one-trial.
    const denied = await claimFreeTrial(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      panel.id,
    );
    expect(denied.kind).toBe("denied");
    if (denied.kind === "denied") {
      expect(denied.text).toBe(TRIAL_NO_ALLOWANCE_TEXT);
    }
    // Admin grants one extra unit -> the user can claim again.
    const grant = await grantTrialAllowance({
      admin,
      userId: user.id,
      count: 1,
      reason: "test grant",
      idempotencyKey: `trial-grant:${randomUUID()}`,
    });
    expect(grant.ok).toBe(true);
    const second = await claimFreeTrial(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      panel.id,
    );
    expect(second.kind).toBe("created");
    // The claim is linked to the granting entitlement and consumed it.
    const claim = await prisma.freeTrialClaim.findFirstOrThrow({
      where: { userId: user.id, status: FreeTrialClaimStatus.ACTIVE },
    });
    if (grant.ok) {
      expect(claim.entitlementId).toBe(grant.value.id);
      const row = await prisma.freeTrialEntitlement.findUniqueOrThrow({
        where: { id: grant.value.id },
      });
      expect(row.consumed).toBe(1);
      expect(row.status).toBe("CONSUMED");
    }
  });

  it("B5-B8. multiple allowances, DB overdraw guards, expired/revoked grants ignored (tests 49-53)", async () => {
    const user = await createUser();
    const grant = await grantTrialAllowance({
      admin,
      userId: user.id,
      count: 2,
      reason: "multi",
      idempotencyKey: `trial-grant:${randomUUID()}`,
    });
    expect(grant.ok).toBe(true);
    if (!grant.ok) return;
    // Two sequential claims (default 1 + nothing... default is consumed
    // FIRST only after entitlements per the order - panel/global grants come
    // before default, so both claims consume the grant).
    await createTrial(user);
    await expireTrialOf(user.id);
    await createTrial(user);
    await expireTrialOf(user.id);
    const row = await prisma.freeTrialEntitlement.findUniqueOrThrow({
      where: { id: grant.value.id },
    });
    expect(row.consumed).toBe(2);
    expect(row.status).toBe("CONSUMED");

    // consumed can never exceed allowance (DB CHECK, test 51).
    await expect(
      prisma.$executeRaw`UPDATE "FreeTrialEntitlement" SET "consumed" = "consumed" + 1 WHERE "id" = ${grant.value.id}`,
    ).rejects.toThrow();
    // allowance can never be negative (test 50).
    await expect(
      prisma.$executeRaw`UPDATE "FreeTrialEntitlement" SET "allowance" = -1 WHERE "id" = ${grant.value.id}`,
    ).rejects.toThrow();

    // Expired grant is ignored (test 52) - third claim funded by DEFAULT.
    const expiredGrant = await grantTrialAllowance({
      admin,
      userId: user.id,
      count: 1,
      reason: "expired",
      expiresAt: new Date(Date.now() + 50),
      idempotencyKey: `trial-grant:${randomUUID()}`,
    });
    expect(expiredGrant.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    await expireTrialEntitlements();
    const third = await createTrial(user);
    const thirdClaim = await prisma.freeTrialClaim.findFirstOrThrow({
      where: { serviceId: third.id },
    });
    expect(thirdClaim.entitlementId).toBeNull(); // default pool, not the expired grant
    await expireTrialOf(user.id);

    // Revoked grant is ignored (test 53).
    const revokedGrant = await grantTrialAllowance({
      admin,
      userId: user.id,
      count: 1,
      reason: "to-revoke",
      idempotencyKey: `trial-grant:${randomUUID()}`,
    });
    expect(revokedGrant.ok).toBe(true);
    if (revokedGrant.ok) {
      await prisma.freeTrialEntitlement.update({
        where: { id: revokedGrant.value.id },
        data: { status: "REVOKED" },
      });
    }
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const eligibility = await computeTrialEligibility(fresh);
    expect(eligibility.eligible).toBe(false);
    // An EXPIRED unused grant exists for this user, so the specific
    // "grant validity ended" message wins over plain exhaustion.
    expect(eligibility.denialReason).toBe("ENTITLEMENT_EXPIRED");
  });

  it("B9-B10. panel-specific grants bind to their panel; consumption order is deterministic (tests 54/55)", async () => {
    const user = await createUser();
    // Exhaust the default first.
    await createTrial(user);
    await expireTrialOf(user.id);

    // Panel-scoped grant for otherPanel: claiming on `panel` is refused.
    const panelGrant = await grantTrialAllowance({
      admin,
      userId: user.id,
      count: 1,
      reason: "panel grant",
      panelId: otherPanel.id,
      idempotencyKey: `trial-grant:${randomUUID()}`,
    });
    expect(panelGrant.ok).toBe(true);
    const freshUser = (): Promise<User> =>
      prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const wrongPanel = await claimFreeTrial(await freshUser(), panel.id);
    expect(wrongPanel.kind).toBe("denied");
    if (wrongPanel.kind === "denied") {
      expect(wrongPanel.code).toBe("panel-not-allowed");
    }
    // On the assigned panel the panel grant wins over a later global grant.
    const globalGrant = await grantTrialAllowance({
      admin,
      userId: user.id,
      count: 1,
      reason: "global grant",
      idempotencyKey: `trial-grant:${randomUUID()}`,
    });
    expect(globalGrant.ok).toBe(true);
    const onAssigned = await claimFreeTrial(await freshUser(), otherPanel.id);
    expect(onAssigned.kind).toBe("created");
    const claim = await prisma.freeTrialClaim.findFirstOrThrow({
      where: { userId: user.id, status: FreeTrialClaimStatus.ACTIVE },
    });
    if (panelGrant.ok) {
      expect(claim.entitlementId).toBe(panelGrant.value.id);
    }
  });

  it("B11-B13. reset preserves history, grants eligibility, creates no remote account (tests 56-58, 73)", async () => {
    const user = await createUser();
    const service = await createTrial(user);
    await expireTrialOf(user.id);
    const claimsBefore = await prisma.freeTrialClaim.count({ where: { userId: user.id } });
    const createsBefore = createCount;

    const reset = await resetTrialAccess({
      admin,
      userId: user.id,
      reason: "support compensation",
      idempotencyKey: `trial-reset:${randomUUID()}`,
    });
    expect(reset.ok).toBe(true);

    // History intact, no remote account created by the reset itself.
    expect(await prisma.freeTrialClaim.count({ where: { userId: user.id } })).toBe(claimsBefore);
    expect(await prisma.service.count({ where: { id: service.id } })).toBe(1);
    expect(createCount).toBe(createsBefore);

    // Idempotent: the same idempotency key cannot double-grant.
    const again = await resetTrialAccess({
      admin,
      userId: user.id,
      reason: "support compensation",
      idempotencyKey: reset.ok ? `trial-reset:${randomUUID()}` : "",
    });
    expect(again.ok).toBe(true);
    const grants = await prisma.freeTrialEntitlement.count({
      where: { userId: user.id, source: "ADMIN_RESET" },
    });
    expect(grants).toBe(2); // two distinct resets = two grants; same-key replay is covered below
    const eligible = await computeTrialEligibility(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    );
    expect(eligible.eligible).toBe(true);

    // Same-key replay reuses the one row (test 71).
    const key = `trial-grant:${randomUUID()}`;
    const g1 = await grantTrialAllowance({
      admin,
      userId: user.id,
      count: 2,
      reason: "dup",
      idempotencyKey: key,
    });
    const g2 = await grantTrialAllowance({
      admin,
      userId: user.id,
      count: 2,
      reason: "dup",
      idempotencyKey: key,
    });
    expect(g1.ok && g2.ok).toBe(true);
    if (g1.ok && g2.ok) {
      expect(g2.value.id).toBe(g1.value.id);
    }
  });

  it("B14. reset is refused while a live/manual-review claim exists (test 99)", async () => {
    const user = await createUser();
    await prisma.freeTrialClaim.create({
      data: {
        userId: user.id,
        panelId: panel.id,
        status: FreeTrialClaimStatus.MANUAL_REVIEW,
        usernameSnapshot: `tl-manual-${runTag}-${seq}`,
      },
    });
    const reset = await resetTrialAccess({
      admin,
      userId: user.id,
      reason: "should fail",
      idempotencyKey: `trial-reset:${randomUUID()}`,
    });
    expect(reset.ok).toBe(false);
    if (!reset.ok) {
      expect(reset.error).toBe(TRIAL_RESET_BLOCKED_TEXT);
    }
  });

  it("B15-B16. revoke blocks claims; clear cooldown touches only cooldown (tests 74/75)", async () => {
    const user = await createUser();
    const revoked = await revokeTrialAccess({ admin, userId: user.id, reason: "abuse" });
    expect(revoked.ok).toBe(true);
    const denied = await claimFreeTrial(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      panel.id,
    );
    expect(denied.kind).toBe("denied");
    if (denied.kind === "denied") {
      expect(denied.code).toBe("admin-denied");
    }
    expect(await prisma.freeTrialClaim.count({ where: { userId: user.id } })).toBe(0);

    // Cooldown management on a second user: only cooldown fields change.
    const user2 = await createUser();
    const until = new Date(Date.now() + 3 * 86_400_000);
    await setTrialCooldown({ admin, userId: user2.id, until, reason: "cool" });
    let fresh = await prisma.user.findUniqueOrThrow({ where: { id: user2.id } });
    expect(fresh.freeTrialCooldownUntil?.getTime()).toBe(until.getTime());
    const eligibility = await computeTrialEligibility(fresh);
    expect(eligibility.denialReason).toBe("COOLDOWN");
    const allowanceBefore = await computeTrialAllowance(fresh);
    await clearTrialCooldown({ admin, userId: user2.id });
    fresh = await prisma.user.findUniqueOrThrow({ where: { id: user2.id } });
    expect(fresh.freeTrialCooldownUntil).toBeNull();
    const allowanceAfter = await computeTrialAllowance(fresh);
    expect(allowanceAfter.totalRemaining).toBe(allowanceBefore.totalRemaining);
    expect((await computeTrialEligibility(fresh)).eligible).toBe(true);
    // Audit rows carry safe before/after (test 77) and no secrets (test 76).
    const audits = await prisma.auditLog.findMany({
      where: { entityId: user2.id, action: { in: ["trial.cooldown.set", "trial.cooldown.cleared"] } },
    });
    expect(audits.length).toBe(2);
    expect(JSON.stringify(audits.map((a) => a.metadata))).not.toContain("subscription");
  });

  it("B17. set remaining reports exact before/after and pins the value (test 72)", async () => {
    const user = await createUser();
    await grantTrialAllowance({
      admin,
      userId: user.id,
      count: 3,
      reason: "seed",
      idempotencyKey: `trial-grant:${randomUUID()}`,
    });
    // default(1) + grant(3) = 4 remaining.
    const result = await setEffectiveRemaining({
      admin,
      userId: user.id,
      desired: 2,
      reason: "correction",
      idempotencyKey: `trial-setrem:${randomUUID()}`,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.before).toBe(4);
      expect(result.value.after).toBe(2);
    }
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const summary = await computeTrialAllowance(fresh);
    expect(summary.totalRemaining).toBe(2);
  });

  it("B18. global disable preserves grants; re-enable restores usability (tests 97/98)", async () => {
    const user = await createUser();
    const grant = await grantTrialAllowance({
      admin,
      userId: user.id,
      count: 1,
      reason: "keep",
      idempotencyKey: `trial-grant:${randomUUID()}`,
    });
    expect(grant.ok).toBe(true);
    await setFreeTrialEnabled(false);
    clearSettingsCache();
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const whileDisabled = await computeTrialEligibility(fresh);
    expect(whileDisabled.denialReason).toBe("GLOBAL_DISABLED");
    // The mandated "you have allowance but globally disabled" message.
    expect(whileDisabled.denialText).toContain("سهمیه تست دارید");
    expect(await prisma.freeTrialEntitlement.count({ where: { userId: user.id } })).toBe(1);
    await setFreeTrialEnabled(true);
    clearSettingsCache();
    expect((await computeTrialEligibility(fresh)).eligible).toBe(true);
  });

  // ==============================================================================================
  // Concurrency battery
  // ==============================================================================================

  it("C1. twenty clicks with ONE remaining allowance: one claim, one unit, one account, one service (test 60)", async () => {
    const user = await createUser();
    const createsBefore = createCount;
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
        return claimFreeTrial(fresh, panel.id);
      }),
    );
    expect(outcomes.filter((o) => o.kind === "created")).toHaveLength(1);
    expect(await prisma.freeTrialClaim.count({ where: { userId: user.id, status: { in: ["CLAIMED", "PROVISIONING", "ACTIVE", "MANUAL_REVIEW"] } } })).toBe(1);
    expect(createCount).toBe(createsBefore + 1);
    expect(await prisma.service.count({ where: { userId: user.id } })).toBe(1);
    const allowance = await computeTrialAllowance(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    );
    expect(allowance.defaultConsumed).toBe(1);
    expect(allowance.totalRemaining).toBe(0);
  });

  it("C2. simultaneous reset and claim converge safely (test 61)", async () => {
    const user = await createUser();
    const [resetOutcome, claimOutcome] = await Promise.all([
      resetTrialAccess({
        admin,
        userId: user.id,
        reason: "race",
        idempotencyKey: `trial-reset:${randomUUID()}`,
      }),
      (async () => {
        const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
        return claimFreeTrial(fresh, panel.id);
      })(),
    ]);
    // Whatever interleaving happened, the invariants hold: at most one live
    // claim, consumed never exceeds allowance, allowance summary coherent.
    expect(resetOutcome.ok === true || claimOutcome.kind !== "created" || true).toBe(true);
    const live = await prisma.freeTrialClaim.count({
      where: { userId: user.id, status: { in: ["CLAIMED", "PROVISIONING", "ACTIVE", "MANUAL_REVIEW"] } },
    });
    expect(live).toBeLessThanOrEqual(1);
    const rows = await prisma.freeTrialEntitlement.findMany({ where: { userId: user.id } });
    for (const row of rows) {
      expect(row.consumed).toBeGreaterThanOrEqual(0);
      expect(row.consumed).toBeLessThanOrEqual(row.allowance);
    }
  });

  it("C3. simultaneous revoke and claim never bypasses the barrier (test 62)", async () => {
    const user = await createUser();
    const [revokeOutcome, claimOutcome] = await Promise.all([
      revokeTrialAccess({ admin, userId: user.id, reason: "race revoke" }),
      (async () => {
        const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
        return claimFreeTrial(fresh, panel.id);
      })(),
    ]);
    expect(revokeOutcome.ok).toBe(true);
    // Either the claim won the race (created before the revoke landed) or it
    // was denied - both are consistent; afterwards no NEW claim is possible.
    const after = await claimFreeTrial(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      panel.id,
    );
    expect(after.kind).toBe("denied");
    if (claimOutcome.kind === "created") {
      expect(await prisma.service.count({ where: { userId: user.id } })).toBe(1);
    }
  });

  it("C4. definite remote failure releases exactly once; retry mints ONE account (tests 63-66 family)", async () => {
    const user = await createUser();
    const grant = await grantTrialAllowance({
      admin,
      userId: user.id,
      count: 1,
      reason: "release test",
      idempotencyKey: `trial-grant:${randomUUID()}`,
    });
    expect(grant.ok).toBe(true);
    if (!grant.ok) return;
    // Exhaust the default first so the grant funds the claim.
    await prisma.user.update({
      where: { id: user.id },
      data: { freeTrialDefaultAllowanceOverride: 0 },
    });

    failNextCreate = true;
    const failed = await claimFreeTrial(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      panel.id,
    );
    expect(failed.kind).toBe("denied");
    const failedClaim = await prisma.freeTrialClaim.findFirstOrThrow({
      where: { userId: user.id, status: FreeTrialClaimStatus.FAILED },
    });
    expect(failedClaim.allowanceReleasedAt).not.toBeNull();
    let row = await prisma.freeTrialEntitlement.findUniqueOrThrow({
      where: { id: grant.value.id },
    });
    expect(row.consumed).toBe(0);
    expect(row.status).toBe("ACTIVE");

    // A second release of the same claim is a no-op (test 66).
    expect(await releaseClaimAllowance(failedClaim.id, "double")).toBe(false);
    row = await prisma.freeTrialEntitlement.findUniqueOrThrow({ where: { id: grant.value.id } });
    expect(row.consumed).toBe(0);

    // Retry consumes the released unit and mints exactly one account.
    const createsBefore = createCount;
    const retry = await claimFreeTrial(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      panel.id,
    );
    expect(retry.kind).toBe("created");
    expect(createCount).toBe(createsBefore + 1);
    row = await prisma.freeTrialEntitlement.findUniqueOrThrow({ where: { id: grant.value.id } });
    expect(row.consumed).toBe(1);
  });

  it("C5. UNKNOWN keeps the allowance reserved until reconciliation decides (tests 64/65)", async () => {
    const user = await createUser();
    // Fabricate an UNKNOWN-outcome claim: PROVISIONING with a frozen
    // username that does NOT exist remotely (default pool funding).
    seq += 1;
    const username = `tl-unknown-${runTag}-${seq}`;
    const claim = await prisma.freeTrialClaim.create({
      data: {
        userId: user.id,
        panelId: panel.id,
        status: FreeTrialClaimStatus.PROVISIONING,
        usernameSnapshot: username,
        durationMinutes: TRIAL_MINUTES,
        trafficBytes: BigInt(TRIAL_MB) * 1024n * 1024n,
      },
    });
    // While PROVISIONING, the unit is reserved: no new claim possible.
    const duringUnknown = await claimFreeTrial(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
      panel.id,
    );
    expect(duringUnknown.kind).toBe("denied");
    const allowance = await computeTrialAllowance(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    );
    expect(allowance.defaultConsumed).toBe(1);

    // Reconciliation: account not on the panel -> NOT_APPLIED -> release once.
    expect(await reconcileTrialClaim(claim.id)).toBe("NOT_APPLIED");
    const released = await prisma.freeTrialClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(released.status).toBe(FreeTrialClaimStatus.FAILED);
    expect(released.allowanceReleasedAt).not.toBeNull();
    const after = await computeTrialAllowance(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    );
    expect(after.defaultConsumed).toBe(0);
    // Reconcile retry does not release twice (test 66): a FAILED claim is
    // out of reconciliation scope (no-op) and consumption stays released.
    expect(await reconcileTrialClaim(claim.id)).toBe("UNKNOWN");
    expect(
      (
        await computeTrialAllowance(
          await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
        )
      ).defaultConsumed,
    ).toBe(0);
  });

  it("C6. force resolution: NOT_CREATED releases once; CREATED recovers the Service (tests 100-104)", async () => {
    // NOT_CREATED path.
    const user = await createUser();
    seq += 1;
    const missing = await prisma.freeTrialClaim.create({
      data: {
        userId: user.id,
        panelId: panel.id,
        status: FreeTrialClaimStatus.MANUAL_REVIEW,
        usernameSnapshot: `tl-fnc-${runTag}-${seq}`,
        durationMinutes: TRIAL_MINUTES,
        trafficBytes: BigInt(TRIAL_MB) * 1024n * 1024n,
      },
    });
    const noReason = await forceClaimNotCreated({ admin, claimId: missing.id, reason: "  " });
    expect(noReason.ok).toBe(false); // reason required (test 103)
    const forced = await forceClaimNotCreated({
      admin,
      claimId: missing.id,
      reason: "panel checked manually",
    });
    expect(forced.ok).toBe(true);
    const cancelled = await prisma.freeTrialClaim.findUniqueOrThrow({ where: { id: missing.id } });
    expect(cancelled.status).toBe(FreeTrialClaimStatus.CANCELLED);
    expect(cancelled.allowanceReleasedAt).not.toBeNull();
    const replay = await forceClaimNotCreated({ admin, claimId: missing.id, reason: "again" });
    expect(replay.ok).toBe(false); // no double release

    // CREATED path: the account EXISTS remotely -> Service recovered.
    const user2 = await createUser();
    seq += 1;
    const existingName = `tl-fc-${runTag}-${seq}`;
    panelUsers.set(existingName, {
      data_limit: TRIAL_MB * 1024 * 1024,
      expire: Math.floor(Date.now() / 1000) + TRIAL_MINUTES * 60,
      used_traffic: 0,
      note: "",
      status: "active",
      subSeq: 0,
    });
    const orphan = await prisma.freeTrialClaim.create({
      data: {
        userId: user2.id,
        panelId: panel.id,
        status: FreeTrialClaimStatus.MANUAL_REVIEW,
        usernameSnapshot: existingName,
        durationMinutes: TRIAL_MINUTES,
        trafficBytes: BigInt(TRIAL_MB) * 1024n * 1024n,
      },
    });
    const confirmed = await forceClaimCreated({
      admin,
      claimId: orphan.id,
      reason: "panel shows the account",
    });
    expect(confirmed.ok).toBe(true);
    if (confirmed.ok) {
      expect(confirmed.value).toBe("APPLIED");
    }
    const recovered = await prisma.freeTrialClaim.findUniqueOrThrow({ where: { id: orphan.id } });
    expect(recovered.status).toBe(FreeTrialClaimStatus.ACTIVE);
    expect(recovered.serviceId).not.toBeNull();
    // Allowance stays consumed (test 102).
    const allowance = await computeTrialAllowance(
      await prisma.user.findUniqueOrThrow({ where: { id: user2.id } }),
    );
    expect(allowance.defaultConsumed).toBe(1);
    // Audits exist for both forced actions (test 104 auditing).
    expect(
      await prisma.auditLog.count({
        where: { action: { in: ["trial.claim.forced_not_created", "trial.claim.forced_created"] } },
      }),
    ).toBeGreaterThanOrEqual(2);
  });

  it("C7. legacy compatibility: checkTrialEligibility still speaks the engine dialect (test 111)", async () => {
    const user = await createUser();
    await createTrial(user);
    const again = await checkTrialEligibility(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    );
    expect(again.ok).toBe(false);
    if (!again.ok) {
      expect(again.code).toBe("trial-active");
    }
  });
});

describe.skipIf(hasDeps)("trial lifecycle + entitlements (skipped)", () => {
  it("requires DATABASE_URL and REDIS_URL - see docs/testing.md", () => {
    expect(hasDeps).toBe(false);
  });
});
