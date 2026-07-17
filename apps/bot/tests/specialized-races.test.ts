import { randomUUID } from "node:crypto";

import {
  prisma,
  type Admin,
  type CheckoutSession,
  type Order,
  type Product,
  type User,
} from "@zedbot/database";
import { decryptSecret } from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "specialized-races-tests-secret-001";

import {
  getOrCreateCheckoutInput,
  submitCheckoutInput,
} from "../src/services/checkout-customer-input.service.js";
import { createCheckoutSession } from "../src/services/checkout.service.js";
import { TELEGRAM_PREMIUM_DEFAULT_SCHEMA } from "../src/services/customer-input-schema.service.js";
import { settleGatewayPayment } from "../src/services/gateway-payment.service.js";
import { dispatchPaidOrderFulfillment } from "../src/services/order-fulfillment.service.js";
import { readFulfillmentSnapshot } from "../src/services/other-product-profile.service.js";
import { addStockItem } from "../src/services/other-product-stock.service.js";
import { approveReceiptPayment } from "../src/services/receipt-review.service.js";
import {
  AWAITING_STOCK_ADMIN_TITLE,
  AWAITING_STOCK_USER_TEXT,
  fulfillSpecializedOtherProduct,
  onCustomerInputCompleted,
} from "../src/services/specialized-product-fulfillment.service.js";

// =============================================================================
// Specialized-workflows phase - §13 race matrix. Every guarantee here is
// DB-backed (CAS flips + unique constraints), so true concurrency via
// Promise.all must converge: approval vs form submission, mass duplicate
// submissions, mass duplicate fulfillment dispatches, repeated approvals,
// two buyers on the last stock item and gateway settlement replay.
// Requires the shared test PostgreSQL (docs/testing.md); cleans up fixtures.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

const ADMIN_READY_MARKER = "سفارش دستی جدید 📦";
const PRICE = 200_000;

let admin: Admin;
let categoryId: string;
let premiumProduct: Product;
let appleProduct: Product;
let giftProduct: Product;

const userIds: string[] = [];

function sendRecorder() {
  const calls: Array<{ chatId: string; text: string; other?: Record<string, unknown> }> = [];
  return {
    calls,
    textsTo(chatId: string): string[] {
      return calls.filter((c) => c.chatId === chatId).map((c) => c.text);
    },
    api: {
      sendMessage: async (
        chatId: string,
        text: string,
        other?: Record<string, unknown>,
      ): Promise<unknown> => {
        calls.push({ chatId, text, other });
        return {};
      },
    },
  };
}

async function createUser(): Promise<User> {
  seq += 1;
  const user = await prisma.user.create({ data: { telegramId: runTag + BigInt(seq) } });
  userIds.push(user.id);
  return user;
}

async function createCheckout(user: User, product: Product): Promise<CheckoutSession> {
  const withRelations = await prisma.product.findUniqueOrThrow({
    where: { id: product.id },
    include: { category: true, panel: true },
  });
  return createCheckoutSession(user, withRelations, {
    productId: product.id,
    categoryId,
    flowType: "OTHER_PRODUCT",
    originalPriceToman: product.priceToman,
    discountAmountToman: 0,
    finalPriceToman: product.priceToman,
    draftNonce: randomUUID(),
  });
}

/** A PAID order settled against its checkout (mimics a completed settlement). */
async function createPaidOrder(
  user: User,
  product: Product,
): Promise<{ checkout: CheckoutSession; order: Order }> {
  const checkout = await createCheckout(user, product);
  await prisma.checkoutSession.update({
    where: { id: checkout.id },
    data: { status: "PAID", paidAt: new Date() },
  });
  const order = await prisma.order.create({
    data: {
      userId: user.id,
      checkoutSessionId: checkout.id,
      type: "OTHER_PRODUCT",
      status: "PAID",
      productId: product.id,
      finalPriceToman: product.priceToman,
      paidAt: new Date(),
    },
  });
  return { checkout, order };
}

