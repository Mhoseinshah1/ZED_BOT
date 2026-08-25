import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const common = path.join(root, "scripts/lib/common.sh");
const generation = "20260809T120000Z-bbbbbbbbbbbb";
const updateStages = ["current-validated", "current-image-retained", "candidate-metadata-prepared", "candidate-image-built", "deployment-reference-tagged", "compatibility-confirmed", "migrations-confirmed", "application-recreated", "health-confirmed", "promotion-prepared", "promoted"];
// compatibility-confirmed precedes deployment-reference-retagged (unlike
// update's own sequence): rollback's compatibility check must run against
// the CURRENT (about-to-be-rolled-back-from) image, whose code and manifest
// are the only ones that know about the newest migration's own backward-
// compatibility declaration - retagging zedbot-app:latest to the previous
// image first would make the check run against code that predates that
// migration entirely, unconditionally blocking every rollback past one.
const rollbackStages = ["previous-selected", "rollback-evidence-validated", "retained-image-validated", "compatibility-confirmed", "deployment-reference-retagged", "application-recreated", "health-confirmed", "promotion-prepared", "promoted"];

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

  // Regression: a leftover, non-promoted operation-state.json for a
  // DIFFERENT generation used to permanently reject every later
  // install/update/rollback attempt, even a routine retry after a transient
  // failure - update.sh always mints a fresh timestamp-based generation, so
  // it could never match the abandoned one, and there was no recovery
  // command. The retry always proves exclusive deployment-lock ownership
  // before reaching this check, which means the abandoned marker's owner has
  // already exited (the lock is only released on exit) - so it is provably
  // abandoned, not concurrent, and safe to clear.
  it("clears an abandoned different-generation non-promoted state instead of permanently rejecting it", () => {
    const f = fixture(); const genB = "20260809T120005Z-bbbbbbbbbbbb";
    expect(shell(f, "initialize_operation_state update '20260809T120000Z-aaaaaaaaaaaa'; advance_operation_state current-validated current-image-retained; advance_operation_state current-image-retained candidate-metadata-prepared").status).toBe(0);
    expect(stage(f)).toBe("candidate-metadata-prepared");
    const retry = shell(f, `initialize_operation_state update '${genB}'`);
    expect(retry.status, retry.stderr).toBe(0);
    const written = JSON.parse(readFileSync(f.state, "utf8"));
    expect(written.generation).toBe(genB); expect(written.stage).toBe("current-validated");
  });

  it("a retried update can then run its full sequence to promoted after the abandoned state is cleared", () => {
    const f = fixture(); expect(shell(f, flow("update", updateStages.slice(0, 5), f.trace)).status).toBe(0);
    const genB = "20260809T130000Z-cccccccccccc";
    const result = shell(f, flow("update", updateStages, f.trace).replace(generation, genB));
    expect(result.status, result.stderr).toBe(0); expect(stage(f)).toBe("promoted");
  });

  it("still treats a matching generation as a safe no-op, not a reset", () => {
    const f = fixture(); expect(shell(f, flow("update", updateStages.slice(0, 5), f.trace)).status).toBe(0);
    expect(stage(f)).toBe(updateStages[4]);
    expect(shell(f, `initialize_operation_state update '${generation}'`).status).toBe(0);
    expect(stage(f)).toBe(updateStages[4]);
  });

  it("clears an abandoned state even across a different kind (a stuck rollback no longer blocks a later install/update)", () => {
    const f = fixture(); expect(shell(f, flow("rollback", rollbackStages.slice(0, 4), f.trace)).status).toBe(0);
    const genB = "20260809T140000Z-dddddddddddd";
    expect(shell(f, `initialize_operation_state update '${genB}'`).status).toBe(0);
    expect(JSON.parse(readFileSync(f.state, "utf8")).kind).toBe("update");
  });

  // Regression: operation-state.json is a live in-flight marker, not a
  // permanent record. Leaving it behind with stage "promoted" forever after
  // every completed operation made rollback-status permanently report
  // OPERATION_INCOMPLETE starting with the very first successful
  // install/update/rollback (inspect_rollback_status blocks on the file's
  // mere PRESENCE, not its stage - see rollback-status-readonly.test.ts).
  it("finalize_promoted_operation_state clears the marker once an operation reaches promoted", () => {
    const f = fixture();
    expect(shell(f, flow("update", updateStages, f.trace)).status).toBe(0);
    expect(existsSync(f.state)).toBe(true);
    const result = shell(f, "finalize_promoted_operation_state");
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(f.state)).toBe(false);
  });

  it("finalize_promoted_operation_state is a safe no-op when no operation state exists", () => {
    const f = fixture();
    const result = shell(f, "finalize_promoted_operation_state");
    expect(result.status, result.stderr).toBe(0);
  });

  it("finalize_promoted_operation_state leaves a not-yet-promoted operation state untouched", () => {
    const f = fixture();
    expect(shell(f, flow("update", updateStages.slice(0, -1), f.trace)).status).toBe(0);
    expect(stage(f)).toBe("promotion-prepared");
    const result = shell(f, "finalize_promoted_operation_state");
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(f.state)).toBe(true);
    expect(stage(f)).toBe("promotion-prepared");
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
