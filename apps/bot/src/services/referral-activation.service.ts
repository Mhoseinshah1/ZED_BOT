import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";

import {
  REFERRAL_AFFILIATE_MIGRATION_NAME,
  evaluateReferralMigrationLineage,
  prisma,
  readPrismaMigrationChecksum,
  resolveMigrationsDir,
} from "@zedbot/database";
import {
  REFERRAL_PAYOUT_WINDOWS_KEY,
  parseReferralPayoutWindowsStrict,
} from "@zedbot/shared";

import {
  pingOpsRedis,
  readReferralExecuteHeartbeat,
  readWorkerHeartbeat,
} from "./ops-queue.service.js";
import { enableReferralPayouts } from "./referral.service.js";
import { getSetting } from "./settings.service.js";

// =============================================================================
// Referral ACTIVATION INTEGRITY GATE (§6). Before the OWNER can switch payouts ON,
// the system must be provably healthy end-to-end — otherwise a commission could be
// paid but never durably credited, or an unresolved data-integrity problem could
// be papered over. Every check is a READ (counts / heartbeats / checksums only —
// never a user, order or wallet id), so the gate is side-effect free. DISABLING is
// NEVER gated (a kill switch must always work). When the gate passes, the ATOMIC
// enable (horizon + payout window + master switch in one transaction) runs.
// =============================================================================

/** A heartbeat is "fresh" when refreshed within this many seconds (TTL is 45s). */
const HEARTBEAT_FRESH_SECONDS = 90;

export interface ReferralActivationCheck {
  /** Stable machine key (safe to log / test against). */
  key: string;
  /** Persian label shown to the OWNER. */
  label: string;
  ok: boolean;
  /** Short, id-free reason when the check fails (null when ok). */
  detail: string | null;
}

/** The migration-history dimension the OWNER activation page renders (§9). */
export type ReferralMigrationHistoryStatus =
  | "HEALTHY"
  | "KNOWN_COMPATIBLE_LEGACY_VARIANT"
  | "CHECKSUM_DRIFT"
  | "FILE_MISSING"
  | "SCHEMA_POSTCONDITION_FAILED";

export interface ReferralMigrationHistory {
  status: ReferralMigrationHistoryStatus;
  /** True for CHECKSUM_DRIFT / FILE_MISSING / SCHEMA_POSTCONDITION_FAILED (blocks activation). */
  blocking: boolean;
  /** True ONLY for KNOWN_COMPATIBLE_LEGACY_VARIANT — the non-blocking OWNER warning. */
  legacyWarning: boolean;
  detail: string | null;
}

export interface ReferralActivationReadiness {
  /** True only when EVERY check passed. */
  ready: boolean;
  checks: ReferralActivationCheck[];
  /** The migration-history dimension broken out for the OWNER UI (§9). */
  migrationHistory: ReferralMigrationHistory;
}

function check(key: string, label: string, ok: boolean, detail: string | null = null): ReferralActivationCheck {
  return { key, label, ok, detail: ok ? null : detail };
}

/** Migrations are healthy when none are pending / rolled back and at least one applied. */
async function checkMigrationsHealthy(): Promise<ReferralActivationCheck> {
  const label = "مهاجرت‌های پایگاه‌داده سالم";
  try {
    const rows = await prisma.$queryRaw<Array<{ pending: bigint; failed: bigint; total: bigint }>>`
      SELECT
        count(*) FILTER (WHERE finished_at IS NULL AND rolled_back_at IS NULL)::bigint AS pending,
        count(*) FILTER (WHERE rolled_back_at IS NOT NULL)::bigint AS failed,
        count(*)::bigint AS total
      FROM _prisma_migrations`;
    const pending = Number(rows[0]?.pending ?? 0n);
    const failed = Number(rows[0]?.failed ?? 0n);
    const total = Number(rows[0]?.total ?? 0n);
    if (total === 0) return check("migrations-healthy", label, false, "no migrations applied");
    if (pending > 0) return check("migrations-healthy", label, false, `${pending} pending`);
    if (failed > 0) return check("migrations-healthy", label, false, `${failed} rolled back`);
    return check("migrations-healthy", label, true);
  } catch {
    return check("migrations-healthy", label, false, "migrations table unreadable");
  }
}

/**
 * Immutable migration-history check WITH dual-lineage awareness (§3). Every APPLIED
 * migration's on-disk SHA-256 must equal its recorded checksum — EXCEPT the one known
 * referral migration (`20260719180000`), which additionally accepts the exact known
 * PR #110 checksum (after every schema postcondition passes). Any other mismatch is
 * CHECKSUM_DRIFT and blocks. Returns a typed migration-history status for the UI.
 */
