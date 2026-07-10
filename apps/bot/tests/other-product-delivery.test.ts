import { prisma, type Product, type User } from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ALREADY_DELIVERED_TEXT,
  DELIVERY_SEND_FAILED_TEXT,
  deliverManualOrder,
  getManualOrderByShortId,
  getPendingInfoOrderByShortId,
  initManualDelivery,
  listManualOrders,
  NOT_READY_TEXT,
  submitUserInfo,
} from "../src/services/other-product-delivery.service.js";

// =============================================================================
// Phase 23 manual-delivery integration tests (OTHER_PRODUCT). Uses the shared
// disposable PostgreSQL (docs/testing.md); skips without DATABASE_URL. The
// receipt-approval dispatch and Telegram handlers are covered by code review;
// everything stateful lives in other-product-delivery.service and is tested
// here with a recording send mock.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

let infoProduct: Product;
let plainProduct: Product;
let adminId: string;

function sendRecorder(failAll = false) {
  const calls: Array<{ chatId: string; text: string }> = [];
  return {
    calls,
    api: {
      sendMessage: async (chatId: string, text: string): Promise<unknown> => {
        if (failAll) {
          throw new Error("blocked");
        }
        calls.push({ chatId, text });
        return {};
      },
    },
  };
}

async function createUser(): Promise<User> {
  return prisma.user.create({
    data: { telegramId: runTag + BigInt(Math.floor(Math.random() * 1_000_000)) },
  });
}

async function createPaidOrder(user: User, product: Product) {
  return prisma.order.create({
    data: {
      userId: user.id,
      type: "OTHER_PRODUCT",
      status: "PAID",
      productId: product.id,
      finalPriceToman: product.priceToman,
      originalPriceToman: product.priceToman,
      productNameSnapshot: product.name,
      paidAt: new Date(),
    },
  });
}

