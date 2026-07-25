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

process.env.APP_SECRET ??= "apple-id-personalized-tests-secret-0001";

import { initialSession, type CheckoutDraft, type SessionData } from "../src/core/session.js";
import { enforceCustomerInfoBeforePayment } from "../src/handlers/user-checkout/customer-input-form.handler.js";
import {
  getOrCreateCheckoutInput,
  isCheckoutInputSatisfied,
  isMandatoryCustomerInfoMissing,
  submitCheckoutInput,
} from "../src/services/checkout-customer-input.service.js";
import { createCheckoutSession } from "../src/services/checkout.service.js";
import {
  decodeValuesEncrypted,
  PERSONALIZED_AI_DEFAULT_SCHEMA,
  PERSONALIZED_APPLE_ID_DEFAULT_SCHEMA,
  renderSafeSummary,
} from "../src/services/customer-input-schema.service.js";
import { productDetailKeyboard } from "../src/handlers/products/product-views.js";
import { dispatchPaidOrderFulfillment } from "../src/services/order-fulfillment.service.js";
import { deliverManualOrder } from "../src/services/other-product-delivery.service.js";
import {
  buildFulfillmentSnapshot,
  resolveEffectiveProfile,
  type ProfileProductFields,
} from "../src/services/other-product-profile.service.js";
import { addStockItem } from "../src/services/other-product-stock.service.js";
import { submitReceipt } from "../src/services/payment-method.service.js";
import { approveReceiptPayment } from "../src/services/receipt-review.service.js";
import { payPurchaseDraftWithWallet } from "../src/services/wallet-payment.service.js";

// =============================================================================
// Apple ID personalized (ساخت شخصی) vs ready-from-stock (تحویل آماده) fulfillment
// (fix/apple-id-personalized-fulfillment). Real PostgreSQL. Proves: the two
// explicit profiles resolve/freeze correctly; the mandatory customer-info gate
// blocks payment before the form and allows it after; a personalized order
// never reserves/consumes stock nor emits out-of-stock; a stock Apple ID still
// auto-delivers from inventory; mode changes affect only future checkouts;
// double settlement is idempotent; info is encrypted; admin manual delivery
// completes the order; and the other OTHER_PRODUCT kinds do not regress.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;
const PRICE = 90_000;

const APPLE_VALUES: Record<string, string> = {
  first_name: "Ali",
  last_name: "Rezaei",
  birth_date: "2000-05-01",
  country_region: "United States",
  recovery_email: "recover.person@example.com",
  phone: "",
  extra_note: "",
};

let admin: Admin;
let categoryId: string;
let personalizedProduct: Product;
let stockProduct: Product;
let cardGateway: PaymentGateway;
const userIds: string[] = [];
const productIds: string[] = [];

