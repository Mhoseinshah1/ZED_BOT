import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  evaluateRollbackCompatibility,
  evaluateUpdateCompatibility,
  parseRollbackCompatibilityManifest,
  type MigrationSnapshot,
} from "../../../packages/database/src/deployment-rollback.js";
import {
  parseMigrationDeclarationManifest,
  validateMigrationDeclarationPair,
} from "../../../packages/database/src/migration-declarations.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const common = path.join(root, "scripts/lib/common.sh");
const rollback = path.join(root, "scripts/rollback.sh");
const nameA = "20260101000000_alpha";
const nameB = "20260102000000_beta";
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

function fixture(entries: Array<{ name: string; sql: string | Buffer }> = [{ name: nameA, sql: "SELECT 1;\n" }]) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-migrations-"));
  const prisma = path.join(dir, "packages/database/prisma");
  const migrations = path.join(prisma, "migrations");
  mkdirSync(migrations, { recursive: true });
  writeFileSync(path.join(migrations, "migration_lock.toml"), "provider = \"postgresql\"\n");
  const declarations = entries.map(({ name, sql }) => ({ name, sqlSha256: sha(sql) }));
  for (const entry of entries) {
    const migrationDir = path.join(migrations, entry.name); mkdirSync(migrationDir);
    writeFileSync(path.join(migrationDir, "migration.sql"), entry.sql);
  }
  const manifest = { formatVersion: 2, backwardCompatibleMigrations: declarations };
  const manifestPath = path.join(prisma, "rollback-compatibility.json");
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { dir, prisma, migrations, manifestPath, declarations };
}

function shellValidate(dir: string) {
  return spawnSync("bash", ["-c", `. '${common}'; validate_migration_declaration_pair "$1"`, "validate", dir], { encoding: "utf8" });
}

