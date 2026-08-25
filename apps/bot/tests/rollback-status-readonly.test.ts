import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const common = path.join(root, "scripts/lib/common.sh");
const rollback = path.join(root, "scripts/rollback.sh");
const currentGeneration = "20260813T120000Z-aaaaaaaaaaaa";
const previousGeneration = "20260812T120000Z-bbbbbbbbbbbb";
const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

type Fixture = { dir: string; current: string; previous: string; lock: string };
function write(file: string, value: unknown | string) {
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); chmodSync(file, 0o600);
}
function generationEvidence(dir: string, generation: string) {
  const evidence = path.join(dir, `evidence-${generation}`);
  mkdirSync(path.join(evidence, "packages/database"), { recursive: true });
  cpSync(path.join(root, "packages/database/prisma"), path.join(evidence, "packages/database/prisma"), { recursive: true });
  cpSync(path.join(root, "docker-compose.yml"), path.join(evidence, "docker-compose.yml"));
  const manifest = path.join(evidence, "packages/database/prisma/rollback-compatibility.json");
  const declarations = JSON.parse(readFileSync(manifest, "utf8")).backwardCompatibleMigrations;
  return { evidence, declarations, manifestHash: sha256(manifest), composeHash: sha256(path.join(evidence, "docker-compose.yml")) };
}
function metadata(dir: string, generation: string, role: "current" | "previous") {
  const ev = generationEvidence(dir, generation);
  return {
    formatVersion: 2, lifecycleRole: role, generation, sourceTree: "c".repeat(40), preDeploySha: (role === "current" ? "b" : "a").repeat(40),
    preDeployImageId: `sha256:${role === "current" ? "3".repeat(64) : "1".repeat(64)}`, targetDeploySha: "b".repeat(40), targetImageId: `sha256:${role === "current" ? "2".repeat(64) : "3".repeat(64)}`,
    retainedImageTag: `zedbot-app:rollback-${generation}`, immutableImageTag: `zedbot-app:generation-${generation}`,
    failedTargetTag: `zedbot-app:failed-${generation}`, capturedAt: "2026-08-13T12:00:00Z", preDeployMigrations: ev.declarations.map((d: { name: string }) => d.name),
    declarationFormatVersion: 2, declarationSourceCategory: "generation-evidence", migrationEvidencePath: ev.evidence,
    composeEvidencePath: path.join(ev.evidence, "docker-compose.yml"), composeEvidenceSha256: ev.composeHash,
    composeProjectName: "zedbot", composeApplicationImage: "zedbot-app:latest", compatibilityManifestSha256: ev.manifestHash,
    compatibilityDeclarations: ev.declarations, recreationAttempted: true, healthConfirmed: true, state: "known-good",
  };
}
function fixture(includePrevious = true): Fixture {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-area11-")); chmodSync(dir, 0o700);
  const f = { dir, current: path.join(dir, "current.json"), previous: path.join(dir, "previous.json"), lock: path.join(dir, "deployment.lock") };
  write(f.current, metadata(dir, currentGeneration, "current"));
  if (includePrevious) write(f.previous, metadata(dir, previousGeneration, "previous"));
  return f;
}
function status(f: Fixture, extra = "", mode = "--json") {
  return spawnSync("bash", ["-c", `. '${rollback}'; set_deployment_state_paths '${f.dir}'; ${extra ? `${extra};` : ""} show_status '${mode}'`], { encoding: "utf8", env: process.env });
}
function parsed(f: Fixture, extra = "") { const result = status(f, extra); return { result, json: JSON.parse(result.stdout) }; }
function snapshot(dir: string): string {
  const rows: string[] = [];
  function walk(entry: string) {
    const st = lstatSync(entry); const rel = path.relative(dir, entry) || ".";
    rows.push([rel, st.mode, st.uid, st.gid, st.ino, st.size, st.mtimeNs, st.ctimeNs, st.isSymbolicLink() ? readFileSync(entry, { encoding: "utf8", flag: "r" }) : st.isFile() ? createHash("sha256").update(readFileSync(entry)).digest("hex") : ""].join(":"));
    if (st.isDirectory()) for (const name of readdirSync(entry).sort()) walk(path.join(entry, name));
  }
  walk(dir); return rows.join("\n");
}