/** A PENDING_REVIEW card-to-card payment fixture (matches submitReceipt). */
async function createReceiptPayment(user: User, checkout: CheckoutSession): Promise<string> {
  const payment = await prisma.payment.create({
    data: {
      userId: user.id,
      checkoutSessionId: checkout.id,
      purpose: "ORDER_PAYMENT",
      status: "PENDING_REVIEW",
      amountToman: checkout.finalPriceToman,
      payableAmountToman: checkout.finalPriceToman,
      receipts: {
        create: { userId: user.id, text: "race receipt", status: "PENDING_REVIEW" },
      },
    },
  });
  return payment.id;
}

const PREMIUM_VALUES = {
  telegram_account: "race_target",
  requested_identifier: "",
  customer_note: "",
};

describe.runIf(hasDb)("specialized workflows race matrix (§13)", () => {
  beforeAll(async () => {
    const category = await prisma.productCategory.create({
      data: { type: "OTHER_PRODUCT", name: `spr-cat-${runTag}`, isActive: true },
    });
    categoryId = category.id;
    admin = await prisma.admin.create({
      data: { telegramId: runTag + 930_000_000n, role: "OWNER", isActive: true },
    });
    premiumProduct = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId,
        name: `spr-premium-${runTag}`,
        priceToman: PRICE,
        isActive: true,
        deliveryType: "MANUAL_ADMIN",
        otherProductKind: "TELEGRAM_PREMIUM",
        otherProductFulfillmentProfile: "PERSONALIZED_SERVICE",
        requiredUserInfoEnabled: true,
        collectInfoBeforeManualApproval: true,
        customerInputSchema: JSON.parse(JSON.stringify(TELEGRAM_PREMIUM_DEFAULT_SCHEMA)),
      },
    });
    appleProduct = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId,
        name: `spr-apple-${runTag}`,
        priceToman: PRICE,
        isActive: true,
        deliveryType: "STOCK_ITEM",
        stockEnabled: true,
        otherProductKind: "APPLE_ID",
        otherProductFulfillmentProfile: "STOCK_CREDENTIAL",
        otherProductStockParser: "EMAIL_BOUNDARY",
      },
    });
    giftProduct = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId,
        name: `spr-gift-${runTag}`,
        priceToman: PRICE,
        isActive: true,
        deliveryType: "STOCK_ITEM",
        stockEnabled: true,
        otherProductKind: "GIFT_CARD",
        otherProductFulfillmentProfile: "STOCK_CODE",
        otherProductStockParser: "SINGLE_LINE",
      },
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const users = { userId: { in: userIds } };
    await prisma.checkoutSession.updateMany({ where: users, data: { settledByPaymentId: null } });
    await prisma.order.updateMany({ where: users, data: { paymentId: null } });
    await prisma.payment.updateMany({ where: users, data: { orderId: null } });
    const logs = await prisma.systemLog.findMany({
      where: { OR: [{ userId: { in: userIds } }, { adminId: admin.id }] },
      select: { id: true },
    });
    await prisma.systemLogDelivery.deleteMany({
      where: { systemLogId: { in: logs.map((l) => l.id) } },
    });
    await prisma.systemLog.deleteMany({ where: { id: { in: logs.map((l) => l.id) } } });
    await prisma.manualReceipt.deleteMany({ where: users });
    await prisma.checkoutCustomerInput.deleteMany({ where: users });
    await prisma.otherProductOrder.deleteMany({ where: users });
    await prisma.otherProductStockItem.deleteMany({
      where: { productId: { in: [appleProduct.id, giftProduct.id] } },
    });
    await prisma.payment.deleteMany({ where: users });
    await prisma.order.deleteMany({ where: users });
    await prisma.checkoutSession.deleteMany({ where: users });
    await prisma.product.deleteMany({ where: { categoryId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma.admin.deleteMany({ where: { id: admin.id } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it(
    "1. approval racing the final form submission converges: one order, one consume, one notify",
    { timeout: 30_000 },
    async () => {
      const user = await createUser();
      const checkout = await createCheckout(user, premiumProduct);
      const paymentId = await createReceiptPayment(user, checkout);
      const input = await getOrCreateCheckoutInput(
        checkout.id,
        user.id,
        TELEGRAM_PREMIUM_DEFAULT_SCHEMA,
      );
      expect(input?.status).toBe("COLLECTING");

      const recorder = sendRecorder();
      const approvalSide = (async () => {
        const result = await approveReceiptPayment(paymentId, admin);
        if (result.ok && result.kind === "ORDER_PAYMENT") {
          await dispatchPaidOrderFulfillment(recorder.api, result.order.id, {
            source: "RECEIPT",
          });
        }
        return result;
      })();
      const submissionSide = (async () => {
        const submit = await submitCheckoutInput(checkout.id, user.id, PREMIUM_VALUES);
        // The confirm handler's post-submit bridge: hand off when the order
        // (and its fulfillment record) already exists.
        const order = await prisma.order.findUnique({
          where: { checkoutSessionId: checkout.id },
          include: { otherProductOrder: true },
        });
        if (order !== null && order.otherProductOrder !== null) {
          await onCustomerInputCompleted(recorder.api, order.id);
        }
        return submit;
      })();
      const [approval, submission] = await Promise.all([approvalSide, submissionSide]);
      expect(approval.ok).toBe(true);
      expect(submission.ok).toBe(true);

      // Production convergence step: the next idempotent bridge/dispatch pass
      // (settlement sweep or the user's next form interaction) finishes any
      // interleaving where the dispatch ran before the submission landed.
      const order = await prisma.order.findUniqueOrThrow({
        where: { checkoutSessionId: checkout.id },
      });
      await onCustomerInputCompleted(recorder.api, order.id);

      expect(await prisma.order.count({ where: { userId: user.id } })).toBe(1);
      const record = await prisma.otherProductOrder.findUniqueOrThrow({
        where: { orderId: order.id },
      });
      expect(record.status).toBe("WAITING_ADMIN_DELIVERY");
      expect(record.customerInputEncrypted).not.toBeNull();

      // Consumed exactly once, by exactly this record.
      const finalInput = await prisma.checkoutCustomerInput.findUniqueOrThrow({
        where: { checkoutSessionId: checkout.id },
      });
      expect(finalInput.status).toBe("CONSUMED");
      expect(finalInput.consumedByOtherProductOrderId).toBe(record.id);

      const adminReady = recorder
        .textsTo(admin.telegramId.toString())
        .filter((t) => t.includes(ADMIN_READY_MARKER));
      expect(adminReady).toHaveLength(1);
    },
  );

  it(
    "2. 20 concurrent submitCheckoutInput calls: one fresh SUBMITTED win, the rest converge",
    { timeout: 30_000 },
    async () => {
      const user = await createUser();
      const checkout = await createCheckout(user, premiumProduct);
      await getOrCreateCheckoutInput(checkout.id, user.id, TELEGRAM_PREMIUM_DEFAULT_SCHEMA);

      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          submitCheckoutInput(checkout.id, user.id, PREMIUM_VALUES),
        ),
      );
      expect(results.every((r) => r.ok)).toBe(true);
      const freshWins = results.filter((r) => r.ok && !r.already);
      expect(freshWins).toHaveLength(1);

      const row = await prisma.checkoutCustomerInput.findUniqueOrThrow({
        where: { checkoutSessionId: checkout.id },
      });
      expect(row.status).toBe("SUBMITTED");
      expect(row.valuesEncrypted).not.toBeNull();
      expect(await prisma.checkoutCustomerInput.count({ where: { userId: user.id } })).toBe(1);
      // Still ZERO financial side effects, no matter how many confirms raced.
      expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0);
    },
  );

  it(
    "3. 20 concurrent fulfillment dispatches for one paid APPLE_ID order: exactly one item consumed",
    { timeout: 30_000 },
    async () => {
      const item = await addStockItem({
        productId: appleProduct.id,
        content: `apple-cred-${runTag}\npass: race-secret-${runTag}`,
        label: null,
        createdByAdminId: admin.id,
      });
      expect(item.ok).toBe(true);
      const spare = await addStockItem({
        productId: appleProduct.id,
        content: `apple-spare-${runTag}\npass: spare-secret-${runTag}`,
        label: null,
        createdByAdminId: admin.id,
      });
      expect(spare.ok).toBe(true);

      const user = await createUser();
      const { checkout, order } = await createPaidOrder(user, appleProduct);
      const snapshot = await readFulfillmentSnapshot(checkout);
      expect(snapshot.kind).toBe("APPLE_ID");

      const recorder = sendRecorder();
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          fulfillSpecializedOtherProduct(recorder.api, order, snapshot, {}),
        ),
      );
      expect(results.every((r) => r !== null)).toBe(true);

      // DB-guaranteed: at most one stock item can ever bind to the order.
      const bound = await prisma.otherProductStockItem.findMany({
        where: { deliveredOrderId: order.id },
      });
      expect(bound).toHaveLength(1);
      expect(bound[0].status).toBe("DELIVERED");
      const deliveredContent = decryptSecret(bound[0].contentEncrypted);

      // The spare item was never consumed and its content never sent.
      const spareRow = await prisma.otherProductStockItem.findUniqueOrThrow({
        where: { id: spare.ok ? spare.item.id : "" },
      });
      expect(spareRow.status).toBe("AVAILABLE");
      const spareContent = decryptSecret(spareRow.contentEncrypted);
      expect(recorder.calls.some((c) => c.text.includes(spareContent))).toBe(false);

      // Credential sends: every one carries THE single delivered item and
      // goes to the buying user ONLY. (The documented resume window means a
      // concurrent duplicate dispatch may repeat the SAME credential to the
      // same buyer - never a second item, never another user's chat - so the
      // count is >= 1, not == 1.)
      const credentialSends = recorder.calls.filter((c) => c.text.includes(deliveredContent));
      expect(credentialSends.length).toBeGreaterThanOrEqual(1);
      expect(credentialSends.every((c) => c.chatId === user.telegramId.toString())).toBe(true);

      const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(finalOrder.status).toBe("COMPLETED");
      expect(await prisma.otherProductOrder.count({ where: { orderId: order.id } })).toBe(1);
      const record = await prisma.otherProductOrder.findUniqueOrThrow({
        where: { orderId: order.id },
      });
      expect(record.status).toBe("DELIVERED");
    },
  );

  it(
    "4. repeated approveReceiptPayment (5 concurrent + 5 sequential): exactly one Order",
    { timeout: 30_000 },
    async () => {
      const user = await createUser();
      const checkout = await createCheckout(user, premiumProduct);
      const paymentId = await createReceiptPayment(user, checkout);

      const concurrent = await Promise.all(
        Array.from({ length: 5 }, () => approveReceiptPayment(paymentId, admin)),
      );
      expect(concurrent.filter((r) => r.ok)).toHaveLength(1);

      for (let i = 0; i < 5; i += 1) {
        const repeat = await approveReceiptPayment(paymentId, admin);
        expect(repeat.ok).toBe(false);
      }

      expect(await prisma.order.count({ where: { userId: user.id } })).toBe(1);
      expect(await prisma.payment.count({ where: { userId: user.id, status: "APPROVED" } })).toBe(
        1,
      );
      const finalCheckout = await prisma.checkoutSession.findUniqueOrThrow({
        where: { id: checkout.id },
      });
      expect(finalCheckout.status).toBe("PAID");
    },
  );

  it(
    "5. two buyers racing for the LAST stock item: one DELIVERED, one AWAITING_STOCK, no shared code",
    { timeout: 30_000 },
    async () => {
      const item = await addStockItem({
        productId: giftProduct.id,
        content: `GIFT-LAST-${runTag}`,
        label: null,
        createdByAdminId: admin.id,
      });
      expect(item.ok).toBe(true);

      const userA = await createUser();
      const userB = await createUser();
      const a = await createPaidOrder(userA, giftProduct);
      const b = await createPaidOrder(userB, giftProduct);

      const recorder = sendRecorder();
      await Promise.all([
        dispatchPaidOrderFulfillment(recorder.api, a.order.id, { source: "WALLET" }),
        dispatchPaidOrderFulfillment(recorder.api, b.order.id, { source: "WALLET" }),
      ]);

      const delivered = await prisma.otherProductStockItem.findMany({
        where: { productId: giftProduct.id, status: "DELIVERED" },
      });
      expect(delivered).toHaveLength(1);
      const winnerOrderId = delivered[0].deliveredOrderId;
      expect([a.order.id, b.order.id]).toContain(winnerOrderId);
      const winner = winnerOrderId === a.order.id ? a : b;
      const loser = winnerOrderId === a.order.id ? b : a;
      const winnerUser = winnerOrderId === a.order.id ? userA : userB;
      const loserUser = winnerOrderId === a.order.id ? userB : userA;

      const winnerRecord = await prisma.otherProductOrder.findUniqueOrThrow({
        where: { orderId: winner.order.id },
      });
      expect(winnerRecord.status).toBe("DELIVERED");
      const loserRecord = await prisma.otherProductOrder.findUniqueOrThrow({
        where: { orderId: loser.order.id },
      });
      expect(loserRecord.status).toBe("AWAITING_STOCK");
      expect(loserRecord.awaitingStockSince).not.toBeNull();

      expect(
        (await prisma.order.findUniqueOrThrow({ where: { id: winner.order.id } })).status,
      ).toBe("COMPLETED");
      expect((await prisma.order.findUniqueOrThrow({ where: { id: loser.order.id } })).status).toBe(
        "PAID",
      );

      // The code reached ONLY the winner; the loser was parked and told so.
      const code = `GIFT-LAST-${runTag}`;
      const codeSends = recorder.calls.filter((c) => c.text.includes(code));
      expect(codeSends).toHaveLength(1);
      expect(codeSends[0].chatId).toBe(winnerUser.telegramId.toString());
      expect(
        recorder.textsTo(loserUser.telegramId.toString()).some((t) =>
          t.includes(AWAITING_STOCK_USER_TEXT),
        ),
      ).toBe(true);
      // Exactly one awaiting-stock admin alert (CAS on the loser's record).
      expect(
        recorder
          .textsTo(admin.telegramId.toString())
          .filter((t) => t.includes(AWAITING_STOCK_ADMIN_TITLE)),
      ).toHaveLength(1);
    },
  );

  it(
    "6. gateway settlement replay converges: one settle, one already, one order, one delivery",
    { timeout: 30_000 },
    async () => {
      const stocked = await addStockItem({
        productId: giftProduct.id,
        content: `GIFT-REPLAY-${runTag}`,
        label: null,
        createdByAdminId: admin.id,
      });
      expect(stocked.ok).toBe(true);

      const user = await createUser();
      const checkout = await createCheckout(user, giftProduct);
      seq += 1;
      const payment = await prisma.payment.create({
        data: {
          userId: user.id,
          checkoutSessionId: checkout.id,
          purpose: "ORDER_PAYMENT",
          status: "PENDING",
          amountToman: checkout.finalPriceToman,
          payableAmountToman: checkout.finalPriceToman,
          provider: "ZARINPAL",
          authority: `spr-${runTag}-${seq}`,
          providerStatus: "SUCCESS",
          verifiedAt: new Date(),
          externalTransactionId: `spr-ext-${runTag}-${seq}`,
          idempotencyKey: `spr:${checkout.id}:${seq}`,
        },
      });

      const first = await settleGatewayPayment(payment.id);
      expect(first.kind).toBe("settled");
      const second = await settleGatewayPayment(payment.id);
      expect(second.kind).toBe("already");

      expect(await prisma.order.count({ where: { userId: user.id } })).toBe(1);
      const order = await prisma.order.findFirstOrThrow({ where: { userId: user.id } });

      const recorder = sendRecorder();
      await dispatchPaidOrderFulfillment(recorder.api, order.id, { source: "GATEWAY" });
      await dispatchPaidOrderFulfillment(recorder.api, order.id, { source: "GATEWAY" });
      expect(
        await prisma.otherProductStockItem.count({ where: { deliveredOrderId: order.id } }),
      ).toBe(1);
      const codeSends = recorder.calls.filter((c) => c.text.includes(`GIFT-REPLAY-${runTag}`));
      expect(codeSends).toHaveLength(1);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
        "COMPLETED",
      );
    },
  );
});

describe.skipIf(hasDb)("specialized workflows race matrix (skipped)", () => {
  it("requires DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
