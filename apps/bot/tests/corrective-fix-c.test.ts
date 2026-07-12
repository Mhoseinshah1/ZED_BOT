import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prisma, type Panel, type User } from "@zedbot/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "fix-c-test-secret-fix-c-test-secret-1234";

import { CB } from "../src/core/callbacks.js";
import {
  AU_CB,
  blockConfirmKeyboard,
  userProfileKeyboard,
  userProfileText,
  usersLandingKeyboard,
  userWalletKeyboard,
} from "../src/handlers/admin-users/admin-users-views.js";
import {
  panelDetailKeyboard,
  panelDetailText,
  panelHostname,
  panelListKeyboard,
  panelMenuKeyboard,
} from "../src/handlers/panels/panel-views.js";
import { pcb, PROD_CB } from "../src/handlers/products/product-cb.js";
import {
  productAddTypeKeyboard,
  productDetailKeyboard,
  productMenuKeyboard,
} from "../src/handlers/products/product-views.js";
import {
  listUsersForAdmin,
  searchUsersForAdmin,
  setUserBlocked,
} from "../src/services/admin-user-wallet.service.js";
import type { ProductWithRelations } from "../src/services/product.service.js";

// =============================================================================
// Corrective Fix C: admin users landing/detail/sub-pages with confirmed
// block-unblock, the products/categories root + filters + type-specific
// detail actions, and the panels root/list/detail with secret-free
// rendering. Pure builders + static source locks; DB parts skip without
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

