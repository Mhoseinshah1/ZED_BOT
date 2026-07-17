import { prisma, type Product } from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "specialized-wizard-tests-secret-01";

import { initialSession, type ProductAddState, type SessionData } from "../src/core/session.js";
import {
  productHandler,
  productTextHandler,
} from "../src/handlers/products/product.handler.js";
import { PROD_CB } from "../src/handlers/products/product-cb.js";
import {
  PERSONALIZED_AI_DEFAULT_SCHEMA,
  TELEGRAM_PREMIUM_DEFAULT_SCHEMA,
} from "../src/services/customer-input-schema.service.js";

// =============================================================================
// Specialized-workflows phase - §13 "Product wizard". Drives the REAL
// product add-wizard / detail-page composers with fake contexts (the
// log-group-wizard convention): the OTHER_PRODUCT subtype question, the
// per-kind defaults each branch persists on save, the detail-page kind /
// parser / collect-before editors and forged-callback rejection. Requires
// the shared test PostgreSQL (docs/testing.md); cleans up its fixtures.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

const INVALID_OPTION_TEXT = "گزینه نامعتبر است.";
const KIND_QUESTION_TEXT = "نوع محصول را انتخاب کنید:";
const DELIVERY_QUESTION_TEXT = "نوع تحویل را انتخاب کنید:";
const USER_INFO_QUESTION_TEXT = "آیا بعد از خرید باید اطلاعاتی از کاربر گرفته شود؟";
const ORDER_QUESTION_TEXT =
  "این محصول در جایگاه چندم نمایش داده شود؟ عدد بفرستید یا برای انتهای لیست 0 بفرستید.";

let categoryId: string;

interface SentMessage {
  text: string;
  other: Record<string, unknown> | undefined;
}

interface InlineButton {
  text?: string;
  callback_data?: string;
}

