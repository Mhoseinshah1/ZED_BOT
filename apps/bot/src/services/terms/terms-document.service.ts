import { createHash } from "node:crypto";

import { Prisma, prisma, TermsDocumentStatus, type TermsDocument } from "@zedbot/database";

import { clearSettingCacheKeys } from "../settings.service.js";

// =============================================================================
// Versioned mandatory Terms & Conditions: the document SERVICE.
//
// Owns every read and mutation of TermsDocument / TermsAcceptance plus the
// master-switch guards. Handlers own ZERO DB logic. Three rules define the
// whole module:
//
//   1. A PUBLISHED document is NEVER modified in place. Changing the terms
//      means publishing a NEW version; the previous one is archived, not
//      rewritten, so the exact body a user accepted stays recoverable forever.
//   2. Every configuration mutation runs inside ONE dedicated transaction-level
//      advisory lock, so concurrent publishes/enables/deletes serialize.
//   3. Acceptance is keyed to a DOCUMENT ID, never to "the current terms". A
//      button rendered for version N can only ever produce an acceptance of
//      version N — and if N is no longer published, it produces none at all.
//
// Nothing here stores or logs an IP address, a device fingerprint or a raw
// Telegram update payload; the only per-user datum written is "this user id
// accepted this document id at this time".
// =============================================================================

/** Master enable switch — REUSES the existing Setting, never duplicated. */
export const TERMS_REQUIRED_KEY = "terms_required";

/**
 * ONE dedicated advisory-lock namespace serializing EVERY terms configuration
 * mutation (publish, draft create/edit/delete, enable, disable, acceptance).
 *
 * Row locks cannot do this job: "there is currently no published document" and
 * "there is currently no draft" are statements about an EMPTY row set, and
 * `SELECT … FOR UPDATE` over an empty set locks nothing at all. Two concurrent
 * publishes would both read `maxVersion = 3`, both mint version 4 and both try
 * to become the single current document. A transaction-level advisory lock
 * exists independently of any row and is released automatically at COMMIT or
 * ROLLBACK, so the whole terms configuration behaves as one serialized resource.
 *
 * It is deliberately a DIFFERENT namespace from the force-join lock: the two
 * subsystems are independent and must never block each other.
 */
const TERMS_CONFIG_LOCK = "zedbot-terms-config";

