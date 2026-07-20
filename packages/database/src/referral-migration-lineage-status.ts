import { prisma } from "./client.js";
import {
  classifyReferralMigrationChecksum,
  REFERRAL_AFFILIATE_MIGRATION_NAME,
  type ReferralMigrationChecksumClass,
} from "./migration-checksum.js";
import {
  countCurrentlyFailedOrStuckMigrations,
  readMigrationAttemptState,
} from "./migration-attempts.js";
import { checkReferralSchemaPostconditions, evaluateReferralMigrationLineage } from "./migration-lineage.js";

// =============================================================================
// Referral migration LINEAGE STATUS — an OWNER/operator-only DIAGNOSTIC command.
// Run standalone via scripts/referral-migration-lineage-status.sh. It shows the
// selected migration attempt + status, the checksum classification, every schema
// postcondition, the exact unique-index ownership/column result, current unresolved
// migration failures, historical rolled-back attempts (separately), and the final
// activation verdict.
//
// GUARANTEES: read-only (moves no money, modifies no rows or migration metadata);
// prints NO credentials / DATABASE_URL and NO order / user / commission ids or row
// contents. The checksums it prints are SHA-256 of a public migration file (not secrets).
// =============================================================================

const EXIT_OK = 0;
const EXIT_ERROR = 2;

/** @deprecated retained for back-compat; prefer classifyReferralMigrationChecksum. */
export type ReferralMigrationClassification = ReferralMigrationChecksumClass;

/** @deprecated prefer classifyReferralMigrationChecksum from migration-checksum.ts. */
export function classifyRecordedChecksum(recorded: string | null): ReferralMigrationChecksumClass {
  return classifyReferralMigrationChecksum(recorded);
}

export async function printReferralMigrationLineageStatus(
  out: (line: string) => void = (l) => console.log(l),
): Promise<number> {
  const attemptState = await readMigrationAttemptState(REFERRAL_AFFILIATE_MIGRATION_NAME);
  const recordedChecksum = attemptState.latestSuccessful?.checksum ?? null;
  // Reuse the authoritative recorded checksum (avoids a second _prisma_migrations read).
  const lineage = await evaluateReferralMigrationLineage(undefined, recordedChecksum);
  const classification = classifyReferralMigrationChecksum(recordedChecksum);
  const postconditions = await checkReferralSchemaPostconditions();
  const currentlyFailed = await countCurrentlyFailedOrStuckMigrations();

  // The FINAL verdict mirrors the real activation gate: the referral lineage must allow
  // activation AND there must be NO currently failed/stuck migration anywhere (which the
  // gate enforces via checkMigrationsHealthy). Historical rolled-back attempts alone do
  // NOT block. A valid lineage while an unrelated migration is stuck is still BLOCKED.
  const finalActivationAllowed = lineage.activationAllowed && currentlyFailed === 0;

  out("referral-migration-lineage-status:");
  out(`  migration:                ${REFERRAL_AFFILIATE_MIGRATION_NAME}`);

  out("  --- referral migration lineage ---");
  out(`  selected attempt:         ${attemptState.status}`);
  out(
    `  latest successful attempt: ${
      attemptState.latestSuccessful === null ? "(none)" : "present (finished, not rolled back)"
    }`,
  );
  out(`  lineage status:           ${lineage.status}`);
  out(`  checksum classification:  ${classification}`);
  out(
    `  lineage activation:       ${lineage.activationAllowed ? "ALLOWED" : "BLOCKED"}${
      lineage.legacyVariant ? " (compatible legacy — non-blocking warning)" : ""
    }`,
  );
  out(`  detail:                   ${lineage.detail}`);
  out(`  recorded checksum:        ${recordedChecksum ?? "(no successful attempt)"}`);
  out(`  on-disk checksum:         ${lineage.onDiskChecksum ?? "(migration file missing)"}`);

  out("  --- referral schema postconditions ---");
  for (const p of postconditions.postconditions) {
    out(`    ${p.ok ? "OK  " : "FAIL"}  ${p.key}`);
  }
  out(`  schema postconditions overall: ${postconditions.ok ? "OK" : "FAILED"}`);

  const iv = postconditions.indexVerification;
  out("  unique-index verification (ReferralCommission.orderId):");
  if (iv === null) {
    out("    (table absent — index not verifiable)");
  } else {
    out(`    exists:                 ${iv.exists ? "yes" : "no"}`);
    out(`    belongs to ReferralCommission (OID): ${iv.belongsToReferralCommission ? "yes" : "no"}`);
    out(`    same schema:            ${iv.sameSchema ? "yes" : "no"}`);
    out(`    unique / valid / ready: ${iv.isUnique ? "y" : "n"} / ${iv.isValid ? "y" : "n"} / ${iv.isReady ? "y" : "n"}`);
    out(`    no predicate / no expr: ${iv.noPredicate ? "y" : "n"} / ${iv.noExpression ? "y" : "n"}`);
    out(`    single key column == orderId: ${iv.singleKeyColumn && iv.targetsOrderId ? "yes" : "no"}`);
    out(`    verdict:                ${iv.ok ? "OK" : "FAILED"} (${iv.detail})`);
  }

  out("  --- migration attempt health ---");
  out(`  current unresolved migration failures: ${currentlyFailed}`);
  out(`  historical rolled-back attempts:       ${attemptState.historicalRolledBackCount}`);

  out("  --- final verdict ---");
  out(
    `  FINAL ACTIVATION VERDICT: ${finalActivationAllowed ? "ALLOWED" : "BLOCKED"} ` +
      `(lineage ${lineage.activationAllowed ? "ALLOWED" : "BLOCKED"} AND ${currentlyFailed} live migration failure(s))`,
  );
  return EXIT_OK;
}

async function main(): Promise<number> {
  try {
    return await printReferralMigrationLineageStatus();
  } catch (err) {
    // Never print a connection string — only the diagnostic class of the failure.
    console.error(
      `referral-migration-lineage-status: ERROR — ${err instanceof Error ? err.message : "unknown error"}`,
    );
    return EXIT_ERROR;
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" && process.argv[1].endsWith("referral-migration-lineage-status.js");
if (invokedDirectly) {
  void main().then((code) => process.exit(code));
}
