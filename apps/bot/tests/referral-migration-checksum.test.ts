import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  REFERRAL_AFFILIATE_CURRENT_ONDISK_VARIANT,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ALLOWLIST,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_CRLF,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_LF,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_CRLF,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_LF,
  REFERRAL_AFFILIATE_MIGRATION_NAME,
  classifyReferralMigrationChecksum,
  prisma,
  prismaMigrationChecksum,
  readPrismaMigrationChecksum,
} from "@zedbot/database";
import { afterAll, afterEach, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "referral-migration-checksum-tests-secret-0123456789";

// =============================================================================
// §5/§6 (checksum helper matches Prisma exactly; the four empirically verified LF/CRLF
// variants) + §6 (the migration file is immutable). Prisma 6.19.3 records the SHA-256 of
// the RAW file bytes (NO line-ending normalization — verified empirically). The helper
// must do the same.
// =============================================================================

const MIGRATION_SQL = fileURLToPath(
  new URL(
    `../../../packages/database/prisma/migrations/${REFERRAL_AFFILIATE_MIGRATION_NAME}/migration.sql`,
    import.meta.url,
  ),
);

/** Converts LF bytes to CRLF byte-exactly (each \n → \r\n, preserving trailing-newline presence). */
function toCrlf(buf: Buffer): Buffer {
  return Buffer.from(buf.toString("latin1").replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"), "latin1");
}

describe("prisma migration checksum helper (§6)", () => {
  it("is the lowercase hex SHA-256 of the raw bytes", () => {
    const content = Buffer.from("CREATE TABLE foo (id int);\n", "utf8");
    expect(prismaMigrationChecksum(content)).toBe(createHash("sha256").update(content).digest("hex"));
    expect(prismaMigrationChecksum(content)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does NOT normalize line endings — LF and CRLF differ (matches real Prisma)", () => {
    const lf = "line1\nline2\n";
    const crlf = "line1\r\nline2\r\n";
    expect(prismaMigrationChecksum(lf)).not.toBe(prismaMigrationChecksum(crlf));
    expect(prismaMigrationChecksum(crlf)).toBe(createHash("sha256").update(Buffer.from(crlf, "utf8")).digest("hex"));
  });

  it("distinguishes a trailing newline present vs absent", () => {
    expect(prismaMigrationChecksum("SELECT 1;\n")).not.toBe(prismaMigrationChecksum("SELECT 1;"));
  });

  it("hashes UTF-8 content by its bytes", () => {
    const utf8 = "-- تست یونیکد ✅\nSELECT 1;\n";
    expect(prismaMigrationChecksum(utf8)).toBe(createHash("sha256").update(Buffer.from(utf8, "utf8")).digest("hex"));
    expect(prismaMigrationChecksum(Buffer.from(utf8, "utf8"))).toBe(prismaMigrationChecksum(utf8));
  });
});

describe("the empirically verified historical checksum allowlist (§5)", () => {
  it("contains exactly the four audited LF/CRLF variants", () => {
    expect(Object.keys(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ALLOWLIST).sort()).toEqual([
      "ORIGINAL_CRLF",
      "ORIGINAL_LF",
      "PR110_CRLF",
      "PR110_LF",
    ]);
    const values = Object.values(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ALLOWLIST);
    expect(new Set(values).size).toBe(4);
    for (const v of values) expect(v).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the constants match their audited values and the back-compat aliases", () => {
    expect(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_LF).toBe(
      "eadac0931519795c0f6153c0b275a56506dcd80ec0cea543ac36b082022b1d59",
    );
    expect(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_CRLF).toBe(
      "ae972ad361bd060432a3aa030e0597b91b0bbf4a0bfee2f12e71b0fc27200447",
    );
    expect(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_LF).toBe(
      "9acc8e3b5e2720a1bc1166c08a3ced30a7108f21eee11b654943d07e6a44a970",
    );
    expect(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_CRLF).toBe(
      "00f1687433b4424e632d87b9c4a23741f6b3632ef81c37f0eb5abdb3e6ea5254",
    );
    expect(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL).toBe(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_LF);
    expect(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110).toBe(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_LF);
    expect(REFERRAL_AFFILIATE_CURRENT_ONDISK_VARIANT).toBe("ORIGINAL_LF");
  });

  it("classifyReferralMigrationChecksum maps each variant, plus UNKNOWN and NOT_APPLIED", () => {
    expect(classifyReferralMigrationChecksum(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_LF)).toBe("ORIGINAL_LF");
    expect(classifyReferralMigrationChecksum(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_CRLF)).toBe("ORIGINAL_CRLF");
    expect(classifyReferralMigrationChecksum(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_LF)).toBe("PR110_LF");
    expect(classifyReferralMigrationChecksum(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_CRLF)).toBe("PR110_CRLF");
    expect(classifyReferralMigrationChecksum("f".repeat(64))).toBe("UNKNOWN");
    expect(classifyReferralMigrationChecksum(null)).toBe("NOT_APPLIED");
  });

  it("the on-disk file's CRLF form hashes to the ORIGINAL_CRLF constant (byte-exact)", () => {
    const lf = readFileSync(MIGRATION_SQL);
    expect(prismaMigrationChecksum(toCrlf(lf))).toBe(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_CRLF);
    expect(prismaMigrationChecksum(lf)).toBe(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_LF);
  });
});

describe("referral affiliate migration is immutable (§6)", () => {
  it("the committed file's SHA-256 equals the pinned ORIGINAL_LF checksum (fails on any edit)", () => {
    const onDisk = createHash("sha256").update(readFileSync(MIGRATION_SQL)).digest("hex");
    expect(onDisk).toBe(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_LF);
    expect(onDisk).toBe("eadac0931519795c0f6153c0b275a56506dcd80ec0cea543ac36b082022b1d59");
  });

  it("the file is LF-only (no CRLF) so its raw-byte checksum is stable cross-platform", () => {
    expect(readFileSync(MIGRATION_SQL).includes(Buffer.from("\r\n"))).toBe(false);
  });
});

import {
  classifyRecordedChecksum,
  printReferralMigrationLineageStatus,
} from "../../../packages/database/src/referral-migration-lineage-status.js";

describe("lineage-status classification (§9, pure)", () => {
  it("classifies the recorded checksum through the shared allowlist", () => {
    expect(classifyRecordedChecksum(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_LF)).toBe("ORIGINAL_LF");
    expect(classifyRecordedChecksum(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110_CRLF)).toBe("PR110_CRLF");
    expect(classifyRecordedChecksum("f".repeat(64))).toBe("UNKNOWN");
    expect(classifyRecordedChecksum(null)).toBe("NOT_APPLIED");
  });
});

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
(hasDb ? describe : describe.skip)("checksum helper matches the value Prisma actually recorded (§5)", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("readPrismaMigrationChecksum(on-disk file) == _prisma_migrations.checksum (latest successful)", async () => {
    const rows = await prisma.$queryRaw<Array<{ checksum: string }>>`
      SELECT checksum FROM _prisma_migrations
      WHERE migration_name = ${REFERRAL_AFFILIATE_MIGRATION_NAME}
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY started_at DESC LIMIT 1`;
    expect(rows[0]?.checksum).toBe(readPrismaMigrationChecksum(MIGRATION_SQL));
    expect(rows[0]?.checksum).toBe(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_LF);
  });

  it("the lineage-status command prints an ORIGINAL_LF / EXACT_MATCH verdict with NO ids / credentials", async () => {
    const lines: string[] = [];
    const code = await printReferralMigrationLineageStatus((l) => lines.push(l));
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("checksum classification:  ORIGINAL_LF");
    expect(out).toContain("lineage status:           EXACT_MATCH");
    // §3 — the DB-only command prints a MIGRATION-readiness verdict, never the old
    // "FINAL ACTIVATION VERDICT" (which implied the full Redis/heartbeat/wallet gate had run).
    expect(out).toContain("FINAL MIGRATION READINESS VERDICT: PASSED");
    expect(out).not.toContain("FINAL ACTIVATION VERDICT");
    expect(out).not.toMatch(/postgres(ql)?:\/\//i);
    expect(out).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  });

  it("the command NEVER claims full referral activation is allowed — it defers to the OWNER readiness gate (§3)", async () => {
    const lines: string[] = [];
    await printReferralMigrationLineageStatus((l) => lines.push(l));
    const out = lines.join("\n");
    // Even when every migration check passes, the diagnostic must clearly state that full
    // activation still requires the OWNER readiness gate (Redis, control queue, worker +
    // execute heartbeats, wallet ledger, payout windows, attribution, integrity).
    expect(out).toContain("Full referral activation still requires the OWNER readiness gate");
    expect(out).toContain(
      "(Redis, control queue, worker + execute heartbeats, wallet ledger, payout windows, attribution, integrity).",
    );
    // It must not overclaim by asserting activation is allowed/enabled.
    expect(out).not.toMatch(/activation\s+(is\s+)?(allowed|enabled|ready)/i);
  });
});

// =============================================================================
// §1/§2/§4 — the operator command's FINAL MIGRATION READINESS VERDICT combines the
// referral lineage AND the authoritative deployment state (pending / currently-failed /
// rolled-back-not-reapplied / missing-file all block) AND ordinary-migration immutability.
// A migration that was rolled back and never reapplied now BLOCKS; only a historical
// rollback FOLLOWED BY a later successful reapplication is non-blocking. These tests
// insert synthetic _prisma_migrations rows / rewrite the recorded checksum and restore.
// =============================================================================
(hasDb ? describe : describe.skip)("lineage-status FINAL migration-readiness verdict (§1/§2/§4)", () => {
  async function setReferralRecorded(checksum: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `UPDATE _prisma_migrations SET checksum=$1 WHERE migration_name=$2 AND rolled_back_at IS NULL`,
      checksum,
      REFERRAL_AFFILIATE_MIGRATION_NAME,
    );
  }
  async function cleanup(): Promise<void> {
    await prisma.$executeRawUnsafe(`DELETE FROM _prisma_migrations WHERE id LIKE 'verdict-test-%'`);
    await setReferralRecorded(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_LF);
  }
  async function finalVerdict(): Promise<"PASSED" | "BLOCKED"> {
    const lines: string[] = [];
    await printReferralMigrationLineageStatus((l) => lines.push(l));
    const line = lines.find((l) => l.includes("FINAL MIGRATION READINESS VERDICT:")) ?? "";
    // Parse the verdict token immediately after the label (the line ALSO reports the
    // separate "lineage ALLOWED/BLOCKED" dimension, so a naive substring check is wrong).
    const m = line.match(/FINAL MIGRATION READINESS VERDICT:\s+(PASSED|BLOCKED)/);
    return m?.[1] === "BLOCKED" ? "BLOCKED" : "PASSED";
  }
  async function insertRow(id: string, name: string, finished: boolean, rolledBack: boolean): Promise<void> {
    await prisma.$executeRawUnsafe(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, rolled_back_at, applied_steps_count)
       VALUES ($1, 'x', $2, now(), ${finished ? "now()" : "NULL"}, ${rolledBack ? "now()" : "NULL"}, 0)`,
      id,
      name,
    );
  }

  afterEach(async () => {
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("valid lineage + a fully-applied deployment → PASSED", async () => {
    expect(await finalVerdict()).toBe("PASSED");
  });

  it("valid lineage + one UNRELATED currently-failed/stuck migration → BLOCKED", async () => {
    await insertRow("verdict-test-stuck", "29991230000000_unrelated_stuck", false, false);
    expect(await finalVerdict()).toBe("BLOCKED");
  });

  it("valid lineage + an UNRELATED rolled-back-not-reapplied migration → BLOCKED (§1/§4)", async () => {
    // A migration rolled back and never reapplied is NOT a healthy applied state — it must
    // block, even though no attempt is currently stuck. (Was previously mis-treated as OK.)
    await insertRow("verdict-test-rb", "29991230000000_unrelated_rolledback", false, true);
    expect(await finalVerdict()).toBe("BLOCKED");
  });

  it("valid lineage + a rollback FOLLOWED BY a later successful reapplication → PASSED (non-blocking)", async () => {
    // For a REAL on-disk migration: an OLDER rolled-back attempt plus the existing current
    // success means the migration is currently applied — the historical rollback must NOT block.
    const rows = await prisma.$queryRaw<Array<{ migration_name: string }>>`
      SELECT migration_name FROM _prisma_migrations
      WHERE migration_name <> ${REFERRAL_AFFILIATE_MIGRATION_NAME}
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY started_at ASC LIMIT 1`;
    const target = rows[0];
    expect(target).toBeDefined();
    if (!target) return;
    // started_at in the PAST so the existing successful attempt is strictly newer.
    await prisma.$executeRawUnsafe(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, rolled_back_at, applied_steps_count)
       VALUES ('verdict-test-histrb', 'x', $1, now() - interval '10 years', NULL, now() - interval '10 years', 0)`,
      target.migration_name,
    );
    expect(await finalVerdict()).toBe("PASSED");
  });

  it("invalid lineage + zero live failures → BLOCKED", async () => {
    await setReferralRecorded("f".repeat(64)); // unknown recorded checksum → lineage blocked
    expect(await finalVerdict()).toBe("BLOCKED");
  });

  it("valid lineage + a CURRENTLY failed referral target migration → BLOCKED", async () => {
    // A stuck attempt row for the referral migration itself makes it a live failure.
    await insertRow("verdict-test-ref-stuck", REFERRAL_AFFILIATE_MIGRATION_NAME, false, false);
    expect(await finalVerdict()).toBe("BLOCKED");
  });

  it("valid lineage + an ORDINARY migration with checksum drift → BLOCKED", async () => {
    // Pick any applied non-referral migration and corrupt its RECORDED checksum so the
    // on-disk file no longer matches — the real gate blocks on this, so the verdict must too.
    const rows = await prisma.$queryRaw<Array<{ migration_name: string; checksum: string }>>`
      SELECT migration_name, checksum FROM _prisma_migrations
      WHERE migration_name <> ${REFERRAL_AFFILIATE_MIGRATION_NAME}
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY started_at ASC LIMIT 1`;
    const target = rows[0];
    expect(target).toBeDefined();
    if (!target) return;
    try {
      await prisma.$executeRawUnsafe(
        `UPDATE _prisma_migrations SET checksum='deadbeef' WHERE migration_name=$1 AND rolled_back_at IS NULL`,
        target.migration_name,
      );
      expect(await finalVerdict()).toBe("BLOCKED");
    } finally {
      await prisma.$executeRawUnsafe(
        `UPDATE _prisma_migrations SET checksum=$1 WHERE migration_name=$2 AND rolled_back_at IS NULL`,
        target.checksum,
        target.migration_name,
      );
    }
  });
});
