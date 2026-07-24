import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prisma, type Admin, type User } from "@zedbot/database";
import {
  purchaseMenuLayout,
  USER_COMBINED_PURCHASE_MENU_ENABLED_KEY,
} from "@zedbot/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "purchase-menu-combined-tests-secret-0001";

import { CB } from "../src/core/callbacks.js";
import { initialSession, type SessionData } from "../src/core/session.js";
import { adminTextSettingsHandler } from "../src/handlers/admin-settings/text-settings.handler.js";
import {
  purchaseHubBody,
  renderPurchaseHub,
} from "../src/handlers/user-purchase-hub/purchase-hub.handler.js";
import {
  buildUserMainMenuDefinition,
  buildUserMainReplyKeyboard,
  resolveMainMenuAction,
  type UserMainMenuAction,
} from "../src/keyboards/user-menu-definition.js";
import {
  DUPLICATE_MAIN_MENU_LABEL_TEXT,
  updateButtonText,
} from "../src/services/admin-text-settings.service.js";
import {
  compareAndSetCombinedPurchaseMenuEnabled,
  isCombinedPurchaseMenuEnabled,
  setCombinedPurchaseMenuEnabled,
} from "../src/services/purchase-menu-layout.service.js";
import {
  clearSettingsCache,
  deleteSetting,
  getSetting,
  setSetting,
} from "../src/services/settings.service.js";
import { clearTextCache } from "../src/services/text.service.js";

// =============================================================================
// Admin-controlled unified purchase menu (feat/admin-controlled-unified-purchase-menu).
// The OWNER-controlled SPLIT/COMBINED layouts, the shared definition consumed
// by BOTH keyboard renderers, the layout-independent purchase compatibility
// resolver, the read-only purchase hub, and the OWNER-gated admin toggle
// (atomic compare-and-set + privacy-safe audit). Requires real PostgreSQL
// (Setting / ButtonText / MessageTemplate / Admin rows); skips without it.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

// Seed defaults for the three purchase labels.
const BUY_LABEL = "خرید اشتراک 🔐";
const OTHER_LABEL = "محصولات دیگر 🛍";
const HUB_LABEL = "خرید محصولات 🛒";

interface SentMessage {
  text: string;
  other: Record<string, unknown> | undefined;
}

/** Callback-query ctx stand-in (no ctx.callbackQuery.message → safeEditOrReply replies). */
function fakeCallbackCtx(
  telegramId: bigint,
  data: string,
  options: { admin?: Admin | null; user?: User | null; session?: SessionData } = {},
) {
  const sent: SentMessage[] = [];
  const toasts: Array<string | undefined> = [];
  const callbackQuery = {
    id: "cbq-1",
    chat_instance: "ci-1",
    from: { id: Number(telegramId), is_bot: false, first_name: "Tester" },
    data,
  };
  const ctx = {
    session: options.session ?? initialSession(),
    dbUser: options.user ?? null,
    admin: options.admin ?? null,
    from: { id: Number(telegramId), first_name: "Tester" },
    callbackQuery,
    update: { update_id: 1, callback_query: callbackQuery },
    reply: async (t: string, other?: Record<string, unknown>) => {
      sent.push({ text: t, other });
      return {};
    },
    editMessageText: async (t: string, other?: Record<string, unknown>) => {
      sent.push({ text: t, other });
      return {};
    },
    answerCallbackQuery: async (payload?: { text?: string }) => {
      toasts.push(payload?.text);
      return true;
    },
  };
  return { ctx: ctx as never, sent, toasts, session: ctx.session };
}

async function dispatchSettings(ctx: never): Promise<void> {
  await adminTextSettingsHandler.middleware()(ctx, async () => {});
}

function inlineButtons(other: Record<string, unknown> | undefined): Array<{ text: string; data: string }> {
  const kb = (other?.reply_markup as { inline_keyboard?: Array<Array<Record<string, string>>> })
    ?.inline_keyboard;
  if (!Array.isArray(kb)) {
    return [];
  }
  return kb.flat().map((b) => ({ text: String(b.text ?? ""), data: String(b.callback_data ?? "") }));
}

