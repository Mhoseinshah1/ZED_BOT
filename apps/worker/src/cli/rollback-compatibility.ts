import {
  connectDatabase,
  disconnectDatabase,
  evaluateMigrationDeploymentState,
  evaluateRollbackCompatibility,
  evaluateUpdateCompatibility,
  validateMigrationDeclarationPair,
  type MigrationSnapshot,
} from "@zedbot/database";

const MIGRATION_NAME = /^\d{14}_[a-z0-9_]+$/;

function parseBaseline(raw: string | undefined): string[] | null {
  if (raw === undefined || raw === "") return null;
  const values = raw.split(",");
  if (!values.every((name) => MIGRATION_NAME.test(name))) return null;
  const result = [...new Set(values)].sort();
  return result.length === values.length ? result : null;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode === "validate-declarations") {
    const result = validateMigrationDeclarationPair(process.argv[3] ?? process.cwd());
    process.stdout.write(`${JSON.stringify(result.ok ? { ok: true, ...result.value } : result)}\n`);
    process.exit(result.ok ? 0 : 1);
  }
  const baseline = parseBaseline(process.argv[3]);
  if ((mode !== "update" && mode !== "rollback") || baseline === null) {
    process.stdout.write(`${JSON.stringify({ ok: false, blocker: "invalid-arguments" })}\n`);
    process.exit(1);
  }
  const validated = validateMigrationDeclarationPair(process.cwd());
  if (!validated.ok) {
    process.stdout.write(`${JSON.stringify(validated)}\n`);
    process.exit(1);
  }
  const manifest = validated.value.manifest;
  await connectDatabase();
  try {
    const state = await evaluateMigrationDeploymentState();
    const snapshot: MigrationSnapshot = {
      shipped: state.entries.filter((entry) => entry.onDisk).map((entry) => entry.migrationName),
      applied: state.entries.filter((entry) => entry.state === "APPLIED").map((entry) => entry.migrationName),
      pending: state.pending,
      failed: [...state.currentlyFailed, ...state.rolledBackNotReapplied],
      databaseOnly: state.missingFile,
      incomplete: state.incompleteOnDisk,
      appliedChecksums: Object.fromEntries(
        state.entries
          .filter((entry): entry is typeof entry & { currentChecksum: string } =>
            entry.state === "APPLIED" && entry.currentChecksum !== null)
          .map((entry) => [entry.migrationName, entry.currentChecksum]),
      ),
    };
    const decision = mode === "update"
      ? evaluateUpdateCompatibility(baseline, snapshot, manifest)
      : evaluateRollbackCompatibility(baseline, snapshot, manifest);
    process.stdout.write(`${JSON.stringify({ ...decision, mode, manifestSha256: validated.value.manifestSha256,
      declarations: validated.value.declarations, declarationFormatVersion: manifest.formatVersion,
      declarationSourceCategory: validated.value.sourceCategory, snapshot })}\n`);
    process.exitCode = decision.ok ? 0 : 1;
  } finally {
    await disconnectDatabase().catch(() => undefined);
  }
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({ ok: false, blocker: "migration-state-unavailable" })}\n`);
  process.exit(1);
});
