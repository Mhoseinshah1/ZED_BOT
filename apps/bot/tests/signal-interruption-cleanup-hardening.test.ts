import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const common = path.join(root, "scripts/lib/common.sh");
const fixture = () => mkdtempSync(path.join(os.tmpdir(), "zedbot-area9-"));
const shell = (body: string) => spawnSync("bash", ["-c", `. '${common}'; ${body}`], { encoding: "utf8" });

async function signalHarness(signal: "SIGINT" | "SIGTERM" | "SIGHUP", ignoreTerm = false) {
  const dir = fixture(); const ready = path.join(dir, "ready"); const childFile = path.join(dir, "child"); const later = path.join(dir, "later");
  const child = ignoreTerm ? `trap '' TERM; echo $$ > '${childFile}'; echo ready > '${ready}'; while :; do sleep 1; done` : `echo $$ > '${childFile}'; echo ready > '${ready}'; while :; do sleep 1; done`;
  const proc = spawn("bash", ["-c", `. '${common}'; set_deployment_state_paths '${dir}'; install_operation_traps; acquire_deployment_lock; run_operation_child bash -c ${JSON.stringify(child)}; echo unsafe > '${later}'`], { stdio: "ignore" });
  for (let i = 0; i < 100 && !existsSync(ready); i++) await new Promise(r => setTimeout(r, 10));
  expect(existsSync(ready)).toBe(true); proc.kill(signal);
  const status = await new Promise<number | null>(resolve => proc.once("exit", code => resolve(code)));
  const childPid = Number(readFileSync(childFile, "utf8"));
  let childAlive = true; try { process.kill(childPid, 0); } catch { childAlive = false; }
  return { status, childAlive, later: existsSync(later), dir };
}

