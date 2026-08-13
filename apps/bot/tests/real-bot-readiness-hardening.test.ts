import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { completeBotStartupReadiness, linuxProcessStartTicks, publishBotReadiness, readBotReadiness, removeBotReadiness } from "../src/core/readiness-marker.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const common = path.join(root, "scripts/lib/common.sh");
const generation = "20260810T140000Z-aaaaaaaaaaaa";
const sha = "a".repeat(40);
const imageId = `sha256:${"b".repeat(64)}`;
const attempt = `update:${generation}:application-recreated`;
const instance = "11111111-1111-4111-8111-111111111111";

type Marker = { formatVersion: number; state: string; processId: number; processInstanceId: string; processStartTicks: string; processStartedAt: number; readyAt: number; generation: string; components: Record<string, boolean> };
type Evidence = ReturnType<typeof evidence>;
function marker(): Marker { return { formatVersion: 1, state: "ready", processId: 42, processInstanceId: instance, processStartTicks: "12345", processStartedAt: 90_000, readyAt: 95_000, generation: sha, components: { application: true, handlers: true, localLoops: true, shutdownHandlers: true } }; }
function evidence(overrides: Partial<{ attempt: string; observedAt: number; marker: unknown; containerId: string; boundaryContainerId: string; imageId: string; generation: string; service: string; project: string; status: string; restartCount: number }> = {}) {
  const cid = overrides.containerId ?? "bot-container";
  return { formatVersion: 1, kind: "real-bot", attempt: overrides.attempt ?? attempt, observedAt: overrides.observedAt ?? 100,
    boundary: { formatVersion: 1, operation: `update:${generation}`, generation, containerId: overrides.boundaryContainerId ?? "bot-container", imageId, imageRef: "zedbot-app:latest", project: "zedbot", service: "bot", recreatedAt: 90 },
    bot: { service: overrides.service ?? "bot", project: overrides.project ?? "zedbot", containerId: cid, imageId: overrides.imageId ?? imageId, imageRef: "zedbot-app:latest", generation: overrides.generation ?? sha, status: overrides.status ?? "running", restartCount: overrides.restartCount ?? 0, marker: overrides.marker ?? marker() } };
}
function shell(body: string) { return spawnSync("bash", ["-c", `. '${common}'; ${body}`], { encoding: "utf8" }); }
function evaluate(value: unknown, started = 100, now = 100) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-real-bot-eval-")); const file = path.join(dir, "evidence.json"); writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return shell(`evaluate_real_bot_readiness_evidence "$(< '${file}')" '${attempt}' '${started}' '${now}' '${imageId}' '${sha}'`);
}

