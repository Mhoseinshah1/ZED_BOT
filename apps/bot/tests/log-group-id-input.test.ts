import { prisma, type Admin } from "@zedbot/database";
import {
  LOG_GROUP_CHAT_ID_RE,
  normalizeChatIdInput,
} from "@zedbot/shared";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "log-group-id-input-tests-secret-1";

import { initialSession } from "../src/core/session.js";
import { LOG_GROUP_ID_FLOW } from "../src/handlers/admin-settings/log-group-id.handler.js";
import {
  logGroupIdHandler,
  logGroupIdTextHandler,
} from "../src/handlers/admin-settings/log-group-id.handler.js";
import {
  buildAdminMainMenuDefinition,
  resolveAdminMainMenuAction,
} from "../src/keyboards/admin-menu-definition.js";
import {
  INVALID_CHAT_ID_TEXT,
  prepareLogGroupConnection,
} from "../src/services/log-group-connection.service.js";
import { resetOpsQueueForTests } from "../src/services/ops-queue.service.js";
import { clearTextCache } from "../src/services/text.service.js";
import {
  callbackCtx,
  clearLogGroupSettings,
  deleteAttemptsFor,
  makeProbeApi,
  textCtx,
  type SentMessage,
} from "./helpers/log-group-harness.js";

// =============================================================================
// Scenarios 1-14: numeric chat-id normalization (pure) + the OWNER "lg:chat_id"
// input flow. Normalization accepts english/persian/arabic digits, unicode
// minus look-alikes and framing whitespace/zero-width, keeps the value as a
// STRING (never Number()-converted), and rejects positive/username/link/
// scientific/decimal/over-long shapes. The flow clears its state on cancel and
// on a "/"-command escape, and consumes a valid main-menu label as input
// (the reply-menu router never intercepts an id typed mid-flow).
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";

const OWNER_TG = 999_777_010;

async function dispatchText(ctx: never): Promise<boolean> {
  let fellThrough = false;
  await logGroupIdTextHandler.middleware()(ctx, async () => {
    fellThrough = true;
  });
  return fellThrough;
}

async function dispatchCallback(ctx: never): Promise<void> {
  await logGroupIdHandler.middleware()(ctx, async () => {});
}

function lastSent(sent: SentMessage[]): SentMessage {
  return sent[sent.length - 1];
}

describe("normalizeChatIdInput (pure) - scenarios 1-9", () => {
  const persian = "۰۱۲۳۴۵۶۷۸۹";
  const arabic = "٠١٢٣٤٥٦٧٨٩";
  const toPersian = (digits: string): string =>
    [...digits].map((d) => persian[Number(d)]).join("");
  const toArabic = (digits: string): string => [...digits].map((d) => arabic[Number(d)]).join("");

  it("1. accepts a plain english supergroup id and keeps the exact string", () => {
    const result = normalizeChatIdInput("-1001234567890");
    expect(result).toEqual({ ok: true, chatId: "-1001234567890" });
  });

  it("2. converts Persian digits to latin", () => {
    const result = normalizeChatIdInput(`-${toPersian("1001234567890")}`);
    expect(result).toEqual({ ok: true, chatId: "-1001234567890" });
  });

  it("3. converts Arabic-Indic digits to latin", () => {
    const result = normalizeChatIdInput(`-${toArabic("1002223334445")}`);
    expect(result).toEqual({ ok: true, chatId: "-1002223334445" });
  });

  it("4. folds unicode minus look-alikes to ASCII '-'", () => {
    for (const minus of ["−", "–", "—", "―", "－"]) {
      expect(normalizeChatIdInput(`${minus}1001234567890`)).toEqual({
        ok: true,
        chatId: "-1001234567890",
      });
    }
  });

  it("5. strips framing whitespace, NBSP and zero-width marks", () => {
    expect(normalizeChatIdInput("  -1001 234 567 890  ")).toEqual({
      ok: true,
      chatId: "-1001234567890",
    });
    expect(normalizeChatIdInput("‎-1001234567890‏")).toEqual({
      ok: true,
      chatId: "-1001234567890",
    });
    expect(normalizeChatIdInput("-100​1234567890")).toEqual({
      ok: true,
      chatId: "-1001234567890",
    });
  });

  it("6. never Number()-converts: a 19-digit id round-trips as an exact string", () => {
    const raw = "-1009999888877776666"; // 19 digits after the minus
    const result = normalizeChatIdInput(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.chatId).toBe(raw); // exact string preserved
      // A float conversion would silently lose precision - it must NOT match.
      expect(result.chatId).not.toBe(String(Number(raw)));
      expect(Number.isInteger(Number(result.chatId))).toBe(true);
    }
    expect(LOG_GROUP_CHAT_ID_RE.test(raw)).toBe(true);
  });

  it("7. rejects positive ids, usernames, links and invite links", () => {
    for (const bad of [
      "1001234567890",
      "100123456",
      "@publicgroup",
      "https://t.me/joinchat/AAAA",
      "https://t.me/+abcDEF123",
      "t.me/somegroup",
    ]) {
      expect(normalizeChatIdInput(bad), bad).toEqual({ ok: false });
    }
  });

  it("8. rejects scientific notation, decimals, empty and mixed text", () => {
    for (const bad of ["-1e12", "-1001234567890.5", "", "  ", "group -1001234567890", "-100abc123456"]) {
      expect(normalizeChatIdInput(bad), bad).toEqual({ ok: false });
    }
  });

  it("9. rejects over-long input (pre-norm cap) and too-many-digit ids", () => {
    expect(normalizeChatIdInput(`-100${"1".repeat(70)}`)).toEqual({ ok: false }); // > 64 chars
    expect(normalizeChatIdInput(`-100${"1".repeat(21)}`)).toEqual({ ok: false }); // > 20 digits
    // Non-string inputs are rejected too.
    expect(normalizeChatIdInput(-1001234567890 as unknown)).toEqual({ ok: false });
    expect(normalizeChatIdInput(undefined)).toEqual({ ok: false });
  });
});

