import { readFileSync } from "node:fs";

import { prisma, TermsDocumentStatus } from "@zedbot/database";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import {
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

/**
 * Users created by THIS file, tracked by id. Cleanup deletes exactly these
 * rows: a telegramId-range delete would also hit users created by other
 * suites in the shared test database, and those may own Orders whose
 * foreign key then refuses the delete.
 */
const createdUserIds: string[] = [];

async function makeUser(status: "ACTIVE" | "BLOCKED" = "ACTIVE"): Promise<string> {
  const row = await prisma.user.create({ data: { telegramId: nextTelegramId(), status } });
  createdUserIds.push(row.id);
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
  // Enforcement is switched ON here because that is the only world in which
  // an acceptance is meaningful: recordTermsAcceptance refuses to write once
  // the master switch is off (a keyboard rendered before it was disabled).
  await enableTermsRequirement();
  return { id: published.document.id, version: published.document.version ?? -1 };
}

async function resetTermsState(): Promise<void> {
  await prisma.termsAcceptance.deleteMany({});
  await prisma.termsDocument.deleteMany({});
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
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

  it("T25a records NOTHING once enforcement has been switched off", async () => {
    // The keyboard was rendered while terms were required; the OWNER disabled
    // them before the user pressed it. Nothing is owed, so nothing may be
    // written — not the acceptance row, not the legacy timestamp.
    const { id } = await publish("قوانین");
    await enableTermsRequirement();
    const userId = await makeUser();
    await disableTermsRequirement();

    const result = await recordTermsAcceptance(userId, id);

    expect(result).toEqual({ ok: false, code: "DISABLED" });
    expect(await prisma.termsAcceptance.count({ where: { userId } })).toBe(0);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).termsAcceptedAt).
      toBeNull();
  });

  it("T25b a duplicate acceptance leaves the transaction usable (ON CONFLICT, not a caught 23505)", async () => {
    // A raised unique violation would ABORT the transaction, so the legacy
    // timestamp written after it could never commit. Proving the write lands is
    // proving the insert used ON CONFLICT DO NOTHING rather than a caught error.
    const { id } = await publish("قوانین");
    await enableTermsRequirement();
    const userId = await makeUser();

    await recordTermsAcceptance(userId, id);
    // Clear the legacy stamp so the second call has something to write.
    await prisma.user.update({ where: { id: userId }, data: { termsAcceptedAt: null } });

    const second = await recordTermsAcceptance(userId, id);

    expect(second).toMatchObject({ ok: true, alreadyAccepted: true });
    expect(await prisma.termsAcceptance.count({ where: { userId } })).toBe(1);
    // The post-insert statement committed — impossible in an aborted transaction.
    expect((await prisma.user.findUniqueOrThrow({ where: { id: userId } })).termsAcceptedAt).
      not.toBeNull();
  });

  it("T25c honours every truthy setting representation, not just the literal 'true'", async () => {
    // getBooleanSetting accepts "true"/"1"/"yes" case-insensitively, so the gate
    // considers an install storing "1" ENABLED. If this path disagreed it would
    // refuse to record, the gate would re-show the same screen, and the user
    // could never get past it.
    const { id } = await publish("قوانین");
    const userId = await makeUser();

    for (const raw of ["1", "yes", "TRUE", "True"]) {
      await prisma.termsAcceptance.deleteMany({ where: { userId } });
      await prisma.setting.update({ where: { key: TERMS_REQUIRED_KEY }, data: { value: raw } });
      clearSettingsCache();

      const result = await recordTermsAcceptance(userId, id);

      expect(result, `value ${raw} must be treated as enabled`).toMatchObject({ ok: true });
    }
  });

  it("T25d never moves the legacy timestamp backwards", async () => {
    // Two acceptances can interleave without the configuration lock; the older
    // one resuming last must not drag `termsAcceptedAt` back in time.
    const { id } = await publish("قوانین");
    const userId = await makeUser();
    await recordTermsAcceptance(userId, id);

    const future = new Date(Date.now() + 60_000);
    await prisma.user.update({ where: { id: userId }, data: { termsAcceptedAt: future } });
    await prisma.termsAcceptance.deleteMany({ where: { userId } });

    await recordTermsAcceptance(userId, id);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(after.termsAcceptedAt?.getTime()).toBe(future.getTime());
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
    // Enforcement ON but the published document gone — the misconfiguration the
    // gate steps aside for. Publishing first is what makes enabling legal; the
    // document is then removed to reach the state under test.
    const { id } = await publish("قوانین");
    const userId = await makeUser();
    await prisma.termsDocument.delete({ where: { id } });

    const result = await recordTermsAcceptance(userId, id);

    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(await prisma.termsAcceptance.count({ where: { userId } })).toBe(0);
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

  it("T33c stats are a single snapshot and exclude non-active users", async () => {
    const { id } = await publish("قوانین");
    const baseline = await activeUserCount();
    const blocked = await makeUser("BLOCKED");
    await recordTermsAcceptance(blocked, id);

    const stats = await getTermsAcceptanceStats(id);
    // A BLOCKED user's acceptance counts on neither side.
    expect(stats.accepted).toBe(0);
    expect(stats.pending).toBe(baseline);
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


// =============================================================================
// The 20260727130000 repair migration, executed as the real file (§11).
//
// The bootstrap in 20260727120000 copied the legacy body VERBATIM. This
// migration repairs that — but version 1 already carries backfilled acceptance
// rows, so it must never be rewritten: an acceptance that keeps pointing at a
// changed body would claim the user accepted wording they never saw. A body
// needing repair is therefore ARCHIVED and the clean text published as a NEW
// version, and text that would have to be CUT is never republished at all.
// =============================================================================

const REPAIR_MIGRATION_SQL = readFileSync(
  new URL(
    "../../../packages/database/prisma/migrations/20260727130000_normalize_bootstrapped_terms_body/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

/** Writes a bootstrapped-looking published version 1 (no admin author). */
async function seedBootstrappedV1(body: string): Promise<string> {
  const row = await prisma.termsDocument.create({
    data: {
      version: 1,
      body,
      status: TermsDocumentStatus.PUBLISHED,
      contentHash: termsContentHash(body),
      publishedAt: new Date(),
    },
  });
  return row.id;
}

async function runRepairMigration(): Promise<void> {
  await prisma.$executeRawUnsafe(REPAIR_MIGRATION_SQL);
}

describe.runIf(hasDb)("versioned terms — bootstrap repair migration (§11)", () => {
  beforeEach(resetTermsState);
  afterAll(async () => {
    await resetTermsState();
    await prisma.$disconnect();
  });

  it("M1 archives the dirty version 1 and publishes the cleaned text as a new version", async () => {
    const dirty = `‮قوانین‌استفاده\nخط دوم\tتب`;
    const v1 = await seedBootstrappedV1(dirty);

    await runRepairMigration();

    const original = await prisma.termsDocument.findUniqueOrThrow({ where: { id: v1 } });
    expect(original.status).toBe(TermsDocumentStatus.ARCHIVED);
    // Byte-for-byte untouched: this is what the acceptance rows refer to.
    expect(original.body).toBe(dirty);

    const published = await getPublishedTerms();
    expect(published?.version).toBe(2);
    expect(published?.body).toBe("قوانین‌استفاده\nخط دوم\tتب");
    expect(published?.contentHash).toBe(termsContentHash(published?.body ?? ""));
    // ZWNJ survives — it is a Persian letter, not formatting.
    expect(published?.body).toContain("‌");
  });

  it("M2 leaves NOTHING published when the body is only invisible characters", async () => {
    // btrim() alone strips spaces but not tabs or newlines, so the emptiness
    // test has to ignore all whitespace or this body survives as a blank screen.
    const v1 = await seedBootstrappedV1("\t‮\n");

    await runRepairMigration();

    expect((await prisma.termsDocument.findUniqueOrThrow({ where: { id: v1 } })).status).toBe(
      TermsDocumentStatus.ARCHIVED,
    );
    expect(await getPublishedTerms()).toBeNull();
  });

  it("M3 refuses to republish a body it would have to truncate", async () => {
    const v1 = await seedBootstrappedV1(`‮${"پ".repeat(4000)}`);

    await runRepairMigration();

    expect((await prisma.termsDocument.findUniqueOrThrow({ where: { id: v1 } })).status).toBe(
      TermsDocumentStatus.ARCHIVED,
    );
    // Cutting terms of service and demanding acceptance of the remainder would
    // drop real clauses; publishing nothing is the honest outcome.
    expect(await getPublishedTerms()).toBeNull();
    expect(await prisma.termsDocument.count()).toBe(1);
  });

  it("M4 leaves an already-clean version 1 completely alone", async () => {
    const clean = "قوانین‌تمیز";
    const v1 = await seedBootstrappedV1(clean);
    const before = await prisma.termsDocument.findUniqueOrThrow({ where: { id: v1 } });

    await runRepairMigration();

    const after = await prisma.termsDocument.findUniqueOrThrow({ where: { id: v1 } });
    expect(after.status).toBe(TermsDocumentStatus.PUBLISHED);
    expect(after.body).toBe(clean);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await prisma.termsDocument.count()).toBe(1);
  });

  it("M5 preserves every existing acceptance, still pointing at version 1", async () => {
    const v1 = await seedBootstrappedV1(`‮متن قانونی`);
    const userId = await makeUser();
    await prisma.termsAcceptance.create({
      data: { userId, termsDocumentId: v1, termsVersion: 1, source: "MIGRATION" },
    });

    await runRepairMigration();

    const acceptance = await prisma.termsAcceptance.findUniqueOrThrow({
      where: { userId_termsDocumentId: { userId, termsDocumentId: v1 } },
    });
    expect(acceptance.termsVersion).toBe(1);
    // The document it refers to still holds exactly the text that was accepted.
    expect((await prisma.termsDocument.findUniqueOrThrow({ where: { id: v1 } })).body).toBe(
      "‮متن قانونی",
    );
    // ...and the user now owes an acceptance of the republished version.
    const published = await getPublishedTerms();
    expect(published?.version).toBe(2);
    expect(await hasAcceptedTermsDocument(userId, published?.id ?? "")).toBe(false);
  });

  it("M7 archives an already-clean body that is over the limit", async () => {
    // The body needs no normalization, so the "unchanged" fast path used to
    // return early and leave it published. The screen refuses to render a
    // document it cannot show in full, so that left every user gated with no
    // button to press — the length check has to come first.
    const v1 = await seedBootstrappedV1("ن".repeat(4000));

    await runRepairMigration();

    expect((await prisma.termsDocument.findUniqueOrThrow({ where: { id: v1 } })).status).toBe(
      TermsDocumentStatus.ARCHIVED,
    );
    expect(await getPublishedTerms()).toBeNull();
  });

  it("M8 measures the limit in UTF-16 code units, as the application does", async () => {
    // 2,100 emoji are 2,100 characters to PostgreSQL's length() but 4,200 to
    // JavaScript's .length — over the limit the bot actually enforces.
    const emoji = "😀".repeat(2100);
    expect(emoji.length).toBe(4200);
    const v1 = await seedBootstrappedV1(`‮${emoji}`);

    await runRepairMigration();

    expect((await prisma.termsDocument.findUniqueOrThrow({ where: { id: v1 } })).status).toBe(
      TermsDocumentStatus.ARCHIVED,
    );
    expect(await getPublishedTerms()).toBeNull();
  });

  it("M9 treats a joiner-only body as blank", async () => {
    // The RLO is what let this past the original bootstrap's emptiness test.
    // Once stripped, only an invisible ZWNJ remains — which the application
    // does not consider meaningful either.
    const v1 = await seedBootstrappedV1("‮‌");

    await runRepairMigration();

    expect(isMeaningfulTermsBody("‌")).toBe(false);
    expect((await prisma.termsDocument.findUniqueOrThrow({ where: { id: v1 } })).status).toBe(
      TermsDocumentStatus.ARCHIVED,
    );
    expect(await getPublishedTerms()).toBeNull();
  });

  it("M10 folds a lone carriage return to a newline instead of deleting it", async () => {
    // Stripping CR as a control character would run two clauses together.
    await seedBootstrappedV1("‮بند الف\rبند ب");

    await runRepairMigration();

    const published = await getPublishedTerms();
    expect(published?.body).toBe("بند الف\nبند ب");
    expect(published?.body).toBe(normalizeTermsBody("‮بند الف\rبند ب"));
  });

  it("M6 is idempotent — running it twice changes nothing further", async () => {
    await seedBootstrappedV1(`‮قوانین`);

    await runRepairMigration();
    const afterFirst = await prisma.termsDocument.findMany({ orderBy: { createdAt: "asc" } });
    await runRepairMigration();
    const afterSecond = await prisma.termsDocument.findMany({ orderBy: { createdAt: "asc" } });

    expect(afterSecond).toHaveLength(afterFirst.length);
    expect(afterSecond.map((d) => `${d.version}:${d.status}:${d.body}`)).toEqual(
      afterFirst.map((d) => `${d.version}:${d.status}:${d.body}`),
    );
  });
});