describe("strict format-2 migration declarations", () => {
  it("accepts valid exact hashes, including an exactly declared empty SQL file", () => {
    const pair = fixture([{ name: nameA, sql: "" }, { name: nameB, sql: Buffer.from([0, 1, 2]) }]);
    const result = validateMigrationDeclarationPair(pair.dir);
    expect(result.ok).toBe(true);
    expect(shellValidate(pair.dir).status).toBe(0);
    if (result.ok) {
      expect(result.value.declarations).toEqual([...pair.declarations].sort((a, b) => a.name.localeCompare(b.name)));
      expect(result.value.manifestSha256).toBe(sha(readFileSync(pair.manifestPath)));
    }
  });

  it("canonicalizes declaration ordering without changing semantic equality", () => {
    const declarations = [
      { name: nameB, sqlSha256: "b".repeat(64) },
      { name: nameA, sqlSha256: "a".repeat(64) },
    ];
    const parsed = parseMigrationDeclarationManifest({ formatVersion: 2, backwardCompatibleMigrations: declarations });
    expect(parsed?.backwardCompatibleMigrations.map(({ name }) => name)).toEqual([nameA, nameB]);
  });

  it.each([
    ["missing name", { sqlSha256: "a".repeat(64) }],
    ["missing checksum", { name: nameA }],
    ["unexpected declaration key", { name: nameA, sqlSha256: "a".repeat(64), extra: true }],
    ["non-string name", { name: 1, sqlSha256: "a".repeat(64) }],
    ["non-string checksum", { name: nameA, sqlSha256: 1 }],
    ["empty name", { name: "", sqlSha256: "a".repeat(64) }],
    ["slash", { name: "20260101000000_bad/name", sqlSha256: "a".repeat(64) }],
    ["traversal", { name: "../20260101000000_bad", sqlSha256: "a".repeat(64) }],
    ["uppercase checksum", { name: nameA, sqlSha256: "A".repeat(64) }],
    ["short checksum", { name: nameA, sqlSha256: "a".repeat(63) }],
    ["overlong checksum", { name: nameA, sqlSha256: "a".repeat(65) }],
    ["non-hex checksum", { name: nameA, sqlSha256: "z".repeat(64) }],
  ])("rejects %s", (_label, declaration) => {
    expect(parseMigrationDeclarationManifest({ formatVersion: 2, backwardCompatibleMigrations: [declaration] })).toBeNull();
    expect(parseRollbackCompatibilityManifest({ formatVersion: 2, backwardCompatibleMigrations: [declaration] })).toBeNull();
  });

  it("rejects duplicates, unexpected top-level keys, malformed JSON and unsupported versions", () => {
    const valid = { name: nameA, sqlSha256: "a".repeat(64) };
    expect(parseMigrationDeclarationManifest({ formatVersion: 2, backwardCompatibleMigrations: [valid, valid] })).toBeNull();
    expect(parseMigrationDeclarationManifest({ formatVersion: 2, backwardCompatibleMigrations: [], extra: true })).toBeNull();
    expect(parseMigrationDeclarationManifest({ formatVersion: 1, backwardCompatibleMigrations: [] })).toBeNull();
    const pair = fixture(); writeFileSync(pair.manifestPath, "{broken");
    expect(validateMigrationDeclarationPair(pair.dir)).toEqual({ ok: false, blocker: "migration-manifest-malformed-json" });
    expect(shellValidate(pair.dir).status).not.toBe(0);
  });

  it.each(["one-byte", "missing-sql", "missing-directory", "additional", "renamed", "extra-file"])("rejects exact-set failure: %s", (kind) => {
    const pair = fixture(); const migrationDir = path.join(pair.migrations, nameA); const sqlPath = path.join(migrationDir, "migration.sql");
    if (kind === "one-byte") writeFileSync(sqlPath, "SELECT 2;\n");
    if (kind === "missing-sql") rmSync(sqlPath);
    if (kind === "missing-directory") rmSync(migrationDir, { recursive: true });
    if (kind === "additional") { const extra = path.join(pair.migrations, nameB); mkdirSync(extra); writeFileSync(path.join(extra, "migration.sql"), ""); }
    if (kind === "renamed") renameSync(migrationDir, path.join(pair.migrations, nameB));
    if (kind === "extra-file") writeFileSync(path.join(migrationDir, "notes.txt"), "not permitted");
    expect(validateMigrationDeclarationPair(pair.dir).ok).toBe(false);
    expect(shellValidate(pair.dir).status).not.toBe(0);
  });

  it("cannot mix a manifest from one tree with migrations from another", () => {
    const left = fixture([{ name: nameA, sql: "left" }]); const right = fixture([{ name: nameA, sql: "right" }]);
    writeFileSync(left.manifestPath, readFileSync(right.manifestPath));
    expect(validateMigrationDeclarationPair(left.dir).ok).toBe(false);
    expect(shellValidate(left.dir).status).not.toBe(0);
  });

  it("detects exact manifest-byte mutation and declaration-set mismatch after recording", () => {
    const pair = fixture(); const validated = validateMigrationDeclarationPair(pair.dir);
    expect(validated.ok).toBe(true); if (!validated.ok) return;
    const recordedHash = validated.value.manifestSha256;
    writeFileSync(pair.manifestPath, `${readFileSync(pair.manifestPath, "utf8")} `);
    const mutated = validateMigrationDeclarationPair(pair.dir);
    expect(mutated.ok).toBe(true); if (!mutated.ok) return;
    expect(mutated.value.manifestSha256).not.toBe(recordedHash);
    expect(mutated.value.declarations).toEqual(validated.value.declarations);
    expect([{ ...validated.value.declarations[0], sqlSha256: "b".repeat(64) }]).not.toEqual(mutated.value.declarations);
  });

  it("fails update and rollback decisions consistently for one-byte SQL evidence", () => {
    const pair = fixture(); writeFileSync(path.join(pair.migrations, nameA, "migration.sql"), "SELECT 9;\n");
    expect(validateMigrationDeclarationPair(pair.dir).ok).toBe(false);
    expect(shellValidate(pair.dir).status).not.toBe(0);
  });

  it("rollback rejects a one-byte evidence mutation before any mocked operational command", () => {
    // validate_compatibility runs the CURRENT (about-to-be-rolled-back-from)
    // worker's own live code, so its evidence must come from
    // $ZEDBOT_CURRENT_DEPLOYMENT_METADATA (current.json), not previous.json -
    // see the fix comment in scripts/rollback.sh's validate_compatibility.
    const pair = fixture(); const state = mkdtempSync(path.join(os.tmpdir(), "zedbot-rollback-evidence-")); chmodSync(state, 0o700);
    const generation = "20260101T000000Z-aaaaaaaaaaaa"; const evidence = path.join(state, `evidence-${generation}`);
    renameSync(pair.dir, evidence);
    const manifestBytes = readFileSync(path.join(evidence, "packages/database/prisma/rollback-compatibility.json"));
    const metadata = path.join(state, "current.json"); const record = path.join(state, "operational-command");
    writeFileSync(metadata, JSON.stringify({
      formatVersion: 2, installationKind: null, lifecycleRole: "current", generation,
      sourceTree: "c".repeat(40), preDeploySha: "a".repeat(40), preDeployImageId: `sha256:${"1".repeat(64)}`,
      targetDeploySha: "b".repeat(40), targetImageId: `sha256:${"2".repeat(64)}`,
      retainedImageTag: `zedbot-app:rollback-${generation}`, immutableImageTag: `zedbot-app:generation-${generation}`,
      failedTargetTag: `zedbot-app:failed-${generation}`, capturedAt: "2026-01-01T00:00:00Z",
      preDeployMigrations: [nameA], declarationFormatVersion: 2, declarationSourceCategory: "generation-evidence",
      migrationEvidencePath: evidence, composeEvidencePath: path.join(evidence, "docker-compose.yml"),
      composeEvidenceSha256: "d".repeat(64), composeProjectName: "zedbot", composeApplicationImage: "zedbot-app:latest",
      compatibilityManifestSha256: sha(manifestBytes), compatibilityDeclarations: pair.declarations,
      recreationAttempted: true, healthConfirmed: true, state: "known-good",
    })); chmodSync(metadata, 0o600);
    writeFileSync(path.join(evidence, "packages/database/prisma/migrations", nameA, "migration.sql"), "SELECT 2;\n");
    const command = `. '${rollback}'; run_compose(){ echo invoked >'${record}'; }; validate_compatibility`;
    const result = spawnSync("bash", ["-c", command], { env: { ...process.env, ZEDBOT_BASE_DIR: state,
      ZEDBOT_DEPLOYMENT_DIR: state, ZEDBOT_CURRENT_DEPLOYMENT_METADATA: metadata } });
    expect(result.status).not.toBe(0);
    expect(() => readFileSync(record)).toThrow();
  });

  it("rollback compares the live worker's manifest and baseline against the CURRENT generation, not previous's stale ones", () => {
    const pair = fixture(); const state = mkdtempSync(path.join(os.tmpdir(), "zedbot-rollback-evidence-current-")); chmodSync(state, 0o700);
    const generation = "20260101T000000Z-aaaaaaaaaaaa"; const evidence = path.join(state, `evidence-${generation}`);
    renameSync(pair.dir, evidence);
    const manifestBytes = readFileSync(path.join(evidence, "packages/database/prisma/rollback-compatibility.json"));
    const currentManifestSha = sha(manifestBytes);
    const currentMetadata = path.join(state, "current.json");
    const currentPayload = {
      formatVersion: 2, installationKind: null, lifecycleRole: "current", generation,
      sourceTree: "c".repeat(40), preDeploySha: "a".repeat(40), preDeployImageId: `sha256:${"1".repeat(64)}`,
      targetDeploySha: "b".repeat(40), targetImageId: `sha256:${"2".repeat(64)}`,
      retainedImageTag: `zedbot-app:rollback-${generation}`, immutableImageTag: `zedbot-app:generation-${generation}`,
      failedTargetTag: `zedbot-app:failed-${generation}`, capturedAt: "2026-01-01T00:00:00Z",
      preDeployMigrations: [nameA], declarationFormatVersion: 2, declarationSourceCategory: "generation-evidence",
      migrationEvidencePath: evidence, composeEvidencePath: path.join(evidence, "docker-compose.yml"),
      composeEvidenceSha256: "d".repeat(64), composeProjectName: "zedbot", composeApplicationImage: "zedbot-app:latest",
      compatibilityManifestSha256: currentManifestSha, compatibilityDeclarations: pair.declarations,
      recreationAttempted: true, healthConfirmed: true, state: "known-good",
    };
    writeFileSync(currentMetadata, JSON.stringify(currentPayload)); chmodSync(currentMetadata, 0o600);
    // previous.json intentionally has a DIFFERENT (stale, pre-migration)
    // manifest hash, declaration set, and preDeployMigrations baseline - if
    // validate_compatibility read any of these from previous.json (the old
    // bug), this test would fail one of the pre-checks or pass the wrong
    // baseline to the live worker, even though everything genuinely matches
    // current.json.
    const previousMetadata = path.join(state, "previous.json");
    writeFileSync(previousMetadata, JSON.stringify({ ...currentPayload, lifecycleRole: "previous", compatibilityManifestSha256: "f".repeat(64), compatibilityDeclarations: [], preDeployMigrations: [] }));
    chmodSync(previousMetadata, 0o600);
    const seenBaseline = path.join(state, "seen-baseline");
    const command = `. '${rollback}'; run_compose(){ echo -n "$8" >'${seenBaseline}'; echo '{"manifestSha256":"${currentManifestSha}"}'; }; validate_compatibility`;
    const result = spawnSync("bash", ["-c", command], { env: { ...process.env, ZEDBOT_BASE_DIR: state,
      ZEDBOT_DEPLOYMENT_DIR: state, ZEDBOT_CURRENT_DEPLOYMENT_METADATA: currentMetadata, ZEDBOT_ROLLBACK_METADATA: previousMetadata } });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(seenBaseline, "utf8")).toBe(nameA);
  });

  it.each([
    ["database-only", { databaseOnly: [nameB] }],
    ["failed", { failed: [nameA] }],
    ["incomplete", { incomplete: [nameA] }],
    ["unknown", { shipped: [nameA, nameB], applied: [nameA, nameB] }],
  ])("update and rollback both fail closed for %s state", (_label, patch) => {
    const manifest = { formatVersion: 2 as const, backwardCompatibleMigrations: [{ name: nameA, sqlSha256: "a".repeat(64) }] };
    const state: MigrationSnapshot = { shipped: [nameA], applied: [nameA], pending: [], failed: [], databaseOnly: [], incomplete: [], appliedChecksums: {}, ...patch };
    expect(evaluateUpdateCompatibility([nameA], state, manifest).ok).toBe(false);
    expect(evaluateRollbackCompatibility([nameA], state, manifest).ok).toBe(false);
  });

  it("rejects legacy rollback metadata without evidence and the jq cross-object regression", () => {
    const state = mkdtempSync(path.join(os.tmpdir(), "zedbot-metadata-")); chmodSync(state, 0o700);
    const metadata = path.join(state, "previous.json");
    const base = {
      formatVersion: 2, generation: "20260101T000000Z-aaaaaaaaaaaa", sourceTree: "a".repeat(40),
      preDeploySha: "a".repeat(40), targetDeploySha: "b".repeat(40), preDeployImageId: `sha256:${"a".repeat(64)}`,
      retainedImageTag: "zedbot-app:rollback-20260101T000000Z-aaaaaaaaaaaa", targetImageId: `sha256:${"b".repeat(64)}`,
      failedTargetTag: "zedbot-app:failed-20260101T000000Z-aaaaaaaaaaaa", compatibilityManifestSha256: "a".repeat(64),
      preDeployMigrations: [nameA], state: "prepared",
    };
    writeFileSync(metadata, JSON.stringify({ ...base, compatibilityDeclarations: [] })); chmodSync(metadata, 0o600);
    const env = { ...process.env, ZEDBOT_BASE_DIR: state, ZEDBOT_DEPLOYMENT_DIR: state, ZEDBOT_ROLLBACK_METADATA: metadata };
    expect(spawnSync("bash", ["-c", `. '${rollback}'; validate_metadata`], { env }).status).not.toBe(0);
    writeFileSync(metadata, JSON.stringify({ ...base, declarationFormatVersion: 2, declarationSourceCategory: "generation-evidence",
      migrationEvidencePath: `${state}/evidence-${base.generation}`,
      compatibilityDeclarations: [{ name: nameA }, { sqlSha256: "a".repeat(64) }] })); chmodSync(metadata, 0o600);
    expect(spawnSync("bash", ["-c", `. '${rollback}'; validate_metadata`], { env }).status).not.toBe(0);
  });

  it("suppresses every later mocked mutation after declaration failure", () => {
    const pair = fixture(); writeFileSync(path.join(pair.migrations, nameA, "migration.sql"), "changed by one byte!");
    const record = path.join(pair.dir, "mutations");
    const command = `. '${common}'; retain(){ echo retain >>'$record'; }; build(){ echo build >>'$record'; }; compatibility(){ echo compatibility >>'$record'; }; migrate(){ echo migrate >>'$record'; }; recreate(){ echo recreate >>'$record'; }; promote(){ echo promote >>'$record'; }; validate_migration_declaration_pair "$1" && retain && build && compatibility && migrate && recreate && promote`;
    expect(spawnSync("bash", ["-c", command, "gate", pair.dir]).status).not.toBe(0);
    expect(() => readFileSync(record)).toThrow();
  });
});
