import {
  MIGRATION_DECLARATION_FORMAT_VERSION,
  parseMigrationDeclarationManifest,
  type MigrationDeclaration as CompatibleMigrationDeclaration,
  type MigrationDeclarationManifest as RollbackCompatibilityManifest,
} from "./migration-declarations.js";

export const ROLLBACK_COMPATIBILITY_FORMAT_VERSION = MIGRATION_DECLARATION_FORMAT_VERSION;
export type { CompatibleMigrationDeclaration, RollbackCompatibilityManifest };

export interface MigrationSnapshot {
  shipped: string[];
  applied: string[];
  pending: string[];
  failed: string[];
  databaseOnly: string[];
  incomplete: string[];
}

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
