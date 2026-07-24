import { prisma, type User } from "@zedbot/database";
import { Composer } from "grammy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "purchase-nav-escape-test-secret-purchase-escape-01";

import type { BotContext } from "../src/core/context.js";
import { initialSession, type SessionData } from "../src/core/session.js";
import { getUserMenuMode, setUserMenuMode } from "../src/services/menu-mode.service.js";
import { clearSettingsCache } from "../src/services/settings.service.js";
import { clearTextCache } from "../src/services/text.service.js";
// REAL handlers, mounted in the EXACT production order from app.ts (§13 + §17):
// pre-flow purchase-navigation escape → flow dispatcher → userMenuTextRouter.
import {
  purchaseNavigationEscapeRouter,
  userMenuTextRouter,
} from "../src/handlers/user-menu-actions.js";
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
// feat/admin-controlled-unified-purchase-menu §13: the pre-flow escape router was
// generalized from Pricing to purchase-navigation (PRICING / PURCHASE_HUB /
// BUY_SUBSCRIPTION / OTHER_PRODUCTS). It must run BEFORE the flow dispatcher so a
// purchase-navigation reply button pressed during one of the six interruptible
// checkout/payment INPUT flows opens that section instead of feeding the label to
// the discount / receipt / amount handler. Tested through a faithful replica of
// app.ts's message pipeline. Resolution→action→handler dispatch is deterministic
// (locked by purchase-menu-combined.test.ts); here we prove pipeline interception.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
let seq = 0;

// Seed defaults for the purchase-navigation reply labels.
const HUB_LABEL = "خرید محصولات 🛒";
const BUY_LABEL = "خرید اشتراک 🔐";
const OTHER_LABEL = "محصولات دیگر 🛍";
const PRICING_LABEL = "تعرفه اشتراک‌ها 💵";

const FLOW_HANDLERS: Record<string, Composer<BotContext>> = {
  "checkout:discount": checkoutTextHandler,
  "payment:receipt": paymentReceiptHandler,
  "renew:discount": renewalTextHandler,
  "extra_volume:discount": extraVolumeTextHandler,
  "extra_time:discount": extraTimeTextHandler,
  "wallet:topup:amount": walletTopupTextHandler,
  // Unrelated flows that must KEEP priority (never interrupted):
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

let probe: { dispatchedFlow: string | null } = { dispatchedFlow: null };

const pipeline = new Composer<BotContext>();
pipeline.on("message:text", purchaseNavigationEscapeRouter.middleware());
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

interface RunResult {
  replies: Array<{ text: string; buttons: Array<{ text: string; data?: string }> }>;
  dispatchedFlow: string | null;
}

function flat(markup: unknown): Array<{ text: string; data?: string }> {
  const kb = (markup as { inline_keyboard?: Array<Array<Record<string, string>>> })?.inline_keyboard;
  if (!Array.isArray(kb)) {
    return [];
  }
  return kb.flat().map((b) => ({ text: b.text, data: b.callback_data }));
}

async function run(text: string, user: User | null, session: SessionData): Promise<RunResult> {
  probe = { dispatchedFlow: null };
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
    api: { sendMessage: async () => ({}), editMessageText: async () => ({}) },
  };
  await pipeline.middleware()(ctx as never, async () => undefined);
  return { replies, dispatchedFlow: probe.dispatchedFlow };
}

/** The hub renders a distinctive title + the VPN route button. */
function hubOpened(res: RunResult): boolean {
  return res.replies.some(
    (r) => r.text.includes("🛒 خرید محصولات") && r.buttons.some((b) => b.data === "user:buy"),
  );
}
function pricingOpened(res: RunResult): boolean {
  return res.replies.some(
    (r) => r.text.includes("تعرفه‌ها") && r.buttons.some((b) => b.data === "user:price:s"),
  );
}

describe.skipIf(hasDb)("purchase navigation escape (skipped without DATABASE_URL)", () => {
  it("requires DATABASE_URL", () => {
    expect(hasDb).toBe(false);
  });
});