describe("Bot-owned readiness marker", () => {
  it("publishes a complete current-generation marker atomically", async () => { const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-marker-")); const file = path.join(dir, "ready.json"); const value = await publishBotReadiness(sha, file, 123_000); expect(value.state).toBe("ready"); expect(await readBotReadiness(file)).toEqual(value); await removeBotReadiness(file); });
  it("parses Linux process start ticks without trusting the command name", () => { expect(linuxProcessStartTicks("42 (node worker) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 999")).toBe("999"); expect(() => linuxProcessStartTicks("truncated")).toThrow("proc-stat-invalid"); });
  it("rejects an invalid generation", async () => { const file = path.join(mkdtempSync(path.join(os.tmpdir(), "zedbot-marker-")), "ready.json"); await expect(publishBotReadiness("short", file)).rejects.toThrow("generation-invalid"); });
  it("cannot publish readiness before required local database initialization", async () => { const file = path.join(mkdtempSync(path.join(os.tmpdir(), "zedbot-marker-")), "ready.json"); await expect(completeBotStartupReadiness({ databaseInitialized: false, generation: sha, markerPath: file })).rejects.toThrow("initialization-incomplete"); expect(() => readFileSync(file)).toThrow(); });
  it("publishes only after the complete startup coordinator confirms initialization", async () => { const file = path.join(mkdtempSync(path.join(os.tmpdir(), "zedbot-marker-")), "ready.json"); const value = await completeBotStartupReadiness({ databaseInitialized: true, generation: sha, markerPath: file, now: 125_000 }); expect(value.readyAt).toBe(125_000); await removeBotReadiness(file); });
  it("rejects a symlinked marker destination", async () => { const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-marker-")); const target = path.join(dir, "target"); const file = path.join(dir, "ready.json"); writeFileSync(target, "safe"); symlinkSync(target, file); await expect(publishBotReadiness(sha, file)).rejects.toThrow("symlinked"); expect(readFileSync(target, "utf8")).toBe("safe"); });
  it("rejects unsafe marker permissions", async () => { const file = path.join(mkdtempSync(path.join(os.tmpdir(), "zedbot-marker-")), "ready.json"); writeFileSync(file, "{}", { mode: 0o644 }); chmodSync(file, 0o644); await expect(readBotReadiness(file)).rejects.toThrow("unsafe"); });
  it("removes only a regular marker and refuses a symlink", async () => { const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-marker-")); const target = path.join(dir, "target"); const file = path.join(dir, "ready.json"); writeFileSync(target, "safe"); symlinkSync(target, file); await expect(removeBotReadiness(file)).rejects.toThrow("unsafe"); expect(readFileSync(target, "utf8")).toBe("safe"); });
});

describe("real Bot structured evidence", () => {
  it("accepts valid current-operation, current-generation readiness", () => expect(evaluate(evidence()).status).toBe(0));
  it.each([
    ["empty", ""], ["malformed", "{"], ["truncated", '{"formatVersion":1'],
  ])("rejects %s evidence", (_name, value) => expect(evaluate(value).status).toBe(2));
  it.each([
    ["incomplete initialization", (e: Evidence) => { (e.bot.marker as Marker).components.handlers = false; }],
    ["startup failed", (e: Evidence) => { e.bot.status = "exited"; }],
    ["terminal failure", (e: Evidence) => { e.bot.status = "dead"; }],
    ["restart", (e: Evidence) => { e.bot.restartCount = 1; }],
    ["missing marker field", (e: Evidence) => { delete (e.bot.marker as Partial<Marker>).readyAt; }],
    ["wrong marker field type", (e: Evidence) => { (e.bot.marker as Marker).processId = "42" as unknown as number; }],
    ["unknown readiness state", (e: Evidence) => { (e.bot.marker as Marker).state = "unknown"; }],
    ["contradictory container", (e: Evidence) => { e.boundary.containerId = "other"; }],
    ["wrong image", (e: Evidence) => { e.bot.imageId = `sha256:${"c".repeat(64)}`; }],
    ["wrong service", (e: Evidence) => { e.bot.service = "api"; }],
    ["wrong project", (e: Evidence) => { e.bot.project = "hostile"; }],
    ["mixed generation", (e: Evidence) => { e.bot.generation = "d".repeat(40); }],
    ["marker generation mismatch", (e: Evidence) => { (e.bot.marker as Marker).generation = "e".repeat(40); }],
    ["previous operation", (e: Evidence) => { e.attempt = `rollback:${generation}:application-recreated`; }],
    ["stale observed time", (e: Evidence) => { e.observedAt = 90; }],
    ["future marker", (e: Evidence) => { (e.bot.marker as Marker).readyAt = 200_000; }],
    ["ready before process start", (e: Evidence) => { (e.bot.marker as Marker).processStartedAt = 99_000; (e.bot.marker as Marker).readyAt = 90_000; }],
    ["unexpected marker field", (e: Evidence) => { (e.bot.marker as Record<string, unknown>).token = "redacted-fixture"; }],
    ["duplicate/ambiguous identity", (e: Evidence) => { (e as unknown as Record<string, unknown>).bots = [e.bot]; }],
  ])("rejects %s", (_name, mutate) => { const value = evidence(); mutate(value); expect(evaluate(value).status).toBe(2); });
  it("treats only the exact starting marker as retryable", () => expect(evaluate(evidence({ marker: { formatVersion: 1, state: "starting" } })).status).toBe(1));
});

describe("bounded real Bot polling and state suppression", () => {
  it("records a lock-owned bot recreation boundary from the confirmed container identity", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-bot-boundary-")); const boundary = path.join(dir, "bot-recreation.json");
    const body = `set_deployment_state_paths '${dir}'; acquire_deployment_lock; initialize_operation_state update '${generation}'; for pair in 'current-validated current-image-retained' 'current-image-retained candidate-metadata-prepared' 'candidate-metadata-prepared candidate-image-built' 'candidate-image-built deployment-reference-tagged' 'deployment-reference-tagged compatibility-confirmed' 'compatibility-confirmed migrations-confirmed'; do set -- $pair; advance_operation_state "$1" "$2"; done; run_compose(){ [ "$1" = ps ] && echo bot-container; }; run_clean_docker(){ jq -cn --arg image '${imageId}' --arg sha '${sha}' '[{Id:"bot-container",Image:$image,RestartCount:0,Config:{Image:"zedbot-app:latest",Env:[("GIT_SHA="+$sha)],Labels:{"com.docker.compose.project":"zedbot","com.docker.compose.service":"bot"}},State:{Status:"running"}}]'; }; record_bot_recreation_boundary '${imageId}' '${sha}'; validate_bot_recreation_boundary`;
    const result = shell(body); expect(result.status, result.stderr).toBe(0); expect(JSON.parse(readFileSync(boundary, "utf8"))).toMatchObject({ operation: `update:${generation}`, containerId: "bot-container", imageId });
  });
  it("rejects recreation boundary recording without the lock or correct predecessor", () => { const result = shell(`require_deployment_lock(){ return 1; }; record_bot_recreation_boundary '${imageId}' '${sha}'`); expect(result.status).not.toBe(0); });
  function poll(sequence: unknown[], timeout = 9, cancel = false) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-real-bot-poll-")); const queue = path.join(dir, "queue"); const clock = path.join(dir, "clock"); const calls = path.join(dir, "calls");
    writeFileSync(queue, sequence.map((item) => JSON.stringify(item)).join("\n") + "\n"); writeFileSync(clock, "100");
    const body = `require_deployment_lock(){ return 0; }; readiness_now(){ cat '${clock}'; }; readiness_pause(){ ${cancel ? "return 130" : `v=$(cat '${clock}'); echo $((v+$1)) >'${clock}'`}; }; collect_real_bot_readiness_evidence(){ echo x >>'${calls}'; item=$(sed -n '1p' '${queue}'); sed -i '1d' '${queue}'; printf '%s' "$item" | jq --argjson now "$(cat '${clock}')" '.observedAt=$now'; }; wait_for_real_bot_readiness '${attempt}' '${imageId}' '${sha}' '${timeout}' 3`;
    const result = shell(body); return { result, calls: readFileSync(calls, "utf8").trim().split("\n").length };
  }
  const starting = () => evidence({ marker: { formatVersion: 1, state: "starting" } });
  it("becomes ready before the deadline", () => { const result = poll([starting(), evidence()]); expect(result.result.status).toBe(0); expect(result.calls).toBe(2); });
  it("starting until timeout fails without busy-looping", () => { const result = poll([starting(), starting(), starting(), starting()]); expect(result.result.status).not.toBe(0); expect(result.calls).toBe(4); });
  it("cancellation fails and stops after one poll", () => { const result = poll([starting(), evidence()], 9, true); expect(result.result.status).not.toBe(0); expect(result.calls).toBe(1); });
  it("terminal failure stops further polling", () => { const result = poll([evidence({ status: "exited" }), evidence()]); expect(result.result.status).not.toBe(0); expect(result.calls).toBe(1); });
  it("identity change during polling fails closed", () => { const second = evidence({ containerId: "replacement", boundaryContainerId: "replacement" }); const result = poll([starting(), second]); expect(result.result.status).not.toBe(0); expect(result.calls).toBe(2); });
  it("failing inspection status rejects valid-looking later evidence", () => { const result = shell(`require_deployment_lock(){ return 0; }; readiness_now(){ echo 100; }; collect_real_bot_readiness_evidence(){ printf '%s' '${JSON.stringify(evidence())}'; return 1; }; wait_for_real_bot_readiness '${attempt}' '${imageId}' '${sha}' 9 3`); expect(result.status).not.toBe(0); });
  it("successful inspection with invalid content fails closed", () => { const result = shell(`require_deployment_lock(){ return 0; }; readiness_now(){ echo 100; }; collect_real_bot_readiness_evidence(){ echo '{'; }; wait_for_real_bot_readiness '${attempt}' '${imageId}' '${sha}' 9 3`); expect(result.status).not.toBe(0); });
  it("operation lock is mandatory", () => { const result = shell(`require_deployment_lock(){ return 1; }; wait_for_real_bot_readiness '${attempt}' '${imageId}' '${sha}' 9 3`); expect(result.status).not.toBe(0); });
  it("generic readiness alone cannot confirm health", () => { const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-bot-gate-")); const trace = path.join(dir, "trace"); const result = shell(`wait_for_readiness_policy(){ return 0; }; wait_for_real_bot_readiness(){ return 1; }; wait_for_readiness_policy application x y z && wait_for_real_bot_readiness x y z && echo health >'${trace}'`); expect(result.status).not.toBe(0); expect(() => readFileSync(trace)).toThrow(); });
  it.each(["update", "rollback"])("%s application validation runs generic then Real Bot readiness", (kind) => { const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-bot-order-")); const trace = path.join(dir, "trace"); const result = shell(`require_deployment_lock(){ return 0; }; current_readiness_attempt(){ echo '${kind}:${generation}:application-recreated'; }; run_clean_docker(){ echo '${imageId}'; }; wait_for_readiness_policy(){ echo generic >>'${trace}'; return 0; }; wait_for_real_bot_readiness(){ echo real-bot >>'${trace}'; return 0; }; validate_running_application '${sha}' >/dev/null`); expect(result.status).toBe(0); expect(readFileSync(trace, "utf8").trim().split("\n")).toEqual(["generic", "real-bot"]); });
  it("Bot failure suppresses health-confirmed and both promotion states", () => { const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-bot-suppress-")); const trace = path.join(dir, "trace"); const result = shell(`validate_running_application(){ return 1; }; validate_running_application '${sha}' && printf 'health\npromotion-prepared\npromoted\n' >'${trace}'`); expect(result.status).not.toBe(0); expect(() => readFileSync(trace)).toThrow(); });
  it("update and rollback share one real Bot policy", () => expect(shell("declare -f validate_running_application wait_for_real_bot_readiness evaluate_real_bot_readiness_evidence >/dev/null").status).toBe(0));
  it("recreation remains api bot worker and excludes dependencies", () => { const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-bot-services-")); const trace = path.join(dir, "trace"); const result = shell(`validate_compose_application_images(){ return 0; }; run_compose(){ printf '%s\n' "$@" >'${trace}'; }; recreate_application_services`); expect(result.status).toBe(0); const args = readFileSync(trace, "utf8").trim().split("\n"); expect(args.slice(-3)).toEqual(["api", "bot", "worker"]); expect(args).not.toContain("postgres"); expect(args).not.toContain("redis"); });
  it("readiness implementation contains no Telegram network command", () => { const source = readFileSync(common, "utf8"); const block = source.slice(source.indexOf("collect_real_bot_readiness_evidence"), source.indexOf("atomic_write_metadata")); expect(block).not.toMatch(/getUpdates|sendMessage|api\.telegram|curl|wget/); });
  it("fixed diagnostics and fixtures contain no credential-shaped output", () => { const source = readFileSync(path.join(root, "apps/bot/src/cli/readiness.ts"), "utf8"); expect(source).not.toMatch(/TELEGRAM_BOT_TOKEN|process\.env|token=/); });
});
