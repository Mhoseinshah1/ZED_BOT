import { randomUUID } from "node:crypto";

import {
  prisma,
  type Admin,
  type CheckoutSession,
  type PaymentGateway,
  type Product,
  type User,
} from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "telegram-premium-receipt-tests-01";

import { initialSession, type SessionData } from "../src/core/session.js";
import {
  customerInputFormHandler,
  customerInputFormTextHandler,
  maybeStartPreSettlementCustomerInput,
} from "../src/handlers/user-checkout/customer-input-form.handler.js";
import {
  consumeCheckoutInputForOrder,
  CUSTOMER_INPUT_SAVED_NOTICE,
} from "../src/services/checkout-customer-input.service.js";
import { createCheckoutSession } from "../src/services/checkout.service.js";
import {
  decodeValuesEncrypted,
  TELEGRAM_PREMIUM_DEFAULT_SCHEMA,
} from "../src/services/customer-input-schema.service.js";
import {
  dispatchPaidOrderFulfillment,
  INFO_REQUIRED_FOLLOWUP_TEXT,
  WAITING_FOR_DELIVERY_TEXT,
} from "../src/services/order-fulfillment.service.js";
import { submitReceipt } from "../src/services/payment-method.service.js";
import {
  approveReceiptPayment,
  rejectReceiptPayment,
} from "../src/services/receipt-review.service.js";

// =============================================================================
// Specialized-workflows phase - §13 TELEGRAM_PREMIUM card-to-card matrix:
// checkout snapshot capture -> real submitReceipt (PENDING_REVIEW) -> the
// receipt hook opens the PRE-SETTLEMENT customer-input form -> the buyer
// completes it (NO financial effect, exact saved-notice) -> approval settles
// and fulfillment copies the submission exactly once (values never re-asked,
// one admin notification) -> repeats converge -> rejection never consumes
// the input -> a NEW checkout can never consume the old checkout's input.
// Requires the shared test PostgreSQL (docs/testing.md); cleans up fixtures.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

const ADMIN_READY_MARKER = "سفارش دستی جدید 📦";
const PRICE = 350_000;

let admin: Admin;
let gateway: PaymentGateway;
let categoryId: string;
let product: Product;

const userIds: string[] = [];

interface SentMessage {
  text: string;
  other: Record<string, unknown> | undefined;
}

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

async function createPremiumCheckout(user: User): Promise<CheckoutSession> {
  const withRelations = await prisma.product.findUniqueOrThrow({
    where: { id: product.id },
    include: { category: true, panel: true },
  });
  return createCheckoutSession(user, withRelations, {
    productId: product.id,
    categoryId,
    flowType: "OTHER_PRODUCT",
    originalPriceToman: PRICE,
    discountAmountToman: 0,
    finalPriceToman: PRICE,
    draftNonce: randomUUID(),
  });
}

// --- fake grammY contexts (log-group-wizard convention) --------------------------------------

function baseCtx(user: User, session: SessionData, api: { sendMessage: unknown }) {
  const replies: SentMessage[] = [];
  const toasts: Array<string | undefined> = [];
  const shared = {
    session,
    dbUser: user,
    admin: null,
    api,
    reply: async (text: string, other?: Record<string, unknown>) => {
      replies.push({ text, other });
      return {};
    },
    answerCallbackQuery: async (payload?: { text?: string }) => {
      toasts.push(payload?.text);
      return true;
    },
  };
  return { shared, replies, toasts };
}

function messageCtx(user: User, session: SessionData, api: { sendMessage: unknown }, text: string) {
  const { shared, replies, toasts } = baseCtx(user, session, api);
  const from = { id: Number(user.telegramId), is_bot: false, first_name: "Buyer" };
  const message = {
    message_id: 30,
    date: 0,
    chat: { id: Number(user.telegramId), type: "private", first_name: "Buyer" },
    from,
    text,
  };
  const ctx = { ...shared, message, update: { update_id: 3, message } };
  return { ctx: ctx as never, replies, toasts };
}

