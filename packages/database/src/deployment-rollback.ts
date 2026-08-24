import {
  MIGRATION_DECLARATION_FORMAT_VERSION,
  parseMigrationDeclarationManifest,
  type MigrationDeclaration as CompatibleMigrationDeclaration,
  type MigrationDeclarationManifest as RollbackCompatibilityManifest,
} from "./migration-declarations.js";
import {
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ALLOWLIST,
  REFERRAL_AFFILIATE_MIGRATION_NAME,
} from "./migration-checksum.js";

export const ROLLBACK_COMPATIBILITY_FORMAT_VERSION = MIGRATION_DECLARATION_FORMAT_VERSION;
export type { CompatibleMigrationDeclaration, RollbackCompatibilityManifest };

export interface MigrationSnapshot {
  shipped: string[];
  applied: string[];
  pending: string[];
  failed: string[];
  databaseOnly: string[];
  incomplete: string[];
  /** Recorded `_prisma_migrations.checksum` for each currently-APPLIED migration, by name. */
  appliedChecksums: Record<string, string>;
}

// A declared backward-compatible migration's manifest checksum is normally the ONE
// acceptable value - it must equal exactly what the database recorded when the
// migration was applied, or a name match alone (with different actual SQL behind it)
// could be misread as a known-safe migration. The referral affiliate migration is the
// sole documented exception: it shipped in two logical SQL forms across two byte
// encodings (see migration-checksum.ts), so a database that applied any of those four
// EMPIRICALLY VERIFIED historical variants is still genuinely compatible.
const HISTORICAL_CHECKSUM_ALLOWLIST: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [REFERRAL_AFFILIATE_MIGRATION_NAME, new Set(Object.values(REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ALLOWLIST))],
]);

export interface CompatibilityDecision {
  ok: boolean;
  newlyPending: string[];
  unsafe: string[];
  blocker: string | null;
}

const MIGRATION_NAME = /^\d{14}_[a-z0-9_]+$/;

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

export function parseRollbackCompatibilityManifest(value: unknown): RollbackCompatibilityManifest | null {
  return parseMigrationDeclarationManifest(value);
}

export function evaluateUpdateCompatibility(
  baselineMigrations: readonly string[],
  target: MigrationSnapshot,
  manifest: RollbackCompatibilityManifest,
): CompatibilityDecision {
  const baseline = uniqueSorted(baselineMigrations);
  const all = [...target.shipped, ...target.applied, ...target.pending, ...target.failed,
    ...target.databaseOnly, ...target.incomplete];
  if (all.some((name) => !MIGRATION_NAME.test(name))) return { ok: false, newlyPending: [], unsafe: [], blocker: "malformed-migration-state" };
  if (target.failed.length > 0) return { ok: false, newlyPending: [], unsafe: [], blocker: `failed:${target.failed[0]}` };
  if (target.databaseOnly.length > 0) return { ok: false, newlyPending: [], unsafe: [], blocker: `database-only:${target.databaseOnly[0]}` };
  if (target.incomplete.length > 0) return { ok: false, newlyPending: [], unsafe: [], blocker: `incomplete:${target.incomplete[0]}` };
  const declared = new Set(manifest.backwardCompatibleMigrations.map(({ name }) => name));
  const unknown = uniqueSorted([...target.shipped, ...target.applied, ...target.pending]).find((name) => !declared.has(name));
  if (unknown !== undefined) return { ok: false, newlyPending: [], unsafe: [], blocker: `unknown:${unknown}` };
  const absent = manifest.backwardCompatibleMigrations.find(({ name }) => !target.shipped.includes(name));
  if (absent !== undefined) return { ok: false, newlyPending: [], unsafe: [], blocker: `declared-not-shipped:${absent.name}` };
  for (const declaration of manifest.backwardCompatibleMigrations) {
    if (!target.applied.includes(declaration.name)) continue;
    const recorded = target.appliedChecksums[declaration.name];
    if (recorded === undefined) return { ok: false, newlyPending: [], unsafe: [], blocker: `checksum-missing:${declaration.name}` };
    const accepted = HISTORICAL_CHECKSUM_ALLOWLIST.get(declaration.name) ?? new Set([declaration.sqlSha256]);
    if (!accepted.has(recorded)) return { ok: false, newlyPending: [], unsafe: [], blocker: `checksum-mismatch:${declaration.name}` };
  }
  if (baseline.some((name) => !target.applied.includes(name))) return { ok: false, newlyPending: [], unsafe: [], blocker: "baseline-not-applied" };
  const newlyPending = uniqueSorted(target.pending.filter((name) => !baseline.includes(name)));
  const unexpectedPending = target.pending.filter((name) => baseline.includes(name));
  if (unexpectedPending.length > 0) return { ok: false, newlyPending, unsafe: [], blocker: `baseline-pending:${unexpectedPending[0]}` };
  const allowed = declared;
  const unsafe = newlyPending.filter((name) => !allowed.has(name));
  return { ok: unsafe.length === 0, newlyPending, unsafe, blocker: unsafe.length === 0 ? null : `not-backward-compatible:${unsafe[0]}` };
}

export function evaluateRollbackCompatibility(
  baselineMigrations: readonly string[],
  current: MigrationSnapshot,
  manifest: RollbackCompatibilityManifest,
): CompatibilityDecision {
  if (current.pending.length > 0) return { ok: false, newlyPending: [], unsafe: [], blocker: `pending:${current.pending[0]}` };
  const appliedAfterBaseline = uniqueSorted(current.applied.filter((name) => !baselineMigrations.includes(name)));
  return evaluateUpdateCompatibility(baselineMigrations, { ...current, pending: appliedAfterBaseline }, manifest);
}
