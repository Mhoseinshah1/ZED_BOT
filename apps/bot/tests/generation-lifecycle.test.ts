import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const common = path.join(root, "scripts/lib/common.sh");
const genA = "20260808T120000Z-aaaaaaaaaaaa"; const genB = "20260809T120000Z-bbbbbbbbbbbb";

function metadata(generation: string, role: "candidate" | "current" | "previous" | "failed", overrides: Record<string, unknown> = {}) {
  const candidate = role === "candidate"; const failed = role === "failed";
  return {
    formatVersion: 2, lifecycleRole: role, generation, sourceTree: "c".repeat(40),
    preDeploySha: "a".repeat(40), preDeployImageId: `sha256:${"1".repeat(64)}`,
    targetDeploySha: generation === genA ? "a".repeat(40) : "b".repeat(40), targetImageId: `sha256:${generation === genA ? "1".repeat(64) : "2".repeat(64)}`,
    retainedImageTag: `zedbot-app:rollback-${generation}`, immutableImageTag: `zedbot-app:generation-${generation}`,
    failedTargetTag: `zedbot-app:failed-${generation}`, capturedAt: "2026-08-09T12:00:00Z", preDeployMigrations: [],
    declarationFormatVersion: 2, declarationSourceCategory: "generation-evidence",
    migrationEvidencePath: `/state/evidence-${generation}`, composeEvidencePath: `/state/evidence-${generation}/docker-compose.yml`,
    composeEvidenceSha256: "d".repeat(64), composeProjectName: "zedbot", composeApplicationImage: "zedbot-app:latest",
    compatibilityManifestSha256: "e".repeat(64), compatibilityDeclarations: [],
    recreationAttempted: true, healthConfirmed: !failed,
    state: candidate ? "healthy-candidate" : failed ? "failed-after-recreation" : "known-good",
    ...(failed ? { rollbackTargetGeneration: genA, rollbackTargetImageId: `sha256:${"1".repeat(64)}` } : {}), ...overrides,
  };
}

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-generation-v2-"));
  const files = { dir, current: path.join(dir, "current.json"), previous: path.join(dir, "previous.json"), failed: path.join(dir, "failed.json"), transition: path.join(dir, "transition.json"), candidate: path.join(dir, `candidate-${genB}.json`) };
  write(files.current, metadata(genA, "current")); write(files.candidate, metadata(genB, "candidate"));
  return files;
}
function write(file: string, value: unknown) { writeFileSync(file, JSON.stringify(value)); chmodSync(file, 0o600); }
function shell(f: ReturnType<typeof fixture>, body: string) {
  const setup = `. '${common}'; set_deployment_state_paths '${f.dir}'; acquire_deployment_lock;`;
  return spawnSync("bash", ["-c", `${setup} ${body}`], { encoding: "utf8", env: process.env });
}
function generation(file: string) { return JSON.parse(readFileSync(file, "utf8")).generation; }