async function evaluateMigrationHistory(): Promise<{ check: ReferralActivationCheck; history: ReferralMigrationHistory }> {
  const label = "تاریخچه مهاجرت";
  const build = (status: ReferralMigrationHistoryStatus, detail: string | null): { check: ReferralActivationCheck; history: ReferralMigrationHistory } => {
    const blocking = status === "CHECKSUM_DRIFT" || status === "FILE_MISSING" || status === "SCHEMA_POSTCONDITION_FAILED";
    const legacyWarning = status === "KNOWN_COMPATIBLE_LEGACY_VARIANT";
    return {
      check: check("migration-history-immutable", label, !blocking, blocking ? detail : null),
      history: { status, blocking, legacyWarning, detail },
    };
  };

  const dir = resolveMigrationsDir();
  if (dir === null) return build("FILE_MISSING", "migrations dir not found");
  try {
    const applied = await prisma.$queryRaw<Array<{ migration_name: string; checksum: string; finished_at: Date | null }>>`
      SELECT migration_name, checksum, finished_at FROM _prisma_migrations WHERE rolled_back_at IS NULL`;
    let legacyWarning = false;
    for (const row of applied) {
      if (row.finished_at === null) continue; // still applying — covered by migrations-healthy

      if (row.migration_name === REFERRAL_AFFILIATE_MIGRATION_NAME) {
        // The one migration with two known historical byte forms — evaluate lineage.
        const lineage = await evaluateReferralMigrationLineage(dir);
        if (lineage.status === "EXACT_MATCH") continue;
        if (lineage.status === "KNOWN_COMPATIBLE_LEGACY_VARIANT") {
          legacyWarning = true;
          continue;
        }
        // FILE_MISSING / SCHEMA_POSTCONDITION_FAILED / CHECKSUM_DRIFT all block.
        return build(lineage.status, lineage.detail);
      }

      // Ordinary migration: strict exact match against the recorded checksum.
      const file = resolvePath(dir, row.migration_name, "migration.sql");
      if (!existsSync(file)) return build("FILE_MISSING", `missing file for ${row.migration_name}`);
      if (readPrismaMigrationChecksum(file) !== row.checksum) {
        return build("CHECKSUM_DRIFT", `checksum drift in ${row.migration_name}`);
      }
    }
    return legacyWarning
      ? build("KNOWN_COMPATIBLE_LEGACY_VARIANT", "known compatible PR#110 lineage")
      : build("HEALTHY", null);
  } catch {
    return build("CHECKSUM_DRIFT", "history unreadable");
  }
}

/** The referral worker (which runs the reconciliation scans) is alive recently. */
async function checkWorkerHeartbeat(): Promise<ReferralActivationCheck> {
  const label = "پردازش‌گر زیرمجموعه فعال";
  const hb = await readWorkerHeartbeat();
  const fresh = hb !== null && hb.ageSeconds !== null && hb.ageSeconds <= HEARTBEAT_FRESH_SECONDS;
  return check("worker-heartbeat-fresh", label, fresh, hb === null ? "no heartbeat" : "stale heartbeat");
}

/** The control queue (Redis) is reachable. */
async function checkControlQueueReachable(): Promise<ReferralActivationCheck> {
  const label = "صف کنترل در دسترس";
  const ping = await pingOpsRedis();
  return check("control-queue-reachable", label, ping.ok, "redis unreachable");
}

/** The bot execute consumer (which performs the wallet mutations) is alive recently. */
async function checkExecuteConsumerHeartbeat(): Promise<ReferralActivationCheck> {
  const label = "مصرف‌کننده اجرا فعال";
  const hb = await readReferralExecuteHeartbeat();
  const fresh = hb !== null && hb.ageSeconds !== null && hb.ageSeconds <= HEARTBEAT_FRESH_SECONDS;
  return check("execute-consumer-heartbeat-fresh", label, fresh, hb === null ? "no heartbeat" : "stale heartbeat");
}

/** The referral clawback ledger accounting is within bounds (never over-collected). */
async function checkWalletLedgerHealthy(): Promise<ReferralActivationCheck> {
  const label = "دفتر کیف‌پول سالم";
  try {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM "ReferralCommission"
      WHERE "recoveredToman" < 0
         OR "recoveryOutstandingToman" < 0
         OR "recoveredToman" > "amountToman"`;
    const bad = Number(rows[0]?.n ?? 0n);
    return check("wallet-ledger-healthy", label, bad === 0, `${bad} out-of-bounds rows`);
  } catch {
    return check("wallet-ledger-healthy", label, false, "ledger unreadable");
  }
}

/** The payout windows parse to a VALID (non-corrupt) state. */
async function checkPayoutWindowsValid(): Promise<ReferralActivationCheck> {
  const label = "بازه‌های پرداخت معتبر";
  const parsed = parseReferralPayoutWindowsStrict(await getSetting(REFERRAL_PAYOUT_WINDOWS_KEY, ""));
  return check("payout-windows-valid", label, parsed.valid, parsed.issues.join(","));
}

/** No User.referrerId disagrees with its Referral.referrerUserId (attribution intact). */
async function checkNoAttributionMismatch(): Promise<ReferralActivationCheck> {
  const label = "بدون مغایرت انتساب";
  try {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n
      FROM "Referral" r
      JOIN "User" u ON u.id = r."referredUserId"
      WHERE u."referrerId" IS NOT NULL AND u."referrerId" <> r."referrerUserId"`;
    const bad = Number(rows[0]?.n ?? 0n);
    return check("no-attribution-mismatch", label, bad === 0, `${bad} mismatched links`);
  } catch {
    return check("no-attribution-mismatch", label, false, "attribution unreadable");
  }
}

