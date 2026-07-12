import {
  prisma,
  type Order,
  type User,
} from "@zedbot/database";
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
  failStaleRunningBroadcasts,
  recoverStaleProvisioningOrders,
  runStartupRecovery,
  STALE_PIPELINE_MINUTES,
} from "../src/services/startup-recovery.service.js";

// =============================================================================
// Startup crash recovery integration tests (real PostgreSQL).
//
// Reproduces the production orphan states this module exists for: a process
// crash between the PAID -> PROVISIONING claim and the pipeline finish left
// the order stuck forever (every entry point refuses PROVISIONING orders),
// and a crash inside the broadcast send loop left the broadcast RUNNING
// forever. Recovery must apply the pipelines' own semantics - completion
// anchor -> COMPLETED, otherwise FAILED + idempotent wallet refund - must
// never touch fresh (possibly live) rows, and must never double-refund even
// when two recovery sweeps race.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const PRICE = 40_000;

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let tgSeq = 0;

let panelId: string;
let categoryId: string;
let productId: string;

beforeAll(async () => {
  if (!hasDb) return;
  const panel = await prisma.panel.create({
    data: {
      type: "MARZBAN",
      name: `recovery-panel-${runTag}`,
      baseUrl: "http://127.0.0.1:1",
      status: "ACTIVE",
    },
  });
  panelId = panel.id;
  const category = await prisma.productCategory.create({
    data: { type: "SERVICE_PRODUCT", name: `recovery-cat-${runTag}`, isActive: true },
  });
  categoryId = category.id;
  const product = await prisma.product.create({
    data: {
      type: "SERVICE_PRODUCT",
      categoryId,
      panelId,
      name: `recovery-product-${runTag}`,
      priceToman: PRICE,
      volumeGb: 10,
      durationDays: 30,
      isActive: true,
    },
  });
  productId = product.id;
});

afterAll(async () => {
  if (!hasDb) return;
  await prisma.product.deleteMany({ where: { id: productId } }).catch(() => undefined);
  await prisma.productCategory.deleteMany({ where: { id: categoryId } }).catch(() => undefined);
  await prisma.panel.deleteMany({ where: { id: panelId } }).catch(() => undefined);
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
  serviceId: string | null = null,
): Promise<Order> {
  return prisma.order.create({
    data: {
      userId: user.id,
      type,
      status: "PROVISIONING",
      productId,
      serviceId,
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

async function createService(user: User, username: string, orderId: string | null) {
  return prisma.service.create({
    data: {
      userId: user.id,
      orderId,
      panelId,
      productId,
      panelType: "MARZBAN",
      username,
      status: "ACTIVE",
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

describe.runIf(hasDb)("startup crash recovery", () => {
  it("completes a stale purchase whose Service row exists (no refund)", async () => {
    const user = await createUser();
    const order = await createProvisioningOrder(user, "SERVICE_PURCHASE");
    await createService(user, generatePanelUsername(user.telegramId, order.id), order.id);
    await ageOrder(order.id);

    const report = await recoverStaleProvisioningOrders(staleCutoff());
    expect(report.completedOrders).toBeGreaterThanOrEqual(1);

    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe("COMPLETED");
    const state = await refundState(user.id, order.id);
    expect(state.refunds).toEqual([]); // service exists - money stays spent
    expect(state.balance).toBe(0);
  });

  it("repairs and completes a stale purchase whose service was never linked", async () => {
    // Crash window: panel + Service row created, orderId link not yet
    // written. The deterministic per-order username identifies it safely.
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
    expect(freshService.orderId).toBe(order.id); // repaired, not re-created
    expect((await refundState(user.id, order.id)).refunds).toEqual([]);
  });

  it("refunds a stale purchase with no service - exactly once, even when re-run", async () => {
    const user = await createUser();
    const order = await createProvisioningOrder(user, "SERVICE_PURCHASE");
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

  it("completes stale renewal/extras whose event-log anchor exists (no refund)", async () => {
    const user = await createUser();
    const cases = [
      { type: "SERVICE_RENEWAL", eventType: RENEWAL_EVENT_TYPE },
      { type: "EXTRA_VOLUME", eventType: EXTRA_VOLUME_EVENT_TYPE },
      { type: "EXTRA_TIME", eventType: EXTRA_TIME_EVENT_TYPE },
    ] as const;
    for (const { type, eventType } of cases) {
      const service = await createService(user, `rec-${runTag}-${type.toLowerCase()}`, null);
      const order = await createProvisioningOrder(user, type, service.id);
      await prisma.serviceEventLog.create({
        data: {
          serviceId: service.id,
          userId: user.id,
          panelId,
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

  it("refunds a stale renewal that never reached its event log", async () => {
    const user = await createUser();
    const service = await createService(user, `rec-${runTag}-renew-lost`, null);
    const order = await createProvisioningOrder(user, "SERVICE_RENEWAL", service.id);
    await ageOrder(order.id);

    await recoverStaleProvisioningOrders(staleCutoff());

    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe("FAILED");
    const state = await refundState(user.id, order.id);
    expect(state.refunds.length).toBe(1);
    expect(state.balance).toBe(PRICE);
  });

  it("never touches a FRESH PROVISIONING order (live pipeline race)", async () => {
    const user = await createUser();
    const order = await createProvisioningOrder(user, "SERVICE_PURCHASE");
    // NOT aged: this order looks exactly like one a live pipeline claimed
    // moments ago - recovery must leave it alone.

    const report = await recoverStaleProvisioningOrders(staleCutoff());
    void report;

    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe("PROVISIONING"); // untouched
    expect((await refundState(user.id, order.id)).refunds).toEqual([]);
  });

  it("two recovery sweeps racing on one stale order refund exactly once", async () => {
    const user = await createUser();
    const order = await createProvisioningOrder(user, "SERVICE_PURCHASE");
    await ageOrder(order.id);

    await Promise.all([
      recoverStaleProvisioningOrders(staleCutoff()),
      recoverStaleProvisioningOrders(staleCutoff()),
    ]);

    const state = await refundState(user.id, order.id);
    expect(state.refunds.length).toBe(1); // CAS + idempotent refund
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
    expect(freshLive.status).toBe("RUNNING"); // a live send loop is never killed

    await prisma.broadcast.deleteMany({ where: { id: live.id } });
    await prisma.admin.deleteMany({ where: { id: admin.id } });
  });

  it("runStartupRecovery reports and never throws", async () => {
    const user = await createUser();
    const order = await createProvisioningOrder(user, "SERVICE_PURCHASE");
    await ageOrder(order.id);

    const report = await runStartupRecovery();
    expect(report.checkedOrders).toBeGreaterThanOrEqual(1);
    expect(report.unresolvedOrders).toBe(0);

    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe("FAILED"); // no anchor -> refunded
  });
});

describe.runIf(!hasDb)("startup crash recovery (skipped)", () => {
  it("integration tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
