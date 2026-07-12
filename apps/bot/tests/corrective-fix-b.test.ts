import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "fix-b-test-secret-fix-b-test-secret-1234";

import { CB } from "../src/core/callbacks.js";
import type { BotContext } from "../src/core/context.js";
import {
  rcb,
  receiptDetailKeyboard,
  receiptDetailText,
  receiptListKeyboard,
  reviewResultKeyboard,
  sendReceiptMedia,
} from "../src/handlers/admin-receipts/receipts.handler.js";
import {
  userProfileKeyboard,
  userWalletKeyboard,
} from "../src/handlers/admin-users/admin-users-views.js";
import {
  manualOrderDetailKeyboard,
  otherProductsLandingKeyboard,
} from "../src/handlers/admin-manual-orders/manual-orders.handler.js";
import {
  ST_CB,
  stockItemActions,
  stockProductKeyboard,
} from "../src/handlers/admin-stock/stock.handler.js";
import type { PaymentWithRelations } from "../src/services/payment-method.service.js";
import type { ManualOrderDetail } from "../src/services/other-product-delivery.service.js";
import type { OtherProductStockItem, Product } from "@zedbot/database";

// =============================================================================
// Corrective Fix B: receipt detail actions/navigation, safe jumps into the
// existing admin user management (navigation only - no mutation here), the
// OTHER_PRODUCT admin landing tree and the status-filtered stock lists.
// Pure keyboard/text builders + static source locks - no database needed.
// =============================================================================

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type Button = { text: string; callback_data?: string };

function rows(kb: { inline_keyboard: unknown }): Button[][] {
  return kb.inline_keyboard as Button[][];
}

function callbacks(kb: { inline_keyboard: unknown }): string[] {
  return rows(kb)
    .flat()
    .map((b) => b.callback_data ?? "");
}

function paymentFixture(overrides: Record<string, unknown> = {}): PaymentWithRelations {
  return {
    id: "abcdef12-3456-7890-abcd-ef1234567890",
    purpose: "ORDER_PAYMENT",
    status: "PENDING_REVIEW",
    amountToman: 250_000,
    orderId: "99887766-aaaa-bbbb-cccc-ddddeeeeffff",
    checkoutSessionId: "11223344-aaaa-bbbb-cccc-ddddeeeeffff",
    rejectReason: null,
    createdAt: new Date("2026-07-01T10:00:00Z"),
    reviewedAt: null,
    user: {
      id: "fedcba98-7654-3210-fedc-ba9876543210",
      telegramId: 555_000_777n,
      username: "buyer_x",
      firstName: "کاربر",
      lastName: "تست",
    },
    gateway: { name: "کارت‌به‌کارت اصلی", type: "CARD_TO_CARD" },
    checkoutSession: { productSnapshot: { productName: "گیفت کارت" } },
    receipts: [{ fileId: "FILE_ID_SECRET", text: null }],
    ...overrides,
  } as unknown as PaymentWithRelations;
}

