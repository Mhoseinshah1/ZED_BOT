import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prisma, type Service, type User } from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "fix-a-test-secret-fix-a-test-secret-1234";

import { CB } from "../src/core/callbacks.js";
import {
  financeLandingKeyboard,
  FIN_CB,
} from "../src/handlers/admin-finance/admin-finance-views.js";
import { rncb } from "../src/handlers/user-renewal/renewal-views.js";
import { serviceDetailKeyboard } from "../src/handlers/user-services/service-views.js";
import {
  topupPreInvoiceText,
  transactionHistoryText,
  walletMainKeyboard,
  walletSummaryText,
  WALLET_CB,
} from "../src/handlers/user-wallet/wallet-views.js";
import { buildAdminMainKeyboard } from "../src/keyboards/admin-main.keyboard.js";
import { buildUserMainKeyboard } from "../src/keyboards/user-main.keyboard.js";
import { getMessageTemplate } from "../src/services/text.service.js";
import type { ServiceDetailActions } from "../src/services/user-services.service.js";
import { getWalletSummary } from "../src/services/wallet.service.js";

// =============================================================================
// Corrective UI/UX Fix A: admin finance nesting (receipts off the root, into
// the finance landing), the trimmed wallet landing with pendingOrders and
// MessageTemplate-backed texts, and the direct «تمدید سرویس ♻️» button on the
// service detail page. Locked flows (subscription purchase, OTHER_PRODUCT
// separation) are asserted unchanged. DB-dependent parts skip without
// DATABASE_URL (docs/testing.md).
// =============================================================================

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const hasDb =
  typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));

type Button = { text: string; callback_data?: string };

function rows(kb: { inline_keyboard: unknown }): Button[][] {
  return kb.inline_keyboard as Button[][];
}

function callbacks(kb: { inline_keyboard: unknown }): string[] {
  return rows(kb)
    .flat()
    .map((b) => b.callback_data ?? "");
}

