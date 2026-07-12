import http from "node:http";

import {
  prisma,
  type Order,
  type Panel,
  type User,
} from "@zedbot/database";
import { encryptSecret } from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "startup-recovery-secret-startup-rec-1";

import { EXTRA_TIME_EVENT_TYPE } from "../src/services/extra-time.service.js";
import { EXTRA_VOLUME_EVENT_TYPE } from "../src/services/extra-volume.service.js";
import {
  generatePanelUsername,
  REFUND_PROVISIONING_REASON,
} from "../src/services/provisioning.service.js";
import { RENEWAL_EVENT_TYPE } from "../src/services/service-renewal.service.js";
import {
  compareMutationState,
  failStaleRunningBroadcasts,
  recoverStaleProvisioningOrders,
  runStartupRecovery,
  STALE_PIPELINE_MINUTES,
} from "../src/services/startup-recovery.service.js";

// =============================================================================
// Startup crash recovery + panel/database reconciliation (real PostgreSQL +
// a mock Marzban panel).
//
// The dangerous scenario under test: the panel mutation SUCCEEDED but the
// database commit was lost in a crash - no Service/ServiceEventLog anchor
// exists. A missing anchor must NEVER be treated as proof that the panel
// mutation did not happen:
//   - refund ONLY when the panel positively proves it (account absent for a
//     purchase; mutation-owned fields identical to the stored pre-state for
//     renewal/extras);
//   - complete + reconcile when the panel proves the mutation applied;
//   - defer (leave PROVISIONING, no refund, no completion) whenever the
//     panel cannot be read - unreachable, unimplemented adapter, missing
//     fields.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const PRICE = 40_000;
const GIB = 1024n * 1024n * 1024n;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let tgSeq = 0;

// --- mock Marzban panel -------------------------------------------------------------
interface MockPanelUser {
  data_limit: number; // bytes; 0 = unlimited
  expire: number; // unix seconds; 0 = never
  used_traffic?: number;
}
const panelUsers = new Map<string, MockPanelUser>();
let mockServer: http.Server;
let mockPanelUrl = "";

function startMockPanel(): Promise<void> {
  mockServer = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/admin/token") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ access_token: "mock-token" }));
      return;
    }
    const match = /^\/api\/user\/([^/]+)$/.exec(req.url ?? "");
    if (req.method === "GET" && match !== null) {
      const username = decodeURIComponent(match[1]);
      const user = panelUsers.get(username);
      if (user === undefined) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ detail: "User not found" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          username,
          status: "active",
          used_traffic: user.used_traffic ?? 0,
          data_limit: user.data_limit,
          expire: user.expire,
          subscription_url: `/sub/${username}`,
        }),
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    mockServer.listen(0, "127.0.0.1", () => {
      const address = mockServer.address() as { port: number };
      mockPanelUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
}

// --- fixtures ----------------------------------------------------------------------
let mockPanel: Panel;
let deadPanel: Panel;
let xuiPanel: Panel;
let categoryId: string;
let productId: string;
let deadProductId: string;
let xuiProductId: string;

beforeAll(async () => {
  if (!hasDb) return;
  await startMockPanel();
  [mockPanel, deadPanel, xuiPanel] = await Promise.all([
    prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: `recon-panel-${runTag}`,
        baseUrl: mockPanelUrl,
        username: "admin",
        passwordEncrypted: encryptSecret("mock-password"),
        status: "ACTIVE",
      },
    }),
    prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: `recon-dead-panel-${runTag}`,
        baseUrl: "http://127.0.0.1:1",
        username: "admin",
        passwordEncrypted: encryptSecret("mock-password"),
        status: "ACTIVE",
      },
    }),
    prisma.panel.create({
      data: {
        type: "XUI",
        name: `recon-xui-panel-${runTag}`,
        baseUrl: "http://127.0.0.1:1",
        tokenEncrypted: encryptSecret("mock-token"),
        status: "ACTIVE",
      },
    }),
  ]);
  const category = await prisma.productCategory.create({
    data: { type: "SERVICE_PRODUCT", name: `recon-cat-${runTag}`, isActive: true },
  });
  categoryId = category.id;
  const makeProduct = (name: string, panelId: string) =>
    prisma.product.create({
      data: {
        type: "SERVICE_PRODUCT",
        categoryId,
        panelId,
        name,
        priceToman: PRICE,
        volumeGb: 10,
        durationDays: 30,
        isActive: true,
      },
    });
  const [p1, p2, p3] = await Promise.all([
    makeProduct(`recon-product-${runTag}`, mockPanel.id),
    makeProduct(`recon-dead-product-${runTag}`, deadPanel.id),
    makeProduct(`recon-xui-product-${runTag}`, xuiPanel.id),
  ]);
  productId = p1.id;
  deadProductId = p2.id;
  xuiProductId = p3.id;
});