function callbackCtx(user: User, session: SessionData, api: { sendMessage: unknown }, data: string) {
  const { shared, replies, toasts } = baseCtx(user, session, api);
  const from = { id: Number(user.telegramId), is_bot: false, first_name: "Buyer" };
  const callbackQuery = { id: "cbq-9", chat_instance: "ci-9", from, data };
  const ctx = { ...shared, callbackQuery, update: { update_id: 4, callback_query: callbackQuery } };
  return { ctx: ctx as never, replies, toasts };
}

async function formText(user: User, session: SessionData, api: { sendMessage: unknown }, text: string) {
  const { ctx, replies } = messageCtx(user, session, api, text);
  await customerInputFormTextHandler.middleware()(ctx, async () => {});
  return replies;
}

async function formCb(user: User, session: SessionData, api: { sendMessage: unknown }, data: string) {
  const { ctx, replies } = callbackCtx(user, session, api, data);
  await customerInputFormHandler.middleware()(ctx, async () => {});
  return replies;
}

describe.runIf(hasDb)("TELEGRAM_PREMIUM card-to-card receipt flow (§13)", () => {
  // Shared across the ordered happy-path tests below.
  let buyer: User;
  let checkout: CheckoutSession;
  let paymentId: string;
  let orderId: string;
  const session = initialSession();
  const recorder = sendRecorder();

  beforeAll(async () => {
    const category = await prisma.productCategory.create({
      data: { type: "OTHER_PRODUCT", name: `tpr-cat-${runTag}`, isActive: true },
    });
    categoryId = category.id;
    admin = await prisma.admin.create({
      data: { telegramId: runTag + 920_000_000n, role: "OWNER", isActive: true },
    });
    gateway = await prisma.paymentGateway.create({
      data: { type: "CARD_TO_CARD", name: `tpr-gw-${runTag}`, isEnabled: true },
    });
    product = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId,
        name: `tpr-premium-${runTag}`,
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
  });

  afterAll(async () => {
    // Let fire-and-forget ops-log writes settle before sweeping.
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
    await prisma.payment.deleteMany({ where: users });
    await prisma.order.deleteMany({ where: users });
    await prisma.checkoutSession.deleteMany({ where: users });
    await prisma.product.deleteMany({ where: { categoryId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma.paymentGateway.deleteMany({ where: { id: gateway.id } });
    await prisma.admin.deleteMany({ where: { id: admin.id } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("1. checkout freezes the premium fulfillment snapshot", async () => {
    buyer = await createUser();
    checkout = await createPremiumCheckout(buyer);
    const snapshot = checkout.otherProductFulfillmentSnapshot as Record<string, unknown>;
    expect(snapshot).not.toBeNull();
    expect(snapshot.kind).toBe("TELEGRAM_PREMIUM");
    expect(snapshot.profile).toBe("PERSONALIZED_SERVICE");
    expect(snapshot.requiresCustomerInfo).toBe(true);
    expect(snapshot.collectInfoBeforeManualApproval).toBe(true);
    expect(snapshot.customerInputSchema).toEqual(
      JSON.parse(JSON.stringify(TELEGRAM_PREMIUM_DEFAULT_SCHEMA)),
    );
  });

  it("2. real submitReceipt registers PENDING_REVIEW and the hook opens the form (COLLECTING)", async () => {
    const submitted = await submitReceipt(buyer, checkout, gateway.id, undefined, {
      text: "کارت به کارت انجام شد",
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) {
      return;
    }
    paymentId = submitted.payment.id;
    expect(submitted.payment.status).toBe("PENDING_REVIEW");

    // The payment.handler hook, driven with a real message-style context.
    const { ctx, replies } = messageCtx(buyer, session, recorder.api, "receipt");
    await maybeStartPreSettlementCustomerInput(ctx as never, checkout);
    const input = await prisma.checkoutCustomerInput.findUniqueOrThrow({
      where: { checkoutSessionId: checkout.id },
    });
    expect(input.status).toBe("COLLECTING");
    expect(input.userId).toBe(buyer.id);
    expect(input.schemaSnapshot).toEqual(
      JSON.parse(JSON.stringify(TELEGRAM_PREMIUM_DEFAULT_SCHEMA)),
    );
    // Field 1 of 3 was rendered and the form flow is active.
    expect(replies.at(-1)?.text).toContain("فیلد 1 از 3");
    expect(session.currentFlow).toBe("customer_input:form");

    // Nothing financial happened.
    expect(await prisma.order.count({ where: { userId: buyer.id } })).toBe(0);
    expect(await prisma.otherProductOrder.count({ where: { userId: buyer.id } })).toBe(0);
  });

  it("3. completing the form pre-approval saves ONLY the input row (exact notice, no order/stock/notify)", async () => {
    await formText(buyer, session, recorder.api, "@premium_target");
    await formCb(buyer, session, recorder.api, "cinput:skip");
    const reviewReplies = await formCb(buyer, session, recorder.api, "cinput:skip");
    expect(reviewReplies.at(-1)?.text).toContain("بازبینی اطلاعات");
    const confirmReplies = await formCb(buyer, session, recorder.api, "cinput:confirm");
    expect(confirmReplies.at(-1)?.text).toBe(CUSTOMER_INPUT_SAVED_NOTICE);

    const input = await prisma.checkoutCustomerInput.findUniqueOrThrow({
      where: { checkoutSessionId: checkout.id },
    });
    expect(input.status).toBe("SUBMITTED");
    expect(input.consumedByOtherProductOrderId).toBeNull();
    expect(input.valuesEncrypted).not.toBeNull();
    expect(decodeValuesEncrypted(input.valuesEncrypted as string)).toEqual({
      telegram_account: "premium_target",
      requested_identifier: "",
      customer_note: "",
    });
    expect(input.renderedSafeSummary).toContain("premium_target");

    // HARD invariant: submission never settles/creates/consumes/notifies.
    expect(await prisma.order.count({ where: { userId: buyer.id } })).toBe(0);
    expect(await prisma.otherProductOrder.count({ where: { userId: buyer.id } })).toBe(0);
    expect(await prisma.otherProductStockItem.count({ where: { productId: product.id } })).toBe(0);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: paymentId } });
    expect(payment.status).toBe("PENDING_REVIEW");
    expect(recorder.textsTo(admin.telegramId.toString())).toHaveLength(0);
  });

  it("4. approval fulfills exactly once: order + WAITING_ADMIN_DELIVERY record with the copied input", async () => {
    const result = await approveReceiptPayment(paymentId, admin);
    expect(result.ok).toBe(true);
    if (!result.ok || result.kind !== "ORDER_PAYMENT") {
      return;
    }
    expect(result.orderType).toBe("OTHER_PRODUCT");
    orderId = result.order.id;

    await dispatchPaidOrderFulfillment(recorder.api, orderId, {
      source: "RECEIPT",
      user: buyer,
    });

    expect(await prisma.order.count({ where: { userId: buyer.id } })).toBe(1);
    const record = await prisma.otherProductOrder.findUniqueOrThrow({ where: { orderId } });
    expect(record.status).toBe("WAITING_ADMIN_DELIVERY");
    expect(record.kindSnapshot).toBe("TELEGRAM_PREMIUM");
    expect(record.fulfillmentProfileSnapshot).toBe("PERSONALIZED_SERVICE");
    expect(record.customerInputEncrypted).not.toBeNull();
    expect(decodeValuesEncrypted(record.customerInputEncrypted as string)).toEqual({
      telegram_account: "premium_target",
      requested_identifier: "",
      customer_note: "",
    });
    expect(record.customerInputSummary).toContain("premium_target");
    expect(record.customerInputSubmittedAt).not.toBeNull();
    expect(record.fulfillmentAdminsNotifiedAt).not.toBeNull();

    // The submission was consumed by exactly this record.
    const input = await prisma.checkoutCustomerInput.findUniqueOrThrow({
      where: { checkoutSessionId: checkout.id },
    });
    expect(input.status).toBe("CONSUMED");
    expect(input.consumedByOtherProductOrderId).toBe(record.id);

    // Values are NOT re-asked: the buyer got the waiting notice, never the
    // info-required prompt or a form button.
    const buyerTexts = recorder.textsTo(buyer.telegramId.toString());
    expect(buyerTexts.some((t) => t.includes(WAITING_FOR_DELIVERY_TEXT))).toBe(true);
    expect(buyerTexts.some((t) => t.includes(INFO_REQUIRED_FOLLOWUP_TEXT))).toBe(false);
    expect(
      recorder.calls.some(
        (c) =>
          c.chatId === buyer.telegramId.toString() &&
          JSON.stringify(c.other ?? {}).includes("cinput:start"),
      ),
    ).toBe(false);

    // Fulfillment admins were told exactly once.
    const adminReady = recorder
      .textsTo(admin.telegramId.toString())
      .filter((t) => t.includes(ADMIN_READY_MARKER));
    expect(adminReady).toHaveLength(1);
  });

  it("5. repeated approval/dispatch converge: no duplicate order, record or notification", async () => {
    const again = await approveReceiptPayment(paymentId, admin);
    expect(again.ok).toBe(false);

    const callsBefore = recorder.calls.length;
    await dispatchPaidOrderFulfillment(recorder.api, orderId, { source: "RECEIPT" });
    await dispatchPaidOrderFulfillment(recorder.api, orderId, { source: "RECEIPT" });
    expect(recorder.calls.length).toBe(callsBefore);

    expect(await prisma.order.count({ where: { userId: buyer.id } })).toBe(1);
    expect(await prisma.otherProductOrder.count({ where: { userId: buyer.id } })).toBe(1);
    const adminReady = recorder
      .textsTo(admin.telegramId.toString())
      .filter((t) => t.includes(ADMIN_READY_MARKER));
    expect(adminReady).toHaveLength(1);
  });

  it("6. rejection: no fulfillment, and the submitted input is NOT consumed", async () => {
    const other = await createUser();
    const otherCheckout = await createPremiumCheckout(other);
    const submitted = await submitReceipt(other, otherCheckout, gateway.id, undefined, {
      text: "receipt-2",
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) {
      return;
    }
    const otherSession = initialSession();
    const otherRecorder = sendRecorder();
    const { ctx } = messageCtx(other, otherSession, otherRecorder.api, "receipt");
    await maybeStartPreSettlementCustomerInput(ctx as never, otherCheckout);
    await formText(other, otherSession, otherRecorder.api, "@reject_case");
    await formCb(other, otherSession, otherRecorder.api, "cinput:skip");
    await formCb(other, otherSession, otherRecorder.api, "cinput:skip");
    await formCb(other, otherSession, otherRecorder.api, "cinput:confirm");

    const rejection = await rejectReceiptPayment(submitted.payment.id, admin, "مبلغ ناقص است.");
    expect(rejection.ok).toBe(true);

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: submitted.payment.id },
    });
    expect(payment.status).toBe("REJECTED");
    expect(await prisma.order.count({ where: { userId: other.id } })).toBe(0);
    expect(await prisma.otherProductOrder.count({ where: { userId: other.id } })).toBe(0);
    const input = await prisma.checkoutCustomerInput.findUniqueOrThrow({
      where: { checkoutSessionId: otherCheckout.id },
    });
    expect(input.status).toBe("SUBMITTED");
    expect(input.consumedByOtherProductOrderId).toBeNull();
    expect(input.valuesEncrypted).not.toBeNull();
    expect(otherRecorder.textsTo(admin.telegramId.toString())).toHaveLength(0);
  });

  it("7. a NEW checkout can never consume another checkout's input", async () => {
    const other = userIds.length > 1 ? await prisma.user.findUniqueOrThrow({ where: { id: userIds[1] } }) : buyer;
    const oldCheckout = await prisma.checkoutSession.findFirstOrThrow({
      where: { userId: other.id },
      orderBy: { createdAt: "asc" },
    });
    const freshCheckout = await createPremiumCheckout(other);
    expect(freshCheckout.id).not.toBe(oldCheckout.id);

    // Consumption is checkout-scoped: the fresh checkout has no input row,
    // so a fulfillment keyed to it can never reach the old submission.
    const crossConsume = await consumeCheckoutInputForOrder(freshCheckout.id, randomUUID());
    expect(crossConsume).toBeNull();

    const oldInput = await prisma.checkoutCustomerInput.findUniqueOrThrow({
      where: { checkoutSessionId: oldCheckout.id },
    });
    expect(oldInput.status).toBe("SUBMITTED");
    expect(oldInput.consumedByOtherProductOrderId).toBeNull();
  });
});

describe.skipIf(hasDb)("TELEGRAM_PREMIUM receipt flow (skipped)", () => {
  it("requires DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
