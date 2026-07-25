import { prisma, TermsDocumentStatus } from "@zedbot/database";
import type { InlineKeyboard } from "grammy";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { CB } from "../src/core/callbacks.js";
import { termsHandler } from "../src/handlers/terms.handler.js";
import type { BotContext } from "../src/core/context.js";
import {
  ensureUserAccess,
  resetTermsMisconfigAlertForTests,
} from "../src/middlewares/user-access.middleware.js";
import {
  clearSettingsCache,
  getBooleanSetting,
  setSetting,
} from "../src/services/settings.service.js";
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
import {
  buildTermsScreen,
  TELEGRAM_MESSAGE_LIMIT,
  TERMS_TITLE_MAX_LENGTH,
  TERMS_UNAVAILABLE_TEXT_FALLBACK,
  toPersianDigits,
} from "../src/services/terms/terms-views.js";
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

/** Overrides the operator-editable terms title, as an admin edit would. */
async function setTitleTemplate(content: string): Promise<void> {
  await prisma.messageTemplate.upsert({
    where: { key: "terms_page_title" },
    update: { currentContent: content },
    create: {
      key: "terms_page_title",
      title: "عنوان صفحه قوانین",
      category: "general",
      defaultContent: "📜 قوانین و شرایط استفاده",
      currentContent: content,
    },
  });
  clearTextCache();
}

