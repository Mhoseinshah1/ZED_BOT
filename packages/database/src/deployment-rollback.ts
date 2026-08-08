export const ROLLBACK_COMPATIBILITY_FORMAT_VERSION = 1;

export interface RollbackCompatibilityManifest {
  formatVersion: 1;
  backwardCompatibleMigrations: string[];
}

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
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.formatVersion !== ROLLBACK_COMPATIBILITY_FORMAT_VERSION) return null;
  if (!Array.isArray(candidate.backwardCompatibleMigrations)) return null;
  if (!candidate.backwardCompatibleMigrations.every((name) => typeof name === "string" && MIGRATION_NAME.test(name))) return null;
  const names = uniqueSorted(candidate.backwardCompatibleMigrations as string[]);
  if (names.length !== candidate.backwardCompatibleMigrations.length) return null;
  return { formatVersion: 1, backwardCompatibleMigrations: names };
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
  if (baseline.some((name) => !target.applied.includes(name))) return { ok: false, newlyPending: [], unsafe: [], blocker: "baseline-not-applied" };
  const newlyPending = uniqueSorted(target.pending.filter((name) => !baseline.includes(name)));
  const unexpectedPending = target.pending.filter((name) => baseline.includes(name));
  if (unexpectedPending.length > 0) return { ok: false, newlyPending, unsafe: [], blocker: `baseline-pending:${unexpectedPending[0]}` };
  const allowed = new Set(manifest.backwardCompatibleMigrations);
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
