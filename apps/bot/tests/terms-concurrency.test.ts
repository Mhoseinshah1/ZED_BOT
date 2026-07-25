import { prisma, TermsDocumentStatus } from "@zedbot/database";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { clearSettingsCache, getBooleanSettingFresh } from "../src/services/settings.service.js";
import {
  createTermsDraft,
  deleteTermsDraft,
  disableTermsRequirement,
  enableTermsRequirement,
  getDraftTerms,
  getPublishedTerms,
  publishTermsDraft,
  recordTermsAcceptance,
  TERMS_REQUIRED_KEY,
  updateTermsDraftBody,
} from "../src/services/terms/terms-document.service.js";

// =============================================================================
// Versioned mandatory terms — REAL CONCURRENCY (§10).
//
// Every case here fires genuinely parallel operations against a real
// PostgreSQL and asserts the invariant that must survive them. These are the
// tests that fail if the terms advisory lock is removed: without it, "read the
// highest version, then write the next one" and "check nothing is published,
// then publish" are both read-modify-write races over row sets that are often
// EMPTY, which no row lock can serialize.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";

const TELEGRAM_ID_BASE = 8_100_000_000_000n;
const RUN_TAG = BigInt(Date.now() % 1_000_000_000);
let seq = 0n;

/**
 * Users created by THIS file, tracked by id. Cleanup deletes exactly these
 * rows: a telegramId-range delete would also hit users created by other
 * suites in the shared test database, and those may own Orders whose
 * foreign key then refuses the delete.
 */
const createdUserIds: string[] = [];

async function makeUser(): Promise<string> {
  seq += 1n;
  const row = await prisma.user.create({
    data: { telegramId: TELEGRAM_ID_BASE + RUN_TAG * 1000n + seq, status: "ACTIVE" },
  });
  createdUserIds.push(row.id);
  return row.id;
}

async function makeDraft(body: string): Promise<string> {
  const draft = await createTermsDraft(null);
  if (!draft.ok) throw new Error(`draft failed: ${draft.code}`);
  const updated = await updateTermsDraftBody(draft.draft.id, body);
  if (!updated.ok) throw new Error(`body failed: ${updated.code}`);
  return updated.draft.id;
}

async function publish(body: string): Promise<string> {
  const id = await makeDraft(body);
  const result = await publishTermsDraft(id, null);
  if (!result.ok) throw new Error(`publish failed: ${result.code}`);
  return result.document.id;
}

/** Creates N drafts directly, bypassing the one-draft-at-a-time service guard. */
async function seedRawDrafts(count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const row = await prisma.termsDocument.create({
      data: { body: `پیش‌نویس ${i}`, status: TermsDocumentStatus.DRAFT },
    });
    ids.push(row.id);
  }
  return ids;
}

async function resetTermsState(): Promise<void> {
  await prisma.termsAcceptance.deleteMany({});
  await prisma.termsDocument.deleteMany({});
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
  await prisma.setting.deleteMany({ where: { key: TERMS_REQUIRED_KEY } });
  clearSettingsCache();
}

async function publishedCount(): Promise<number> {
  return prisma.termsDocument.count({ where: { status: TermsDocumentStatus.PUBLISHED } });
}