function sendRecorder() {
  const calls: Array<{ chatId: string; text: string; other?: Record<string, unknown> }> = [];
  return {
    calls,
    textsTo(chatId: string): string[] {
      return calls.filter((c) => c.chatId === chatId).map((c) => c.text);
    },
    allText(): string {
      return calls.map((c) => c.text).join("\n");
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

async function createUser(balance = PRICE * 10): Promise<User> {
  seq += 1;
  const user = await prisma.user.create({
    data: { telegramId: runTag + BigInt(seq), balanceToman: balance },
  });
  userIds.push(user.id);
  return user;
}

async function createProduct(data: Partial<Product> & { name: string }): Promise<Product> {
  const product = await prisma.product.create({
    data: {
      type: "OTHER_PRODUCT",
      categoryId,
      priceToman: PRICE,
      isActive: true,
      displayGroups: ["ALL"],
      ...data,
    } as never,
  });
  productIds.push(product.id);
  return product;
}

async function productWithRelations(productId: string) {
  return prisma.product.findUniqueOrThrow({
    where: { id: productId },
    include: { category: true, panel: true },
  });
}

function draftFor(product: Product): CheckoutDraft {
  return {
    productId: product.id,
    categoryId,
    flowType: "OTHER_PRODUCT",
    originalPriceToman: PRICE,
    discountAmountToman: 0,
    finalPriceToman: PRICE,
    draftNonce: randomUUID(),
  };
}

async function makeCheckout(user: User, product: Product): Promise<CheckoutSession> {
  return createCheckoutSession(user, await productWithRelations(product.id), draftFor(product));
}

/** Directly persist a confirmed customer-info submission for a checkout. */
async function submitInfo(checkoutId: string, user: User): Promise<void> {
  await getOrCreateCheckoutInput(checkoutId, user.id, PERSONALIZED_APPLE_ID_DEFAULT_SCHEMA);
  const r = await submitCheckoutInput(checkoutId, user.id, APPLE_VALUES);
  expect(r.ok).toBe(true);
}

function callbackCtx(user: User, session: SessionData, api: { sendMessage: unknown }) {
  const toasts: Array<string | undefined> = [];
  const from = { id: Number(user.telegramId), is_bot: false, first_name: "Buyer" };
  const shared = {
    session,
    dbUser: user,
    admin: null,
    api,
    reply: async () => ({}),
    answerCallbackQuery: async (payload?: { text?: string }) => {
      toasts.push(payload?.text);
      return true;
    },
    callbackQuery: { id: "cbq", chat_instance: "ci", from, data: "x" },
  };
  return { ctx: shared as never, toasts };
}

describe.runIf(hasDb)("Apple ID personalized vs stock fulfillment (DB)", () => {
  beforeAll(async () => {
    const category = await prisma.productCategory.create({
      data: { type: "OTHER_PRODUCT", name: `apple-cat-${runTag}`, isActive: true },
    });
    categoryId = category.id;
    admin = await prisma.admin.create({
      data: { telegramId: runTag + 900_000_000n, role: "OWNER", isActive: true },
    });
    cardGateway = await prisma.paymentGateway.create({
      data: { type: "CARD_TO_CARD", name: `apple-gw-${runTag}`, isEnabled: true },
    });
    personalizedProduct = await createProduct({
      name: `apple-pers-${runTag}`,
      deliveryType: "MANUAL_ADMIN",
      otherProductKind: "APPLE_ID",
      otherProductFulfillmentProfile: "PERSONALIZED_SERVICE",
      requiredUserInfoEnabled: true,
      collectInfoBeforeManualApproval: true,
      stockEnabled: false,
      customerInputSchema: JSON.parse(JSON.stringify(PERSONALIZED_APPLE_ID_DEFAULT_SCHEMA)),
    });
    stockProduct = await createProduct({
      name: `apple-stock-${runTag}`,
      deliveryType: "STOCK_ITEM",
      otherProductKind: "APPLE_ID",
      otherProductFulfillmentProfile: "STOCK_CREDENTIAL",
      otherProductStockParser: "EMAIL_BOUNDARY",
      requiredUserInfoEnabled: false,
      stockEnabled: true,
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
    await prisma.systemLogDelivery.deleteMany({ where: { systemLogId: { in: logs.map((l) => l.id) } } });
    await prisma.systemLog.deleteMany({ where: { id: { in: logs.map((l) => l.id) } } });
    await prisma.checkoutCustomerInput.deleteMany({ where: users });
    await prisma.otherProductStockItem.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.otherProductOrder.deleteMany({ where: users });
    await prisma.walletTransaction.deleteMany({ where: users });
    await prisma.manualReceipt.deleteMany({ where: users });
    await prisma.payment.deleteMany({ where: users });
    await prisma.order.deleteMany({ where: users });
    await prisma.checkoutSession.deleteMany({ where: users });
    await prisma.product.deleteMany({ where: { id: { in: productIds } } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma.paymentGateway.deleteMany({ where: { id: cardGateway.id } });
    await prisma.admin.deleteMany({ where: { id: admin.id } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("1. a STOCK_CREDENTIAL Apple ID resolves to ready-from-stock (no info, EMAIL_BOUNDARY, no schema)", () => {
    const p = resolveEffectiveProfile(stockProduct as ProfileProductFields);
    expect(p.kind).toBe("APPLE_ID");
    expect(p.profile).toBe("STOCK_CREDENTIAL");
    expect(p.stockParser).toBe("EMAIL_BOUNDARY");
    expect(p.requiresCustomerInfo).toBe(false);
    expect(p.customerInputSchema).toBeNull();
  });

  it("2. a PERSONALIZED_SERVICE Apple ID resolves to manual build (info required, no stock)", () => {
    const p = resolveEffectiveProfile(personalizedProduct as ProfileProductFields);
    expect(p.profile).toBe("PERSONALIZED_SERVICE");
    expect(p.stockParser).toBeNull();
    expect(p.requiresCustomerInfo).toBe(true);
  });

  it("3. personalized Apple ID uses the default structured customer form", async () => {
    const noSchema = { ...personalizedProduct, customerInputSchema: null } as ProfileProductFields;
    const p = resolveEffectiveProfile(noSchema);
    expect(p.customerInputSchema).toEqual(PERSONALIZED_APPLE_ID_DEFAULT_SCHEMA);
    const keys = (p.customerInputSchema?.fields ?? []).map((f) => f.key);
    expect(keys).toEqual([
      "first_name",
      "last_name",
      "birth_date",
      "country_region",
      "recovery_email",
      "phone",
      "extra_note",
    ]);
    // The checkout freezes the personalized snapshot with the schema.
    const user = await createUser();
    const checkout = await makeCheckout(user, personalizedProduct);
    const snap = checkout.otherProductFulfillmentSnapshot as Record<string, unknown>;
    expect(snap.profile).toBe("PERSONALIZED_SERVICE");
    expect(snap.requiresCustomerInfo).toBe(true);
    expect(snap.customerInputSchema).toEqual(
      JSON.parse(JSON.stringify(PERSONALIZED_APPLE_ID_DEFAULT_SCHEMA)),
    );
  });

  it("4. wallet payment is BLOCKED before the info is submitted (no money moves)", async () => {
    const user = await createUser();
    const draft = draftFor(personalizedProduct);
    const result = await payPurchaseDraftWithWallet(user, draft);
    expect(result.ok).toBe(false);
    expect("needsCustomerInfo" in result && result.needsCustomerInfo).toBe(true);
    if (result.ok || !("needsCustomerInfo" in result)) return;
    // A PENDING checkout was materialized with the frozen personalized snapshot.
    const pending = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: result.checkoutId } });
    expect(pending.status).toBe("PENDING");
    expect((pending.otherProductFulfillmentSnapshot as Record<string, unknown>).profile).toBe(
      "PERSONALIZED_SERVICE",
    );
    expect(await isCheckoutInputSatisfied(result.checkoutId)).toBe(false);
    // Nothing financial happened.
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0);
    expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(0);
    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(fresh.balanceToman).toBe(user.balanceToman);
  });

  it("5. confirmed information ALLOWS wallet settlement (charge + manual order, no stock)", async () => {
    const user = await createUser();
    const draft = draftFor(personalizedProduct);
    const first = await payPurchaseDraftWithWallet(user, draft);
    expect(first.ok).toBe(false);
    if (first.ok || !("needsCustomerInfo" in first)) return;
    const checkoutId = first.checkoutId;
    draft.otherProductCheckoutId = checkoutId;
    await submitInfo(checkoutId, user);
    expect(await isCheckoutInputSatisfied(checkoutId)).toBe(true);

    const fresh = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const paid = await payPurchaseDraftWithWallet(fresh, draft);
    expect(paid.ok).toBe(true);
    if (!paid.ok) return;
    expect(paid.checkout.id).toBe(checkoutId);
    expect(paid.checkout.status).toBe("PAID");
    expect(paid.newBalanceToman).toBe(user.balanceToman - PRICE);

    const recorder = sendRecorder();
    await dispatchPaidOrderFulfillment(recorder.api, paid.order.id, { source: "WALLET", user: fresh });
    const record = await prisma.otherProductOrder.findUniqueOrThrow({ where: { orderId: paid.order.id } });
    expect(record.kindSnapshot).toBe("APPLE_ID");
    expect(record.fulfillmentProfileSnapshot).toBe("PERSONALIZED_SERVICE");
    expect(record.status).toBe("WAITING_ADMIN_DELIVERY");
    expect(record.customerInputEncrypted).not.toBeNull();
    // No stock was ever touched.
    expect(await prisma.otherProductStockItem.count({ where: { productId: personalizedProduct.id } })).toBe(0);
  });

  it("6. the gateway/Stars pre-payment gate blocks before info and allows after", async () => {
    const user = await createUser();
    const checkout = await makeCheckout(user, personalizedProduct);
    const session = initialSession();
    const recorder = sendRecorder();
    // Blocked before info.
    const { ctx } = callbackCtx(user, session, recorder.api);
    const blocked = await enforceCustomerInfoBeforePayment(ctx, checkout);
    expect(blocked).toBe(true);
    // After a confirmed submission the gate lets the payment proceed.
    await submitInfo(checkout.id, user);
    const { ctx: ctx2 } = callbackCtx(user, initialSession(), recorder.api);
    const afterInfo = await enforceCustomerInfoBeforePayment(ctx2, checkout);
    expect(afterInfo).toBe(false);
  });

  it("7. confirmed information ALLOWS receipt-style settlement + fulfillment", async () => {
    const user = await createUser();
    const checkout = await makeCheckout(user, personalizedProduct);
    await submitInfo(checkout.id, user);
    // Simulate an approved receipt: a PAID payment + order on the checkout.
    const payment = await prisma.payment.create({
      data: {
        userId: user.id,
        checkoutSessionId: checkout.id,
        purpose: "ORDER_PAYMENT",
        status: "APPROVED",
        amountToman: PRICE,
        payableAmountToman: PRICE,
        provider: "ZARINPAL",
        settlementStatus: "SETTLED",
        settledAt: new Date(),
      },
    });
    await prisma.checkoutSession.update({
      where: { id: checkout.id },
      data: { status: "PAID", paidAt: new Date(), settledByPaymentId: payment.id },
    });
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        checkoutSessionId: checkout.id,
        type: "OTHER_PRODUCT",
        status: "PAID",
        productId: personalizedProduct.id,
        paymentId: payment.id,
        finalPriceToman: PRICE,
      },
    });
    const recorder = sendRecorder();
    await dispatchPaidOrderFulfillment(recorder.api, order.id, { source: "RECEIPT", user });
    const record = await prisma.otherProductOrder.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(record.status).toBe("WAITING_ADMIN_DELIVERY");
    const input = await prisma.checkoutCustomerInput.findUniqueOrThrow({
      where: { checkoutSessionId: checkout.id },
    });
    expect(input.status).toBe("CONSUMED");
    expect(input.consumedByOtherProductOrderId).toBe(record.id);
  });

  it("8/9/10. zero stock personalized Apple still creates a manual order — no reserve, no out-of-stock", async () => {
    const user = await createUser();
    const checkout = await makeCheckout(user, personalizedProduct);
    await submitInfo(checkout.id, user);
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        checkoutSessionId: checkout.id,
        type: "OTHER_PRODUCT",
        status: "PAID",
        productId: personalizedProduct.id,
        finalPriceToman: PRICE,
      },
    });
    const recorder = sendRecorder();
    await dispatchPaidOrderFulfillment(recorder.api, order.id, { source: "WALLET", user });
    const record = await prisma.otherProductOrder.findUniqueOrThrow({ where: { orderId: order.id } });
    // Manual queue, never AWAITING_STOCK.
    expect(record.status).toBe("WAITING_ADMIN_DELIVERY");
    // No StockItem reserved/consumed for this product (personalized).
    expect(await prisma.otherProductStockItem.count({ where: { productId: personalizedProduct.id } })).toBe(0);
    // No out-of-stock message to the buyer or admins.
    expect(recorder.allText()).not.toContain("موجودی");
    expect(recorder.allText()).not.toContain("در انتظار شارژ");
  });

  it("11. a stock Apple ID requires inventory: auto-delivers when stocked, parks when empty", async () => {
    // Empty inventory → AWAITING_STOCK (requires inventory).
    const emptyUser = await createUser();
    const emptyCheckout = await makeCheckout(emptyUser, stockProduct);
    const emptyOrder = await prisma.order.create({
      data: {
        userId: emptyUser.id,
        checkoutSessionId: emptyCheckout.id,
        type: "OTHER_PRODUCT",
        status: "PAID",
        productId: stockProduct.id,
        finalPriceToman: PRICE,
      },
    });
    const rec1 = sendRecorder();
    await dispatchPaidOrderFulfillment(rec1.api, emptyOrder.id, { source: "WALLET", user: emptyUser });
    const parked = await prisma.otherProductOrder.findUniqueOrThrow({ where: { orderId: emptyOrder.id } });
    expect(parked.status).toBe("AWAITING_STOCK");

    // Stocked → auto-delivers.
    const okAdded = await addStockItem({
      productId: stockProduct.id,
      content: "appleid@icloud.com\nPassw0rd!",
      label: null,
      createdByAdminId: admin.id,
    });
    expect(okAdded.ok).toBe(true);
    const buyer = await createUser();
    const checkout = await makeCheckout(buyer, stockProduct);
    const order = await prisma.order.create({
      data: {
        userId: buyer.id,
        checkoutSessionId: checkout.id,
        type: "OTHER_PRODUCT",
        status: "PAID",
        productId: stockProduct.id,
        finalPriceToman: PRICE,
      },
    });
    const rec2 = sendRecorder();
    await dispatchPaidOrderFulfillment(rec2.api, order.id, { source: "WALLET", user: buyer });
    const delivered = await prisma.otherProductOrder.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(delivered.status).toBe("DELIVERED");
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("COMPLETED");
    expect(rec2.textsTo(buyer.telegramId.toString()).some((t) => t.includes("appleid@icloud.com"))).toBe(true);
  });

  it("12/13. changing the mode affects only FUTURE checkouts; frozen snapshots are immutable", async () => {
    const product = await createProduct({
      name: `apple-flip-${runTag}`,
      deliveryType: "MANUAL_ADMIN",
      otherProductKind: "APPLE_ID",
      otherProductFulfillmentProfile: "PERSONALIZED_SERVICE",
      requiredUserInfoEnabled: true,
      collectInfoBeforeManualApproval: true,
      stockEnabled: false,
      customerInputSchema: JSON.parse(JSON.stringify(PERSONALIZED_APPLE_ID_DEFAULT_SCHEMA)),
    });
    const user = await createUser();
    const checkoutA = await makeCheckout(user, product);
    expect((checkoutA.otherProductFulfillmentSnapshot as Record<string, unknown>).profile).toBe(
      "PERSONALIZED_SERVICE",
    );
    // Admin flips the product to ready-from-stock.
    await prisma.product.update({
      where: { id: product.id },
      data: {
        otherProductFulfillmentProfile: "STOCK_CREDENTIAL",
        otherProductStockParser: "EMAIL_BOUNDARY",
        requiredUserInfoEnabled: false,
        collectInfoBeforeManualApproval: false,
        deliveryType: "STOCK_ITEM",
        stockEnabled: true,
      },
    });
    const checkoutB = await makeCheckout(user, product);
    expect((checkoutB.otherProductFulfillmentSnapshot as Record<string, unknown>).profile).toBe(
      "STOCK_CREDENTIAL",
    );
    // The earlier checkout keeps its original personalized snapshot.
    const reloadedA = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkoutA.id } });
    expect((reloadedA.otherProductFulfillmentSnapshot as Record<string, unknown>).profile).toBe(
      "PERSONALIZED_SERVICE",
    );
  });

  it("14. double settlement produces ONE OtherProductOrder and ONE admin notification", async () => {
    const user = await createUser();
    const checkout = await makeCheckout(user, personalizedProduct);
    await submitInfo(checkout.id, user);
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        checkoutSessionId: checkout.id,
        type: "OTHER_PRODUCT",
        status: "PAID",
        productId: personalizedProduct.id,
        finalPriceToman: PRICE,
      },
    });
    const recorder = sendRecorder();
    await dispatchPaidOrderFulfillment(recorder.api, order.id, { source: "WALLET", user });
    const before = recorder.calls.length;
    await dispatchPaidOrderFulfillment(recorder.api, order.id, { source: "WALLET", user });
    await dispatchPaidOrderFulfillment(recorder.api, order.id, { source: "WALLET", user });
    expect(recorder.calls.length).toBe(before);
    expect(await prisma.otherProductOrder.count({ where: { orderId: order.id } })).toBe(1);
    const adminNotices = recorder
      .textsTo(admin.telegramId.toString())
      .filter((t) => t.includes("سفارش دستی جدید"));
    expect(adminNotices).toHaveLength(1);
  });

  it("15. customer information is encrypted at rest; raw values are not stored in plaintext", async () => {
    const user = await createUser();
    const checkout = await makeCheckout(user, personalizedProduct);
    await submitInfo(checkout.id, user);
    const input = await prisma.checkoutCustomerInput.findUniqueOrThrow({
      where: { checkoutSessionId: checkout.id },
    });
    expect(input.valuesEncrypted).not.toBeNull();
    // The stored blob is ciphertext, not the raw email.
    expect(input.valuesEncrypted as string).not.toContain(APPLE_VALUES.recovery_email);
    // Only the round-trip decode reveals the values.
    expect(decodeValuesEncrypted(input.valuesEncrypted as string)).toEqual(APPLE_VALUES);
  });

  it("16. admin manual delivery completes the personalized Apple order normally", async () => {
    const user = await createUser();
    const checkout = await makeCheckout(user, personalizedProduct);
    await submitInfo(checkout.id, user);
    const order = await prisma.order.create({
      data: {
        userId: user.id,
        checkoutSessionId: checkout.id,
        type: "OTHER_PRODUCT",
        status: "PAID",
        productId: personalizedProduct.id,
        finalPriceToman: PRICE,
      },
    });
    const recorder = sendRecorder();
    await dispatchPaidOrderFulfillment(recorder.api, order.id, { source: "WALLET", user });
    const record = await prisma.otherProductOrder.findUniqueOrThrow({ where: { orderId: order.id } });
    expect(record.status).toBe("WAITING_ADMIN_DELIVERY");

    const outcome = await deliverManualOrder(recorder.api, {
      recordId: record.id,
      adminId: admin.id,
      deliveryText: "Apple ID: built.person@icloud.com / TempPass!23",
    });
    expect(outcome.ok).toBe(true);
    const done = await prisma.otherProductOrder.findUniqueOrThrow({ where: { id: record.id } });
    expect(done.status).toBe("DELIVERED");
    const finalOrder = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(finalOrder.status).toBe("COMPLETED");
    expect(recorder.textsTo(user.telegramId.toString()).some((t) => t.includes("built.person@icloud.com"))).toBe(
      true,
    );
  });

  it("17. the other OTHER_PRODUCT kinds resolve unchanged (no regression)", () => {
    const base: ProfileProductFields = {
      otherProductKind: "GENERIC",
      otherProductFulfillmentProfile: null,
      otherProductStockParser: null,
      collectInfoBeforeManualApproval: false,
      customerInputSchema: null,
      completionMessageTemplate: null,
      requiredUserInfoEnabled: false,
      requiredUserInfoPromptText: null,
      deliveryType: "STOCK_ITEM",
      stockEnabled: true,
    };
    // GENERIC legacy: stock delivery from the legacy columns.
    expect(resolveEffectiveProfile(base).profile).toBe("STOCK_CREDENTIAL");
    // AI account, both modes.
    expect(
      resolveEffectiveProfile({ ...base, otherProductKind: "AI_ACCOUNT", otherProductFulfillmentProfile: "STOCK_CREDENTIAL" }).profile,
    ).toBe("STOCK_CREDENTIAL");
    expect(
      resolveEffectiveProfile({ ...base, otherProductKind: "AI_ACCOUNT", otherProductFulfillmentProfile: "PERSONALIZED_SERVICE" }).requiresCustomerInfo,
    ).toBe(true);
    // Telegram Premium personalized, gift card stock.
    expect(
      resolveEffectiveProfile({ ...base, otherProductKind: "TELEGRAM_PREMIUM", otherProductFulfillmentProfile: "PERSONALIZED_SERVICE" }).collectInfoBeforeManualApproval,
    ).toBe(true);
    expect(
      resolveEffectiveProfile({ ...base, otherProductKind: "GIFT_CARD", otherProductFulfillmentProfile: "STOCK_CODE" }).profile,
    ).toBe("STOCK_CODE");
    // Apple stock still parses email-boundary, personalized still needs info.
    expect(buildFulfillmentSnapshot(stockProduct as ProfileProductFields).stockParser).toBe("EMAIL_BOUNDARY");
  });

  it("18. requireInfoBeforeSettlement is true ONLY for personalized Apple; other personalized kinds stay post-payment", () => {
    const personalizedApple = buildFulfillmentSnapshot(personalizedProduct as ProfileProductFields);
    expect(personalizedApple.requireInfoBeforeSettlement).toBe(true);
    expect(buildFulfillmentSnapshot(stockProduct as ProfileProductFields).requireInfoBeforeSettlement).toBe(
      false,
    );
    const base: ProfileProductFields = {
      otherProductKind: "AI_ACCOUNT",
      otherProductFulfillmentProfile: "PERSONALIZED_SERVICE",
      otherProductStockParser: null,
      collectInfoBeforeManualApproval: true,
      customerInputSchema: null,
      completionMessageTemplate: null,
      requiredUserInfoEnabled: true,
      requiredUserInfoPromptText: null,
      deliveryType: "MANUAL_ADMIN",
      stockEnabled: false,
    };
    // AI + Telegram Premium personalized keep post-payment collection.
    expect(resolveEffectiveProfile(base).requireInfoBeforeSettlement).toBe(false);
    expect(
      resolveEffectiveProfile({ ...base, otherProductKind: "TELEGRAM_PREMIUM" })
        .requireInfoBeforeSettlement,
    ).toBe(false);
  });

  it("19. the settlement gate blocks personalized Apple before info and only AFTER submit; never blocks post-payment kinds", async () => {
    const user = await createUser();
    const appleCheckout = await makeCheckout(user, personalizedProduct);
    expect(await isMandatoryCustomerInfoMissing(appleCheckout)).toBe(true);
    await submitInfo(appleCheckout.id, user);
    const afterApple = await prisma.checkoutSession.findUniqueOrThrow({
      where: { id: appleCheckout.id },
    });
    expect(await isMandatoryCustomerInfoMissing(afterApple)).toBe(false);

    // A post-payment kind (AI personalized) is NEVER blocked at settlement even
    // with no info submitted - it collects info in the WAITING_USER_INFO queue.
    const aiProduct = await createProduct({
      name: `apple-ai-${runTag}`,
      deliveryType: "MANUAL_ADMIN",
      otherProductKind: "AI_ACCOUNT",
      otherProductFulfillmentProfile: "PERSONALIZED_SERVICE",
      requiredUserInfoEnabled: true,
      collectInfoBeforeManualApproval: true,
      stockEnabled: false,
      customerInputSchema: JSON.parse(JSON.stringify(PERSONALIZED_AI_DEFAULT_SCHEMA)),
    });
    const aiCheckout = await makeCheckout(user, aiProduct);
    expect(await isMandatoryCustomerInfoMissing(aiCheckout)).toBe(false);
    // Stock Apple is never blocked (requires no info).
    const stockCheckout = await makeCheckout(user, stockProduct);
    expect(await isMandatoryCustomerInfoMissing(stockCheckout)).toBe(false);
  });

  it("20. CARD receipt approval FAILS CLOSED for personalized Apple without info, and settles after submit", async () => {
    const user = await createUser();
    const checkout = await makeCheckout(user, personalizedProduct);
    const submitted = await submitReceipt(user, checkout, cardGateway.id, undefined, {
      text: "کارت به کارت انجام شد",
    });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok) {
      return;
    }
    const paymentId = submitted.payment.id;

    // Direct settlement call cannot bypass the form: approval is refused, the
    // checkout stays PENDING and no paid Order is created.
    const blocked = await approveReceiptPayment(paymentId, admin);
    expect(blocked.ok).toBe(false);
    expect(
      (await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkout.id } })).status,
    ).toBe("PENDING");
    expect(await prisma.order.count({ where: { checkoutSessionId: checkout.id } })).toBe(0);

    // After the buyer submits the form, the same call settles normally.
    await submitInfo(checkout.id, user);
    const ok = await approveReceiptPayment(paymentId, admin);
    expect(ok.ok).toBe(true);
    expect(
      (await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkout.id } })).status,
    ).toBe("PAID");
  });

  it("21. wallet resumes the FROZEN personalized checkout even after the product is flipped to stock (mode immutability)", async () => {
    const user = await createUser();
    const flipProduct = await createProduct({
      name: `apple-flip-${runTag}`,
      deliveryType: "MANUAL_ADMIN",
      otherProductKind: "APPLE_ID",
      otherProductFulfillmentProfile: "PERSONALIZED_SERVICE",
      requiredUserInfoEnabled: true,
      collectInfoBeforeManualApproval: true,
      stockEnabled: false,
      customerInputSchema: JSON.parse(JSON.stringify(PERSONALIZED_APPLE_ID_DEFAULT_SCHEMA)),
    });
    const draft = draftFor(flipProduct);
    const balanceBefore = user.balanceToman;

    // First tap materializes a personalized PENDING checkout (no money moves).
    const first = await payPurchaseDraftWithWallet(user, draft);
    expect(first.ok).toBe(false);
    if (first.ok || !("needsCustomerInfo" in first)) {
      throw new Error("expected needsCustomerInfo");
    }
    const pendingId = first.checkoutId;
    draft.otherProductCheckoutId = pendingId;

    // Admin flips the product to ready-from-stock BEFORE the buyer settles.
    await prisma.product.update({
      where: { id: flipProduct.id },
      data: {
        otherProductFulfillmentProfile: "STOCK_CREDENTIAL",
        otherProductStockParser: "EMAIL_BOUNDARY",
        requiredUserInfoEnabled: false,
        collectInfoBeforeManualApproval: false,
        deliveryType: "STOCK_ITEM",
        stockEnabled: true,
      },
    });

    // The buyer confirms the form and taps again: the FROZEN personalized
    // checkout settles - never a new stock checkout - and dispatch routes to the
    // manual queue, touching no stock.
    await submitInfo(pendingId, user);
    const second = await payPurchaseDraftWithWallet(user, draft);
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    expect(second.checkout.id).toBe(pendingId);
    const recorder = sendRecorder();
    await dispatchPaidOrderFulfillment(recorder.api, second.order.id, { source: "WALLET", user });
    const record = await prisma.otherProductOrder.findUniqueOrThrow({
      where: { orderId: second.order.id },
    });
    expect(record.status).toBe("WAITING_ADMIN_DELIVERY");
    // No stock was ever reserved for this order.
    expect(
      await prisma.otherProductStockItem.count({ where: { deliveredOrderId: second.order.id } }),
    ).toBe(0);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.balanceToman).toBe(balanceBefore - PRICE);
  });

  it("22. a ready-from-stock wallet checkout freezes its fulfillment snapshot on the PAID checkout", async () => {
    const user = await createUser();
    // Give the stock product an item so the wallet purchase settles.
    await addStockItem({
      productId: stockProduct.id,
      content: "frozen.snap@example.com\npw-frozen-1",
      label: null,
      createdByAdminId: admin.id,
    });
    const second = await payPurchaseDraftWithWallet(user, draftFor(stockProduct));
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }
    const paid = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: second.checkout.id } });
    const snap = paid.otherProductFulfillmentSnapshot as Record<string, unknown> | null;
    expect(snap).not.toBeNull();
    expect(snap?.profile).toBe("STOCK_CREDENTIAL");
    expect(snap?.kind).toBe("APPLE_ID");
  });

  it("23. an EXPIRED materialized wallet checkout can never settle (fails closed)", async () => {
    const user = await createUser();
    const draft = draftFor(personalizedProduct);
    const balanceBefore = user.balanceToman;
    const first = await payPurchaseDraftWithWallet(user, draft);
    if (first.ok || !("needsCustomerInfo" in first)) {
      throw new Error("expected needsCustomerInfo");
    }
    const pendingId = first.checkoutId;
    draft.otherProductCheckoutId = pendingId;
    await submitInfo(pendingId, user);
    // The buyer leaves the confirmation open past expiry.
    await prisma.checkoutSession.update({
      where: { id: pendingId },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const second = await payPurchaseDraftWithWallet(user, draft);
    // Not settled: the expired checkout is not resumed and a fresh one needs the
    // form again; no money moved.
    expect(second.ok).toBe(false);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.balanceToman).toBe(balanceBefore);
    const stale = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: pendingId } });
    expect(stale.status).not.toBe("PAID");
  });

  it("24. a second materialize cancels the superseded pending wallet checkout and abandons its input", async () => {
    const user = await createUser();
    const firstDraft = draftFor(personalizedProduct);
    const a = await payPurchaseDraftWithWallet(user, firstDraft);
    if (a.ok || !("needsCustomerInfo" in a)) {
      throw new Error("expected needsCustomerInfo");
    }
    const checkoutA = a.checkoutId;
    await submitInfo(checkoutA, user);
    // A brand-new draft (no otherProductCheckoutId) materializes a fresh
    // checkout, superseding A.
    const secondDraft = draftFor(personalizedProduct);
    const b = await payPurchaseDraftWithWallet(user, secondDraft);
    if (b.ok || !("needsCustomerInfo" in b)) {
      throw new Error("expected needsCustomerInfo");
    }
    const checkoutB = b.checkoutId;
    expect(checkoutB).not.toBe(checkoutA);
    expect(
      (await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkoutA } })).status,
    ).toBe("CANCELLED");
    expect(
      (await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkoutB } })).status,
    ).toBe("PENDING");
    // A's SUBMITTED input is PRESERVED (not abandoned): if A carried an in-flight
    // gateway payment, a later provider success must still find the info
    // satisfied so settleGatewayPayment reaches duplicate-success reconciliation
    // instead of stranding the charge. The settlement gate on A is therefore
    // NOT blocked.
    const preservedInput = await prisma.checkoutCustomerInput.findUnique({
      where: { checkoutSessionId: checkoutA },
    });
    expect(preservedInput?.status).toBe("SUBMITTED");
    const cancelledA = await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkoutA } });
    expect(await isMandatoryCustomerInfoMissing(cancelledA)).toBe(false);
    // Exactly one live PENDING checkout for this user+product remains.
    expect(
      await prisma.checkoutSession.count({
        where: { userId: user.id, productId: personalizedProduct.id, status: "PENDING" },
      }),
    ).toBe(1);

    // An IN-PROGRESS (COLLECTING, never submitted) input IS abandoned when its
    // checkout is superseded, so dead form state is cleaned up.
    await getOrCreateCheckoutInput(checkoutB, user.id, PERSONALIZED_APPLE_ID_DEFAULT_SCHEMA);
    const thirdDraft = draftFor(personalizedProduct);
    const c = await payPurchaseDraftWithWallet(user, thirdDraft);
    if (c.ok || !("needsCustomerInfo" in c)) {
      throw new Error("expected needsCustomerInfo");
    }
    expect(
      (await prisma.checkoutSession.findUniqueOrThrow({ where: { id: checkoutB } })).status,
    ).toBe("CANCELLED");
    const collectingInput = await prisma.checkoutCustomerInput.findUnique({
      where: { checkoutSessionId: checkoutB },
    });
    expect(collectingInput?.status).toBe("ABANDONED");
  });

  it("25. the safe masked summary masks the personal identity fields but keeps country/region visible", () => {
    const summary = renderSafeSummary(PERSONALIZED_APPLE_ID_DEFAULT_SCHEMA, {
      ...APPLE_VALUES,
      phone: "09120000000",
      extra_note: "no note",
    });
    // Masked (sensitive) fields never appear verbatim.
    expect(summary).not.toContain("Rezaei");
    expect(summary).not.toContain("recover.person@example.com");
    expect(summary).not.toContain("09120000000");
    // Country/region (not identifying) stays readable.
    expect(summary).toContain("United States");
  });

  it("26. personalized Apple detail hides the ineffective legacy user-info toggle; a legacy manual kind keeps it", async () => {
    const persKb = productDetailKeyboard(await productWithRelations(personalizedProduct.id));
    const persCodes = persKb.inline_keyboard.flat().map((b) => ("callback_data" in b ? b.callback_data : ""));
    // The legacy requiredUserInfoEnabled toggle (admin:prod:rui:) is suppressed:
    // a PERSONALIZED_SERVICE always requires the structured form, so the toggle
    // would falsely report info as disabled.
    expect(persCodes.some((c) => c?.startsWith("admin:prod:rui:"))).toBe(false);

    // A legacy GENERIC manual product keeps the free-text toggle.
    const generic = await createProduct({
      name: `apple-generic-${runTag}`,
      otherProductKind: "GENERIC",
      otherProductFulfillmentProfile: null,
      deliveryType: "MANUAL_ADMIN",
      requiredUserInfoEnabled: true,
      stockEnabled: false,
    });
    const genKb = productDetailKeyboard(await productWithRelations(generic.id));
    const genCodes = genKb.inline_keyboard.flat().map((b) => ("callback_data" in b ? b.callback_data : ""));
    expect(genCodes.some((c) => c?.startsWith("admin:prod:rui:"))).toBe(true);
  });
});

describe.skipIf(hasDb)("Apple ID personalized fulfillment (skipped — no DATABASE_URL)", () => {
  it("requires DATABASE_URL", () => {
    expect(hasDb).toBe(false);
  });
});
