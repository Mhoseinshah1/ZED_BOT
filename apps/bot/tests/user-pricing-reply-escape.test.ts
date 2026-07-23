import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { prisma, type User } from "@zedbot/database";
import { Composer } from "grammy";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "pricing-escape-test-secret-pricing-escape-secret";

import type { BotContext } from "../src/core/context.js";
import { initialSession, type SessionData } from "../src/core/session.js";
import { getUserMenuMode, setUserMenuMode } from "../src/services/menu-mode.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";
import { clearTextCache } from "../src/services/text.service.js";
// The REAL handlers, imported and mounted in the EXACT production order from
// app.ts, so this reproduces the middleware-order defect (unlike PR #126 which
// dispatched pricingHandler directly).
import { pricingReplyEscapeRouter, userMenuTextRouter } from "../src/handlers/user-menu-actions.js";
import { checkoutTextHandler } from "../src/handlers/user-checkout/checkout.handler.js";
import { customerInputFormTextHandler } from "../src/handlers/user-checkout/customer-input-form.handler.js";
import { paymentReceiptHandler } from "../src/handlers/user-checkout/payment.handler.js";
import { extraTimeTextHandler } from "../src/handlers/user-extra-time/extra-time.handler.js";
import { extraVolumeTextHandler } from "../src/handlers/user-extra-volume/extra-volume.handler.js";
import { renewalTextHandler } from "../src/handlers/user-renewal/renewal.handler.js";
import { representativeInputHandler } from "../src/handlers/user-representative/representative.handler.js";
import { supportInputHandler } from "../src/handlers/user-support/support.handler.js";
import { walletTopupTextHandler } from "../src/handlers/user-wallet/wallet.handler.js";

// =============================================================================
// fix/pricing-reply-keyboard-flow-escape: the pre-flow Pricing reply-keyboard
// escape must run BEFORE the flow dispatcher, so pressing the Pricing button
// during one of the six interruptible checkout/payment INPUT flows opens
// Pricing instead of feeding the label to the discount / receipt / amount
// handler. Tested through a faithful replica of app.ts's message pipeline that
// mounts the REAL escape router + REAL flow handlers + REAL userMenuTextRouter
// in the exact production order.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

const PRICING_LABEL = "تعرفه اشتراک‌ها 💵"; // seed default for ButtonText `pricing`

// The active-flow → real-handler map, mirroring app.ts's flow-dispatcher
// branches. Each active flow routes to exactly the same handler app.ts uses.
const FLOW_HANDLERS: Record<string, Composer<BotContext>> = {
  "checkout:discount": checkoutTextHandler,
  "payment:receipt": paymentReceiptHandler,
  "renew:discount": renewalTextHandler,
  "extra_volume:discount": extraVolumeTextHandler,
  "extra_time:discount": extraTimeTextHandler,
  "wallet:topup:amount": walletTopupTextHandler,
  // Unrelated flows that must KEEP priority (never interrupted by Pricing):
  "support:message": supportInputHandler,
  "rep:apply": representativeInputHandler,
  "customer_input:form": customerInputFormTextHandler,
};

const DRAFT_KEY: Record<string, string> = {
  "checkout:discount": "checkoutDraft",
  "payment:receipt": "paymentDraft",
  "wallet:topup:amount": "walletTopupDraft",
  "renew:discount": "renewalDraft",
  "extra_volume:discount": "extraVolumeDraft",
  "extra_time:discount": "extraTimeDraft",
};

interface Captured {
  replies: string[];
  dispatchedFlow: string | null;
}

// Reproduces app.ts order: 1) pre-flow Pricing escape, 2) flow dispatcher,
// 3) userMenuTextRouter. A shared mutable probe records whether the flow
// dispatcher was reached (i.e. whether the escape router passed the message on).
let probe: Captured = { replies: [], dispatchedFlow: null };

const pipeline = new Composer<BotContext>();
pipeline.on("message:text", pricingReplyEscapeRouter.middleware());
pipeline.on("message", async (ctx, next) => {
  const flow = ctx.session.currentFlow;
  if (flow === null) {
    return next();
  }
  const handler = FLOW_HANDLERS[flow];
  if (handler === undefined) {
    return next();
  }
  probe.dispatchedFlow = flow; // the flow dispatcher was REACHED (escape passed through)
  try {
    await handler.middleware()(ctx, next);
  } catch {
    // A real flow handler may bail on a missing draft/api in this harness; the
    // ORDER assertion is that the dispatcher was reached at all.
  }
});
pipeline.on("message:text", userMenuTextRouter.middleware());

