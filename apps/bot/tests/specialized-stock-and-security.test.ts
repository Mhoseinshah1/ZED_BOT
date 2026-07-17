import { randomUUID } from "node:crypto";

import {
  prisma,
  type Admin,
  type CheckoutSession,
  type Order,
  type OtherProductFulfillmentProfile,
  type OtherProductKind,
  type OtherProductStockParser,
  type Product,
  type User,
} from "@zedbot/database";
import { maskSecretEdges } from "@zedbot/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "specialized-stock-security-tests-1";

import { initialSession } from "../src/core/session.js";
import { manualOrdersHandler } from "../src/handlers/admin-manual-orders/manual-orders.handler.js";
import {
  abandonCheckoutInput,
  CUSTOMER_INPUT_FORM_NOT_FOUND_TEXT,
  CUSTOMER_INPUT_RETENTION_DAYS_KEY,
  getOrCreateCheckoutInput,
  runCheckoutInputRetentionSweep,
  submitCheckoutInput,
} from "../src/services/checkout-customer-input.service.js";
import { createCheckoutSession } from "../src/services/checkout.service.js";
import {
  encodeValuesEncrypted,
  PERSONALIZED_AI_DEFAULT_SCHEMA,
  renderSafeSummary,
  validateCustomerInputSchema,
  type CustomerInputSchema,
} from "../src/services/customer-input-schema.service.js";
import {
  dispatchPaidOrderFulfillment,
  INFO_REQUIRED_FOLLOWUP_TEXT,
} from "../src/services/order-fulfillment.service.js";
import { importStockItems } from "../src/services/other-product-stock-import.service.js";
import {
  addStockItem,
  finalizeStockDelivery,
  releaseStockClaim,
  reserveStockItemForOrder,
} from "../src/services/other-product-stock.service.js";
import { approveReceiptPayment } from "../src/services/receipt-review.service.js";
import {
  onCustomerInputCompleted,
  retryAwaitingStockOrders,
} from "../src/services/specialized-product-fulfillment.service.js";
import {
  clearSettingsCache,
  deleteSetting,
  setSetting,
} from "../src/services/settings.service.js";

// =============================================================================
// Specialized-workflows phase - §13 stock guarantees and security surface:
// DB-unique one-item-per-order, replenishment retry ordering, no credential
// re-send on repeated dispatch, gift-card SINGLE_LINE import + settlement
// gating + distinct codes under concurrency, both AI_ACCOUNT modes, and the
// security invariants (owner checks, encryption at rest, masked summaries,
// no secrets in logs or AuditLog metadata, HTML escaping). Requires the
// shared test PostgreSQL (docs/testing.md); cleans up its fixtures.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

const ADMIN_READY_MARKER = "سفارش دستی جدید 📦";
const PRICE = 100_000;

let admin: Admin;
let categoryId: string;

const userIds: string[] = [];
const productIds: string[] = [];

const SECURE_SCHEMA: CustomerInputSchema = {
  version: 1,
  fields: [
    { key: "account_email", label: "ایمیل حساب", required: true, type: "EMAIL", order: 1 },
    {
      key: "account_password",
      label: "رمز عبور حساب",
      required: true,
      type: "TEXT",
      order: 2,
      sensitive: true,
      securityWarning: true,
    },
  ],
};
const SECRET_EMAIL = `secure.${runTag}@example.com`;
const SECRET_PASSWORD = `TopSecretPW-${runTag}!`;

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

