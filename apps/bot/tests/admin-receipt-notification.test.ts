import {
  prisma,
  type CheckoutSession,
  type Payment,
  type User,
} from "@zedbot/database";
import type { InlineKeyboard } from "grammy";
import { afterAll, describe, expect, it } from "vitest";

import {
  buildReceiptNotificationText,
  notifyAdminsAboutReceipt,
  receiptNotificationKeyboard,
  type ReceiptNotifyApi,
} from "../src/services/admin-receipt-notification.service.js";

// =============================================================================
// Phase 21.1/21.2 regression: receipt submission must notify ACTIVE admins
// with the actual receipt media/text, a masked card number and a review
// button - and a failing admin send must never break the submission.
//
// The text/keyboard suites are pure; the notify suites need the shared
// disposable PostgreSQL (docs/testing.md) for the active-admin lookup and
// use a recording fake instead of the real Telegram API.
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

interface RecordedCall {
  method: "sendPhoto" | "sendDocument" | "sendMessage";
  chatId: string;
  /** file_id for media sends; message text for sendMessage. */
  payload: string;
  caption?: string;
  keyboardTexts: string[];
}

function keyboardTexts(other?: Record<string, unknown>): string[] {
  const markup = other?.reply_markup as InlineKeyboard | undefined;
  return markup?.inline_keyboard.flat().map((b) => b.text) ?? [];
}

function recordingApi(failFor: string[] = []) {
  const calls: RecordedCall[] = [];
  const make =
    (method: RecordedCall["method"]) =>
    async (chatId: string, payload: string, other?: Record<string, unknown>): Promise<unknown> => {
      if (failFor.includes(chatId)) {
        throw new Error("blocked by user");
      }
      calls.push({
        method,
        chatId,
        payload,
        caption: typeof other?.caption === "string" ? other.caption : undefined,
        keyboardTexts: keyboardTexts(other),
      });
      return {};
    };
  const api: ReceiptNotifyApi = {
    sendPhoto: make("sendPhoto"),
    sendDocument: make("sendDocument"),
    sendMessage: make("sendMessage"),
  };
  return { api, calls };
}

// --- pure: notification text + keyboard ------------------------------------------------

describe("buildReceiptNotificationText", () => {
  it("masks the card number and carries the full review context", () => {
    const text = buildReceiptNotificationText(
      {
        payment: fakePayment,
        checkout: fakeCheckout("ORDER_PAYMENT", "SERVICE_PURCHASE"),
        user: fakeUser,
        receiptKind: "PHOTO",
        cardNumber: "5892101317653466",
        receiptText: "پرداخت انجام شد",
      },
      "علی رضایی",
    );
    expect(text).toContain("رسید پرداخت جدید 🧾");
    expect(text).toContain("5892 10** **** 3466"); // masked
    expect(text).not.toContain("5892101317653466"); // never raw
    expect(text).not.toContain("1317"); // middle digits hidden
    expect(text).toContain("5,000,000 تومان");
    expect(text).toContain("424242"); // user telegram id
    expect(text).toContain("<code>abcdef12</code>"); // payment short id
    expect(text).toContain("<code>fedcba98</code>"); // checkout short id
    expect(text).toContain("در انتظار بررسی");
    expect(text).toContain("خرید سرویس");
    expect(text).toContain("علی رضایی"); // card owner
    expect(text).toContain("متن رسید: پرداخت انجام شد");
  });

  it("labels wallet top-ups and omits the card line without a card", () => {
    const text = buildReceiptNotificationText(
      {
        payment: fakePayment,
        checkout: fakeCheckout("WALLET_CHARGE", null),
        user: fakeUser,
        receiptKind: "TEXT",
      },
      null,
    );
    expect(text).toContain("شارژ کیف پول 🏦");
    expect(text).not.toContain("شماره کارت پرداخت");
  });

  it("review keyboard targets the existing receipt detail + list", () => {
    const buttons = receiptNotificationKeyboard("abcdef12").inline_keyboard.flat();
    expect(buttons.map((b) => b.text)).toEqual(["بررسی رسید 🧾", "رسیدهای تایید نشده 💵"]);
    expect(buttons[0]).toHaveProperty("callback_data", "admin:rec:view:abcdef12");
    expect(buttons[1]).toHaveProperty("callback_data", "admin:receipts");
  });
});

// --- DB + fake api: notifyAdminsAboutReceipt -------------------------------------------