describe("receipt detail (Fix B)", () => {
  it("pending receipt shows approve/reject in the agreed rows", () => {
    const kb = receiptDetailKeyboard(paymentFixture(), 2);
    expect(rows(kb).map((row) => row.map((b) => b.callback_data))).toEqual([
      [rcb.approveAsk("abcdef12"), rcb.reject("abcdef12")],
      [rcb.media("abcdef12")],
      [rcb.userWallet("abcdef12"), rcb.userView("abcdef12")],
      ["admin:rec:list:2", CB.ADMIN_FINANCE],
    ]);
  });

  it("reviewed receipt hides approve/reject but keeps the other actions", () => {
    for (const status of ["APPROVED", "REJECTED"]) {
      const kb = receiptDetailKeyboard(paymentFixture({ status }), 1);
      const cbs = callbacks(kb);
      expect(cbs).not.toContain(rcb.approveAsk("abcdef12"));
      expect(cbs).not.toContain(rcb.reject("abcdef12"));
      expect(cbs).toContain(rcb.media("abcdef12"));
      expect(cbs).toContain(rcb.userWallet("abcdef12"));
      expect(cbs).toContain(rcb.userView("abcdef12"));
      expect(cbs).toContain(CB.ADMIN_FINANCE);
    }
  });

  it("detail text carries the readable fields and no secrets", () => {
    const text = receiptDetailText(
      paymentFixture({
        status: "REJECTED",
        rejectReason: "مبلغ ناقص",
        reviewedAt: new Date("2026-07-02T08:30:00Z"),
      }),
    );
    expect(text).toContain("جزئیات رسید 🧾 <b>abcdef12</b>");
    expect(text).toContain("نوع پرداخت: پرداخت سفارش");
    expect(text).toContain("رد شده ❌");
    expect(text).toContain("@buyer_x");
    expect(text).toContain("<code>555000777</code>");
    expect(text).toContain("مبلغ: <b>250,000 تومان</b>");
    expect(text).toContain("روش پرداخت: کارت‌به‌کارت اصلی (CARD_TO_CARD)");
    expect(text).toContain("پیش‌فاکتور: <code>11223344</code>");
    expect(text).toContain("سفارش: <code>99887766</code>");
    expect(text).toContain("محصول: گیفت کارت");
    expect(text).toContain("نوع رسید: فایل/عکس");
    expect(text).toContain("دلیل رد: مبلغ ناقص");
    expect(text).toContain("ثبت: 2026-07-01 10:00 (UTC)");
    expect(text).toContain("بررسی: 2026-07-02 08:30 (UTC)");
    // The stored Telegram file id must never render.
    expect(text).not.toContain("FILE_ID_SECRET");
  });

  it("wallet-charge detail hides the product line and shows the purpose", () => {
    const text = receiptDetailText(paymentFixture({ purpose: "WALLET_CHARGE", orderId: null }));
    expect(text).toContain("شارژ کیف پول 🏦");
    expect(text).not.toContain("محصول:");
    expect(text).not.toContain("سفارش:");
  });

  it("list back goes to finance; review-result backs go to list page + finance", () => {
    const list = receiptListKeyboard({ payments: [paymentFixture()], page: 2, pages: 3 });
    const flat = rows(list).flat();
    expect(flat.at(-1)?.callback_data).toBe(CB.ADMIN_FINANCE);
    expect(flat.at(-1)?.text).toBe("بازگشت به مالی");
    expect(rows(reviewResultKeyboard(3)).map((row) => row.map((b) => b.callback_data))).toEqual([
      ["admin:rec:list:3"],
      [CB.ADMIN_FINANCE],
    ]);
  });

  it("does not mutate wallets or block users from the receipt pages", () => {
    const src = readFileSync(
      path.join(repoRoot, "apps/bot/src/handlers/admin-receipts/receipts.handler.ts"),
      "utf8",
    );
    expect(src).not.toContain("adjustUserWallet");
    expect(src).not.toContain("prisma.user.update");
    expect(src).not.toContain('"BLOCKED"');
    // The jumps render the EXISTING admin user pages.
    expect(src).toContain("userProfileText");
    expect(src).toContain("userWalletKeyboard");
    expect(src).toContain("listUserWalletTransactionsForAdmin");
  });
});

