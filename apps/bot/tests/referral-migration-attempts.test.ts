import {
  classifyMigrationAttempt,
  countCurrentlyFailedOrStuckMigrations,
  prisma,
  readLatestMigrationAttempt,
  readLatestSuccessfulMigrationAttempt,
  readMigrationAttemptState,
  type MigrationAttempt,
} from "@zedbot/database";
import { afterAll, afterEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "referral-migration-attempts-tests-secret-0123456789";

// =============================================================================
// §1/§5 — deterministic migration-ATTEMPT lifecycle. Prisma keeps every attempt of a
// migration forever, so the state must be derived from the FULL ordered history: an
// older success preceding a newer rollback is NOT applied. States:
//   NOT_APPLIED / CURRENTLY_FAILED / ROLLED_BACK_NOT_REAPPLIED / APPLIED.
// These tests insert synthetic `_prisma_migrations` rows for isolated fake migration
// names and clean them up; they never touch a real migration row.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const d = hasDb ? describe : describe.skip;

const FAKE = "29990101000000_attempt_helper_test";
const OTHER = "29990102000000_attempt_helper_other";

let idSeq = 0;
async function insertAttempt(opts: {
  name?: string;
  startedAt: string;
  finishedAt?: string | null;
  rolledBackAt?: string | null;
  checksum?: string;
}): Promise<void> {
  idSeq += 1;
  await prisma.$executeRawUnsafe(
    `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, rolled_back_at, applied_steps_count)
     VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6::timestamptz, 1)`,
    `attempt-test-${idSeq}-${opts.startedAt}`,
    opts.checksum ?? `checksum-${idSeq}`,
    opts.name ?? FAKE,
    opts.startedAt,
    opts.finishedAt ?? null,
    opts.rolledBackAt ?? null,
  );
}
async function clearFakes(): Promise<void> {
  await prisma.$executeRawUnsafe(`DELETE FROM _prisma_migrations WHERE migration_name IN ($1, $2)`, FAKE, OTHER);
}

// Pure builder for classifyMigrationAttempt unit tests.
function A(startedAt: string, finishedAt: string | null, rolledBackAt: string | null, checksum = "c"): MigrationAttempt {
  return {
    migrationName: FAKE,
    checksum,
    startedAt: new Date(startedAt),
    finishedAt: finishedAt ? new Date(finishedAt) : null,
    rolledBackAt: rolledBackAt ? new Date(rolledBackAt) : null,
  };
}

describe("classifyMigrationAttempt lifecycle (§1, pure)", () => {
  it("no attempts → NOT_APPLIED", () => {
    expect(classifyMigrationAttempt([])).toBe("NOT_APPLIED");
  });
  it("a stuck latest attempt → CURRENTLY_FAILED", () => {
    expect(classifyMigrationAttempt([A("2026-01-01", null, null)])).toBe("CURRENTLY_FAILED");
  });
  it("a rolled-back attempt with no success → ROLLED_BACK_NOT_REAPPLIED", () => {
    expect(classifyMigrationAttempt([A("2026-01-01", null, "2026-01-01T01:00")])).toBe("ROLLED_BACK_NOT_REAPPLIED");
  });
  it("a single successful attempt → APPLIED", () => {
    expect(classifyMigrationAttempt([A("2026-01-01", "2026-01-01T00:01", null)])).toBe("APPLIED");
  });
  it("rollback THEN a later success → APPLIED", () => {
    expect(
      classifyMigrationAttempt([A("2026-01-01", null, "2026-01-01T01:00"), A("2026-01-02", "2026-01-02T00:01", null)]),
    ).toBe("APPLIED");
  });
  it("success THEN a later rollback → ROLLED_BACK_NOT_REAPPLIED (older success is NOT proof)", () => {
    expect(
      classifyMigrationAttempt([A("2026-01-01", "2026-01-01T00:01", null), A("2026-01-02", null, "2026-01-02T01:00")]),
    ).toBe("ROLLED_BACK_NOT_REAPPLIED");
  });
  it("is order-independent in its input", () => {
    expect(
      classifyMigrationAttempt([A("2026-01-02", null, "2026-01-02T01:00"), A("2026-01-01", "2026-01-01T00:01", null)]),
    ).toBe("ROLLED_BACK_NOT_REAPPLIED");
  });
  it("a currently-stuck latest attempt wins even over an older success", () => {
    expect(
      classifyMigrationAttempt([A("2026-01-01", "2026-01-01T00:01", null), A("2026-01-02", null, null)]),
    ).toBe("CURRENTLY_FAILED");
  });
});

d("migration-attempt state helpers (§1/§5, real PG)", () => {
  afterEach(async () => {
    await clearFakes();
  });
  afterAll(async () => {
    await clearFakes();
    await prisma.$disconnect();
  });

  it("one successful attempt → APPLIED with currentChecksum", async () => {
    await insertAttempt({ startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", checksum: "aaa" });
    const state = await readMigrationAttemptState(FAKE);
    expect(state.status).toBe("APPLIED");
    expect(state.currentChecksum).toBe("aaa");
    expect(state.latestSuccessful?.checksum).toBe("aaa");
    expect(state.rolledBackCount).toBe(0);
    expect((await readLatestSuccessfulMigrationAttempt(FAKE))?.checksum).toBe("aaa");
  });

  it("a failed attempt with no resolve → CURRENTLY_FAILED (currentChecksum null, live failure)", async () => {
    const before = await countCurrentlyFailedOrStuckMigrations();
    await insertAttempt({ startedAt: "2026-01-01T00:00:00Z", finishedAt: null, rolledBackAt: null });
    const state = await readMigrationAttemptState(FAKE);
    expect(state.status).toBe("CURRENTLY_FAILED");
    expect(state.currentChecksum).toBeNull();
    expect(await countCurrentlyFailedOrStuckMigrations()).toBe(before + 1);
  });

  it("a failed attempt marked rolled back, never reapplied → ROLLED_BACK_NOT_REAPPLIED (not a live failure)", async () => {
    const before = await countCurrentlyFailedOrStuckMigrations();
    await insertAttempt({ startedAt: "2026-01-01T00:00:00Z", finishedAt: null, rolledBackAt: "2026-01-01T00:05:00Z" });
    const state = await readMigrationAttemptState(FAKE);
    expect(state.status).toBe("ROLLED_BACK_NOT_REAPPLIED");
    expect(state.currentChecksum).toBeNull();
    expect(state.rolledBackCount).toBe(1);
    // A rolled-back-not-reapplied migration is NOT counted as currently failed/stuck.
    expect(await countCurrentlyFailedOrStuckMigrations()).toBe(before);
  });

  it("rolled-back attempt followed by a later successful reapplication → APPLIED with the NEW checksum", async () => {
    await insertAttempt({ startedAt: "2026-01-01T00:00:00Z", finishedAt: null, rolledBackAt: "2026-01-01T00:05:00Z", checksum: "old" });
    await insertAttempt({ startedAt: "2026-01-02T00:00:00Z", finishedAt: "2026-01-02T00:00:01Z", checksum: "new" });
    const state = await readMigrationAttemptState(FAKE);
    expect(state.status).toBe("APPLIED");
    expect(state.currentChecksum).toBe("new");
    expect(state.rolledBackCount).toBe(1);
    expect((await readLatestMigrationAttempt(FAKE))?.checksum).toBe("new");
  });

  it("a success FOLLOWED BY a later rollback → ROLLED_BACK_NOT_REAPPLIED (currentChecksum null)", async () => {
    await insertAttempt({ startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", checksum: "gone" });
    await insertAttempt({ startedAt: "2026-01-02T00:00:00Z", finishedAt: null, rolledBackAt: "2026-01-02T00:05:00Z" });
    const state = await readMigrationAttemptState(FAKE);
    expect(state.status).toBe("ROLLED_BACK_NOT_REAPPLIED");
    // The since-rolled-back success is NOT the current checksum.
    expect(state.currentChecksum).toBeNull();
  });

  it("an unrelated rolled-back-not-reapplied migration does not affect this one's state", async () => {
    await insertAttempt({ name: OTHER, startedAt: "2026-01-01T00:00:00Z", finishedAt: null, rolledBackAt: "2026-01-01T00:05:00Z" });
    await insertAttempt({ startedAt: "2026-01-02T00:00:00Z", finishedAt: "2026-01-02T00:00:01Z", checksum: "ok" });
    expect((await readMigrationAttemptState(FAKE)).status).toBe("APPLIED");
    expect((await readMigrationAttemptState(OTHER)).status).toBe("ROLLED_BACK_NOT_REAPPLIED");
  });

  it("NOT_APPLIED when no attempt row exists", async () => {
    expect((await readMigrationAttemptState(FAKE)).status).toBe("NOT_APPLIED");
    expect(await readLatestSuccessfulMigrationAttempt(FAKE)).toBeNull();
    expect(await readLatestMigrationAttempt(FAKE)).toBeNull();
  });
});
