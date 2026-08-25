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

  // Regression: the first update after a first install promotes that
  // first-install's current.json - which documents null preDeploySha,
  // preDeployImageId, retainedImageTag, and an empty preDeployMigrations,
  // since there is no prior deployment to describe - straight into
  // previous.json. rollback.sh's own validate_metadata duplicated a second,
  // stricter schema on top of validate_generation_metadata_core (which
  // already handles this nullable shape correctly) that unconditionally
  // required these as non-null, so the very first rollback after the very
  // first update was rejected outright.
  function firstInstallDerivedPrevious(generation: string, evidenceDir: string) {
    return {
      formatVersion: 2, installationKind: "first-install", lifecycleRole: "previous", generation,
      sourceTree: "a".repeat(40), preDeploySha: null, preDeployImageId: null,
      targetDeploySha: "b".repeat(40), targetImageId: `sha256:${"1".repeat(64)}`,
      retainedImageTag: null, immutableImageTag: `zedbot-app:generation-${generation}`,
      failedTargetTag: `zedbot-app:failed-${generation}`, capturedAt: "2026-08-14T12:00:00Z",
      preDeployMigrations: [], declarationFormatVersion: 2, declarationSourceCategory: "generation-evidence",
      migrationEvidencePath: evidenceDir, composeEvidencePath: path.join(evidenceDir, "docker-compose.yml"),
      composeEvidenceSha256: "c".repeat(64), composeProjectName: "zedbot", composeApplicationImage: "zedbot-app:latest",
      compatibilityManifestSha256: "d".repeat(64), compatibilityDeclarations: [],
      recreationAttempted: true, healthConfirmed: true, state: "known-good",
    };
  }

  it("validate_metadata accepts a first-install-derived previous.json with its documented nulls", () => {
    const state = mkdtempSync(path.join(os.tmpdir(), "zedbot-first-install-previous-")); chmodSync(state, 0o700);
    const generation = "20260101T000000Z-aaaaaaaaaaaa";
    const metadata = path.join(state, "previous.json");
    writeFileSync(metadata, JSON.stringify(firstInstallDerivedPrevious(generation, path.join(state, `evidence-${generation}`))));
    chmodSync(metadata, 0o600);
    const env = { ...process.env, ZEDBOT_BASE_DIR: state, ZEDBOT_DEPLOYMENT_DIR: state, ZEDBOT_ROLLBACK_METADATA: metadata };
    const result = spawnSync("bash", ["-c", `. '${rollback}'; validate_metadata`], { env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  it("validate_metadata still rejects a normal previous.json that carries those same nulls without installationKind", () => {
    const state = mkdtempSync(path.join(os.tmpdir(), "zedbot-non-first-install-nulls-")); chmodSync(state, 0o700);
    const generation = "20260101T000000Z-bbbbbbbbbbbb";
    const metadata = path.join(state, "previous.json");
    const payload = firstInstallDerivedPrevious(generation, path.join(state, `evidence-${generation}`));
    delete (payload as { installationKind?: string }).installationKind;
    writeFileSync(metadata, JSON.stringify(payload));
    chmodSync(metadata, 0o600);
    const env = { ...process.env, ZEDBOT_BASE_DIR: state, ZEDBOT_DEPLOYMENT_DIR: state, ZEDBOT_ROLLBACK_METADATA: metadata };
    expect(spawnSync("bash", ["-c", `. '${rollback}'; validate_metadata`], { env }).status).not.toBe(0);
  });

  // Regression: independent of the first-install nullability above,
  // validate_metadata's compatibilityDeclarations check piped the array
  // into an `and`-chain - `.compatibilityDeclarations|type=="array" and
  // all(.compatibilityDeclarations[]; ...)` - which (jq's `|` binds looser
  // than `and`) redirected every clause after the pipe, not just the first,
  // to receive the ARRAY itself as ".". `all(.compatibilityDeclarations[];
  // ...)` then tried to index that array by the string
  // "compatibilityDeclarations", which jq rejects outright - so
  // validate_metadata could never actually SUCCEED for ANY well-formed
  // metadata, empty declarations or not. No prior test exercised
  // validate_metadata's success path all the way through, so this was
  // never caught: rollback was completely non-functional.
  it("validate_metadata accepts a normal previous.json with a non-empty, well-formed compatibilityDeclarations array", () => {
    const state = mkdtempSync(path.join(os.tmpdir(), "zedbot-normal-previous-")); chmodSync(state, 0o700);
    const generation = "20260101T000000Z-cccccccccccc";
    const metadata = path.join(state, "previous.json");
    const payload = {
      formatVersion: 2, installationKind: null, lifecycleRole: "previous", generation,
      sourceTree: "a".repeat(40), preDeploySha: "e".repeat(40), preDeployImageId: `sha256:${"3".repeat(64)}`,
      targetDeploySha: "b".repeat(40), targetImageId: `sha256:${"1".repeat(64)}`,
      retainedImageTag: `zedbot-app:rollback-${generation}`, immutableImageTag: `zedbot-app:generation-${generation}`,
      failedTargetTag: `zedbot-app:failed-${generation}`, capturedAt: "2026-08-14T12:00:00Z",
      preDeployMigrations: [nameA], declarationFormatVersion: 2, declarationSourceCategory: "generation-evidence",
      migrationEvidencePath: path.join(state, `evidence-${generation}`), composeEvidencePath: path.join(state, `evidence-${generation}`, "docker-compose.yml"),
      composeEvidenceSha256: "c".repeat(64), composeProjectName: "zedbot", composeApplicationImage: "zedbot-app:latest",
      compatibilityManifestSha256: "d".repeat(64), compatibilityDeclarations: [{ name: nameA, sqlSha256: "f".repeat(64) }],
      recreationAttempted: true, healthConfirmed: true, state: "known-good",
    };
    writeFileSync(metadata, JSON.stringify(payload));
    chmodSync(metadata, 0o600);
    const env = { ...process.env, ZEDBOT_BASE_DIR: state, ZEDBOT_DEPLOYMENT_DIR: state, ZEDBOT_ROLLBACK_METADATA: metadata };
    const result = spawnSync("bash", ["-c", `. '${rollback}'; validate_metadata`], { env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });

  // Regression: validate_generation_owned_evidence (the non-readonly
  // variant) ends by calling set_rollback_compose_contract as a side
  // effect. rollback.sh's perform_rollback used to call it on previous.json
  // right after validate_metadata - well before validate_compatibility,
  // which its own comment says must run under the CURRENT generation's
  // Compose contract - silently rebinding run_compose to previous's
  // contract early and defeating that ordering guarantee even after it was
  // otherwise fixed. Switched to validate_generation_owned_evidence_readonly,
  // which performs the identical validation with no such side effect.
  function evidenceFixture(compose: string) {
    const pair = fixture();
    const state = mkdtempSync(path.join(os.tmpdir(), "zedbot-evidence-sideeffect-"));
    chmodSync(state, 0o700);
    const generation = "20260101T000000Z-dddddddddddd";
    const evidence = path.join(state, `evidence-${generation}`);
    renameSync(pair.dir, evidence);
    writeFileSync(path.join(evidence, "docker-compose.yml"), compose);
    const manifestBytes = readFileSync(path.join(evidence, "packages/database/prisma/rollback-compatibility.json"));
    const metadataPath = path.join(state, "previous.json");
    writeFileSync(metadataPath, JSON.stringify({
      formatVersion: 2, installationKind: null, lifecycleRole: "previous", generation,
      sourceTree: "a".repeat(40), preDeploySha: "e".repeat(40), preDeployImageId: `sha256:${"3".repeat(64)}`,
      targetDeploySha: "b".repeat(40), targetImageId: `sha256:${"1".repeat(64)}`,
      retainedImageTag: `zedbot-app:rollback-${generation}`, immutableImageTag: `zedbot-app:generation-${generation}`,
      failedTargetTag: `zedbot-app:failed-${generation}`, capturedAt: "2026-08-14T12:00:00Z",
      preDeployMigrations: [nameA], declarationFormatVersion: 2, declarationSourceCategory: "generation-evidence",
      migrationEvidencePath: evidence, composeEvidencePath: path.join(evidence, "docker-compose.yml"),
      composeEvidenceSha256: sha(compose), composeProjectName: "zedbot", composeApplicationImage: "zedbot-app:latest",
      compatibilityManifestSha256: sha(manifestBytes), compatibilityDeclarations: pair.declarations,
      recreationAttempted: true, healthConfirmed: true, state: "known-good",
    }));
    chmodSync(metadataPath, 0o600);
    return { state, metadataPath };
  }

  it("validate_generation_owned_evidence_readonly leaves the active Compose contract untouched", () => {
    const { state, metadataPath } = evidenceFixture("services: {}\n");
    const sentinel = "/sentinel/docker-compose.yml";
    const command = `. '${common}'; set_deployment_state_paths '${state}'; validate_compose_contract_paths(){ :; }; ZEDBOT_CANONICAL_COMPOSE_FILE='${sentinel}'; validate_generation_owned_evidence_readonly '${metadataPath}' && printf '%s' "$ZEDBOT_CANONICAL_COMPOSE_FILE"`;
    const result = spawnSync("bash", ["-c", command], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(sentinel);
  });

  it("validate_generation_owned_evidence (non-readonly), by contrast, rebinds the active Compose contract", () => {
    const { state, metadataPath } = evidenceFixture("services: {}\n");
    const sentinel = "/sentinel/docker-compose.yml";
    const command = `. '${common}'; set_deployment_state_paths '${state}'; validate_compose_contract_paths(){ :; }; ZEDBOT_CANONICAL_COMPOSE_FILE='${sentinel}'; validate_generation_owned_evidence '${metadataPath}' && printf '%s' "$ZEDBOT_CANONICAL_COMPOSE_FILE"`;
    const result = spawnSync("bash", ["-c", command], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toBe(sentinel);
    expect(result.stdout).toBe(path.join(state, "evidence-20260101T000000Z-dddddddddddd", "docker-compose.yml"));
  });

  it("perform_rollback validates previous's evidence via the side-effect-free readonly variant before compatibility is checked", () => {
    const rollbackText = readFileSync(rollback, "utf8");
    const perform = rollbackText.slice(rollbackText.indexOf("perform_rollback() {"), rollbackText.indexOf("\nmain() {"));
    const evidenceCheck = perform.indexOf("validate_generation_owned_evidence_readonly");
    // The standalone call (its own line, no arguments) - not any mention of
    // the name inside a comment, including this file's own explanatory one.
    const compatibilityCheck = perform.indexOf("\n    validate_compatibility\n");
    const contractSwitch = perform.indexOf("\n  configure_rollback_compose_contract\n");
    expect(evidenceCheck).toBeGreaterThan(-1);
    expect(evidenceCheck).toBeLessThan(compatibilityCheck);
    expect(compatibilityCheck).toBeLessThan(contractSwitch);
    // The mutating (non-readonly) validate_generation_owned_evidence must
    // not be CALLED anywhere in perform_rollback - only the readonly
    // variant. Matches the actual call shape (a quoted argument), not
    // prose mentioning the function name in a comment.
    expect(perform).not.toMatch(/[^_]validate_generation_owned_evidence\s+"/);
  });

  it("suppresses every later mocked mutation after declaration failure", () => {
    const pair = fixture(); writeFileSync(path.join(pair.migrations, nameA, "migration.sql"), "changed by one byte!");
    const record = path.join(pair.dir, "mutations");
    const command = `. '${common}'; retain(){ echo retain >>'$record'; }; build(){ echo build >>'$record'; }; compatibility(){ echo compatibility >>'$record'; }; migrate(){ echo migrate >>'$record'; }; recreate(){ echo recreate >>'$record'; }; promote(){ echo promote >>'$record'; }; validate_migration_declaration_pair "$1" && retain && build && compatibility && migrate && recreate && promote`;
    expect(spawnSync("bash", ["-c", command, "gate", pair.dir]).status).not.toBe(0);
    expect(() => readFileSync(record)).toThrow();
  });

  // Regression: sync_deployment_checkout (git merge --ff-only) can only ever
  // move the persistent checkout's HEAD forward, so after a rollback to an
  // OLDER generation the checkout's own docker-compose.yml stays on the
  // newer commit forever - there is no ff-only path back. Any command that
  // just defaulted to the checkout's file (zedbot.sh's status/logs/restart/
  // start/stop/shell/deploy-status/backup verify/repair backups, doctor.sh,
  // backup.sh, backup-db.sh) would then run against a Compose definition
  // that does not match what is actually deployed, until the next update
  // happens to fast-forward past it. current.json is rewritten to describe
  // exactly the active generation on every promotion, together with an
  // immutable, checksum-verified copy of that generation's own
  // docker-compose.yml, so binding to it instead is always accurate.
  describe("binding the live Compose contract to the currently promoted generation", () => {
    const zedbot = path.join(root, "scripts/zedbot.sh");
    const doctor = path.join(root, "scripts/doctor.sh");
    const backupScript = path.join(root, "scripts/backup.sh");
    const backupDbScript = path.join(root, "scripts/backup-db.sh");

    function currentEvidenceFixture(compose: string) {
      const pair = fixture();
      const state = mkdtempSync(path.join(os.tmpdir(), "zedbot-current-evidence-"));
      chmodSync(state, 0o700);
      const generation = "20260101T000000Z-eeeeeeeeeeee";
      const evidence = path.join(state, `evidence-${generation}`);
      renameSync(pair.dir, evidence);
      writeFileSync(path.join(evidence, "docker-compose.yml"), compose);
      const manifestBytes = readFileSync(path.join(evidence, "packages/database/prisma/rollback-compatibility.json"));
      const metadataPath = path.join(state, "current.json");
      writeFileSync(metadataPath, JSON.stringify({
        formatVersion: 2, installationKind: null, lifecycleRole: "current", generation,
        sourceTree: "a".repeat(40), preDeploySha: "e".repeat(40), preDeployImageId: `sha256:${"3".repeat(64)}`,
        targetDeploySha: "b".repeat(40), targetImageId: `sha256:${"1".repeat(64)}`,
        retainedImageTag: `zedbot-app:rollback-${generation}`, immutableImageTag: `zedbot-app:generation-${generation}`,
        failedTargetTag: `zedbot-app:failed-${generation}`, capturedAt: "2026-08-14T12:00:00Z",
        preDeployMigrations: [nameA], declarationFormatVersion: 2, declarationSourceCategory: "generation-evidence",
        migrationEvidencePath: evidence, composeEvidencePath: path.join(evidence, "docker-compose.yml"),
        composeEvidenceSha256: sha(compose), composeProjectName: "zedbot", composeApplicationImage: "zedbot-app:latest",
        compatibilityManifestSha256: sha(manifestBytes), compatibilityDeclarations: pair.declarations,
        recreationAttempted: true, healthConfirmed: true, state: "known-good",
      }));
      chmodSync(metadataPath, 0o600);
      return { state, evidence, generation };
    }

    it("binds to current.json's own evidence, not the checkout default", () => {
      const { state, evidence } = currentEvidenceFixture("services: {promoted: true}\n");
      const command = `. '${common}'; set_deployment_state_paths '${state}'; validate_compose_contract_paths(){ :; }; ZEDBOT_CANONICAL_PROJECT_DIR='/opt/zedbot/app'; ZEDBOT_CANONICAL_COMPOSE_FILE='/opt/zedbot/app/docker-compose.yml'; bind_current_generation_compose_contract && printf '%s' "$ZEDBOT_CANONICAL_COMPOSE_FILE"`;
      const result = spawnSync("bash", ["-c", command], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe(path.join(evidence, "docker-compose.yml"));
    });

    it("falls back to the checkout default when no current.json exists yet (a genuine pre-bootstrap first install)", () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-no-current-"));
      const command = `. '${common}'; set_deployment_state_paths '${dir}'; ZEDBOT_CANONICAL_PROJECT_DIR='/opt/zedbot/app'; ZEDBOT_CANONICAL_COMPOSE_FILE='/opt/zedbot/app/docker-compose.yml'; bind_current_generation_compose_contract && printf '%s' "$ZEDBOT_CANONICAL_COMPOSE_FILE"`;
      const result = spawnSync("bash", ["-c", command], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("/opt/zedbot/app/docker-compose.yml");
    });

    it("hard mode fails closed and soft mode falls back with a warning on invalid current.json", () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-bad-current-"));
      writeFileSync(path.join(dir, "current.json"), "not-json");
      chmodSync(path.join(dir, "current.json"), 0o600);
      const hard = spawnSync("bash", ["-c", `. '${common}'; set_deployment_state_paths '${dir}'; bind_current_generation_compose_contract`], { encoding: "utf8" });
      expect(hard.status).not.toBe(0);
      const soft = spawnSync("bash", ["-c", `. '${common}'; set_deployment_state_paths '${dir}'; ZEDBOT_CANONICAL_PROJECT_DIR='/opt/zedbot/app'; ZEDBOT_CANONICAL_COMPOSE_FILE='/opt/zedbot/app/docker-compose.yml'; bind_current_generation_compose_contract --soft && printf '%s' "$ZEDBOT_CANONICAL_COMPOSE_FILE"`], { encoding: "utf8" });
      expect(soft.status, soft.stderr).toBe(0);
      expect(soft.stdout).toBe("/opt/zedbot/app/docker-compose.yml");
    });

    it("zedbot.sh binds the compose contract before every run_compose-touching command", () => {
      const text = readFileSync(zedbot, "utf8");
      // Anchored on "\n<indent><label>" (the real case-arm indentation,
      // which varies between the outer case and nested SUB cases) - a bare
      // indexOf(label) can false-match prose mentioning the command name,
      // e.g. usage/restore_help text like "(zedbot start)." or "...or logs):".
      function caseBody(label: string): string {
        const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const match = /\n[ ]+/.source + escaped;
        const start = text.search(new RegExp(match));
        expect(start, `case label not found: ${label}`).toBeGreaterThan(-1);
        const nextCase = text.indexOf("\n  ", text.indexOf(";;", start));
        return text.slice(start, nextCase === -1 ? undefined : nextCase);
      }
      for (const label of ["status | ps)", "logs)", "restart)", "start)", "stop)", "shell)"]) {
        const body = caseBody(label);
        const bindIndex = body.indexOf("bind_current_generation_compose_contract");
        const runIndex = body.indexOf("run_compose");
        expect(bindIndex, `${label} does not bind`).toBeGreaterThan(-1);
        expect(runIndex, `${label} does not call run_compose`).toBeGreaterThan(-1);
        expect(bindIndex).toBeLessThan(runIndex);
      }
      for (const label of ["deploy-status)", "verify)", "backups)", "health)"]) {
        expect(caseBody(label).indexOf("bind_current_generation_compose_contract")).toBeGreaterThan(-1);
      }
    });

    it("doctor.sh binds the compose contract (soft) before any run_compose-based check", () => {
      const text = readFileSync(doctor, "utf8");
      const mainStart = text.indexOf("main() {");
      const bindIndex = text.indexOf("bind_current_generation_compose_contract --soft", mainStart);
      const firstCheck = text.indexOf("core_check", mainStart);
      expect(bindIndex).toBeGreaterThan(mainStart);
      expect(bindIndex).toBeLessThan(firstCheck);
    });

    // Regression: after a successful rollback the persistent checkout
    // intentionally stays on the NEWER commit (checkouts only ever
    // fast-forward), while current.json and the running containers
    // correctly describe the OLDER, rolled-back-to generation. Comparing
    // container GIT_SHA against repo_head_sha() there warned on every
    // healthy rolled-back deployment and told the operator to run
    // `zedbot update`, which would simply redeploy the version they just
    // rolled back from.
    it("doctor.sh derives the expected version from current.json when canonical deployment state exists", () => {
      const text = readFileSync(doctor, "utf8");
      const snippetStart = text.indexOf("local head_sha", text.indexOf("main() {"));
      const snippetEnd = text.indexOf('report_version_row worker "$head_sha"') + 'report_version_row worker "$head_sha"'.length;
      expect(snippetStart).toBeGreaterThan(-1);
      const snippet = text.slice(snippetStart, snippetEnd);
      expect(snippet).toContain("validate_generation_metadata_core");
      expect(snippet).toContain(".targetDeploySha");

      // validate_canonical_state_destination requires current.json to sit
      // directly under $ZEDBOT_DEPLOYMENT_DIR, so the fixture is written
      // straight into this test's own deployment-state directory rather
      // than pointed at externally.
      const rolledBackGeneration = "20260101T000000Z-aaaaaaaaaaaa";
      const targetDeploySha = "b".repeat(40);
      const run = (withCurrentJson: boolean) => {
        const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-doctor-version-"));
        chmodSync(dir, 0o700);
        if (withCurrentJson) {
          const currentPath = path.join(dir, "current.json");
          writeFileSync(currentPath, JSON.stringify({
            formatVersion: 2, lifecycleRole: "current", generation: rolledBackGeneration, sourceTree: "a".repeat(40),
            preDeploySha: "1".repeat(40), preDeployImageId: `sha256:${"2".repeat(64)}`, targetDeploySha,
            targetImageId: `sha256:${"3".repeat(64)}`, retainedImageTag: `zedbot-app:rollback-${rolledBackGeneration}`,
            immutableImageTag: `zedbot-app:generation-${rolledBackGeneration}`, failedTargetTag: `zedbot-app:failed-${rolledBackGeneration}`,
            capturedAt: "2026-01-01T00:00:00Z", preDeployMigrations: [], declarationFormatVersion: 2, declarationSourceCategory: "generation-evidence",
            migrationEvidencePath: `${dir}/evidence-${rolledBackGeneration}`, composeEvidencePath: `${dir}/evidence-${rolledBackGeneration}/docker-compose.yml`,
            composeEvidenceSha256: "4".repeat(64), composeProjectName: "zedbot", composeApplicationImage: "zedbot-app:latest",
            compatibilityManifestSha256: "5".repeat(64), compatibilityDeclarations: [],
            recreationAttempted: true, healthConfirmed: true, state: "known-good",
          }));
          chmodSync(currentPath, 0o600);
        }
        const command = `. '${common}'; set_deployment_state_paths '${dir}'; repo_head_sha(){ printf '%s' '${"c".repeat(40)}'; }; report_version_row(){ printf '%s:%s\\n' "$1" "$2"; }; run_snippet(){ ${snippet}\n}; run_snippet`;
        return spawnSync("bash", ["-c", command], { encoding: "utf8" });
      };

      const withCurrent = run(true);
      expect(withCurrent.status, withCurrent.stderr).toBe(0);
      expect(withCurrent.stdout).toContain(`bot:${targetDeploySha}`);
      expect(withCurrent.stdout).toContain(`worker:${targetDeploySha}`);
      expect(withCurrent.stdout).not.toContain("c".repeat(40));

      const withoutCurrent = run(false);
      expect(withoutCurrent.status, withoutCurrent.stderr).toBe(0);
      expect(withoutCurrent.stdout).toContain(`bot:${"c".repeat(40)}`);
      expect(withoutCurrent.stdout).toContain(`worker:${"c".repeat(40)}`);
    });

    it("backup.sh binds the compose contract before its own pg_dump call", () => {
      const text = readFileSync(backupScript, "utf8");
      const bindIndex = text.indexOf("bind_current_generation_compose_contract");
      const dumpIndex = text.indexOf("pg_dump", bindIndex + 1);
      expect(bindIndex).toBeGreaterThan(-1);
      expect(dumpIndex).toBeGreaterThan(bindIndex);
    });

    it("backup-db.sh binds the compose contract before main() touches postgres", () => {
      // main() calls compose_service_running/run_compose by name; the
      // literal pg_dump/run_compose invocations live in helper functions
      // defined (and hence textually positioned) earlier in the file, so
      // main()'s own call order - not raw text order across the whole
      // file - is what determines execution order here.
      const text = readFileSync(backupDbScript, "utf8");
      const mainStart = text.indexOf("main() {");
      const bindIndex = text.indexOf("bind_current_generation_compose_contract", mainStart);
      const firstMainComposeCall = text.indexOf("compose_service_running", mainStart);
      expect(bindIndex).toBeGreaterThan(mainStart);
      expect(firstMainComposeCall).toBeGreaterThan(bindIndex);
    });

    // Regression: perform_rollback's compatibility check was documented as
    // running "under the CURRENT generation's own Compose contract", but
    // nothing actually bound it there - it just trusted ZEDBOT_CANONICAL_
    // COMPOSE_FILE's default (the persistent checkout's own docker-
    // compose.yml), which is only accurate as long as sync_deployment_
    // checkout has kept the checkout fast-forwarded. That sync is best-
    // effort - it logs a warning and continues on failure, not one that
    // aborts the update - so a prior update whose sync step failed would
    // leave validate_compatibility silently running against a stale
    // Compose definition (wrong commands, mounts, or environment),
    // potentially accepting or rejecting a rollback on the wrong evidence.
    it("rollback.sh binds the compose contract to current.json's own evidence before checking compatibility", () => {
      const rollbackText = readFileSync(rollback, "utf8");
      const perform = rollbackText.slice(rollbackText.indexOf("perform_rollback() {"), rollbackText.indexOf("\nmain() {"));
      const evidenceCheck = perform.indexOf("validate_generation_owned_evidence_readonly");
      const bindIndex = perform.indexOf("bind_current_generation_compose_contract");
      const compatibilityCheck = perform.indexOf("\n    validate_compatibility\n");
      const contractSwitch = perform.indexOf("\n  configure_rollback_compose_contract\n");
      expect(evidenceCheck).toBeGreaterThan(-1);
      expect(bindIndex).toBeGreaterThan(evidenceCheck);
      expect(bindIndex).toBeLessThan(compatibilityCheck);
      expect(compatibilityCheck).toBeLessThan(contractSwitch);
    });
  });
});
