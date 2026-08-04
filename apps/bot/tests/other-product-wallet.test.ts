import { randomUUID } from "node:crypto";

import { prisma, type Admin, type Product, type User } from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "other-product-wallet-tests-0001";

import type { CheckoutDraft } from "../src/core/session.js";
import {
  settleGatewayPayment,
} from "../src/services/gateway-payment.service.js";
import {
  fulfillSettledGatewayOrder,
} from "../src/services/gateway-settlement-runner.service.js";
import {
  dispatchPaidOrderFulfillment,
  fulfillmentConfirmationLine,
  INFO_REQUIRED_FOLLOWUP_TEXT,
  WAITING_FOR_DELIVERY_TEXT,
} from "../src/services/order-fulfillment.service.js";
import { submitUserInfo, notifyAdminsAboutManualOrder } from "../src/services/other-product-delivery.service.js";
import { addStockItem } from "../src/services/other-product-stock.service.js";
import {
  approveReceiptPayment,
  rejectReceiptPayment,
} from "../src/services/receipt-review.service.js";
import {
  INSUFFICIENT_BALANCE_TEXT,
  payPurchaseDraftWithWallet,
  WALLET_ORDER_PAYMENT_REASON,
} from "../src/services/wallet-payment.service.js";

// =============================================================================
// OTHER_PRODUCT wallet payment + unified post-payment fulfillment
// (other-product-wallet phase). Wallet / card-to-card receipt / gateway all
// converge on dispatchPaidOrderFulfillment - these tests prove the money
// invariants (one deduction, one Payment, one Order, one SPEND row, one
// OtherProductOrder), the required-information state machine, the stock path
// and the idempotency of repeated dispatches.
//
// Requires real PostgreSQL (docs/testing.md); skips without DATABASE_URL.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

const ADMIN_READY_MARKER = "سفارش دستی جدید 📦";
const WALLET_INFO_TEXT = `${fulfillmentConfirmationLine("WALLET")}\n\n${INFO_REQUIRED_FOLLOWUP_TEXT}`;
const WALLET_WAIT_TEXT = `${fulfillmentConfirmationLine("WALLET")}\n\n${WAITING_FOR_DELIVERY_TEXT}`;
const RECEIPT_INFO_TEXT = `${fulfillmentConfirmationLine("RECEIPT")}\n\n${INFO_REQUIRED_FOLLOWUP_TEXT}`;
const GATEWAY_INFO_TEXT = `${fulfillmentConfirmationLine("GATEWAY")}\n\n${INFO_REQUIRED_FOLLOWUP_TEXT}`;

const PROMPT = "ایمیل و رمز دلخواه برای اکانت را ارسال کنید.";

let categoryId: string;
let admin: Admin;
let infoProduct: Product;
let plainProduct: Product;
let stockProduct: Product;