describe("area 9 authoritative signals and owned children", () => {
  it.each([["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const)("%s preserves its conventional failure status", async (signal, expected) => {
    const result = await signalHarness(signal); expect(result.status).toBe(expected); expect(result.childAlive).toBe(false); expect(result.later).toBe(false);
  });
  it("bounded escalation reaps a child that ignores TERM", async () => { const result = await signalHarness("SIGTERM", true); expect(result.status).toBe(143); expect(result.childAlive).toBe(false); });
  it("preserves a child's ordinary failure", () => expect(shell("install_operation_traps; run_operation_child bash -c 'exit 37'").status).toBe(37));
  it("refuses to launch a new child after interruption", () => expect(shell("ZEDBOT_OPERATION_INTERRUPTED=1; run_operation_child bash -c 'exit 0'").status).not.toBe(0));
  it("closes deployment lock fd 9 in an owned child", () => { const dir = fixture(); const result = shell(`set_deployment_state_paths '${dir}'; install_operation_traps; acquire_deployment_lock; run_operation_child bash -c 'test ! -e /proc/$$$$/fd/9'`); expect(result.status, result.stderr).toBe(0); });
});

describe("area 9 cleanup ownership and idempotency", () => {
  it("normal success removes owned files but preserves pre-existing files", () => { const dir = fixture(); const owned = path.join(dir, "owned"); const pre = path.join(dir, "pre"); writeFileSync(pre, "keep"); const r = shell(`install_operation_traps; p="$(operation_mktemp '${owned}.XXXXXXXX')"; test -f "$p"`); expect(r.status).toBe(0); expect(readFileSync(pre, "utf8")).toBe("keep"); expect(existsSync(owned)).toBe(false); });
  it("already removed owned artifacts remain idempotent", () => expect(shell("install_operation_traps; p=$(operation_mktemp /tmp/zedbot-a9.XXXXXXXX); rm -f -- \"$p\"; operation_cleanup 1; operation_cleanup 1").status).toBe(0));
  it("does not delete an inode-substituted artifact", () => { const dir = fixture(); const r = shell(`install_operation_traps; p=$(operation_mktemp '${dir}/owned.XXXXXXXX'); rm -f "$p"; echo replacement > "$p"; operation_cleanup 1`); expect(r.status).toBe(0); const replacement = readdirSync(dir).find(name => name.startsWith("owned.")); expect(replacement).toBeDefined(); expect(readFileSync(path.join(dir, replacement!), "utf8").trim()).toBe("replacement"); });
  it("rejects a symlink-substituted cleanup target", () => { const dir = fixture(); const target = path.join(dir, "target"); writeFileSync(target, "safe"); const r = shell(`install_operation_traps; p=$(operation_mktemp '${dir}/owned.XXXXXXXX'); rm -f "$p"; ln -s '${target}' "$p"; operation_cleanup 1`); expect(r.status).toBe(0); expect(readFileSync(target, "utf8")).toBe("safe"); });
  it("a substituted cleanup registry fails without deleting its replacement target", () => { const dir = fixture(); const target = path.join(dir, "target"); writeFileSync(target, "safe"); const r = shell(`install_operation_traps; registry=$ZEDBOT_OPERATION_REGISTRY; rm -f "$registry"; ln -s '${target}' "$registry"; operation_cleanup 0`); expect(r.status).not.toBe(0); expect(readFileSync(target, "utf8")).toBe("safe"); });
  it("cleanup failure cannot convert the operation to success", () => expect(shell("install_operation_traps; operation_cleanup_artifacts(){ return 1; }").status).not.toBe(0));
});

describe("area 9 interruption state suppression", () => {
  it.each([
    "metadata-validation", "retention", "build", "image-tagging", "compatibility", "migration-inspection", "migration-execution",
    "dependency-readiness", "application-recreation", "generic-readiness", "real-bot-readiness", "before-health-confirmed",
    "health-persistence", "promotion-preparation", "reference-write", "promotion", "rollback-retag", "rollback-recreation",
    "rollback-readiness", "rollback-promotion",
  ])("suppresses later work after interruption at %s", (boundary) => {
    const dir = fixture(); const trace = path.join(dir, "trace");
    const r = shell(`ZEDBOT_OPERATION_INTERRUPTED=1; ZEDBOT_OPERATION_SIGNAL_STATUS=143; operation_assert_active && echo '${boundary}' > '${trace}'`);
    expect(r.status).not.toBe(0); expect(existsSync(trace)).toBe(false);
  });
  it("readiness polling checks interruption before collecting evidence", () => { const dir = fixture(); const trace = path.join(dir, "trace"); const r = shell(`ZEDBOT_OPERATION_INTERRUPTED=1; collect_readiness_evidence(){ echo called > '${trace}'; }; wait_for_readiness_policy dependency attempt '' '' 3 1`); expect(r.status).not.toBe(0); expect(existsSync(trace)).toBe(false); });
  it("Real Bot polling checks interruption before collecting evidence", () => { const dir = fixture(); const trace = path.join(dir, "trace"); const r = shell(`ZEDBOT_OPERATION_INTERRUPTED=1; require_deployment_lock(){ return 0; }; collect_real_bot_readiness_evidence(){ echo called > '${trace}'; }; wait_for_real_bot_readiness attempt 'sha256:${"a".repeat(64)}' '${"b".repeat(40)}' 3 1`); expect(r.status).not.toBe(0); expect(existsSync(trace)).toBe(false); });
  it("state confirmation cannot advance after interruption", () => expect(shell("ZEDBOT_OPERATION_INTERRUPTED=1; confirm_operation_state current-validated current-image-retained").status).not.toBe(0));
  it("metadata transition recovery cannot advance after interruption", () => expect(shell("ZEDBOT_OPERATION_INTERRUPTED=1; recover_metadata_transition").status).not.toBe(0));
});

describe("area 9 accepted deployment boundaries", () => {
  it("keeps api bot worker as the exact application set", () => { const text = readFileSync(common, "utf8"); expect(text).toContain("up -d --no-deps --no-build --pull never --force-recreate api bot worker"); });
  it("does not include postgres or redis in application recreation", () => { const line = readFileSync(common, "utf8").split("\n").find(v => v.includes("--force-recreate api bot worker")); expect(line).not.toMatch(/postgres|redis/); });
  it("uses the same trap installer in update and rollback entry points", () => { const update = readFileSync(path.join(root, "scripts/update.sh"), "utf8"); const rollback = readFileSync(path.join(root, "scripts/rollback.sh"), "utf8"); expect(update).toContain("install_operation_traps"); expect(rollback).toContain("install_operation_traps"); });
});