describe.runIf(hasDb)("notifyAdminsAboutReceipt", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createAdmins() {
    // Unique telegramIds per call; only rows this test created are asserted
    // on (other suites create their own admins in parallel).
    const tag = runTag + BigInt(Math.floor(Math.random() * 1_000_000));
    const active1 = await prisma.admin.create({
      data: { telegramId: tag + 1n, role: "OWNER", isActive: true },
    });
    const active2 = await prisma.admin.create({
      data: { telegramId: tag + 2n, role: "RECEIPT_REVIEWER", isActive: true },
    });
    const inactive = await prisma.admin.create({
      data: { telegramId: tag + 3n, role: "SUPPORT", isActive: false },
    });
    return {
      chat1: active1.telegramId.toString(),
      chat2: active2.telegramId.toString(),
      chatInactive: inactive.telegramId.toString(),
    };
  }

  it("photo receipt: sendPhoto once per active admin with caption + review button", async () => {
    const { chat1, chat2, chatInactive } = await createAdmins();
    const { api, calls } = recordingApi();
    const reached = await notifyAdminsAboutReceipt(api, {
      payment: fakePayment,
      checkout: fakeCheckout("ORDER_PAYMENT", "SERVICE_RENEWAL"),
      user: fakeUser,
      receiptKind: "PHOTO",
      receiptFileId: "file-photo-1",
      cardNumber: "5892101317653466",
    });

    // Exactly one photo send per OUR active admin; the inactive one gets none.
    for (const chatId of [chat1, chat2]) {
      const mine = calls.filter((c) => c.chatId === chatId);
      expect(mine).toHaveLength(1);
      expect(mine[0].method).toBe("sendPhoto");
      expect(mine[0].payload).toBe("file-photo-1");
      expect(mine[0].caption).toContain("رسید پرداخت جدید 🧾");
      expect(mine[0].caption).toContain("5892 10** **** 3466");
      expect(mine[0].caption).not.toContain("5892101317653466");
      expect(mine[0].keyboardTexts).toContain("بررسی رسید 🧾");
      expect(mine[0].keyboardTexts).toContain("رسیدهای تایید نشده 💵");
    }
    expect(calls.some((c) => c.chatId === chatInactive)).toBe(false);
    // Return value = number of successful sends (every recorded call succeeded).
    expect(reached).toBe(calls.length);
  });

  it("document receipt: sendDocument with the same caption/keyboard", async () => {
    const { chat1 } = await createAdmins();
    const { api, calls } = recordingApi();
    await notifyAdminsAboutReceipt(api, {
      payment: fakePayment,
      checkout: fakeCheckout("ORDER_PAYMENT", "EXTRA_VOLUME"),
      user: fakeUser,
      receiptKind: "DOCUMENT",
      receiptFileId: "file-doc-1",
    });
    const mine = calls.filter((c) => c.chatId === chat1);
    expect(mine).toHaveLength(1);
    expect(mine[0].method).toBe("sendDocument");
    expect(mine[0].payload).toBe("file-doc-1");
    expect(mine[0].caption).toContain("رسید پرداخت جدید 🧾");
    expect(mine[0].keyboardTexts).toContain("بررسی رسید 🧾");
  });

  it("text receipt: sendMessage including the receipt text", async () => {
    const { chat1 } = await createAdmins();
    const { api, calls } = recordingApi();
    await notifyAdminsAboutReceipt(api, {
      payment: fakePayment,
      checkout: fakeCheckout("WALLET_CHARGE", null),
      user: fakeUser,
      receiptKind: "TEXT",
      receiptText: "شماره پیگیری 12345",
    });
    const mine = calls.filter((c) => c.chatId === chat1);
    expect(mine).toHaveLength(1);
    expect(mine[0].method).toBe("sendMessage");
    expect(mine[0].payload).toContain("رسید پرداخت جدید 🧾");
    expect(mine[0].payload).toContain("متن رسید: شماره پیگیری 12345");
    expect(mine[0].keyboardTexts).toContain("بررسی رسید 🧾");
  });

  it("one blocked admin: no throw, others still notified, return = successful sends", async () => {
    const { chat1, chat2 } = await createAdmins();
    const { api, calls } = recordingApi([chat1]);
    const reached = await notifyAdminsAboutReceipt(api, {
      payment: fakePayment,
      checkout: fakeCheckout("ORDER_PAYMENT", "EXTRA_TIME"),
      user: fakeUser,
      receiptKind: "PHOTO",
      receiptFileId: "file-photo-2",
    });
    expect(calls.some((c) => c.chatId === chat1)).toBe(false); // blocked
    expect(calls.filter((c) => c.chatId === chat2)).toHaveLength(1); // still delivered
    expect(reached).toBe(calls.length); // exact successful-send count
    expect(reached).toBeGreaterThanOrEqual(1);
  });
});

describe.skipIf(hasDb)("notifyAdminsAboutReceipt (skipped)", () => {
  it("receipt notification integration tests require DATABASE_URL - see docs/testing.md", () => {
    expect(hasDb).toBe(false);
  });
});
