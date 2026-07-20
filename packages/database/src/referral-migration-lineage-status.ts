import { prisma } from "./client.js";
import {
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110,
} from "./migration-checksum.js";
import { checkReferralSchemaPostconditions, evaluateReferralMigrationLineage } from "./migration-lineage.js";

// =============================================================================
// Referral migration LINEAGE STATUS — an OWNER/operator-only DIAGNOSTIC command.
// Run standalone via scripts/referral-migration-lineage-status.sh. It inspects the
// recorded `20260719180000` checksum, classifies it ORIGINAL / PR110_COMPATIBLE /
// UNKNOWN, verifies the schema postconditions, and prints the verdict.
//
// GUARANTEES: read-only (moves no money, modifies no rows or migration metadata);
// prints NO credentials / DATABASE_URL and NO order / user / commission ids. The
// checksums it prints are SHA-256 of a public migration file (not secrets).
// =============================================================================

const EXIT_OK = 0;
const EXIT_ERROR = 2;

export type ReferralMigrationClassification = "ORIGINAL" | "PR110_COMPATIBLE" | "UNKNOWN" | "NOT_APPLIED";

export function classifyRecordedChecksum(recorded: string | null): ReferralMigrationClassification {
  if (recorded === null) return "NOT_APPLIED";
  if (recorded === REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL) return "ORIGINAL";
  if (recorded === REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_PR110) return "PR110_COMPATIBLE";
  return "UNKNOWN";
}

export async function printReferralMigrationLineageStatus(
  out: (line: string) => void = (l) => console.log(l),
): Promise<number> {
  const lineage = await evaluateReferralMigrationLineage();
  const classification = classifyRecordedChecksum(lineage.recordedChecksum);
  const postconditions = await checkReferralSchemaPostconditions();

  out("referral-migration-lineage-status:");
  out(`  lineage status:     ${lineage.status}`);
  out(`  classification:     ${classification}`);
  out(`  activation:         ${lineage.activationAllowed ? "ALLOWED" : "BLOCKED"}${lineage.legacyVariant ? " (compatible legacy — non-blocking warning)" : ""}`);
  out(`  detail:             ${lineage.detail}`);
  out(`  recorded checksum:  ${lineage.recordedChecksum ?? "(migration not applied)"}`);
  out(`  on-disk checksum:   ${lineage.onDiskChecksum ?? "(migration file missing)"}`);
  out("  schema postconditions:");
  for (const p of postconditions.postconditions) {
    out(`    ${p.ok ? "OK  " : "FAIL"}  ${p.key}`);
  }
  out(`  schema postconditions overall: ${postconditions.ok ? "OK" : "FAILED"}`);
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
