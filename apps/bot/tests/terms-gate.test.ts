import { prisma } from "@zedbot/database";
import type { InlineKeyboard } from "grammy";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CB } from "../src/core/callbacks.js";
import type { BotContext } from "../src/core/context.js";
import {
  ensureUserAccess,
  resetTermsMisconfigAlertForTests,
} from "../src/middlewares/user-access.middleware.js";
import { clearSettingsCache, setSetting } from "../src/services/settings.service.js";
import {
  isTermsAcceptCallback,
  parseTermsAcceptCallback,
  TERMS_ACCEPT_CALLBACK_MAX_BYTES,
  TERMS_ACCEPT_PATTERN,
  termsAcceptCallback,
} from "../src/services/terms/terms-callbacks.js";
import {
  createTermsDraft,
  disableTermsRequirement,
  enableTermsRequirement,
  publishTermsDraft,
  recordTermsAcceptance,
  TERMS_REQUIRED_KEY,
  updateTermsDraftBody,
} from "../src/services/terms/terms-document.service.js";
import { buildTermsScreen, toPersianDigits } from "../src/services/terms/terms-views.js";
import { clearTextCache } from "../src/services/text.service.js";

// =============================================================================
// Versioned mandatory terms — GATE, CALLBACK IDENTITY and SCREEN (§1, §4, §5,
// §6, §14). Proves the gate order is preserved, that the screen and its button
// always describe the same document, and that every stale/adversarial payload
// accepts nothing.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const TELEGRAM_ID_BASE = 8_200_000_000_000n;
const RUN_TAG = BigInt(Date.now() % 1_000_000_000);
let seq = 0n;

interface Sent {
  text: string;
  keyboard?: InlineKeyboard;
}

interface FakeCtx {
  ctx: BotContext;
  sent: Sent[];
  answers: (string | undefined)[];
}

function fakeCtx(
  dbUser: { id: string; telegramId: bigint; status: string } | null,
  callbackData?: string,
): FakeCtx {
  const sent: Sent[] = [];
  const answers: (string | undefined)[] = [];
  const ctx = {
    from: { id: 42, is_bot: false, first_name: "T" },
    dbUser,
    callbackQuery: callbackData === undefined ? undefined : { data: callbackData },
    reply: vi.fn(async (text: string, other?: { reply_markup?: InlineKeyboard }) => {
      sent.push({ text, keyboard: other?.reply_markup });
    }),
    answerCallbackQuery: vi.fn(async (other?: { text?: string }) => {
      answers.push(other?.text);
    }),
    editMessageText: vi.fn(async () => {
      throw new Error("no message to edit");
    }),
    api: {
      getChatMember: vi.fn(async () => ({ status: "member" })),
    },
  } as unknown as BotContext;
  return { ctx, sent, answers };
}

/**
 * Users created by THIS file, tracked by id. Cleanup deletes exactly these
 * rows: a telegramId-range delete would also hit users created by other
 * suites in the shared test database, and those may own Orders whose
 * foreign key then refuses the delete.
 */
const createdUserIds: string[] = [];

async function makeUser(status: "ACTIVE" | "BLOCKED" = "ACTIVE"): Promise<{
  id: string;
  telegramId: bigint;
  status: string;
}> {
  seq += 1n;
  const row = await prisma.user.create({
    data: { telegramId: TELEGRAM_ID_BASE + RUN_TAG * 1000n + seq, status },
  });
  createdUserIds.push(row.id);
  return { id: row.id, telegramId: row.telegramId, status: row.status };
}

async function publish(body: string): Promise<{ id: string; version: number }> {
  const draft = await createTermsDraft(null);
  if (!draft.ok) throw new Error(`draft failed: ${draft.code}`);
  const updated = await updateTermsDraftBody(draft.draft.id, body);
  if (!updated.ok) throw new Error(`body failed: ${updated.code}`);
  const published = await publishTermsDraft(updated.draft.id, null);
  if (!published.ok) throw new Error(`publish failed: ${published.code}`);
  return { id: published.document.id, version: published.document.version ?? -1 };
}

function callbacksOf(keyboard: InlineKeyboard | undefined): string[] {
  if (keyboard === undefined) return [];
  return keyboard.inline_keyboard.flat().map((b) => ("callback_data" in b ? b.callback_data : ""));
}

async function resetAll(): Promise<void> {
  await prisma.termsAcceptance.deleteMany({});
  await prisma.termsDocument.deleteMany({});
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
  await prisma.setting.deleteMany({
    where: { key: { in: [TERMS_REQUIRED_KEY, "maintenance_mode", "force_join_enabled"] } },
  });
  clearSettingsCache();
  clearTextCache();
  resetTermsMisconfigAlertForTests();
}

