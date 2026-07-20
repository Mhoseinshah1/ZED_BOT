import {
  classifyMigrationAttempt,
  countCurrentlyFailedOrStuckMigrations,
  prisma,
  readLatestMigrationAttempt,
  readLatestSuccessfulMigrationAttempt,
  readMigrationAttemptState,
} from "@zedbot/database";
import { afterAll, afterEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "referral-migration-attempts-tests-secret-0123456789";

// =============================================================================
// §2 — deterministic migration-ATTEMPT selection. Prisma keeps every attempt of a
// migration forever (failed / rolled-back rows included), so the helpers must pick the
// latest SUCCESSFUL attempt and never let a historical rollback block. These tests
// insert synthetic `_prisma_migrations` rows for isolated fake migration names and
// clean them up; they never touch a real migration row.
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

d("migration-attempt selection helpers (§2)", () => {
  afterEach(async () => {
    await clearFakes();
  });
  afterAll(async () => {
    await clearFakes();
    await prisma.$disconnect();
  });

  it("one successful attempt → APPLIED with its checksum", async () => {
    await insertAttempt({ startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", checksum: "aaa" });
    const state = await readMigrationAttemptState(FAKE);
    expect(state.status).toBe("APPLIED");
    expect(state.latestSuccessful?.checksum).toBe("aaa");
    expect((await readLatestSuccessfulMigrationAttempt(FAKE))?.checksum).toBe("aaa");
    expect(state.historicalRolledBackCount).toBe(0);
  });

  it("one unresolved failed attempt → CURRENTLY_FAILED and counts as a live failure", async () => {
    const before = await countCurrentlyFailedOrStuckMigrations();
    await insertAttempt({ startedAt: "2026-01-01T00:00:00Z", finishedAt: null, rolledBackAt: null });
    const state = await readMigrationAttemptState(FAKE);
    expect(state.status).toBe("CURRENTLY_FAILED");
    expect(state.latestSuccessful).toBeNull();
    expect(await countCurrentlyFailedOrStuckMigrations()).toBe(before + 1);
  });

  it("a failed attempt later marked rolled back → HISTORICALLY_ROLLED_BACK, not a live failure", async () => {
    const before = await countCurrentlyFailedOrStuckMigrations();
    await insertAttempt({ startedAt: "2026-01-01T00:00:00Z", finishedAt: null, rolledBackAt: "2026-01-01T00:05:00Z" });
    const state = await readMigrationAttemptState(FAKE);
    expect(state.status).toBe("HISTORICALLY_ROLLED_BACK");
    expect(state.historicalRolledBackCount).toBe(1);
    // A rolled-back row is NOT a currently-failed/stuck migration.
    expect(await countCurrentlyFailedOrStuckMigrations()).toBe(before);
  });

  it("rolled-back attempt followed by a successful reapplication → APPLIED with the NEW checksum", async () => {
    await insertAttempt({ startedAt: "2026-01-01T00:00:00Z", finishedAt: null, rolledBackAt: "2026-01-01T00:05:00Z", checksum: "old" });
    await insertAttempt({ startedAt: "2026-01-02T00:00:00Z", finishedAt: "2026-01-02T00:00:01Z", checksum: "new" });
    const state = await readMigrationAttemptState(FAKE);
    expect(state.status).toBe("APPLIED");
    expect(state.latestSuccessful?.checksum).toBe("new");
    expect(state.latest?.checksum).toBe("new");
    expect(state.historicalRolledBackCount).toBe(1);
    expect((await readLatestMigrationAttempt(FAKE))?.checksum).toBe("new");
  });

  it("multiple successful/failed attempts → the LATEST successful checksum wins (deterministic)", async () => {
    await insertAttempt({ startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:00:01Z", checksum: "s1" });
    await insertAttempt({ startedAt: "2026-01-03T00:00:00Z", finishedAt: null, rolledBackAt: "2026-01-03T01:00:00Z", checksum: "f-rb" });
    await insertAttempt({ startedAt: "2026-01-02T00:00:00Z", finishedAt: "2026-01-02T00:00:01Z", checksum: "s2" });
    // Latest SUCCESSFUL by started_at is s2 (2026-01-02), even though a later-started
    // rolled-back attempt exists (2026-01-03).
    const state = await readMigrationAttemptState(FAKE);
    expect(state.latestSuccessful?.checksum).toBe("s2");
    expect(state.status).toBe("APPLIED");
    expect((await readLatestSuccessfulMigrationAttempt(FAKE))?.checksum).toBe("s2");
  });

  it("an unrelated historical rollback in ANOTHER migration does not affect this one", async () => {
    const before = await countCurrentlyFailedOrStuckMigrations();
    await insertAttempt({ name: OTHER, startedAt: "2026-01-01T00:00:00Z", finishedAt: null, rolledBackAt: "2026-01-01T00:05:00Z" });
    await insertAttempt({ startedAt: "2026-01-02T00:00:00Z", finishedAt: "2026-01-02T00:00:01Z", checksum: "ok" });
    expect((await readMigrationAttemptState(FAKE)).status).toBe("APPLIED");
    expect((await readMigrationAttemptState(OTHER)).status).toBe("HISTORICALLY_ROLLED_BACK");
    // Neither is a currently-failed migration.
    expect(await countCurrentlyFailedOrStuckMigrations()).toBe(before);
  });

  it("latest successful checksum selection ignores older successful rows", async () => {
    await insertAttempt({ startedAt: "2025-06-01T00:00:00Z", finishedAt: "2025-06-01T00:00:01Z", checksum: "older" });
    await insertAttempt({ startedAt: "2026-06-01T00:00:00Z", finishedAt: "2026-06-01T00:00:01Z", checksum: "newer" });
    expect((await readLatestSuccessfulMigrationAttempt(FAKE))?.checksum).toBe("newer");
  });

  it("NOT_APPLIED when no attempt row exists", async () => {
    expect((await readMigrationAttemptState(FAKE)).status).toBe("NOT_APPLIED");
    expect(await readLatestSuccessfulMigrationAttempt(FAKE)).toBeNull();
    expect(await readLatestMigrationAttempt(FAKE)).toBeNull();
  });

  it("classifyMigrationAttempt is a pure function of latest + latestSuccessful", () => {
    const mk = (finishedAt: Date | null, rolledBackAt: Date | null) => ({
      migrationName: FAKE,
      checksum: "c",
      startedAt: new Date("2026-01-01T00:00:00Z"),
      finishedAt,
      rolledBackAt,
    });
    const ok = mk(new Date(), null);
    const stuck = mk(null, null);
    const rb = mk(null, new Date());
    expect(classifyMigrationAttempt(null, null)).toBe("NOT_APPLIED");
    expect(classifyMigrationAttempt(stuck, null)).toBe("CURRENTLY_FAILED");
    expect(classifyMigrationAttempt(ok, ok)).toBe("APPLIED");
    expect(classifyMigrationAttempt(rb, null)).toBe("HISTORICALLY_ROLLED_BACK");
    // A live failure wins even if an older success exists.
    expect(classifyMigrationAttempt(stuck, ok)).toBe("CURRENTLY_FAILED");
  });
});
