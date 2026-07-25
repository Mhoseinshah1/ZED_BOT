import { prisma, TermsDocumentStatus } from "@zedbot/database";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
  bootstrapLegacyTermsDocument,
  createTermsDraft,
  deleteTermsDraft,
  disableTermsRequirement,
  enableTermsRequirement,
  getDraftTerms,
  getPublishedTerms,
  getTermsAcceptanceStats,
  hasAcceptedTermsDocument,
  isMeaningfulTermsBody,
  listTermsVersionsPage,
  normalizeTermsBody,
  publishTermsDraft,
  recordTermsAcceptance,
  resolveTermsDocumentByShortId,
  TERMS_MAX_BODY_LENGTH,
  TERMS_REQUIRED_KEY,
  termsContentHash,
  updateTermsDraftBody,
  validateTermsBody,
} from "../src/services/terms/terms-document.service.js";
import { clearSettingsCache, getBooleanSetting } from "../src/services/settings.service.js";

// =============================================================================
// Versioned mandatory terms — DOCUMENT + ACCEPTANCE semantics (§2, §3, §5, §7,
// §9, §11, §13). Every case runs against a real PostgreSQL so the database-level
// invariants (single published document, version/status check constraint,
// acceptance uniqueness) are exercised alongside the service logic.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const RUN_TAG = BigInt(Date.now() % 1_000_000_000);
let seq = 0n;
function nextTelegramId(): bigint {
  seq += 1n;
  return 8_000_000_000_000n + RUN_TAG * 1000n + seq;
}

/** Telegram ids allocated by this file, so cleanup can target exactly them. */
const TELEGRAM_ID_BASE = 8_000_000_000_000n;

async function makeUser(status: "ACTIVE" | "BLOCKED" = "ACTIVE"): Promise<string> {
  const row = await prisma.user.create({ data: { telegramId: nextTelegramId(), status } });
  return row.id;
}

/**
 * Acceptance counts are aggregates over the WHOLE user table, and this suite
 * shares its database with every other suite. Assertions are therefore made
 * against a baseline captured just before the test acts, never against an
 * assumed-empty table.
 */
async function activeUserCount(): Promise<number> {
  return prisma.user.count({ where: { status: "ACTIVE" } });
}

/** Publishes a body and returns the resulting document. */
async function publish(body: string): Promise<{ id: string; version: number }> {
  const draft = await createTermsDraft(null);
  if (!draft.ok) throw new Error(`draft creation failed: ${draft.code}`);
  const updated = await updateTermsDraftBody(draft.draft.id, body);
  if (!updated.ok) throw new Error(`draft update failed: ${updated.code}`);
  const published = await publishTermsDraft(updated.draft.id, null);
  if (!published.ok) throw new Error(`publish failed: ${published.code}`);
  return { id: published.document.id, version: published.document.version ?? -1 };
}

async function resetTermsState(): Promise<void> {
  await prisma.termsAcceptance.deleteMany({});
  await prisma.termsDocument.deleteMany({});
  // Users this file created (their acceptances cascade away with them).
  await prisma.user.deleteMany({ where: { telegramId: { gte: TELEGRAM_ID_BASE } } });
  await prisma.setting.deleteMany({ where: { key: TERMS_REQUIRED_KEY } });
  await prisma.messageTemplate.deleteMany({ where: { key: "terms_text" } });
  clearSettingsCache();
}