afterAll(async () => {
  if (!hasDb) return;
  mockServer?.close();
});

async function createUser(balanceToman = 0): Promise<User> {
  tgSeq += 1;
  return prisma.user.create({
    data: { telegramId: runTag + BigInt(tgSeq), balanceToman },
  });
}

async function createProvisioningOrder(
  user: User,
  type: "SERVICE_PURCHASE" | "SERVICE_RENEWAL" | "EXTRA_VOLUME" | "EXTRA_TIME",
  opts: { serviceId?: string | null; productId?: string } = {},
): Promise<Order> {
  return prisma.order.create({
    data: {
      userId: user.id,
      type,
      status: "PROVISIONING",
      productId: opts.productId ?? productId,
      serviceId: opts.serviceId ?? null,
      originalPriceToman: PRICE,
      discountAmountToman: 0,
      finalPriceToman: PRICE,
      paidAt: new Date(),
    },
  });
}

/** Simulates a crash long ago: ages the claim past the stale threshold. */
async function ageOrder(orderId: string, minutes = STALE_PIPELINE_MINUTES + 10): Promise<void> {
  await prisma.$executeRaw`UPDATE "Order" SET "updatedAt" = now() - (${minutes} * interval '1 minute') WHERE "id" = ${orderId}`;
}

async function createService(
  user: User,
  username: string,
  orderId: string | null,
  opts: { volumeBytes?: bigint; expiresAt?: Date | null } = {},
) {
  return prisma.service.create({
    data: {
      userId: user.id,
      orderId,
      panelId: mockPanel.id,
      productId,
      panelType: "MARZBAN",
      username,
      status: "ACTIVE",
      volumeBytes: opts.volumeBytes ?? 10n * GIB,
      remainingBytes: opts.volumeBytes ?? 10n * GIB,
      expiresAt: opts.expiresAt === undefined ? new Date(Date.now() + 30 * 86_400_000) : opts.expiresAt,
      startsAt: new Date(),
    },
  });
}

function staleCutoff(): Date {
  return new Date(Date.now() - STALE_PIPELINE_MINUTES * 60_000);
}

async function refundState(userId: string, orderId: string) {
  const [user, refunds] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    prisma.walletTransaction.findMany({
      where: { relatedOrderId: orderId, reason: REFUND_PROVISIONING_REASON },
    }),
  ]);
  return { balance: user.balanceToman, refunds };
}

/** Aligns a Date to whole unix seconds (Marzban stores seconds). */
function secondsDate(msFromNow: number): { date: Date; unix: number } {
  const unix = Math.floor((Date.now() + msFromNow) / 1000);
  return { date: new Date(unix * 1000), unix };
}

