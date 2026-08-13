import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const common = path.join(root, "scripts/lib/common.sh");
const generation = "20260809T120000Z-bbbbbbbbbbbb";
const updateStages = ["current-validated", "current-image-retained", "candidate-metadata-prepared", "candidate-image-built", "deployment-reference-tagged", "compatibility-confirmed", "migrations-confirmed", "application-recreated", "health-confirmed", "promotion-prepared", "promoted"];
const rollbackStages = ["previous-selected", "rollback-evidence-validated", "retained-image-validated", "deployment-reference-retagged", "compatibility-confirmed", "application-recreated", "health-confirmed", "promotion-prepared", "promoted"];

function fixture() { const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-state-order-")); return { dir, state: path.join(dir, "operation-state.json"), trace: path.join(dir, "trace") }; }
function shell(f: ReturnType<typeof fixture>, body: string) {
  return spawnSync("bash", ["-c", `. '${common}'; set_deployment_state_paths '${f.dir}'; acquire_deployment_lock; ${body}`], { encoding: "utf8", env: process.env });
}
function stage(f: ReturnType<typeof fixture>) { return JSON.parse(readFileSync(f.state, "utf8")).stage; }
function flow(kind: "update" | "rollback", stages: string[], trace: string) {
  return `initialize_operation_state ${kind} '${generation}'; ok(){ echo "$1" >>'${trace}'; }; verify(){ return 0; }; ${stages.slice(1).map((next, i) => `step(){ ok '${next}'; }; run_confirmed_operation_step '${stages[i]}' '${next}' step verify;`).join(" ")}`;
}

describe("confirmed deployment state ordering", () => {
  it("runs one complete successful update with the exact confirmed sequence", () => {
    const f = fixture(); const result = shell(f, flow("update", updateStages, f.trace)); expect(result.status, result.stderr).toBe(0);
    expect(stage(f)).toBe("promoted"); expect(readFileSync(f.trace, "utf8").trim().split("\n")).toEqual(updateStages.slice(1));
  });

  it("runs one complete successful rollback with the exact confirmed sequence", () => {
    const f = fixture(); const result = shell(f, flow("rollback", rollbackStages, f.trace)); expect(result.status, result.stderr).toBe(0);
    expect(stage(f)).toBe("promoted"); expect(readFileSync(f.trace, "utf8").trim().split("\n")).toEqual(rollbackStages.slice(1));
  });

  it.each(updateStages.slice(1))("update failure before %s preserves the last confirmed predecessor", (next) => {
    const f = fixture(); const index = updateStages.indexOf(next); const prefix = updateStages.slice(0, index);
    expect(shell(f, flow("update", prefix, f.trace)).status).toBe(0);
    const expected = updateStages[index - 1]; const result = shell(f, `fail(){ return 1; }; verify(){ return 0; }; run_confirmed_operation_step '${expected}' '${next}' fail verify`);
    expect(result.status).not.toBe(0); expect(stage(f)).toBe(expected);
  });

  it.each(rollbackStages.slice(1))("rollback failure before %s preserves the last confirmed predecessor", (next) => {
    const f = fixture(); const index = rollbackStages.indexOf(next); const prefix = rollbackStages.slice(0, index);
    expect(shell(f, flow("rollback", prefix, f.trace)).status).toBe(0);
    const expected = rollbackStages[index - 1]; expect(shell(f, `fail(){ return 1; }; verify(){ return 0; }; run_confirmed_operation_step '${expected}' '${next}' fail verify`).status).not.toBe(0); expect(stage(f)).toBe(expected);
  });

  it("external success followed by metadata-write failure does not advance", () => {
    const f = fixture(); const artifact = path.join(f.dir, "artifact");
    const command = `initialize_operation_state update '${generation}'; op(){ echo done >'${artifact}'; }; verify(){ return 0; }; original=$(declare -f atomic_write_metadata); atomic_write_metadata(){ return 1; }; run_confirmed_operation_step current-validated current-image-retained op verify`;
    expect(shell(f, command).status).not.toBe(0); expect(readFileSync(artifact, "utf8")).toContain("done"); expect(stage(f)).toBe("current-validated");
  });

  it("persisted success followed by interruption keeps exactly that confirmed state", () => {
    const f = fixture(); expect(shell(f, `initialize_operation_state update '${generation}'; advance_operation_state current-validated current-image-retained; exit 130`).status).toBe(130); expect(stage(f)).toBe("current-image-retained");
  });

  it("rejects skip, backward, duplicate strict transition, unknown state and unsupported schema", () => {
    const f = fixture(); expect(shell(f, `initialize_operation_state update '${generation}'; advance_operation_state current-validated candidate-image-built`).status).not.toBe(0);
    expect(shell(f, `advance_operation_state current-validated current-image-retained; advance_operation_state current-image-retained current-validated`).status).not.toBe(0);
    expect(shell(f, `advance_operation_state current-image-retained candidate-metadata-prepared; advance_operation_state current-image-retained candidate-metadata-prepared`).status).not.toBe(0);
    writeFileSync(f.state, JSON.stringify({ formatVersion: 1, kind: "update", generation, stage: "unknown" })); expect(shell(f, `validate_operation_state '${f.state}'`).status).not.toBe(0);
    writeFileSync(f.state, JSON.stringify({ formatVersion: 99, kind: "update", generation, stage: "current-validated" })); expect(shell(f, `validate_operation_state '${f.state}'`).status).not.toBe(0);
  });

  it("retry confirms already-persisted stages but never skips ahead", () => {
    const f = fixture(); expect(shell(f, `initialize_operation_state rollback '${generation}'; advance_operation_state previous-selected rollback-evidence-validated; confirm_operation_state previous-selected rollback-evidence-validated`).status).toBe(0);
    expect(shell(f, `confirm_operation_state retained-image-validated compatibility-confirmed`).status).not.toBe(0); expect(stage(f)).toBe("rollback-evidence-validated");
  });

  it.each(["api-only", "bot-worker", "duplicate", "wrong-image"])("partial or mixed recreation %s is never confirmed", (kind) => {
    const f = fixture(); const expected = `sha256:${"2".repeat(64)}`;
    const mocks = `run_compose(){ service="\${3}"; case '${kind}:$service' in api-only:api) echo api-id;; bot-worker:bot) echo bot-id;; bot-worker:worker) echo worker-id;; duplicate:*) echo same-id;; wrong-image:api) echo api-id;; wrong-image:bot) echo bot-id;; wrong-image:worker) echo worker-id;; esac; }; run_clean_docker(){ [ '${kind}' = wrong-image ] && echo 'sha256:${"3".repeat(64)}' || echo '${expected}'; }; verify_application_recreation_set '${expected}'`;
    expect(shell(f, mocks).status).not.toBe(0);
  });

  it("complete api/bot/worker recreation confirms without PostgreSQL or Redis", () => {
    const f = fixture(); const calls = path.join(f.dir, "services"); const expected = `sha256:${"2".repeat(64)}`;
    const mocks = `run_compose(){ echo "$3" >>'${calls}'; echo "$3-id"; }; run_clean_docker(){ echo '${expected}'; }; verify_application_recreation_set '${expected}'`;
    expect(shell(f, mocks).status).toBe(0); expect(readFileSync(calls, "utf8").trim().split("\n")).toEqual(["api", "bot", "worker"]);
  });

  it("Compose non-zero and verification failure cannot record application-recreated", () => {
    const f = fixture(); expect(shell(f, flow("update", updateStages.slice(0, 7), f.trace)).status).toBe(0);
    expect(shell(f, `op(){ return 1; }; verify(){ return 0; }; run_confirmed_operation_step migrations-confirmed application-recreated op verify`).status).not.toBe(0); expect(stage(f)).toBe("migrations-confirmed");
    expect(shell(f, `op(){ return 0; }; verify(){ return 1; }; run_confirmed_operation_step migrations-confirmed application-recreated op verify`).status).not.toBe(0); expect(stage(f)).toBe("migrations-confirmed");
  });

  it("health and promotion cannot advance without recreation and health predecessors", () => {
    const f = fixture(); expect(shell(f, `initialize_operation_state update '${generation}'; advance_operation_state application-recreated health-confirmed`).status).not.toBe(0);
    expect(shell(f, `advance_operation_state health-confirmed promotion-prepared`).status).not.toBe(0); expect(stage(f)).toBe("current-validated");
  });

  it("every rewrite receives a fresh invocation-owned temporary pathname", () => {
    const f = fixture(); const seen = path.join(f.dir, "seen");
    const command = `initialize_operation_state update '${generation}'; metadata_write_observer(){ echo "$1" >>'${seen}'; }; advance_operation_state current-validated current-image-retained; advance_operation_state current-image-retained candidate-metadata-prepared`;
    expect(shell(f, command).status).toBe(0); const paths = readFileSync(seen, "utf8").trim().split("\n"); expect(new Set(paths).size).toBe(paths.length); expect(paths.every((p) => p.startsWith(`${f.dir}/.operation-stage.`))).toBe(true);
  });
});