/** No order carries more than one commission row (idempotency invariant holds). */
async function checkNoDuplicateCommissionOrder(): Promise<ReferralActivationCheck> {
  const label = "بدون سفارش کمیسیون تکراری";
  try {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM (
        SELECT "orderId" FROM "ReferralCommission"
        WHERE "orderId" IS NOT NULL
        GROUP BY "orderId"
        HAVING count(*) > 1
      ) d`;
    const bad = Number(rows[0]?.n ?? 0n);
    return check("no-duplicate-commission-order", label, bad === 0, `${bad} duplicate order(s)`);
  } catch {
    return check("no-duplicate-commission-order", label, false, "commissions unreadable");
  }
}

/** No terminal commission row is in an inconsistent financial state. */
async function checkNoUnresolvedIntegrityIssue(): Promise<ReferralActivationCheck> {
  const label = "بدون مشکل یکپارچگی مالی حل‌نشده";
  try {
    const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT count(*)::bigint AS n FROM "ReferralCommission"
      WHERE ("status" = 'REVERSED' AND "recoveryOutstandingToman" <> 0)
         OR ("status" = 'REVERSAL_PENDING' AND "recoveredToman" + "recoveryOutstandingToman" <> "amountToman")
         OR ("status" = 'PAID' AND "amountToman" < 0)`;
    const bad = Number(rows[0]?.n ?? 0n);
    return check("no-unresolved-integrity-issue", label, bad === 0, `${bad} inconsistent row(s)`);
  } catch {
    return check("no-unresolved-integrity-issue", label, false, "integrity unreadable");
  }
}

/**
 * Runs EVERY activation-integrity check (all reads) and returns the verdict. The
 * OWNER can enable payouts only when `ready` is true. Ordered exactly as §6 lists.
 */
export async function assessReferralActivationReadiness(): Promise<ReferralActivationReadiness> {
  const [
    migrationsHealthy,
    migrationHistory,
    workerHeartbeat,
    controlQueue,
    executeConsumer,
    walletLedger,
    payoutWindows,
    attributionMismatch,
    duplicateOrder,
    integrityIssue,
  ] = await Promise.all([
    checkMigrationsHealthy(),
    evaluateMigrationHistory(),
    checkWorkerHeartbeat(),
    checkControlQueueReachable(),
    checkExecuteConsumerHeartbeat(),
    checkWalletLedgerHealthy(),
    checkPayoutWindowsValid(),
    checkNoAttributionMismatch(),
    checkNoDuplicateCommissionOrder(),
    checkNoUnresolvedIntegrityIssue(),
  ]);
  // Order exactly as §6 lists; the migration-history check reflects the dual-lineage
  // verdict (a KNOWN_COMPATIBLE_LEGACY_VARIANT is ok=true, non-blocking).
  const checks = [
    migrationsHealthy,
    migrationHistory.check,
    workerHeartbeat,
    controlQueue,
    executeConsumer,
    walletLedger,
    payoutWindows,
    attributionMismatch,
    duplicateOrder,
    integrityIssue,
  ];
  return { ready: checks.every((c) => c.ok), checks, migrationHistory: migrationHistory.history };
}

/** The migration-history dimension only (cheap — no heartbeat/Redis reads), for the UI. */
export async function getReferralMigrationHistory(): Promise<ReferralMigrationHistory> {
  return (await evaluateMigrationHistory()).history;
}

export type EnableReferralPayoutsResult =
  | { status: "enabled"; flipped: boolean; startedAt: Date; migrationHistory: ReferralMigrationHistory }
  | { status: "blocked"; readiness: ReferralActivationReadiness };

/**
 * GATED enable: the OWNER-facing activation path. Runs the full integrity gate and,
 * only if every check passes, performs the ATOMIC enable (horizon + payout window +
 * master switch in one transaction). If anything is unhealthy it returns the failing
 * checks and changes nothing — payouts stay off. A KNOWN_COMPATIBLE_LEGACY_VARIANT
 * migration history does NOT block (the gate passes) but is surfaced as a non-blocking
 * warning. Disabling is never gated, so this can never trap the OWNER with payouts on.
 */
export async function enableReferralPayoutsGated(now: Date = new Date()): Promise<EnableReferralPayoutsResult> {
  const readiness = await assessReferralActivationReadiness();
  if (!readiness.ready) {
    return { status: "blocked", readiness };
  }
  const { flipped, startedAt } = await enableReferralPayouts(now);
  return { status: "enabled", flipped, startedAt, migrationHistory: readiness.migrationHistory };
}