describe.runIf(hasDb)("startup crash recovery with panel reconciliation", () => {
  it("completes a stale purchase whose Service row exists (no refund, no panel call)", async () => {
    const user = await createUser();
    const order = await createProvisioningOrder(user, "SERVICE_PURCHASE");
    await createService(user, generatePanelUsername(user.telegramId, order.id), order.id);
    await ageOrder(order.id);

    const report = await recoverStaleProvisioningOrders(staleCutoff());
    expect(report.completedOrders).toBeGreaterThanOrEqual(1);

    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe("COMPLETED");
    expect((await refundState(user.id, order.id)).refunds).toEqual([]);
  });

  it("repairs and completes a stale purchase whose service was never linked", async () => {
    const user = await createUser();
    const order = await createProvisioningOrder(user, "SERVICE_PURCHASE");
    const service = await createService(
      user,
      generatePanelUsername(user.telegramId, order.id),
      null,
    );
    await ageOrder(order.id);

    await recoverStaleProvisioningOrders(staleCutoff());

    const [freshOrder, freshService] = await Promise.all([
      prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
      prisma.service.findUniqueOrThrow({ where: { id: service.id } }),
    ]);
    expect(freshOrder.status).toBe("COMPLETED");
    expect(freshService.orderId).toBe(order.id);
    expect((await refundState(user.id, order.id)).refunds).toEqual([]);
  });

  it("refunds an anchor-less purchase ONLY after the panel confirms the account is absent", async () => {
    const user = await createUser();
    const order = await createProvisioningOrder(user, "SERVICE_PURCHASE");
    // The mock panel 404s for this order's username: proven never created.
    await ageOrder(order.id);

    await recoverStaleProvisioningOrders(staleCutoff());
    await recoverStaleProvisioningOrders(staleCutoff()); // idempotent re-run

    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe("FAILED");
    const state = await refundState(user.id, order.id);
    expect(state.refunds.length).toBe(1); // NEVER a second refund
    expect(state.refunds[0]!.amountToman).toBe(PRICE);
    expect(state.balance).toBe(PRICE);
  });

  it("ADOPTS the panel account of an anchor-less purchase instead of refunding", async () => {
    // The dangerous scenario: panel create SUCCEEDED, DB commit lost.
    const user = await createUser();
    const order = await createProvisioningOrder(user, "SERVICE_PURCHASE");
    const username = generatePanelUsername(user.telegramId, order.id);
    const expiry = secondsDate(30 * 86_400_000);
    panelUsers.set(username, {
      data_limit: Number(10n * GIB),
      expire: expiry.unix,
      used_traffic: 0,
    });
    await ageOrder(order.id);

    const report = await recoverStaleProvisioningOrders(staleCutoff());
    expect(report.refundedOrders).toBe(0);

    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe("COMPLETED"); // NOT FAILED
    expect((await refundState(user.id, order.id)).refunds).toEqual([]); // NO refund

    const adopted = await prisma.service.findUnique({ where: { username } });
    expect(adopted).not.toBeNull();
    expect(adopted!.orderId).toBe(order.id);
    expect(adopted!.userId).toBe(user.id);
    expect(adopted!.volumeBytes).toBe(10n * GIB);
    expect(adopted!.expiresAt?.getTime()).toBe(expiry.date.getTime());

    // Re-run: now anchored - still exactly one service, still no refund.
    await recoverStaleProvisioningOrders(staleCutoff());
    expect(await prisma.service.count({ where: { orderId: order.id } })).toBe(1);
    expect((await refundState(user.id, order.id)).refunds).toEqual([]);
  });

  it("DEFERS an anchor-less purchase when the panel is unreachable (no refund, no completion)", async () => {
    const user = await createUser();
    const order = await createProvisioningOrder(user, "SERVICE_PURCHASE", {
      productId: deadProductId,
    });
    await ageOrder(order.id);

    const report = await recoverStaleProvisioningOrders(staleCutoff());
    expect(report.deferredOrders).toBeGreaterThanOrEqual(1);

    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe("PROVISIONING"); // untouched - retried later
    expect((await refundState(user.id, order.id)).refunds).toEqual([]);
    expect(await prisma.service.count({ where: { orderId: order.id } })).toBe(0);
  });

  it("DEFERS when the panel adapter cannot read accounts at all (XUI)", async () => {
    const user = await createUser();
    const order = await createProvisioningOrder(user, "SERVICE_PURCHASE", {
      productId: xuiProductId,
    });
    await ageOrder(order.id);

    await recoverStaleProvisioningOrders(staleCutoff());

    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe("PROVISIONING"); // "not implemented" is NOT "not found"
    expect((await refundState(user.id, order.id)).refunds).toEqual([]);
  });

  it("completes stale renewal/extras whose event-log anchor exists (no refund)", async () => {
    const user = await createUser();
    const cases = [
      { type: "SERVICE_RENEWAL", eventType: RENEWAL_EVENT_TYPE },
      { type: "EXTRA_VOLUME", eventType: EXTRA_VOLUME_EVENT_TYPE },
      { type: "EXTRA_TIME", eventType: EXTRA_TIME_EVENT_TYPE },
    ] as const;
    for (const { type, eventType } of cases) {
      const service = await createService(user, `recon-${runTag}-${type.toLowerCase()}`, null);
      const order = await createProvisioningOrder(user, type, { serviceId: service.id });
      await prisma.serviceEventLog.create({
        data: {
          serviceId: service.id,
          userId: user.id,
          panelId: mockPanel.id,
          eventType,
          metadata: { orderId: order.id },
        },
      });
      await ageOrder(order.id);

      await recoverStaleProvisioningOrders(staleCutoff());

      const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(fresh.status).toBe("COMPLETED");
      expect((await refundState(user.id, order.id)).refunds).toEqual([]);
    }
  });

  it("refunds an anchor-less renewal ONLY when panel state matches the stored pre-state", async () => {
    const user = await createUser();
    const expiry = secondsDate(10 * 86_400_000);
    const username = `recon-${runTag}-renew-same`;
    const service = await createService(user, username, null, {
      volumeBytes: 10n * GIB,
      expiresAt: expiry.date,
    });
    // Panel reports EXACTLY the stored pre-mutation state: proven unapplied.
    panelUsers.set(username, { data_limit: Number(10n * GIB), expire: expiry.unix });
    const order = await createProvisioningOrder(user, "SERVICE_RENEWAL", {
      serviceId: service.id,
    });
    await ageOrder(order.id);

    await recoverStaleProvisioningOrders(staleCutoff());

    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe("FAILED");
    const state = await refundState(user.id, order.id);
    expect(state.refunds.length).toBe(1);
    expect(state.balance).toBe(PRICE);
    // The service row itself is untouched by the refund path.
    const freshService = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(freshService.volumeBytes).toBe(10n * GIB);
  });

  it("RECONCILES an anchor-less renewal whose panel state changed (no refund)", async () => {
    // Panel renewal applied (bigger limit, later expiry), DB commit lost.
    const user = await createUser();
    const storedExpiry = secondsDate(5 * 86_400_000);
    const panelExpiry = secondsDate(35 * 86_400_000);
    const username = `recon-${runTag}-renew-applied`;
    const service = await createService(user, username, null, {
      volumeBytes: 10n * GIB,
      expiresAt: storedExpiry.date,
    });
    panelUsers.set(username, {
      data_limit: Number(20n * GIB),
      expire: panelExpiry.unix,
      used_traffic: 0,
    });
    const order = await createProvisioningOrder(user, "SERVICE_RENEWAL", {
      serviceId: service.id,
    });
    await ageOrder(order.id);

    await recoverStaleProvisioningOrders(staleCutoff());

    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe("COMPLETED"); // NOT FAILED
    expect((await refundState(user.id, order.id)).refunds).toEqual([]); // NO refund

    // Service row reconciled from panel truth.
    const freshService = await prisma.service.findUniqueOrThrow({ where: { id: service.id } });
    expect(freshService.volumeBytes).toBe(20n * GIB);
    expect(freshService.expiresAt?.getTime()).toBe(panelExpiry.date.getTime());

    // The pipeline's own anchor was written - re-runs are anchored.
    const events = await prisma.serviceEventLog.findMany({
      where: { eventType: RENEWAL_EVENT_TYPE, metadata: { path: ["orderId"], equals: order.id } },
    });
    expect(events.length).toBe(1);
    await recoverStaleProvisioningOrders(staleCutoff());
    expect(
      await prisma.serviceEventLog.count({
        where: { eventType: RENEWAL_EVENT_TYPE, metadata: { path: ["orderId"], equals: order.id } },
      }),
    ).toBe(1);
  });

  it("extra volume compares the data limit; extra time compares the expiry", async () => {
    const user = await createUser();
    // EXTRA_VOLUME, panel limit unchanged -> refund.
    const evExpiry = secondsDate(10 * 86_400_000);
    const evName = `recon-${runTag}-ev-same`;
    const evService = await createService(user, evName, null, {
      volumeBytes: 10n * GIB,
      expiresAt: evExpiry.date,
    });
    panelUsers.set(evName, { data_limit: Number(10n * GIB), expire: evExpiry.unix });
    const evOrder = await createProvisioningOrder(user, "EXTRA_VOLUME", {
      serviceId: evService.id,
    });
    await ageOrder(evOrder.id);

    // EXTRA_TIME, panel expiry later -> reconcile-complete.
    const etStored = secondsDate(10 * 86_400_000);
    const etPanel = secondsDate(40 * 86_400_000);
    const etName = `recon-${runTag}-et-applied`;
    const etService = await createService(user, etName, null, {
      volumeBytes: 10n * GIB,
      expiresAt: etStored.date,
    });
    panelUsers.set(etName, { data_limit: Number(10n * GIB), expire: etPanel.unix });
    const etOrder = await createProvisioningOrder(user, "EXTRA_TIME", {
      serviceId: etService.id,
    });
    await ageOrder(etOrder.id);

    await recoverStaleProvisioningOrders(staleCutoff());

    const [freshEv, freshEt] = await Promise.all([
      prisma.order.findUniqueOrThrow({ where: { id: evOrder.id } }),
      prisma.order.findUniqueOrThrow({ where: { id: etOrder.id } }),
    ]);
    expect(freshEv.status).toBe("FAILED"); // proven unapplied -> refund
    expect(freshEt.status).toBe("COMPLETED"); // proven applied -> no refund
    expect((await refundState(user.id, evOrder.id)).refunds.length).toBe(1);
    expect((await refundState(user.id, etOrder.id)).refunds).toEqual([]);
    const freshEtService = await prisma.service.findUniqueOrThrow({
      where: { id: etService.id },
    });
    expect(freshEtService.expiresAt?.getTime()).toBe(etPanel.date.getTime());
  });

  it("never touches a FRESH PROVISIONING order (live pipeline race)", async () => {
    const user = await createUser();
    const order = await createProvisioningOrder(user, "SERVICE_PURCHASE");
    // NOT aged: looks exactly like a live pipeline's claim.

    await recoverStaleProvisioningOrders(staleCutoff());

    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe("PROVISIONING");
    expect((await refundState(user.id, order.id)).refunds).toEqual([]);
  });

  it("two recovery sweeps racing on one panel-confirmed-absent order refund exactly once", async () => {
    const user = await createUser();
    const order = await createProvisioningOrder(user, "SERVICE_PURCHASE");
    await ageOrder(order.id); // username absent from mock panel -> 404

    await Promise.all([
      recoverStaleProvisioningOrders(staleCutoff()),
      recoverStaleProvisioningOrders(staleCutoff()),
    ]);

    const state = await refundState(user.id, order.id);
    expect(state.refunds.length).toBe(1);
    expect(state.balance).toBe(PRICE);
    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe("FAILED");
  });

  it("marks a stale RUNNING broadcast FAILED and leaves a fresh one alone", async () => {
    const admin = await prisma.admin.create({
      data: { telegramId: runTag + 800_000n, role: "OWNER", isActive: true },
    });
    const stale = await prisma.broadcast.create({
      data: {
        type: "SEND",
        status: "RUNNING",
        targetFilter: { audience: "all_active" },
        messageText: "x",
        createdByAdminId: admin.id,
        startedAt: new Date(),
      },
    });
    const live = await prisma.broadcast.create({
      data: {
        type: "SEND",
        status: "RUNNING",
        targetFilter: { audience: "all_active" },
        messageText: "y",
        createdByAdminId: admin.id,
        startedAt: new Date(),
      },
    });
    await prisma.$executeRaw`UPDATE "Broadcast" SET "updatedAt" = now() - (${STALE_PIPELINE_MINUTES + 10} * interval '1 minute') WHERE "id" = ${stale.id}`;

    const count = await failStaleRunningBroadcasts(staleCutoff());
    expect(count).toBeGreaterThanOrEqual(1);

    const [freshStale, freshLive] = await Promise.all([
      prisma.broadcast.findUniqueOrThrow({ where: { id: stale.id } }),
      prisma.broadcast.findUniqueOrThrow({ where: { id: live.id } }),
    ]);
    expect(freshStale.status).toBe("FAILED");
    expect(freshLive.status).toBe("RUNNING");

    await prisma.broadcast.deleteMany({ where: { id: live.id } });
    await prisma.admin.deleteMany({ where: { id: admin.id } });
  });

  it("runStartupRecovery reports all outcome classes and never throws", async () => {
    const user = await createUser();
    const refundable = await createProvisioningOrder(user, "SERVICE_PURCHASE");
    await ageOrder(refundable.id); // 404 on mock panel -> refunded
    const deferred = await createProvisioningOrder(user, "SERVICE_PURCHASE", {
      productId: deadProductId,
    });
    await ageOrder(deferred.id); // unreachable panel -> deferred

    const report = await runStartupRecovery();
    expect(report.checkedOrders).toBeGreaterThanOrEqual(2);
    expect(report.refundedOrders).toBeGreaterThanOrEqual(1);
    expect(report.deferredOrders).toBeGreaterThanOrEqual(1);
    expect(report.unresolvedOrders).toBe(0);

    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: refundable.id } })).status,
    ).toBe("FAILED");
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: deferred.id } })).status,
    ).toBe("PROVISIONING");
  });
});

