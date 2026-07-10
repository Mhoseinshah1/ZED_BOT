import {
  prisma,
  type CheckoutSession,
  type Payment,
  type User,
} from "@zedbot/database";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildReceiptNotificationText,
  notifyAdminsAboutReceipt,
  receiptNotificationKeyboard,
  type ReceiptNotifyApi,
} from "../src/services/admin-receipt-notification.service.js";
import { cardToCardKeyboard } from "../src/handlers/user-checkout/payment-views.js";

// =============================================================================
// Phase 21.1 tests: real copy_text buttons + admin receipt notification.
// The keyboard/text tests are pure; the notification tests need the shared
// disposable PostgreSQL (docs/testing.md) for the active-admin lookup and
// use a recording mock instead of the real Telegram API.
// =============================================================================

const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

const fakeUser = {
  id: "u-1",
  telegramId: 424242n,
  username: "buyer",
  firstName: "علی",
  lastName: null,
} as unknown as User;

const fakePayment = {
  id: "abcdef12-3456-7890-abcd-ef1234567890",
  amountToman: 5_000_000,
  createdAt: new Date("2026-07-10T10:00:00Z"),
} as unknown as Payment;

const fakeCheckout = (purpose: string, orderType: string | null) =>
  ({
    id: "fedcba98-7654-3210-fedc-ba9876543210",
    purpose,
    orderType,
  }) as unknown as CheckoutSession;

function recordingApi(failFor: string[] = []) {
  const calls: Array<{ method: string; chatId: string; payload?: string }> = [];
  const make =
    (method: string) =>
    async (chatId: string, payload?: unknown): Promise<unknown> => {
      if (failFor.includes(chatId)) {
        throw new Error("blocked");
      }
      calls.push({ method, chatId, payload: typeof payload === "string" ? payload : undefined });
      return {};
    };
  const api: ReceiptNotifyApi = {
    sendPhoto: make("sendPhoto"),
    sendDocument: make("sendDocument"),
    sendMessage: make("sendMessage"),
  };
  return { api, calls };
}

describe("card-to-card copy buttons (Phase 21.1)", () => {
  it("uses Telegram copy_text with RAW values - no callback, no extra message", () => {
    const checkout = { id: "abcd1234-0000", finalPriceToman: 5_000_000 } as CheckoutSession;
    const kb = cardToCardKeyboard(checkout, "6037991122334455");
    const buttons = kb.inline_keyboard.flat();
    const copyCard = buttons.find((b) => b.text === "کپی شماره کارت");
    const copyAmount = buttons.find((b) => b.text === "کپی مبلغ");
    expect(copyCard).toMatchObject({ copy_text: { text: "6037991122334455" } });
    expect(copyAmount).toMatchObject({ copy_text: { text: "5000000" } });
    expect(copyCard).not.toHaveProperty("callback_data");
    expect(copyAmount).not.toHaveProperty("callback_data");
    // The receipt/back buttons are untouched callback buttons.
    expect(buttons.some((b) => b.text === "ارسال رسید 🧾" && "callback_data" in b)).toBe(true);
  });
});

describe("admin receipt notification text", () => {
  it("masks the card number, labels the type and links the review page", () => {
    const text = buildReceiptNotificationText(
      {
        payment: fakePayment,
        checkout: fakeCheckout("ORDER_PAYMENT", "SERVICE_PURCHASE"),
        user: fakeUser,
        receiptKind: "PHOTO",
        cardNumber: "6037991122334455",
        receiptText: "پرداخت انجام شد",
      },
      "علی رضایی",
    );
    expect(text).toContain("رسید پرداخت جدید 🧾");
    expect(text).toContain("خرید سرویس");
    expect(text).toContain("5,000,000 تومان");
    expect(text).toContain("6037 99** **** 4455");
    expect(text).not.toContain("6037991122334455");
    expect(text).not.toContain("1122");
    expect(text).toContain("علی رضایی");
    expect(text).toContain("در انتظار بررسی");
    expect(text).toContain("متن رسید: پرداخت انجام شد");
    expect(text).toContain("<code>abcdef12</code>");

    const walletText = buildReceiptNotificationText(
      {
        payment: fakePayment,
        checkout: fakeCheckout("WALLET_CHARGE", null),
        user: fakeUser,
        receiptKind: "TEXT",
      },
      null,
    );
    expect(walletText).toContain("شارژ کیف پول 🏦");
    expect(walletText).not.toContain("شماره کارت پرداخت");

    const kbButtons = receiptNotificationKeyboard("abcdef12").inline_keyboard.flat();
    expect(kbButtons.some((b) => "callback_data" in b && b.callback_data === "admin:rec:view:abcdef12")).toBe(true);
    expect(kbButtons.some((b) => "callback_data" in b && b.callback_data === "admin:receipts")).toBe(true);
  });
});