describe.runIf(hasDb)("versioned terms — body validation (§5, §14)", () => {
  it("T01 rejects an empty body", () => {
    expect(validateTermsBody("")).toEqual({ ok: false, code: "EMPTY" });
  });

  it("T02 rejects a whitespace-only body", () => {
    expect(validateTermsBody("   \n\t  \n ")).toEqual({ ok: false, code: "EMPTY" });
  });

  it("T03 rejects a body made only of zero-width characters", () => {
    expect(validateTermsBody("\u200c\u200d\u200b\ufeff")).toEqual({ ok: false, code: "EMPTY" });
  });

  it("T04 rejects a body longer than the safe limit", () => {
    const result = validateTermsBody("ب".repeat(TERMS_MAX_BODY_LENGTH + 1));
    expect(result).toEqual({ ok: false, code: "TOO_LONG" });
  });

  it("T05 accepts a body exactly at the limit", () => {
    const result = validateTermsBody("ب".repeat(TERMS_MAX_BODY_LENGTH));
    expect(result.ok).toBe(true);
  });

  it("T06 strips control characters and bidi overrides but KEEPS ZWNJ", () => {
    // ZWNJ is a real letter inside Persian words ("می‌پذیرم"), so stripping it
    // would corrupt the operator's text; RLO and NUL/BEL make rendered text lie.
    const normalized = normalizeTermsBody("قوانین \u0000\u202e استفاده\u200c\u0007 جدید");
    expect(normalized).not.toContain("\u0000");
    expect(normalized).not.toContain("\u0007");
    expect(normalized).not.toContain("\u202e");
    expect(normalized).toContain("\u200c");
  });

  it("T07 preserves newlines and folds CRLF", () => {
    expect(normalizeTermsBody("خط اول\r\nخط دوم\rخط سوم")).toBe("خط اول\nخط دوم\nخط سوم");
  });

  it("T08 treats HTML/Markdown as literal text, never as markup", () => {
    const raw = "<b>قوانین</b> & *مهم* <script>alert(1)</script>";
    const result = validateTermsBody(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Preserved verbatim: the screen renders plain text (no parse_mode), so
      // there is nothing to escape and nothing that can become markup.
      expect(result.body).toBe(raw);
    }
  });

  it("T09 isMeaningfulTermsBody distinguishes invisible-only content", () => {
    expect(isMeaningfulTermsBody("الف")).toBe(true);
    expect(isMeaningfulTermsBody(" \n‌ ")).toBe(false);
  });
});

describe.runIf(hasDb)("versioned terms — document lifecycle (§2, §9)", () => {
  beforeEach(resetTermsState);
  afterAll(async () => {
    await resetTermsState();
    await prisma.$disconnect();
  });

  it("T10 publishing the first document assigns version 1", async () => {
    const { version } = await publish("نسخه اول قوانین");
    expect(version).toBe(1);
  });

  it("T11 versions are monotonic across publications", async () => {
    await publish("یک");
    await publish("دو");
    const third = await publish("سه");
    expect(third.version).toBe(3);
  });

  it("T12 publishing archives the previous published document", async () => {
    const first = await publish("یک");
    await publish("دو");
    const old = await prisma.termsDocument.findUnique({ where: { id: first.id } });
    expect(old?.status).toBe(TermsDocumentStatus.ARCHIVED);
    // Archived, NOT rewritten: the exact body users accepted is still readable.
    expect(old?.body).toBe("یک");
    expect(old?.version).toBe(1);
  });

  it("T13 exactly one document is PUBLISHED at any time", async () => {
    await publish("یک");
    await publish("دو");
    await publish("سه");
    const published = await prisma.termsDocument.count({
      where: { status: TermsDocumentStatus.PUBLISHED },
    });
    expect(published).toBe(1);
  });

  it("T14 a new draft is SEEDED from the current published body", async () => {
    await publish("متن منتشرشده");
    const draft = await createTermsDraft(null);
    expect(draft.ok).toBe(true);
    if (draft.ok) expect(draft.draft.body).toBe("متن منتشرشده");
  });

  it("T15 refuses to create a second draft", async () => {
    await createTermsDraft(null);
    const second = await createTermsDraft(null);
    expect(second).toEqual({ ok: false, code: "DRAFT_EXISTS" });
  });

  it("T16 editing a draft does not change what users see", async () => {
    const { id } = await publish("متن منتشرشده");
    const draft = await createTermsDraft(null);
    if (!draft.ok) throw new Error("draft failed");
    await updateTermsDraftBody(draft.draft.id, "متن پیش‌نویس تازه");

    const live = await getPublishedTerms();
    expect(live?.id).toBe(id);
    expect(live?.body).toBe("متن منتشرشده");
  });

  it("T17 a published document is never modified in place", async () => {
    const { id } = await publish("اصل");
    // The update path filters on status: aiming it at a published id is a no-op.
    const result = await updateTermsDraftBody(id, "دستکاری‌شده");
    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    const row = await prisma.termsDocument.findUnique({ where: { id } });
    expect(row?.body).toBe("اصل");
  });

  it("T18 a published document cannot be deleted through the draft path", async () => {
    const { id } = await publish("اصل");
    expect(await deleteTermsDraft(id)).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await prisma.termsDocument.findUnique({ where: { id } })).not.toBeNull();
  });

  it("T19 an ARCHIVED document cannot be deleted through the draft path", async () => {
    const first = await publish("یک");
    await publish("دو");
    expect(await deleteTermsDraft(first.id)).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await prisma.termsDocument.findUnique({ where: { id: first.id } })).not.toBeNull();
  });

  it("T20 deleting a draft removes it and leaves the published version alone", async () => {
    const { id } = await publish("منتشرشده");
    const draft = await createTermsDraft(null);
    if (!draft.ok) throw new Error("draft failed");
    expect(await deleteTermsDraft(draft.draft.id)).toEqual({ ok: true });
    expect(await getDraftTerms()).toBeNull();
    expect((await getPublishedTerms())?.id).toBe(id);
  });

  it("T21 publishing an empty draft is refused", async () => {
    const draft = await createTermsDraft(null);
    if (!draft.ok) throw new Error("draft failed");
    // A draft seeded from nothing has an empty body; publishing it would make an
    // unsatisfiable blank screen mandatory.
    expect(await publishTermsDraft(draft.draft.id, null)).toEqual({ ok: false, code: "EMPTY" });
  });

  it("T22 publishing an unknown/deleted draft publishes nothing", async () => {
    const draft = await createTermsDraft(null);
    if (!draft.ok) throw new Error("draft failed");
    await updateTermsDraftBody(draft.draft.id, "متن");
    await deleteTermsDraft(draft.draft.id);
    expect(await publishTermsDraft(draft.draft.id, null)).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await getPublishedTerms()).toBeNull();
  });

  it("T23 the content hash is recorded and matches the stored body", async () => {
    const { id } = await publish("متن قابل بررسی");
    const row = await prisma.termsDocument.findUnique({ where: { id } });
    expect(row?.contentHash).toBe(termsContentHash("متن قابل بررسی"));
  });

  it("T24 short-id resolution returns null for unknown and ambiguous prefixes", async () => {
    const { id } = await publish("متن");
    expect((await resolveTermsDocumentByShortId(id.slice(0, 8)))?.id).toBe(id);
    expect(await resolveTermsDocumentByShortId("ffffffff")).toBeNull();
    // Malformed input never reaches the database.
    expect(await resolveTermsDocumentByShortId("../../etc")).toBeNull();
    expect(await resolveTermsDocumentByShortId("")).toBeNull();
  });

  it("T25 version history is paginated in the database, newest first", async () => {
    for (let i = 1; i <= 5; i += 1) await publish(`نسخه ${i}`);
    const page = await listTermsVersionsPage(0, 2);
    expect(page.total).toBe(5);
    expect(page.rows.map((r) => r.version)).toEqual([5, 4]);
    const second = await listTermsVersionsPage(2, 2);
    expect(second.rows.map((r) => r.version)).toEqual([3, 2]);
  });
});