describe.runIf(hasDb)("OTHER_PRODUCT manual delivery (Phase 23)", () => {
  beforeAll(async () => {
    const category = await prisma.productCategory.create({
      data: { type: "OTHER_PRODUCT", name: `p23-cat-${runTag}`, isActive: true },
    });
    infoProduct = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId: category.id,
        name: `p23-apple-id-${runTag}`,
        priceToman: 250_000,
        isActive: true,
        deliveryType: "MANUAL_ADMIN",
        requiredUserInfoEnabled: true,
        requiredUserInfoPromptText: "ایمیل مورد نظر برای Apple ID را بفرستید.",
      },
    });
    plainProduct = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId: category.id,
        name: `p23-giftcard-${runTag}`,
        priceToman: 100_000,
        isActive: true,
        deliveryType: "MANUAL_ADMIN",
        requiredUserInfoEnabled: false,
      },
    });
    const admin = await prisma.admin.create({
      data: { telegramId: runTag + 900_000_000n, role: "OWNER", isActive: true },
    });
    adminId = admin.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("init: no-info product is ready immediately; info product waits for the user; idempotent", async () => {
    const user = await createUser();
    const plainOrder = await createPaidOrder(user, plainProduct);
    const infoOrder = await createPaidOrder(user, infoProduct);

    const plainInit = await initManualDelivery(plainOrder.id);
    expect(plainInit.ok && plainInit.created).toBe(true);
    if (plainInit.ok) {
      expect(plainInit.record.status).toBe("WAITING_ADMIN_DELIVERY");
      expect(plainInit.requiresInfo).toBe(false);
    }

    const infoInit = await initManualDelivery(infoOrder.id);
    expect(infoInit.ok && infoInit.created).toBe(true);
    if (infoInit.ok) {
      expect(infoInit.record.status).toBe("WAITING_USER_INFO");
      expect(infoInit.requiresInfo).toBe(true);
      expect(infoInit.promptText).toContain("Apple ID");
    }

    // Idempotent: a repeated approval returns the existing record.
    const again = await initManualDelivery(infoOrder.id);
    expect(again.ok).toBe(true);
    if (again.ok && infoInit.ok) {
      expect(again.created).toBe(false);
      expect(again.record.id).toBe(infoInit.record.id);
    }
    expect(await prisma.otherProductOrder.count({ where: { orderId: infoOrder.id } })).toBe(1);

    // Never a Service, never provisioning.
    expect(await prisma.service.count({ where: { userId: user.id } })).toBe(0);
  });

  it("user info: owner-scoped resume button, validated storage, single transition", async () => {
    const user = await createUser();
    const stranger = await createUser();
    const order = await createPaidOrder(user, infoProduct);
    const init = await initManualDelivery(order.id);
    expect(init.ok).toBe(true);
    if (!init.ok) return;

    const sid = order.id.slice(0, 8);
    expect((await getPendingInfoOrderByShortId(sid, user.id))?.id).toBe(init.record.id);
    expect(await getPendingInfoOrderByShortId(sid, stranger.id)).toBeNull();

    const tooLong = await submitUserInfo(user.id, init.record.id, "x".repeat(2001));
    expect(tooLong.ok).toBe(false);
    const foreign = await submitUserInfo(stranger.id, init.record.id, "hijack@example.com");
    expect(foreign.ok).toBe(false);

    const saved = await submitUserInfo(user.id, init.record.id, "  someone@icloud.com  ");
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(saved.record.userProvidedInfoText).toBe("someone@icloud.com");
      expect(saved.record.status).toBe("WAITING_ADMIN_DELIVERY");
    }
    // The record left WAITING_USER_INFO: the button no longer resolves and a
    // second submit cannot overwrite.
    expect(await getPendingInfoOrderByShortId(sid, user.id)).toBeNull();
    expect((await submitUserInfo(user.id, init.record.id, "other@x.com")).ok).toBe(false);
  });

  it("delivery: sends, marks DELIVERED + Order COMPLETED, refuses repeats and not-ready", async () => {
    const user = await createUser();
    const order = await createPaidOrder(user, plainProduct);
    const init = await initManualDelivery(order.id);
    expect(init.ok).toBe(true);
    if (!init.ok) return;

    // Not-ready guard: an info-waiting record cannot be delivered.
    const infoOrder = await createPaidOrder(user, infoProduct);
    const infoInit = await initManualDelivery(infoOrder.id);
    if (infoInit.ok) {
      const early = await deliverManualOrder(sendRecorder().api, {
        recordId: infoInit.record.id,
        adminId,
        deliveryText: "زود است",
      });
      expect(!early.ok && early.safeMessage === NOT_READY_TEXT).toBe(true);
    }

    const { api, calls } = sendRecorder();
    const delivered = await deliverManualOrder(api, {
      recordId: init.record.id,
      adminId,
      deliveryText: "کد گیفت کارت: ABCD-1234",
    });
    expect(delivered.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].chatId).toBe(user.telegramId.toString());
    expect(calls[0].text).toContain("سفارش شما آماده شد ✅");
    expect(calls[0].text).toContain(plainProduct.name);
    expect(calls[0].text).toContain("کد گیفت کارت: ABCD-1234");

    const record = await prisma.otherProductOrder.findUniqueOrThrow({
      where: { id: init.record.id },
    });
    expect(record.status).toBe("DELIVERED");
    expect(record.adminDeliveryText).toBe("کد گیفت کارت: ABCD-1234");
    expect(record.deliveredByAdminId).toBe(adminId);
    expect(record.deliveredAt).not.toBeNull();
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe("COMPLETED");

    // Double delivery refused, and the user is NOT messaged again.
    const again = await deliverManualOrder(api, {
      recordId: init.record.id,
      adminId,
      deliveryText: "دوباره",
    });
    expect(!again.ok && again.safeMessage === ALREADY_DELIVERED_TEXT).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("failed send rolls back the claim and the order stays deliverable", async () => {
    const user = await createUser();
    const order = await createPaidOrder(user, plainProduct);
    const init = await initManualDelivery(order.id);
    expect(init.ok).toBe(true);
    if (!init.ok) return;

    const blocked = await deliverManualOrder(sendRecorder(true).api, {
      recordId: init.record.id,
      adminId,
      deliveryText: "این پیام نمی‌رسد",
    });
    expect(!blocked.ok && blocked.safeMessage === DELIVERY_SEND_FAILED_TEXT).toBe(true);
    const record = await prisma.otherProductOrder.findUniqueOrThrow({
      where: { id: init.record.id },
    });
    expect(record.status).toBe("WAITING_ADMIN_DELIVERY");
    // The claim fields were rolled back - nothing lingers.
    expect(record.adminDeliveryText).toBeNull();
    expect(record.deliveredByAdminId).toBeNull();
    expect(record.deliveredAt).toBeNull();
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe("PAID");

    // Still listed as open, resolvable by short id...
    const page = await listManualOrders(1);
    expect(page.records.some((r) => r.id === init.record.id)).toBe(true);
    expect((await getManualOrderByShortId(init.record.id.slice(0, 8)))?.id).toBe(init.record.id);

    // ...and a later delivery succeeds normally after the rollback.
    const { api, calls } = sendRecorder();
    const retried = await deliverManualOrder(api, {
      recordId: init.record.id,
      adminId,
      deliveryText: "این بار می‌رسد",
    });
    expect(retried.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(
      (await prisma.otherProductOrder.findUniqueOrThrow({ where: { id: init.record.id } })).status,
    ).toBe("DELIVERED");
  });

  it("concurrent deliveries send exactly ONE message (atomic claim)", async () => {
    const user = await createUser();
    const order = await createPaidOrder(user, plainProduct);
    const init = await initManualDelivery(order.id);
    expect(init.ok).toBe(true);
    if (!init.ok) return;

    const { api, calls } = sendRecorder();
    const [r1, r2] = await Promise.all([
      deliverManualOrder(api, {
        recordId: init.record.id,
        adminId,
        deliveryText: "تحویل از ادمین اول",
      }),
      deliverManualOrder(api, {
        recordId: init.record.id,
        adminId,
        deliveryText: "تحویل از ادمین دوم",
      }),
    ]);

    // Exactly one winner, exactly one user message - never a double send.
    const oks = [r1, r2].filter((r) => r.ok);
    const fails = [r1, r2].filter(
      (r): r is { ok: false; error: string; safeMessage: string } => !r.ok,
    );
    expect(oks).toHaveLength(1);
    expect(fails).toHaveLength(1);
    expect([ALREADY_DELIVERED_TEXT, NOT_READY_TEXT]).toContain(fails[0].safeMessage);
    expect(calls).toHaveLength(1);
    expect(calls[0].chatId).toBe(user.telegramId.toString());

    const record = await prisma.otherProductOrder.findUniqueOrThrow({
      where: { id: init.record.id },
    });
    expect(record.status).toBe("DELIVERED");
    expect(record.deliveredAt).not.toBeNull();
    // The stored text belongs to the winning claim (matches the sent message).
    expect(calls[0].text).toContain(record.adminDeliveryText ?? "");
    expect(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    ).toBe("COMPLETED");
  });
});

describe.skipIf(hasDb)("OTHER_PRODUCT manual delivery (skipped)", () => {
  it("manual delivery integration tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
