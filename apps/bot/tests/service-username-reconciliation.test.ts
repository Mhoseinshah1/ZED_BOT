import { randomUUID } from "node:crypto";

import {
  prisma,
  ServiceUsernameMode,
  ServiceUsernameReservationStatus,
  type Panel,
  type Product,
  type User,
} from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.APP_SECRET ??= "svc-recon-tests-secret-svc-recon-0001";

import {
  fileServiceUsernameUnboundCase,
  hasBlockingServiceUsernameUnboundCase,
  notifyServiceUsernameUnboundCase,
  retryBindServiceUsernameUnboundCase,
  SERVICE_UNBOUND_ADMIN_TEXT,
} from "../src/services/financial-reconciliation.service.js";
import { provisionPaidOrder } from "../src/services/provisioning.service.js";

// =============================================================================
// SERVICE_USERNAME_UNBOUND durable reconciliation (§3/§4/§5): the OWNER alert,
// the safe retry-bind action (bind-then-resolve in ONE locked tx, resolve ONLY
// on a real exact bind), and the provisioning-authority defense that blocks a
// direct provisionPaidOrder for an unresolved case. Real PostgreSQL + Redis.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis =
  (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;
const nextTg = (): bigint => runTag + BigInt(++seq);

describe.runIf(hasDb)("SERVICE_USERNAME_UNBOUND reconciliation (DB)", () => {
  let panel: Panel;
  let product: Product;
  let user: User;
  const ownerTgIds: bigint[] = [];
  let nonOwnerTgId = 0n;
  const adminIds: string[] = [];
  const userIds: string[] = [];

  beforeAll(async () => {
    panel = await prisma.panel.create({
      data: {
        type: "MARZBAN",
        name: `svc-recon-${runTag}`,
        baseUrl: "http://127.0.0.1:1",
        status: "ACTIVE",
        isVisible: true,
        username: "admin",
        passwordEncrypted: "enc",
        templateUsername: "tpl",
        provisioningReady: true,
      },
    });
    const category = await prisma.productCategory.create({
      data: { name: `svc-recon-cat-${runTag}`, type: "SERVICE_PRODUCT", isActive: true },
    });
    product = await prisma.product.create({
      data: {
        name: `svc-recon-prod-${runTag}`,
        type: "SERVICE_PRODUCT",
        categoryId: category.id,
        panelId: panel.id,
        priceToman: 90_000,
        durationDays: 30,
        volumeGb: 50,
        isActive: true,
        displayGroups: ["ALL"],
      },
    });
    user = await prisma.user.create({ data: { telegramId: nextTg(), group: "F" } });
    userIds.push(user.id);
    // Two ACTIVE owners (alert targets) + one ACTIVE non-owner (must be skipped).
    for (let i = 0; i < 2; i++) {
      const tg = nextTg();
      ownerTgIds.push(tg);
      const admin = await prisma.admin.create({
        data: { telegramId: tg, role: "OWNER", isActive: true },
      });
      adminIds.push(admin.id);
    }
    nonOwnerTgId = nextTg();
    const nonOwner = await prisma.admin.create({
      data: { telegramId: nonOwnerTgId, role: "SUPPORT", isActive: true },
    });
    adminIds.push(nonOwner.id);
  });

  afterAll(async () => {
    await prisma.serviceUsernameReservation.deleteMany({ where: { panelId: panel.id } });
    await prisma.financialReconciliationCase.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.service.deleteMany({ where: { panelId: panel.id } });
    await prisma.payment.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.order.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.checkoutSession.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.admin.deleteMany({ where: { id: { in: adminIds } } });
    await prisma.product.deleteMany({ where: { id: product.id } });
    await prisma.productCategory.deleteMany({ where: { id: product.categoryId } });
    await prisma.panel.deleteMany({ where: { id: panel.id } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  // Build a full settled-but-unbound case: checkout (with the username snapshot),
  // a reservation in the given state, a PAID SERVICE order, its settling payment
  // and the SERVICE_USERNAME_UNBOUND case. `reservationStatus`/`reservationUsername`
  // control whether a later retry-bind can succeed.
  async function buildCase(opts: {
    reservationStatus: ServiceUsernameReservationStatus;
    /** The username stored ON the reservation (mismatch → unbindable). */
    reservationUsername?: string;
    /** The username written INTO the checkout snapshot (what the bind expects). */
    snapshotUsername?: string;
    withNamingSnapshot?: boolean;
  }): Promise<{ caseId: string; orderId: string; reservationId: string; paymentId: string }> {
    const username = `svcu${++seq}${Math.random().toString(36).slice(2, 6)}`.slice(0, 14);
    const snapshotUsername = opts.snapshotUsername ?? username;
    const reservationUsername = opts.reservationUsername ?? username;
    const nonce = randomUUID();
    const checkout = await prisma.checkoutSession.create({
      data: {
        userId: user.id,
        purpose: "ORDER_PAYMENT",
        status: "PAID",
        expiresAt: new Date(Date.now() + 3_600_000),
        productSnapshot: {
          serviceUsernameReservationId: "PLACEHOLDER",
          serviceUsername: snapshotUsername,
          panelId: panel.id,
        },
      },
    });
    const reservation = await prisma.serviceUsernameReservation.create({
      data: {
        panelId: panel.id,
        userId: user.id,
        normalizedUsername: reservationUsername,
        activeUsernameKey:
          opts.reservationStatus === ServiceUsernameReservationStatus.RELEASED
            ? null
            : reservationUsername,
        mode: ServiceUsernameMode.CUSTOM,
        status: opts.reservationStatus,
        draftNonce: nonce,
        checkoutSessionId: checkout.id,
        boundAt: new Date(),
      },
    });
    // The snapshot must reference the actual reservation id.
    await prisma.checkoutSession.update({
      where: { id: checkout.id },
      data: {
        productSnapshot: {
          serviceUsernameReservationId: reservation.id,
          serviceUsername: snapshotUsername,
          panelId: panel.id,
        },
      },
    });
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        productId: product.id,
        type: "SERVICE_PURCHASE",
        status: "PAID",
        checkoutSessionId: checkout.id,
        finalPriceToman: 90_000,
        ...(opts.withNamingSnapshot === true
          ? { namingSnapshot: { resolvedRemoteUsername: reservationUsername, strategy: "USER_SELECTED" } }
          : {}),
      },
    });
    const payment = await prisma.payment.create({
      data: {
        userId: user.id,
        purpose: "ORDER_PAYMENT",
        status: "APPROVED",
        amountToman: 90_000,
        payableAmountToman: 90_000,
        provider: "ZARINPAL",
        providerStatus: "SUCCESS",
        orderId: order.id,
      },
    });
    const filed = await prisma.$transaction((tx) =>
      fileServiceUsernameUnboundCase(tx, {
        checkoutSessionId: checkout.id,
        paymentId: payment.id,
        userId: user.id,
        expectedAmountToman: 90_000,
        safeReason: "gateway settlement reservation bind failed: ORDER_BIND_NO_MATCH",
      }),
    );
    return {
      caseId: filed.reconciliationCase.id,
      orderId: order.id,
      reservationId: reservation.id,
      paymentId: payment.id,
    };
  }

  it("filing a case is idempotent per payment (one case, no repeated alert) (§3)", async () => {
    const built = await buildCase({ reservationStatus: ServiceUsernameReservationStatus.BOUND });
    // A second file for the SAME settling payment returns created:false — the
    // handler gates the OWNER alert on `created`, so a duplicate callback never
    // re-alerts and never files a second case.
    const again = await prisma.$transaction((tx) =>
      fileServiceUsernameUnboundCase(tx, {
        checkoutSessionId: randomUUID(),
        paymentId: built.paymentId,
        userId: user.id,
        expectedAmountToman: 90_000,
        safeReason: "second attempt",
      }),
    );
    expect(again.created).toBe(false);
    expect(again.reconciliationCase.id).toBe(built.caseId);
    const count = await prisma.financialReconciliationCase.count({
      where: { duplicatePaymentId: built.paymentId },
    });
    expect(count).toBe(1);
  });

  it("the OWNER alert reaches active owners only, with safe fields and no raw secrets (§3)", async () => {
    const built = await buildCase({ reservationStatus: ServiceUsernameReservationStatus.BOUND });
    const reconciliationCase = await prisma.financialReconciliationCase.findUniqueOrThrow({
      where: { id: built.caseId },
    });
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: built.paymentId } });
    const sent: Array<{ chatId: string; text: string }> = [];
    const api = {
      sendMessage: vi.fn(async (chatId: string | number, text: string) => {
        sent.push({ chatId: chatId.toString(), text });
        return {};
      }),
    };
    await notifyServiceUsernameUnboundCase(api, reconciliationCase, payment);
    const chatIds = sent.map((s) => s.chatId);
    for (const owner of ownerTgIds) {
      expect(chatIds).toContain(owner.toString());
    }
    expect(chatIds).not.toContain(nonOwnerTgId.toString());
    const body = sent[0]?.text ?? "";
    expect(body).toContain("⚠️ مغایرت رزرو یوزرنیم سرویس");
    expect(body).toContain(SERVICE_UNBOUND_ADMIN_TEXT);
    expect(body).toContain(reconciliationCase.id.slice(0, 8));
    expect(body).toContain("ZARINPAL");
    // NEVER the duplicate-success alert, a raw username/note, reservation id or full UUID.
    expect(body).not.toContain("پرداخت موفق تکراری");
    expect(body).not.toContain(built.reservationId);
    expect(body).not.toContain("ORDER_BIND_NO_MATCH");
    expect(body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("retry-bind attaches the exact reservation and resolves the case (§4)", async () => {
    const built = await buildCase({ reservationStatus: ServiceUsernameReservationStatus.BOUND });
    expect(await hasBlockingServiceUsernameUnboundCase((await orderCheckout(built.orderId)))).toBe(true);
    const result = await retryBindServiceUsernameUnboundCase(built.caseId, adminIds[0]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.orderId).toBe(built.orderId);
    const reservation = await prisma.serviceUsernameReservation.findUniqueOrThrow({
      where: { id: built.reservationId },
    });
    expect(reservation.orderId).toBe(built.orderId);
    expect(reservation.status).toBe(ServiceUsernameReservationStatus.BOUND);
    const rc = await prisma.financialReconciliationCase.findUniqueOrThrow({ where: { id: built.caseId } });
    expect(rc.status).toBe("RESOLVED");
    expect(rc.resolvedByAdminId).toBe(adminIds[0]);
    expect(rc.resolvedAt).not.toBeNull();
    // The case no longer blocks provisioning once it is bound + resolved.
    expect(await hasBlockingServiceUsernameUnboundCase(await orderCheckout(built.orderId))).toBe(false);
  });

  it("retry-bind leaves the case blocking and NEVER resolves when the exact bind is impossible (§4)", async () => {
    // The reservation is RELEASED (its slot is gone) → the strict bind matches
    // nothing → the case must stay OPEN and keep blocking provisioning.
    const built = await buildCase({
      reservationStatus: ServiceUsernameReservationStatus.RELEASED,
    });
    const result = await retryBindServiceUsernameUnboundCase(built.caseId, adminIds[0]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("BIND_FAILED");
    const rc = await prisma.financialReconciliationCase.findUniqueOrThrow({ where: { id: built.caseId } });
    expect(rc.status).toBe("OPEN");
    expect(rc.resolvedByAdminId).toBeNull();
    const reservation = await prisma.serviceUsernameReservation.findUniqueOrThrow({
      where: { id: built.reservationId },
    });
    expect(reservation.orderId).toBeNull();
    expect(await hasBlockingServiceUsernameUnboundCase(await orderCheckout(built.orderId))).toBe(true);
  });

  it("concurrent retry presses resolve once and attach the reservation once (§4)", async () => {
    const built = await buildCase({ reservationStatus: ServiceUsernameReservationStatus.BOUND });
    const [a, b] = await Promise.all([
      retryBindServiceUsernameUnboundCase(built.caseId, adminIds[0]),
      retryBindServiceUsernameUnboundCase(built.caseId, adminIds[1]),
    ]);
    // Both converge on success (one binds, the other is idempotent) — never an error.
    expect(a.ok && b.ok).toBe(true);
    const resolvedCount = await prisma.financialReconciliationCase.count({
      where: { id: built.caseId, status: "RESOLVED" },
    });
    expect(resolvedCount).toBe(1);
    const reservation = await prisma.serviceUsernameReservation.findUniqueOrThrow({
      where: { id: built.reservationId },
    });
    // Attached to exactly the one order, uncorrupted.
    expect(reservation.orderId).toBe(built.orderId);
    expect(reservation.status).toBe(ServiceUsernameReservationStatus.BOUND);
  });

  it.runIf(hasRedis)(
    "direct provisionPaidOrder cannot bypass an OPEN case (§5) and creates no service",
    async () => {
      const built = await buildCase({
        reservationStatus: ServiceUsernameReservationStatus.BOUND,
        withNamingSnapshot: true,
      });
      const outcome = await provisionPaidOrder(built.orderId);
      expect(outcome.ok).toBe(false);
      expect(outcome.refunded).toBe(false);
      const service = await prisma.service.findFirst({ where: { orderId: built.orderId } });
      expect(service).toBeNull();
      // The order is untouched (still PAID) — money preserved for the retry-bind.
      const order = await prisma.order.findUniqueOrThrow({ where: { id: built.orderId } });
      expect(order.status).toBe("PAID");
    },
  );

  async function orderCheckout(orderId: string): Promise<string> {
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { checkoutSessionId: true },
    });
    return order.checkoutSessionId ?? "";
  }
});
