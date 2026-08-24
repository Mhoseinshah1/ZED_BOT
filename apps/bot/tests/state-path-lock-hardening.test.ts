import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const common = path.join(root, "scripts/lib/common.sh");
const generation = "20260810T120000Z-aaaaaaaaaaaa";

function fixture() { return mkdtempSync(path.join(os.tmpdir(), "zedbot-area6-")); }
function shell(dir: string, body: string) {
  return spawnSync("bash", ["-c", `. '${common}'; set_deployment_state_paths '${dir}'; ${body}`], { encoding: "utf8", env: process.env });
}

describe("area 6 canonical state paths, metadata and locks", () => {
  it("creates a genuinely absent canonical directory as root-owned mode 0700 regardless of umask", () => {
    const parent = fixture(); const dir = path.join(parent, "deployments");
    const result = shell(dir, "umask 0022; secure_deployment_dir; stat -c '%u:%g:%a' \"$ZEDBOT_DEPLOYMENT_DIR\"");
    expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe("0:0:700");
  });

  it("does not repair an existing wrong-mode deployment directory", () => {
    const parent = fixture(); const dir = path.join(parent, "deployments"); mkdirSync(dir, { mode: 0o755 }); chmodSync(dir, 0o755);
    expect(shell(dir, "secure_deployment_dir").status).not.toBe(0); expect(lstatSync(dir).mode & 0o777).toBe(0o755);
  });

  it("does not repair an existing foreign-owned deployment directory", () => {
    const parent = fixture(); const dir = path.join(parent, "deployments"); mkdirSync(dir, { mode: 0o700 }); chownSync(dir, 65534, 65534);
    expect(shell(dir, "secure_deployment_dir").status).not.toBe(0);
    expect(lstatSync(dir).uid).toBe(65534); expect(lstatSync(dir).mode & 0o777).toBe(0o700);
  });

  it("rejects a non-directory substituted at the canonical directory path without changing it", () => {
    const parent = fixture(); const dir = path.join(parent, "deployments"); writeFileSync(dir, "unchanged");
    expect(shell(dir, "secure_deployment_dir").status).not.toBe(0); expect(readFileSync(dir, "utf8")).toBe("unchanged");
  });

  it("production entry-point reset ignores ambient state-path redirection", () => {
    const dir = fixture(); const result = shell(dir, "ZEDBOT_DEPLOYMENT_DIR=/tmp/attacker; ZEDBOT_ROLLBACK_METADATA=/tmp/attacker.json; reset_deployment_state_fixed_identity; printf '%s\\n' \"$ZEDBOT_DEPLOYMENT_DIR|$ZEDBOT_ROLLBACK_METADATA\"");
    expect(result.status).toBe(0); expect(result.stdout.trim()).toBe("/opt/zedbot/deployments|/opt/zedbot/deployments/previous.json");
  });

  it.each([
    ["parent traversal", (d: string) => `${d}/../state`],
    ["dot spelling", (d: string) => `${d}/./state`],
    ["duplicate separator", (d: string) => `${d}//state`],
  ])("rejects %s", (_name, make) => {
    const dir = fixture(); expect(shell(dir, `set_deployment_state_paths '${make(dir)}'; validate_deployment_path_contract`).status).not.toBe(0);
  });

  it("rejects a relative state directory and an absolute external metadata path", () => {
    const dir = fixture();
    expect(shell(dir, "set_deployment_state_paths relative/state; validate_deployment_path_contract").status).not.toBe(0);
    expect(shell(dir, "ZEDBOT_ROLLBACK_METADATA=/tmp/external.json; validate_deployment_path_contract").status).not.toBe(0);
  });

  it("rejects a symlinked state directory and symlinked parent component", () => {
    const rootDir = fixture(); const real = path.join(rootDir, "real"); const link = path.join(rootDir, "link");
    chmodSync(rootDir, 0o700); mkdirSync(real, { mode: 0o700 }); symlinkSync(real, link);
    expect(shell(link, "secure_deployment_dir").status).not.toBe(0);
    expect(shell(path.join(link, "state"), "secure_deployment_dir").status).not.toBe(0);
  });

  it("rejects symlinked metadata and does not alter its target", () => {
    const dir = fixture(); const target = path.join(dir, "external"); const previous = path.join(dir, "previous.json");
    writeFileSync(target, "unchanged"); chmodSync(target, 0o600); symlinkSync(target, previous);
    const source = path.join(dir, "source"); writeFileSync(source, "{}");
    expect(shell(dir, `acquire_deployment_lock; atomic_write_metadata '${source}' '${previous}'`).status).not.toBe(0);
    expect(readFileSync(target, "utf8")).toBe("unchanged");
  });

  it.each(["symlink", "directory"])("rejects a %s lock path", (kind) => {
    const dir = fixture(); const lock = path.join(dir, "deployment.lock"); const target = path.join(dir, "target");
    if (kind === "symlink") { writeFileSync(target, "x"); symlinkSync(target, lock); } else mkdirSync(lock);
    expect(shell(dir, "acquire_deployment_lock").status).not.toBe(0);
  });

  it("rejects malformed and truncated operation metadata", () => {
    const dir = fixture(); const state = path.join(dir, "operation-state.json");
    writeFileSync(state, '{"formatVersion":1'); chmodSync(state, 0o600);
    expect(shell(dir, `validate_operation_state '${state}'`).status).not.toBe(0);
  });

  it("rejects ownership-mismatched metadata", () => {
    const dir = fixture(); const state = path.join(dir, "operation-state.json");
    writeFileSync(state, JSON.stringify({ formatVersion: 1, generation, kind: "update", stage: "current-validated" })); chmodSync(state, 0o600); chownSync(state, 65534, 65534);
    expect(shell(dir, `validate_operation_state '${state}'`).status).not.toBe(0);
  });

  // Regression: this used to unconditionally reject a same-generation,
  // different-kind reinitialization ("cross-operation metadata identity").
  // But a fresh operation always proves exclusive deployment-lock ownership
  // before reaching this check, which means no other process can still be
  // running whatever operation-state.json currently records - its owner
  // already exited. A non-promoted leftover is therefore provably abandoned
  // regardless of kind, not evidence of a genuine conflict, so it is now
  // cleared and the newly requested operation starts fresh instead of being
  // permanently rejected. See "clears an abandoned...operation state" below
  // for the general (non-cross-kind) case this generalizes.
  it("clears an abandoned differently-kinded operation state instead of permanently rejecting it", () => {
    const dir = fixture();
    const state = path.join(dir, "operation-state.json");
    const result = shell(dir, `acquire_deployment_lock; initialize_operation_state update '${generation}'; initialize_operation_state rollback '${generation}'`);
    expect(result.status, result.stderr).toBe(0);
    const written = JSON.parse(readFileSync(state, "utf8"));
    expect(written.kind).toBe("rollback"); expect(written.generation).toBe(generation); expect(written.stage).toBe("previous-selected");
  });

  it("pre-created temporary names cannot be substituted or reused", () => {
    const dir = fixture(); const planted = path.join(dir, ".metadata.AAAAAAAA"); const source = path.join(dir, "source");
    writeFileSync(planted, "attacker"); chmodSync(planted, 0o600); writeFileSync(source, "safe");
    expect(shell(dir, `acquire_deployment_lock; atomic_write_metadata '${source}' "$ZEDBOT_ROLLBACK_METADATA"`).status).toBe(0);
    expect(readFileSync(planted, "utf8")).toBe("attacker"); expect(readFileSync(path.join(dir, "previous.json"), "utf8")).toBe("safe");
  });

  it.each(["update/update", "update/rollback", "rollback/rollback"])("serializes concurrent %s", () => {
    const dir = fixture(); const command = `acquire_deployment_lock; if bash -c "exec 9>&-; . '${common}'; set_deployment_state_paths '${dir}'; acquire_deployment_lock"; then exit 99; else exit 7; fi`;
    const result = shell(dir, command); expect(result.status).not.toBe(0); expect(result.stderr).toContain("already running");
  });

  it("failed lock acquisition suppresses later work", () => {
    const dir = fixture(); const later = path.join(dir, "later");
    const result = shell(dir, `acquire_deployment_lock; if bash -c "exec 9>&-; . '${common}'; set_deployment_state_paths '${dir}'; acquire_deployment_lock && echo unsafe >'${later}'"; then exit 99; else exit 7; fi`);
    expect(result.status).not.toBe(0); expect(existsSync(later)).toBe(false);
  });

  it("a non-owner cannot release the lock", () => {
    const dir = fixture(); expect(shell(dir, "release_deployment_lock").status).not.toBe(0);
  });

  it("an unlocked valid persistent inode is the safe stale-lock state", () => {
    const dir = fixture(); const first = shell(dir, "acquire_deployment_lock; release_deployment_lock"); expect(first.status, first.stderr).toBe(0);
    const lock = path.join(dir, "deployment.lock"); expect(lstatSync(lock).isFile()).toBe(true); expect(shell(dir, "acquire_deployment_lock").status).toBe(0);
  });

  it("interrupted ownership releases through process exit without success metadata", () => {
    const dir = fixture(); expect(shell(dir, "acquire_deployment_lock; exit 130").status).toBe(130);
    expect(existsSync(path.join(dir, "operation-state.json"))).toBe(false); expect(shell(dir, "acquire_deployment_lock").status).toBe(0);
  });

  it("substitution prevents an owner from releasing another inode", () => {
    const dir = fixture(); const lock = path.join(dir, "deployment.lock"); const moved = path.join(dir, "owned-lock");
    const result = shell(dir, `acquire_deployment_lock; mv '${lock}' '${moved}'; : >'${lock}'; chmod 600 '${lock}'; release_deployment_lock`);
    expect(result.status).not.toBe(0); expect(existsSync(lock)).toBe(true); expect(existsSync(moved)).toBe(true);
  });

  it("wrong lock mode fails closed and closes the acquisition path", () => {
    const dir = fixture(); const lock = path.join(dir, "deployment.lock"); writeFileSync(lock, ""); chmodSync(lock, 0o644);
    expect(shell(dir, "acquire_deployment_lock").status).not.toBe(0);
  });

  it("ownership-mismatched lock fails closed", () => {
    const dir = fixture(); const lock = path.join(dir, "deployment.lock"); writeFileSync(lock, ""); chmodSync(lock, 0o600); chownSync(lock, 65534, 65534);
    expect(shell(dir, "acquire_deployment_lock").status).not.toBe(0);
  });

  it("metadata write failure suppresses later state", () => {
    const dir = fixture(); const later = path.join(dir, "later");
    const result = shell(dir, `acquire_deployment_lock; source='${dir}/source'; echo safe >"$source"; atomic_write_metadata(){ return 1; }; atomic_write_metadata "$source" "$ZEDBOT_ROLLBACK_METADATA" && echo unsafe >'${later}'`);
    expect(result.status).not.toBe(0); expect(existsSync(later)).toBe(false);
  });

  it("state mutation without the owned lock fails closed", () => {
    const dir = fixture(); const source = path.join(dir, "source"); writeFileSync(source, "safe");
    expect(shell(dir, `atomic_write_metadata '${source}' "$ZEDBOT_ROLLBACK_METADATA"`).status).not.toBe(0);
    expect(existsSync(path.join(dir, "previous.json"))).toBe(false);
  });
});