function flat(markup: unknown): Array<{ text: string; data?: string }> {
  const kb = (markup as { inline_keyboard?: Array<Array<Record<string, string>>> })?.inline_keyboard;
  if (!Array.isArray(kb)) {
    return [];
  }
  return kb.flat().map((b) => ({ text: b.text, data: b.callback_data }));
}

interface RunResult {
  replies: Array<{ text: string; buttons: Array<{ text: string; data?: string }> }>;
  dispatchedFlow: string | null;
}

async function run(text: string, user: User | null, session: SessionData): Promise<RunResult> {
  probe = { replies: [], dispatchedFlow: null };
  const replies: RunResult["replies"] = [];
  const from = { id: Number((runTag % 2_000_000_000n) + BigInt(seq++)), is_bot: false, first_name: "T" };
  const message = { message_id: 7, date: 0, chat: { id: from.id, type: "private" }, from, text };
  const ctx = {
    session,
    dbUser: user,
    admin: null,
    from,
    chat: message.chat,
    message,
    update: { update_id: 1, message },
    reply: async (t: string, other?: { reply_markup?: unknown }) => {
      replies.push({ text: t, buttons: flat(other?.reply_markup) });
      return {};
    },
    editMessageText: async (t: string, other?: { reply_markup?: unknown }) => {
      replies.push({ text: t, buttons: flat(other?.reply_markup) });
      return {};
    },
    answerCallbackQuery: async () => true,
    api: {
      sendMessage: async () => ({}),
      editMessageText: async () => ({}),
    },
  };
  await pipeline.middleware()(ctx as never, async () => undefined);
  return { replies, dispatchedFlow: probe.dispatchedFlow };
}

function pricingOpened(res: RunResult): boolean {
  return res.replies.some(
    (r) => r.text.includes("تعرفه‌ها") && r.buttons.some((b) => b.data === "user:price:s"),
  );
}

// --- source-order guard (no DB) ---------------------------------------------

describe("app.ts mounts the Pricing escape before the flow dispatcher", () => {
  it("pricingReplyEscapeRouter is registered before bot.on('message', ...)", () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const app = readFileSync(path.join(repoRoot, "apps/bot/src/app.ts"), "utf8");
    const escapeIdx = app.indexOf("pricingReplyEscapeRouter.middleware()");
    const flowIdx = app.indexOf('bot.on("message"');
    const userRouterIdx = app.indexOf("userMenuTextRouter.middleware()");
    expect(escapeIdx).toBeGreaterThan(-1);
    expect(flowIdx).toBeGreaterThan(-1);
    // Escape BEFORE the flow dispatcher; the post-flow user router stays after it.
    expect(escapeIdx).toBeLessThan(flowIdx);
    expect(userRouterIdx).toBeGreaterThan(flowIdx);
  });
});

describe.skipIf(hasDb)("pricing reply escape (skipped without DATABASE_URL)", () => {
  it("requires DATABASE_URL", () => {
    expect(hasDb).toBe(false);
  });
});