async function clearTitleTemplate(): Promise<void> {
  await prisma.messageTemplate.deleteMany({ where: { key: "terms_page_title" } });
  clearTextCache();
}

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
  const chat = { id: 42, type: "private" };
  const from = { id: 42, is_bot: false, first_name: "T" };
  // A full callback_query + update pair: grammY's composer filters read
  // ctx.update, so a bare `callbackQuery` is enough for calling the gate
  // directly but NOT for routing a real update through termsHandler.
  const callbackQuery =
    callbackData === undefined
      ? undefined
      : {
          id: "cbq",
          chat_instance: "ci",
          from,
          data: callbackData,
          message: { message_id: 1, date: 0, chat },
        };
  const ctx = {
    from,
    chat,
    dbUser,
    // Present so the accept handler's fall-through into the real access path
    // can render the actual user menu instead of dying on an undefined session.
    session: { temp: {} },
    admin: null,
    callbackQuery,
    update: callbackQuery === undefined ? { update_id: 1 } : { update_id: 1, callback_query: callbackQuery },
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
  // Enforcement is switched ON here because that is the only world in which
  // an acceptance is meaningful: recordTermsAcceptance refuses to write once
  // the master switch is off (a keyboard rendered before it was disabled).
  await enableTermsRequirement();
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

  it("G05b a long operator title is clamped so the WHOLE body still renders", async () => {
    // A body at the cap PLUS a long operator-edited title used to overflow 4096.
    // Overflowing is not cosmetic: sendMessage 400s, safeReply swallows it, and
    // the gate still blocks — the user is stuck with no message at all.
    //
    // The fix must not be "shorten the body": the button accepts the WHOLE
    // document, so hiding clauses behind an ellipsis would record acceptance of
    // text the user never saw (§4). The decoration is what gets clamped.
    const body = "ب".repeat(3500);
    const { id } = await publish(body);
    await setTitleTemplate("ت".repeat(900));

    const document = await prisma.termsDocument.findUniqueOrThrow({ where: { id } });
    const screen = await buildTermsScreen(document);

    expect(screen.text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
    // Every character of the body is present — nothing was elided.
    expect(screen.text).toContain(body);
    expect(screen.text).not.toContain("…");
    // The title was the thing that gave way.
    expect(screen.text).not.toContain("ت".repeat(TERMS_TITLE_MAX_LENGTH + 1));
    expect(callbacksOf(screen.keyboard)).toEqual([termsAcceptCallback(id)]);

    await clearTitleTemplate();
  });

  it("G05c a body too long to render offers NO accept button at all", async () => {
    // Legacy bodies predate the 3,500 cap (migration 20260727130000 repairs
    // them). Until then the screen must fail CLOSED: showing a partial document
    // beside a working accept button is the one thing §4 forbids, so the button
    // is what disappears — never part of the text.
    const oversized = "ک".repeat(4500);
    const document = await prisma.termsDocument.create({
      data: {
        version: 1,
        body: oversized,
        status: TermsDocumentStatus.PUBLISHED,
        publishedAt: new Date(),
      },
    });

    const screen = await buildTermsScreen(document);

    expect(callbacksOf(screen.keyboard)).toEqual([]);
    expect(screen.text).not.toContain(oversized.slice(0, 200));
    expect(screen.text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
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

  it("G22 a BLOCKED user pressing accept records NOTHING", async () => {
    // The accept action used to record first and gate afterwards, so a blocked
    // user with a stale button wrote a real acceptance row and had
    // termsAcceptedAt stamped before being told their account was blocked.
    const { id } = await publish("قوانین");
    await enableTermsRequirement();
    const user = await makeUser("BLOCKED");

    const { ctx, sent } = fakeCtx(user, termsAcceptCallback(id));
    await termsHandler.middleware()(ctx, async () => {});

    expect(await prisma.termsAcceptance.count({ where: { userId: user.id } })).toBe(0);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.termsAcceptedAt).toBeNull();
    // And they were told why.
    expect(sent.length).toBeGreaterThan(0);
  });

  it("G23 maintenance mode stops the accept action before it records", async () => {
    const { id } = await publish("قوانین");
    await enableTermsRequirement();
    const user = await makeUser();
    await setSetting("maintenance_mode", "true", "BOOLEAN");
    clearSettingsCache();

    const { ctx } = fakeCtx(user, termsAcceptCallback(id));
    await termsHandler.middleware()(ctx, async () => {});

    expect(await prisma.termsAcceptance.count({ where: { userId: user.id } })).toBe(0);
  });

  it("G24 a MALFORMED accept payload reaches the handler and is answered", async () => {
    // The gate skips itself for anything with the accept prefix, so the handler
    // must route on the prefix too — otherwise such a payload is silently
    // unanswered and the documented "stale button" behaviour never happens.
    const { id } = await publish("قوانین");
    await enableTermsRequirement();
    const user = await makeUser();

    const { ctx, sent } = fakeCtx(user, "user:terms:accept:zzz");
    let fellThrough = false;
    await termsHandler.middleware()(ctx, async () => {
      fellThrough = true;
    });

    expect(fellThrough).toBe(false);
    // Answered with the CURRENT terms and the CURRENT button; nothing accepted.
    expect(callbacksOf(sent.at(-1)?.keyboard)).toEqual([termsAcceptCallback(id)]);
    expect(await prisma.termsAcceptance.count({ where: { userId: user.id } })).toBe(0);
  });

  it("G27 enforceTerms re-gates an accept callback that no longer satisfies the terms", async () => {
    // The gate skips its terms step for accept callbacks (G15) so pressing
    // accept is not gated into the screen it is trying to satisfy. AFTER the
    // acceptance is recorded that skip is wrong: if a newer version was
    // published while the callback was in flight, the user owes THAT one, and
    // keeping the skip would walk them straight into the menu. This is the
    // option the accept handler re-enters with.
    const first = await publish("نسخه یک");
    const user = await makeUser();
    await recordTermsAcceptance(user.id, first.id);
    // A publication lands between the acceptance and the re-entry.
    const second = await publish("نسخه دو");

    // Default (the skip): the callback walks past the terms step.
    expect(await ensureUserAccess(fakeCtx(user, termsAcceptCallback(first.id)).ctx)).toBe(true);

    // Enforced: the same callback is stopped and shown the version it owes.
    const { ctx, sent } = fakeCtx(user, termsAcceptCallback(first.id));
    expect(await ensureUserAccess(ctx, { enforceTerms: true })).toBe(false);
    expect(callbacksOf(sent.at(-1)?.keyboard)).toEqual([termsAcceptCallback(second.id)]);
  });

  it("G25 pressing accept while NOTHING is published continues the access path", async () => {
    // Enforcement on with no published document is the state the gate itself
    // deliberately treats as a recoverable misconfiguration (only the OWNER can
    // publish, so blocking would be a lockout with no user-side recovery). It
    // is reachable in production: the v1 repair migration archives a version 1
    // whose body is unrenderable or over the limit and publishes nothing.
    // The accept action must agree with the gate rather than parking the user
    // on the "unavailable" message, which no button can ever satisfy.
    const { id } = await publish("قوانین");
    const user = await makeUser();
    await prisma.termsDocument.update({
      where: { id },
      data: { status: TermsDocumentStatus.ARCHIVED },
    });

    const { ctx, sent } = fakeCtx(user, termsAcceptCallback(id));
    await termsHandler.middleware()(ctx, async () => {});

    // Nothing was accepted — there was nothing to accept.
    expect(await prisma.termsAcceptance.count({ where: { userId: user.id } })).toBe(0);
    // ...and the user reached the menu instead of the dead-end message.
    expect((ctx.session as { lastMenu?: string }).lastMenu).toBe("user_main");
    expect(sent.some((m) => m.text === TERMS_UNAVAILABLE_TEXT_FALLBACK)).toBe(false);
  });

  it("G26 a DISABLED result drops this worker's cached switch before re-gating", async () => {
    // Multi-process deployment: another worker turns enforcement off while this
    // one still holds `terms_required=true` in its 30s settings cache.
    // recordTermsAcceptance reads the DATABASE and correctly returns DISABLED,
    // but the re-entered access gate reads the CACHE. Without invalidation it
    // re-draws the very screen the switch just retired — and pressing accept
    // again returns DISABLED again, forever.
    const { id } = await publish("قوانین");
    const user = await makeUser();

    // Warm this worker's cache with the pre-disable value...
    expect(await getBooleanSetting(TERMS_REQUIRED_KEY, false)).toBe(true);
    // ...then flip the row the way another process would: straight to the
    // database, leaving this process's cache stale on purpose.
    await prisma.setting.update({ where: { key: TERMS_REQUIRED_KEY }, data: { value: "false" } });

    const { ctx, sent } = fakeCtx(user, termsAcceptCallback(id));
    await termsHandler.middleware()(ctx, async () => {});

    expect(await prisma.termsAcceptance.count({ where: { userId: user.id } })).toBe(0);
    expect((ctx.session as { lastMenu?: string }).lastMenu).toBe("user_main");
    // No message in the whole exchange carried an accept button.
    expect(sent.flatMap((m) => callbacksOf(m.keyboard)).some(isTermsAcceptCallback)).toBe(false);
  });

  it("G28 the LEGACY accept button continues the access path when nothing is published", async () => {
    // Same dead end as G25, on the pre-upgrade `terms:accept` payload: it names
    // no document, so it always lands on "re-draw the current terms" — and with
    // enforcement on but nothing published there is no current terms to draw.
    const { id } = await publish("قوانین");
    const user = await makeUser();
    await prisma.termsDocument.update({
      where: { id },
      data: { status: TermsDocumentStatus.ARCHIVED },
    });

    const { ctx, sent } = fakeCtx(user, CB.TERMS_ACCEPT);
    await termsHandler.middleware()(ctx, async () => {});

    expect((ctx.session as { lastMenu?: string }).lastMenu).toBe("user_main");
    expect(sent.some((m) => m.text === TERMS_UNAVAILABLE_TEXT_FALLBACK)).toBe(false);
  });

  it("G29 an UNRESOLVABLE accept payload continues the access path when nothing is published", async () => {
    // The third route into the same dead end: a malformed/unknown short id
    // resolves to no document, so the handler re-draws the current terms —
    // which do not exist. Nothing is owed, so the menu is the right answer.
    const { id } = await publish("قوانین");
    const user = await makeUser();
    await prisma.termsDocument.update({
      where: { id },
      data: { status: TermsDocumentStatus.ARCHIVED },
    });

    const { ctx, sent } = fakeCtx(user, "user:terms:accept:zzz");
    await termsHandler.middleware()(ctx, async () => {});

    expect(await prisma.termsAcceptance.count({ where: { userId: user.id } })).toBe(0);
    expect((ctx.session as { lastMenu?: string }).lastMenu).toBe("user_main");
    expect(sent.some((m) => m.text === TERMS_UNAVAILABLE_TEXT_FALLBACK)).toBe(false);
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