describe("receipt media action (Fix B)", () => {
  function recorderApi(behavior: { photoFails?: boolean; documentFails?: boolean }) {
    const calls: Array<{ method: string; chatId: number | string; caption?: string }> = [];
    return {
      calls,
      api: {
        sendPhoto: async (chatId: number | string, _f: string, opts?: { caption?: string }) => {
          if (behavior.photoFails === true) {
            throw new Error("photo rejected");
          }
          calls.push({ method: "photo", chatId, caption: opts?.caption });
          return {};
        },
        sendDocument: async (chatId: number | string, _f: string, opts?: { caption?: string }) => {
          if (behavior.documentFails === true) {
            throw new Error("document rejected");
          }
          calls.push({ method: "document", chatId, caption: opts?.caption });
          return {};
        },
      } as unknown as Pick<BotContext["api"], "sendPhoto" | "sendDocument">,
    };
  }

  it("sends the photo with the short caption", async () => {
    const { api, calls } = recorderApi({});
    const outcome = await sendReceiptMedia(api, 42, paymentFixture());
    expect(outcome.kind).toBe("photo");
    expect(calls[0]?.caption).toBe("رسید abcdef12 🧾 | @buyer_x | 250,000 تومان");
  });

  it("falls back to document, then reports failure safely", async () => {
    const fallback = recorderApi({ photoFails: true });
    expect((await sendReceiptMedia(fallback.api, 42, paymentFixture())).kind).toBe("document");
    const failed = recorderApi({ photoFails: true, documentFails: true });
    expect((await sendReceiptMedia(failed.api, 42, paymentFixture())).kind).toBe("failed");
  });

  it("returns the text for text-only receipts and none when nothing exists", async () => {
    const { api } = recorderApi({});
    const textOnly = await sendReceiptMedia(
      api,
      42,
      paymentFixture({ receipts: [{ fileId: null, text: "شماره پیگیری 123" }] }),
    );
    expect(textOnly).toEqual({ kind: "text", text: "شماره پیگیری 123" });
    expect((await sendReceiptMedia(api, 42, paymentFixture({ receipts: [] }))).kind).toBe("none");
  });

  it("never logs the Telegram file id", () => {
    const src = readFileSync(
      path.join(repoRoot, "apps/bot/src/handlers/admin-receipts/receipts.handler.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/logger\.\w+\([^)]*fileId/s);
  });
});

describe("admin user pages return-to-receipt context (Fix B)", () => {
  it("profile/wallet keyboards show «بازگشت به رسید 🧾» only with a receipt context", () => {
    const withContext = userProfileKeyboard("aabbccdd", false, "abcdef12");
    const back = rows(withContext)
      .flat()
      .find((b) => b.text === "بازگشت به رسید 🧾");
    expect(back?.callback_data).toBe("admin:rec:view:abcdef12");
    expect(callbacks(userProfileKeyboard("aabbccdd", false))).not.toContain(
      "admin:rec:view:abcdef12",
    );

    const wallet = userWalletKeyboard("aabbccdd", "abcdef12");
    expect(callbacks(wallet)).toContain("admin:rec:view:abcdef12");
    expect(callbacks(userWalletKeyboard("aabbccdd"))).not.toContain("admin:rec:view:abcdef12");
  });

  it("normal user-detail navigation is unchanged without the context", () => {
    // Fix C widened the profile keyboard (services/orders/payments rows);
    // the Fix B invariant stays: no receipt button without a context, and
    // the normal results/users/admin backs are intact.
    const kb = userProfileKeyboard("aabbccdd", true);
    const flat = rows(kb).map((row) => row.map((b) => b.callback_data));
    expect(flat[0]).toEqual(["admin:user_wallet:open:aabbccdd", "admin:users:svc:aabbccdd:1"]);
    expect(flat).toContainEqual(["admin:users:results"]);
    expect(flat).toContainEqual([CB.ADMIN_USERS]);
    expect(flat).toContainEqual([CB.ADMIN_MENU]);
    expect(callbacks(kb).some((c) => c.startsWith("admin:rec:view:"))).toBe(false);
  });

  it("the context is cleared on the users landing / admin main menu", () => {
    const usersHandler = readFileSync(
      path.join(repoRoot, "apps/bot/src/handlers/admin-users/admin-users.handler.ts"),
      "utf8",
    );
    expect(usersHandler).toContain("delete ctx.session.temp.adminUserReturnContext");
    const adminHandler = readFileSync(
      path.join(repoRoot, "apps/bot/src/handlers/admin.handler.ts"),
      "utf8",
    );
    expect(adminHandler).toContain("clearAdminUsersState(ctx)");
    // Arriving back at a receipt consumes the context.
    const receipts = readFileSync(
      path.join(repoRoot, "apps/bot/src/handlers/admin-receipts/receipts.handler.ts"),
      "utf8",
    );
    expect(receipts).toContain("delete ctx.session.temp.adminUserReturnContext");
  });
});

describe("OTHER_PRODUCT admin tree (Fix B)", () => {
  it("landing has the exact agreed rows", () => {
    const kb = otherProductsLandingKeyboard();
    expect(rows(kb).map((row) => row.map((b) => b.callback_data))).toEqual([
      [CB.ADMIN_PRODUCTS],
      ["admin:mo:list:open:1", "admin:mo:list:info:1"],
      ["admin:mo:list:ready:1", "admin:mo:list:delivered:1"],
      ["admin:stock:products"],
      [CB.ADMIN_MENU],
    ]);
    const labels = rows(kb).flat().map((b) => b.text);
    expect(labels).toEqual([
      "مدیریت محصولات دیگر 🛍",
      "سفارش‌های دستی 📦",
      "سفارش‌های در انتظار اطلاعات 📝",
      "سفارش‌های آماده تحویل 🚚",
      "تاریخچه تحویل ✅",
      "مدیریت موجودی استاک 🎟",
      "بازگشت به پنل ادمین",
    ]);
  });

  it("manual-order detail returns to the same filter/page from the session", () => {
    const record = { id: "12345678-aaaa-bbbb-cccc-ddddeeeeffff", status: "DELIVERED" };
    const ctx = {
      session: { temp: { adminManualOrderLastFilter: "ready", adminManualOrderLastPage: 3 } },
    } as unknown as BotContext;
    const kb = manualOrderDetailKeyboard(ctx, record as unknown as ManualOrderDetail);
    expect(callbacks(kb)).toContain("admin:mo:list:ready:3");
    expect(callbacks(kb)).toContain(CB.ADMIN_OTHER_PRODUCTS);

    const fresh = { session: { temp: {} } } as unknown as BotContext;
    expect(callbacks(manualOrderDetailKeyboard(fresh, record as unknown as ManualOrderDetail)))
      .toContain("admin:mo:list:open:1");
  });
});

describe("stock tree and status filters (Fix B)", () => {
  const product = {
    id: "aabbccdd-1122-3344-5566-778899aabbcc",
    name: "گیفت کارت",
    isActive: true,
    deliveryType: "STOCK_ITEM",
    stockEnabled: true,
  } as unknown as Product;

  function item(status: string): OtherProductStockItem {
    return {
      id: "11223344-aaaa-bbbb-cccc-ddddeeeeffff",
      status,
      label: null,
    } as unknown as OtherProductStockItem;
  }

  it("product page nests under محصولات دیگر and exposes the status lists", () => {
    const kb = stockProductKeyboard(product, 5);
    const cbs = callbacks(kb);
    expect(cbs).toContain(ST_CB.itemsFiltered("aabbccdd", "a", 1));
    expect(cbs).toContain(ST_CB.itemsFiltered("aabbccdd", "r", 1));
    expect(cbs).toContain(ST_CB.itemsFiltered("aabbccdd", "x", 1));
    expect(cbs).toContain(ST_CB.itemsFiltered("aabbccdd", "d", 1));
    expect(cbs).toContain(ST_CB.thresholdClear("aabbccdd")); // threshold set
    expect(cbs).toContain(ST_CB.products);
    expect(cbs).toContain(CB.ADMIN_OTHER_PRODUCTS);
    // Threshold not set -> no clear button.
    expect(callbacks(stockProductKeyboard(product, null))).not.toContain(
      ST_CB.thresholdClear("aabbccdd"),
    );
  });

  it("status list callbacks preserve product/status/page and stay under 64 bytes", () => {
    expect(ST_CB.itemsFiltered("aabbccdd", "r", 2)).toBe("admin:stock:items:aabbccdd:r:2");
    const actions = stockItemActions(item("RESERVED"), "r", 2);
    expect(actions.map((a) => a.callback)).toEqual([
      "admin:stock:item_release:11223344:r:2",
      "admin:stock:item_disable_reserved:11223344:r:2",
    ]);
    for (const action of actions) {
      expect(Buffer.byteLength(action.callback, "utf8")).toBeLessThan(64);
    }
    expect(stockItemActions(item("AVAILABLE"), "a", 3).map((a) => a.callback)).toEqual([
      "admin:stock:item_off:11223344:a:3",
    ]);
  });

  it("delivered and disabled items expose no mutation buttons", () => {
    expect(stockItemActions(item("DELIVERED"), "d", 1)).toEqual([]);
    expect(stockItemActions(item("DISABLED"), "x", 1)).toEqual([]);
  });

  it("stock lists/details never render decrypted content", () => {
    const src = readFileSync(
      path.join(repoRoot, "apps/bot/src/handlers/admin-stock/stock.handler.ts"),
      "utf8",
    );
    expect(src).not.toContain("decrypt");
  });
});

describe("locked flows (Fix B regression)", () => {
  it("CB.USER_BUY and CB.USER_OTHER_PRODUCTS are unchanged", () => {
    expect(CB.USER_BUY).toBe("user:buy");
    expect(CB.USER_OTHER_PRODUCTS).toBe("user:other_products");
  });

  it("old callbacks stay registered (list/view/media/user routes + legacy stock items)", () => {
    const receipts = readFileSync(
      path.join(repoRoot, "apps/bot/src/handlers/admin-receipts/receipts.handler.ts"),
      "utf8",
    );
    expect(receipts).toMatch(/callbackQuery\(\s*\[\s*CB\.ADMIN_RECEIPTS/);
    const stock = readFileSync(
      path.join(repoRoot, "apps/bot/src/handlers/admin-stock/stock.handler.ts"),
      "utf8",
    );
    // Old all-statuses list route still present next to the filtered one.
    expect(stock).toContain("admin:stock:items:([0-9a-f-]+):(\\d+)$");
    expect(stock).toContain("admin:stock:items:([0-9a-f-]+):([arxd]):(\\d+)$");
    const manual = readFileSync(
      path.join(repoRoot, "apps/bot/src/handlers/admin-manual-orders/manual-orders.handler.ts"),
      "utf8",
    );
    // Legacy Phase 23 page-only list route still handled.
    expect(manual).toContain("admin:mo:list:(\\d+)$");
  });
});