describe.runIf(hasDb)("pricing reply-keyboard escape (real pipeline)", () => {
  let user: User;
  let blocked: User;
  let priorMode: "INLINE" | "REPLY";

  beforeAll(async () => {
    priorMode = await getUserMenuMode();
    user = await prisma.user.create({
      data: { telegramId: runTag + BigInt(seq++), balanceToman: 1_000_000, group: "F", status: "ACTIVE" },
    });
    blocked = await prisma.user.create({
      data: { telegramId: runTag + BigInt(seq++), group: "F", status: "BLOCKED" },
    });
  });

  afterEach(async () => {
    // Restore an edited Pricing label if a test changed it.
    await prisma.buttonText.updateMany({
      where: { key: "pricing" },
      data: { currentText: PRICING_LABEL },
    });
    clearTextCache();
  });

  afterAll(async () => {
    await setUserMenuMode(priorMode);
    clearSettingsCache();
    await prisma.user.deleteMany({ where: { id: { in: [user.id, blocked.id] } } });
    await prisma.$disconnect();
  });

  function armed(flow: string): SessionData {
    const session = initialSession();
    session.currentFlow = flow;
    const key = DRAFT_KEY[flow];
    if (key !== undefined) {
      (session.temp as Record<string, unknown>)[key] = { marker: true };
    }
    return session;
  }

  it("REPLY + each interruptible flow + Pricing label opens Pricing and clears state", async () => {
    await setUserMenuMode("REPLY");
    clearSettingsCache();
    for (const flow of Object.keys(DRAFT_KEY)) {
      const session = armed(flow);
      const coBefore = await prisma.checkoutSession.count({ where: { userId: user.id } });
      const payBefore = await prisma.payment.count({ where: { userId: user.id } });
      const res = await run(PRICING_LABEL, user, session);
      expect(pricingOpened(res), `${flow}: pricing opened`).toBe(true);
      // The flow dispatcher was NOT reached — the label never became a discount
      // code / receipt / amount.
      expect(res.dispatchedFlow, `${flow}: flow dispatcher not reached`).toBeNull();
      expect(session.currentFlow, `${flow}: currentFlow cleared`).toBeNull();
      expect(
        (session.temp as Record<string, unknown>)[DRAFT_KEY[flow]],
        `${flow}: draft cleared`,
      ).toBeUndefined();
      // No financial record created by navigating.
      expect(await prisma.checkoutSession.count({ where: { userId: user.id } })).toBe(coBefore);
      expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(payBefore);
    }
  });

  it("REPLY + Pricing label does NOT interrupt unrelated flows", async () => {
    await setUserMenuMode("REPLY");
    clearSettingsCache();
    for (const flow of ["support:message", "rep:apply", "customer_input:form"]) {
      const session = initialSession();
      session.currentFlow = flow;
      const res = await run(PRICING_LABEL, user, session);
      // Pricing never opens, and the flow's OWN handler is reached by the
      // dispatcher (not bypassed) — the escape router passed the label through.
      // What that handler then does with its own flow is its normal business.
      expect(pricingOpened(res), `${flow}: pricing NOT opened`).toBe(false);
      expect(res.dispatchedFlow, `${flow}: reaches its own handler`).toBe(flow);
    }
  });

  it("REPLY + arbitrary text during a checkout flow still reaches the flow", async () => {
    await setUserMenuMode("REPLY");
    clearSettingsCache();
    const session = armed("checkout:discount");
    const res = await run(`random-${runTag}`, user, session);
    expect(pricingOpened(res)).toBe(false);
    expect(res.dispatchedFlow).toBe("checkout:discount");
  });

  it("edited Pricing label works immediately; the old label does not interrupt", async () => {
    await setUserMenuMode("REPLY");
    clearSettingsCache();
    const edited = `تعرفه‌های من ${runTag}`;
    await prisma.buttonText.update({ where: { key: "pricing" }, data: { currentText: edited } });
    clearTextCache();
    // New label rescues Pricing out of the flow.
    const good = await run(edited, user, armed("checkout:discount"));
    expect(pricingOpened(good)).toBe(true);
    expect(good.dispatchedFlow).toBeNull();
    // The OLD label no longer resolves → it falls through to the active flow.
    const stale = await run(PRICING_LABEL, user, armed("checkout:discount"));
    expect(pricingOpened(stale)).toBe(false);
    expect(stale.dispatchedFlow).toBe("checkout:discount");
  });

  it("INLINE mode never routes the Pricing label as navigation", async () => {
    await setUserMenuMode("INLINE");
    clearSettingsCache();
    const res = await run(PRICING_LABEL, user, armed("checkout:discount"));
    expect(pricingOpened(res)).toBe(false);
    expect(res.dispatchedFlow).toBe("checkout:discount");
  });

  it("commands keep their priority (never intercepted by the escape router)", async () => {
    await setUserMenuMode("REPLY");
    clearSettingsCache();
    const res = await run("/menu", user, armed("checkout:discount"));
    expect(pricingOpened(res)).toBe(false);
    expect(res.dispatchedFlow).toBe("checkout:discount");
  });

  it("a blocked user gets the access gate, not Pricing, and state is untouched", async () => {
    await setUserMenuMode("REPLY");
    clearSettingsCache();
    const session = armed("checkout:discount");
    const res = await run(PRICING_LABEL, blocked, session);
    expect(pricingOpened(res)).toBe(false);
    expect(res.dispatchedFlow).toBeNull(); // consumed by the gate, not the flow
    expect(res.replies.some((r) => r.text.includes("مسدود"))).toBe(true);
    // Access decided BEFORE any clear: the flow + draft survive.
    expect(session.currentFlow).toBe("checkout:discount");
    expect((session.temp as Record<string, unknown>).checkoutDraft).toBeDefined();
  });
});