describe("Area 11 authoritative rollback status", () => {
  it("reports complete canonical evidence available with stable schema and exit zero", () => {
    const f = fixture(); const { result, json } = parsed(f);
    expect(result.status, result.stderr).toBe(0); expect(json.schema).toBe("zedbot.rollback-status/v1"); expect(json.schemaVersion).toBe(1); expect(json.rollbackStatus).toBe("available"); expect(json.eligible).toBe(true);
    expect(json.reasonCode).toBe("ELIGIBLE"); expect(json.currentGeneration).toBe(currentGeneration); expect(json.previousGeneration).toBe(previousGeneration);
    expect(Object.values(json.evidence).every(Boolean)).toBe(true);
  });
  it("derives human output from the same result", () => { const f = fixture(); const machine = parsed(f).json; const human = status(f, "", "--human"); expect(human.status).toBe(0); expect(human.stdout).toContain(`Rollback status: ${machine.rollbackStatus}`); expect(human.stdout).toContain(`Reason: ${machine.reason}`); });
  it("is deterministic across repeated observations", () => { const f = fixture(); expect(status(f).stdout).toBe(status(f).stdout); });
  it("uses distinct documented exits", () => { const unavailable = fixture(false); expect(status(unavailable).status).toBe(2); write(unavailable.previous, "{"); expect(status(unavailable).status).toBe(3); expect(status(unavailable, "", "--bad").status).toBe(4); });
  it("uses null eligibility when authoritative evidence is indeterminate", () => { const f = fixture(); write(f.previous, "{"); const out = parsed(f); expect(out.result.status).toBe(3); expect(out.json.eligible).toBeNull(); });

  it("reports genuine empty state unavailable without creating it", () => { const dir = path.join(os.tmpdir(), `zedbot-area11-missing-${process.pid}-${Date.now()}`); const f = { dir, current: path.join(dir, "current.json"), previous: path.join(dir, "previous.json"), lock: path.join(dir, "deployment.lock") }; const out = parsed(f); expect(out.result.status).toBe(2); expect(out.json.reasonCode).toBe("FIRST_INSTALL_EMPTY"); expect(existsSync(dir)).toBe(false); });
  it("reports a canonical first install without previous unavailable", () => { const f = fixture(false); const out = parsed(f); expect(out.result.status).toBe(2); expect(out.json.reasonCode).toBe("NO_PREVIOUS_GENERATION"); });
  it("does not mistake missing current plus other evidence for first install", () => { const f = fixture(); rmSync(f.current); const out = parsed(f); expect(out.result.status).toBe(3); expect(out.json.reasonCode).toBe("PARTIAL_INSTALLATION_EVIDENCE"); });
  it("reports valid unconverted legacy evidence blocked", () => { const f = fixture(false); rmSync(f.current); write(path.join(f.dir, "legacy-install-v1.json"), metadata(f.dir, currentGeneration, "current")); const out = parsed(f); expect(out.result.status).toBe(2); expect(out.json.reasonCode).toBe("LEGACY_NOT_CONVERTED"); });
  it("reports valid incomplete bootstrap blocked", () => { const f = fixture(); rmSync(f.dir, { recursive: true }); mkdirSync(f.dir, { mode: 0o700 }); write(path.join(f.dir, "bootstrap.json"), { formatVersion: 1, kind: "first-install", phase: "initialized", generation: currentGeneration, sourceSha: "a".repeat(40), sourceTree: "b".repeat(40), operation: "11111111-1111-4111-8111-111111111111" }); const out = parsed(f); expect(out.result.status).toBe(2); expect(out.json.reasonCode).toBe("OPERATION_INCOMPLETE"); });
  it("keeps converted legacy current without real previous unavailable", () => { const f = fixture(false); cpSync(f.current, path.join(f.dir, "legacy-install-v1.json")); write(path.join(f.dir, "bootstrap.json"), { formatVersion: 1, kind: "legacy-upgrade", phase: "promoted", generation: currentGeneration, sourceSha: "a".repeat(40), sourceTree: "b".repeat(40), operation: "11111111-1111-4111-8111-111111111111" }); const out = parsed(f); expect(out.result.status).toBe(2); expect(out.json.reasonCode).toBe("NO_PREVIOUS_GENERATION"); });
  it("evaluates a valid completed legacy conversion normally", () => { const f = fixture(); cpSync(f.current, path.join(f.dir, "legacy-install-v1.json")); write(path.join(f.dir, "bootstrap.json"), { formatVersion: 1, kind: "legacy-upgrade", phase: "promoted", generation: currentGeneration, sourceSha: "a".repeat(40), sourceTree: "b".repeat(40), operation: "11111111-1111-4111-8111-111111111111" }); expect(status(f).status).toBe(0); });
  // Regression: bootstrap.json/legacy-install-v1.json are permanent
  // provenance written once at conversion and never updated again, while
  // current.json's generation advances on every later update. This must
  // stay available after a later update moved current.json past the
  // conversion's own (unchanged) generation - not be rejected as mixed
  // evidence forever.
  it("evaluates a completed legacy conversion normally after a later update moved current past it", () => {
    const f = fixture();
    const legacyGeneration = "20260811T120000Z-cccccccccccc";
    write(path.join(f.dir, "legacy-install-v1.json"), metadata(f.dir, legacyGeneration, "current"));
    write(path.join(f.dir, "bootstrap.json"), { formatVersion: 1, kind: "legacy-upgrade", phase: "promoted", generation: legacyGeneration, sourceSha: "a".repeat(40), sourceTree: "b".repeat(40), operation: "11111111-1111-4111-8111-111111111111" });
    const out = parsed(f);
    expect(out.result.status, out.result.stderr).toBe(0);
    expect(out.json.rollbackStatus).toBe("available");
  });

  it.each([["empty", ""], ["truncated", "{"], ["malformed", "not-json"]])("rejects %s current metadata", (_name, value) => { const f = fixture(); write(f.current, value); expect(parsed(f).json.reasonCode).toBe("INVALID_CURRENT_METADATA"); });
  it.each([["empty", ""], ["truncated", "{"], ["malformed", "not-json"]])("rejects %s previous metadata", (_name, value) => { const f = fixture(); write(f.previous, value); expect(parsed(f).json.reasonCode).toBe("INVALID_PREVIOUS_METADATA"); });
  it.each([["current", "previous"], ["previous", "current"]] as const)("rejects %s role mismatch", (which, role) => { const f = fixture(); const file = which === "current" ? f.current : f.previous; const value = JSON.parse(readFileSync(file, "utf8")); value.lifecycleRole = role; write(file, value); expect(status(f).status).not.toBe(0); });
  it("rejects equal current and previous generation", () => { const f = fixture(); write(f.previous, { ...JSON.parse(readFileSync(f.previous, "utf8")), generation: currentGeneration }); expect(status(f).status).not.toBe(0); });
  it.each(["preDeploySha", "preDeployImageId"])("rejects a current generation not bound to previous %s", (field) => { const f = fixture(); const value = JSON.parse(readFileSync(f.current, "utf8")); value[field] = field === "preDeploySha" ? "f".repeat(40) : `sha256:${"f".repeat(64)}`; write(f.current, value); expect(parsed(f).json.reasonCode).toBe("ROLLBACK_EVIDENCE_MISMATCH"); });
  it.each(["sourceTree", "targetImageId", "composeEvidenceSha256", "compatibilityManifestSha256"])("rejects missing or changed %s evidence", (field) => { const f = fixture(); const value = JSON.parse(readFileSync(f.previous, "utf8")); delete value[field]; write(f.previous, value); expect(status(f).status).not.toBe(0); });
  it("rejects changed migration bytes", () => { const f = fixture(); const migrations = path.join(JSON.parse(readFileSync(f.previous, "utf8")).migrationEvidencePath, "packages/database/prisma/migrations"); const migration = path.join(migrations, readdirSync(migrations).sort()[0], "migration.sql"); writeFileSync(migration, Buffer.concat([readFileSync(migration), Buffer.from([0])])); expect(status(f).status).not.toBe(0); });
  it("rejects changed Compose evidence", () => { const f = fixture(); writeFileSync(JSON.parse(readFileSync(f.previous, "utf8")).composeEvidencePath, "services: {}\n"); expect(status(f).status).not.toBe(0); });
  it("rejects oversized metadata without echoing it", () => { const f = fixture(); write(f.previous, `{"secret":"${"x".repeat(1048577)}"}`); const out = status(f); expect(out.status).toBe(3); expect(out.stdout.length).toBeLessThan(2000); expect(out.stdout).not.toContain("xxxx"); });
  it.each(["current", "previous"])("rejects symlinked %s metadata", (which) => { const f = fixture(); const file = which === "current" ? f.current : f.previous; const target = `${file}.target`; cpSync(file, target); rmSync(file); symlinkSync(target, file); expect(status(f).status).toBe(3); });
  it("rejects a symlinked state parent", () => { const f = fixture(); const parent = mkdtempSync(path.join(os.tmpdir(), "zedbot-area11-parent-")); const link = path.join(parent, "state"); symlinkSync(f.dir, link); const linked = { dir: link, current: path.join(link, "current.json"), previous: path.join(link, "previous.json"), lock: path.join(link, "deployment.lock") }; expect(status(linked).status).toBe(3); });
  it("detects identity-changing evidence during the bounded read", () => { const f = fixture(); const extra = `rollback_status_read_observer(){ if [ "$1" = '${f.previous}' ]; then cp '${f.previous}' '${f.previous}.new'; chmod 600 '${f.previous}.new'; mv '${f.previous}.new' '${f.previous}'; fi; }`; expect(status(f, extra).status).toBe(3); });
  it("detects disappearing evidence during the bounded read", () => { const f = fixture(); const extra = `rollback_status_read_observer(){ [ "$1" != '${f.previous}' ] || rm -f '${f.previous}'; }`; expect(status(f, extra).status).toBe(3); });

  // Regression: a successful install/update/rollback always writes
  // bot-recreation.json (record_bot_recreation_boundary), but this allowlist
  // never accepted it, so every healthy installation permanently reported
  // PARTIAL_INSTALLATION_EVIDENCE instead of available.
  it("accepts a genuine bot recreation boundary bound to the current generation", () => {
    const f = fixture();
    write(path.join(f.dir, "bot-recreation.json"), {
      formatVersion: 1, operation: `update:${currentGeneration}`, generation: currentGeneration,
      containerId: "c".repeat(64), imageId: `sha256:${"4".repeat(64)}`, imageRef: "zedbot-app:latest",
      project: "zedbot", service: "bot", recreatedAt: 1,
    });
    const out = parsed(f);
    expect(out.result.status, out.result.stderr).toBe(0);
    expect(out.json.rollbackStatus).toBe("available");
  });
  it.each([
    ["wrong generation", { generation: previousGeneration }],
    ["bad imageId", { imageId: "sha256:not-hex" }],
    ["wrong imageRef", { imageRef: "zedbot-app:candidate" }],
  ])("rejects an invalid bot recreation boundary: %s", (_name, override) => {
    const f = fixture();
    write(path.join(f.dir, "bot-recreation.json"), {
      formatVersion: 1, operation: `update:${currentGeneration}`, generation: currentGeneration,
      containerId: "c".repeat(64), imageId: `sha256:${"4".repeat(64)}`, imageRef: "zedbot-app:latest",
      project: "zedbot", service: "bot", recreatedAt: 1, ...override,
    });
    const out = parsed(f);
    expect(out.result.status).toBe(3);
    expect(out.json.reasonCode).toBe("INVALID_BOT_RECREATION_EVIDENCE");
  });
  // Regression: evidence-<generation> directories are never pruned once a
  // generation ages out of current/previous (persist_migration_declaration_
  // evidence creates them; nothing deletes them). A retained directory from
  // an older, no-longer-referenced generation is expected, ordinary state
  // -not ambiguity- and must not permanently block rollback-status.
  it("does not treat a retained evidence directory from an aged-out generation as ambiguous", () => {
    const f = fixture();
    generationEvidence(f.dir, "20260811T120000Z-cccccccccccc");
    const out = parsed(f);
    expect(out.result.status, out.result.stderr).toBe(0);
    expect(out.json.rollbackStatus).toBe("available");
  });
});