describe.runIf(hasDb)("versioned terms — callback identity (§4)", () => {
  it("G01 the accept callback carries the document and fits Telegram's budget", () => {
    const id = "0123abcd-4567-89ef-0123-456789abcdef";
    const data = termsAcceptCallback(id);
    expect(data).toBe("user:terms:accept:0123abcd");
    expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(TERMS_ACCEPT_CALLBACK_MAX_BYTES);
  });

  it("G02 parses a well-formed accept callback and rejects malformed ones", () => {
    expect(parseTermsAcceptCallback("user:terms:accept:0123abcd")).toBe("0123abcd");
    expect(parseTermsAcceptCallback("user:terms:accept:")).toBeNull();
    expect(parseTermsAcceptCallback("user:terms:accept:zzz!!")).toBeNull();
    expect(parseTermsAcceptCallback("user:terms:accept:../../etc/passwd")).toBeNull();
    expect(parseTermsAcceptCallback(undefined)).toBeNull();
    expect(parseTermsAcceptCallback("terms:accept")).toBeNull();
  });

  it("G03 a MALFORMED accept payload is still recognised as an accept action", () => {
    // Otherwise the gate would re-render the terms screen instead of letting the
    // handler explain that the button is stale — an infinite loop for the user.
    expect(isTermsAcceptCallback("user:terms:accept:!!!")).toBe(true);
    expect(isTermsAcceptCallback("user:terms:accept:0123abcd")).toBe(true);
    expect(isTermsAcceptCallback("admin:terms:root")).toBe(false);
    expect(isTermsAcceptCallback(undefined)).toBe(false);
  });

  it("G04 routing never derives from the visible Persian label", () => {
    // The pattern is pure ASCII: no Persian text can match it, so editing a
    // button's label in the text registry cannot re-route or disable the gate.
    expect(TERMS_ACCEPT_PATTERN.test("قوانین را می‌پذیرم ✅")).toBe(false);
    expect(TERMS_ACCEPT_PATTERN.test("user:terms:accept:0123abcd")).toBe(true);
  });
});

describe.runIf(hasDb)("versioned terms — user screen (§5)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("G05 the screen shows the title, the version in Persian digits and the full body", async () => {
    const { id, version } = await publish("متن کامل قوانین سرویس");
    const document = await prisma.termsDocument.findUniqueOrThrow({ where: { id } });

    const screen = await buildTermsScreen(document);
    expect(screen.text).toContain("📜 قوانین و شرایط استفاده");
    expect(screen.text).toContain(`نسخه: ${toPersianDigits(version)}`);
    expect(screen.text).toContain("متن کامل قوانین سرویس");
  });

  it("G06 the screen's button always names the SAME document it rendered", async () => {
    const first = await publish("نسخه یک");
    const doc1 = await prisma.termsDocument.findUniqueOrThrow({ where: { id: first.id } });
    const screen1 = await buildTermsScreen(doc1);
    expect(callbacksOf(screen1.keyboard)).toEqual([termsAcceptCallback(first.id)]);

    const second = await publish("نسخه دو");
    const doc2 = await prisma.termsDocument.findUniqueOrThrow({ where: { id: second.id } });
    const screen2 = await buildTermsScreen(doc2);
    // Different document -> different button. "screen shows N, button accepts M"
    // is unrepresentable because both come from one document object.
    expect(callbacksOf(screen2.keyboard)).toEqual([termsAcceptCallback(second.id)]);
    expect(callbacksOf(screen1.keyboard)).not.toEqual(callbacksOf(screen2.keyboard));
  });

  it("G07 the publication date is rendered when present", async () => {
    const { id } = await publish("متن");
    const document = await prisma.termsDocument.findUniqueOrThrow({ where: { id } });
    const screen = await buildTermsScreen(document);
    expect(screen.text).toContain("تاریخ انتشار:");
  });
});