describe.runIf(hasDb)("versioned terms — concurrency (§10)", () => {
  beforeEach(resetTermsState);
  afterAll(async () => {
    await resetTermsState();
    await prisma.$disconnect();
  });

  it("C1 two concurrent publishes never mint duplicate versions", async () => {
    await publish("نسخه پایه");
    const [a, b] = await seedRawDrafts(2);

    const results = await Promise.all([publishTermsDraft(a, null), publishTermsDraft(b, null)]);

    // Both may legitimately succeed — they are different drafts — but they must
    // have taken DIFFERENT version numbers and only one may remain published.
    const versions = await prisma.termsDocument.findMany({
      where: { version: { not: null } },
      select: { version: true },
    });
    const numbers = versions.map((v) => v.version);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(await publishedCount()).toBe(1);
    expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
  });

  it("C2 many concurrent publishes still leave exactly one published document", async () => {
    const drafts = await seedRawDrafts(6);
    await Promise.all(drafts.map((id) => publishTermsDraft(id, null)));

    expect(await publishedCount()).toBe(1);
    const withVersion = await prisma.termsDocument.findMany({
      where: { version: { not: null } },
      select: { version: true },
    });
    const numbers = withVersion.map((v) => v.version);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("C3 concurrent draft creation never produces two drafts", async () => {
    const results = await Promise.all([
      createTermsDraft(null),
      createTermsDraft(null),
      createTermsDraft(null),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await prisma.termsDocument.count({ where: { status: TermsDocumentStatus.DRAFT } })).toBe(
      1,
    );
  });

  it("C4 publish racing delete-draft: the draft is either published or deleted, never both", async () => {
    const draftId = await makeDraft("متن");

    const [publishResult, deleteResult] = await Promise.all([
      publishTermsDraft(draftId, null),
      deleteTermsDraft(draftId),
    ]);

    const row = await prisma.termsDocument.findUnique({ where: { id: draftId } });
    if (publishResult.ok) {
      // Published: the row must still exist, published, with a version.
      expect(deleteResult.ok).toBe(false);
      expect(row?.status).toBe(TermsDocumentStatus.PUBLISHED);
      expect(row?.version).not.toBeNull();
    } else {
      // Deleted first: nothing was published.
      expect(deleteResult.ok).toBe(true);
      expect(row).toBeNull();
      expect(await publishedCount()).toBe(0);
    }
  });

  it("C5 enable racing publish never leaves enforcement on with nothing published", async () => {
    const draftId = await makeDraft("متن");

    await Promise.all([enableTermsRequirement(), publishTermsDraft(draftId, null)]);

    clearSettingsCache();
    const enabled = await getBooleanSettingFresh(TERMS_REQUIRED_KEY, false);
    if (enabled) {
      // Enforcement can only be on if a published document existed when the
      // enable transaction committed — and it must still be there.
      expect(await getPublishedTerms()).not.toBeNull();
    }
  });

  it("C6 enable racing delete-draft never enables without a published document", async () => {
    const draftId = await makeDraft("متن");

    await Promise.all([enableTermsRequirement(), deleteTermsDraft(draftId)]);

    clearSettingsCache();
    const enabled = await getBooleanSettingFresh(TERMS_REQUIRED_KEY, false);
    // There was never a published document, so enabling must have been refused.
    expect(enabled).toBe(false);
  });

  it("C7 enable racing disable settles on a state consistent with the documents", async () => {
    await publish("متن");
    await Promise.all([enableTermsRequirement(), disableTermsRequirement()]);
    clearSettingsCache();
    const enabled = await getBooleanSettingFresh(TERMS_REQUIRED_KEY, false);
    if (enabled) {
      expect(await getPublishedTerms()).not.toBeNull();
    }
    // Either way the document survived both transactions.
    expect(await prisma.termsDocument.count()).toBe(1);
  });

  it("C8 acceptance racing publication NEVER marks the new version accepted", async () => {
    const firstId = await publish("نسخه یک");
    const userId = await makeUser();
    const nextDraft = await makeDraft("نسخه دو");

    // The user presses the version-1 button at the exact moment version 2 is
    // published. Whichever order the two transactions commit in, the ONLY thing
    // that must never happen is an acceptance row for version 2.
    const [acceptResult] = await Promise.all([
      recordTermsAcceptance(userId, firstId),
      publishTermsDraft(nextDraft, null),
    ]);

    const secondDoc = await prisma.termsDocument.findUniqueOrThrow({ where: { id: nextDraft } });
    const acceptedSecond = await prisma.termsAcceptance.findUnique({
      where: { userId_termsDocumentId: { userId, termsDocumentId: secondDoc.id } },
    });
    expect(acceptedSecond).toBeNull();

    if (acceptResult.ok) {
      // The acceptance landed first: it is a historically valid version-1 row...
      const row = await prisma.termsAcceptance.findUniqueOrThrow({
        where: { userId_termsDocumentId: { userId, termsDocumentId: firstId } },
      });
      expect(row.termsVersion).toBe(1);
    } else {
      // ...or it was rejected as stale before insertion. Nothing was recorded.
      expect(acceptResult.code).toBe("STALE");
      expect(await prisma.termsAcceptance.count({ where: { userId } })).toBe(0);
    }
    // Either way the user still owes an acceptance of the current version.
    expect(secondDoc.status).toBe(TermsDocumentStatus.PUBLISHED);
  });

  it("C9 concurrent acceptances by the same user create exactly one row", async () => {
    const id = await publish("قوانین");
    const userId = await makeUser();

    const results = await Promise.all([
      recordTermsAcceptance(userId, id),
      recordTermsAcceptance(userId, id),
      recordTermsAcceptance(userId, id),
      recordTermsAcceptance(userId, id),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    expect(await prisma.termsAcceptance.count({ where: { userId } })).toBe(1);
  });

  it("C10 concurrent acceptances by different users all land exactly once", async () => {
    const id = await publish("قوانین");
    const users = await Promise.all([makeUser(), makeUser(), makeUser(), makeUser(), makeUser()]);

    await Promise.all(users.map((u) => recordTermsAcceptance(u, id)));

    expect(await prisma.termsAcceptance.count({ where: { termsDocumentId: id } })).toBe(
      users.length,
    );
  });

  it("C11 edit racing publish never changes a published body", async () => {
    const draftId = await makeDraft("متن اصلی");

    const [publishResult, editResult] = await Promise.all([
      publishTermsDraft(draftId, null),
      updateTermsDraftBody(draftId, "متن دستکاری‌شده"),
    ]);

    const row = await prisma.termsDocument.findUniqueOrThrow({ where: { id: draftId } });

    if (!publishResult.ok) {
      // Publication lost outright - nothing became mandatory.
      expect(row.status).toBe(TermsDocumentStatus.DRAFT);
      return;
    }

    // Editing a draft before it is published is legitimate, so BOTH bodies are
    // valid outcomes here. The invariant is not "the original text wins", it is
    // that whatever body publication FROZE is the body that survives: the stored
    // row must never drift away from what publishTermsDraft returned.
    expect(row.status).toBe(TermsDocumentStatus.PUBLISHED);
    expect(row.body).toBe(publishResult.document.body);
    expect(row.contentHash).toBe(publishResult.document.contentHash);

    if (editResult.ok) {
      // The edit committed while the row was still a draft; publication then
      // froze the edited text and the hash above proves the two agree.
      expect(row.body).toBe("متن دستکاری‌شده");
    } else {
      // The edit arrived after publication and was refused - a published
      // document is not reachable through the draft path (see also T17).
      expect(editResult.code).toBe("NOT_FOUND");
      expect(row.body).toBe("متن اصلی");
    }
  });

  it("C12 a full concurrent storm keeps every invariant", async () => {
    await publish("پایه");
    const drafts = await seedRawDrafts(4);
    const users = await Promise.all([makeUser(), makeUser(), makeUser()]);
    const currentId = (await getPublishedTerms())?.id ?? "";

    await Promise.all([
      ...drafts.map((id) => publishTermsDraft(id, null)),
      ...users.map((u) => recordTermsAcceptance(u, currentId)),
      enableTermsRequirement(),
      createTermsDraft(null),
      disableTermsRequirement(),
    ]);

    // 1. At most one published document.
    expect(await publishedCount()).toBe(1);
    // 2. Versions are unique.
    const versioned = await prisma.termsDocument.findMany({
      where: { version: { not: null } },
      select: { version: true },
    });
    const numbers = versioned.map((v) => v.version);
    expect(new Set(numbers).size).toBe(numbers.length);
    // 3. No user has more than one acceptance per document.
    const acceptances = await prisma.termsAcceptance.findMany({
      select: { userId: true, termsDocumentId: true },
    });
    const keys = acceptances.map((a) => `${a.userId}:${a.termsDocumentId}`);
    expect(new Set(keys).size).toBe(keys.length);
    // 4. Every acceptance points at a document that still exists with that version.
    for (const a of await prisma.termsAcceptance.findMany()) {
      const doc = await prisma.termsDocument.findUnique({ where: { id: a.termsDocumentId } });
      expect(doc).not.toBeNull();
      expect(doc?.version).toBe(a.termsVersion);
    }
    // 5. Enforcement, if on, has something to enforce.
    clearSettingsCache();
    if (await getBooleanSettingFresh(TERMS_REQUIRED_KEY, false)) {
      expect(await getPublishedTerms()).not.toBeNull();
    }
    // 6. At most one draft survived the storm.
    expect(
      await prisma.termsDocument.count({ where: { status: TermsDocumentStatus.DRAFT } }),
    ).toBeLessThanOrEqual(1);
    expect(await getDraftTerms()).toBeDefined();
  });
});