/** The action grid of the current user main-menu definition. */
async function actionGrid(isActiveAdmin: boolean): Promise<UserMainMenuAction[][]> {
  const rows = await buildUserMainMenuDefinition({ isActiveAdmin });
  return rows.map((row) => row.map((b) => b.action));
}

/** The label grid of the current user main-menu definition. */
async function labelGrid(isActiveAdmin: boolean): Promise<string[][]> {
  const rows = await buildUserMainMenuDefinition({ isActiveAdmin });
  return rows.map((row) => row.map((b) => b.label));
}

/** The reply keyboard's label grid (must equal the definition's — one source). */
function replyLabelGrid(kb: unknown): string[][] {
  const markup = kb as { keyboard: Array<Array<{ text: string }>> };
  return markup.keyboard.map((row) => row.map((b) => b.text));
}

async function setLayout(combined: boolean): Promise<void> {
  await setCombinedPurchaseMenuEnabled(combined);
  clearSettingsCache();
}

// --- source-level privacy regression (no DB) --------------------------------
// The purchase-layout mutation must persist NO actor identifier for the
// privacy-minimal audit event: neither the writeSystemLog success call nor the
// stale/race logger may reference the admin database id
// (fix/purchase-menu-audit-privacy).
describe("purchase-layout audit is privacy-minimal (source level)", () => {
  it("the admin:menu_buy:set handler references no admin identifier", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const src = readFileSync(
      path.join(repoRoot, "apps/bot/src/handlers/admin-settings/text-settings.handler.ts"),
      "utf8",
    );
    const setIdx = src.indexOf("admin:menu_buy:set:(0|1)");
    expect(setIdx).toBeGreaterThan(-1);
    // The set-callback body ends where the next top-level declaration begins.
    const endIdx = src.indexOf("async function renderTextsLanding", setIdx);
    expect(endIdx).toBeGreaterThan(setIdx);
    const block = src.slice(setIdx, endIdx);
    // Sanity: this IS the block that writes the event + the stale logger.
    expect(block).toContain("writeSystemLog(");
    expect(block).toContain("USER_MENU_PURCHASE_LAYOUT_CHANGED");
    expect(block).toContain("purchase layout change lost the race");
    // Assert on CODE only — strip comments so an explanatory comment that merely
    // mentions the forbidden field names does not trip the regression.
    const code = block
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    // Regression: no persisted or logged admin identifier anywhere in the code.
    expect(code).not.toContain("adminId");
    expect(code).not.toContain("admin.id");
    expect(code).not.toContain("userId");
    expect(code).not.toContain("telegramId");
  });
});