describe("mutation state comparator (pure)", () => {
  const service = { volumeBytes: 10n * GIB, expiresAt: new Date("2026-08-01T00:00:00Z") };

  it("treats missing panel fields as unknown, never as a decision", () => {
    expect(compareMutationState("EXTRA_VOLUME", service, { ok: true })).toBe("unknown");
    expect(compareMutationState("EXTRA_TIME", service, { ok: true })).toBe("unknown");
    expect(compareMutationState("SERVICE_RENEWAL", service, { ok: true })).toBe("unknown");
    // Renewal with only ONE comparable-and-equal field stays unknown.
    expect(
      compareMutationState("SERVICE_RENEWAL", service, { ok: true, totalBytes: 10n * GIB }),
    ).toBe("unknown");
  });

  it("tolerates sub-second expiry truncation (Marzban stores seconds)", () => {
    const truncated = new Date(Math.floor(service.expiresAt.getTime() / 1000) * 1000);
    expect(
      compareMutationState("EXTRA_TIME", service, { ok: true, expiresAt: truncated }),
    ).toBe("not_applied");
    const dayLater = new Date(service.expiresAt.getTime() + 86_400_000);
    expect(
      compareMutationState("EXTRA_TIME", service, { ok: true, expiresAt: dayLater }),
    ).toBe("applied");
  });

  it("maps unlimited (null) panel limits to the stored 0n convention", () => {
    const unlimited = { volumeBytes: 0n, expiresAt: null };
    expect(
      compareMutationState("EXTRA_VOLUME", unlimited, { ok: true, totalBytes: null }),
    ).toBe("not_applied");
    expect(
      compareMutationState("EXTRA_VOLUME", unlimited, { ok: true, totalBytes: 10n * GIB }),
    ).toBe("applied");
  });
});

describe.runIf(!hasDb)("startup crash recovery (skipped)", () => {
  it("integration tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
