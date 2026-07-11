import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { User } from "@zedbot/database";
import { describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "phase39-test-secret-phase39-test-secret";

import { CB } from "../src/core/callbacks.js";
import type { CheckoutDraft } from "../src/core/session.js";
import { preInvoiceText } from "../src/handlers/user-checkout/checkout-views.js";
import { buildAdminMainKeyboard } from "../src/keyboards/admin-main.keyboard.js";
import { buildUserMainKeyboard } from "../src/keyboards/user-main.keyboard.js";
import type { ProductWithRelations } from "../src/services/product.service.js";
import { getButtonText, getMessageTemplate } from "../src/services/text.service.js";

// =============================================================================
// Phase 39 UI/UX alignment: menu structure locks (subscription purchase and
// OTHER_PRODUCT stay separate and unchanged), hidden placeholders, text
// fallbacks and the pre-invoice fields. Runs without a database - the text
// service falls back to the built-in defaults.
// =============================================================================

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type Button = { text: string; callback_data?: string };

function flatCallbacks(rows: Button[][]): string[] {
  return rows.flat().map((button) => button.callback_data ?? "");
}

describe("user main menu (Phase 39 layout)", () => {
  it("shows exactly the implemented sections in the agreed order", async () => {
    const kb = await buildUserMainKeyboard();
    const rows = kb.inline_keyboard as Button[][];
    expect(rows.map((row) => row.map((b) => b.callback_data))).toEqual([
      [CB.USER_BUY, CB.USER_RENEW],
      [CB.USER_SERVICES, CB.USER_WALLET],
      [CB.USER_OTHER_PRODUCTS, CB.USER_ORDERS],
      [CB.USER_SUPPORT],
    ]);
  });

  it("keeps the locked flows: خرید اشتراک -> user:buy, محصولات دیگر separate", async () => {
    expect(CB.USER_BUY).toBe("user:buy");
    expect(CB.USER_OTHER_PRODUCTS).toBe("user:other_products");
    const kb = await buildUserMainKeyboard();
    const rows = kb.inline_keyboard as Button[][];
    const buy = rows.flat().find((b) => b.callback_data === CB.USER_BUY);
    const other = rows.flat().find((b) => b.callback_data === CB.USER_OTHER_PRODUCTS);
    expect(buy?.text).toBe("خرید اشتراک 🔐");
    expect(other?.text).toBe("محصولات دیگر 🛍");
    // The checkout handler still owns the user:buy entry callback.
    const checkoutCb = readFileSync(
      path.join(repoRoot, "apps/bot/src/handlers/user-checkout/checkout-cb.ts"),
      "utf8",
    );
    expect(checkoutCb).toContain('BUY: "user:buy"');
  });

  it("hides the unfinished placeholder sections", async () => {
    const kb = await buildUserMainKeyboard();
    const callbacks = flatCallbacks(kb.inline_keyboard as Button[][]);
    for (const hidden of [
      CB.USER_REFERRAL,
      CB.USER_FREE_TEST,
      CB.USER_WHEEL,
      CB.USER_TUTORIALS,
      CB.USER_PRICING,
      CB.USER_REPRESENTATIVE,
    ]) {
      expect(callbacks, `${hidden} must be hidden`).not.toContain(hidden);
    }
    // ...but their callbacks stay answered for old keyboards.
    const placeholders = readFileSync(
      path.join(repoRoot, "apps/bot/src/handlers/user-placeholders.handler.ts"),
      "utf8",
    );
    for (const key of ["referral", "free_test", "lucky_wheel", "tutorials", "pricing"]) {
      expect(placeholders).toContain(key);
    }
  });
});

describe("admin main menu (Phase 39 layout)", () => {
  it("shows all implemented modules and no dead placeholders", () => {
    const kb = buildAdminMainKeyboard();
    const callbacks = flatCallbacks(kb.inline_keyboard as Button[][]);
    for (const visible of [
      CB.ADMIN_FINANCE,
      CB.ADMIN_RECEIPTS,
      CB.ADMIN_USERS,
      CB.ADMIN_GENERAL_SETTINGS,
      CB.ADMIN_PRODUCTS,
      CB.ADMIN_PANELS,
      CB.ADMIN_OTHER_PRODUCTS,
      CB.ADMIN_SUPPORT,
      CB.ADMIN_BROADCAST,
      CB.ADMIN_REPORTS_BACKUP,
    ]) {
      expect(callbacks, `${visible} must be visible`).toContain(visible);
    }
    for (const hidden of [
      CB.ADMIN_PANEL_FEATURES,
      CB.ADMIN_UPDATE_BOT,
      CB.ADMIN_TUTORIALS,
      CB.ADMIN_MINI_APP_SETTINGS,
      CB.ADMIN_CUSTOM_SERVICE_PRICE,
    ]) {
      expect(callbacks, `${hidden} must be hidden`).not.toContain(hidden);
    }
  });
});

describe("text fallbacks (Phase 39)", () => {
  it("every visible menu button has a ButtonText fallback", async () => {
    const expectations: Record<string, string> = {
      buy_subscription: "خرید اشتراک 🔐",
      renew_service: "تمدید سرویس ♻️",
      my_services: "سرویس‌های من 🛍",
      wallet: "کیف پول + شارژ 🏦",
      other_products: "محصولات دیگر 🛍",
      my_orders: "سفارش‌های من 🧾",
      support: "پشتیبانی ☎️",
      // Common buttons.
      back: "بازگشت",
      main_menu: "منوی اصلی",
      cancel: "لغو ❌",
      confirm: "تایید ✅",
      next: "بعدی »",
      previous: "« قبلی",
    };
    for (const [key, label] of Object.entries(expectations)) {
      expect(await getButtonText(key), key).toBe(label);
    }
  });

  it("important MessageTemplate keys have fallbacks", async () => {
    expect(await getMessageTemplate("start_text")).toBe("به ربات خوش آمدید.");
    expect(await getMessageTemplate("support_text")).toBe(
      "برای ارتباط با پشتیبانی پیام خود را ارسال کنید.",
    );
    expect(await getMessageTemplate("no_services_text")).toBe("شما هنوز سرویسی ندارید.");
    expect(await getMessageTemplate("no_orders_text")).toBe("شما هنوز سفارشی ندارید.");
    expect(await getMessageTemplate("no_tickets_text")).toBe("هنوز تیکتی ثبت نکرده‌اید.");
  });

  it("the seed contains no duplicate keys", () => {
    const seed = readFileSync(path.join(repoRoot, "packages/database/src/seed.ts"), "utf8");
    const keys = [...seed.matchAll(/key: "([^"]+)"/g)].map((match) => match[1]);
    expect(keys.length).toBeGreaterThan(20);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("pre-invoice (locked checkout rendering)", () => {
  const user = { balanceToman: 500_000 } as User;

  function draft(overrides: Partial<CheckoutDraft> = {}): CheckoutDraft {
    return {
      productId: "p",
      categoryId: "c",
      flowType: "SERVICE_PRODUCT",
      originalPriceToman: 250_000,
      discountAmountToman: 0,
      finalPriceToman: 250_000,
      ...overrides,
    };
  }

  it("still renders every required field for a subscription product", () => {
    const product = {
      type: "SERVICE_PRODUCT",
      name: "پلن طلایی",
      category: { name: "اشتراک‌ها" },
      panel: { name: "پنل آلمان" },
      allLocations: false,
      serviceLocation: null,
      volumeGb: 50,
      durationDays: 30,
      invoiceDescription: null,
      requiredUserInfoEnabled: false,
    } as unknown as ProductWithRelations;
    const text = preInvoiceText(product, user, draft({ discountCode: "OFF10", discountAmountToman: 25_000, finalPriceToman: 225_000 }));
    expect(text).toContain("پیش‌فاکتور");
    expect(text).toContain("محصول: پلن طلایی");
    expect(text).toContain("دسته‌بندی: اشتراک‌ها");
    expect(text).toContain("پنل: پنل آلمان");
    expect(text).toContain("حجم:");
    expect(text).toContain("مدت:");
    expect(text).toContain("قیمت:");
    expect(text).toContain("کد تخفیف: <code>OFF10</code>");
    expect(text).toContain("مبلغ تخفیف:");
    expect(text).toContain("مبلغ قابل پرداخت:");
    expect(text).toContain("موجودی کیف پول شما:");
  });

  it("still renders the OTHER_PRODUCT required-info notice", () => {
    const product = {
      type: "OTHER_PRODUCT",
      name: "گیفت کارت",
      category: { name: "محصولات دیگر" },
      panel: null,
      allLocations: false,
      serviceLocation: null,
      volumeGb: null,
      durationDays: null,
      invoiceDescription: null,
      deliveryType: "STOCK_ITEM",
      requiredUserInfoEnabled: true,
      requiredUserInfoPromptText: "ایمیل خود را بفرستید.",
    } as unknown as ProductWithRelations;
    const text = preInvoiceText(product, user, draft({ flowType: "OTHER_PRODUCT" }));
    expect(text).toContain("محصول: گیفت کارت");
    expect(text).toContain("نوع تحویل:");
    expect(text).toContain("بعد از پرداخت، اطلاعات زیر از شما دریافت می‌شود:");
    expect(text).toContain("ایمیل خود را بفرستید.");
    expect(text).toContain("مبلغ قابل پرداخت:");
  });
});

describe("docs (Phase 39)", () => {
  it("documents the locked flows and hidden placeholders", () => {
    const doc = readFileSync(path.join(repoRoot, "docs/ui-ux-alignment-phase39.md"), "utf8");
    expect(doc).toContain("خرید اشتراک");
    expect(doc).toContain("محصولات دیگر");
    expect(doc).toMatch(/unchanged|locked/i);
    expect(doc).toContain("Hidden placeholders");
    expect(doc).toContain("no_services_text");
  });
});
