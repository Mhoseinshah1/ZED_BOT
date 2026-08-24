import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const common = path.join(root, "scripts/lib/common.sh");
const sha = "a".repeat(40);
const imageId = `sha256:${"b".repeat(64)}`;
const attempt = "update:20260810T120000Z-aaaaaaaaaaaa:migrations-confirmed";

type Kind = "dependency" | "application";
type RecordShape = { service: string; containerId: string; imageId: string; imageRef: string; project: string; declaredService: string; status: string; health: string; restartCount: number; generation: string };
type MutableEvidence = { services: Array<Partial<RecordShape>> };
function record(service: string, kind: Kind): RecordShape {
  const app = kind === "application";
  return { service, containerId: `${service}-id`, imageId: app ? imageId : `sha256:${(service === "postgres" ? "c" : "d").repeat(64)}`,
    imageRef: app ? "zedbot-app:latest" : service === "postgres" ? "postgres:16-alpine" : "redis:7-alpine",
    project: "zedbot", declaredService: service, status: "running", health: "healthy", restartCount: 0, generation: app ? sha : "" };
}
function evidence(kind: Kind, overrides: Partial<{ attempt: string; observedAt: number; services: RecordShape[] }> = {}) {
  const names = kind === "dependency" ? ["postgres", "redis"] : ["api", "bot", "worker"];
  return { formatVersion: 1, kind, attempt, observedAt: 100, services: names.map((name) => record(name, kind)), ...overrides };
}
function shell(body: string) { return spawnSync("bash", ["-c", `. '${common}'; ${body}`], { encoding: "utf8" }); }
function evaluate(value: unknown, kind: Kind = "dependency", started = 100, now = 100, baselineRestarts?: Record<string, number>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-ready-")); const file = path.join(dir, "evidence.json"); writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  const baseline = baselineRestarts === undefined ? "" : `'${JSON.stringify(baselineRestarts)}'`;
  return shell(`evaluate_readiness_evidence "$(< '${file}')" '${kind}' '${attempt}' '${started}' '${now}' '${kind === "application" ? imageId : ""}' '${kind === "application" ? sha : ""}' ${baseline}`);
}

