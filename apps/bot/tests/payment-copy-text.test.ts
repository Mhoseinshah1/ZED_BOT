import type { CheckoutSession } from "@zedbot/database";
import { describe, expect, it } from "vitest";

import { cardToCardKeyboard } from "../src/handlers/user-checkout/payment-views.js";

// =============================================================================
// Phase 21.1/21.2 regression: the card-to-card copy buttons must be Telegram
// `copy_text` buttons carrying the RAW values - clicking them copies to the
// clipboard client-side, fires NO callback and sends NO chat message.
//
// The legacy PAY_CB.COPY_CARD/COPY_AMOUNT callback handlers (old keyboards
// only) answer with a popup and never safeReply - verified by code review
// (apps/bot/src/handlers/user-checkout/payment.handler.ts, "legacy copy
// callbacks" section); a full grammY update harness would be overbuilt for
// two three-line handlers.
//
// Pure test - no DB, no Telegram API.
// =============================================================================

const checkout = {
  id: "abcd1234-0000-0000-0000-000000000000",
  finalPriceToman: 5_000_000,
  expiresAt: new Date(Date.now() + 30 * 60_000),
} as CheckoutSession;

describe("cardToCardKeyboard copy_text buttons", () => {
  const buttons = cardToCardKeyboard(checkout, "5892101317653466").inline_keyboard.flat();

  it("«کپی شماره کارت» copies the raw 16-digit number, no callback", () => {
    const btn = buttons.find((b) => b.text === "کپی شماره کارت");
    expect(btn).toBeDefined();
    expect(btn).toMatchObject({ copy_text: { text: "5892101317653466" } });
    expect(btn).not.toHaveProperty("callback_data");
  });

  it("«کپی مبلغ» copies the plain numeric amount, no callback", () => {
    const btn = buttons.find((b) => b.text === "کپی مبلغ");
    expect(btn).toBeDefined();
    expect(btn).toMatchObject({ copy_text: { text: "5000000" } });
    expect(btn).not.toHaveProperty("callback_data");
  });

  it("copy_text values respect Telegram's 1..256 char limit", () => {
    for (const label of ["کپی شماره کارت", "کپی مبلغ"]) {
      const btn = buttons.find((b) => b.text === label);
      const value = (btn as { copy_text?: { text?: string } }).copy_text?.text ?? "";
      expect(value.length).toBeGreaterThanOrEqual(1);
      expect(value.length).toBeLessThanOrEqual(256);
    }
  });

  it("the rest of the keyboard still uses callback buttons", () => {
    const receipt = buttons.find((b) => b.text === "ارسال رسید 🧾");
    expect(receipt).toHaveProperty("callback_data", "user:pay:receipt");
    const back = buttons.find((b) => b.text === "بازگشت به روش‌های پرداخت");
    expect(back).toHaveProperty("callback_data", "user:pay:m:abcd1234");
  });
});