describe.runIf(hasDb)("notifyAdminsAboutReceipt (DB + mock api)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("sends the right media kind to ACTIVE admins only and survives per-admin failures", async () => {
    const active1 = await prisma.admin.create({
      data: { telegramId: runTag + 1n, role: "OWNER", isActive: true },
    });
    const active2 = await prisma.admin.create({
      data: { telegramId: runTag + 2n, role: "RECEIPT_REVIEWER", isActive: true },
    });
    const inactive = await prisma.admin.create({
      data: { telegramId: runTag + 3n, role: "SUPPORT", isActive: false },
    });
    const chat1 = active1.telegramId.toString();
    const chat2 = active2.telegramId.toString();
    const chatInactive = inactive.telegramId.toString();

    // Photo receipt -> sendPhoto to every active admin, never the inactive one.
    const photo = recordingApi();
    await notifyAdminsAboutReceipt(photo.api, {
      payment: fakePayment,
      checkout: fakeCheckout("ORDER_PAYMENT", "SERVICE_RENEWAL"),
      user: fakeUser,
      receiptKind: "PHOTO",
      receiptFileId: "file-photo-1",
    });
    expect(photo.calls.filter((c) => c.chatId === chat1)).toEqual([
      { method: "sendPhoto", chatId: chat1, payload: "file-photo-1" },
    ]);
    expect(photo.calls.some((c) => c.chatId === chat2 && c.method === "sendPhoto")).toBe(true);
    expect(photo.calls.some((c) => c.chatId === chatInactive)).toBe(false);

    // Document receipt -> sendDocument.
    const doc = recordingApi();
    await notifyAdminsAboutReceipt(doc.api, {
      payment: fakePayment,
      checkout: fakeCheckout("ORDER_PAYMENT", "EXTRA_VOLUME"),
      user: fakeUser,
      receiptKind: "DOCUMENT",
      receiptFileId: "file-doc-1",
    });
    expect(doc.calls.some((c) => c.chatId === chat1 && c.method === "sendDocument")).toBe(true);

    // Text receipt -> sendMessage.
    const txt = recordingApi();
    await notifyAdminsAboutReceipt(txt.api, {
      payment: fakePayment,
      checkout: fakeCheckout("WALLET_CHARGE", null),
      user: fakeUser,
      receiptKind: "TEXT",
      receiptText: "شماره پیگیری 12345",
    });
    expect(txt.calls.some((c) => c.chatId === chat1 && c.method === "sendMessage")).toBe(true);

    // One blocked admin: no throw, the other still gets it.
    const partial = recordingApi([chat1]);
    await expect(
      notifyAdminsAboutReceipt(partial.api, {
        payment: fakePayment,
        checkout: fakeCheckout("ORDER_PAYMENT", "EXTRA_TIME"),
        user: fakeUser,
        receiptKind: "PHOTO",
        receiptFileId: "file-photo-2",
      }),
    ).resolves.toBeGreaterThanOrEqual(1);
    expect(partial.calls.some((c) => c.chatId === chat1)).toBe(false);
    expect(partial.calls.some((c) => c.chatId === chat2 && c.method === "sendPhoto")).toBe(true);
  });
});

describe.skipIf(hasDb)("notifyAdminsAboutReceipt (skipped)", () => {
  it("receipt notification integration tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