describe("admin users tree (Fix C)", () => {
  it("landing has the exact rows mapped to existing UserStatus values", () => {
    const kb = usersLandingKeyboard();
    expect(rows(kb).map((row) => row.map((b) => b.callback_data))).toEqual([
      [AU_CB.search],
      [AU_CB.list("r", 1), AU_CB.list("b", 1)],
      [AU_CB.list("a", 1), AU_CB.list("d", 1)],
      [CB.ADMIN_MENU],
    ]);
    expect(rows(kb).at(-1)?.[0]?.text).toBe("بازگشت به پنل ادمین");
  });

  it("profile text escapes dynamic values and carries the Fix C fields", () => {
    const user = {
      id: "aabbccdd-0000-0000-0000-000000000000",
      telegramId: 999n,
      firstName: "<b>bad",
      lastName: null,
      username: "u<i>x",
      phoneNumber: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      lastSeenAt: new Date("2026-07-01T00:00:00Z"),
      status: "ACTIVE",
      group: "F",
      balanceToman: 1000,
      totalChargedToman: 500,
      totalManualAddedToman: 250,
      totalSpentToman: 100,
      totalManualDeductedToman: 50,
    } as unknown as User;
    const text = userProfileText(user, {
      services: 2,
      activeServices: 1,
      orders: 5,
      pendingOrders: 1,
      paidOrders: 3,
      payments: 4,
      tickets: 2,
      referralCount: 6,
      referrer: { telegramId: 111n, username: "inviter" },
    });
    expect(text).toContain("&lt;b&gt;bad");
    expect(text).toContain("@u&lt;i&gt;x");
    expect(text).not.toContain("<b>bad");
    expect(text).toContain("مجموع شارژ (بستانکار): 750 تومان");
    expect(text).toContain("مجموع خرید/کسر (بدهکار): 150 تومان");
    expect(text).toContain("سفارش‌های در انتظار: 1 | موفق: 3");
    expect(text).toContain("سرویس‌ها: 2 (فعال: 1)");
    expect(text).toContain("سفارش‌ها: 5 | پرداخت‌ها: 4 | تیکت‌ها: 2");
    expect(text).toContain("معرف: @inviter");
    expect(text).toContain("تعداد زیرمجموعه‌ها: 6");
    expect(text).toContain("آخرین بازدید:");
  });

  it("active shows block, blocked shows unblock, others neither", () => {
    const active = callbacks(userProfileKeyboard("aabbccdd", false, undefined, "ACTIVE"));
    expect(active).toContain(AU_CB.blockAsk("aabbccdd"));
    expect(active).not.toContain(AU_CB.unblockAsk("aabbccdd"));
    const blocked = callbacks(userProfileKeyboard("aabbccdd", false, undefined, "BLOCKED"));
    expect(blocked).toContain(AU_CB.unblockAsk("aabbccdd"));
    expect(blocked).not.toContain(AU_CB.blockAsk("aabbccdd"));
    const disabled = callbacks(userProfileKeyboard("aabbccdd", false, undefined, "DISABLED"));
    expect(disabled).not.toContain(AU_CB.blockAsk("aabbccdd"));
    expect(disabled).not.toContain(AU_CB.unblockAsk("aabbccdd"));
    // Confirmation before any status change.
    expect(callbacks(blockConfirmKeyboard("aabbccdd", true))).toEqual([
      AU_CB.blockConfirm("aabbccdd"),
      AU_CB.view("aabbccdd"),
    ]);
  });

  it("profile keyboard: sub-pages, receipt return, and list/results backs", () => {
    const kb = userProfileKeyboard("aabbccdd", false, "abcdef12", "ACTIVE", {
      filter: "b",
      page: 2,
    });
    const cbs = callbacks(kb);
    expect(cbs).toContain(AU_CB.wallet("aabbccdd"));
    expect(cbs).toContain(AU_CB.services("aabbccdd", 1));
    expect(cbs).toContain(AU_CB.orders("aabbccdd", 1));
    expect(cbs).toContain(AU_CB.payments("aabbccdd", 1));
    expect(cbs).toContain("admin:rec:view:abcdef12"); // Fix B context preserved
    expect(cbs).toContain(AU_CB.list("b", 2)); // back to the same filter/page
    // Normal navigation (search results) unchanged: results back, no list back.
    const normal = callbacks(userProfileKeyboard("aabbccdd", true, undefined, "ACTIVE"));
    expect(normal).toContain(AU_CB.results);
    expect(normal).not.toContain(AU_CB.list("b", 2));
  });

  it("wallet page keeps the existing adjustment flow and adds tx history", () => {
    const cbs = callbacks(userWalletKeyboard("aabbccdd"));
    expect(cbs).toContain(AU_CB.walletAdd("aabbccdd"));
    expect(cbs).toContain(AU_CB.walletSubtract("aabbccdd"));
    expect(cbs).toContain(AU_CB.walletTx("aabbccdd", 1));
    expect(cbs).toContain(AU_CB.view("aabbccdd"));
    expect(cbs).toContain(AU_CB.root);
  });

  it("sub-list services are read-only (no create/update in the Fix C service block)", () => {
    const service = src("apps/bot/src/services/admin-user-wallet.service.ts");
    const fixCBlock = service.slice(
      service.indexOf("Fix C: user landing filters"),
      service.indexOf("Fix C: block / unblock"),
    );
    expect(fixCBlock.length).toBeGreaterThan(500);
    expect(fixCBlock).not.toMatch(/\.(create|update|updateMany|delete)\(/);
    // setUserBlocked touches ONLY the status column.
    const blockBlock = service.slice(
      service.indexOf("Fix C: block / unblock"),
      service.indexOf("the adjustment itself"),
    );
    expect(blockBlock.length).toBeGreaterThan(300);
    expect(blockBlock).toContain("data: { status:");
    expect(blockBlock).not.toContain("balanceToman");
  });
});

describe("products tree (Fix C)", () => {
  function product(overrides: Record<string, unknown>): ProductWithRelations {
    return {
      id: "11223344-0000-0000-0000-000000000000",
      name: "محصول",
      isActive: true,
      priceToman: 1000,
      durationDays: 30,
      displayOrder: 1,
      displayGroups: [],
      invoiceDescription: null,
      category: { name: "دسته", type: "SERVICE_PRODUCT" },
      panel: null,
      volumeGb: 10,
      allLocations: false,
      serviceLocation: "MULTI_LOCATION",
      trafficResetCycle: null,
      requiredUserInfoEnabled: false,
      requiredUserInfoPromptText: null,
      deliveryType: null,
      stockEnabled: false,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-01-01T00:00:00Z"),
      ...overrides,
    } as unknown as ProductWithRelations;
  }

  it("product root has the exact Fix C rows", () => {
    const kb = productMenuKeyboard();
    expect(rows(kb).map((row) => row.map((b) => b.callback_data))).toEqual([
      [pcb.list("A", 1), PROD_CB.ADD],
      [PROD_CB.CAT_MENU, PROD_CB.CAT_ADD],
      [pcb.list("S", 1), pcb.list("O", 1)],
      ["admin:menu"],
    ]);
    expect(callbacks(productAddTypeKeyboard())).toEqual([
      PROD_CB.ADD_SERVICE,
      PROD_CB.ADD_OTHER,
      PROD_CB.MENU,
    ]);
  });

  it("list filters include active/inactive and the handler accepts them", () => {
    expect(pcb.list("V", 2)).toBe("admin:prod:ls:V:2");
    expect(pcb.list("X", 1)).toBe("admin:prod:ls:X:1");
    expect(src("apps/bot/src/handlers/products/product.handler.ts")).toContain(
      "admin:prod:ls:(S|O|A|V|X)",
    );
    const service = src("apps/bot/src/services/product.service.ts");
    expect(service).toContain('filter === "V"');
    expect(service).toContain("{ isActive: true }");
    expect(service).toContain("{ isActive: false }");
  });

  it("SERVICE_PRODUCT detail: panel/volume/location actions, no stock/delivery", () => {
    const kb = productDetailKeyboard(product({ type: "SERVICE_PRODUCT" }));
    const cbs = callbacks(kb);
    expect(cbs).toContain(pcb.pickPanel("11223344"));
    expect(cbs).toContain(pcb.fieldEdit("11223344", "vol"));
    expect(cbs).toContain(pcb.pickLocation("11223344"));
    expect(cbs).not.toContain(pcb.pickDelivery("11223344"));
    expect(cbs).not.toContain("admin:stock:p:11223344");
  });

  it("OTHER_PRODUCT detail: delivery/info/stock actions, never the panel picker", () => {
    const kb = productDetailKeyboard(product({ type: "OTHER_PRODUCT", deliveryType: "STOCK_ITEM" }));
    const cbs = callbacks(kb);
    expect(cbs).toContain(pcb.pickDelivery("11223344"));
    expect(cbs).toContain(pcb.toggleUserInfo("11223344"));
    expect(cbs).toContain("admin:stock:p:11223344"); // existing Fix B stock page
    expect(cbs).not.toContain(pcb.pickPanel("11223344"));
    // The handler refuses panel selection for OTHER_PRODUCT even via old callbacks.
    const handler = src("apps/bot/src/handlers/products/product.handler.ts");
    expect(handler.match(/محصولات دیگر به پنل متصل نمی‌شوند/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("detail returns to the same filter/page; wizard is double-click safe", () => {
    const cbs = callbacks(productDetailKeyboard(product({ type: "SERVICE_PRODUCT" }), { filter: "X", page: 3 }));
    expect(cbs).toContain(pcb.list("X", 3));
    expect(cbs).toContain(PROD_CB.MENU);
    const handler = src("apps/bot/src/handlers/products/product.handler.ts");
    // Exactly one create call site, and the wizard state is consumed first.
    expect(handler.match(/createProductAtOrder\(/g)?.length).toBe(1);
    const saveBlock = handler.slice(handler.indexOf('"admin:prod:f:save"'));
    expect(saveBlock.indexOf("clearProductFlows(ctx);")).toBeLessThan(
      saveBlock.indexOf("createProductAtOrder("),
    );
  });

  it("category and product deletes stay soft (no destructive removal)", () => {
    const handler = src("apps/bot/src/handlers/products/product.handler.ts");
    expect(handler).toContain("حذف فیزیکی انجام نمی‌شود؛ دسته‌بندی فقط غیرفعال خواهد شد.");
    expect(handler).toContain("حذف فیزیکی انجام نمی‌شود؛ محصول فقط غیرفعال خواهد شد.");
    expect(handler).toContain("updateCategory(category.id, { isActive: false })");
    expect(handler).toContain("softDeleteProduct(");
    expect(handler).not.toMatch(/prisma\.(product|productCategory)\.delete/);
    // Product/panel change never touches Service rows.
    expect(handler).not.toContain("prisma.service");
    expect(handler).toContain("تغییر پنل محصول فقط روی خریدهای بعدی اثر می‌گذارد.");
  });
});

describe("panels tree (Fix C)", () => {
  const panel = {
    id: "55667788-0000-0000-0000-000000000000",
    name: "پنل آلمان",
    type: "MARZBAN",
    baseUrl: "https://panel.example.com:8443/dashboard",
    status: "ACTIVE",
    isVisible: true,
    passwordEncrypted: "ENCRYPTED_SECRET_VALUE",
    tokenEncrypted: null,
    visibleForGroups: [],
    renewalMethod: "RENEW",
    accountLimitEnabled: false,
    accountLimitCount: null,
    createdAccountsCount: 0,
    activeAccountsCount: 0,
    subscriptionDomain: null,
    usernamePatternType: "TELEGRAM_ID_RANDOM",
    testEnabled: false,
    renewalEnabled: true,
    customServiceForF: false,
    customServiceForN: false,
    customServiceForN2: false,
    pricePerExtraGbToman: 0,
    pricePerExtraDayToman: 0,
    locationChangePriceToman: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-06-01T00:00:00Z"),
  } as unknown as Panel;

  it("panel root and list carry the Fix C structure (hostname, filters)", () => {
    const kb = panelMenuKeyboard();
    expect(rows(kb).map((row) => row.map((b) => b.callback_data))).toEqual([
      ["admin:panels:list:1", "admin:panels:add"],
      ["admin:panels:ls:a:1", "admin:panels:ls:i:1"],
      ["admin:menu"],
    ]);
    expect(panelHostname(panel.baseUrl)).toBe("panel.example.com");
    const list = panelListKeyboard([panel], 1, 1, "a");
    expect(rows(list)[0]?.[0]?.text).toContain("panel.example.com");
    expect(rows(list)[0]?.[0]?.text).not.toContain("https://");
  });

  it("panel detail never renders credential values or the full URL", () => {
    const text = panelDetailText(panel, 4);
    expect(text).toContain("اطلاعات ورود: تنظیم شده ✅");
    expect(text).toContain("محصولات متصل: 4");
    expect(text).toContain("هاست: panel.example.com");
    expect(text).not.toContain("ENCRYPTED_SECRET_VALUE");
    expect(text).not.toContain("https://");
    const noCred = panelDetailText({ ...panel, passwordEncrypted: null } as Panel, 0);
    expect(noCred).toContain("اطلاعات ورود: تنظیم نشده ❌");
  });

  it("detail returns to the same list/filter/page and exposes linked products", () => {
    const cbs = callbacks(panelDetailKeyboard(panel, { filter: "i", page: 2 }));
    expect(cbs).toContain("admin:panels:ls:i:2");
    expect(cbs).toContain("admin:panel:prods:55667788");
    expect(cbs).toContain("admin:panels"); // panel root back
    expect(callbacks(panelDetailKeyboard(panel))).toContain("admin:panels:list:1");
  });

  it("panel wizard/edit keeps secret masking and safe test failure", () => {
    const handler = src("apps/bot/src/handlers/panels/panel.handler.ts");
    expect(handler).toContain("maskSecretEdges");
    expect(handler).toContain("testPanelConnection");
    // Soft delete only; no hard panel removal.
    expect(handler).toContain("softDeletePanel(");
    expect(handler).not.toContain("prisma.panel.delete");
    // The linked-products page and panel picker use ACTIVE panels only.
    const productHandler = src("apps/bot/src/handlers/products/product.handler.ts");
    expect(productHandler).toContain('where: { status: "ACTIVE" }');
  });
});

describe("locked flows (Fix C regression)", () => {
  it("CB.USER_BUY and CB.USER_OTHER_PRODUCTS are unchanged", () => {
    expect(CB.USER_BUY).toBe("user:buy");
    expect(CB.USER_OTHER_PRODUCTS).toBe("user:other_products");
  });
});

describe.runIf(hasDb)("admin users search/filters/block (Fix C, DB)", () => {
  let user: User;

  // telegramId must stay <= 15 digits for the exact-id search branch.
  const shortTgId = runTag % 900_000_000_000_000n;

  beforeAll(async () => {
    user = await prisma.user.create({
      data: {
        telegramId: shortTgId,
        firstName: "FixC",
        username: `fixc_${runTag}`,
        group: "F",
        status: "ACTIVE",
      },
    });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: user.id } });
  });

  it("search normalizes telegram id, @username and internal short id", async () => {
    const byId = await searchUsersForAdmin(String(shortTgId));
    expect(byId.map((u) => u.id)).toContain(user.id);
    const byUsername = await searchUsersForAdmin(`@FIXC_${runTag}`);
    expect(byUsername.map((u) => u.id)).toContain(user.id);
    const byShortId = await searchUsersForAdmin(user.id.slice(0, 12));
    expect(byShortId.map((u) => u.id)).toContain(user.id);
    expect(await searchUsersForAdmin("   ")).toEqual([]);
  });

  it("block/unblock is a guarded status flip with no side effects", async () => {
    const blocked = await setUserBlocked(user.id, true);
    expect(blocked.ok).toBe(true);
    if (blocked.ok) {
      expect(blocked.user.status).toBe("BLOCKED");
      expect(blocked.user.balanceToman).toBe(user.balanceToman);
    }
    // Blocking an already-blocked user is refused (stale confirmation).
    expect((await setUserBlocked(user.id, true)).ok).toBe(false);
    // The blocked filter finds the user.
    const list = await listUsersForAdmin("b", 1);
    expect(list.users.map((u) => u.id)).toContain(user.id);
    const unblocked = await setUserBlocked(user.id, false);
    expect(unblocked.ok).toBe(true);
    if (unblocked.ok) {
      expect(unblocked.user.status).toBe("ACTIVE");
    }
  });
});