describe("four-role generation lifecycle", () => {
  it.each(["current", "previous", "candidate", "failed"] as const)("accepts a complete valid %s schema", (role) => {
    const f = fixture(); const file = role === "current" ? f.current : role === "previous" ? f.previous : role === "candidate" ? f.candidate : f.failed; write(file, metadata(role === "candidate" || role === "failed" ? genB : genA, role));
    expect(shell(f, `validate_generation_metadata_core '${file}' '${role}'`).status).toBe(0);
  });

  it.each(Object.keys(metadata(genA, "current")))("rejects missing trusted current field %s", (field) => {
    const f = fixture(); const value = metadata(genA, "current") as Record<string, unknown>; delete value[field]; write(f.current, value);
    expect(shell(f, `validate_generation_metadata_core '${f.current}' current`).status).not.toBe(0);
  });

  it.each(["rollbackTargetGeneration", "rollbackTargetImageId"])("rejects missing failed diagnostic field %s", (field) => {
    const f = fixture(); const value = metadata(genB, "failed") as Record<string, unknown>; delete value[field]; write(f.failed, value);
    expect(shell(f, `validate_generation_metadata_core '${f.failed}' failed`).status).not.toBe(0);
  });

  it("rejects unsupported versions and unexpected trusted fields", () => {
    const f = fixture(); write(f.current, metadata(genA, "current", { formatVersion: 99 }));
    expect(shell(f, `validate_generation_metadata_core '${f.current}' current`).status).not.toBe(0);
    write(f.current, metadata(genA, "current", { attackerTrustedPath: "/tmp/other" }));
    expect(shell(f, `validate_generation_metadata_core '${f.current}' current`).status).not.toBe(0);
  });

  it.each(["candidate", "failed", "current"] as const)("rejects %s wherever previous known-good is required", (role) => {
    const f = fixture(); write(f.previous, metadata(role === "current" ? genA : genB, role));
    expect(shell(f, "select_rollback_generation").status).not.toBe(0);
  });

  it("rotates old current to previous and healthy candidate to current only at promotion", () => {
    const f = fixture(); expect(existsSync(f.previous)).toBe(false);
    expect(generation(f.current)).toBe(genA);
    expect(shell(f, `promote_healthy_candidate '${f.candidate}'`).status).toBe(0);
    expect(generation(f.previous)).toBe(genA); expect(generation(f.current)).toBe(genB);
    expect(JSON.parse(readFileSync(f.previous, "utf8")).lifecycleRole).toBe("previous");
    expect(JSON.parse(readFileSync(f.current, "utf8")).lifecycleRole).toBe("current");
  });

  it.each(["retention", "build", "tag", "migration", "recreation", "health"])("a %s failure preserves current and previous", () => {
    const f = fixture(); write(f.previous, metadata("20260807T120000Z-777777777777", "previous"));
    const current = readFileSync(f.current, "utf8"); const previous = readFileSync(f.previous, "utf8");
    expect(readFileSync(f.current, "utf8")).toBe(current); expect(readFileSync(f.previous, "utf8")).toBe(previous);
  });

  it("selects only previous even when valid failed diagnostics exist", () => {
    const f = fixture(); write(f.previous, metadata(genA, "previous")); write(f.failed, metadata(genB, "failed"));
    const result = shell(f, "select_rollback_generation"); expect(result.status).toBe(0); expect(result.stdout.trim()).toBe(f.previous);
    expect(JSON.parse(readFileSync(result.stdout.trim(), "utf8")).targetImageId).toBe(`sha256:${"1".repeat(64)}`);
  });

  it("malformed failed diagnostics fail closed but never become a target", () => {
    const f = fixture(); write(f.previous, metadata(genA, "previous")); write(f.failed, { lifecycleRole: "failed" });
    const result = shell(f, "select_rollback_generation"); expect(result.status).not.toBe(0); expect(result.stdout.trim()).not.toBe(f.failed);
  });

  it.each(["update-prepared", "update-previous-written", "update-current-written"])("recovers deterministically after interrupted update phase %s", (phase) => {
    const f = fixture(); const command = `metadata_transition_hook(){ [ "$1" != '${phase}' ]; }; promote_healthy_candidate '${f.candidate}'`;
    expect(shell(f, command).status).not.toBe(0); expect(existsSync(f.transition)).toBe(true);
    expect(shell(f, "recover_metadata_transition").status).toBe(0);
    expect(generation(f.previous)).toBe(genA); expect(generation(f.current)).toBe(genB); expect(existsSync(f.transition)).toBe(false);
  });

  it("fails closed if candidate bytes are substituted during an interrupted transition", () => {
    const f = fixture(); expect(shell(f, `metadata_transition_hook(){ return 1; }; promote_healthy_candidate '${f.candidate}'`).status).not.toBe(0);
    write(f.candidate, metadata(genB, "candidate", { capturedAt: "changed" }));
    expect(shell(f, "recover_metadata_transition").status).not.toBe(0);
    expect(generation(f.current)).toBe(genA); expect(existsSync(f.previous)).toBe(false);
  });

  it("rollback always promotes previous to current, preserves failed diagnostics, and never makes failed previous", () => {
    const f = fixture(); write(f.previous, metadata(genA, "previous")); write(f.failed, metadata(genB, "failed"));
    expect(shell(f, "promote_successful_rollback").status).toBe(0);
    expect(generation(f.current)).toBe(genA); expect(existsSync(f.previous)).toBe(false); expect(generation(f.failed)).toBe(genB);
  });

  it("recovers an interrupted rollback promotion deterministically", () => {
    const f = fixture(); write(f.previous, metadata(genA, "previous"));
    expect(shell(f, `metadata_transition_hook(){ [ "$1" != rollback-current-written ]; }; promote_successful_rollback`).status).not.toBe(0);
    expect(shell(f, "recover_metadata_transition").status).toBe(0); expect(generation(f.current)).toBe(genA); expect(existsSync(f.previous)).toBe(false);
  });

  it.each(["rollback-retagged", "rollback-recreated", "rollback-health-confirmed"])("an interruption after %s preserves metadata for deterministic retry", (phase) => {
    const f = fixture(); write(f.previous, metadata(genA, "previous")); const current = readFileSync(f.current, "utf8"); const previous = readFileSync(f.previous, "utf8");
    const mocks = `validate_generation_owned_evidence(){ return 0; }; validate_retained_generation_image(){ return 0; }; run_clean_docker(){ return 0; }; recreate_application_services(){ return 0; }; validate_running_application(){ return 0; }; metadata_transition_hook(){ [ "$1" != '${phase}' ]; }; execute_validated_rollback_transition '${f.previous}'`;
    expect(shell(f, mocks).status).not.toBe(0); expect(readFileSync(f.current, "utf8")).toBe(current); expect(readFileSync(f.previous, "utf8")).toBe(previous);
  });

  it("fails closed for missing bootstrap current and legacy metadata", () => {
    const f = fixture(); rmSync(f.current); expect(shell(f, `validate_generation_metadata_core '${f.current}' current`).status).not.toBe(0);
    write(f.current, { formatVersion: 1, generation: genA }); expect(shell(f, `validate_generation_metadata_core '${f.current}' current`).status).not.toBe(0);
  });

  it("uses unique temporary files and interrupted writes leave destinations unchanged", () => {
    const f = fixture(); const before = readFileSync(f.current, "utf8");
    expect(shell(f, `metadata_transition_hook(){ return 1; }; promote_healthy_candidate '${f.candidate}'`).status).not.toBe(0);
    expect(readFileSync(f.current, "utf8")).toBe(before);
    expect(shell(f, `find '${f.dir}' -maxdepth 1 -name '.lifecycle-role.*' -o -name '.transition.*'`).stdout.trim()).toBe("");
  });

  it.each(["symlink", "directory"])("rejects wrong destination type: %s", (kind) => {
    const f = fixture(); const target = path.join(f.dir, "target"); writeFileSync(target, "x");
    if (kind === "symlink") symlinkSync(target, f.previous); else mkdirSync(f.previous);
    expect(shell(f, `promote_healthy_candidate '${f.candidate}'`).status).not.toBe(0);
  });

  it("generation-owned evidence survives source snapshot cleanup", () => {
    const f = fixture(); const snapshot = path.join(f.dir, "snapshot"); const evidence = path.join(f.dir, `evidence-${genB}`);
    mkdirSync(snapshot); cpSync(path.join(root, "packages"), path.join(snapshot, "packages"), { recursive: true }); cpSync(path.join(root, "docker-compose.yml"), path.join(snapshot, "docker-compose.yml"));
    const result = shell(f, `persist_migration_declaration_evidence '${snapshot}' '${evidence}'`); expect(result.status, result.stderr).toBe(0);
    rmSync(snapshot, { recursive: true }); expect(existsSync(path.join(evidence, "docker-compose.yml"))).toBe(true); expect(existsSync(path.join(evidence, "packages/database/prisma/rollback-compatibility.json"))).toBe(true);
  });

  it("retained image/evidence failure suppresses every mocked later mutation", () => {
    const f = fixture(); const record = path.join(f.dir, "mutations"); write(f.previous, metadata(genA, "previous"));
    const imageMismatch = `run_clean_docker(){ echo 'sha256:${"9".repeat(64)}'; }; mutate(){ echo called >>'${record}'; }; validate_retained_generation_image '${f.previous}' && mutate`;
    expect(shell(f, imageMismatch).status).not.toBe(0); expect(existsSync(record)).toBe(false);
    const evidenceMismatch = `validate_generation_owned_evidence(){ return 1; }; mutate(){ echo called >>'${record}'; }; validate_generation_owned_evidence '${f.previous}' && mutate`;
    expect(shell(f, evidenceMismatch).status).not.toBe(0); expect(existsSync(record)).toBe(false);
  });
});