describe("authoritative readiness evidence", () => {
  it.each(["dependency", "application"] as Kind[])("accepts a complete fresh %s set", (kind) => expect(evaluate(evidence(kind), kind).status).toBe(0));
  it("collects and evaluates fresh dependency inspections through the real collector", () => {
    // run_clean_docker now serves both the container-id lookup (a direct
    // "docker ps" label filter, so a leftover "compose run --rm" oneoff
    // container can never masquerade as a second instance of a service -
    // "docker compose ps" has no general label filter to express that) and
    // the inspect call the original mock already covered.
    const body = `run_clean_docker(){ if [ "$1" = ps ]; then s="\${6#*service=}"; printf '%s-id\\n' "$s"; else s="\${2%-id}"; [ "$s" = postgres ] && ref=postgres:16-alpine || ref=redis:7-alpine; [ "$s" = postgres ] && char=c || char=d; id=$(printf "$char%.0s" {1..64}); jq -cn --arg s "$s" --arg ref "$ref" --arg id "sha256:$id" '[{Id:($s+"-id"),Image:$id,RestartCount:0,Config:{Image:$ref,Env:[],Labels:{"com.docker.compose.project":"zedbot","com.docker.compose.service":$s}},State:{Status:"running",Health:{Status:"healthy"}}}]'; fi; }; value=$(collect_readiness_evidence dependency '${attempt}' 100 ''); evaluate_readiness_evidence "$value" dependency '${attempt}' 100 100 '' ''`;
    expect(shell(body).status).toBe(0);
  });

  it.each([
    ["missing dependency", (e: MutableEvidence) => e.services.pop()],
    ["duplicate dependency identity", (e: MutableEvidence) => e.services[1].containerId = e.services[0].containerId],
    ["substituted dependency", (e: MutableEvidence) => e.services[0].service = e.services[0].declaredService = "mysql"],
    ["unhealthy dependency", (e: MutableEvidence) => e.services[0].health = "unhealthy"],
    ["dependency exited", (e: MutableEvidence) => e.services[0].status = "exited"],
    ["dependency restarting", (e: MutableEvidence) => e.services[0].status = "restarting"],
    ["dependency dead", (e: MutableEvidence) => e.services[0].status = "dead"],
    ["unknown state", (e: MutableEvidence) => e.services[0].health = "mystery"],
    ["missing field", (e: MutableEvidence) => delete e.services[0].health],
    ["wrong field type", (e: MutableEvidence) => e.services[0].restartCount = "zero" as unknown as number],
    ["contradictory service label", (e: MutableEvidence) => e.services[0].declaredService = "redis"],
    ["wrong project", (e: MutableEvidence) => e.services[0].project = "hostile"],
    ["wrong dependency image", (e: MutableEvidence) => e.services[0].imageRef = "fork/postgres:latest"],
  ])("rejects %s", (_name, mutate) => { const e = evidence("dependency") as MutableEvidence; mutate(e); expect(evaluate(e).status).toBe(2); });

  it.each([
    ["partial application set", (e: MutableEvidence) => e.services.pop()],
    ["api only healthy", (e: MutableEvidence) => { e.services[1].health = "unhealthy"; e.services[2].health = "unhealthy"; }],
    ["bot only healthy", (e: MutableEvidence) => { e.services[0].health = "unhealthy"; e.services[2].health = "unhealthy"; }],
    ["worker only healthy", (e: MutableEvidence) => { e.services[0].health = "unhealthy"; e.services[1].health = "unhealthy"; }],
    ["duplicate app container", (e: MutableEvidence) => e.services[2].containerId = e.services[1].containerId],
    ["mixed generation", (e: MutableEvidence) => e.services[1].generation = "f".repeat(40)],
    ["wrong immutable image", (e: MutableEvidence) => e.services[2].imageId = `sha256:${"e".repeat(64)}`],
    ["substituted app service", (e: MutableEvidence) => e.services[0].service = e.services[0].declaredService = "postgres"],
  ])("rejects %s", (_name, mutate) => { const e = evidence("application") as MutableEvidence; mutate(e); expect(evaluate(e, "application").status).toBe(2); });

  // Regression: postgres/redis are never recreated between deploys, so a
  // single historical restart from before this readiness wait even began
  // (an old OOM kill, a host reboot) must not by itself fail readiness -
  // only a further increase DURING this wait (an active restart loop
  // happening right now) should. restartCount is checked as a delta
  // against baseline_restarts (each service's count as first observed this
  // wait), not required to equal zero outright.
  it("a nonzero restartCount with no known baseline (first observation of a wait) is not rejected", () => {
    const e = evidence("dependency") as MutableEvidence; e.services[0].restartCount = 3;
    expect(evaluate(e).status).toBe(0);
  });
  it("a restartCount at or below its baseline is accepted", () => {
    const e = evidence("application") as MutableEvidence; e.services[0].restartCount = 2;
    expect(evaluate(e, "application", 100, 100, { api: 2, bot: 0, worker: 0 }).status).toBe(0);
  });
  it("a restartCount that increased beyond its baseline during this wait is rejected", () => {
    const e = evidence("application") as MutableEvidence; e.services[0].restartCount = 3;
    expect(evaluate(e, "application", 100, 100, { api: 2, bot: 0, worker: 0 }).status).toBe(2);
  });

  it.each([
    ["empty output", ""], ["malformed JSON", "{"], ["truncated JSON", '{"formatVersion":1'],
  ])("rejects %s", (_name, value) => expect(evaluate(value).status).toBe(2));
  it("rejects stale evidence from an earlier operation", () => expect(evaluate(evidence("dependency", { attempt: "old-attempt" })).status).toBe(2));
  it("rejects stale observed time", () => expect(evaluate(evidence("dependency", { observedAt: 90 }), "dependency", 100, 100).status).toBe(2));
  it("treats a complete starting set as retryable", () => { const e = evidence("dependency"); e.services.forEach((s) => s.health = "starting"); expect(evaluate(e).status).toBe(1); });
  it("treats a complete mixed healthy and starting set as retryable", () => { const e = evidence("application"); e.services[1].health = "starting"; expect(evaluate(e, "application").status).toBe(1); });
  it("never treats a missing mandatory service as ready or retryable", () => { const e = evidence("application"); e.services.pop(); expect(evaluate(e, "application").status).toBe(2); });
});