describe.runIf(hasDb)("versioned terms — acceptance (§3, §6, §10)", () => {
  beforeEach(resetTermsState);
  afterAll(async () => {
    await resetTermsState();
    await prisma.$disconnect();
  });

  it("T26 accepting records the exact version and stamps the legacy timestamp", async () => {
    const { id, version } = await publish("قوانین");
    const userId = await makeUser();

    const result = await recordTermsAcceptance(userId, id);
    expect(result).toMatchObject({ ok: true, version, alreadyAccepted: false });

    const row = await prisma.termsAcceptance.findUnique({
      where: { userId_termsDocumentId: { userId, termsDocumentId: id } },
    });
    expect(row?.termsVersion).toBe(version);
    expect(row?.source).toBe("BOT");
    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user?.termsAcceptedAt).not.toBeNull();
  });

  it("T27 accepting twice is idempotent and never rewrites history", async () => {
    const { id } = await publish("قوانین");
    const userId = await makeUser();

    await recordTermsAcceptance(userId, id);
    const first = await prisma.termsAcceptance.findFirstOrThrow({ where: { userId } });

    const second = await recordTermsAcceptance(userId, id);
    expect(second).toMatchObject({ ok: true, alreadyAccepted: true });

    const rows = await prisma.termsAcceptance.findMany({ where: { userId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].acceptedAt.getTime()).toBe(first.acceptedAt.getTime());
  });

  it("T28 accepting an ARCHIVED version accepts nothing (stale button)", async () => {
    const first = await publish("نسخه یک");
    await publish("نسخه دو");
    const userId = await makeUser();

    expect(await recordTermsAcceptance(userId, first.id)).toEqual({ ok: false, code: "STALE" });
    expect(await prisma.termsAcceptance.count({ where: { userId } })).toBe(0);
  });

  it("T29 accepting a non-existent document id accepts nothing", async () => {
    await publish("قوانین");
    const userId = await makeUser();
    const result = await recordTermsAcceptance(userId, "00000000-0000-0000-0000-000000000000");
    expect(result).toEqual({ ok: false, code: "STALE" });
    expect(await prisma.termsAcceptance.count({ where: { userId } })).toBe(0);
  });

  it("T30 accepting with nothing published accepts nothing", async () => {
    const userId = await makeUser();
    const result = await recordTermsAcceptance(userId, "00000000-0000-0000-0000-000000000000");
    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
  });

  it("T31 acceptance history survives publishing a new version", async () => {
    const first = await publish("نسخه یک");
    const userId = await makeUser();
    await recordTermsAcceptance(userId, first.id);

    const second = await publish("نسخه دو");

    // The old acceptance is intact...
    expect(await hasAcceptedTermsDocument(userId, first.id)).toBe(true);
    // ...and it does NOT satisfy the new version.
    expect(await hasAcceptedTermsDocument(userId, second.id)).toBe(false);
  });

  it("T32 acceptance touches no balance, order, referral or role field", async () => {
    const { id } = await publish("قوانین");
    const userId = await makeUser();
    await prisma.user.update({
      where: { id: userId },
      data: { balanceToman: 12_345, forceJoinBypass: true, ordersCount: 7, referralCount: 3 },
    });
    const before = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

    await recordTermsAcceptance(userId, id);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.balanceToman).toBe(before.balanceToman);
    expect(after.forceJoinBypass).toBe(before.forceJoinBypass);
    expect(after.ordersCount).toBe(before.ordersCount);
    expect(after.referralCount).toBe(before.referralCount);
    expect(after.status).toBe(before.status);
    expect(after.group).toBe(before.group);
    // Only the terms timestamp moved.
    expect(after.termsAcceptedAt).not.toBeNull();
  });

  it("T33b accepting after the user row was deleted fails safely, recording nothing", async () => {
    const { id } = await publish("قوانین");
    const userId = await makeUser();
    // The terms page was rendered, then the account was deleted.
    await prisma.user.delete({ where: { id: userId } });

    // The foreign key refuses the orphan acceptance; the caller sees a thrown
    // error (the handler turns it into the generic message) and NOTHING lands.
    await expect(recordTermsAcceptance(userId, id)).rejects.toThrow();
    expect(await prisma.termsAcceptance.count({ where: { userId } })).toBe(0);
    // The published document is untouched and still usable by everyone else.
    expect((await getPublishedTerms())?.id).toBe(id);
  });

  it("T33 acceptance stats are aggregates over ACTIVE users only", async () => {
    const { id } = await publish("قوانین");
    const baselineActive = await activeUserCount();

    const a = await makeUser();
    await makeUser();
    const blocked = await makeUser("BLOCKED");

    await recordTermsAcceptance(a, id);
    await recordTermsAcceptance(blocked, id);

    const stats = await getTermsAcceptanceStats(id);
    // Only `a` counts as accepted: the BLOCKED user's acceptance is excluded
    // from both sides, and the second active user is still pending.
    expect(stats.accepted).toBe(1);
    expect(stats.pending).toBe(baselineActive + 2 - 1);
  });
});

