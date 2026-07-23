import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CheckoutStatus,
  INITIAL_BUTTON_TEXTS,
  INITIAL_MESSAGE_TEMPLATES,
  OrderType,
  prisma,
  ServiceStatus,
  type CardToCardAccount,
  type CheckoutSession,
  type Service,
  type User,
} from "@zedbot/database";
import { afterAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "persian-text-test-secret-persian-text-42";

import { CB } from "../src/core/callbacks.js";
import type { CheckoutDraft } from "../src/core/session.js";
import { financeLandingKeyboard } from "../src/handlers/admin-finance/admin-finance-views.js";
import { checkoutViewText, preInvoiceText } from "../src/handlers/user-checkout/checkout-views.js";
import { cardToCardKeyboard, cardToCardText } from "../src/handlers/user-checkout/payment-views.js";
import { buildHistoryLandingKeyboard } from "../src/handlers/user-orders/orders.handler.js";
import {
  serviceDetailKeyboard,
  serviceDetailText,
} from "../src/handlers/user-services/service-views.js";
import { buildSupportLandingKeyboard } from "../src/handlers/user-support/support.handler.js";
import { walletMainKeyboard } from "../src/handlers/user-wallet/wallet-views.js";
import { buildAdminMainKeyboard } from "../src/keyboards/admin-main.keyboard.js";
import { buildUserMainKeyboard } from "../src/keyboards/user-main.keyboard.js";
import { NOT_EDITABLE_TEXT } from "../src/services/admin-text-settings.service.js";
import {
  approvalUserNotice,
  rejectionUserNotice,
} from "../src/services/receipt-review.service.js";
import { REGEN_SUCCESS_TEXT } from "../src/services/service-link.service.js";
import {
  SYNC_FAILED_USER_TEXT,
  SYNC_NOT_FOUND_TEXT,
  SYNC_OK_TEXT,
} from "../src/services/service-sync.service.js";
import {
  TOGGLE_DISABLED_OK_TEXT,
  TOGGLE_ENABLED_OK_TEXT,
  TOGGLE_FAILED_TEXT,
} from "../src/services/service-toggle.service.js";
import { TICKET_CLOSED_TEXT } from "../src/services/support-ticket.service.js";
import {
  INVALID_TEMPLATE_VARIABLE_TEXT,
  validateTemplateContentVariables,
} from "../src/services/template-variables.js";
import {
  clearTextCache,
  getButtonText,
  getMessageTemplate,
} from "../src/services/text.service.js";
import type { ServiceDetailActions } from "../src/services/user-services.service.js";
import type { ProductWithRelations } from "../src/services/product.service.js";
import {
  INSUFFICIENT_BALANCE_TEXT,
  WALLET_PAYMENT_DONE_TEXT,
} from "../src/services/wallet-payment.service.js";
import { renderTemplateOmitMissing } from "../src/utils/template.js";

// =============================================================================
// Persian text alignment lock (fix/persian-bot-texts): the approved copy for
// every user/admin surface, the seed registry as the single source of
// defaults, the variable-validation gate, cache/seed semantics and the
// label-vs-callback independence rule. Mostly pure (keyboard/text builders +
// the registry); the DB-backed cache/seed/edit semantics run under
// describe.runIf(hasDb) and skip without DATABASE_URL (docs/testing.md).
// docs/text-system.md describes the architecture these tests lock.
// =============================================================================

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const srcRoot = path.join(repoRoot, "apps/bot/src");
const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const tag = runTag.toString();

type Button = { text: string; callback_data?: string };

function rows(kb: { inline_keyboard: unknown }): Button[][] {
  return kb.inline_keyboard as Button[][];
}

function labels(kb: { inline_keyboard: unknown }): string[] {
  return rows(kb)
    .flat()
    .map((b) => b.text);
}

function callbacks(kb: { inline_keyboard: unknown }): string[] {
  return rows(kb)
    .flat()
    .map((b) => b.callback_data)
    .filter((cb): cb is string => cb !== undefined);
}

function readSource(relative: string): string {
  return readFileSync(path.join(repoRoot, relative), "utf8");
}

// --- fabricated rows (cast pattern shared with corrective-fix-a.test.ts) ----

function fakeService(overrides: Partial<Record<string, unknown>> = {}): Service {
  return {
    id: "abcdef12-3456-7890-abcd-ef1234567890",
    username: "srv_user_01",
    productNameSnapshot: "پلن طلایی",
    panelNameSnapshot: "پنل آلمان",
    panelType: "MARZBAN",
    serviceLocation: "MULTI_LOCATION",
    status: "ACTIVE",
    volumeBytes: 10n * 1024n * 1024n * 1024n,
    usedBytes: 1n * 1024n * 1024n * 1024n,
    remainingBytes: 9n * 1024n * 1024n * 1024n,
    durationDays: 30,
    startsAt: new Date("2026-06-01T00:00:00Z"),
    expiresAt: new Date("2026-08-01T00:00:00Z"),
    createdAt: new Date("2026-06-01T00:00:00Z"),
    lastConnectedAt: null,
    lastSubscriptionUpdateAt: null,
    remoteMetadata: null,
    subscriptionUrl: "https://example.com/sub/abc",
    configLinks: [],
    ...overrides,
  } as unknown as Service;
}

const ALL_ACTIONS: ServiceDetailActions = {
  toggleAction: "DISABLE",
  canBuyExtraVolume: true,
  canBuyExtraTime: true,
  canRegenerateLink: true,
  canRenew: true,
};

const fakeUser = { balanceToman: 200_000 } as unknown as User;

// buildAdminMainKeyboard is admin-scoped since the admin-menu-keyboard-mode
// phase: a minimal ACTIVE admin renders the full approved menu (labels come
// from the ButtonText registry with in-code seed fallbacks, so no DB needed).
const activeAdmin = { isActive: true } as unknown as Parameters<
  typeof buildAdminMainKeyboard
>[0];

const fakeProduct = {
  id: "11112222-3333-4444-5555-666677778888",
  name: "پلن طلایی",
  type: "SERVICE_PRODUCT",
  allLocations: false,
  serviceLocation: "MULTI_LOCATION",
  durationDays: 30,
  volumeGb: 50,
  priceToman: 150_000,
  invoiceDescription: null,
  requiredUserInfoEnabled: false,
  deliveryType: null,
} as unknown as ProductWithRelations;

function fakeDraft(overrides: Partial<CheckoutDraft> = {}): CheckoutDraft {
  return {
    productId: "11112222-3333-4444-5555-666677778888",
    categoryId: "99990000-aaaa-bbbb-cccc-ddddeeeeffff",
    flowType: "SERVICE_PRODUCT",
    originalPriceToman: 150_000,
    discountAmountToman: 0,
    finalPriceToman: 150_000,
    ...overrides,
  };
}

function fakeCheckout(overrides: Partial<Record<string, unknown>> = {}): CheckoutSession {
  return {
    id: "abcd1234-0000-0000-0000-000000000000",
    purpose: "ORDER_PAYMENT",
    status: "PENDING",
    productSnapshot: { productName: "پلن طلایی", categoryName: "اشتراک‌ها" },
    originalPriceToman: 150_000,
    discountAmountToman: 0,
    finalPriceToman: 150_000,
    expiresAt: new Date("2026-08-01T10:00:00Z"),
    ...overrides,
  } as unknown as CheckoutSession;
}

// --- 1-5: landing pages carry exactly the approved labels --------------------

describe("main menus and landing pages (exact approved labels)", () => {
  it("user main menu: exact labels and callbacks including the Pricing row", async () => {
    const kb = await buildUserMainKeyboard();
    expect(rows(kb).map((row) => row.map((b) => [b.text, b.callback_data]))).toEqual([
      [
        ["خرید اشتراک 🔐", "user:buy"],
        ["تمدید سرویس ♻️", "user:renew"],
      ],
      [
        ["سرویس‌های من 🛍", "user:services"],
        ["کیف پول + شارژ 🏦", "user:wallet"],
      ],
      [
        ["محصولات دیگر 🛍", "user:other_products"],
        ["سفارش‌های من 🧾", "user:orders"],
      ],
      // Public retail Pricing Catalog: standalone always-visible row.
      [["تعرفه اشتراک‌ها 💵", "user:pricing"]],
      [["پشتیبانی ☎️", "user:support"]],
    ]);
    expect(callbacks(kb)).toEqual([
      CB.USER_BUY,
      CB.USER_RENEW,
      CB.USER_SERVICES,
      CB.USER_WALLET,
      CB.USER_OTHER_PRODUCTS,
      CB.USER_ORDERS,
      CB.USER_PRICING,
      CB.USER_SUPPORT,
    ]);
  });

  it("admin main menu: exact labels", async () => {
    expect(labels(await buildAdminMainKeyboard(activeAdmin))).toEqual([
      "مالی 💎",
      "مدیریت کاربران 👤",
      "مدیریت محصولات/پلن‌ها 📦",
      "مدیریت پنل‌ها 🖥",
      "محصولات دیگر / سفارش‌های محصولات دیگر",
      "تیکت‌های پشتیبانی 🎫",
      "پیام همگانی 📣",
      "تنظیمات عمومی ⚙️",
      "گزارشات / بکاپ 📊",
      // Two-way navigation: the final full-width return-to-user row.
      "بازگشت به منوی کاربر 👤",
    ]);
  });

  it("finance landing: exact labels with the admin back route", () => {
    const kb = financeLandingKeyboard();
    expect(rows(kb).map((row) => row.map((b) => b.text))).toEqual([
      ["رسیدهای تاییدنشده 💵"],
      ["روش‌های پرداخت 💳", "تنظیمات کیف پول و پرداخت 🏦"],
      ["مدیریت کیف پول کاربران 👤", "گزارش مالی 📊"],
      // Gateway/settlement phase: read-only payments list + reconciliation
      // row above the back row.
      ["لیست پرداخت‌ها 💳", "تطبیق مالی ⚖️"],
      ["بازگشت به پنل ادمین"],
    ]);
  });

  it("support landing: exact labels (ButtonText-backed) and callbacks", async () => {
    const kb = await buildSupportLandingKeyboard();
    expect(rows(kb).map((row) => row.map((b) => b.text))).toEqual([
      ["ایجاد تیکت جدید ➕"],
      ["تیکت‌های من 📋"],
      ["بازگشت به منوی اصلی"],
    ]);
    expect(callbacks(kb)).toEqual(["user:sup:new", "user:sup:list:1", CB.USER_MENU]);
    // The registry carries the two ButtonText defaults these labels come from.
    expect(INITIAL_BUTTON_TEXTS.find((b) => b.key === "new_ticket")?.text).toBe(
      "ایجاد تیکت جدید ➕",
    );
    expect(INITIAL_BUTTON_TEXTS.find((b) => b.key === "my_tickets")?.text).toBe(
      "تیکت‌های من 📋",
    );
  });

  it("history landing: exact labels and callbacks", async () => {
    const kb = await buildHistoryLandingKeyboard();
    expect(rows(kb).map((row) => row.map((b) => b.text))).toEqual([
      ["همه سفارش‌ها 📋"],
      ["خرید اشتراک‌ها 🔐", "محصولات دیگر 🛍"],
      ["پرداخت‌ها 💳", "تراکنش‌های کیف پول 🏦"],
      ["بازگشت به منوی اصلی"],
    ]);
    expect(callbacks(kb)).toEqual([
      "user:hist:list:1",
      "user:hist:sub:1",
      "user:orders:list:1",
      "user:payhist:list:1",
      "user:hist:wtx:1",
      CB.USER_MENU,
    ]);
  });
});

// --- 6-8, 10, 26, 30: service detail ------------------------------------------

describe("service detail page (approved fields, no dead/unfinished buttons)", () => {
  it("serviceDetailText carries every approved field label", () => {
    const text = serviceDetailText(fakeService());
    for (const field of [
      "وضعیت:",
      "نام سرویس:",
      "نام محصول:",
      "لوکیشن / پنل:",
      "ترافیک کل:",
      "ترافیک مصرف‌شده:",
      "ترافیک باقی‌مانده:",
      "تاریخ اتمام:",
      "روزهای باقی‌مانده:",
    ]) {
      expect(text, `detail must render: ${field}`).toContain(field);
    }
  });

  it("hides every unfinished capability instead of rendering it dead", async () => {
    const userLabels = labels(await buildUserMainKeyboard());
    // «تعرفه» (Pricing) graduated to a real, always-visible row in the
    // public-pricing-catalog phase, so it is no longer a forbidden/dead label.
    for (const forbidden of ["آموزش", "اشتراک رایگان", "زیرمجموعه", "نمایندگی", "گردونه"]) {
      for (const label of userLabels) {
        expect(label, `user menu must not show: ${forbidden}`).not.toContain(forbidden);
      }
    }
    const detailLabels = labels(serviceDetailKeyboard(fakeService(), ALL_ACTIONS));
    for (const forbidden of ["QR Code", "تغییر یادداشت ✏️", "انتقال سرویس", "آموزش اتصال"]) {
      expect(detailLabels, `detail must not show: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("every service-detail callback targets a live route family (no dead callbacks)", () => {
    const detail = callbacks(serviceDetailKeyboard(fakeService(), ALL_ACTIONS));
    expect(detail.length).toBeGreaterThanOrEqual(8);
    for (const cb of detail) {
      expect(cb).toMatch(/^(user:(svc|nsvc|arn|sub|renew|ev|et):|user:support$|user:menu$)/);
    }
  });

  it("back routes: finance -> admin panel, wallet -> main menu, detail -> list + menu", () => {
    expect(labels(financeLandingKeyboard())).toContain("بازگشت به پنل ادمین");
    const wallet = walletMainKeyboard();
    expect(rows(wallet).at(-1)?.map((b) => b.text)).toEqual(["بازگشت به منوی اصلی"]);
    const lastRow = rows(serviceDetailKeyboard(fakeService(), ALL_ACTIONS)).at(-1);
    expect(lastRow?.map((b) => b.text)).toEqual(["بازگشت به لیست", "بازگشت به منوی اصلی"]);
  });

  it("HTML-escapes a hostile productNameSnapshot (parseMode HTML safety)", () => {
    const text = serviceDetailText(
      fakeService({ productNameSnapshot: "پلن <b>ویژه</b>" }),
    );
    expect(text).toContain("پلن &lt;b&gt;ویژه&lt;/b&gt;");
    expect(text).not.toContain("پلن <b>ویژه");
  });

  it("never renders a raw ServiceStatus enum member to the user", () => {
    for (const status of Object.values(ServiceStatus)) {
      const text = serviceDetailText(fakeService({ status }));
      for (const member of Object.values(ServiceStatus)) {
        expect(text, `status ${status} must not leak ${member}`).not.toMatch(
          new RegExp(`\\b${member}\\b`),
        );
      }
    }
  });

  it("never renders a raw CheckoutStatus enum member to the user", () => {
    for (const status of Object.values(CheckoutStatus)) {
      const text = checkoutViewText(fakeCheckout({ status }));
      for (const member of Object.values(CheckoutStatus)) {
        expect(text, `status ${status} must not leak ${member}`).not.toMatch(
          new RegExp(`\\b${member}\\b`),
        );
      }
      expect(text).toContain("وضعیت:");
    }
  });
});

// --- 9: every visible user-main button reaches a registered handler ----------

describe("user main menu handler coverage", () => {
  function sourceFiles(): string[] {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) {
          walk(p);
        } else if (p.endsWith(".ts")) {
          files.push(p);
        }
      }
    };
    walk(srcRoot);
    return files;
  }

  it("every user-main callback appears in a callbackQuery() registration", async () => {
    // Whole-tree dead-button analysis lives in navigation-integrity.test.ts;
    // this locks the SEVEN visible main-menu entries by resolving constant
    // references (CB.*, CO_CB.*) against every literal callback map in src.
    const sources = sourceFiles().map((f) => readFileSync(f, "utf8"));
    const constMap = new Map<string, string>();
    for (const src of sources) {
      for (const m of src.matchAll(
        /([A-Za-z0-9_]+):\s*"((?:user|admin|common|terms|force_join):[a-z0-9_:.]+)"/g,
      )) {
        constMap.set(m[1], m[2]);
      }
    }
    const registered = new Set<string>();
    for (const src of sources) {
      for (const m of src.matchAll(
        /callbackQuery\(\s*(\[[^\]]+\]|"[^"]+"|[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z0-9_]+)/g,
      )) {
        for (const part of m[1].replace(/[[\]\s]/g, "").split(",")) {
          if (part.startsWith('"')) {
            registered.add(part.replaceAll('"', ""));
          } else if (part.includes(".")) {
            const value = constMap.get(part.split(".")[1]);
            if (value !== undefined) {
              registered.add(value);
            }
          }
        }
      }
    }
    for (const cb of callbacks(await buildUserMainKeyboard())) {
      expect(registered, `no handler registered for ${cb}`).toContain(cb);
    }
    expect(registered).toContain(CB.USER_MENU);
  });
});

// --- 11-13: invoice + card-to-card rendering ----------------------------------

describe("invoice and card-to-card rendering", () => {
  it("pre-invoice without discount: approved layout, no discount lines", () => {
    const text = preInvoiceText(fakeProduct, fakeUser, fakeDraft());
    for (const line of [
      "🧾",
      "پیش‌فاکتور شما",
      "🌿 نام سرویس:",
      "🌐 لوکیشن:",
      "⏳ مدت اعتبار:",
      "🧯 حجم سرویس:",
      "💵 قیمت:",
      "🏦 موجودی کیف پول:",
    ]) {
      expect(text, `pre-invoice must render: ${line}`).toContain(line);
    }
    expect(text).not.toContain("قیمت اصلی");
  });

  it("pre-invoice with discount: original price, discount and final amount", () => {
    const text = preInvoiceText(
      fakeProduct,
      fakeUser,
      fakeDraft({
        discountCode: "OFF10",
        discountCodeId: "deadbeef-0000-0000-0000-000000000000",
        discountAmountToman: 15_000,
        finalPriceToman: 135_000,
      }),
    );
    expect(text).toContain("💵 قیمت اصلی:");
    expect(text).toContain("🎟 تخفیف:");
    expect(text).toContain("✅");
    expect(text).toContain("مبلغ نهایی:");
  });

  it("card-to-card page: approved copy and button rows", () => {
    const account = { ownerName: "علی رضایی" } as unknown as CardToCardAccount;
    const text = cardToCardText(fakeCheckout(), account, "6037991234567890");
    expect(text).toContain("برای تکمیل پرداخت، مبلغ");
    expect(text).toContain("====================");
    expect(text).toContain("سپس روی «پرداخت کردم» بزنید و رسید را ارسال کنید.");

    const kb = cardToCardKeyboard(fakeCheckout(), "6037991234567890");
    expect(rows(kb)[0].map((b) => b.text)).toEqual(["کپی مبلغ", "کپی شماره کارت"]);
    expect(rows(kb)[1].map((b) => b.text)).toEqual(["پرداخت کردم ✅", "بازگشت"]);
  });
});

// --- 14-18: flow message constants ---------------------------------------------

describe("payment / wallet / service / support / admin message constants", () => {
  it("receipt prompt and duplicate-receipt copy (source-locked, not exported)", () => {
    const paymentHandler = readSource("apps/bot/src/handlers/user-checkout/payment.handler.ts");
    expect(paymentHandler).toContain(
      'RECEIPT_PROMPT = "لطفاً تصویر یا فایل رسید پرداخت را ارسال کنید."',
    );
    const methodService = readSource("apps/bot/src/services/payment-method.service.ts");
    expect(methodService).toContain("این پرداخت قبلاً رسید دریافت کرده است.");
  });

  it("approval notices lead with the approved head for EVERY order type", () => {
    for (const orderType of Object.values(OrderType)) {
      expect(
        approvalUserNotice(orderType).startsWith("پرداخت شما تایید شد ✅"),
        `approval head for ${orderType}`,
      ).toBe(true);
    }
  });

  it("rejection notice carries the admin reason behind «دلیل:»", () => {
    const text = rejectionUserNotice("مبلغ واریزی اشتباه است");
    expect(text).toContain("دلیل: مبلغ واریزی اشتباه است");
    expect(text.startsWith("پرداخت شما رد شد.")).toBe(true);
  });

  it("wallet texts: insufficient balance, wallet-paid, registry prompts", () => {
    expect(INSUFFICIENT_BALANCE_TEXT).toBe("موجودی کیف پول شما کافی نیست.");
    expect(
      WALLET_PAYMENT_DONE_TEXT.startsWith("پرداخت از کیف پول با موفقیت انجام شد ✅"),
    ).toBe(true);
    expect(
      INITIAL_MESSAGE_TEMPLATES.find((t) => t.key === "wallet_topup_amount_prompt")
        ?.defaultContent,
    ).toBe("مبلغ موردنظر برای افزایش موجودی را به تومان وارد کنید.");
    expect(
      INITIAL_MESSAGE_TEMPLATES.find((t) => t.key === "wallet_empty_transactions_text")
        ?.defaultContent,
    ).toBe("هنوز تراکنشی برای کیف پول شما ثبت نشده است.");
  });

  it("service lifecycle texts: toggle, sync, link regeneration", () => {
    expect(TOGGLE_DISABLED_OK_TEXT).toBe("سرویس با موفقیت غیرفعال شد.");
    expect(TOGGLE_ENABLED_OK_TEXT).toBe("سرویس با موفقیت فعال شد.");
    expect(TOGGLE_FAILED_TEXT).toBe(
      "تغییر وضعیت سرویس انجام نشد. لطفاً کمی بعد دوباره تلاش کنید.",
    );
    expect(SYNC_OK_TEXT).toBe("اطلاعات سرویس بروزرسانی شد ✅");
    expect(SYNC_FAILED_USER_TEXT).toBe("بروزرسانی اطلاعات سرویس موقتاً امکان‌پذیر نیست.");
    expect(SYNC_NOT_FOUND_TEXT).toBe("سرویس در پنل پیدا نشد.");
    expect(REGEN_SUCCESS_TEXT).toBe("لینک اشتراک جدید ساخته شد ✅");
  });

  it("support texts: prompts, created-confirmation and closed-ticket guard", () => {
    expect(
      INITIAL_MESSAGE_TEMPLATES.find((t) => t.key === "support_subject_prompt")
        ?.defaultContent.startsWith("موضوع تیکت را وارد کنید."),
    ).toBe(true);
    expect(
      INITIAL_MESSAGE_TEMPLATES.find((t) => t.key === "support_message_prompt")
        ?.defaultContent.startsWith("پیام خود را برای پشتیبانی ارسال کنید."),
    ).toBe(true);
    expect(
      INITIAL_MESSAGE_TEMPLATES.find((t) => t.key === "support_ticket_created_text")
        ?.defaultContent,
    ).toBe("تیکت شما با موفقیت ثبت شد ✅");
    expect(TICKET_CLOSED_TEXT).toBe(
      "این تیکت بسته شده است و امکان ارسال پاسخ جدید وجود ندارد.",
    );
  });

  it("admin text editor: non-editable guard and update/reset toasts", () => {
    expect(NOT_EDITABLE_TEXT).toContain("این متن قابل ویرایش نیست");
    const handler = readSource("apps/bot/src/handlers/admin-settings/text-settings.handler.ts");
    expect(handler).toContain("متن با موفقیت بروزرسانی شد ✅");
    expect(handler).toContain("متن به مقدار پیش‌فرض بازنشانی شد ✅");
  });
});

// --- 19-20, 27: the seed registry ------------------------------------------------

describe("seed registry (single source of default copy)", () => {
  it("every template row is complete with a unique key", () => {
    for (const row of INITIAL_MESSAGE_TEMPLATES) {
      expect(row.key, "template key must be non-empty").not.toBe("");
      expect(row.title, `title for ${row.key}`).not.toBe("");
      expect(row.defaultContent, `defaultContent for ${row.key}`).not.toBe("");
    }
    const keys = INITIAL_MESSAGE_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("gate templates carry the approved sentences", () => {
    const byKey = new Map(INITIAL_MESSAGE_TEMPLATES.map((t) => [t.key, t.defaultContent]));
    expect(byKey.get("bot_off_text")).toBe(
      "ربات در حال بروزرسانی است. لطفاً کمی بعد دوباره تلاش کنید.",
    );
    expect(byKey.get("blocked_text")).toBe(
      "حساب کاربری شما مسدود شده است. برای بررسی بیشتر با پشتیبانی تماس بگیرید.",
    );
    expect(byKey.get("terms_text")).toBe(
      "برای استفاده از ربات، ابتدا قوانین را مطالعه و تایید کنید.",
    );
    expect(byKey.get("force_join_text")).toBe(
      "برای ادامه، ابتدا در کانال‌های مشخص‌شده عضو شوید.",
    );
  });

  it("every button row is complete, unique and within Telegram's 64-char label budget", () => {
    for (const row of INITIAL_BUTTON_TEXTS) {
      expect(row.key, "button key must be non-empty").not.toBe("");
      expect(row.title, `title for ${row.key}`).not.toBe("");
      expect(row.text, `text for ${row.key}`).not.toBe("");
      expect(row.text.length, `label length for ${row.key}`).toBeLessThanOrEqual(64);
    }
    const keys = INITIAL_BUTTON_TEXTS.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
    const byKey = new Map(INITIAL_BUTTON_TEXTS.map((b) => [b.key, b.text]));
    expect(byKey.get("back_to_list")).toBe("بازگشت به لیست");
    expect(byKey.get("back_to_admin")).toBe("بازگشت به پنل ادمین");
    expect(byKey.get("main_menu")).toBe("بازگشت به منوی اصلی");
  });

  it("no allowed variable is secret-shaped (registry level)", () => {
    const allNames = INITIAL_MESSAGE_TEMPLATES.flatMap((t) => t.allowedVariables);
    for (const name of allNames) {
      for (const forbidden of [
        "token",
        "password",
        "cookie",
        "secret",
        "database_url",
        "file_id",
      ]) {
        expect(name.toLowerCase(), `variable ${name}`).not.toContain(forbidden);
      }
    }
  });
});

// --- 21-23: variable validation, rendering, fallbacks --------------------------

describe("template variables and fallbacks", () => {
  it("rejects unknown variables with the approved Persian safeMessage", () => {
    const outcome = validateTemplateContentVariables(["first_name"], "", "x {bogus}");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.invalidNames).toContain("bogus");
      expect(outcome.safeMessage).toBe("متغیر استفاده‌شده در این قالب معتبر نیست.");
      expect(outcome.safeMessage).toBe(INVALID_TEMPLATE_VARIABLE_TEXT);
    }
  });

  it("rejects secret-shaped names even when the allowed list carries them", () => {
    const outcome = validateTemplateContentVariables(
      ["panel_token"],
      "",
      "توکن: {panel_token}",
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.invalidNames).toContain("panel_token");
    }
  });

  it("renderTemplateOmitMissing drops lines for missing optional variables", () => {
    const template = "سلام {first_name}\nنام کاربری: {username}\n\nخوش آمدید";
    const without = renderTemplateOmitMissing(template, {
      first_name: "علی",
      username: undefined,
    });
    expect(without).toContain("سلام علی");
    expect(without).not.toContain("نام کاربری");
    expect(without).not.toContain("{username}");
    expect(without).not.toContain("\n\n\n");
    const withUsername = renderTemplateOmitMissing(template, {
      first_name: "علی",
      username: "ali_r",
    });
    expect(withUsername).toContain("نام کاربری: ali_r");
  });

  it("falls back to registry defaults, never to the bare template key", async () => {
    const start = await getMessageTemplate("start_text");
    expect(start).toContain("خوش آمدید");
    expect(start).not.toBe("start_text");
  });

  it("getButtonText returns the key itself only as the very last resort", async () => {
    expect(await getButtonText("nonexistent_key_xyz")).toBe("nonexistent_key_xyz");
  });
});

// --- 25 (source half): seed refresh preserves operator-customized texts --------

describe("seed default-refresh semantics (source)", () => {
  it("seed.ts only moves currentContent along when it was never customized", () => {
    const seed = readFileSync(
      path.join(repoRoot, "packages/database/src/seed.ts"),
      "utf8",
    );
    expect(seed).toContain("existing.currentContent === existing.defaultContent");
    expect(seed).toContain("existing.currentText === existing.defaultText");
  });
});

// --- 28: Telegram callback-data budget ------------------------------------------

describe("callback data stays within Telegram's 64-byte limit", () => {
  it("user main, admin main, finance, service detail and wallet keyboards", async () => {
    const keyboards = [
      await buildUserMainKeyboard(),
      await buildAdminMainKeyboard(activeAdmin),
      financeLandingKeyboard(),
      serviceDetailKeyboard(fakeService(), ALL_ACTIONS),
      walletMainKeyboard(),
    ];
    for (const kb of keyboards) {
      for (const cb of callbacks(kb)) {
        expect(Buffer.byteLength(cb, "utf8"), `callback too long: ${cb}`).toBeLessThanOrEqual(
          64,
        );
      }
    }
  });
});

// --- 24, 25 (behavioral half), 29: DB-backed semantics ---------------------------

describe.runIf(hasDb)("text cache, seed refresh and label/callback independence (DB)", () => {
  const cacheKey = `pta_cache_${tag}`;
  const customizedKey = `pta_seed_custom_${tag}`;
  const uncustomizedKey = `pta_seed_plain_${tag}`;

  afterAll(async () => {
    await prisma.messageTemplate.deleteMany({
      where: { key: { in: [cacheKey, customizedKey, uncustomizedKey] } },
    });
    clearTextCache();
    await prisma.$disconnect();
  });

  it("getMessageTemplate caches for 30s; clearTextCache makes edits visible", async () => {
    await prisma.messageTemplate.create({
      data: {
        key: cacheKey,
        title: "قالب آزمایشی کش",
        category: "test",
        defaultContent: "متن قدیمی",
        currentContent: "متن قدیمی",
        allowedVariables: [],
      },
    });
    clearTextCache();
    expect(await getMessageTemplate(cacheKey)).toBe("متن قدیمی");
    // A direct row update (no service-layer cache clear) stays invisible...
    await prisma.messageTemplate.update({
      where: { key: cacheKey },
      data: { currentContent: "متن تازه" },
    });
    expect(await getMessageTemplate(cacheKey)).toBe("متن قدیمی");
    // ...until the cache is dropped (the admin editor calls this on save).
    clearTextCache();
    expect(await getMessageTemplate(cacheKey)).toBe("متن تازه");
  });

  it("the seed refresh rule never overwrites operator-customized texts", async () => {
    const oldDefault = "پیش‌فرض قدیمی";
    const newDefault = "پیش‌فرض جدید تاییدشده";
    const operatorText = "متن سفارشی اپراتور";
    await prisma.messageTemplate.create({
      data: {
        key: customizedKey,
        title: "قالب سفارشی‌شده",
        category: "test",
        defaultContent: oldDefault,
        currentContent: operatorText,
        allowedVariables: [],
      },
    });
    await prisma.messageTemplate.create({
      data: {
        key: uncustomizedKey,
        title: "قالب دست‌نخورده",
        category: "test",
        defaultContent: oldDefault,
        currentContent: oldDefault,
        allowedVariables: [],
      },
    });
    // The exact decision seed.ts makes when the registry default changes
    // (asserted against its source above): refresh the DEFAULT always,
    // move CURRENT along only when current === old default.
    for (const key of [customizedKey, uncustomizedKey]) {
      const existing = await prisma.messageTemplate.findUniqueOrThrow({ where: { key } });
      const uncustomized = existing.currentContent === existing.defaultContent;
      await prisma.messageTemplate.update({
        where: { key },
        data: {
          defaultContent: newDefault,
          ...(uncustomized ? { currentContent: newDefault } : {}),
        },
      });
    }
    const customized = await prisma.messageTemplate.findUniqueOrThrow({
      where: { key: customizedKey },
    });
    expect(customized.currentContent).toBe(operatorText);
    expect(customized.defaultContent).toBe(newDefault);
    const plain = await prisma.messageTemplate.findUniqueOrThrow({
      where: { key: uncustomizedKey },
    });
    expect(plain.currentContent).toBe(newDefault);
  });

  it("editing a button LABEL never changes its callback (labels carry no behavior)", async () => {
    const original = await prisma.buttonText.upsert({
      where: { key: "buy_subscription" },
      update: {},
      create: {
        key: "buy_subscription",
        title: "خرید اشتراک",
        defaultText: "خرید اشتراک 🔐",
        currentText: "خرید اشتراک 🔐",
      },
    });
    try {
      await prisma.buttonText.update({
        where: { key: "buy_subscription" },
        data: { currentText: "خرید سرویس ویژه 🚀" },
      });
      clearTextCache();
      const kb = await buildUserMainKeyboard();
      const buyButton = rows(kb)
        .flat()
        .find((b) => b.callback_data === CB.USER_BUY);
      expect(buyButton?.text).toBe("خرید سرویس ویژه 🚀");
      expect(buyButton?.callback_data).toBe("user:buy");
    } finally {
      await prisma.buttonText.update({
        where: { key: "buy_subscription" },
        data: { currentText: original.currentText },
      });
      clearTextCache();
    }
  });
});