describe("Area 11 strict read-only and execution consistency", () => {
  it("leaves the complete application-controlled filesystem snapshot unchanged", () => { const f = fixture(); const before = snapshot(f.dir); expect(status(f).status).toBe(0); expect(snapshot(f.dir)).toBe(before); });
  it("does not create, acquire, or release a missing operation lock", () => { const f = fixture(); expect(existsSync(f.lock)).toBe(false); expect(status(f).status).toBe(0); expect(existsSync(f.lock)).toBe(false); });
  it.each(["regular", "malformed", "symlink"])("does not modify or remove an existing %s lock", (kind) => { const f = fixture(); const target = `${f.lock}.target`; if (kind === "symlink") { write(target, "foreign"); symlinkSync(target, f.lock); } else write(f.lock, kind === "regular" ? "foreign-owner" : "{"); const before = snapshot(f.dir); status(f); expect(snapshot(f.dir)).toBe(before); });
  it("never invokes mutating, infrastructure, recovery, readiness, or trap helpers", () => { const f = fixture(); const trace = path.join(os.tmpdir(), `zedbot-area11-trace-${process.pid}-${Date.now()}`); const names = ["acquire_deployment_lock", "release_deployment_lock", "atomic_write_metadata", "install_operation_traps", "recover_metadata_transition", "convert_supported_legacy_installation", "begin_installation_bootstrap", "run_clean_docker", "run_compose", "recreate_application_services", "validate_running_application", "run_real_bot_readiness", "operation_mktemp"]; const overrides = names.map((n) => `${n}(){ echo ${n} >> '${trace}'; return 99; }`).join(";"); expect(status(f, overrides).status).toBe(0); expect(existsSync(trace)).toBe(false); });
  it.each(["candidate-20260813T130000Z-cccccccccccc.json", "transition.json", "operation-state.json"])("blocks conflicting operation artifact %s", (name) => { const f = fixture(); write(path.join(f.dir, name), {}); const out = parsed(f); expect(out.result.status).toBe(2); expect(out.json.reasonCode).toBe("OPERATION_INCOMPLETE"); });
  // Regression: resolve_failed_generation_after_rollback deliberately
  // PRESERVES failed.json (state "rolled-back") once a rollback has durably
  // promoted the matching generation, and assert_no_unresolved_failed_
  // generation explicitly permits that resolved state too - its mere
  // presence must not block rollback-status forever after an otherwise
  // fully successful recovery. An UNRESOLVED failed.json (any other state)
  // still blocks exactly as before, and one that fails to validate at all
  // still fails closed (distinctly, as invalid evidence rather than a
  // generic incomplete-operation block).
  it("an unresolved failed.json still blocks, a resolved one does not, and invalid failed.json fails closed distinctly", () => {
    const failedMetadata = (state: string) => ({
      formatVersion: 2, lifecycleRole: "failed", generation: "20260813T130000Z-cccccccccccc", sourceTree: "c".repeat(40),
      preDeploySha: "a".repeat(40), preDeployImageId: `sha256:${"1".repeat(64)}`, targetDeploySha: "b".repeat(40), targetImageId: `sha256:${"2".repeat(64)}`,
      retainedImageTag: "zedbot-app:rollback-20260813T130000Z-cccccccccccc", immutableImageTag: "zedbot-app:generation-20260813T130000Z-cccccccccccc",
      failedTargetTag: "zedbot-app:failed-20260813T130000Z-cccccccccccc", capturedAt: "2026-08-13T13:00:00Z", preDeployMigrations: [],
      declarationFormatVersion: 2, declarationSourceCategory: "generation-evidence",
      migrationEvidencePath: "/state/evidence-20260813T130000Z-cccccccccccc", composeEvidencePath: "/state/evidence-20260813T130000Z-cccccccccccc/docker-compose.yml",
      composeEvidenceSha256: "d".repeat(64), composeProjectName: "zedbot", composeApplicationImage: "zedbot-app:latest",
      compatibilityManifestSha256: "e".repeat(64), compatibilityDeclarations: [], recreationAttempted: true, healthConfirmed: false, state,
      rollbackTargetGeneration: currentGeneration, rollbackTargetImageId: `sha256:${"1".repeat(64)}`,
    });
    const unresolved = fixture(); write(path.join(unresolved.dir, "failed.json"), failedMetadata("failed-after-recreation"));
    const unresolvedOut = parsed(unresolved);
    expect(unresolvedOut.result.status).toBe(2); expect(unresolvedOut.json.reasonCode).toBe("OPERATION_INCOMPLETE");

    const resolved = fixture(); write(path.join(resolved.dir, "failed.json"), failedMetadata("rolled-back"));
    const resolvedOut = parsed(resolved);
    expect(resolvedOut.result.status).not.toBe(2); expect(resolvedOut.json.reasonCode).not.toBe("OPERATION_INCOMPLETE");

    const invalid = fixture(); write(path.join(invalid.dir, "failed.json"), {});
    const invalidOut = parsed(invalid);
    expect(invalidOut.result.status).toBe(3); expect(invalidOut.json.reasonCode).toBe("INVALID_FAILED_EVIDENCE");
  });
  it.each([".temporary-status.json", "readiness-success.json", "evidence-orphan"])("fails closed for unsupported or unbound artifact %s", (name) => { const f = fixture(); const target = path.join(f.dir, name); if (name.startsWith("evidence-")) mkdirSync(target); else write(target, {}); const out = parsed(f); expect(out.result.status).toBe(3); expect(out.json.reasonCode).toBe("PARTIAL_INSTALLATION_EVIDENCE"); expect(out.json.eligible).toBeNull(); });
  it("does not consult live Compose project or runtime configuration", () => { const f = fixture(); const trace = path.join(os.tmpdir(), `zedbot-area11-live-compose-${process.pid}-${Date.now()}`); const out = status(f, `validate_compose_contract_paths(){ echo called > '${trace}'; return 99; }`); expect(out.status).toBe(0); expect(existsSync(trace)).toBe(false); });
  it("shares the pure mandatory evidence validator with actual rollback", () => { const f = fixture(); const result = spawnSync("bash", ["-c", `. '${common}'; set_deployment_state_paths '${f.dir}'; validate_rollback_eligibility_evidence '${f.current}' '${f.previous}'`], { encoding: "utf8" }); expect(result.status).toBe(0); expect(readFileSync(rollback, "utf8")).toContain('validate_rollback_eligibility_evidence "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" "$ZEDBOT_ROLLBACK_METADATA"'); });
  it("status is informational and never persisted as authorization", () => { const f = fixture(); expect(status(f).status).toBe(0); expect(readdirSync(f.dir).some((name) => /status|authorization|report|cache/.test(name))).toBe(false); });
  it.each(["DOCKER_IMAGE=zedbot-app:latest", "CONTAINER_ID=fake", "INSTALL_DATE=now", "DATABASE_URL=redacted", "BOT_TOKEN=redacted"])("does not infer or expose eligibility from %s", (claim) => { const f = fixture(false); const out = status(f, claim); expect(out.status).toBe(2); expect(out.stdout).not.toContain("redacted"); });
  it("never emits raw invalid metadata or sensitive lock details", () => { const f = fixture(); write(f.previous, { credential: "secret-shaped-value", pid: 999999, hostname: "private-host", path: "/sensitive/path" }); write(f.lock, "foreign-lock-token"); const out = status(f); for (const forbidden of ["secret-shaped", "999999", "private-host", "/sensitive/path", "foreign-lock-token"]) expect(out.stdout + out.stderr).not.toContain(forbidden); });
  it("keeps rollback recreation and readiness enforcement unchanged", () => { const text = readFileSync(path.join(root, "scripts/lib/common.sh"), "utf8") + readFileSync(rollback, "utf8"); expect(text).toContain("--force-recreate api bot worker"); expect(text).toContain("validate_running_application"); expect(text).not.toContain("--force-recreate postgres"); expect(text).not.toContain("--force-recreate redis"); });
});