describe.runIf(hasDb)("versioned terms — access gate (§1, §6, §7)", () => {
  beforeEach(resetAll);
  afterAll(async () => {
    await resetAll();
    await prisma.$disconnect();
  });

  it("G08 no gate at all while enforcement is disabled", async () => {
    await publish("قوانین");
    await disableTermsRequirement();
    const user = await makeUser();

    const { ctx, sent } = fakeCtx(user);
    expect(await ensureUserAccess(ctx)).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("G09 enabled + published + not accepted blocks and shows the terms screen", async () => {
    const { id, version } = await publish("قوانین سرویس");
    await enableTermsRequirement();
    const user = await makeUser();

    const { ctx, sent } = fakeCtx(user);
    expect(await ensureUserAccess(ctx)).toBe(false);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(`نسخه: ${toPersianDigits(version)}`);
    expect(callbacksOf(sent[0].keyboard)).toEqual([termsAcceptCallback(id)]);
  });

  it("G10 a user who accepted the CURRENT version passes", async () => {
    const { id } = await publish("قوانین");
    await enableTermsRequirement();
    const user = await makeUser();
    await recordTermsAcceptance(user.id, id);

    const { ctx, sent } = fakeCtx(user);
    expect(await ensureUserAccess(ctx)).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("G11 publishing a new version re-gates a user who accepted the old one", async () => {
    const first = await publish("نسخه یک");
    await enableTermsRequirement();
    const user = await makeUser();
    await recordTermsAcceptance(user.id, first.id);

    // Passes today...
    expect(await ensureUserAccess(fakeCtx(user).ctx)).toBe(true);

    const second = await publish("نسخه دو");

    // ...and is gated the moment version 2 is published.
    const { ctx, sent } = fakeCtx(user);
    expect(await ensureUserAccess(ctx)).toBe(false);
    expect(callbacksOf(sent[0].keyboard)).toEqual([termsAcceptCallback(second.id)]);
  });

  it("G12 maintenance mode still wins over the terms gate (order preserved)", async () => {
    await publish("قوانین");
    await enableTermsRequirement();
    await setSetting("maintenance_mode", "true", "BOOLEAN");
    clearSettingsCache();
    const user = await makeUser();

    const { ctx, sent } = fakeCtx(user);
    expect(await ensureUserAccess(ctx)).toBe(false);
    // The maintenance message, NOT the terms screen.
    expect(sent[0].text).not.toContain("📜 قوانین و شرایط استفاده");
    expect(sent[0].keyboard).toBeUndefined();
  });

  it("G13 a blocked account still wins over the terms gate (order preserved)", async () => {
    await publish("قوانین");
    await enableTermsRequirement();
    const user = await makeUser("BLOCKED");

    const { ctx, sent } = fakeCtx(user);
    expect(await ensureUserAccess(ctx)).toBe(false);
    expect(sent[0].text).not.toContain("📜 قوانین و شرایط استفاده");
  });

  it("G14 terms are evaluated BEFORE force join", async () => {
    const { id } = await publish("قوانین");
    await enableTermsRequirement();
    await setSetting("force_join_enabled", "true", "BOOLEAN");
    clearSettingsCache();
    const user = await makeUser();

    const { ctx, sent } = fakeCtx(user);
    expect(await ensureUserAccess(ctx)).toBe(false);
    // The terms screen, not the force-join screen — and the force-join check
    // never even ran.
    expect(callbacksOf(sent[0].keyboard)).toEqual([termsAcceptCallback(id)]);
    expect(ctx.api.getChatMember).not.toHaveBeenCalled();
  });

  it("G15 the gate skips itself for the accept action so it can be recorded", async () => {
    const { id } = await publish("قوانین");
    await enableTermsRequirement();
    const user = await makeUser();

    const { ctx, sent } = fakeCtx(user, termsAcceptCallback(id));
    expect(await ensureUserAccess(ctx)).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("G16 the gate also skips itself for a MALFORMED accept payload", async () => {
    await publish("قوانین");
    await enableTermsRequirement();
    const user = await makeUser();

    // Otherwise the user would be stuck: the gate would answer with the terms
    // screen forever instead of the handler saying "this button is stale".
    const { ctx } = fakeCtx(user, "user:terms:accept:!!!!");
    expect(await ensureUserAccess(ctx)).toBe(true);
  });

  it("G17 enforcement enabled with NOTHING published lets users through, not out", async () => {
    // Unreachable via the bot (enabling is refused without a published version),
    // so this covers manual tampering / a partial restore. Blocking here would
    // deny every user access with no action available to them.
    await setSetting(TERMS_REQUIRED_KEY, "true", "BOOLEAN");
    clearSettingsCache();
    const user = await makeUser();

    const { ctx, sent } = fakeCtx(user);
    expect(await ensureUserAccess(ctx)).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it("G18 an acceptance of an ARCHIVED version does not satisfy the gate", async () => {
    const first = await publish("نسخه یک");
    const user = await makeUser();
    await recordTermsAcceptance(user.id, first.id);
    await publish("نسخه دو");
    await enableTermsRequirement();

    const { ctx } = fakeCtx(user);
    expect(await ensureUserAccess(ctx)).toBe(false);
  });

  it("G19 disabling then re-enabling the same version does not re-gate an accepter", async () => {
    const { id } = await publish("قوانین");
    await enableTermsRequirement();
    const user = await makeUser();
    await recordTermsAcceptance(user.id, id);

    await disableTermsRequirement();
    await enableTermsRequirement();

    expect(await ensureUserAccess(fakeCtx(user).ctx)).toBe(true);
  });

  it("G20 the legacy termsAcceptedAt timestamp alone does NOT satisfy the gate", async () => {
    // A user carrying only the old timestamp (e.g. stamped by some other path)
    // has no acceptance row for the published document, so they must accept.
    const { id } = await publish("قوانین");
    await enableTermsRequirement();
    const user = await makeUser();
    await prisma.user.update({ where: { id: user.id }, data: { termsAcceptedAt: new Date() } });

    const { ctx, sent } = fakeCtx(user);
    expect(await ensureUserAccess(ctx)).toBe(false);
    expect(callbacksOf(sent[0].keyboard)).toEqual([termsAcceptCallback(id)]);
  });

  it("G21 the legacy terms:accept callback is NOT treated as a versioned accept", async () => {
    await publish("قوانین");
    await enableTermsRequirement();
    const user = await makeUser();

    // It names no document, so it can never satisfy "accept exactly what you
    // were shown"; the gate does not skip for it.
    expect(isTermsAcceptCallback(CB.TERMS_ACCEPT)).toBe(false);
    const { ctx } = fakeCtx(user, CB.TERMS_ACCEPT);
    expect(await ensureUserAccess(ctx)).toBe(false);
  });
});