describe.runIf(hasDb)("purchase-navigation reply-keyboard escape (real pipeline)", () => {
  let user: User;
  let blocked: User;
  let priorMode: "INLINE" | "REPLY";

  beforeAll(async () => {
    priorMode = await getUserMenuMode();
    await setUserMenuMode("REPLY");
    // Deterministic labels + optional feature rows off (they never affect the
    // three purchase labels, but keep resolution stable).
    for (const [key, text] of [
      ["purchase_hub", HUB_LABEL],
      ["buy_subscription", BUY_LABEL],
      ["other_products", OTHER_LABEL],
      ["pricing", PRICING_LABEL],
    ] as const) {
      await prisma.buttonText.updateMany({ where: { key }, data: { currentText: text } });
    }
    clearTextCache();
    clearSettingsCache();
    user = await prisma.user.create({
      data: { telegramId: runTag + BigInt(seq++), balanceToman: 1_000_000, group: "F", status: "ACTIVE" },
    });
    blocked = await prisma.user.create({
      data: { telegramId: runTag + BigInt(seq++), group: "F", status: "BLOCKED" },
    });
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

  const interruptible = Object.keys(DRAFT_KEY);

  it("PURCHASE_HUB label opens the hub during every interruptible flow, clears state, no records", async () => {
    for (const flow of interruptible) {
      const session = armed(flow);
      const coBefore = await prisma.checkoutSession.count({ where: { userId: user.id } });
      const payBefore = await prisma.payment.count({ where: { userId: user.id } });
      const res = await run(HUB_LABEL, user, session);
      expect(hubOpened(res), `${flow}: hub opened`).toBe(true);
      expect(res.dispatchedFlow, `${flow}: flow dispatcher not reached`).toBeNull();
      expect(session.currentFlow, `${flow}: currentFlow cleared`).toBeNull();
      expect(
        (session.temp as Record<string, unknown>)[DRAFT_KEY[flow]],
        `${flow}: draft cleared`,
      ).toBeUndefined();
      expect(await prisma.checkoutSession.count({ where: { userId: user.id } })).toBe(coBefore);
      expect(await prisma.payment.count({ where: { userId: user.id } })).toBe(payBefore);
    }
  });

  it("BUY_SUBSCRIPTION compatibility label opens the VPN flow during every interruptible flow", async () => {
    for (const flow of interruptible) {
      const session = armed(flow);
      const res = await run(BUY_LABEL, user, session);
      // Intercepted before the flow dispatcher; the VPN section (startBuyFlow) ran
      // and cleared checkout state. It is not the hub and not the active flow.
      expect(res.dispatchedFlow, `${flow}: flow not reached`).toBeNull();
      expect(session.currentFlow, `${flow}: state cleared`).toBeNull();
      expect(hubOpened(res), `${flow}: not the hub`).toBe(false);
      expect(res.replies.length, `${flow}: a section rendered`).toBeGreaterThan(0);
    }
  });

  it("OTHER_PRODUCTS compatibility label opens the Other-Products flow during every interruptible flow", async () => {
    for (const flow of interruptible) {
      const session = armed(flow);
      const res = await run(OTHER_LABEL, user, session);
      expect(res.dispatchedFlow, `${flow}: flow not reached`).toBeNull();
      expect(session.currentFlow, `${flow}: state cleared`).toBeNull();
      expect(hubOpened(res), `${flow}: not the hub`).toBe(false);
      expect(res.replies.length, `${flow}: a section rendered`).toBeGreaterThan(0);
    }
  });

  it("PRICING behavior from PR #127 remains green (pricing opens, flow not reached)", async () => {
    const res = await run(PRICING_LABEL, user, armed("checkout:discount"));
    expect(pricingOpened(res)).toBe(true);
    expect(res.dispatchedFlow).toBeNull();
  });

  it("unrelated flows keep priority (support / rep-apply / customer-input reach their handler)", async () => {
    for (const flow of ["support:message", "rep:apply", "customer_input:form"]) {
      const session = initialSession();
      session.currentFlow = flow;
      const res = await run(HUB_LABEL, user, session);
      expect(hubOpened(res), `${flow}: hub NOT opened`).toBe(false);
      expect(res.dispatchedFlow, `${flow}: reaches its own handler`).toBe(flow);
    }
  });

  it("arbitrary text during a checkout flow still reaches the flow", async () => {
    const res = await run(`random-${runTag}`, user, armed("checkout:discount"));
    expect(hubOpened(res)).toBe(false);
    expect(res.dispatchedFlow).toBe("checkout:discount");
  });

  it("INLINE mode never routes a purchase label as navigation", async () => {
    await setUserMenuMode("INLINE");
    clearSettingsCache();
    const res = await run(HUB_LABEL, user, armed("checkout:discount"));
    expect(hubOpened(res)).toBe(false);
    expect(res.dispatchedFlow).toBe("checkout:discount");
    await setUserMenuMode("REPLY");
    clearSettingsCache();
  });

  it("commands keep their priority (never intercepted)", async () => {
    const res = await run("/menu", user, armed("checkout:discount"));
    expect(hubOpened(res)).toBe(false);
    expect(res.dispatchedFlow).toBe("checkout:discount");
  });

  it("a blocked user gets the access gate, not the hub, and state is untouched", async () => {
    const session = armed("checkout:discount");
    const res = await run(HUB_LABEL, blocked, session);
    expect(hubOpened(res)).toBe(false);
    expect(res.dispatchedFlow).toBeNull(); // consumed by the gate, not the flow
    expect(res.replies.some((r) => r.text.includes("مسدود"))).toBe(true);
    // Access decided BEFORE any clear: the flow + draft survive.
    expect(session.currentFlow).toBe("checkout:discount");
    expect((session.temp as Record<string, unknown>).checkoutDraft).toBeDefined();
  });
});