describe.runIf(hasDb)("versioned terms — enable/disable safety (§7)", () => {
  beforeEach(resetTermsState);
  afterAll(async () => {
    await resetTermsState();
    await prisma.$disconnect();
  });

  it("T34 enabling with no published document is refused", async () => {
    expect(await enableTermsRequirement()).toEqual({ ok: false, code: "NO_PUBLISHED_DOCUMENT" });
    expect(await getBooleanSetting(TERMS_REQUIRED_KEY, false)).toBe(false);
  });

  it("T35 enabling with only a DRAFT is refused", async () => {
    const draft = await createTermsDraft(null);
    if (!draft.ok) throw new Error("draft failed");
    await updateTermsDraftBody(draft.draft.id, "متن پیش‌نویس");
    expect(await enableTermsRequirement()).toEqual({ ok: false, code: "NO_PUBLISHED_DOCUMENT" });
    expect(await getBooleanSetting(TERMS_REQUIRED_KEY, false)).toBe(false);
  });

  it("T36 enabling with a published document succeeds", async () => {
    await publish("قوانین");
    expect(await enableTermsRequirement()).toEqual({ ok: true });
    clearSettingsCache();
    expect(await getBooleanSetting(TERMS_REQUIRED_KEY, false)).toBe(true);
  });

  it("T37 disabling preserves documents and acceptance history", async () => {
    const { id } = await publish("قوانین");
    const userId = await makeUser();
    await recordTermsAcceptance(userId, id);
    await enableTermsRequirement();

    await disableTermsRequirement();

    clearSettingsCache();
    expect(await getBooleanSetting(TERMS_REQUIRED_KEY, false)).toBe(false);
    expect((await getPublishedTerms())?.id).toBe(id);
    expect(await hasAcceptedTermsDocument(userId, id)).toBe(true);
  });

  it("T38 re-enabling the SAME version does not require re-acceptance", async () => {
    const { id } = await publish("قوانین");
    const userId = await makeUser();
    await recordTermsAcceptance(userId, id);

    await enableTermsRequirement();
    await disableTermsRequirement();
    await enableTermsRequirement();

    expect(await hasAcceptedTermsDocument(userId, id)).toBe(true);
  });

  it("T39 publishing a NEW version requires re-acceptance from everyone", async () => {
    const first = await publish("نسخه یک");
    const a = await makeUser();
    const b = await makeUser();
    await recordTermsAcceptance(a, first.id);
    await recordTermsAcceptance(b, first.id);
    await enableTermsRequirement();

    const second = await publish("نسخه دو");

    expect(await hasAcceptedTermsDocument(a, second.id)).toBe(false);
    expect(await hasAcceptedTermsDocument(b, second.id)).toBe(false);
    const stats = await getTermsAcceptanceStats(second.id);
    // Nobody has accepted the new version, so every ACTIVE user is pending.
    expect(stats.accepted).toBe(0);
    expect(stats.pending).toBe(await activeUserCount());
  });
});

