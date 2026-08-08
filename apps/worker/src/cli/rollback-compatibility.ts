import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  connectDatabase,
  disconnectDatabase,
  evaluateMigrationDeploymentState,
  evaluateRollbackCompatibility,
  evaluateUpdateCompatibility,
  parseRollbackCompatibilityManifest,
  type MigrationSnapshot,
} from "@zedbot/database";

const MIGRATION_NAME = /^\d{14}_[a-z0-9_]+$/;

async function readManifest(): Promise<{ raw: Buffer; value: unknown } | null> {
  for (const candidate of [
    path.resolve(process.cwd(), "packages/database/prisma/rollback-compatibility.json"),
    path.resolve(process.cwd(), "../../packages/database/prisma/rollback-compatibility.json"),
  ]) {
    try {
      const raw = await readFile(candidate);
      return { raw, value: JSON.parse(raw.toString("utf8")) as unknown };
    } catch {
      // Try the next repository/image layout.
    }
  }
  return null;
}

function parseBaseline(raw: string | undefined): string[] | null {
  if (raw === undefined || raw === "") return null;
  const values = raw.split(",");
  if (!values.every((name) => MIGRATION_NAME.test(name))) return null;
  const result = [...new Set(values)].sort();
  return result.length === values.length ? result : null;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const baseline = parseBaseline(process.argv[3]);
  if ((mode !== "update" && mode !== "rollback") || baseline === null) {
    process.stdout.write(`${JSON.stringify({ ok: false, blocker: "invalid-arguments" })}\n`);
    process.exit(1);
  }
  const loaded = await readManifest();
  const manifest = loaded === null ? null : parseRollbackCompatibilityManifest(loaded.value);
  if (loaded === null || manifest === null) {
    process.stdout.write(`${JSON.stringify({ ok: false, blocker: "invalid-compatibility-manifest" })}\n`);
    process.exit(1);
  }
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
    };
    const decision = mode === "update"
      ? evaluateUpdateCompatibility(baseline, snapshot, manifest)
      : evaluateRollbackCompatibility(baseline, snapshot, manifest);
    const manifestSha256 = createHash("sha256").update(loaded.raw).digest("hex");
    process.stdout.write(`${JSON.stringify({ ...decision, mode, manifestSha256, snapshot })}\n`);
    process.exitCode = decision.ok ? 0 : 1;
  } finally {
    await disconnectDatabase().catch(() => undefined);
  }
}

main().catch(() => {
  process.stdout.write(`${JSON.stringify({ ok: false, blocker: "migration-state-unavailable" })}\n`);
  process.exit(1);
});
