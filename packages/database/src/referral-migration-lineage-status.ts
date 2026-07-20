import { prisma } from "./client.js";
import {
  classifyReferralMigrationChecksum,
  REFERRAL_AFFILIATE_MIGRATION_NAME,
  type ReferralMigrationChecksumClass,
} from "./migration-checksum.js";
import { readMigrationAttemptState } from "./migration-attempts.js";
import { evaluateMigrationDeploymentState } from "./migration-deployment.js";
import {
  checkOrdinaryMigrationsImmutable,
  checkReferralSchemaPostconditions,
  evaluateReferralMigrationLineage,
} from "./migration-lineage.js";

// =============================================================================
// Referral migration LINEAGE STATUS — an OWNER/operator-only DIAGNOSTIC command.
// Run standalone via scripts/referral-migration-lineage-status.sh. It reports the
// referral migration lineage, the schema postconditions, the exact unique-index
// ownership/column result, and the FULL migration-deployment state (on-disk vs DB),
// then prints a FINAL MIGRATION READINESS VERDICT.
//
// SCOPE: this command checks MIGRATION health only. It does NOT run the full referral
// activation gate (Redis / control queue / worker + execute heartbeats / wallet ledger
// / payout windows / attribution / integrity), so it deliberately never claims that
// full referral activation is allowed — the OWNER readiness gate
// (assessReferralActivationReadiness) remains the authoritative complete verdict.
//
// GUARANTEES: read-only (moves no money, modifies no rows or migration metadata);
// prints NO credentials / DATABASE_URL and NO order / user / commission ids or row
// contents. The values it prints are public migration names and SHA-256 checksums of a
// public migration file, never secrets.
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
  // The referral lineage uses the CURRENT applied checksum (null unless currently applied).
  const lineage = await evaluateReferralMigrationLineage(undefined, attemptState.currentChecksum);
  const classification = classifyReferralMigrationChecksum(attemptState.currentChecksum);
  const postconditions = await checkReferralSchemaPostconditions();
  const deployment = await evaluateMigrationDeploymentState();
  const ordinary = await checkOrdinaryMigrationsImmutable();

  // The verdict is a MIGRATION-READINESS verdict ONLY: the referral lineage must allow,
  // every shipped migration must be currently applied (deployment ready — no pending /
  // currently-failed / rolled-back-not-reapplied / missing-file), and every other applied
  // migration must be immutable. This command does NOT run the Redis / heartbeat / wallet /
  // payout-window / attribution / integrity checks, so it never claims full activation.
  const migrationReadinessOk = lineage.activationAllowed && deployment.ready && ordinary.ok;

  out("referral-migration-lineage-status:");
  out(`  migration:                ${REFERRAL_AFFILIATE_MIGRATION_NAME}`);

  out("  --- referral migration lineage ---");
  out(`  selected attempt:         ${attemptState.status}`);
  out(`  lineage status:           ${lineage.status}`);
  out(`  checksum classification:  ${classification}`);
  out(
    `  lineage activation:       ${lineage.activationAllowed ? "ALLOWED" : "BLOCKED"}${
      lineage.legacyVariant ? " (compatible legacy — non-blocking warning)" : ""
    }`,
  );
  out(`  detail:                   ${lineage.detail}`);
  out(`  recorded checksum:        ${attemptState.currentChecksum ?? "(not currently applied)"}`);
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

  out("  --- migration deployment state (on-disk vs database) ---");
  out(`  on-disk migrations: ${deployment.onDiskCount}; currently applied: ${deployment.appliedCount}`);
  out(`  pending (shipped, not applied):        ${deployment.pending.length}${deployment.pending.length ? ` [${deployment.pending.join(", ")}]` : ""}`);
  out(`  currently failed/stuck:                ${deployment.currentlyFailed.length}${deployment.currentlyFailed.length ? ` [${deployment.currentlyFailed.join(", ")}]` : ""}`);
  out(`  rolled back (not reapplied):           ${deployment.rolledBackNotReapplied.length}${deployment.rolledBackNotReapplied.length ? ` [${deployment.rolledBackNotReapplied.join(", ")}]` : ""}`);
  out(`  applied but file missing:              ${deployment.missingFile.length}${deployment.missingFile.length ? ` [${deployment.missingFile.join(", ")}]` : ""}`);
  out(`  historical rolled-back attempts (referral): ${attemptState.rolledBackCount}`);
  out(`  deployment ready: ${deployment.ready ? "YES" : `NO (${deployment.blocker})`}`);

  out("  --- other applied migrations (immutability) ---");
  out(`  ordinary migrations immutable: ${ordinary.ok ? "OK" : "FAILED"} (${ordinary.detail})`);

  out("  --- final verdict ---");
  out(
    `  FINAL MIGRATION READINESS VERDICT: ${migrationReadinessOk ? "PASSED" : "BLOCKED"} ` +
      `(lineage ${lineage.activationAllowed ? "ALLOWED" : "BLOCKED"}, deployment ${deployment.ready ? "READY" : "BLOCKED"}, ` +
      `ordinary migrations ${ordinary.ok ? "immutable" : "DRIFTED"})`,
  );
  if (migrationReadinessOk) {
    out("  Migration checks passed. Full referral activation still requires the OWNER readiness gate");
    out("  (Redis, control queue, worker + execute heartbeats, wallet ledger, payout windows, attribution, integrity).");
  } else {
    out("  Migration checks did NOT pass — resolve the blocker above.");
    out("  (Full referral activation also requires the OWNER readiness gate beyond these migration checks.)");
  }
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
