import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  INITIAL_BUTTON_TEXTS,
  INITIAL_MESSAGE_TEMPLATES,
  prisma,
  type Order,
  type Payment,
  type User,
} from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "fix-d-test-secret-fix-d-test-secret-1234";

import { CB } from "../src/core/callbacks.js";
import { buildHistoryLandingKeyboard } from "../src/handlers/user-orders/orders.handler.js";
import {
  buildSupportLandingKeyboard,
  buildTicketDetailKeyboard,
} from "../src/handlers/user-support/support.handler.js";
import { transactionHistoryKeyboard } from "../src/handlers/user-wallet/wallet-views.js";
import { getButtonText, getMessageTemplate } from "../src/services/text.service.js";
import {
  listUserHistory,
  listUserSubscriptionOrders,
} from "../src/services/user-history.service.js";
import type { TicketWithMessages } from "../src/services/support-ticket.service.js";

// =============================================================================
// Corrective Fix D: the support landing/detail navigation, the history
// landing (all/subscription/other/payments/wallet-tx), same-page returns
// and the operator-editable support/history texts. DB parts skip without
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

function src(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

describe("support navigation (Fix D)", () => {
  it("landing has the exact rows and uses the MessageTemplate", async () => {
    const kb = await buildSupportLandingKeyboard();
    expect(rows(kb).map((row) => row.map((b) => b.callback_data))).toEqual([
      ["user:sup:new"],
      ["user:sup:list:1"],
      [CB.USER_MENU],
    ]);
    const labels = rows(kb).flat().map((b) => b.text);
    expect(labels).toEqual(["ایجاد تیکت جدید ➕", "تیکت‌های من 📋", "بازگشت به منوی اصلی"]);
    const handler = src("apps/bot/src/handlers/user-support/support.handler.ts");
    expect(handler).toContain('getMessageTemplate("support_landing_text")');
    expect(handler).toContain('getMessageTemplate("support_subject_prompt"');
    // Support Tickets V2 unified the message + reply prompts into one template
    // that mentions text-or-attachment input.
    expect(handler).toContain('getMessageTemplate("support_message_or_attachment_prompt"');
    expect(handler).toContain('getMessageTemplate("support_empty_tickets_text")');
    expect(handler).toContain('getMessageTemplate("support_ticket_created_text")');
  });

  it("open tickets show reply + refresh; closed tickets never offer reply", async () => {
    const ticket = { id: "abcdef12-0000-0000-0000-000000000000", status: "WAITING_ADMIN" };
    const open = await buildTicketDetailKeyboard(
      ticket as Pick<TicketWithMessages, "id" | "status">,
      2,
    );
    const openCbs = callbacks(open);
    expect(openCbs).toContain("user:sup:reply:abcdef12");
    expect(openCbs).toContain("user:sup:view:abcdef12"); // refresh
    expect(openCbs).toContain("user:sup:list:2"); // same-page return
    expect(openCbs).toContain(CB.USER_SUPPORT);

    const closed = await buildTicketDetailKeyboard(
      { id: ticket.id, status: "CLOSED" } as Pick<TicketWithMessages, "id" | "status">,
      3,
    );
    const closedCbs = callbacks(closed);
    expect(closedCbs).not.toContain("user:sup:reply:abcdef12");
    expect(closedCbs).toContain("user:sup:view:abcdef12");
    expect(closedCbs).toContain("user:sup:list:3");
  });

  it("ticket list stays owner-scoped and stores the page for back-navigation", () => {
    const handler = src("apps/bot/src/handlers/user-support/support.handler.ts");
    expect(handler).toContain("listUserTickets(user.id, page)");
    expect(handler).toContain("ctx.session.temp.userTicketListPage = pageData.page");
  });
});

describe("history navigation (Fix D)", () => {
  it("history landing has the exact Fix D rows", async () => {
    const kb = await buildHistoryLandingKeyboard();
    expect(rows(kb).map((row) => row.map((b) => b.callback_data))).toEqual([
      ["user:hist:list:1"],
      ["user:hist:sub:1", "user:orders:list:1"],
      ["user:payhist:list:1", "user:hist:wtx:1"],
      [CB.USER_MENU],
    ]);
    const labels = rows(kb).flat().map((b) => b.text);
    expect(labels).toEqual([
      "همه سفارش‌ها 📋",
      "خرید اشتراک‌ها 🔐",
      "محصولات دیگر 🛍",
      "پرداخت‌ها 💳",
      "تراکنش‌های کیف پول 🏦",
      "بازگشت به منوی اصلی",
    ]);
  });

  it("wallet history returns to the correct source", () => {
    // From the wallet: the existing route keeps its wallet backs.
    const fromWallet = callbacks(
      transactionHistoryKeyboard({ transactions: [], page: 1, pages: 1, total: 0 }),
    );
    expect(fromWallet).toContain(CB.USER_WALLET);
    expect(fromWallet).not.toContain(CB.USER_ORDERS);
    // From history: the new user:hist:wtx route backs to the history landing.
    const handler = src("apps/bot/src/handlers/user-orders/orders.handler.ts");
    expect(handler).toContain("user:hist:wtx:");
    expect(handler).toContain('getButtonText("back_to_history")');
    expect(handler).toContain('getMessageTemplate("wallet_empty_transactions_text")');
  });

  it("order/payment details return to the same list/page (session context)", () => {
    const handler = src("apps/bot/src/handlers/user-orders/orders.handler.ts");
    expect(handler).toContain("ctx.session.temp.userHistListKind = kind");
    expect(handler).toContain("ctx.session.temp.userHistListPage = pageInfo.page");
    expect(handler).toContain("ctx.session.temp.userPayListPage = pageData.page");
    expect(handler).toContain("PAY_CB.list(ctx.session.temp.userPayListPage ?? 1)");
  });

  it("payment pages never render file ids or secrets", () => {
    const handler = src("apps/bot/src/handlers/user-orders/orders.handler.ts");
    expect(handler).not.toContain("fileId");
    expect(handler).not.toContain("callbackPayload");
    expect(handler).not.toContain("idempotencyKey");
    // Receipts appear only as a sent/not-sent marker.
    expect(handler).toContain('payment.receipts.length > 0 ? "ارسال شده ✅" : "—"');
  });
});

describe("Fix D texts (fallbacks + seeds)", () => {
  const templates = [
    "support_landing_text",
    "support_subject_prompt",
    "support_message_prompt",
    "support_reply_prompt",
    "support_empty_tickets_text",
    "support_ticket_created_text",
    "history_landing_text",
    "no_payments_text",
    "no_other_product_orders_text",
  ];
  const buttons = [
    "new_ticket",
    "my_tickets",
    "reply_ticket",
    "refresh",
    "all_orders",
    "subscription_orders",
    "other_product_orders",
    "payments",
    "wallet_transactions",
    "back_to_support",
    "back_to_history",
    "next",
    "previous",
  ];

  it("every key has a registry default (fallbacks derive from it)", async () => {
    // Fallbacks come from the seed registry (seed-data.ts) since the
    // Persian text-alignment phase - assert the registry rows directly.
    const templateKeys = INITIAL_MESSAGE_TEMPLATES.map((t) => t.key);
    const buttonKeys = INITIAL_BUTTON_TEXTS.map((b) => b.key);
    for (const key of templates) {
      expect(templateKeys, `registry row for ${key}`).toContain(key);
      expect(await getMessageTemplate(key)).not.toBe(key);
    }
    for (const key of buttons) {
      expect(buttonKeys, `registry row for ${key}`).toContain(key);
      expect(await getButtonText(key)).not.toBe(key);
    }
    // No duplicate keys within either registry.
    expect(new Set(templateKeys).size).toBe(templateKeys.length);
    expect(new Set(buttonKeys).size).toBe(buttonKeys.length);
  });

  it("prompts render the real validation limits via {min}/{max}", async () => {
    expect(
      await getMessageTemplate("support_subject_prompt", undefined, { min: 3, max: 100 }),
    ).toBe("موضوع تیکت را وارد کنید. (3 تا 100 کاراکتر)");
    expect(await getMessageTemplate("support_message_prompt", undefined, { max: 3000 })).toBe(
      "پیام خود را برای پشتیبانی ارسال کنید. (حداکثر 3000 کاراکتر)",
    );
  });
});

describe("locked flows (Fix D regression)", () => {
  it("CB.USER_BUY and CB.USER_OTHER_PRODUCTS are unchanged", () => {
    expect(CB.USER_BUY).toBe("user:buy");
    expect(CB.USER_OTHER_PRODUCTS).toBe("user:other_products");
  });
});

describe.runIf(hasDb)("unified history dedup (Fix D, DB)", () => {
  let user: User;
  let order: Order;
  let orderPayment: Payment;
  let topup: Payment;

  beforeAll(async () => {
    user = await prisma.user.create({
      data: { telegramId: runTag, firstName: "FixD", group: "F" },
    });
    order = await prisma.order.create({
      data: {
        userId: user.id,
        type: "SERVICE_PURCHASE",
        status: "COMPLETED",
        productNameSnapshot: `fixd-order-${runTag}`,
        finalPriceToman: 90_000,
        paidAt: new Date(),
        completedAt: new Date(),
      },
    });
    // The order's settled payment (must NOT appear as a separate row).
    orderPayment = await prisma.payment.create({
      data: {
        userId: user.id,
        purpose: "ORDER_PAYMENT",
        status: "APPROVED",
        amountToman: 90_000,
        payableAmountToman: 90_000,
        orderId: order.id,
      },
    });
    // A wallet top-up (order-less payment - appears exactly once).
    topup = await prisma.payment.create({
      data: {
        userId: user.id,
        purpose: "WALLET_CHARGE",
        status: "APPROVED",
        amountToman: 50_000,
        payableAmountToman: 50_000,
      },
    });
  });

  afterAll(async () => {
    await prisma.payment.deleteMany({ where: { userId: user.id } });
    await prisma.order.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("order payments are represented by their order; top-ups appear once", async () => {
    const page = await listUserHistory(user.id, 1);
    const orderRows = page.items.filter((i) => i.kind === "order" && i.id === order.id);
    const orderPaymentRows = page.items.filter(
      (i) => i.kind === "payment" && i.id === orderPayment.id,
    );
    const topupRows = page.items.filter((i) => i.kind === "payment" && i.id === topup.id);
    expect(orderRows.length).toBe(1);
    expect(orderPaymentRows.length).toBe(0); // no duplicate row for the order's payment
    expect(topupRows.length).toBe(1); // wallet top-up exactly once
  });

  it("the subscription filter lists service orders and stays owner-scoped", async () => {
    const page = await listUserSubscriptionOrders(user.id, 1);
    expect(page.orders.map((o) => o.id)).toContain(order.id);
    const stranger = await listUserSubscriptionOrders("00000000-0000-0000-0000-000000000000", 1);
    expect(stranger.total).toBe(0);
  });
});