function sendRecorder() {
  const calls: Array<{ chatId: string; text: string; other?: Record<string, unknown> }> = [];
  return {
    calls,
    textsTo(chatId: string): string[] {
      return calls.filter((c) => c.chatId === chatId).map((c) => c.text);
    },
    countMatching(marker: string): number {
      return calls.filter((c) => c.text.includes(marker)).length;
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

async function createUser(balanceToman = 0): Promise<User> {
  seq += 1;
  return prisma.user.create({
    data: { telegramId: runTag + BigInt(seq), balanceToman },
  });
}

function draftFor(product: Product): CheckoutDraft {
  return {
    productId: product.id,
    categoryId,
    flowType: "OTHER_PRODUCT",
    originalPriceToman: product.priceToman,
    discountAmountToman: 0,
    finalPriceToman: product.priceToman,
    draftNonce: randomUUID(),
  };
}

/** A PENDING_REVIEW card-to-card ORDER_PAYMENT (checkout + payment + receipt). */
async function createReceiptPayment(user: User, product: Product): Promise<string> {
  const checkout = await prisma.checkoutSession.create({
    data: {
      userId: user.id,
      purpose: "ORDER_PAYMENT",
      orderType: "OTHER_PRODUCT",
      productId: product.id,
      productSnapshot: {
        productType: "OTHER_PRODUCT",
        productName: product.name,
        originalPriceToman: product.priceToman,
      },
      originalPriceToman: product.priceToman,
      discountAmountToman: 0,
      finalPriceToman: product.priceToman,
      status: "PENDING",
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  const payment = await prisma.payment.create({
    data: {
      userId: user.id,
      checkoutSessionId: checkout.id,
      purpose: "ORDER_PAYMENT",
      status: "PENDING_REVIEW",
      amountToman: product.priceToman,
      payableAmountToman: product.priceToman,
      receipts: {
        create: { userId: user.id, text: "card receipt", status: "PENDING_REVIEW" },
      },
    },
  });
  return payment.id;
}

/** A gateway payment with recorded provider SUCCESS, ready to settle. */
async function createGatewaySuccess(user: User, product: Product): Promise<string> {
  seq += 1;
  const checkout = await prisma.checkoutSession.create({
    data: {
      userId: user.id,
      purpose: "ORDER_PAYMENT",
      orderType: "OTHER_PRODUCT",
      productId: product.id,
      productSnapshot: {
        productType: "OTHER_PRODUCT",
        productName: product.name,
        originalPriceToman: product.priceToman,
      },
      originalPriceToman: product.priceToman,
      discountAmountToman: 0,
      finalPriceToman: product.priceToman,
      status: "PENDING",
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  const payment = await prisma.payment.create({
    data: {
      userId: user.id,
      checkoutSessionId: checkout.id,
      purpose: "ORDER_PAYMENT",
      status: "PENDING",
      amountToman: product.priceToman,
      payableAmountToman: product.priceToman,
      provider: "ZARINPAL",
      authority: `opw-${runTag}-${seq}`,
      providerStatus: "SUCCESS",
      verifiedAt: new Date(),
      externalTransactionId: `opw-ext-${runTag}-${seq}`,
      idempotencyKey: `opw:${checkout.id}:${seq}`,
    },
  });
  return payment.id;
}

describe.runIf(hasDb)("OTHER_PRODUCT wallet payment + unified fulfillment", () => {
  beforeAll(async () => {
    const category = await prisma.productCategory.create({
      data: { type: "OTHER_PRODUCT", name: `opw-cat-${runTag}`, isActive: true },
    });
    categoryId = category.id;
    admin = await prisma.admin.create({
      data: { telegramId: runTag + 800_000_000n, role: "OWNER", isActive: true },
    });
    infoProduct = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId,
        name: `opw-apple-${runTag}`,
        priceToman: 120_000,
        isActive: true,
        deliveryType: "MANUAL_ADMIN",
        requiredUserInfoEnabled: true,
        requiredUserInfoPromptText: PROMPT,
      },
    });
    plainProduct = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId,
        name: `opw-gift-${runTag}`,
        priceToman: 80_000,
        isActive: true,
        deliveryType: "MANUAL_ADMIN",
        requiredUserInfoEnabled: false,
      },
    });
    stockProduct = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId,
        name: `opw-stock-${runTag}`,
        priceToman: 60_000,
        isActive: true,
        deliveryType: "STOCK_ITEM",
        stockEnabled: true,
        requiredUserInfoEnabled: false,
      },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("1. wallet + required info: exact money rows, WAITING_USER_INFO, prompt sent, no premature admin alert", async () => {
    const user = await createUser(200_000);
    const result = await payPurchaseDraftWithWallet(user, draftFor(infoProduct));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.alreadyPaid).toBe(false);

    // Money invariants: one deduction, one APPROVED wallet Payment, one PAID
    // OTHER_PRODUCT Order, one SPEND ledger row, settled checkout.
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(fresh.balanceToman).toBe(200_000 - 120_000);
    expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(1);
    expect(result.payment.status).toBe("APPROVED");
    expect(result.payment.purpose).toBe("PAY_WITH_WALLET");
    expect((result.payment.callbackPayload as Record<string, unknown>).method).toBe("WALLET");
    expect(result.payment.checkoutSessionId).toBe(result.checkout.id);
    expect(result.payment.orderId).toBe(result.order.id);
    expect(result.order.type).toBe("OTHER_PRODUCT");
    expect(result.order.status).toBe("PAID");
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(1);
    expect(
      await prisma.walletTransaction.count({
        where: { userId: user.id, type: "SPEND", reason: WALLET_ORDER_PAYMENT_REASON },
      }),
    ).toBe(1);
    const checkout = await prisma.checkoutSession.findUniqueOrThrow({
      where: { id: result.checkout.id },
    });
    expect(checkout.status).toBe("PAID");
    expect(checkout.settledByPaymentId).toBe(result.payment.id);
    // Never a VPN Service for OTHER_PRODUCT.
    expect(await prisma.service.count({ where: { userId: user.id } })).toBe(0);

    // Post-commit fulfillment: WAITING_USER_INFO + configured prompt + info
    // button; admins are NOT told the order is ready yet.
    const recorder = sendRecorder();
    const dispatch = await dispatchPaidOrderFulfillment(recorder.api, result.order.id, {
      source: "WALLET",
    });
    expect(dispatch.kind).toBe("OTHER_PRODUCT");
    const record = await prisma.otherProductOrder.findUniqueOrThrow({
      where: { orderId: result.order.id },
    });
    expect(record.status).toBe("WAITING_USER_INFO");
    const userTexts = recorder.textsTo(user.telegramId.toString());
    expect(userTexts).toHaveLength(1);
    expect(userTexts[0].startsWith(WALLET_INFO_TEXT)).toBe(true);
    expect(userTexts[0]).toContain(PROMPT);
    const infoCall = recorder.calls.find((c) => c.chatId === user.telegramId.toString());
    expect(JSON.stringify(infoCall?.other ?? {})).toContain("user:op:info:");
    expect(recorder.countMatching(ADMIN_READY_MARKER)).toBe(0);
  });

  it("2. info submission: stored once, WAITING_ADMIN_DELIVERY, admins notified, duplicate submit rejected", async () => {
    const user = await createUser(200_000);
    const result = await payPurchaseDraftWithWallet(user, draftFor(infoProduct));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const recorder = sendRecorder();
    await dispatchPaidOrderFulfillment(recorder.api, result.order.id, { source: "WALLET" });
    const record = await prisma.otherProductOrder.findUniqueOrThrow({
      where: { orderId: result.order.id },
    });

    const submit = await submitUserInfo(user.id, record.id, "mail@example.com / pass1234");
    expect(submit.ok).toBe(true);
    const after = await prisma.otherProductOrder.findUniqueOrThrow({ where: { id: record.id } });
    expect(after.status).toBe("WAITING_ADMIN_DELIVERY");
    expect(after.userProvidedInfoText).toBe("mail@example.com / pass1234");

    // The info handler notifies admins after a successful submission.
    if (submit.ok) {
      await notifyAdminsAboutManualOrder(recorder.api, submit.record);
    }
    expect(recorder.countMatching(ADMIN_READY_MARKER)).toBeGreaterThanOrEqual(1);
    expect(recorder.textsTo(admin.telegramId.toString()).some((t) => t.includes(ADMIN_READY_MARKER))).toBe(
      true,
    );

    // Duplicate submission: rejected, stored info unchanged, still ONE record.
    const dup = await submitUserInfo(user.id, record.id, "second attempt");
    expect(dup.ok).toBe(false);
    const final = await prisma.otherProductOrder.findUniqueOrThrow({ where: { id: record.id } });
    expect(final.userProvidedInfoText).toBe("mail@example.com / pass1234");
    expect(await prisma.otherProductOrder.count({ where: { orderId: result.order.id } })).toBe(1);
  });

  it("3. wallet, no required info: WAITING_ADMIN_DELIVERY, exact waiting message, admins notified", async () => {
    const user = await createUser(100_000);
    const result = await payPurchaseDraftWithWallet(user, draftFor(plainProduct));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const recorder = sendRecorder();
    await dispatchPaidOrderFulfillment(recorder.api, result.order.id, { source: "WALLET" });

    const record = await prisma.otherProductOrder.findUniqueOrThrow({
      where: { orderId: result.order.id },
    });
    expect(record.status).toBe("WAITING_ADMIN_DELIVERY");
    const userTexts = recorder.textsTo(user.telegramId.toString());
    expect(userTexts).toEqual([WALLET_WAIT_TEXT]);
    expect(recorder.countMatching(ADMIN_READY_MARKER)).toBeGreaterThanOrEqual(1);
  });

  it("4. stock product via wallet: one item delivered, tied to the order, Order COMPLETED, no manual record", async () => {
    const added = await addStockItem({
      productId: stockProduct.id,
      content: `opw-stock-content-${runTag}-${++seq}`,
      label: null,
      createdByAdminId: admin.id,
    });
    expect(added.ok).toBe(true);

    const user = await createUser(60_000);
    const result = await payPurchaseDraftWithWallet(user, draftFor(stockProduct));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const recorder = sendRecorder();
    const dispatch = await dispatchPaidOrderFulfillment(recorder.api, result.order.id, {
      source: "WALLET",
    });
    expect(dispatch.kind).toBe("OTHER_PRODUCT");
    if (dispatch.kind === "OTHER_PRODUCT") {
      expect(dispatch.auto).toBe("DELIVERED");
    }

    // Exactly one stock item is associated with this order and delivered.
    const items = await prisma.otherProductStockItem.findMany({
      where: { deliveredOrderId: result.order.id },
    });
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe("DELIVERED");
    const order = await prisma.order.findUniqueOrThrow({ where: { id: result.order.id } });
    expect(order.status).toBe("COMPLETED");
    // No manual-delivery record for a clean stock delivery.
    expect(await prisma.otherProductOrder.count({ where: { orderId: result.order.id } })).toBe(0);
    // The user received the stock delivery message (content sent by the
    // stock service itself).
    expect(
      recorder.textsTo(user.telegramId.toString()).some((t) => t.includes("سفارش شما آماده شد ✅")),
    ).toBe(true);
  });

  it("5. insufficient balance: nothing is created, nothing is sent", async () => {
    const user = await createUser(10_000);
    const result = await payPurchaseDraftWithWallet(user, draftFor(infoProduct));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(INSUFFICIENT_BALANCE_TEXT);
    }
    expect(await prisma.checkoutSession.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.otherProductOrder.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.walletTransaction.count({ where: { userId: user.id } })).toBe(0);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).balanceToman,
    ).toBe(10_000);
  });

  it(
    "6. concurrent double-click on ONE draft: one deduction, one order, one record, one prompt",
    { timeout: 30_000 },
    async () => {
      const user = await createUser(120_000);
      const draft = draftFor(infoProduct);
      const [a, b] = await Promise.all([
        payPurchaseDraftWithWallet(user, draft),
        payPurchaseDraftWithWallet(user, draft),
      ]);
      expect(a.ok && b.ok).toBe(true);
      if (!a.ok || !b.ok) {
        return;
      }
      expect(a.order.id).toBe(b.order.id);
      expect([a.alreadyPaid, b.alreadyPaid].filter((x) => !x).length).toBeLessThanOrEqual(1);

      // One deduction, one payment, one order, one SPEND row.
      const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(fresh.balanceToman).toBe(0);
      expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(1);
      expect(await prisma.order.count({ where: { userId: user.id } })).toBe(1);
      expect(
        await prisma.walletTransaction.count({ where: { userId: user.id, type: "SPEND" } }),
      ).toBe(1);

      // The handler dispatches fulfillment ONLY for the fresh (non-replay)
      // result - and even a raced double dispatch converges on one record
      // and one prompt.
      const recorder = sendRecorder();
      await Promise.all([
        dispatchPaidOrderFulfillment(recorder.api, a.order.id, { source: "WALLET" }),
        dispatchPaidOrderFulfillment(recorder.api, a.order.id, { source: "WALLET" }),
      ]);
      expect(await prisma.otherProductOrder.count({ where: { orderId: a.order.id } })).toBe(1);
      const prompts = recorder
        .textsTo(user.telegramId.toString())
        .filter((t) => t.startsWith(WALLET_INFO_TEXT));
      expect(prompts).toHaveLength(1);
    },
  );

  it(
    "7. two DIFFERENT drafts racing on one balance: overspend protection intact",
    { timeout: 30_000 },
    async () => {
      const user = await createUser(150_000); // covers ONE 120k purchase only
      const [a, b] = await Promise.all([
        payPurchaseDraftWithWallet(user, draftFor(infoProduct)),
        payPurchaseDraftWithWallet(user, draftFor(infoProduct)),
      ]);
      const okCount = [a, b].filter((r) => r.ok).length;
      expect(okCount).toBe(1);
      const loser = [a, b].find((r) => !r.ok);
      expect(loser !== undefined && !loser.ok && loser.error === INSUFFICIENT_BALANCE_TEXT).toBe(
        true,
      );
      const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
      expect(fresh.balanceToman).toBe(150_000 - 120_000);
      expect(fresh.balanceToman).toBeGreaterThanOrEqual(0);
      expect(await prisma.order.count({ where: { userId: user.id } })).toBe(1);
      expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(1);
    },
  );

  it("8. pending card-to-card receipt: no order, no record, no info request", async () => {
    const user = await createUser();
    await createReceiptPayment(user, infoProduct);
    // Payment sits in PENDING_REVIEW - nothing may exist or be asked yet.
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.otherProductOrder.count({ where: { userId: user.id } })).toBe(0);
  });

  it("9. approved receipt: same dispatcher, prompt sent exactly once with the receipt confirmation", async () => {
    const user = await createUser();
    const paymentId = await createReceiptPayment(user, infoProduct);
    const result = await approveReceiptPayment(paymentId, admin);
    expect(result.ok).toBe(true);
    if (!result.ok || result.kind === "WALLET_TOPUP") {
      return;
    }
    expect(result.orderType).toBe("OTHER_PRODUCT");

    const recorder = sendRecorder();
    await dispatchPaidOrderFulfillment(recorder.api, result.order.id, {
      source: "RECEIPT",
      user: result.user,
    });
    const record = await prisma.otherProductOrder.findUniqueOrThrow({
      where: { orderId: result.order.id },
    });
    expect(record.status).toBe("WAITING_USER_INFO");
    const prompts = recorder
      .textsTo(user.telegramId.toString())
      .filter((t) => t.startsWith(RECEIPT_INFO_TEXT));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(PROMPT);
    expect(recorder.countMatching(ADMIN_READY_MARKER)).toBe(0);
  });

  it("10. rejected receipt: no order, no manual record, no info request", async () => {
    const user = await createUser();
    const paymentId = await createReceiptPayment(user, infoProduct);
    const result = await rejectReceiptPayment(paymentId, admin, "مبلغ واریزی ناقص است.");
    expect(result.ok).toBe(true);
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.otherProductOrder.count({ where: { userId: user.id } })).toBe(0);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe("REJECTED");
  });

  it("11. gateway-paid OTHER_PRODUCT goes through the SAME dispatcher with the same states", async () => {
    const user = await createUser();
    const paymentId = await createGatewaySuccess(user, infoProduct);
    const outcome = await settleGatewayPayment(paymentId);
    expect(outcome.kind).toBe("settled");

    const recorder = sendRecorder();
    await fulfillSettledGatewayOrder(recorder.api, outcome);
    const order = await prisma.order.findFirstOrThrow({ where: { userId: user.id } });
    const record = await prisma.otherProductOrder.findUniqueOrThrow({
      where: { orderId: order.id },
    });
    expect(record.status).toBe("WAITING_USER_INFO");
    const prompts = recorder
      .textsTo(user.telegramId.toString())
      .filter((t) => t.startsWith(GATEWAY_INFO_TEXT));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(PROMPT);
    expect(recorder.countMatching(ADMIN_READY_MARKER)).toBe(0);
  });

  it("12. repeated dispatcher calls converge: no duplicate stock, records, prompts or admin alerts", async () => {
    // Manual (no-info) order: repeats never re-prompt or re-alert.
    const user = await createUser(80_000);
    const result = await payPurchaseDraftWithWallet(user, draftFor(plainProduct));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const recorder = sendRecorder();
    await dispatchPaidOrderFulfillment(recorder.api, result.order.id, { source: "WALLET" });
    const afterFirst = recorder.calls.length;
    for (let i = 0; i < 3; i += 1) {
      await dispatchPaidOrderFulfillment(recorder.api, result.order.id, { source: "WALLET" });
    }
    expect(recorder.calls.length).toBe(afterFirst);
    expect(await prisma.otherProductOrder.count({ where: { orderId: result.order.id } })).toBe(1);

    // Stock order: repeats resolve to ALREADY_DELIVERED - one item, one send.
    const added = await addStockItem({
      productId: stockProduct.id,
      content: `opw-stock-repeat-${runTag}-${++seq}`,
      label: null,
      createdByAdminId: admin.id,
    });
    expect(added.ok).toBe(true);
    const stockUser = await createUser(60_000);
    const stockResult = await payPurchaseDraftWithWallet(stockUser, draftFor(stockProduct));
    expect(stockResult.ok).toBe(true);
    if (!stockResult.ok) {
      return;
    }
    const stockRecorder = sendRecorder();
    const first = await dispatchPaidOrderFulfillment(stockRecorder.api, stockResult.order.id, {
      source: "WALLET",
    });
    expect(first.kind === "OTHER_PRODUCT" && first.auto === "DELIVERED").toBe(true);
    const sentAfterFirst = stockRecorder.textsTo(stockUser.telegramId.toString()).length;
    const second = await dispatchPaidOrderFulfillment(stockRecorder.api, stockResult.order.id, {
      source: "WALLET",
    });
    expect(second.kind === "OTHER_PRODUCT" && second.auto === "ALREADY_DELIVERED").toBe(true);
    expect(stockRecorder.textsTo(stockUser.telegramId.toString()).length).toBe(sentAfterFirst);
    expect(
      await prisma.otherProductStockItem.count({
        where: { deliveredOrderId: stockResult.order.id },
      }),
    ).toBe(1);
    expect(await prisma.otherProductOrder.count({ where: { orderId: stockResult.order.id } })).toBe(
      0,
    );
  });
});

describe.skipIf(hasDb)("OTHER_PRODUCT wallet payment (skipped)", () => {
  it("requires DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