describe.runIf(hasDb)("admin-controlled unified purchase menu", () => {
  let owner: Admin;
  let support: Admin;
  let user: User;

  beforeAll(async () => {
    seq += 1;
    owner = await prisma.admin.create({
      data: { telegramId: runTag + 900_000_000n + BigInt(seq), role: "OWNER", isActive: true },
    });
    seq += 1;
    support = await prisma.admin.create({
      data: { telegramId: runTag + 900_000_000n + BigInt(seq), role: "SUPPORT", isActive: true },
    });
    seq += 1;
    user = await prisma.user.create({
      data: {
        telegramId: runTag + BigInt(seq),
        balanceToman: 500_000,
        group: "F",
        status: "ACTIVE",
      },
    });
    // Keep the optional feature rows (free trial / referral / representative)
    // OFF so the menu grids are deterministic regardless of other suites.
    await setSetting("referral_system_enabled", "false", "BOOLEAN");
    await setSetting("representative_program_enabled", "false", "BOOLEAN");
    await setSetting("free_trial_enabled", "false", "BOOLEAN");
    clearSettingsCache();
  });

  beforeEach(async () => {
    // Restore the three purchase labels to their seed defaults, split layout.
    await prisma.buttonText.updateMany({ where: { key: "buy_subscription" }, data: { currentText: BUY_LABEL } });
    await prisma.buttonText.updateMany({ where: { key: "other_products" }, data: { currentText: OTHER_LABEL } });
    await prisma.buttonText.updateMany({ where: { key: "purchase_hub" }, data: { currentText: HUB_LABEL } });
    clearTextCache();
    await setLayout(false);
  });

  afterEach(() => {
    clearTextCache();
    clearSettingsCache();
  });

  afterAll(async () => {
    await deleteSetting(USER_COMBINED_PURCHASE_MENU_ENABLED_KEY);
    // The audit event carries NO relation id, so it can only be cleaned up by its
    // (unique) event type — this suite is the only producer of it.
    await prisma.systemLog.deleteMany({
      where: { eventType: "user_menu.purchase_layout_changed" },
    });
    await prisma.buttonText.updateMany({ where: { key: "buy_subscription" }, data: { currentText: BUY_LABEL } });
    await prisma.buttonText.updateMany({ where: { key: "other_products" }, data: { currentText: OTHER_LABEL } });
    await prisma.buttonText.updateMany({ where: { key: "purchase_hub" }, data: { currentText: HUB_LABEL } });
    await prisma.user.deleteMany({ where: { id: user.id } });
    await prisma.admin.deleteMany({ where: { id: { in: [owner.id, support.id] } } });
    clearTextCache();
    clearSettingsCache();
    await prisma.$disconnect();
  });

  // --- SETTING -------------------------------------------------------------

  describe("setting", () => {
    it("missing setting defaults to split", async () => {
      await deleteSetting(USER_COMBINED_PURCHASE_MENU_ENABLED_KEY);
      clearSettingsCache();
      expect(await isCombinedPurchaseMenuEnabled()).toBe(false);
    });

    it("invalid setting value defaults to split", async () => {
      await setSetting(USER_COMBINED_PURCHASE_MENU_ENABLED_KEY, "banana", "STRING");
      clearSettingsCache();
      expect(await isCombinedPurchaseMenuEnabled()).toBe(false);
    });

    it("OWNER can enable then disable combined mode (atomic CAS)", async () => {
      await setLayout(false);
      expect(await compareAndSetCombinedPurchaseMenuEnabled(false, true)).toBe(true);
      clearSettingsCache();
      expect(await isCombinedPurchaseMenuEnabled()).toBe(true);
      expect(await compareAndSetCombinedPurchaseMenuEnabled(true, false)).toBe(true);
      clearSettingsCache();
      expect(await isCombinedPurchaseMenuEnabled()).toBe(false);
    });

    it("stale confirmation fails (expected no longer matches stored)", async () => {
      await setLayout(true); // stored is combined
      // A confirmation that observed SPLIT (expected=false) must lose.
      expect(await compareAndSetCombinedPurchaseMenuEnabled(false, true)).toBe(false);
      clearSettingsCache();
      expect(await isCombinedPurchaseMenuEnabled()).toBe(true); // unchanged
    });

    it("duplicate confirmation converges (second identical CAS is a no-op false)", async () => {
      await setLayout(false);
      expect(await compareAndSetCombinedPurchaseMenuEnabled(false, true)).toBe(true);
      // Re-playing the same confirmation loses (already combined) — no double toggle.
      expect(await compareAndSetCombinedPurchaseMenuEnabled(false, true)).toBe(false);
      clearSettingsCache();
      expect(await isCombinedPurchaseMenuEnabled()).toBe(true);
    });

    it("two concurrent confirmations result in exactly one transition", async () => {
      await setLayout(false);
      const [a, b] = await Promise.all([
        compareAndSetCombinedPurchaseMenuEnabled(false, true),
        compareAndSetCombinedPurchaseMenuEnabled(false, true),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1); // exactly one winner
      clearSettingsCache();
      expect(await isCombinedPurchaseMenuEnabled()).toBe(true);
    });

    it("uses the existing Setting table (BOOLEAN row) — no new store", async () => {
      await setLayout(true);
      const raw = await getSetting(USER_COMBINED_PURCHASE_MENU_ENABLED_KEY, "");
      expect(raw).toBe("true");
      const row = await prisma.setting.findUnique({
        where: { key: USER_COMBINED_PURCHASE_MENU_ENABLED_KEY },
      });
      expect(row?.type).toBe("BOOLEAN");
    });
  });

  // --- SPLIT MENU ----------------------------------------------------------

  describe("split menu (default)", () => {
    it("renders the historical layout: BUY + OTHER visible, PURCHASE_HUB hidden", async () => {
      await setLayout(false);
      const grid = await actionGrid(false);
      expect(grid).toEqual([
        ["BUY_SUBSCRIPTION", "RENEW_SERVICE"],
        ["MY_SERVICES", "WALLET"],
        ["OTHER_PRODUCTS", "MY_ORDERS"],
        ["PRICING"],
        ["SUPPORT"],
      ]);
      const flat = grid.flat();
      expect(flat).toContain("BUY_SUBSCRIPTION");
      expect(flat).toContain("OTHER_PRODUCTS");
      expect(flat).not.toContain("PURCHASE_HUB");
    });

    it("inline and reply definitions match (one source of truth)", async () => {
      await setLayout(false);
      const labels = await labelGrid(false);
      const reply = replyLabelGrid(await buildUserMainReplyKeyboard({ isActiveAdmin: false }));
      expect(reply).toEqual(labels);
    });
  });

  // --- COMBINED MENU -------------------------------------------------------

  describe("combined menu", () => {
    it("renders one purchase button: PURCHASE_HUB visible, BUY + OTHER hidden", async () => {
      await setLayout(true);
      const grid = await actionGrid(false);
      expect(grid).toEqual([
        ["PURCHASE_HUB", "RENEW_SERVICE"],
        ["MY_SERVICES", "WALLET"],
        ["MY_ORDERS", "PRICING"],
        ["SUPPORT"],
      ]);
      const flat = grid.flat();
      expect(flat).toContain("PURCHASE_HUB");
      expect(flat).not.toContain("BUY_SUBSCRIPTION");
      expect(flat).not.toContain("OTHER_PRODUCTS");
    });

    it("PURCHASE_HUB pairs with RENEW_SERVICE; MY_ORDERS pairs with PRICING", async () => {
      await setLayout(true);
      const grid = await actionGrid(false);
      expect(grid[0]).toEqual(["PURCHASE_HUB", "RENEW_SERVICE"]);
      expect(grid[2]).toEqual(["MY_ORDERS", "PRICING"]);
    });

    it("ADMIN_PANEL visibility is unchanged (active admin sees it, else hidden)", async () => {
      await setLayout(true);
      expect((await actionGrid(false)).flat()).not.toContain("ADMIN_PANEL");
      const adminGrid = await actionGrid(true);
      expect(adminGrid.flat()).toContain("ADMIN_PANEL");
      expect(adminGrid[adminGrid.length - 1]).toEqual(["ADMIN_PANEL"]);
    });

    it("inline and reply definitions match in combined mode too", async () => {
      await setLayout(true);
      const labels = await labelGrid(false);
      const reply = replyLabelGrid(await buildUserMainReplyKeyboard({ isActiveAdmin: false }));
      expect(reply).toEqual(labels);
    });
  });

  // --- HUB -----------------------------------------------------------------

  describe("purchase hub", () => {
    it("opens the real hub with the three existing routes (VPN / Other / back)", async () => {
      const { ctx, sent } = fakeCallbackCtx(user.telegramId, CB.USER_PURCHASE_HUB, { user });
      await renderPurchaseHub(ctx);
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toContain("🛒 خرید محصولات");
      const buttons = inlineButtons(sent[0].other);
      expect(buttons).toEqual([
        { text: BUY_LABEL, data: CB.USER_BUY },
        { text: OTHER_LABEL, data: CB.USER_OTHER_PRODUCTS },
        { text: "بازگشت به منوی اصلی", data: CB.USER_MENU },
      ]);
    });

    it("opening the hub clears the six interruptible checkout states", async () => {
      const session = initialSession();
      session.currentFlow = "checkout:discount";
      (session.temp as Record<string, unknown>).checkoutDraft = { marker: true };
      (session.temp as Record<string, unknown>).paymentDraft = { marker: true };
      (session.temp as Record<string, unknown>).walletTopupDraft = { marker: true };
      (session.temp as Record<string, unknown>).renewalDraft = { marker: true };
      (session.temp as Record<string, unknown>).extraVolumeDraft = { marker: true };
      (session.temp as Record<string, unknown>).extraTimeDraft = { marker: true };
      const { ctx } = fakeCallbackCtx(user.telegramId, CB.USER_PURCHASE_HUB, { user, session });
      await renderPurchaseHub(ctx);
      expect(session.currentFlow).toBeNull();
      for (const key of [
        "checkoutDraft",
        "paymentDraft",
        "walletTopupDraft",
        "renewalDraft",
        "extraVolumeDraft",
        "extraTimeDraft",
      ]) {
        expect((session.temp as Record<string, unknown>)[key]).toBeUndefined();
      }
    });

    it("opening the hub creates no financial / stock / Service record", async () => {
      const coBefore = await prisma.checkoutSession.count({ where: { userId: user.id } });
      const payBefore = await prisma.payment.count({ where: { userId: user.id } });
      const ordBefore = await prisma.order.count({ where: { userId: user.id } });
      const svcBefore = await prisma.service.count({ where: { userId: user.id } });
      const { ctx } = fakeCallbackCtx(user.telegramId, CB.USER_PURCHASE_HUB, { user });
      await renderPurchaseHub(ctx);
      expect(await prisma.checkoutSession.count({ where: { userId: user.id } })).toBe(coBefore);
      expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(payBefore);
      expect(await prisma.order.count({ where: { userId: user.id } })).toBe(ordBefore);
      expect(await prisma.service.count({ where: { userId: user.id } })).toBe(svcBefore);
    });

    it("hub body falls back to the default intro when the template is blank", () => {
      expect(purchaseHubBody("")).toContain("نوع محصول موردنظر خود را انتخاب کنید.");
      expect(purchaseHubBody("متن دلخواه")).toContain("متن دلخواه");
    });
  });

  // --- COMPATIBILITY (stale reply keyboards across layout changes) ----------

  describe("reply-label compatibility resolver", () => {
    it("resolves all three purchase actions in SPLIT mode (stale hub label works)", async () => {
      await setLayout(false);
      expect(await resolveMainMenuAction(BUY_LABEL)).toBe("BUY_SUBSCRIPTION");
      expect(await resolveMainMenuAction(OTHER_LABEL)).toBe("OTHER_PRODUCTS");
      // PURCHASE_HUB is hidden in split, but a stale combined keyboard still routes.
      expect(await resolveMainMenuAction(HUB_LABEL)).toBe("PURCHASE_HUB");
    });

    it("resolves all three purchase actions in COMBINED mode (stale split labels work)", async () => {
      await setLayout(true);
      expect(await resolveMainMenuAction(HUB_LABEL)).toBe("PURCHASE_HUB");
      // BUY/OTHER are hidden in combined, but stale split keyboards still route.
      expect(await resolveMainMenuAction(BUY_LABEL)).toBe("BUY_SUBSCRIPTION");
      expect(await resolveMainMenuAction(OTHER_LABEL)).toBe("OTHER_PRODUCTS");
    });

    it("an edited current label routes immediately; the superseded label does not", async () => {
      seq += 1;
      const edited = `خرید محصولات ویژه ${runTag}`;
      const row = await prisma.buttonText.findUniqueOrThrow({ where: { key: "purchase_hub" } });
      const res = await updateButtonText(row.id, edited, owner.id);
      expect(res.ok).toBe(true);
      clearTextCache();
      expect(await resolveMainMenuAction(edited)).toBe("PURCHASE_HUB");
      // The pre-edit label no longer resolves.
      expect(await resolveMainMenuAction(HUB_LABEL)).toBeNull();
    });

    it("the duplicate-label edit-time guard includes purchase_hub", async () => {
      const row = await prisma.buttonText.findUniqueOrThrow({ where: { key: "purchase_hub" } });
      // Editing purchase_hub to the CURRENT buy_subscription label must be refused.
      const res = await updateButtonText(row.id, BUY_LABEL, owner.id);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.safeMessage).toBe(DUPLICATE_MAIN_MENU_LABEL_TEXT);
      }
    });

    it("duplicate labels fail closed at resolution (forced collision → null)", async () => {
      // Force a collision bypassing the edit-time guard (a legacy/raw write).
      seq += 1;
      const collide = `چیدمان-یکسان-${runTag}`;
      await prisma.buttonText.updateMany({ where: { key: "purchase_hub" }, data: { currentText: collide } });
      await prisma.buttonText.updateMany({ where: { key: "other_products" }, data: { currentText: collide } });
      clearTextCache();
      expect(await resolveMainMenuAction(collide)).toBeNull();
    });

    it("arbitrary text never resolves to a menu action", async () => {
      expect(await resolveMainMenuAction(`random-${runTag}`)).toBeNull();
      expect(await resolveMainMenuAction("/menu")).toBeNull();
      expect(await resolveMainMenuAction("")).toBeNull();
    });
  });

  // --- ADMIN TOGGLE (view any admin; mutate OWNER only) --------------------

  describe("admin purchase-layout control", () => {
    it("any active admin may VIEW the layout page", async () => {
      await setLayout(false);
      const { ctx, sent } = fakeCallbackCtx(support.telegramId, "admin:menu_buy", { admin: support });
      await dispatchSettings(ctx);
      expect(sent).toHaveLength(1);
      expect(sent[0].text).toContain("دکمه‌های خرید جدا هستند");
      const buttons = inlineButtons(sent[0].other);
      // Split → the enable toggle carries the current code (0).
      expect(buttons[0]).toEqual({ text: "فعال‌کردن منوی خرید یکپارچه ✅", data: "admin:menu_buy:ask:0" });
    });

    it("a regular admin CANNOT mutate — OWNER-only toast, no state change", async () => {
      await setLayout(false);
      const ask = fakeCallbackCtx(support.telegramId, "admin:menu_buy:ask:0", { admin: support });
      await dispatchSettings(ask.ctx);
      expect(ask.toasts.some((t) => t?.includes("مالک"))).toBe(true);
      expect(ask.sent).toHaveLength(0); // no confirm page rendered

      const set = fakeCallbackCtx(support.telegramId, "admin:menu_buy:set:0", { admin: support });
      await dispatchSettings(set.ctx);
      expect(set.toasts.some((t) => t?.includes("مالک"))).toBe(true);
      clearSettingsCache();
      expect(await isCombinedPurchaseMenuEnabled()).toBe(false); // untouched
    });

    it("OWNER enable: commit flips to combined + writes a privacy-MINIMAL audit event", async () => {
      await setLayout(false);
      // ask shows the confirm page with the set button carrying the observed code.
      const ask = fakeCallbackCtx(owner.telegramId, "admin:menu_buy:ask:0", { admin: owner });
      await dispatchSettings(ask.ctx);
      expect(inlineButtons(ask.sent[0].other)[0]).toEqual({ text: "تایید ✅", data: "admin:menu_buy:set:0" });

      // Located by the UNIQUE event type + an isolated before/after window — NEVER
      // by adminId, because the event deliberately carries no actor identifier.
      const before = await prisma.systemLog.count({
        where: { eventType: "user_menu.purchase_layout_changed" },
      });
      const set = fakeCallbackCtx(owner.telegramId, "admin:menu_buy:set:0", { admin: owner });
      await dispatchSettings(set.ctx);
      clearSettingsCache();
      expect(await isCombinedPurchaseMenuEnabled()).toBe(true);
      // The result page states the "opens on next main-menu render" note (§10).
      expect(set.sent[set.sent.length - 1].text).toContain(
        "چیدمان جدید با بازکردن دوباره منوی اصلی برای کاربران نمایش داده می‌شود.",
      );

      const logs = await prisma.systemLog.findMany({
        where: { eventType: "user_menu.purchase_layout_changed" },
        orderBy: { createdAt: "desc" },
      });
      expect(logs.length).toBe(before + 1);
      const row = logs[0];

      // Every relation-id column is null — no correlation to an Admin/User row.
      expect(row.userId).toBeNull();
      expect(row.adminId).toBeNull();
      expect(row.orderId).toBeNull();
      expect(row.paymentId).toBeNull();
      expect(row.serviceId).toBeNull();

      // Metadata is EXACTLY the three safe fields.
      const meta = row.metadata as Record<string, unknown>;
      expect(meta).toEqual({
        previousLayout: purchaseMenuLayout(false),
        nextLayout: purchaseMenuLayout(true),
        actorRole: "OWNER",
      });

      // …and contains NO identifier / label / callback / Product / Payment field.
      const metaKeys = Object.keys(meta);
      for (const forbidden of [
        "id",
        "adminId",
        "userId",
        "telegramId",
        "label",
        "callback",
        "product",
        "productId",
        "payment",
        "paymentId",
        "amount",
      ]) {
        expect(metaKeys, `metadata must not contain "${forbidden}"`).not.toContain(forbidden);
      }
      // Belt-and-suspenders: the serialized metadata mentions no forbidden token.
      const metaJson = JSON.stringify(meta).toLowerCase();
      for (const token of ["adminid", "userid", "telegramid", "callback", "payment"]) {
        expect(metaJson.includes(token), `metadata json must not mention "${token}"`).toBe(false);
      }
    });

    it("OWNER disable: from combined, commit returns to split", async () => {
      await setLayout(true);
      const set = fakeCallbackCtx(owner.telegramId, "admin:menu_buy:set:1", { admin: owner });
      await dispatchSettings(set.ctx);
      clearSettingsCache();
      expect(await isCombinedPurchaseMenuEnabled()).toBe(false);
    });

    it("a stale OWNER confirmation is caught by CAS — state unchanged, fresh page", async () => {
      await setLayout(true); // stored is combined
      // The OWNER confirms enabling FROM split (code 0) but it is already combined.
      const set = fakeCallbackCtx(owner.telegramId, "admin:menu_buy:set:0", { admin: owner });
      await dispatchSettings(set.ctx);
      clearSettingsCache();
      expect(await isCombinedPurchaseMenuEnabled()).toBe(true); // no double toggle
      // The stale notice arrives as a toast; the body re-renders the fresh state.
      expect(set.toasts.some((t) => t?.includes("وضعیت چیدمان تغییر کرده بود"))).toBe(true);
      expect(set.sent[set.sent.length - 1].text).toContain("دکمه‌های خرید در یک دکمه ادغام شده‌اند");
    });

    it("a stale OWNER ASK (observed code no longer current) re-renders instead of confirming", async () => {
      await setLayout(true); // stored is combined
      const ask = fakeCallbackCtx(owner.telegramId, "admin:menu_buy:ask:0", { admin: owner });
      await dispatchSettings(ask.ctx);
      // No confirm page with a set button — the fresh status page instead.
      const buttons = inlineButtons(ask.sent[ask.sent.length - 1].other);
      expect(buttons.some((b) => b.data.startsWith("admin:menu_buy:set:"))).toBe(false);
    });

    it("the «نوع نمایش منوها» overview shows the current purchase layout + entry button", async () => {
      await setLayout(false);
      const split = fakeCallbackCtx(owner.telegramId, "admin:menu_mode", { admin: owner });
      await dispatchSettings(split.ctx);
      expect(split.sent[0].text).toContain("چیدمان خرید منوی کاربر:\nجداگانه");
      expect(inlineButtons(split.sent[0].other).some((b) => b.data === "admin:menu_buy")).toBe(true);

      await setLayout(true);
      const combined = fakeCallbackCtx(owner.telegramId, "admin:menu_mode", { admin: owner });
      await dispatchSettings(combined.ctx);
      expect(combined.sent[0].text).toContain("چیدمان خرید منوی کاربر:\nیکپارچه");
    });
  });
});