describe("prepareLogGroupConnection input rejection - scenario 10", () => {
  it("10. returns INVALID_CHAT_ID_TEXT for a bad-format id (no probe, no persist)", async () => {
    const api = makeProbeApi();
    const result = await prepareLogGroupConnection(api, "@not-an-id", OWNER_TG);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.safeCode).toBe("INVALID_INPUT");
      expect(result.safeMessage).toBe(INVALID_CHAT_ID_TEXT);
    }
    // Bad input short-circuits before any Telegram probe.
    expect(api.getChatCalls).toHaveLength(0);
  });
});

describe.runIf(hasDb && hasRedis)("lg:chat_id input flow - scenarios 11-14", () => {
  let owner: Admin;

  beforeAll(async () => {
    owner = await prisma.admin.create({
      data: { telegramId: BigInt(OWNER_TG), role: "OWNER", isActive: true },
    });
    clearTextCache();
    await clearLogGroupSettings();
  });

  afterEach(async () => {
    await deleteAttemptsFor([owner.id]);
    await clearLogGroupSettings();
  });

  afterAll(async () => {
    await prisma.admin.deleteMany({ where: { id: owner.id } });
    await resetOpsQueueForTests();
    await prisma.$disconnect();
  });

  it("11. an invalid id keeps the flow active and re-prompts (no fall-through)", async () => {
    const session = initialSession();
    session.currentFlow = LOG_GROUP_ID_FLOW;
    const { ctx, sent } = textCtx("not-a-valid-id", { admin: owner, session });
    const fellThrough = await dispatchText(ctx);
    expect(fellThrough).toBe(false); // consumed, not passed on
    expect(lastSent(sent).text).toBe(INVALID_CHAT_ID_TEXT);
    // The flow stays active so the OWNER can correct + resend.
    expect((session as { currentFlow: string | null }).currentFlow).toBe(LOG_GROUP_ID_FLOW);
  });

  it("12. cancel callback clears currentFlow + the draft", async () => {
    const session = initialSession();
    session.currentFlow = LOG_GROUP_ID_FLOW;
    session.temp.adminLogGroupSetupDraft = { attemptId: "abc123" };
    const { ctx } = callbackCtx("admin:lg:id_cancel", { admin: owner, session });
    await dispatchCallback(ctx);
    const s = session as { currentFlow: string | null; temp: { adminLogGroupSetupDraft?: unknown } };
    expect(s.currentFlow).toBeNull();
    expect(s.temp.adminLogGroupSetupDraft).toBeUndefined();
  });

  it("13. a '/'-command escapes the flow (the flow-timeout equivalent) and falls through", async () => {
    // The flow has no timer; a leading-slash message is its documented escape.
    const session = initialSession();
    session.currentFlow = LOG_GROUP_ID_FLOW;
    session.temp.adminLogGroupSetupDraft = { attemptId: "abc123" };
    const { ctx, sent } = textCtx("/menu", { admin: owner, session });
    const fellThrough = await dispatchText(ctx);
    expect(fellThrough).toBe(true); // handed off to normal command handling
    const s = session as { currentFlow: string | null; temp: { adminLogGroupSetupDraft?: unknown } };
    expect(s.currentFlow).toBeNull();
    expect(s.temp.adminLogGroupSetupDraft).toBeUndefined();
    expect(sent).toHaveLength(0); // the flow emitted nothing
  });

  it("14. a valid main-menu label typed mid-flow is consumed as input, not menu nav", async () => {
    // Prove the string really IS a live main-menu label first.
    const definition = await buildAdminMainMenuDefinition(owner);
    const label = definition.flat().find((b) => b.action === "GENERAL_SETTINGS")?.label ?? "";
    expect(label).not.toBe("");
    expect(await resolveAdminMainMenuAction(label, owner)).toMatchObject({ matched: true });

    // Sent as text while the flow is active: the id handler consumes it (the
    // reply-menu router, which runs AFTER the flow dispatcher, never sees it).
    const session = initialSession();
    session.currentFlow = LOG_GROUP_ID_FLOW;
    const { ctx, sent } = textCtx(label, { admin: owner, session });
    const fellThrough = await dispatchText(ctx);
    expect(fellThrough).toBe(false); // no next() -> menu router unreachable
    expect(lastSent(sent).text).toBe(INVALID_CHAT_ID_TEXT); // treated as (invalid) id
    expect((session as { currentFlow: string | null }).currentFlow).toBe(LOG_GROUP_ID_FLOW);
  });
});