async function lockTermsConfig(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${TERMS_CONFIG_LOCK}))`;
}

// --- body validation (§5, §14) ----------------------------------------------

/**
 * Maximum stored body length. A Telegram text message caps at 4096 UTF-16 code
 * units and the terms screen also renders a title, the version line and an
 * optional publication date, so the body itself is bounded well below that and
 * the rendered screen can never be rejected by Telegram.
 */
export const TERMS_MAX_BODY_LENGTH = 3500;

export type TermsBodyError = "EMPTY" | "TOO_LONG";

/**
 * Normalizes an operator-supplied body: CRLF/CR are folded to LF and control
 * characters other than newline and tab are stripped, so pasted content can
 * never smuggle in bidi overrides, zero-width joiners used as separators, or
 * terminal escapes. The visible text is otherwise preserved verbatim — this
 * normalizes, it does not "clean up" or reformat the operator's wording.
 */
export function normalizeTermsBody(raw: string): string {
  const folded = raw.replace(/\r\n?/g, "\n");
  let cleaned = "";
  for (const ch of folded) {
    const code = ch.codePointAt(0) ?? 0;
    // C0/C1 control characters (newline and tab survive).
    if (code < 0x20 && ch !== "\n" && ch !== "\t") continue;
    if (code >= 0x7f && code <= 0x9f) continue;
    // Bidi overrides/isolates and zero-width formatting characters that make
    // rendered text lie about its own contents. ZWNJ (U+200C) and ZWJ (U+200D)
    // are deliberately KEPT: both are legitimate letters inside Persian words.
    if (code === 0x200b || code === 0x200e || code === 0x200f) continue;
    if (code >= 0x202a && code <= 0x202e) continue;
    if (code >= 0x2066 && code <= 0x2069) continue;
    if (code === 0xfeff) continue;
    cleaned += ch;
  }
  return cleaned.trim();
}

/**
 * True when a body carries actual content. ZWNJ (U+200C) is legitimate inside
 * Persian words, so it is preserved by normalization — but a body consisting of
 * nothing BUT invisible characters is not meaningful content.
 */
export function isMeaningfulTermsBody(body: string): boolean {
  return body.replace(/[\s\u200C\u200D]/g, "").length > 0;
}

export function validateTermsBody(raw: string): { ok: true; body: string } | { ok: false; code: TermsBodyError } {
  const body = normalizeTermsBody(raw);
  if (!isMeaningfulTermsBody(body)) {
    return { ok: false, code: "EMPTY" };
  }
  if (body.length > TERMS_MAX_BODY_LENGTH) {
    return { ok: false, code: "TOO_LONG" };
  }
  return { ok: true, body };
}

/** SHA-256 of the body — an integrity aid that carries no user data. */
export function termsContentHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

// --- reads --------------------------------------------------------------------

/** The single currently-PUBLISHED document, or null when none exists. */
export async function getPublishedTerms(): Promise<TermsDocument | null> {
  return prisma.termsDocument.findFirst({ where: { status: TermsDocumentStatus.PUBLISHED } });
}

/**
 * The current DRAFT, or null. At most one draft exists at a time in practice
 * (the admin UI only ever offers "create" when none exists); the newest wins if
 * an older one somehow survives.
 */
export async function getDraftTerms(): Promise<TermsDocument | null> {
  return prisma.termsDocument.findFirst({
    where: { status: TermsDocumentStatus.DRAFT },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
}

export async function getTermsDocumentById(id: string): Promise<TermsDocument | null> {
  return prisma.termsDocument.findUnique({ where: { id } });
}

/**
 * Resolves the short id carried in callback data (§4). An unknown OR AMBIGUOUS
 * prefix resolves to null — never to "probably this one" — so a truncated or
 * forged identity can only ever produce "this button is stale", not an
 * acceptance of the wrong document.
 */
export async function resolveTermsDocumentByShortId(shortId: string): Promise<TermsDocument | null> {
  if (!/^[0-9a-f-]{4,36}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.termsDocument.findMany({
    where: { id: { startsWith: shortId.toLowerCase() } },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

export interface TermsVersionPage {
  rows: TermsDocument[];
  total: number;
}

/**
 * Version history, newest first, PAGINATED IN THE DATABASE — an install with
 * hundreds of versions must never load them all to render one page.
 */
export async function listTermsVersionsPage(skip: number, take: number): Promise<TermsVersionPage> {
  const where: Prisma.TermsDocumentWhereInput = { version: { not: null } };
  const [rows, total] = await prisma.$transaction([
    prisma.termsDocument.findMany({
      where,
      orderBy: [{ version: "desc" }],
      skip: Math.max(0, skip),
      take: Math.max(1, take),
    }),
    prisma.termsDocument.count({ where }),
  ]);
  return { rows, total };
}

// --- acceptance reads (§13) ---------------------------------------------------

/**
 * Whether this user has accepted THIS document. The gate asks about the
 * currently-published document id, so an acceptance of any older version never
 * satisfies it.
 */
export async function hasAcceptedTermsDocument(userId: string, documentId: string): Promise<boolean> {
  const row = await prisma.termsAcceptance.findUnique({
    where: { userId_termsDocumentId: { userId, termsDocumentId: documentId } },
    select: { id: true },
  });
  return row !== null;
}

export interface TermsAcceptanceStats {
  /** Users who have accepted the current published document. */
  accepted: number;
  /** ACTIVE users who have not — i.e. who will see the terms screen. */
  pending: number;
}

/**
 * DB-backed aggregate counts for the admin overview. Returns COUNTS ONLY: no
 * user id, telegram id, name or acceptance timestamp ever leaves this function,
 * so the overview cannot leak who has or has not accepted.
 */
export async function getTermsAcceptanceStats(documentId: string | null): Promise<TermsAcceptanceStats> {
  if (documentId === null) {
    const activeOnly = await prisma.user.count({ where: { status: "ACTIVE" } });
    return { accepted: 0, pending: activeOnly };
  }
  // ONE statement, deliberately. Wrapping two counts in `$transaction([...])`
  // would NOT have given them one snapshot: at PostgreSQL's default READ
  // COMMITTED isolation every statement takes a fresh snapshot, so a
  // registration or acceptance landing between them could still skew the pair.
  // A single aggregate query is atomic by construction and needs no isolation
  // level to be correct.
  const [row] = await prisma.$queryRaw<{ active: bigint; accepted: bigint }[]>`
    SELECT
      count(*) AS active,
      count(a."id") AS accepted
    FROM "User" u
    LEFT JOIN "TermsAcceptance" a
      ON a."userId" = u."id" AND a."termsDocumentId" = ${documentId}
    WHERE u."status" = 'ACTIVE'
  `;
  const activeUsers = Number(row?.active ?? 0n);
  const accepted = Number(row?.accepted ?? 0n);
  return { accepted, pending: Math.max(0, activeUsers - accepted) };
}

// --- draft lifecycle (§9) -----------------------------------------------------

export type CreateDraftResult =
  | { ok: true; draft: TermsDocument }
  | { ok: false; code: "DRAFT_EXISTS" };

/**
 * Narrower than creation on purpose: editing an existing draft can fail because
 * the row is gone / no longer a draft, or because the body is invalid — never
 * because "a draft already exists". Keeping the unions tight means every caller
 * handles exactly the cases that can actually occur.
 */
export type UpdateDraftResult =
  | { ok: true; draft: TermsDocument }
  | { ok: false; code: "NOT_FOUND" | TermsBodyError };

/**
 * Creates a new draft, SEEDED from the current published body so the operator
 * edits the real current terms instead of starting from a blank page. Refuses
 * to create a second draft.
 */
export async function createTermsDraft(adminId: string | null): Promise<CreateDraftResult> {
  return prisma.$transaction(async (tx) => {
    await lockTermsConfig(tx);
    const existing = await tx.termsDocument.findFirst({ where: { status: TermsDocumentStatus.DRAFT } });
    if (existing !== null) {
      return { ok: false as const, code: "DRAFT_EXISTS" as const };
    }
    const published = await tx.termsDocument.findFirst({
      where: { status: TermsDocumentStatus.PUBLISHED },
    });
    const draft = await tx.termsDocument.create({
      data: {
        body: published?.body ?? "",
        status: TermsDocumentStatus.DRAFT,
        createdByAdminId: adminId,
      },
    });
    return { ok: true as const, draft };
  });
}

/**
 * Replaces a DRAFT's body. Editing a draft is invisible to users by
 * construction: the gate only ever reads the PUBLISHED document, and the
 * `status: DRAFT` filter here means this can never touch a published one.
 */
export async function updateTermsDraftBody(
  draftId: string,
  rawBody: string,
): Promise<UpdateDraftResult> {
  const validated = validateTermsBody(rawBody);
  if (!validated.ok) {
    return { ok: false, code: validated.code };
  }
  return prisma.$transaction(async (tx) => {
    await lockTermsConfig(tx);
    const draft = await tx.termsDocument.findFirst({
      where: { id: draftId, status: TermsDocumentStatus.DRAFT },
    });
    if (draft === null) {
      return { ok: false as const, code: "NOT_FOUND" as const };
    }
    const updated = await tx.termsDocument.update({
      where: { id: draft.id },
      data: { body: validated.body },
    });
    return { ok: true as const, draft: updated };
  });
}

export type DeleteDraftResult = { ok: true } | { ok: false; code: "NOT_FOUND" };

/**
 * Deletes a DRAFT. The `status: DRAFT` filter is the guard that makes deleting
 * a published or archived document impossible from the bot UI — history is
 * never destroyed, only unpublished work is.
 */
export async function deleteTermsDraft(draftId: string): Promise<DeleteDraftResult> {
  return prisma.$transaction(async (tx) => {
    await lockTermsConfig(tx);
    const draft = await tx.termsDocument.findFirst({
      where: { id: draftId, status: TermsDocumentStatus.DRAFT },
    });
    if (draft === null) {
      return { ok: false as const, code: "NOT_FOUND" as const };
    }
    await tx.termsDocument.delete({ where: { id: draft.id } });
    return { ok: true as const };
  });
}

// --- publishing (§2, §10) -----------------------------------------------------

export type PublishResult =
  | { ok: true; document: TermsDocument; previousVersion: number | null }
  | { ok: false; code: "NOT_FOUND" | TermsBodyError };

/**
 * Publishes a draft. In ONE serialized transaction this:
 *   - assigns the next version (max existing version + 1),
 *   - archives the previously published document (never rewriting its body),
 *   - flips the draft to PUBLISHED with its version, hash and timestamps.
 *
 * Because acceptance is keyed to the document id, the act of publishing is
 * exactly what requires every user to accept again — no user row is touched and
 * no acceptance history is deleted.
 */
export async function publishTermsDraft(draftId: string, adminId: string | null): Promise<PublishResult> {
  return prisma.$transaction(async (tx) => {
    await lockTermsConfig(tx);

    const draft = await tx.termsDocument.findFirst({
      where: { id: draftId, status: TermsDocumentStatus.DRAFT },
    });
    if (draft === null) {
      return { ok: false as const, code: "NOT_FOUND" as const };
    }

    // Re-validate at publish time: the draft body could have been stored before
    // a limit change, and an empty document must never become mandatory.
    const validated = validateTermsBody(draft.body);
    if (!validated.ok) {
      return { ok: false as const, code: validated.code };
    }

    const previous = await tx.termsDocument.findFirst({
      where: { status: TermsDocumentStatus.PUBLISHED },
    });
    if (previous !== null) {
      // Archive FIRST: the partial unique index allows only one PUBLISHED row,
      // so the old one must step aside inside this same transaction.
      await tx.termsDocument.update({
        where: { id: previous.id },
        data: { status: TermsDocumentStatus.ARCHIVED },
      });
    }

    const highest = await tx.termsDocument.aggregate({ _max: { version: true } });
    const nextVersion = (highest._max.version ?? 0) + 1;

    const published = await tx.termsDocument.update({
      where: { id: draft.id },
      data: {
        status: TermsDocumentStatus.PUBLISHED,
        version: nextVersion,
        body: validated.body,
        contentHash: termsContentHash(validated.body),
        publishedByAdminId: adminId,
        publishedAt: new Date(),
      },
    });
    return { ok: true as const, document: published, previousVersion: previous?.version ?? null };
  });
}

// --- master switch (§7) -------------------------------------------------------

export type EnableResult = { ok: true } | { ok: false; code: "NO_PUBLISHED_DOCUMENT" };

/**
 * Turns enforcement on — but ONLY when a valid published document exists.
 * Enabling with nothing to show would gate every user behind a blank screen, so
 * the read and the write are serialized together under the lock: a concurrent
 * "delete the draft" or "publish" cannot slip between the check and the write.
 */
export async function enableTermsRequirement(): Promise<EnableResult> {
  const result = await prisma.$transaction(async (tx) => {
    await lockTermsConfig(tx);
    const published = await tx.termsDocument.findFirst({
      where: { status: TermsDocumentStatus.PUBLISHED },
    });
    if (published === null || !isMeaningfulTermsBody(published.body)) {
      return { ok: false as const, code: "NO_PUBLISHED_DOCUMENT" as const };
    }
    await tx.setting.upsert({
      where: { key: TERMS_REQUIRED_KEY },
      update: { value: "true", type: "BOOLEAN" },
      create: { key: TERMS_REQUIRED_KEY, value: "true", type: "BOOLEAN" },
    });
    return { ok: true as const };
  });
  clearSettingCacheKeys([TERMS_REQUIRED_KEY]);
  return result;
}

/**
 * Turns enforcement off. Always allowed and never destructive: documents and
 * acceptance history are untouched, so re-enabling the SAME published version
 * asks nobody to accept again.
 */
export async function disableTermsRequirement(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await lockTermsConfig(tx);
    await tx.setting.upsert({
      where: { key: TERMS_REQUIRED_KEY },
      update: { value: "false", type: "BOOLEAN" },
      create: { key: TERMS_REQUIRED_KEY, value: "false", type: "BOOLEAN" },
    });
  });
  clearSettingCacheKeys([TERMS_REQUIRED_KEY]);
}

// --- acceptance (§3, §6, §10) -------------------------------------------------

export type AcceptResult =
  | { ok: true; version: number; alreadyAccepted: boolean }
  | { ok: false; code: "STALE" | "NOT_FOUND" };

/**
 * Records a user's acceptance of ONE EXACT document.
 *
 * The document id comes from the button the user actually pressed, and this
 * function refuses anything that is not the currently-published document. That
 * is the enforcement point for the core invariant: a user can only accept the
 * exact body that was rendered with that button, and an acceptance racing a
 * publication is rejected BEFORE insertion rather than being silently credited
 * to the new version.
 *
 * Idempotent: pressing the button twice returns the ORIGINAL acceptance
 * untouched — `acceptedAt` is never overwritten and no second row appears.
 * `User.termsAcceptedAt` is updated in the SAME transaction as the acceptance
 * row, so the legacy timestamp and the history can never disagree.
 *
 * It touches NOTHING else: no balance, order, referral, checkout, payment,
 * force-join bypass or role field is written here.
 */
export async function recordTermsAcceptance(
  userId: string,
  documentId: string,
  source = "BOT",
): Promise<AcceptResult> {
  // NOTE: this path deliberately does NOT take the configuration lock.
  //
  // Publishing a new version re-gates the entire user base at once, which is
  // precisely when a burst of acceptances arrives. Serializing all of them on
  // the same lock the OWNER's publish uses would queue every user behind one
  // another while each holds a pooled connection, starving unrelated bot work.
  //
  // The lock is not needed for correctness here. The invariant "never mark the
  // NEW version accepted" is enforced by re-reading the published document
  // inside this transaction and comparing ids: a publish that commits meanwhile
  // can only make this read return the NEW document (so the stale button is
  // rejected) or leave it unchanged (so an acceptance of the OLD document is
  // recorded, which is historically valid and still does not satisfy the gate).
  // Duplicate acceptances are impossible regardless, because of the
  // (userId, termsDocumentId) unique index — handled below.
  return prisma.$transaction(async (tx) => {
    const published = await tx.termsDocument.findFirst({
      where: { status: TermsDocumentStatus.PUBLISHED },
    });
    if (published === null) {
      return { ok: false as const, code: "NOT_FOUND" as const };
    }
    // A button for any other document — an older version, an archived one, a
    // deleted draft, a forged id — accepts nothing at all.
    if (published.id !== documentId || published.version === null) {
      return { ok: false as const, code: "STALE" as const };
    }

    const existing = await tx.termsAcceptance.findUnique({
      where: { userId_termsDocumentId: { userId, termsDocumentId: published.id } },
      select: { id: true },
    });
    if (existing !== null) {
      // Already accepted: history is never rewritten. Still refresh the legacy
      // timestamp only if it is missing, so an old row cannot leave it null.
      await tx.user.updateMany({
        where: { id: userId, termsAcceptedAt: null },
        data: { termsAcceptedAt: new Date() },
      });
      return { ok: true as const, version: published.version, alreadyAccepted: true };
    }

    const acceptedAt = new Date();
    try {
      await tx.termsAcceptance.create({
        data: {
          userId,
          termsDocumentId: published.id,
          termsVersion: published.version,
          acceptedAt,
          source,
        },
      });
    } catch (err) {
      // Two presses landing together: the unique index picks one winner. The
      // loser is an idempotent success, never an error and never a second row.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return { ok: true as const, version: published.version, alreadyAccepted: true };
      }
      throw err;
    }
    await tx.user.update({ where: { id: userId }, data: { termsAcceptedAt: acceptedAt } });
    return { ok: true as const, version: published.version, alreadyAccepted: false };
  });
}

// --- legacy bootstrap (§11) ---------------------------------------------------

export type BootstrapResult =
  | { ok: true; created: false; reason: "DOCUMENT_EXISTS" | "NO_LEGACY_TEXT" }
  | { ok: true; created: true; backfilled: number };

/**
 * Idempotent safety net for the one-time legacy bootstrap that
 * `20260727120000_versioned_mandatory_terms` performs in SQL.
 *
 * The migration covers every ordinary upgrade. This function exists for the
 * installs the migration cannot help: one whose `terms_text` was seeded AFTER
 * the migration ran (a fresh database is migrated before it is seeded), or one
 * restored from a partial backup. It creates published version 1 from the
 * configured legacy text and backfills acceptances for users who had already
 * accepted, carrying their ORIGINAL timestamps — so nobody is asked to accept
 * again. It does nothing at all once any document exists.
 *
 * Returns COUNTS only; the legacy body is never logged or returned.
 */
export async function bootstrapLegacyTermsDocument(): Promise<BootstrapResult> {
  return prisma.$transaction(async (tx) => {
    await lockTermsConfig(tx);

    const anyDocument = await tx.termsDocument.findFirst({ select: { id: true } });
    if (anyDocument !== null) {
      return { ok: true as const, created: false as const, reason: "DOCUMENT_EXISTS" as const };
    }

    const legacy = await tx.messageTemplate.findUnique({ where: { key: "terms_text" } });
    const body = legacy === null ? "" : normalizeTermsBody(legacy.currentContent);
    if (!isMeaningfulTermsBody(body)) {
      return { ok: true as const, created: false as const, reason: "NO_LEGACY_TEXT" as const };
    }

    const document = await tx.termsDocument.create({
      data: {
        version: 1,
        body,
        status: TermsDocumentStatus.PUBLISHED,
        contentHash: termsContentHash(body),
        publishedAt: new Date(),
      },
    });

    const accepted = await tx.user.findMany({
      where: { termsAcceptedAt: { not: null } },
      select: { id: true, termsAcceptedAt: true },
    });
    if (accepted.length > 0) {
      await tx.termsAcceptance.createMany({
        data: accepted.map((u) => ({
          userId: u.id,
          termsDocumentId: document.id,
          termsVersion: 1,
          // Non-null by the query filter; keep their ORIGINAL acceptance time.
          acceptedAt: u.termsAcceptedAt as Date,
          source: "MIGRATION",
        })),
        skipDuplicates: true,
      });
    }
    return { ok: true as const, created: true as const, backfilled: accepted.length };
  });
}
