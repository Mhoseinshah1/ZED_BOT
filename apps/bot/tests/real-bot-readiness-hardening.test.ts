import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { validateMarker } from "../src/cli/readiness.js";
import { completeBotStartupReadiness, completeBotStartupReadinessIfKnownGeneration, linuxProcessStartTicks, publishBotReadiness, readBotReadiness, removeBotReadiness } from "../src/core/readiness-marker.js";

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
function evaluate(value: unknown, started = 100, now = 100, baselineRestart?: number) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-real-bot-eval-")); const file = path.join(dir, "evidence.json"); writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  const baseline = baselineRestart === undefined ? "" : `'${baselineRestart}'`;
  return shell(`evaluate_real_bot_readiness_evidence "$(< '${file}')" '${attempt}' '${started}' '${now}' '${imageId}' '${sha}' ${baseline}`);
}

describe("Bot-owned readiness marker", () => {
  it("publishes a complete current-generation marker atomically", async () => { const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-marker-")); const file = path.join(dir, "ready.json"); const value = await publishBotReadiness(sha, file, 123_000); expect(value.state).toBe("ready"); expect(await readBotReadiness(file)).toEqual(value); await removeBotReadiness(file); });
  it("parses Linux process start ticks without trusting the command name", () => { expect(linuxProcessStartTicks("42 (node worker) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 999")).toBe("999"); expect(() => linuxProcessStartTicks("truncated")).toThrow("proc-stat-invalid"); });
  it("rejects an invalid generation", async () => { const file = path.join(mkdtempSync(path.join(os.tmpdir(), "zedbot-marker-")), "ready.json"); await expect(publishBotReadiness("short", file)).rejects.toThrow("generation-invalid"); });
  it("cannot publish readiness before required local database initialization", async () => { const file = path.join(mkdtempSync(path.join(os.tmpdir(), "zedbot-marker-")), "ready.json"); await expect(completeBotStartupReadiness({ databaseInitialized: false, generation: sha, markerPath: file })).rejects.toThrow("initialization-incomplete"); expect(() => readFileSync(file)).toThrow(); });
  it("publishes only after the complete startup coordinator confirms initialization", async () => { const file = path.join(mkdtempSync(path.join(os.tmpdir(), "zedbot-marker-")), "ready.json"); const value = await completeBotStartupReadiness({ databaseInitialized: true, generation: sha, markerPath: file, now: 125_000 }); expect(value.readyAt).toBe(125_000); await removeBotReadiness(file); });
  // Regression (P2, PR #155 review of src/index.ts:223 - "Permit
  // development builds without a deployment SHA"): wait_for_real_bot_
  // readiness (lib/common.sh) always polls with a validated, full
  // deployment SHA sourced from current/candidate metadata - never from the
  // running process's own environment - so a build without GIT_SHA (e.g.
  // local dev, `pnpm dev:bot`) is never the target of that check. The old
  // onStart callback threw unconditionally when runningGitSha() returned
  // null, which index.ts's own outer catch treats as fatal and non-
  // retryable - crash-looping every dev/unknown-SHA run forever, since
  // GIT_SHA never becomes defined on a later attempt.
  it("skips readiness publication entirely for an unknown (null) generation, without requiring database initialization", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "zedbot-marker-")), "ready.json");
    const skippedNoDb = await completeBotStartupReadinessIfKnownGeneration({ databaseInitialized: false, generation: null, markerPath: file });
    expect(skippedNoDb).toBeNull();
    const skippedWithDb = await completeBotStartupReadinessIfKnownGeneration({ databaseInitialized: true, generation: null, markerPath: file });
    expect(skippedWithDb).toBeNull();
    expect(() => readFileSync(file)).toThrow();
  });
  it("still publishes, and still requires database initialization, once a real generation is known", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "zedbot-marker-")), "ready.json");
    await expect(completeBotStartupReadinessIfKnownGeneration({ databaseInitialized: false, generation: sha, markerPath: file })).rejects.toThrow("initialization-incomplete");
    expect(() => readFileSync(file)).toThrow();
    const value = await completeBotStartupReadinessIfKnownGeneration({ databaseInitialized: true, generation: sha, markerPath: file, now: 125_000 });
    expect(value?.readyAt).toBe(125_000);
    await removeBotReadiness(file);
  });
  it("index.ts no longer throws bot-readiness-generation-unavailable on a null generation", () => {
    const text = readFileSync(path.join(root, "apps/bot/src/index.ts"), "utf8");
    expect(text).not.toContain("bot-readiness-generation-unavailable");
    expect(text).toContain("completeBotStartupReadinessIfKnownGeneration");
  });
  // Regression (P2, PR #155 review of src/index.ts:223 - "Publish local
  // readiness before Telegram initialization"): grammY's bot.start()
  // performs its own Telegram-dependent setup (getMe, webhook deletion)
  // BEFORE its onStart callback ever runs. Publishing readiness from inside
  // onStart meant a Telegram outage - unrelated to whether this process's
  // own database/consumers/handlers/local loops came up correctly - left
  // the readiness marker unpublished forever, so the Docker healthcheck and
  // validate_running_application timed out and classified an otherwise
  // healthy deployment as failed.
  it("publishes readiness before bot.start() is called, not from inside its onStart callback", () => {
    const text = readFileSync(path.join(root, "apps/bot/src/index.ts"), "utf8");
    // Anchored to the real call site (`pollingPromise = bot.start(`), not
    // "bot.start(" alone - earlier comments in this file mention bot.start()
    // in prose.
    const readinessCall = text.indexOf("completeBotStartupReadinessIfKnownGeneration(");
    const startCall = text.indexOf("pollingPromise = bot.start(");
    expect(readinessCall).toBeGreaterThan(-1);
    expect(startCall).toBeGreaterThan(-1);
    expect(readinessCall).toBeLessThan(startCall);
    // And it must not be nested inside the onStart callback itself, e.g.
    // reappearing again between onStart's own definition and bot.start(.
    const onStartIndex = text.indexOf("onStart:", readinessCall);
    expect(onStartIndex).toBeGreaterThan(startCall);
  });
  it("rejects a symlinked marker destination", async () => { const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-marker-")); const target = path.join(dir, "target"); const file = path.join(dir, "ready.json"); writeFileSync(target, "safe"); symlinkSync(target, file); await expect(publishBotReadiness(sha, file)).rejects.toThrow("symlinked"); expect(readFileSync(target, "utf8")).toBe("safe"); });
  it("rejects unsafe marker permissions", async () => { const file = path.join(mkdtempSync(path.join(os.tmpdir(), "zedbot-marker-")), "ready.json"); writeFileSync(file, "{}", { mode: 0o644 }); chmodSync(file, 0o644); await expect(readBotReadiness(file)).rejects.toThrow("unsafe"); });
  it("removes only a regular marker and refuses a symlink", async () => { const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-marker-")); const target = path.join(dir, "target"); const file = path.join(dir, "ready.json"); writeFileSync(target, "safe"); symlinkSync(target, file); await expect(removeBotReadiness(file)).rejects.toThrow("unsafe"); expect(readFileSync(target, "utf8")).toBe("safe"); });
});

describe("readiness CLI marker schema validation", () => {
  // Regression: docker-compose runs the bot as the sole process in its
  // container (no init/tini), so grammY's own process is container PID 1.
  // A boundary bug here (`processId <= 1`) rejected that legitimate identity
  // on every single check, permanently failing the bot's Docker healthcheck
  // and, in turn, `wait_for_readiness_policy application` and
  // `wait_for_real_bot_readiness` - never a timing race, always closed.
  it("accepts processId 1 (the bot's own container PID when it is the sole process)", () => {
    expect(() => validateMarker(marker())).not.toThrow();
    const m: Marker = { ...marker(), processId: 1 };
    expect(() => validateMarker(m)).not.toThrow();
  });
  it.each([0, -1])("rejects a non-positive processId (%d)", (processId) => {
    const m: Marker = { ...marker(), processId };
    expect(() => validateMarker(m)).toThrow("bot-readiness-pid-invalid");
  });
});

describe("real Bot structured evidence", () => {
  it("accepts valid current-operation, current-generation readiness", () => expect(evaluate(evidence()).status).toBe(0));
  it("accepts processId 1 (container PID 1 - the bot's own identity when it is the sole container process)", () => {
    const value = evidence({ marker: { ...marker(), processId: 1 } });
    expect(evaluate(value).status).toBe(0);
  });
  it.each([
    ["empty", ""], ["malformed", "{"], ["truncated", '{"formatVersion":1'],
  ])("rejects %s evidence", (_name, value) => expect(evaluate(value).status).toBe(2));
  it.each([
    ["incomplete initialization", (e: Evidence) => { (e.bot.marker as Marker).components.handlers = false; }],
    ["startup failed", (e: Evidence) => { e.bot.status = "exited"; }],
    ["terminal failure", (e: Evidence) => { e.bot.status = "dead"; }],
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
  // Regression: the bot container can legitimately crash-loop once (e.g.
  // waiting on a dependency) before becoming healthy, or carry a restart
  // from well before this readiness wait began (an old OOM kill, a host
  // reboot) - neither should, by itself, mark otherwise-healthy,
  // identity-checked evidence terminal forever, with no operator recourse
  // short of force-recreating the container. restartCount is checked as a
  // delta against baseline_restart (the count as first observed by THIS
  // wait), not required to equal zero outright - mirrors
  // evaluate_readiness_evidence's identical baseline-delta fix.
  it("a nonzero restartCount with no known baseline (first observation of a wait) is not rejected", () => {
    expect(evaluate(evidence({ restartCount: 3 })).status).toBe(0);
  });
  it("a restartCount at or below its baseline is accepted", () => {
    expect(evaluate(evidence({ restartCount: 2 }), 100, 100, 2).status).toBe(0);
  });
  it("a restartCount that increased beyond its baseline during this wait is rejected", () => {
    expect(evaluate(evidence({ restartCount: 3 }), 100, 100, 2).status).toBe(2);
  });
  // Regression: current_readiness_attempt()'s fallback outside any active
  // operation returns the "preflight:<generation>:current-validated"
  // sentinel (no real kind exists yet to report), but the boundary's own
  // .operation field always records the REAL kind that recreated the bot
  // (install/update/rollback). Comparing a reconstructed "<kind>:<generation>"
  // string built from "preflight:..." against that field can never match any
  // real kind, so update.sh's own step 3 ("capture the healthy running
  // application rollback candidate", which calls validate_running_application
  // with no SHA and so hits this exact fallback) failed on every single
  // legacy-upgrade run once the backup-verification gate ahead of it was
  // fixed - not a timing race, a combination that could never succeed.
  it("matches a preflight (no active operation) attempt against a boundary recorded by any real operation kind", () => {
    const preflightAttempt = `preflight:${generation}:current-validated`;
    const value = evidence({ attempt: preflightAttempt });
    value.boundary.operation = `install:${generation}`;
    const result = shell(`evaluate_real_bot_readiness_evidence '${JSON.stringify(value)}' '${preflightAttempt}' '100' '100' '${imageId}' '${sha}'`);
    expect(result.status, result.stderr).toBe(0);
  });
});

describe("bounded real Bot polling and state suppression", () => {
  it("records a lock-owned bot recreation boundary from the confirmed container identity", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-bot-boundary-")); const boundary = path.join(dir, "bot-recreation.json");
    const body = `set_deployment_state_paths '${dir}'; acquire_deployment_lock; initialize_operation_state update '${generation}'; for pair in 'current-validated current-image-retained' 'current-image-retained candidate-metadata-prepared' 'candidate-metadata-prepared candidate-image-built' 'candidate-image-built deployment-reference-tagged' 'deployment-reference-tagged compatibility-confirmed' 'compatibility-confirmed migrations-confirmed'; do set -- $pair; advance_operation_state "$1" "$2"; done; run_compose(){ [ "$1" = ps ] && echo bot-container; }; run_clean_docker(){ jq -cn --arg image '${imageId}' --arg sha '${sha}' '[{Id:"bot-container",Image:$image,RestartCount:0,Config:{Image:"zedbot-app:latest",Env:[("GIT_SHA="+$sha)],Labels:{"com.docker.compose.project":"zedbot","com.docker.compose.service":"bot"}},State:{Status:"running"}}]'; }; record_bot_recreation_boundary '${imageId}' '${sha}'; validate_bot_recreation_boundary`;
    const result = shell(body); expect(result.status, result.stderr).toBe(0); expect(JSON.parse(readFileSync(boundary, "utf8"))).toMatchObject({ operation: `update:${generation}`, containerId: "bot-container", imageId });
  });
  it("rejects recreation boundary recording without the lock or correct predecessor", () => { const result = shell(`require_deployment_lock(){ return 1; }; record_bot_recreation_boundary '${imageId}' '${sha}'`); expect(result.status).not.toBe(0); });

  // Regression: `zedbot restart` force-recreates every container, including
  // bot, entirely outside any tracked install/update/rollback operation -
  // record_bot_recreation_boundary requires exactly that kind of operation
  // to be active, so it could never be called from restart directly. The
  // recreated bot container's id then permanently mismatched
  // bot-recreation.json's stale one, failing every later real-bot readiness
  // check (collect_real_bot_readiness_evidence) until an operator
  // manually repaired the file - silently breaking the documented
  // "add TELEGRAM_BOT_TOKEN, then run zedbot restart" first-install flow.
  describe("bot recreation boundary refresh after a bare restart", () => {
    const currentMetadata = (overrides: Record<string, unknown> = {}) => ({
      formatVersion: 2, installationKind: null, lifecycleRole: "current", generation,
      sourceTree: "c".repeat(40), preDeploySha: "a".repeat(40), preDeployImageId: `sha256:${"1".repeat(64)}`,
      targetDeploySha: sha, targetImageId: imageId,
      retainedImageTag: `zedbot-app:rollback-${generation}`, immutableImageTag: `zedbot-app:generation-${generation}`,
      failedTargetTag: `zedbot-app:failed-${generation}`, capturedAt: "2026-08-10T12:00:00Z", preDeployMigrations: [],
      declarationFormatVersion: 2, declarationSourceCategory: "generation-evidence",
      migrationEvidencePath: "/state/evidence-x", composeEvidencePath: "/state/evidence-x/docker-compose.yml",
      composeEvidenceSha256: "d".repeat(64), composeProjectName: "zedbot", composeApplicationImage: "zedbot-app:latest",
      compatibilityManifestSha256: "e".repeat(64), compatibilityDeclarations: [],
      recreationAttempted: true, healthConfirmed: true, state: "known-good", ...overrides,
    });
    const dockerStub = `run_compose(){ [ "$1" = ps ] && echo bot-container; }; run_clean_docker(){ jq -cn --arg image '${imageId}' --arg sha '${sha}' '[{Id:"bot-container",Image:$image,RestartCount:0,Config:{Image:"zedbot-app:latest",Env:[("GIT_SHA="+$sha)],Labels:{"com.docker.compose.project":"zedbot","com.docker.compose.service":"bot"}},State:{Status:"running"}}]'; }`;

    it("writes a valid restart-kind boundary sourced from current.json", () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-restart-boundary-"));
      writeFileSync(path.join(dir, "current.json"), JSON.stringify(currentMetadata()));
      chmodSync(path.join(dir, "current.json"), 0o600);
      const result = shell(`set_deployment_state_paths '${dir}'; acquire_deployment_lock; ${dockerStub}; record_bot_recreation_boundary_after_restart`);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(readFileSync(path.join(dir, "bot-recreation.json"), "utf8"))).toMatchObject({ operation: `restart:${generation}`, generation, containerId: "bot-container", imageId });
    });

    it("returns 2 (soft-skip) and writes nothing when current.json does not exist yet", () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-restart-no-current-"));
      // common.sh runs under `set -Eeuo pipefail`: a bare failing statement
      // would abort the script under errexit before a trailing `echo` could
      // run, so the nonzero return must be consumed inside a conditional.
      const result = shell(`set_deployment_state_paths '${dir}'; acquire_deployment_lock; ${dockerStub}; if record_bot_recreation_boundary_after_restart; then rc=0; else rc=$?; fi; echo "rc=$rc"`);
      expect(result.stdout).toContain("rc=2");
      expect(() => readFileSync(path.join(dir, "bot-recreation.json"))).toThrow();
    });

    it("fails (not 2) when the recreated bot container does not match current.json's expected image or generation", () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-restart-mismatch-"));
      writeFileSync(path.join(dir, "current.json"), JSON.stringify(currentMetadata()));
      chmodSync(path.join(dir, "current.json"), 0o600);
      const wrongShaStub = `run_compose(){ [ "$1" = ps ] && echo bot-container; }; run_clean_docker(){ jq -cn --arg image '${imageId}' --arg sha '${"f".repeat(40)}' '[{Id:"bot-container",Image:$image,RestartCount:0,Config:{Image:"zedbot-app:latest",Env:[("GIT_SHA="+$sha)],Labels:{"com.docker.compose.project":"zedbot","com.docker.compose.service":"bot"}},State:{Status:"running"}}]'; }`;
      const result = shell(`set_deployment_state_paths '${dir}'; acquire_deployment_lock; ${wrongShaStub}; if record_bot_recreation_boundary_after_restart; then rc=0; else rc=$?; fi; echo "rc=$rc"`);
      expect(result.stdout).not.toContain("rc=2");
      expect(result.stdout).not.toContain("rc=0");
    });

    it("requires the deployment lock", () => {
      const result = shell(`require_deployment_lock(){ return 1; }; record_bot_recreation_boundary_after_restart`);
      expect(result.status).not.toBe(0);
    });

    it("validate_bot_recreation_boundary accepts a restart-kind operation and still rejects an unknown kind", () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-boundary-schema-"));
      const file = path.join(dir, "bot-recreation.json");
      const base = { formatVersion: 1, generation, containerId: "bot-container", imageId, imageRef: "zedbot-app:latest", project: "zedbot", service: "bot", recreatedAt: 100 };
      writeFileSync(file, JSON.stringify({ ...base, operation: `restart:${generation}` }));
      chmodSync(file, 0o600);
      expect(shell(`set_deployment_state_paths '${dir}'; validate_bot_recreation_boundary`).status).toBe(0);
      writeFileSync(file, JSON.stringify({ ...base, operation: `deploy:${generation}` }));
      chmodSync(file, 0o600);
      expect(shell(`set_deployment_state_paths '${dir}'; validate_bot_recreation_boundary`).status).not.toBe(0);
    });

    it("zedbot.sh's restart command locks, recreates, then refreshes the recreation boundary before reporting success", () => {
      const zedbot = readFileSync(path.join(root, "scripts/zedbot.sh"), "utf8");
      const start = zedbot.indexOf("restart)");
      // Not the first ";;" after start - the nested case (restart_boundary_rc)
      // inside this branch has its own arms terminated by ";;" well before
      // this branch itself ends. Bound on the next top-level case label.
      const end = zedbot.indexOf("\n  start)", start);
      const body = zedbot.slice(start, end);
      const lockIndex = body.indexOf("acquire_deployment_lock");
      const recreateIndex = body.indexOf("run_compose up -d --force-recreate");
      const boundaryIndex = body.indexOf("record_bot_recreation_boundary_after_restart");
      const successIndex = body.indexOf("log_success");
      expect(lockIndex).toBeGreaterThan(-1);
      expect(recreateIndex).toBeGreaterThan(-1);
      expect(boundaryIndex).toBeGreaterThan(-1);
      expect(successIndex).toBeGreaterThan(-1);
      expect(lockIndex).toBeLessThan(recreateIndex);
      expect(recreateIndex).toBeLessThan(boundaryIndex);
      expect(boundaryIndex).toBeLessThan(successIndex);
    });

    // Regression: a failed update that reached application recreation
    // deliberately leaves zedbot-app:latest on the (possibly broken)
    // candidate image - current.json still names the previous known-good
    // generation, and failed.json records the unresolved failure (see
    // update_owned_cleanup's own comment: restoring the tag there would
    // fight, not help, an in-progress recreation). Neither restart nor
    // start checked for this before force-recreating/starting from
    // whatever zedbot-app:latest currently is, so either command could
    // redeploy a known-failed candidate across every service.
    it("zedbot.sh's restart and start commands both refuse while a failed generation is unresolved", () => {
      const zedbot = readFileSync(path.join(root, "scripts/zedbot.sh"), "utf8");
      const restartStart = zedbot.indexOf("restart)");
      const restartEnd = zedbot.indexOf("\n  start)", restartStart);
      const restartBody = zedbot.slice(restartStart, restartEnd);
      const restartLock = restartBody.indexOf("acquire_deployment_lock");
      const restartAssert = restartBody.indexOf("assert_no_unresolved_failed_generation");
      // Anchored from restartAssert onward: the guard's own explanatory
      // comment, just above the real call, mentions
      // bind_current_generation_compose_contract in prose first.
      const restartBind = restartBody.indexOf("bind_current_generation_compose_contract", restartAssert);
      const restartRecreate = restartBody.indexOf("run_compose up -d --force-recreate");
      expect(restartAssert).toBeGreaterThan(restartLock);
      expect(restartAssert).toBeLessThan(restartBind);
      expect(restartBind).toBeLessThan(restartRecreate);

      const startStart = zedbot.indexOf("\n  start)");
      const startEnd = zedbot.indexOf("\n  stop)", startStart);
      const startBody = zedbot.slice(startStart, startEnd);
      const startLock = startBody.indexOf("acquire_deployment_lock");
      const startAssert = startBody.indexOf("assert_no_unresolved_failed_generation");
      const startBind = startBody.indexOf("bind_current_generation_compose_contract");
      const startUp = startBody.indexOf("run_compose up -d\n");
      expect(startAssert).toBeGreaterThan(startLock);
      expect(startAssert).toBeLessThan(startBind);
      expect(startBind).toBeLessThan(startUp);
    });

    // Regression: `up -d` (start) can create or replace the bot container
    // too - e.g. it did not exist yet, or stopped containers were pruned
    // before this run - assigning it a new container ID while bot-
    // recreation.json keeps pointing at the old (now-removed) one. The
    // next update's real-bot readiness preflight
    // (collect_real_bot_readiness_evidence) then fails because it requires
    // the live ID to equal the recorded one. start now refreshes the
    // boundary exactly like restart already does.
    it("zedbot.sh's start command also locks, starts, then refreshes the recreation boundary before reporting success", () => {
      const zedbot = readFileSync(path.join(root, "scripts/zedbot.sh"), "utf8");
      const start = zedbot.indexOf("\n  start)");
      const end = zedbot.indexOf("\n  stop)", start);
      const body = zedbot.slice(start, end);
      const lockIndex = body.indexOf("acquire_deployment_lock");
      const upIndex = body.indexOf("run_compose up -d\n");
      const boundaryIndex = body.indexOf("record_bot_recreation_boundary_after_restart");
      const successIndex = body.indexOf("log_success");
      expect(lockIndex).toBeGreaterThan(-1);
      expect(upIndex).toBeGreaterThan(-1);
      expect(boundaryIndex).toBeGreaterThan(-1);
      expect(successIndex).toBeGreaterThan(-1);
      expect(lockIndex).toBeLessThan(upIndex);
      expect(upIndex).toBeLessThan(boundaryIndex);
      expect(boundaryIndex).toBeLessThan(successIndex);
    });

    // Regression (P1): "Reject restarts after an incomplete rollback" - a
    // NORMAL rollback that itself fails after retagging zedbot-app:latest
    // and starting application recreation leaves current.json naming the
    // OLDER, pre-rollback generation while the tag (and possibly the
    // containers themselves) are already on the rollback target - a
    // different, non-overlapping danger from the failed-UPDATE case
    // assert_no_unresolved_failed_generation guards (rollback.sh never
    // writes failed.json). Both guards are required in both commands.
    it("zedbot.sh's restart and start commands both also refuse while a rollback attempt is incomplete, after the failed-generation check", () => {
      const zedbot = readFileSync(path.join(root, "scripts/zedbot.sh"), "utf8");
      const restartStart = zedbot.indexOf("restart)");
      const restartEnd = zedbot.indexOf("\n  start)", restartStart);
      const restartBody = zedbot.slice(restartStart, restartEnd);
      const restartFailedAssert = restartBody.indexOf("assert_no_unresolved_failed_generation");
      const restartRollbackAssert = restartBody.indexOf("assert_no_incomplete_rollback_attempt", restartFailedAssert);
      const restartBind = restartBody.indexOf("bind_current_generation_compose_contract", restartRollbackAssert);
      expect(restartFailedAssert).toBeGreaterThan(-1);
      expect(restartRollbackAssert).toBeGreaterThan(restartFailedAssert);
      expect(restartRollbackAssert).toBeLessThan(restartBind);

      const startStart = zedbot.indexOf("\n  start)");
      const startEnd = zedbot.indexOf("\n  stop)", startStart);
      const startBody = zedbot.slice(startStart, startEnd);
      const startFailedAssert = startBody.indexOf("assert_no_unresolved_failed_generation");
      const startRollbackAssert = startBody.indexOf("assert_no_incomplete_rollback_attempt", startFailedAssert);
      const startBind = startBody.indexOf("bind_current_generation_compose_contract", startRollbackAssert);
      expect(startFailedAssert).toBeGreaterThan(-1);
      expect(startRollbackAssert).toBeGreaterThan(startFailedAssert);
      expect(startRollbackAssert).toBeLessThan(startBind);
    });

    // Functional coverage of assert_no_incomplete_rollback_attempt itself,
    // extracted directly from zedbot.sh (it is not defined in common.sh).
    describe("assert_no_incomplete_rollback_attempt", () => {
      const zedbot = readFileSync(path.join(root, "scripts/zedbot.sh"), "utf8");
      const fnStart = zedbot.indexOf("assert_no_incomplete_rollback_attempt() {");
      const fnEnd = zedbot.indexOf("\n\ncase \"$CMD\" in", fnStart);
      const fn = zedbot.slice(fnStart, fnEnd);

      function run(operationState: Record<string, unknown> | string | null) {
        const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-incomplete-rollback-"));
        chmodSync(dir, 0o700);
        const file = path.join(dir, "operation-state.json");
        if (operationState !== null) {
          writeFileSync(file, typeof operationState === "string" ? operationState : JSON.stringify(operationState));
          chmodSync(file, 0o600);
        }
        return shell(`set_deployment_state_paths '${dir}'; ${fn}\nassert_no_incomplete_rollback_attempt`);
      }

      it("passes when no operation state exists at all", () => {
        const result = run(null);
        expect(result.status, result.stderr).toBe(0);
      });

      it.each(["previous-selected", "rollback-evidence-validated", "retained-image-validated", "compatibility-confirmed", "deployment-reference-retagged", "application-recreated", "health-confirmed", "promotion-prepared"])(
        "refuses while a rollback is stuck at stage %s, naming the remedy",
        (stage) => {
          const result = run({ formatVersion: 1, kind: "rollback", generation, stage });
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain("zedbot rollback");
          expect(result.stderr).toContain("doctor");
        },
      );

      it("passes once the rollback reached the promoted stage", () => {
        const result = run({ formatVersion: 1, kind: "rollback", generation, stage: "promoted" });
        expect(result.status, result.stderr).toBe(0);
      });

      it("is not this function's concern for any other operation kind, even if incomplete", () => {
        const result = run({ formatVersion: 1, kind: "update", generation, stage: "application-recreated" });
        expect(result.status, result.stderr).toBe(0);
      });

      it("fails closed on a present but malformed/unsafe operation-state.json", () => {
        const result = run("not valid json");
        expect(result.status).not.toBe(0);
      });
    });
  });

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
  // A restartCount that's already nonzero on the very FIRST poll of a wait
  // becomes the baseline (accepted, not rejected) - but that SAME container
  // increasing further on a LATER poll of that same wait is an active
  // restart happening right now and must still fail closed.
  it("tolerates a restartCount already nonzero on the first poll of a wait", () => {
    const result = poll([evidence({ restartCount: 2 })]);
    expect(result.result.status).toBe(0); expect(result.calls).toBe(1);
  });
  it("still fails closed when restartCount increases during the wait", () => {
    const first = () => evidence({ restartCount: 2, marker: { formatVersion: 1, state: "starting" } });
    const second = () => evidence({ restartCount: 3 });
    const result = poll([first(), second()]);
    expect(result.result.status).not.toBe(0); expect(result.calls).toBe(2);
  });
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