function flatButtons(sent: SentMessage | undefined): InlineButton[] {
  const markup = sent?.other?.reply_markup as { inline_keyboard?: InlineButton[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat();
}

const FROM = { id: 4_900_001, is_bot: false, first_name: "Admin" };
const CHAT = { id: 4_900_001, type: "private", first_name: "Admin" };

function baseCtx(session: SessionData) {
  const sent: SentMessage[] = [];
  const toasts: Array<string | undefined> = [];
  const shared = {
    session,
    admin: null,
    dbUser: null,
    reply: async (text: string, other?: Record<string, unknown>) => {
      sent.push({ text, other });
      return {};
    },
    answerCallbackQuery: async (payload?: { text?: string }) => {
      toasts.push(payload?.text);
      return true;
    },
  };
  return { shared, sent, toasts };
}

async function dispatchCb(session: SessionData, data: string) {
  const { shared, sent, toasts } = baseCtx(session);
  const callbackQuery = { id: "cbq-1", chat_instance: "ci-1", from: FROM, data };
  const ctx = { ...shared, callbackQuery, update: { update_id: 1, callback_query: callbackQuery } };
  await productHandler.middleware()(ctx as never, async () => {});
  return { sent, toasts };
}

async function dispatchText(session: SessionData, text: string) {
  const { shared, sent, toasts } = baseCtx(session);
  const message = { message_id: 10, date: 0, chat: CHAT, from: FROM, text };
  const ctx = { ...shared, message, update: { update_id: 2, message } };
  await productTextHandler.middleware()(ctx as never, async () => {});
  return { sent, toasts };
}

function addState(session: SessionData): ProductAddState | undefined {
  return session.temp.productAdd as ProductAddState | undefined;
}

/** ADD_OTHER -> name -> groups -> category; returns the category-step render. */
async function driveToKindStep(session: SessionData, name: string) {
  await dispatchCb(session, PROD_CB.ADD_OTHER);
  await dispatchText(session, name);
  await dispatchCb(session, "admin:prod:f:grp:ALL");
  return dispatchCb(session, `admin:prod:f:cat:${categoryId.slice(0, 8)}`);
}

/** duration -> price -> invoice ("-"). Returns the invoice-step render. */
async function driveDurationPriceInvoice(session: SessionData) {
  await dispatchText(session, "30");
  await dispatchText(session, "120000");
  return dispatchText(session, "-");
}

/** order position -> confirm -> save; returns the saved product row. */
async function driveOrderAndSave(session: SessionData, name: string): Promise<Product> {
  await dispatchText(session, "0");
  expect(addState(session)?.step).toBe("confirm");
  await dispatchCb(session, "admin:prod:f:save");
  const product = await prisma.product.findFirst({ where: { name } });
  expect(product).not.toBeNull();
  return product as Product;
}

describe.runIf(hasDb)("specialized product wizard (§13)", () => {
  beforeAll(async () => {
    const category = await prisma.productCategory.create({
      data: { type: "OTHER_PRODUCT", name: `spw-cat-${runTag}`, isActive: true },
    });
    categoryId = category.id;
  });

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { categoryId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma.$disconnect();
  });

  it("asks the OTHER_PRODUCT subtype right after the category step", async () => {
    const session = initialSession();
    const { sent } = await driveToKindStep(session, `spw-kindq-${runTag}`);
    expect(sent.at(-1)?.text).toBe(KIND_QUESTION_TEXT);
    const codes = flatButtons(sent.at(-1)).map((b) => b.callback_data);
    for (const code of ["APPLE", "AI", "TGP", "GIFT", "GEN"]) {
      expect(codes).toContain(`admin:prod:f:kind:${code}`);
    }
    expect(addState(session)?.step).toBe("otherKind");
  });

  it("APPLE_ID: stock credentials, EMAIL_BOUNDARY, stock on, no info question", async () => {
    const session = initialSession();
    const name = `spw-apple-${runTag}`;
    await driveToKindStep(session, name);
    await dispatchCb(session, "admin:prod:f:kind:APPLE");
    const { sent: invoiceStep } = await driveDurationPriceInvoice(session);
    // No legacy user-info question for APPLE_ID - straight to the order step.
    expect(invoiceStep.at(-1)?.text).toBe(ORDER_QUESTION_TEXT);
    const product = await driveOrderAndSave(session, name);
    expect(product.otherProductKind).toBe("APPLE_ID");
    expect(product.otherProductFulfillmentProfile).toBe("STOCK_CREDENTIAL");
    expect(product.otherProductStockParser).toBe("EMAIL_BOUNDARY");
    expect(product.stockEnabled).toBe(true);
    expect(product.deliveryType).toBe("STOCK_ITEM");
    expect(product.requiredUserInfoEnabled).toBe(false);
    expect(product.collectInfoBeforeManualApproval).toBe(false);
    expect(product.customerInputSchema).toBeNull();
  });

  it("AI_ACCOUNT ready: stock credentials with the admin-picked parser", async () => {
    const session = initialSession();
    const name = `spw-ai-ready-${runTag}`;
    await driveToKindStep(session, name);
    await dispatchCb(session, "admin:prod:f:kind:AI");
    await dispatchCb(session, "admin:prod:f:ai:ready");
    await dispatchCb(session, "admin:prod:f:sp:SEP");
    await driveDurationPriceInvoice(session);
    const product = await driveOrderAndSave(session, name);
    expect(product.otherProductKind).toBe("AI_ACCOUNT");
    expect(product.otherProductFulfillmentProfile).toBe("STOCK_CREDENTIAL");
    expect(product.otherProductStockParser).toBe("EXPLICIT_SEPARATOR");
    expect(product.stockEnabled).toBe(true);
    expect(product.requiredUserInfoEnabled).toBe(false);
    expect(product.customerInputSchema).toBeNull();
  });

  it("AI_ACCOUNT personalized: PERSONALIZED_SERVICE, collect-before, preset AI schema", async () => {
    const session = initialSession();
    const name = `spw-ai-pers-${runTag}`;
    await driveToKindStep(session, name);
    await dispatchCb(session, "admin:prod:f:kind:AI");
    await dispatchCb(session, "admin:prod:f:ai:pers");
    await dispatchCb(session, "admin:prod:f:fp:AI");
    await driveDurationPriceInvoice(session);
    const product = await driveOrderAndSave(session, name);
    expect(product.otherProductKind).toBe("AI_ACCOUNT");
    expect(product.otherProductFulfillmentProfile).toBe("PERSONALIZED_SERVICE");
    expect(product.otherProductStockParser).toBeNull();
    expect(product.stockEnabled).toBe(false);
    expect(product.deliveryType).toBe("MANUAL_ADMIN");
    expect(product.requiredUserInfoEnabled).toBe(true);
    expect(product.collectInfoBeforeManualApproval).toBe(true);
    expect(product.customerInputSchema).toEqual(
      JSON.parse(JSON.stringify(PERSONALIZED_AI_DEFAULT_SCHEMA)),
    );
  });

  it("TELEGRAM_PREMIUM: personalized defaults incl. the persisted premium schema", async () => {
    const session = initialSession();
    const name = `spw-tgp-${runTag}`;
    await driveToKindStep(session, name);
    await dispatchCb(session, "admin:prod:f:kind:TGP");
    const { sent: invoiceStep } = await driveDurationPriceInvoice(session);
    expect(invoiceStep.at(-1)?.text).toBe(ORDER_QUESTION_TEXT);
    const product = await driveOrderAndSave(session, name);
    expect(product.otherProductKind).toBe("TELEGRAM_PREMIUM");
    expect(product.otherProductFulfillmentProfile).toBe("PERSONALIZED_SERVICE");
    expect(product.otherProductStockParser).toBeNull();
    expect(product.stockEnabled).toBe(false);
    expect(product.deliveryType).toBe("MANUAL_ADMIN");
    expect(product.requiredUserInfoEnabled).toBe(true);
    expect(product.collectInfoBeforeManualApproval).toBe(true);
    expect(product.customerInputSchema).toEqual(
      JSON.parse(JSON.stringify(TELEGRAM_PREMIUM_DEFAULT_SCHEMA)),
    );
  });

  it("GIFT_CARD stock: SINGLE_LINE codes, no legacy info question", async () => {
    const session = initialSession();
    const name = `spw-gift-stock-${runTag}`;
    await driveToKindStep(session, name);
    await dispatchCb(session, "admin:prod:f:kind:GIFT");
    await dispatchCb(session, "admin:prod:f:gc:stock");
    const { sent: invoiceStep } = await driveDurationPriceInvoice(session);
    expect(invoiceStep.at(-1)?.text).toBe(ORDER_QUESTION_TEXT);
    const product = await driveOrderAndSave(session, name);
    expect(product.otherProductKind).toBe("GIFT_CARD");
    expect(product.otherProductFulfillmentProfile).toBe("STOCK_CODE");
    expect(product.otherProductStockParser).toBe("SINGLE_LINE");
    expect(product.stockEnabled).toBe(true);
    expect(product.deliveryType).toBe("STOCK_ITEM");
    expect(product.requiredUserInfoEnabled).toBe(false);
  });

  it("GIFT_CARD manual: keeps the legacy user-info question, saves MANUAL_DELIVERY", async () => {
    const session = initialSession();
    const name = `spw-gift-manual-${runTag}`;
    const prompt = "کد ملی و ایمیل گیرنده را بفرستید.";
    await driveToKindStep(session, name);
    await dispatchCb(session, "admin:prod:f:kind:GIFT");
    await dispatchCb(session, "admin:prod:f:gc:manual");
    const { sent: invoiceStep } = await driveDurationPriceInvoice(session);
    expect(invoiceStep.at(-1)?.text).toBe(USER_INFO_QUESTION_TEXT);
    await dispatchCb(session, "admin:prod:f:rui:y");
    const { sent: promptStep } = await dispatchText(session, prompt);
    // Delivery is already fixed by the gift-card branch - straight to order.
    expect(promptStep.at(-1)?.text).toBe(ORDER_QUESTION_TEXT);
    const product = await driveOrderAndSave(session, name);
    expect(product.otherProductKind).toBe("GIFT_CARD");
    expect(product.otherProductFulfillmentProfile).toBe("MANUAL_DELIVERY");
    expect(product.otherProductStockParser).toBeNull();
    expect(product.stockEnabled).toBe(false);
    expect(product.deliveryType).toBe("MANUAL_ADMIN");
    expect(product.requiredUserInfoEnabled).toBe(true);
    expect(product.requiredUserInfoPromptText).toBe(prompt);
    expect(product.collectInfoBeforeManualApproval).toBe(false);
  });

  it("GENERIC: the legacy flow (info + delivery questions) is unchanged", async () => {
    const session = initialSession();
    const name = `spw-generic-${runTag}`;
    await driveToKindStep(session, name);
    await dispatchCb(session, "admin:prod:f:kind:GEN");
    const { sent: invoiceStep } = await driveDurationPriceInvoice(session);
    expect(invoiceStep.at(-1)?.text).toBe(USER_INFO_QUESTION_TEXT);
    const { sent: deliveryStep } = await dispatchCb(session, "admin:prod:f:rui:n");
    expect(deliveryStep.at(-1)?.text).toBe(DELIVERY_QUESTION_TEXT);
    await dispatchCb(session, "admin:prod:f:dlv:S");
    const product = await driveOrderAndSave(session, name);
    expect(product.otherProductKind).toBe("GENERIC");
    expect(product.otherProductFulfillmentProfile).toBeNull();
    expect(product.otherProductStockParser).toBeNull();
    // Legacy creation default: the wizard never auto-enables stock for GENERIC.
    expect(product.stockEnabled).toBe(false);
    expect(product.deliveryType).toBe("STOCK_ITEM");
    expect(product.requiredUserInfoEnabled).toBe(false);
    expect(product.customerInputSchema).toBeNull();
  });

  it("detail page: setkind applies the same per-kind defaults (and GEN clears them)", async () => {
    const product = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId,
        name: `spw-edit-kind-${runTag}`,
        priceToman: 90_000,
        isActive: true,
        deliveryType: "MANUAL_ADMIN",
      },
    });
    const sid = product.id.slice(0, 8);

    await dispatchCb(initialSession(), `admin:prod:setkind:${sid}:TGP`);
    let row = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(row.otherProductKind).toBe("TELEGRAM_PREMIUM");
    expect(row.otherProductFulfillmentProfile).toBe("PERSONALIZED_SERVICE");
    expect(row.otherProductStockParser).toBeNull();
    expect(row.requiredUserInfoEnabled).toBe(true);
    expect(row.collectInfoBeforeManualApproval).toBe(true);
    expect(row.deliveryType).toBe("MANUAL_ADMIN");
    expect(row.stockEnabled).toBe(false);
    expect(row.customerInputSchema).toEqual(
      JSON.parse(JSON.stringify(TELEGRAM_PREMIUM_DEFAULT_SCHEMA)),
    );

    await dispatchCb(initialSession(), `admin:prod:setkind:${sid}:APPLE`);
    row = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(row.otherProductKind).toBe("APPLE_ID");
    expect(row.otherProductFulfillmentProfile).toBe("STOCK_CREDENTIAL");
    expect(row.otherProductStockParser).toBe("EMAIL_BOUNDARY");
    expect(row.requiredUserInfoEnabled).toBe(false);
    expect(row.collectInfoBeforeManualApproval).toBe(false);
    expect(row.deliveryType).toBe("STOCK_ITEM");
    expect(row.stockEnabled).toBe(true);
    expect(row.customerInputSchema).toBeNull();

    await dispatchCb(initialSession(), `admin:prod:setkind:${sid}:GEN`);
    row = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(row.otherProductKind).toBe("GENERIC");
    expect(row.otherProductFulfillmentProfile).toBeNull();
    expect(row.otherProductStockParser).toBeNull();
    expect(row.collectInfoBeforeManualApproval).toBe(false);
    expect(row.customerInputSchema).toBeNull();
    // GEN only clears specialized fields - legacy settings stay untouched.
    expect(row.deliveryType).toBe("STOCK_ITEM");
    expect(row.stockEnabled).toBe(true);
    expect(row.requiredUserInfoEnabled).toBe(false);
  });

  it("detail page: cmt edits set and clear the completion message", async () => {
    const product = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId,
        name: `spw-edit-cmt-${runTag}`,
        priceToman: 70_000,
        isActive: true,
        deliveryType: "MANUAL_ADMIN",
      },
    });
    const sid = product.id.slice(0, 8);
    const session = initialSession();
    await dispatchCb(session, `admin:prod:fe:${sid}:cmt`);
    expect(session.currentFlow).toBe("product:edit");
    await dispatchText(session, "از خرید شما متشکریم 🎉");
    let row = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(row.completionMessageTemplate).toBe("از خرید شما متشکریم 🎉");

    const session2 = initialSession();
    await dispatchCb(session2, `admin:prod:fe:${sid}:cmt`);
    await dispatchText(session2, "-");
    row = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(row.completionMessageTemplate).toBeNull();

    // Over-long message is refused and nothing is stored.
    const session3 = initialSession();
    await dispatchCb(session3, `admin:prod:fe:${sid}:cmt`);
    await dispatchText(session3, "x".repeat(501));
    row = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(row.completionMessageTemplate).toBeNull();
  });

  it("detail page: cba toggles collect-before-approval only for info-collecting products", async () => {
    const personalized = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId,
        name: `spw-edit-cba-${runTag}`,
        priceToman: 50_000,
        isActive: true,
        deliveryType: "MANUAL_ADMIN",
        otherProductKind: "TELEGRAM_PREMIUM",
        otherProductFulfillmentProfile: "PERSONALIZED_SERVICE",
        requiredUserInfoEnabled: true,
        collectInfoBeforeManualApproval: true,
      },
    });
    const sid = personalized.id.slice(0, 8);
    await dispatchCb(initialSession(), `admin:prod:cba:${sid}`);
    let row = await prisma.product.findUniqueOrThrow({ where: { id: personalized.id } });
    expect(row.collectInfoBeforeManualApproval).toBe(false);
    await dispatchCb(initialSession(), `admin:prod:cba:${sid}`);
    row = await prisma.product.findUniqueOrThrow({ where: { id: personalized.id } });
    expect(row.collectInfoBeforeManualApproval).toBe(true);

    // A no-info product refuses the toggle.
    const plain = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId,
        name: `spw-edit-cba-plain-${runTag}`,
        priceToman: 40_000,
        isActive: true,
        deliveryType: "STOCK_ITEM",
        otherProductKind: "APPLE_ID",
        otherProductFulfillmentProfile: "STOCK_CREDENTIAL",
        requiredUserInfoEnabled: false,
      },
    });
    const { toasts } = await dispatchCb(
      initialSession(),
      `admin:prod:cba:${plain.id.slice(0, 8)}`,
    );
    expect(toasts.at(-1)).toBe("این گزینه فقط برای محصولات دارای فرم اطلاعات مشتری است.");
    const plainRow = await prisma.product.findUniqueOrThrow({ where: { id: plain.id } });
    expect(plainRow.collectInfoBeforeManualApproval).toBe(false);
  });

  it("forged callback codes are rejected without any state change", async () => {
    // Wizard: unknown kind code leaves the state on the kind step.
    const session = initialSession();
    await driveToKindStep(session, `spw-forged-${runTag}`);
    const { toasts: kindToasts } = await dispatchCb(session, "admin:prod:f:kind:HAX");
    expect(kindToasts.at(-1)).toBe(INVALID_OPTION_TEXT);
    expect(addState(session)?.step).toBe("otherKind");
    expect(addState(session)?.otherProductKind).toBeUndefined();
    // The wizard never persisted anything for this draft.
    expect(await prisma.product.findFirst({ where: { name: `spw-forged-${runTag}` } })).toBeNull();

    // Detail page: unknown kind / parser codes reject without touching the row.
    const product = await prisma.product.create({
      data: {
        type: "OTHER_PRODUCT",
        categoryId,
        name: `spw-forged-detail-${runTag}`,
        priceToman: 30_000,
        isActive: true,
        deliveryType: "MANUAL_ADMIN",
        otherProductKind: "TELEGRAM_PREMIUM",
        otherProductFulfillmentProfile: "PERSONALIZED_SERVICE",
        requiredUserInfoEnabled: true,
        collectInfoBeforeManualApproval: true,
      },
    });
    const sid = product.id.slice(0, 8);
    const before = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });

    const { toasts: badKind } = await dispatchCb(initialSession(), `admin:prod:setkind:${sid}:ZZZ`);
    expect(badKind.at(-1)).toBe(INVALID_OPTION_TEXT);
    const { toasts: badParser } = await dispatchCb(initialSession(), `admin:prod:setsp:${sid}:XX`);
    expect(badParser.at(-1)).toBe(INVALID_OPTION_TEXT);
    // A VALID parser code is still refused for a non-stock profile.
    const { toasts: nonStock } = await dispatchCb(initialSession(), `admin:prod:setsp:${sid}:SL`);
    expect(nonStock.at(-1)).toBe("فرمت موجودی فقط برای پروفایل‌های استوکی قابل تنظیم است.");

    const after = await prisma.product.findUniqueOrThrow({ where: { id: product.id } });
    expect(after.otherProductKind).toBe(before.otherProductKind);
    expect(after.otherProductFulfillmentProfile).toBe(before.otherProductFulfillmentProfile);
    expect(after.otherProductStockParser).toBe(before.otherProductStockParser);
    expect(after.collectInfoBeforeManualApproval).toBe(before.collectInfoBeforeManualApproval);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });
});

describe.skipIf(hasDb)("specialized product wizard (skipped)", () => {
  it("requires DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