async function createSpecializedProduct(config: {
  kind: OtherProductKind;
  profile: OtherProductFulfillmentProfile;
  parser?: OtherProductStockParser;
  schema?: CustomerInputSchema;
}): Promise<Product> {
  seq += 1;
  const stock = config.profile === "STOCK_CREDENTIAL" || config.profile === "STOCK_CODE";
  const product = await prisma.product.create({
    data: {
      type: "OTHER_PRODUCT",
      categoryId,
      name: `sss-${config.kind.toLowerCase()}-${seq}-${runTag}`,
      priceToman: PRICE,
      isActive: true,
      deliveryType: stock ? "STOCK_ITEM" : "MANUAL_ADMIN",
      stockEnabled: stock,
      requiredUserInfoEnabled: config.profile === "PERSONALIZED_SERVICE",
      collectInfoBeforeManualApproval: config.profile === "PERSONALIZED_SERVICE",
      otherProductKind: config.kind,
      otherProductFulfillmentProfile: config.profile,
      otherProductStockParser: config.parser ?? null,
      ...(config.schema !== undefined
        ? { customerInputSchema: JSON.parse(JSON.stringify(config.schema)) }
        : {}),
    },
  });
  productIds.push(product.id);
  return product;
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

async function addItem(product: Product, content: string) {
  const outcome = await addStockItem({
    productId: product.id,
    content,
    label: null,
    createdByAdminId: admin.id,
  });
  expect(outcome.ok).toBe(true);
  if (!outcome.ok) {
    throw new Error("addStockItem failed");
  }
  return outcome.item;
}

/** Captures everything written to stdout/stderr while fn runs (pass-through). */
async function captureProcessOutput<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; output: string }> {
  const chunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const wrap = (orig: (...args: never[]) => boolean) =>
    ((chunk: string | Uint8Array, ...rest: never[]) => {
      chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      return orig(chunk as never, ...rest);
    }) as typeof process.stdout.write;
  process.stdout.write = wrap(origOut as never);
  process.stderr.write = wrap(origErr as never);
  try {
    const result = await fn();
    return { result, output: chunks.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

async function dispatchAdminCallback(data: string) {
  const replies: Array<{ text: string; other?: Record<string, unknown> }> = [];
  const toasts: Array<string | undefined> = [];
  const from = { id: Number(admin.telegramId), is_bot: false, first_name: "Admin" };
  const callbackQuery = { id: "cbq-sec", chat_instance: "ci-sec", from, data };
  const ctx = {
    session: initialSession(),
    admin,
    dbUser: null,
    api: sendRecorder().api,
    callbackQuery,
    update: { update_id: 7, callback_query: callbackQuery },
    reply: async (text: string, other?: Record<string, unknown>) => {
      replies.push({ text, other });
      return {};
    },
    answerCallbackQuery: async (payload?: { text?: string }) => {
      toasts.push(payload?.text);
      return true;
    },
  };
  await manualOrdersHandler.middleware()(ctx as never, async () => {});
  return { replies, toasts };
}

describe.runIf(hasDb)("specialized stock guarantees + security (§13)", () => {
  beforeAll(async () => {
    const category = await prisma.productCategory.create({
      data: { type: "OTHER_PRODUCT", name: `sss-cat-${runTag}`, isActive: true },
    });
    categoryId = category.id;
    admin = await prisma.admin.create({
      data: { telegramId: runTag + 940_000_000n, role: "OWNER", isActive: true },
    });
  });

  afterAll(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await deleteSetting(CUSTOMER_INPUT_RETENTION_DAYS_KEY);
    clearSettingsCache();
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
    await prisma.otherProductStockItem.deleteMany({ where: { productId: { in: productIds } } });
    await prisma.payment.deleteMany({ where: users });
    await prisma.order.deleteMany({ where: users });
    await prisma.checkoutSession.deleteMany({ where: users });
    await prisma.auditLog.deleteMany({ where: { actorTelegramId: admin.telegramId } });
    await prisma.product.deleteMany({ where: { categoryId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma.admin.deleteMany({ where: { id: admin.id } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("1. one order can never hold two stock items (scoped CAS + DB unique)", async () => {
    const product = await createSpecializedProduct({
      kind: "APPLE_ID",
      profile: "STOCK_CREDENTIAL",
      parser: "EMAIL_BOUNDARY",
    });
    const item1 = await addItem(product, `unique-a-${runTag}`);
    const item2 = await addItem(product, `unique-b-${runTag}`);
    const user = await createUser();
    const { order } = await createPaidOrder(user, product);

    const first = await reserveStockItemForOrder(order.id, product.id, user.id);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.item.id).toBe(item1.id);
    expect(first.resumed).toBe(false);

    // A second reserve for the SAME order resumes the same claim.
    const second = await reserveStockItemForOrder(order.id, product.id, user.id);
    expect(second.ok && second.item.id === item1.id && second.resumed).toBe(true);

    // Foreign-order finalize/release are scoped no-ops.
    const foreignOrderId = randomUUID();
    expect(await finalizeStockDelivery(item1.id, foreignOrderId)).toBe(false);
    expect(await releaseStockClaim(item1.id, foreignOrderId)).toBe(false);

    // Raw second-claim insert violates the deliveredOrderId unique.
    await expect(
      prisma.otherProductStockItem.update({
        where: { id: item2.id },
        data: { deliveredOrderId: order.id },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    expect(await finalizeStockDelivery(item1.id, order.id)).toBe(true);
    const rows = await prisma.otherProductStockItem.findMany({
      where: { deliveredOrderId: order.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(item1.id);
  });

  it("2. replenishment retry completes the OLDEST awaiting-stock order first", async () => {
    const product = await createSpecializedProduct({
      kind: "APPLE_ID",
      profile: "STOCK_CREDENTIAL",
      parser: "EMAIL_BOUNDARY",
    });
    const userA = await createUser();
    const userB = await createUser();
    const a = await createPaidOrder(userA, product);
    const recorderPark = sendRecorder();
    await dispatchPaidOrderFulfillment(recorderPark.api, a.order.id, { source: "WALLET" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const b = await createPaidOrder(userB, product);
    await dispatchPaidOrderFulfillment(recorderPark.api, b.order.id, { source: "WALLET" });

    for (const order of [a.order, b.order]) {
      const record = await prisma.otherProductOrder.findUniqueOrThrow({
        where: { orderId: order.id },
      });
      expect(record.status).toBe("AWAITING_STOCK");
    }

    await addItem(product, `replenish-1-${runTag}`);
    const recorder = sendRecorder();
    const firstPass = await retryAwaitingStockOrders(recorder.api, product.id);
    expect(firstPass).toEqual({ completed: 1, remaining: 1 });
    expect(
      (await prisma.otherProductOrder.findUniqueOrThrow({ where: { orderId: a.order.id } })).status,
    ).toBe("DELIVERED");
    expect(
      (await prisma.otherProductOrder.findUniqueOrThrow({ where: { orderId: b.order.id } })).status,
    ).toBe("AWAITING_STOCK");
    expect(recorder.textsTo(userA.telegramId.toString()).join("\n")).toContain(
      `replenish-1-${runTag}`,
    );

    await addItem(product, `replenish-2-${runTag}`);
    const secondPass = await retryAwaitingStockOrders(recorder.api, product.id);
    expect(secondPass).toEqual({ completed: 1, remaining: 0 });
    expect(
      (await prisma.otherProductOrder.findUniqueOrThrow({ where: { orderId: b.order.id } })).status,
    ).toBe("DELIVERED");
  });

  it("3. duplicate dispatch after delivery never re-sends credentials", async () => {
    const product = await createSpecializedProduct({
      kind: "APPLE_ID",
      profile: "STOCK_CREDENTIAL",
      parser: "EMAIL_BOUNDARY",
    });
    await addItem(product, `once-only-${runTag}`);
    const user = await createUser();
    const { order } = await createPaidOrder(user, product);

    const recorder = sendRecorder();
    await dispatchPaidOrderFulfillment(recorder.api, order.id, { source: "WALLET" });
    const sendsAfterFirst = recorder.calls.length;
    expect(
      recorder.textsTo(user.telegramId.toString()).filter((t) => t.includes(`once-only-${runTag}`)),
    ).toHaveLength(1);

    for (let i = 0; i < 3; i += 1) {
      await dispatchPaidOrderFulfillment(recorder.api, order.id, { source: "WALLET" });
    }
    expect(recorder.calls.length).toBe(sendsAfterFirst);
    expect(
      await prisma.otherProductStockItem.count({ where: { deliveredOrderId: order.id } }),
    ).toBe(1);
  });

  it("4. gift-card SINGLE_LINE import: one code per non-empty line, blanks ignored", async () => {
    const product = await createSpecializedProduct({
      kind: "GIFT_CARD",
      profile: "STOCK_CODE",
      parser: "SINGLE_LINE",
    });
    const raw = `GIFT-${runTag}-01\n\n   \nGIFT-${runTag}-02\r\nGIFT-${runTag}-03\n\n`;
    const result = await importStockItems(product.id, admin.id, "SINGLE_LINE", raw);
    expect(result.ok).toBe(true);
    expect(result.importedCount).toBe(3);
    expect(
      await prisma.otherProductStockItem.count({
        where: { productId: product.id, status: "AVAILABLE" },
      }),
    ).toBe(3);
  });

  it("5. a gift code is delivered ONLY after settlement (receipt approval)", async () => {
    const product = await createSpecializedProduct({
      kind: "GIFT_CARD",
      profile: "STOCK_CODE",
      parser: "SINGLE_LINE",
    });
    const item = await addItem(product, `GIFT-SETTLE-${runTag}`);
    const user = await createUser();
    const checkout = await createCheckout(user, product);
    const payment = await prisma.payment.create({
      data: {
        userId: user.id,
        checkoutSessionId: checkout.id,
        purpose: "ORDER_PAYMENT",
        status: "PENDING_REVIEW",
        amountToman: PRICE,
        payableAmountToman: PRICE,
        receipts: { create: { userId: user.id, text: "gift receipt", status: "PENDING_REVIEW" } },
      },
    });

    // Before approval: no order, code untouched, nothing sent anywhere.
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(0);
    expect(
      (await prisma.otherProductStockItem.findUniqueOrThrow({ where: { id: item.id } })).status,
    ).toBe("AVAILABLE");

    const approval = await approveReceiptPayment(payment.id, admin);
    expect(approval.ok).toBe(true);
    if (!approval.ok || approval.kind !== "ORDER_PAYMENT") {
      return;
    }
    const recorder = sendRecorder();
    await dispatchPaidOrderFulfillment(recorder.api, approval.order.id, { source: "RECEIPT" });
    const delivered = await prisma.otherProductStockItem.findUniqueOrThrow({
      where: { id: item.id },
    });
    expect(delivered.status).toBe("DELIVERED");
    expect(delivered.deliveredOrderId).toBe(approval.order.id);
    expect(
      recorder.textsTo(user.telegramId.toString()).some((t) => t.includes(`GIFT-SETTLE-${runTag}`)),
    ).toBe(true);
  });

  it("6. concurrent gift purchases receive DISTINCT codes", async () => {
    const product = await createSpecializedProduct({
      kind: "GIFT_CARD",
      profile: "STOCK_CODE",
      parser: "SINGLE_LINE",
    });
    await addItem(product, `GIFT-D1-${runTag}`);
    await addItem(product, `GIFT-D2-${runTag}`);
    const userA = await createUser();
    const userB = await createUser();
    const a = await createPaidOrder(userA, product);
    const b = await createPaidOrder(userB, product);

    const recorder = sendRecorder();
    await Promise.all([
      dispatchPaidOrderFulfillment(recorder.api, a.order.id, { source: "WALLET" }),
      dispatchPaidOrderFulfillment(recorder.api, b.order.id, { source: "WALLET" }),
    ]);

    const itemA = await prisma.otherProductStockItem.findUniqueOrThrow({
      where: { deliveredOrderId: a.order.id },
    });
    const itemB = await prisma.otherProductStockItem.findUniqueOrThrow({
      where: { deliveredOrderId: b.order.id },
    });
    expect(itemA.id).not.toBe(itemB.id);
    expect(itemA.status).toBe("DELIVERED");
    expect(itemB.status).toBe("DELIVERED");

    // Every code reached exactly one buyer and never crossed over.
    for (const code of [`GIFT-D1-${runTag}`, `GIFT-D2-${runTag}`]) {
      expect(recorder.calls.filter((c) => c.text.includes(code))).toHaveLength(1);
    }
    const aTexts = recorder.textsTo(userA.telegramId.toString()).join("\n");
    const bTexts = recorder.textsTo(userB.telegramId.toString()).join("\n");
    const aCode = aTexts.includes(`GIFT-D1-${runTag}`) ? `GIFT-D1-${runTag}` : `GIFT-D2-${runTag}`;
    const bCode = aCode === `GIFT-D1-${runTag}` ? `GIFT-D2-${runTag}` : `GIFT-D1-${runTag}`;
    expect(aTexts).toContain(aCode);
    expect(aTexts).not.toContain(bCode);
    expect(bTexts).toContain(bCode);
    expect(bTexts).not.toContain(aCode);
  });

  it("7. AI_ACCOUNT ready profile auto-delivers without any info step", async () => {
    const product = await createSpecializedProduct({
      kind: "AI_ACCOUNT",
      profile: "STOCK_CREDENTIAL",
      parser: "SINGLE_LINE",
    });
    await addItem(product, `ai-ready-cred-${runTag}`);
    const user = await createUser();
    const { order } = await createPaidOrder(user, product);

    const recorder = sendRecorder();
    await dispatchPaidOrderFulfillment(recorder.api, order.id, { source: "WALLET" });
    const record = await prisma.otherProductOrder.findUniqueOrThrow({
      where: { orderId: order.id },
    });
    expect(record.status).toBe("DELIVERED");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      "COMPLETED",
    );
    const texts = recorder.textsTo(user.telegramId.toString());
    expect(texts.some((t) => t.includes(`ai-ready-cred-${runTag}`))).toBe(true);
    expect(texts.some((t) => t.includes(INFO_REQUIRED_FOLLOWUP_TEXT))).toBe(false);
    expect(
      recorder.calls.some((c) => JSON.stringify(c.other ?? {}).includes("cinput:start")),
    ).toBe(false);
  });

  it("8. AI personalized: info flow with ONE admin notification across submit + repeats + sweep; CONSUMED never redacted", async () => {
    const product = await createSpecializedProduct({
      kind: "AI_ACCOUNT",
      profile: "PERSONALIZED_SERVICE",
      schema: PERSONALIZED_AI_DEFAULT_SCHEMA,
    });
    // The frozen checkout snapshot wants the info collected BEFORE approval.
    const user = await createUser();
    const { checkout, order } = await createPaidOrder(user, product);
    const snapshot = checkout.otherProductFulfillmentSnapshot as Record<string, unknown>;
    expect(snapshot.requiresCustomerInfo).toBe(true);
    expect(snapshot.collectInfoBeforeManualApproval).toBe(true);

    const recorder = sendRecorder();
    await dispatchPaidOrderFulfillment(recorder.api, order.id, { source: "WALLET" });
    const record = await prisma.otherProductOrder.findUniqueOrThrow({
      where: { orderId: order.id },
    });
    expect(record.status).toBe("WAITING_USER_INFO");
    // The structured form entry button (values collected via the cinput flow).
    expect(
      recorder.calls.some(
        (c) =>
          c.chatId === user.telegramId.toString() &&
          JSON.stringify(c.other ?? {}).includes("cinput:start"),
      ),
    ).toBe(true);
    expect(recorder.textsTo(admin.telegramId.toString())).toHaveLength(0);

    // Buyer submits the structured form; the bridge advances + notifies once.
    const input = await getOrCreateCheckoutInput(
      checkout.id,
      user.id,
      PERSONALIZED_AI_DEFAULT_SCHEMA,
    );
    expect(input?.status).toBe("COLLECTING");
    const submit = await submitCheckoutInput(checkout.id, user.id, {
      account_email: `ai.buyer.${runTag}@example.com`,
      customer_note: "",
    });
    expect(submit.ok).toBe(true);
    await onCustomerInputCompleted(recorder.api, order.id);

    const advanced = await prisma.otherProductOrder.findUniqueOrThrow({
      where: { orderId: order.id },
    });
    expect(advanced.status).toBe("WAITING_ADMIN_DELIVERY");
    expect(advanced.customerInputEncrypted).not.toBeNull();
    expect(advanced.fulfillmentAdminsNotifiedAt).not.toBeNull();

    // Repeat dispatch + repeat bridge + retention sweep: still ONE notification.
    await dispatchPaidOrderFulfillment(recorder.api, order.id, { source: "WALLET" });
    await onCustomerInputCompleted(recorder.api, order.id);
    await setSetting(CUSTOMER_INPUT_RETENTION_DAYS_KEY, "0", "NUMBER");
    clearSettingsCache();
    // A dead-end ABANDONED row IS redacted by the sweep...
    const deadUser = await createUser();
    const deadCheckout = await createCheckout(deadUser, product);
    await getOrCreateCheckoutInput(deadCheckout.id, deadUser.id, PERSONALIZED_AI_DEFAULT_SCHEMA);
    await abandonCheckoutInput(deadCheckout.id);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await runCheckoutInputRetentionSweep();
    await deleteSetting(CUSTOMER_INPUT_RETENTION_DAYS_KEY);
    clearSettingsCache();

    const deadRow = await prisma.checkoutCustomerInput.findUniqueOrThrow({
      where: { checkoutSessionId: deadCheckout.id },
    });
    expect(deadRow.status).toBe("REDACTED");
    expect(deadRow.valuesEncrypted).toBeNull();
    // ...but the CONSUMED submission is the fulfillment record and survives.
    const consumedRow = await prisma.checkoutCustomerInput.findUniqueOrThrow({
      where: { checkoutSessionId: checkout.id },
    });
    expect(consumedRow.status).toBe("CONSUMED");
    expect(consumedRow.valuesEncrypted).not.toBeNull();

    const adminReady = recorder
      .textsTo(admin.telegramId.toString())
      .filter((t) => t.includes(ADMIN_READY_MARKER));
    expect(adminReady).toHaveLength(1);
  });

  it("9. cross-user checkout-input access is rejected at the service level", async () => {
    const product = await createSpecializedProduct({
      kind: "AI_ACCOUNT",
      profile: "PERSONALIZED_SERVICE",
      schema: PERSONALIZED_AI_DEFAULT_SCHEMA,
    });
    const owner = await createUser();
    const attacker = await createUser();
    const checkout = await createCheckout(owner, product);
    const created = await getOrCreateCheckoutInput(checkout.id, owner.id, SECURE_SCHEMA);
    expect(created?.userId).toBe(owner.id);

    // Foreign user: the row resolves to null (access denied), never leaked.
    expect(await getOrCreateCheckoutInput(checkout.id, attacker.id, SECURE_SCHEMA)).toBeNull();
    const foreignSubmit = await submitCheckoutInput(checkout.id, attacker.id, {
      account_email: "attacker@example.com",
      account_password: "attacker-pass",
    });
    expect(foreignSubmit.ok).toBe(false);
    if (!foreignSubmit.ok) {
      expect(foreignSubmit.error).toBe(CUSTOMER_INPUT_FORM_NOT_FOUND_TEXT);
    }
    const row = await prisma.checkoutCustomerInput.findUniqueOrThrow({
      where: { checkoutSessionId: checkout.id },
    });
    expect(row.status).toBe("COLLECTING");
    expect(row.valuesEncrypted).toBeNull();
  });

  it("10. stored values are encrypted at rest and the summary masks sensitive fields", async () => {
    const product = await createSpecializedProduct({
      kind: "AI_ACCOUNT",
      profile: "PERSONALIZED_SERVICE",
      schema: PERSONALIZED_AI_DEFAULT_SCHEMA,
    });
    const user = await createUser();
    const checkout = await createCheckout(user, product);
    await getOrCreateCheckoutInput(checkout.id, user.id, SECURE_SCHEMA);
    const submit = await submitCheckoutInput(checkout.id, user.id, {
      account_email: SECRET_EMAIL,
      account_password: SECRET_PASSWORD,
    });
    expect(submit.ok).toBe(true);

    const row = await prisma.checkoutCustomerInput.findUniqueOrThrow({
      where: { checkoutSessionId: checkout.id },
    });
    // Raw DB payload never contains the plaintext values.
    expect(row.valuesEncrypted).not.toBeNull();
    expect(row.valuesEncrypted).not.toContain(SECRET_PASSWORD);
    expect(row.valuesEncrypted).not.toContain(SECRET_EMAIL);
    // The display summary masks the sensitive field, never the full secret.
    expect(row.renderedSafeSummary).not.toBeNull();
    expect(row.renderedSafeSummary).not.toContain(SECRET_PASSWORD);
    expect(row.renderedSafeSummary).toContain(maskSecretEdges(SECRET_PASSWORD));
  });

  it("11. renderSafeSummary HTML-escapes values (Telegram HTML parse mode safe)", () => {
    const parsed = validateCustomerInputSchema(SECURE_SCHEMA);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    const summary = renderSafeSummary(parsed.schema, {
      account_email: "safe@example.com",
      account_password: "",
    });
    expect(summary).toContain("safe@example.com");

    const withMarkup = renderSafeSummary(
      { version: 1, fields: [{ key: "note", label: "توضیح", required: false, type: "TEXT", order: 1 }] },
      { note: "<b>bold</b> & \"quoted\"" },
    );
    expect(withMarkup).toContain("&lt;b&gt;bold&lt;/b&gt;");
    expect(withMarkup).toContain("&amp;");
    expect(withMarkup).not.toContain("<b>");
  });

  it("12. no secret ever reaches the process logs during a stock delivery + submission", async () => {
    const product = await createSpecializedProduct({
      kind: "GIFT_CARD",
      profile: "STOCK_CODE",
      parser: "SINGLE_LINE",
    });
    const code = `GIFT-LOG-${runTag}`;
    await addItem(product, code);
    const user = await createUser();
    const { checkout, order } = await createPaidOrder(user, product);

    const recorder = sendRecorder();
    const { output } = await captureProcessOutput(async () => {
      await getOrCreateCheckoutInput(checkout.id, user.id, SECURE_SCHEMA);
      await submitCheckoutInput(checkout.id, user.id, {
        account_email: SECRET_EMAIL,
        account_password: SECRET_PASSWORD,
      });
      await dispatchPaidOrderFulfillment(recorder.api, order.id, { source: "WALLET" });
    });
    // The delivery happened (the buyer got the code)...
    expect(recorder.textsTo(user.telegramId.toString()).some((t) => t.includes(code))).toBe(true);
    // ...but neither the stock content nor the customer values were logged.
    expect(output).not.toContain(code);
    expect(output).not.toContain(SECRET_PASSWORD);
    expect(output).not.toContain(SECRET_EMAIL);
  });

  it("13. audited cinfo viewer: masked page masks, AuditLog rows carry ids only", async () => {
    const product = await createSpecializedProduct({
      kind: "AI_ACCOUNT",
      profile: "PERSONALIZED_SERVICE",
      schema: PERSONALIZED_AI_DEFAULT_SCHEMA,
    });
    const user = await createUser();
    const { order } = await createPaidOrder(user, product);
    const values = { account_email: SECRET_EMAIL, account_password: SECRET_PASSWORD };
    const record = await prisma.otherProductOrder.create({
      data: {
        orderId: order.id,
        userId: user.id,
        productId: product.id,
        status: "WAITING_ADMIN_DELIVERY",
        kindSnapshot: "AI_ACCOUNT",
        fulfillmentProfileSnapshot: "PERSONALIZED_SERVICE",
        customerInputSchemaSnapshot: JSON.parse(JSON.stringify(SECURE_SCHEMA)),
        customerInputEncrypted: encodeValuesEncrypted(values),
        customerInputSummary: renderSafeSummary(SECURE_SCHEMA, values),
        customerInputSubmittedAt: new Date(),
      },
    });
    const sid = record.id.slice(0, 8);

    const masked = await dispatchAdminCallback(`admin:mo:cinfo:${sid}`);
    const maskedPage = masked.replies.map((r) => r.text).join("\n");
    expect(maskedPage).toContain(maskSecretEdges(SECRET_PASSWORD));
    expect(maskedPage).not.toContain(SECRET_PASSWORD);

    const full = await dispatchAdminCallback(`admin:mo:cinfo_full:${sid}`);
    const fullPage = full.replies.map((r) => r.text).join("\n");
    // The full view is the deliberate, separately-audited reveal.
    expect(fullPage).toContain(SECRET_PASSWORD);

    const audits = await prisma.auditLog.findMany({
      where: { action: "other_product_customer_input_viewed", entityId: record.id },
      orderBy: { createdAt: "asc" },
    });
    expect(audits).toHaveLength(2);
    expect(audits.map((a) => (a.metadata as Record<string, unknown>).view)).toEqual([
      "masked",
      "full",
    ]);
    for (const audit of audits) {
      const text = JSON.stringify({ ...audit, actorTelegramId: audit.actorTelegramId?.toString() });
      expect(text).not.toContain(SECRET_PASSWORD);
      expect(text).not.toContain(SECRET_EMAIL);
    }
  });
});

describe.skipIf(hasDb)("specialized stock + security (skipped)", () => {
  it("requires DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