describe.runIf(hasDb)("versioned terms — legacy bootstrap (§11)", () => {
  beforeEach(resetTermsState);
  afterAll(async () => {
    await resetTermsState();
    await prisma.$disconnect();
  });

  it("T40 does nothing when no legacy terms text exists", async () => {
    expect(await bootstrapLegacyTermsDocument()).toEqual({
      ok: true,
      created: false,
      reason: "NO_LEGACY_TEXT",
    });
    expect(await prisma.termsDocument.count()).toBe(0);
  });

  it("T41 does nothing when the legacy text is only whitespace", async () => {
    await prisma.messageTemplate.create({
      data: {
        key: "terms_text",
        title: "متن قوانین",
        category: "general",
        defaultContent: "x",
        currentContent: "   \n\u200b ",
      },
    });
    expect(await bootstrapLegacyTermsDocument()).toMatchObject({ created: false });
    expect(await prisma.termsDocument.count()).toBe(0);
  });

  it("T42 creates version 1 and backfills existing acceptances with original timestamps", async () => {
    const acceptedAt = new Date("2026-01-15T10:20:30.000Z");
    const accepted = await prisma.user.create({
      data: { telegramId: nextTelegramId(), status: "ACTIVE", termsAcceptedAt: acceptedAt },
    });
    const never = await makeUser();

    await prisma.messageTemplate.create({
      data: {
        key: "terms_text",
        title: "متن قوانین",
        category: "general",
        defaultContent: "x",
        currentContent: "قوانین قدیمی سرویس",
      },
    });

    const result = await bootstrapLegacyTermsDocument();
    expect(result).toMatchObject({ ok: true, created: true });

    const published = await getPublishedTerms();
    expect(published?.version).toBe(1);
    expect(published?.body).toBe("قوانین قدیمی سرویس");

    // The previously-accepting user is NOT asked to accept again, and keeps
    // their original timestamp.
    const row = await prisma.termsAcceptance.findFirstOrThrow({ where: { userId: accepted.id } });
    expect(row.acceptedAt.getTime()).toBe(acceptedAt.getTime());
    expect(row.source).toBe("MIGRATION");
    expect(await hasAcceptedTermsDocument(accepted.id, published?.id ?? "")).toBe(true);
    // Someone who never accepted still has to.
    expect(await hasAcceptedTermsDocument(never, published?.id ?? "")).toBe(false);
  });

  it("T43 is idempotent — a second run creates nothing", async () => {
    await prisma.messageTemplate.create({
      data: {
        key: "terms_text",
        title: "متن قوانین",
        category: "general",
        defaultContent: "x",
        currentContent: "قوانین قدیمی",
      },
    });
    await bootstrapLegacyTermsDocument();
    const again = await bootstrapLegacyTermsDocument();
    expect(again).toEqual({ ok: true, created: false, reason: "DOCUMENT_EXISTS" });
    expect(await prisma.termsDocument.count()).toBe(1);
  });
});