describe("bounded polling and flow suppression", () => {
  function poll(sequence: unknown[], timeout = 9, cancel = false) {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-poll-")); const queue = path.join(dir, "queue"); const clock = path.join(dir, "clock"); const calls = path.join(dir, "calls");
    writeFileSync(queue, sequence.map((x) => JSON.stringify(x)).join("\n") + "\n"); writeFileSync(clock, "100");
    const body = `validate_compose_readiness_contract(){ return 0; }; readiness_now(){ cat '${clock}'; }; readiness_pause(){ ${cancel ? "return 130" : `v=$(cat '${clock}'); echo $((v+$1)) >'${clock}'`}; }; collect_readiness_evidence(){ echo x >>'${calls}'; item=$(sed -n '1p' '${queue}'); sed -i '1d' '${queue}'; printf '%s' "$item" | jq --argjson now "$(cat '${clock}')" '.observedAt=$now'; }; wait_for_readiness_policy dependency '${attempt}' '' '' '${timeout}' 3`;
    const result = shell(body); return { result, calls: readFileSync(calls, "utf8").trim().split("\n").length };
  }
  const starting = () => { const e = evidence("dependency"); e.services.forEach((s) => s.health = "starting"); return e; };
  const converging = () => { const e = evidence("dependency"); e.services[1].health = "starting"; return e; };
  it("retries and succeeds before the deadline", () => { const r = poll([starting(), evidence("dependency")]); expect(r.result.status).toBe(0); expect(r.calls).toBe(2); });
  it("expires at a finite deadline without a busy loop", () => { const r = poll([starting(), starting(), starting(), starting()], 9); expect(r.result.status).not.toBe(0); expect(r.calls).toBe(4); });
  it("retries a mixed healthy and starting set until all services are healthy", () => { const r = poll([converging(), evidence("dependency")]); expect(r.result.status).toBe(0); expect(r.calls).toBe(2); });
  it("a mixed healthy and starting set fails at the bounded deadline", () => { const r = poll([converging(), converging(), converging(), converging()], 9); expect(r.result.status).not.toBe(0); expect(r.calls).toBe(4); });
  it("cancellation is failure and stops polling", () => { const r = poll([starting(), evidence("dependency")], 9, true); expect(r.result.status).not.toBe(0); expect(r.calls).toBe(1); });
  // A restartCount that's already nonzero on the very FIRST poll of a wait
  // becomes the baseline (accepted, not rejected) - but the SAME service
  // increasing further on a LATER poll of that same wait is an active
  // restart happening right now and must still fail closed.
  it("tolerates a restartCount already nonzero on the first poll of a wait", () => {
    const withHistoricalRestart = () => { const e = evidence("dependency"); e.services[0].restartCount = 2; return e; };
    const r = poll([withHistoricalRestart()]);
    expect(r.result.status).toBe(0); expect(r.calls).toBe(1);
  });
  it("still fails closed when restartCount increases during the wait", () => {
    const first = () => { const e = evidence("dependency"); e.services.forEach((s) => s.health = "starting"); e.services[0].restartCount = 2; return e; };
    const second = () => { const e = evidence("dependency"); e.services[0].restartCount = 3; return e; };
    const r = poll([first(), second()]);
    expect(r.result.status).not.toBe(0); expect(r.calls).toBe(2);
  });
  it("terminal failure stops additional polling", () => { const bad = evidence("dependency"); bad.services[0].status = "exited"; const r = poll([bad, evidence("dependency")]); expect(r.result.status).not.toBe(0); expect(r.calls).toBe(1); });
  it("a failed inspection command rejects valid-looking later content", () => { const result = shell(`validate_compose_readiness_contract(){ return 0; }; readiness_now(){ echo 100; }; collect_readiness_evidence(){ printf '%s' '${JSON.stringify(evidence("dependency"))}'; return 1; }; wait_for_readiness_policy dependency '${attempt}' '' '' 9 3`); expect(result.status).not.toBe(0); });
  it("success exit with invalid content fails closed", () => { const result = shell(`validate_compose_readiness_contract(){ return 0; }; readiness_now(){ echo 100; }; collect_readiness_evidence(){ echo '{'; }; wait_for_readiness_policy dependency '${attempt}' '' '' 9 3`); expect(result.status).not.toBe(0); });
  it("dependency failure suppresses recreation and every later marker", () => { const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-suppress-")); const trace = path.join(dir, "trace"); const result = shell(`validate_dependencies_healthy(){ return 1; }; validate_dependencies_healthy && { echo recreate >>'${trace}'; echo health >>'${trace}'; echo promote >>'${trace}'; }`); expect(result.status).not.toBe(0); expect(() => readFileSync(trace)).toThrow(); });
  it("application failure suppresses health confirmation and promotion", () => { const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-app-suppress-")); const trace = path.join(dir, "trace"); const result = shell(`validate_running_application(){ return 1; }; validate_running_application '${sha}' && { echo health >>'${trace}'; echo promote >>'${trace}'; }`); expect(result.status).not.toBe(0); expect(() => readFileSync(trace)).toThrow(); });
  it("failed health-state persistence suppresses promotion", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-ready-state-")); const state = path.join(dir, "operation-state.json"); const promoted = path.join(dir, "promoted"); const generation = "20260810T120000Z-aaaaaaaaaaaa";
    const prefix = `. '${common}'; set_deployment_state_paths '${dir}'; acquire_deployment_lock; initialize_operation_state update '${generation}'; for pair in 'current-validated current-image-retained' 'current-image-retained candidate-metadata-prepared' 'candidate-metadata-prepared candidate-image-built' 'candidate-image-built deployment-reference-tagged' 'deployment-reference-tagged compatibility-confirmed' 'compatibility-confirmed migrations-confirmed' 'migrations-confirmed application-recreated'; do set -- $pair; advance_operation_state "$1" "$2"; done; atomic_write_metadata(){ return 1; }; ready(){ return 0; }; verify(){ return 0; }; run_confirmed_operation_step application-recreated health-confirmed ready verify && echo promoted >'${promoted}'`;
    const result = spawnSync("bash", ["-c", prefix], { encoding: "utf8" }); expect(result.status).not.toBe(0); expect(JSON.parse(readFileSync(state, "utf8")).stage).toBe("application-recreated"); expect(() => readFileSync(promoted)).toThrow();
  });
  it("update and rollback use the same dependency and application policy", () => { const result = shell(`declare -f validate_dependencies_healthy validate_running_application wait_for_readiness_policy >/dev/null`); expect(result.status).toBe(0); });
  it("recreation remains exactly api bot worker", () => { const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-services-")); const trace = path.join(dir, "trace"); const result = shell(`validate_compose_application_images(){ return 0; }; run_compose(){ printf '%s\n' "$@" >'${trace}'; }; recreate_application_services`); expect(result.status).toBe(0); const argv = readFileSync(trace, "utf8").trim().split("\n"); expect(argv.slice(-3)).toEqual(["api", "bot", "worker"]); expect(argv).not.toContain("postgres"); expect(argv).not.toContain("redis"); });
  // Regression: an earlier version of this probe spawned a fresh
  // `docker compose exec ... node -e` (loading bullmq's ESM dependency
  // graph) on every readiness poll. In real CI that cold start was
  // empirically SIGKILLed by the probe's own internal timeout on EVERY
  // single poll for the whole readiness budget - never printing so much as
  // its own start marker - which permanently starved worker readiness.
  // Query Redis directly with the redis image's own tiny static redis-cli
  // binary instead (no cold ESM resolution, no bespoke RedisConnection/
  // retryStrategy/EventEmitter-crash handling needed), bounded by an outer
  // timeout as a defensive backstop.
  it("worker heartbeat probe queries Redis directly through redis-cli, bounded by an outer timeout", () => {
    const source = readFileSync(common, "utf8");
    const block = source.slice(source.indexOf("check_fresh_worker_heartbeat() {"), source.indexOf("validate_running_application() {"));
    expect(block).toMatch(/run_compose exec -T redis timeout -s KILL \d+ redis-cli GET zedbot:worker:heartbeat/);
    expect(block).not.toContain("node --input-type=module");
    expect(block).not.toContain("RedisConnection");
  });
});