describe("admin root / finance nesting (Fix A)", () => {
  it("admin root has the Fix A rows and no receipts button", () => {
    const kb = buildAdminMainKeyboard();
    expect(rows(kb).map((row) => row.map((b) => b.callback_data))).toEqual([
      [CB.ADMIN_FINANCE, CB.ADMIN_USERS],
      [CB.ADMIN_PRODUCTS, CB.ADMIN_PANELS],
      [CB.ADMIN_OTHER_PRODUCTS],
      [CB.ADMIN_SUPPORT, CB.ADMIN_BROADCAST],
      [CB.ADMIN_GENERAL_SETTINGS, CB.ADMIN_REPORTS_BACKUP],
    ]);
    expect(callbacks(kb)).not.toContain(CB.ADMIN_RECEIPTS);
  });

  it("finance landing carries receipts, methods/settings, users + reports, back", () => {
    const kb = financeLandingKeyboard();
    expect(rows(kb).map((row) => row.map((b) => b.callback_data))).toEqual([
      [CB.ADMIN_RECEIPTS],
      [FIN_CB.methods, FIN_CB.settings],
      [CB.ADMIN_USERS, "admin:fin:reports"],
      [CB.ADMIN_MENU],
    ]);
    const labels = rows(kb).flat();
    expect(labels[0]?.text).toBe("رسیدهای تاییدنشده 💵");
    expect(labels.find((b) => b.callback_data === CB.ADMIN_USERS)?.text).toBe(
      "مدیریت کیف پول کاربران 👤",
    );
    expect(labels.at(-1)?.text).toBe("بازگشت به پنل ادمین");
  });

  it("the old CB.ADMIN_RECEIPTS handler stays registered", () => {
    const src = readFileSync(
      path.join(repoRoot, "apps/bot/src/handlers/admin-receipts/receipts.handler.ts"),
      "utf8",
    );
    expect(src).toMatch(/callbackQuery\(\s*\[\s*CB\.ADMIN_RECEIPTS/);
  });
});

describe("wallet landing (Fix A)", () => {
  const user = {
    telegramId: 777_000_111n,
    firstName: "علی",
    lastName: "رضایی",
    username: "ali_r",
    phoneNumber: null,
    joinedAt: new Date("2026-01-05T10:00:00Z"),
    lastSeenAt: new Date("2026-07-01T10:00:00Z"),
    group: "F",
    status: "ACTIVE",
    balanceToman: 120_000,
    totalChargedToman: 900_000,
    totalSpentToman: 780_000,
    totalDiscountToman: 15_000,
    totalRefundedToman: 5_000,
  } as unknown as User;
  const summary = { user, totalServices: 2, pendingOrders: 3, referralCount: 4 };
  const text = walletSummaryText(summary, "کیف پول و حساب کاربری 🏦");

  it("renders exactly the agreed fields", () => {
    expect(text).toContain("کیف پول و حساب کاربری 🏦");
    expect(text).toContain("شناسه عددی تلگرام: <code>777000111</code>");
    expect(text).toContain("نام: علی رضایی");
    expect(text).toContain("نام کاربری: @ali_r");
    expect(text).toContain("شماره تماس: ثبت نشده");
    expect(text).toContain("زمان ثبت‌نام: 2026-01-05");
    expect(text).toContain("موجودی کیف پول: <b>120,000 تومان</b>");
    expect(text).toContain("گروه کاربری: کاربر عادی (F)");
    expect(text).toContain("تعداد سرویس‌ها: 2");
    expect(text).toContain("سفارش‌های در انتظار پرداخت/بررسی: 3");
    expect(text).toContain("تعداد زیرمجموعه‌ها: 4");
  });

  it("does not render the removed fields", () => {
    for (const forbidden of [
      "آخرین بازدید",
      "وضعیت کاربر",
      "مجموع شارژ",
      "مجموع خرید",
      "مجموع تخفیف",
      "مجموع برگشتی",
      "تعداد سرویس‌های فعال",
      "تعداد کل سفارش‌ها",
      "سفارش‌های پرداخت‌شده",
      "آخرین تراکنش",
      "تاریخ/ساعت فعلی",
      "900,000",
      "780,000",
    ]) {
      expect(text, `must not render: ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("wallet keyboard has the exact Fix A rows and back label", () => {
    const kb = walletMainKeyboard();
    expect(rows(kb).map((row) => row.map((b) => b.callback_data))).toEqual([
      [WALLET_CB.TOPUP],
      ["user:wallet:tx:1", WALLET_CB.REFRESH],
      [CB.USER_MENU],
    ]);
    expect(rows(kb).at(-1)?.[0]?.text).toBe("بازگشت به منوی اصلی");
  });

  it("transaction empty text and top-up preview note flow in from templates", () => {
    const empty = transactionHistoryText(
      { transactions: [], page: 1, pages: 1, total: 0 },
      "تراکنشی ثبت نشده است.",
    );
    expect(empty).toContain("تراکنشی ثبت نشده است.");
    const preview = topupPreInvoiceText(
      50_000,
      10_000,
      "پس از تایید رسید توسط ادمین، موجودی کیف پول شما افزایش می‌یابد.",
    );
    expect(preview).toContain("مبلغ شارژ: <b>50,000 تومان</b>");
    expect(preview).toContain("موجودی بعد از شارژ: 60,000 تومان");
    expect(preview).toContain(
      "توضیح: پس از تایید رسید توسط ادمین، موجودی کیف پول شما افزایش می‌یابد.",
    );
  });

  it("template values are HTML-escaped (a bad operator edit cannot break the pages)", () => {
    // These messages go out with parseMode HTML - raw '<' from an operator
    // edit must never reach Telegram unescaped.
    const summary2 = walletSummaryText(summary, "شارژ <5000");
    expect(summary2).toContain("شارژ &lt;5000");
    expect(summary2).not.toContain("شارژ <5000");
    const empty = transactionHistoryText(
      { transactions: [], page: 1, pages: 1, total: 0 },
      "<b>خالی",
    );
    expect(empty).toContain("&lt;b&gt;خالی");
    const preview = topupPreInvoiceText(50_000, 10_000, "a<b");
    expect(preview).toContain("توضیح: a&lt;b");
  });

  it("the four wallet MessageTemplate keys have code fallbacks and behave", async () => {
    const defaults: Record<string, string> = {
      wallet_header_text: "کیف پول و حساب کاربری 🏦",
      wallet_topup_amount_prompt: "مبلغ شارژ کیف پول را به تومان وارد کنید.",
      wallet_topup_preview_note:
        "پس از تایید رسید توسط ادمین، موجودی کیف پول شما افزایش می‌یابد.",
      wallet_empty_transactions_text: "تراکنشی ثبت نشده است.",
    };
    // Deterministic: the fallback map itself carries the exact defaults
    // (getMessageTemplate would return DB content instead when a row exists).
    const src = readFileSync(
      path.join(repoRoot, "apps/bot/src/services/text.service.ts"),
      "utf8",
    );
    for (const [key, value] of Object.entries(defaults)) {
      expect(src, `TEMPLATE_FALLBACKS must carry ${key}`).toContain(`${key}: "${value}"`);
      // Behavioral smoke check - resolves via DB row or fallback, never the
      // bare key, in every test configuration.
      expect(await getMessageTemplate(key)).not.toBe(key);
    }
  });

  it("the seed contains the wallet template keys without duplicates", () => {
    const seed = readFileSync(path.join(repoRoot, "packages/database/src/seed.ts"), "utf8");
    // Uniqueness matters only within the MessageTemplate seed array (the DB
    // unique constraint is per-model) - scope the check to that block.
    const block = /INITIAL_MESSAGE_TEMPLATES[^=]*= \[([\s\S]*?)\n\];/.exec(seed)?.[1] ?? "";
    const keys = [...block.matchAll(/key: "([^"]+)"/g)].map((m) => m[1]);
    for (const key of [
      "wallet_header_text",
      "wallet_topup_amount_prompt",
      "wallet_topup_preview_note",
      "wallet_empty_transactions_text",
    ]) {
      expect(keys).toContain(key);
    }
    expect(keys.length).toBeGreaterThanOrEqual(8);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("direct renewal from service detail (Fix A)", () => {
  const service = {
    id: "abcdef12-3456-7890-abcd-ef1234567890",
    username: "svc_user",
    productNameSnapshot: "پلن طلایی",
    panelNameSnapshot: "پنل آلمان",
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
    subscriptionUrl: "https://example.com/sub/abc",
    configLinks: [],
  } as unknown as Service;

  function actions(overrides: Partial<ServiceDetailActions>): ServiceDetailActions {
    return {
      toggleAction: null,
      canBuyExtraVolume: false,
      canBuyExtraTime: false,
      canRegenerateLink: false,
      canRenew: false,
      ...overrides,
    };
  }

  it("shows «تمدید سرویس ♻️» via rncb.service only when canRenew", () => {
    const withRenew = rows(serviceDetailKeyboard(service, actions({ canRenew: true }))).flat();
    const renewButton = withRenew.find((b) => b.text === "تمدید سرویس ♻️");
    expect(renewButton?.callback_data).toBe(rncb.service("abcdef12"));
    expect(renewButton?.callback_data).toBe("user:renew:svc:abcdef12");

    const without = callbacks(serviceDetailKeyboard(service, actions({})));
    expect(without).not.toContain("user:renew:svc:abcdef12");
  });

  it("keeps the required action order (renew after regen-link, before extras)", () => {
    const kb = serviceDetailKeyboard(
      service,
      actions({
        canRenew: true,
        canRegenerateLink: true,
        canBuyExtraVolume: true,
        canBuyExtraTime: true,
        toggleAction: "DISABLE",
      }),
    );
    const flat = callbacks(kb);
    const order = [
      "user:svc:refresh:abcdef12",
      "user:svc:regen_link:abcdef12",
      "user:renew:svc:abcdef12",
      "user:ev:svc:abcdef12",
      "user:svc:disable:abcdef12",
      "user:svc:list:1",
      CB.USER_MENU,
    ];
    const positions = order.map((cb) => flat.indexOf(cb));
    expect(positions).not.toContain(-1);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(rows(kb).at(-1)?.[0]?.text).toBe("بازگشت به منوی اصلی");
  });

  it("canRenew reuses RENEWABLE_STATUSES instead of duplicating status rules", () => {
    const src = readFileSync(
      path.join(repoRoot, "apps/bot/src/services/user-services.service.ts"),
      "utf8",
    );
    expect(src).toContain('import { RENEWABLE_STATUSES } from "./renewal-checkout.service.js"');
    expect(src).toContain("RENEWABLE_STATUSES.includes(service.status)");
  });
});

describe("locked flows (Fix A)", () => {
  it("CB.USER_BUY and CB.USER_OTHER_PRODUCTS are unchanged and separate", async () => {
    expect(CB.USER_BUY).toBe("user:buy");
    expect(CB.USER_OTHER_PRODUCTS).toBe("user:other_products");
    const menu = callbacks(await buildUserMainKeyboard());
    expect(menu).toContain(CB.USER_BUY);
    expect(menu).toContain(CB.USER_OTHER_PRODUCTS);
  });
});

describe.runIf(hasDb)("wallet summary pendingOrders (Fix A, DB)", () => {
  let user: User;

  beforeAll(async () => {
    user = await prisma.user.create({
      data: { telegramId: runTag, firstName: "FixA", group: "F" },
    });
    const statuses = [
      "PENDING_PAYMENT",
      "WAITING_RECEIPT",
      "PENDING_REVIEW",
      "PAID",
      "COMPLETED",
      "CANCELLED",
      "FAILED",
      "REFUNDED",
    ] as const;
    for (const status of statuses) {
      await prisma.order.create({
        data: {
          userId: user.id,
          type: "SERVICE_PURCHASE",
          status,
          productNameSnapshot: `fix-a-${status}`,
          finalPriceToman: 10_000,
        },
      });
    }
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("counts exactly the three unpaid/pending states", async () => {
    const summary = await getWalletSummary(user.id);
    expect(summary.pendingOrders).toBe(3);
    expect(summary.totalServices).toBe(0);
    expect(summary.referralCount).toBe(0);
    expect(summary.user.id).toBe(user.id);
  });
});
