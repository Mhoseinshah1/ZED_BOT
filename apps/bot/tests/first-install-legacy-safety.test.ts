import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const common = path.join(root, "scripts/lib/common.sh");
const bootstrapScript = path.join(root, "scripts/bootstrap-deployment.sh");
const generation = "20260813T120000Z-aaaaaaaaaaaa";
const sha = "a".repeat(40); const tree = "b".repeat(40); const operation = "11111111-1111-4111-8111-111111111111";
const fixture = () => mkdtempSync(path.join(os.tmpdir(), "zedbot-area10-"));
function metadata(role: "current" | "candidate" = "current") { const first = role === "candidate"; return { formatVersion: 2, ...(first ? { installationKind: "first-install" } : {}), lifecycleRole: role, generation, sourceTree: tree, preDeploySha: first ? null : sha, preDeployImageId: first ? null : `sha256:${"1".repeat(64)}`, targetDeploySha: sha, targetImageId: `sha256:${"2".repeat(64)}`, retainedImageTag: first ? null : `zedbot-app:rollback-${generation}`, immutableImageTag: `zedbot-app:generation-${generation}`, failedTargetTag: `zedbot-app:failed-${generation}`, capturedAt: "2026-08-13T12:00:00Z", preDeployMigrations: [], declarationFormatVersion: 2, declarationSourceCategory: "generation-evidence", migrationEvidencePath: `/state/evidence-${generation}`, composeEvidencePath: `/state/evidence-${generation}/docker-compose.yml`, composeEvidenceSha256: "c".repeat(64), composeProjectName: "zedbot", composeApplicationImage: "zedbot-app:latest", compatibilityManifestSha256: "d".repeat(64), compatibilityDeclarations: [], recreationAttempted: true, healthConfirmed: true, state: first ? "healthy-candidate" : "known-good" }; }
function write(file: string, value: unknown | string) { writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); chmodSync(file, 0o600); }
function shell(dir: string, body: string, lock = false) { return spawnSync("bash", ["-c", `. '${common}'; set_deployment_state_paths '${dir}'; validate_generation_owned_evidence(){ return 0; }; ${lock ? "acquire_deployment_lock;" : ""} ${body}`], { encoding: "utf8" }); }

describe("area 10 authoritative installation classification", () => {
  it("classifies only an explicitly requested empty state as genuine first install", () => { const dir = fixture(); expect(shell(dir, "classify_installation first-install").stdout.trim()).toBe("genuine-first-install"); expect(shell(dir, "classify_installation observe").status).not.toBe(0); });
  it("never classifies a canonical installation as first install", () => { const dir = fixture(); write(path.join(dir, "current.json"), metadata()); expect(shell(dir, "classify_installation first-install").stdout.trim()).toBe("existing-canonical"); });
  it("classifies the one allowlisted complete legacy-v1 record", () => { const dir = fixture(); write(path.join(dir, "legacy-install-v1.json"), metadata()); expect(shell(dir, "classify_installation observe").stdout.trim()).toBe("supported-legacy"); });
  it.each([0, 1, 3, 99])("rejects unsupported legacy format/version %s", (version) => { const dir = fixture(); write(path.join(dir, "legacy-install-v1.json"), { ...metadata(), formatVersion: version }); expect(shell(dir, "classify_installation observe").status).not.toBe(0); });
  it.each([["empty", ""], ["truncated", "{"], ["malformed", "not-json"]])("rejects %s canonical metadata", (_name, value) => { const dir = fixture(); write(path.join(dir, "current.json"), value); expect(shell(dir, "classify_installation observe").status).not.toBe(0); });
  it.each([["empty", ""], ["truncated", "{"], ["malformed", "not-json"]])("rejects %s legacy metadata", (_name, value) => { const dir = fixture(); write(path.join(dir, "legacy-install-v1.json"), value); expect(shell(dir, "classify_installation observe").status).not.toBe(0); });
  it("rejects a symlinked canonical record", () => { const dir = fixture(); const target = path.join(dir, "target"); write(target, metadata()); symlinkSync(target, path.join(dir, "current.json")); expect(shell(dir, "classify_installation observe").status).not.toBe(0); });
  it("rejects a symlinked legacy record", () => { const dir = fixture(); const target = path.join(dir, "target"); write(target, metadata()); symlinkSync(target, path.join(dir, "legacy-install-v1.json")); expect(shell(dir, "classify_installation observe").status).not.toBe(0); });
  it.each(["candidate-junk.json", "failed.json", ".metadata.stale", "unknown-v9.json"])("does not infer installation identity from partial artifact %s", (name) => { const dir = fixture(); write(path.join(dir, name), "{}"); expect(shell(dir, "classify_installation first-install").status).not.toBe(0); });
  it("rejects simultaneously plausible legacy signatures", () => { const dir = fixture(); write(path.join(dir, "legacy-install-v1.json"), metadata()); write(path.join(dir, "legacy-v2.json"), metadata()); expect(shell(dir, "classify_installation observe").status).not.toBe(0); });
  it("rejects inconsistent mixed canonical and legacy evidence", () => { const dir = fixture(); write(path.join(dir, "current.json"), metadata()); write(path.join(dir, "legacy-install-v1.json"), metadata()); expect(shell(dir, "classify_installation observe").status).not.toBe(0); });
  it("ignores environment, tag, container and timestamp claims", () => { const dir = fixture(); const result = shell(dir, "DOCKER_IMAGE=zedbot-app:latest; CONTAINER_ID=fake; INSTALL_DATE=now; classify_installation observe"); expect(result.status).not.toBe(0); });
  it("rejects traversal and symlinked parent state paths", () => { const dir = fixture(); expect(shell(`${dir}/../state`, "classify_installation first-install").status).not.toBe(0); const target = fixture(); const link = path.join(dir, "link"); symlinkSync(target, link); expect(shell(link, "classify_installation first-install").status).not.toBe(0); });
});

describe("area 10 locked atomic bootstrap and conversion", () => {
  it("validated legacy self-heal publishes current only and the next update sees existing-canonical", () => {
    const dir = fixture(); const snapshot = fixture();
    const migrations = path.join(snapshot, "packages/database/prisma/migrations/20260101000000_initial");
    mkdirSync(migrations, { recursive: true }); writeFileSync(path.join(migrations, "migration.sql"), "SELECT 1;");
    const compose = path.join(snapshot, "docker-compose.yml"); writeFileSync(compose, "services: {}\n");
    const body = `require_source_integrity(){ :; }; set_update_compose_contract(){ :; }; validate_compose_application_images(){ :; }; validate_migration_declaration_pair(){ MIGRATION_MANIFEST_SHA256='${"d".repeat(64)}'; MIGRATION_DECLARATIONS_JSON='[]'; }; run_clean_docker(){ case "$*" in *'image inspect'*) echo 'sha256:${"2".repeat(64)}';; esac; }; verify_application_recreation_set(){ :; }; validate_dependencies_healthy(){ :; }; run_compose(){ echo '{"ok":true,"upToDate":true,"failedCount":0}'; }; persist_migration_declaration_evidence(){ mkdir "$2"; cp '${compose}' "$2/docker-compose.yml"; MIGRATION_MANIFEST_SHA256='${"d".repeat(64)}'; MIGRATION_DECLARATIONS_JSON='[]'; }; record_bot_recreation_boundary(){ printf '{}\n' >"$ZEDBOT_BOT_RECREATION_BOUNDARY"; chmod 600 "$ZEDBOT_BOT_RECREATION_BOUNDARY"; }; validate_running_application(){ :; }; publish_validated_legacy_self_heal '${sha}' '${tree}' '${snapshot}'; printf '%s\n' "$(classify_installation observe)"`;
    const result = shell(dir, body, true); expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("existing-canonical");
    expect(existsSync(path.join(dir, "current.json"))).toBe(true);
    expect(existsSync(path.join(dir, "previous.json"))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(dir, "bootstrap.json"), "utf8"))).toMatchObject({ kind: "legacy-upgrade", phase: "promoted" });
  });

  it("does not publish legacy canonical evidence before readiness succeeds", () => {
    const text = readFileSync(common, "utf8");
    const start = text.indexOf("publish_validated_legacy_self_heal() {");
    const end = text.indexOf("\n}\n\nvalid_git_sha()", start);
    const body = text.slice(start, end);
    const readiness = body.indexOf('validate_running_application "$sha"');
    expect(readiness).toBeGreaterThan(0);
    expect(body.indexOf('atomic_write_metadata "$tmp" "$ZEDBOT_LEGACY_INSTALLATION"')).toBeGreaterThan(readiness);
    expect(body.indexOf("convert_supported_legacy_installation")).toBeGreaterThan(readiness);
  });

  it("executes the complete first-install orchestrator through mandatory mocked gates", () => { const dir = fixture(); const snapshot = fixture(); const trace = path.join(dir, "trace"); const body = `. '${bootstrapScript}'; set_deployment_state_paths '${dir}'; require_root(){ :; }; reset_deployment_state_fixed_identity(){ set_deployment_state_paths '${dir}'; }; app_cd(){ :; }; load_env_if_exists(){ :; }; reset_compose_fixed_identity(){ :; }; detect_compose_command(){ :; }; acquire_deployment_lock(){ ZEDBOT_DEPLOYMENT_LOCK_HELD=1; }; classify_installation(){ echo genuine-first-install; }; prepare_exact_origin_main(){ echo '${sha} ${tree} ${snapshot}'; }; verify_source_snapshot(){ :; }; register_source_snapshot(){ :; }; set_update_compose_contract(){ :; }; validate_compose_application_images(){ echo compose >> '${trace}'; }; validate_migration_declaration_pair(){ MIGRATION_MANIFEST_SHA256='${"d".repeat(64)}'; MIGRATION_DECLARATIONS_JSON='[]'; echo declarations >> '${trace}'; }; begin_installation_bootstrap(){ echo bootstrap >> '${trace}'; }; initialize_operation_state(){ echo state-init >> '${trace}'; }; validate_dependencies_healthy(){ echo dependencies >> '${trace}'; }; advance_operation_state(){ echo "state:$1:$2" >> '${trace}'; }; require_source_integrity(){ echo source >> '${trace}'; }; build_verified_source_snapshot(){ echo build >> '${trace}'; }; run_clean_docker(){ echo 'sha256:${"2".repeat(64)}'; }; persist_migration_declaration_evidence(){ mkdir -p "$2"; cp '${path.join(root, "docker-compose.yml")}' "$2/docker-compose.yml"; }; operation_mktemp(){ mktemp "$1"; }; atomic_write_metadata(){ cp "$1" "$2"; chmod 600 "$2"; }; validate_generation_metadata_core(){ :; }; validate_generation_owned_evidence(){ :; }; advance_installation_bootstrap(){ echo "bootstrap:$1:$2" >> '${trace}'; }; run_compose(){ echo "compose-cmd:$*" >> '${trace}'; }; recreate_application_services(){ echo recreate >> '${trace}'; }; verify_application_recreation_set(){ echo recreate-verified >> '${trace}'; }; record_bot_recreation_boundary(){ echo bot-boundary >> '${trace}'; }; rewrite_generation_state(){ echo "candidate:$2" >> '${trace}'; }; validate_running_application(){ echo generic-and-bot-ready >> '${trace}'; }; publish_first_install_current(){ echo publish-current >> '${trace}'; }; record_deployed_sha(){ echo record-sha >> '${trace}'; }; log_success(){ :; }; main; cat '${trace}'`;
    const result = spawnSync("bash", ["-c", body], { encoding: "utf8" }); expect(result.status, result.stderr).toBe(0); const traceText = result.stdout; for (const gate of ["compose", "declarations", "bootstrap", "dependencies", "build", "compose-cmd:run --rm --no-deps api", "compose-cmd:run --rm --no-deps api node packages/database/dist/seed.js", "recreate", "recreate-verified", "bot-boundary", "generic-and-bot-ready", "publish-current"]) expect(traceText).toContain(gate); expect(traceText.indexOf("recreate")).toBeLessThan(traceText.indexOf("generic-and-bot-ready")); expect(traceText.indexOf("generic-and-bot-ready")).toBeLessThan(traceText.indexOf("publish-current"));
    // Regression: the first-install path used to apply migrations but never
    // seed baseline data (OWNER admins from ADMIN_TELEGRAM_IDS, default
    // settings), unlike the legacy installer path it replaced (migrate.sh).
    // Seed must run after migrations are applied and before the deployment
    // is recreated with the new candidate.
    expect(traceText.indexOf("packages/database/dist/seed.js")).toBeLessThan(traceText.indexOf("recreate"));
  });
  it("seeds baseline data after migrations and before recreation, matching the legacy installer's seed step", () => {
    const text = readFileSync(bootstrapScript, "utf8");
    expect(text).toContain("packages/database/dist/seed.js");
    const migrateIndex = text.indexOf("prisma migrate deploy");
    const seedIndex = text.indexOf("packages/database/dist/seed.js");
    const confirmedIndex = text.indexOf("advance_operation_state candidate-image-built migrations-confirmed");
    const recreateIndex = text.indexOf("recreate_application_services");
    expect(migrateIndex).toBeGreaterThan(-1); expect(seedIndex).toBeGreaterThan(-1); expect(confirmedIndex).toBeGreaterThan(-1); expect(recreateIndex).toBeGreaterThan(-1);
    expect(migrateIndex).toBeLessThan(seedIndex);
    expect(seedIndex).toBeLessThan(confirmedIndex);
    expect(confirmedIndex).toBeLessThan(recreateIndex);
  });
  it("runs a genuine first-install metadata lifecycle without fabricating previous", () => { const dir = fixture(); const candidate = path.join(dir, `candidate-${generation}.json`); write(candidate, metadata("candidate")); const result = shell(dir, `rm -f '${candidate}'; begin_installation_bootstrap first-install '${generation}' '${sha}' '${tree}' '${operation}'; cp /dev/null /tmp/zedbot-area10-noop 2>/dev/null || true; advance_installation_bootstrap initialized canonical-published; advance_installation_bootstrap canonical-published health-confirmed; cat > '${candidate}' <<'JSON'
${JSON.stringify(metadata("candidate"))}
JSON
chmod 600 '${candidate}'; publish_first_install_current '${candidate}'; classify_installation observe`, true); expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe("existing-canonical"); expect(existsSync(path.join(dir, "current.json"))).toBe(true); expect(existsSync(path.join(dir, "previous.json"))).toBe(false); expect(JSON.parse(readFileSync(path.join(dir, "bootstrap.json"), "utf8")).phase).toBe("promoted");
    // Regression: the candidate's content is fully absorbed into current.json
    // above; leaving candidate-<generation>.json behind permanently blocks
    // rollback-status (it treats the file's mere presence as an incomplete
    // operation, regardless of content).
    expect(existsSync(candidate)).toBe(false); });
  // Regression: bootstrap.json is a permanent provenance record written once
  // at promotion and never updated again, while current.json's generation
  // advances on every later update. classify_installation used to require
  // them to stay equal forever, which rejected an otherwise healthy
  // installation as soon as a second generation was promoted. Provenance is
  // now proven once, at promotion time (publish_first_install_current), not
  // perpetually here.
  it("stays existing-canonical through a second update after first-install, past the bootstrap generation check", () => {
    const dir = fixture(); const candidate1 = path.join(dir, `candidate-${generation}.json`);
    const first = shell(dir, `begin_installation_bootstrap first-install '${generation}' '${sha}' '${tree}' '${operation}'; advance_installation_bootstrap initialized canonical-published; advance_installation_bootstrap canonical-published health-confirmed; cat > '${candidate1}' <<'JSON'
${JSON.stringify(metadata("candidate"))}
JSON
chmod 600 '${candidate1}'; publish_first_install_current '${candidate1}'`, true);
    expect(first.status, first.stderr).toBe(0);
    // The second candidate is only written now, mirroring a real second
    // update: candidate1.json is already gone and current.json already
    // published by the time this file exists.
    const genB = "20260814T120000Z-cccccccccccc";
    const candidate2 = path.join(dir, `candidate-${genB}.json`);
    write(candidate2, {
      formatVersion: 2, lifecycleRole: "candidate", generation: genB, sourceTree: tree,
      preDeploySha: sha, preDeployImageId: `sha256:${"1".repeat(64)}`, targetDeploySha: sha, targetImageId: `sha256:${"2".repeat(64)}`,
      retainedImageTag: `zedbot-app:rollback-${genB}`, immutableImageTag: `zedbot-app:generation-${genB}`, failedTargetTag: `zedbot-app:failed-${genB}`,
      capturedAt: "2026-08-14T12:00:00Z", preDeployMigrations: [], declarationFormatVersion: 2, declarationSourceCategory: "generation-evidence",
      migrationEvidencePath: `/state/evidence-${genB}`, composeEvidencePath: `/state/evidence-${genB}/docker-compose.yml`,
      composeEvidenceSha256: "c".repeat(64), composeProjectName: "zedbot", composeApplicationImage: "zedbot-app:latest",
      compatibilityManifestSha256: "d".repeat(64), compatibilityDeclarations: [], recreationAttempted: true, healthConfirmed: true, state: "healthy-candidate",
    });
    const result = shell(dir, `promote_healthy_candidate '${candidate2}'; classify_installation observe`, true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("existing-canonical");
  });
  it("converts supported legacy evidence atomically and preserves it", () => { const dir = fixture(); const legacy = path.join(dir, "legacy-install-v1.json"); write(legacy, metadata()); const before = readFileSync(legacy, "utf8"); const result = shell(dir, `begin_installation_bootstrap legacy-upgrade '${generation}' '${sha}' '${tree}' '${operation}'; convert_supported_legacy_installation; classify_installation observe`, true); expect(result.status, result.stderr).toBe(0); expect(result.stdout.trim()).toBe("existing-canonical"); expect(readFileSync(legacy, "utf8")).toBe(before); expect(existsSync(path.join(dir, "previous.json"))).toBe(false); });
  // Regression: legacy-install-v1.json is likewise a permanent record whose
  // generation is never updated - the same generation-drift bug independently
  // affects converted legacy installations even once first-install's own
  // previous.json can validate again.
  it("stays existing-canonical through an update after legacy conversion, past the legacy generation check", () => {
    const dir = fixture(); const legacy = path.join(dir, "legacy-install-v1.json"); write(legacy, metadata());
    const first = shell(dir, `begin_installation_bootstrap legacy-upgrade '${generation}' '${sha}' '${tree}' '${operation}'; convert_supported_legacy_installation`, true);
    expect(first.status, first.stderr).toBe(0);
    // The update candidate is only written now, mirroring a real update
    // that happens after conversion has already published current.json.
    const genB = "20260814T120000Z-dddddddddddd";
    const candidate = path.join(dir, `candidate-${genB}.json`);
    write(candidate, {
      formatVersion: 2, lifecycleRole: "candidate", generation: genB, sourceTree: tree,
      preDeploySha: sha, preDeployImageId: `sha256:${"2".repeat(64)}`, targetDeploySha: sha, targetImageId: `sha256:${"3".repeat(64)}`,
      retainedImageTag: `zedbot-app:rollback-${genB}`, immutableImageTag: `zedbot-app:generation-${genB}`, failedTargetTag: `zedbot-app:failed-${genB}`,
      capturedAt: "2026-08-14T12:00:00Z", preDeployMigrations: [], declarationFormatVersion: 2, declarationSourceCategory: "generation-evidence",
      migrationEvidencePath: `/state/evidence-${genB}`, composeEvidencePath: `/state/evidence-${genB}/docker-compose.yml`,
      composeEvidenceSha256: "c".repeat(64), composeProjectName: "zedbot", composeApplicationImage: "zedbot-app:latest",
      compatibilityManifestSha256: "d".repeat(64), compatibilityDeclarations: [], recreationAttempted: true, healthConfirmed: true, state: "healthy-candidate",
    });
    const result = shell(dir, `promote_healthy_candidate '${candidate}'; classify_installation observe`, true);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("existing-canonical");
  });
  it("requires the operation lock before bootstrap, conversion, or publication", () => { const dir = fixture(); write(path.join(dir, "legacy-install-v1.json"), metadata()); expect(shell(dir, `begin_installation_bootstrap legacy-upgrade '${generation}' '${sha}' '${tree}' '${operation}'`).status).not.toBe(0); expect(shell(dir, "convert_supported_legacy_installation").status).not.toBe(0); expect(existsSync(path.join(dir, "current.json"))).toBe(false); });
  it("repeated conversion is rejected as canonical instead of generating another identity", () => { const dir = fixture(); write(path.join(dir, "legacy-install-v1.json"), metadata()); const first = shell(dir, `begin_installation_bootstrap legacy-upgrade '${generation}' '${sha}' '${tree}' '${operation}'; convert_supported_legacy_installation`, true); expect(first.status, first.stderr).toBe(0); expect(shell(dir, "convert_supported_legacy_installation", true).status).not.toBe(0); });
  it("failed atomic publication suppresses later work", () => { const dir = fixture(); const later = path.join(dir, "later"); const result = shell(dir, `atomic_write_metadata(){ return 1; }; begin_installation_bootstrap first-install '${generation}' '${sha}' '${tree}' '${operation}' && echo unsafe > '${later}'`, true); expect(result.status).not.toBe(0); expect(existsSync(later)).toBe(false); });
  it("rejects publishing a candidate whose generation does not match the promoted bootstrap identity", () => {
    const dir = fixture();
    const bootstrap = shell(dir, `begin_installation_bootstrap first-install '${generation}' '${sha}' '${tree}' '${operation}'; advance_installation_bootstrap initialized canonical-published; advance_installation_bootstrap canonical-published health-confirmed`, true);
    expect(bootstrap.status, bootstrap.stderr).toBe(0);
    const mismatched = path.join(dir, "candidate-mismatched.json");
    write(mismatched, { ...metadata("candidate"), generation: "20260814T120000Z-eeeeeeeeeeee" });
    const result = shell(dir, `publish_first_install_current '${mismatched}'`, true);
    expect(result.status).not.toBe(0);
    expect(existsSync(path.join(dir, "current.json"))).toBe(false);
  });
  it("rejects converting legacy evidence whose generation does not match the bootstrap identity", () => {
    const dir = fixture(); const legacy = path.join(dir, "legacy-install-v1.json");
    write(legacy, metadata());
    const result = shell(dir, `begin_installation_bootstrap legacy-upgrade '20260814T120000Z-ffffffffffff' '${sha}' '${tree}' '${operation}'; convert_supported_legacy_installation`, true);
    expect(result.status).not.toBe(0);
    expect(existsSync(path.join(dir, "current.json"))).toBe(false);
  });
  it("changed legacy evidence before conversion fails closed", () => { const dir = fixture(); const legacy = path.join(dir, "legacy-install-v1.json"); write(legacy, metadata()); const result = shell(dir, `begin_installation_bootstrap legacy-upgrade '${generation}' '${sha}' '${tree}' '${operation}'; echo broken > '${legacy}'; convert_supported_legacy_installation`, true); expect(result.status).not.toBe(0); expect(existsSync(path.join(dir, "current.json"))).toBe(false); });
  it("an interrupted bootstrap cannot advance or publish", () => { const dir = fixture(); const result = shell(dir, `begin_installation_bootstrap first-install '${generation}' '${sha}' '${tree}' '${operation}'; ZEDBOT_OPERATION_INTERRUPTED=1; advance_installation_bootstrap initialized canonical-published`, true); expect(result.status).not.toBe(0); expect(JSON.parse(readFileSync(path.join(dir, "bootstrap.json"), "utf8")).phase).toBe("initialized"); });
  it("stale temporary metadata is preserved and never reused", () => { const dir = fixture(); const stale = path.join(dir, ".bootstrap.AAAAAAAA"); write(stale, "forensic"); expect(shell(dir, `begin_installation_bootstrap first-install '${generation}' '${sha}' '${tree}' '${operation}'`, true).status).not.toBe(0); expect(readFileSync(stale, "utf8")).toBe("forensic"); });
  it("a failed canonical reread suppresses later work", () => { const dir = fixture(); const later = path.join(dir, "later"); const result = shell(dir, `validate_installation_bootstrap(){ return 1; }; begin_installation_bootstrap first-install '${generation}' '${sha}' '${tree}' '${operation}' && echo unsafe > '${later}'`, true); expect(result.status).not.toBe(0); expect(existsSync(later)).toBe(false); });
});

describe("area 10 failure boundaries and preserved policies", () => {
  it.each(["classification", "canonical-path", "source", "compose", "migration-declarations", "candidate-construction", "candidate-validation", "publication", "dependency-readiness", "build", "migration", "recreation", "generic-readiness", "real-bot-readiness", "health", "promotion-preparation", "reference-write", "promotion", "cleanup", "lock-release"])("suppresses later mutation after %s failure", (boundary) => { const dir = fixture(); const later = path.join(dir, "later"); const result = shell(dir, `fail(){ return 1; }; fail '${boundary}' && echo unsafe > '${later}'`); expect(result.status).not.toBe(0); expect(existsSync(later)).toBe(false); });
  it.each(["SIGINT", "SIGTERM", "SIGHUP"])("%s interruption refuses bootstrap advancement", (signal) => { const dir = fixture(); const status = signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129; const result = shell(dir, `ZEDBOT_OPERATION_INTERRUPTED=1; ZEDBOT_OPERATION_SIGNAL_STATUS=${status}; operation_assert_active`); expect(result.status).not.toBe(0); });
  it.each(["dependency", "generic-application", "real-bot"])("retry reruns %s readiness rather than trusting stale evidence", (gate) => { const dir = fixture(); const trace = path.join(dir, "trace"); const result = shell(dir, `retry_gate(){ echo '${gate}' >> '${trace}'; return 1; }; retry_gate`); expect(result.status).not.toBe(0); expect(readFileSync(trace, "utf8").trim()).toBe(gate); });
  it("foreign lock prevents bootstrap and remains present", () => { const dir = fixture(); const lock = path.join(dir, "deployment.lock"); const result = shell(dir, `acquire_deployment_lock; bash -c ". '${common}'; set_deployment_state_paths '${dir}'; begin_installation_bootstrap first-install '${generation}' '${sha}' '${tree}' '${operation}'"`); expect(result.status).not.toBe(0); expect(existsSync(lock)).toBe(true); });
  it("first-install contenders serialize through the same lock", () => { const dir = fixture(); const result = shell(dir, `acquire_deployment_lock; if bash -c "exec 9>&-; . '${common}'; set_deployment_state_paths '${dir}'; acquire_deployment_lock"; then exit 99; else exit 7; fi`); expect(result.status).toBe(7); });
  it("legacy-upgrade contenders serialize through the same lock", () => { const dir = fixture(); write(path.join(dir, "legacy-install-v1.json"), metadata()); const result = shell(dir, `acquire_deployment_lock; if bash -c "exec 9>&-; . '${common}'; set_deployment_state_paths '${dir}'; acquire_deployment_lock"; then exit 99; else exit 7; fi`); expect(result.status).toBe(7); });
  it("first-install and legacy conversion cannot race", () => { const dir = fixture(); write(path.join(dir, "legacy-install-v1.json"), metadata()); expect(shell(dir, "classify_installation first-install").stdout.trim()).toBe("supported-legacy"); });
  it("cleanup never targets canonical or legacy evidence", () => { const text = readFileSync(common, "utf8"); expect(text).not.toMatch(/operation_register_artifact.*(?:current\.json|legacy-install-v1\.json)/); });
  it("keeps the exact application-only recreation set", () => { const text = readFileSync(common, "utf8"); expect(text).toContain("--force-recreate api bot worker"); expect(text.match(/--force-recreate api bot worker/)?.[0]).not.toMatch(/postgres|redis/); });
  it("the installer starts dependencies separately and delegates application bootstrap", () => { const text = readFileSync(path.join(root, "scripts/install.sh"), "utf8"); expect(text).toContain("up -d --no-deps --no-build postgres redis"); expect(text).toContain('bash "${APP_DIR}/scripts/bootstrap-deployment.sh"'); expect(text).not.toContain("up -d --build --remove-orphans"); });
  // Regression: the installer explicitly allows leaving TELEGRAM_BOT_TOKEN
  // empty ("can be added later" - install.sh's own prompt says so), but
  // apps/bot/src/index.ts never calls run() without a token and so never
  // publishes the real-bot readiness marker. Bootstrap must gate on generic
  // application readiness only (not the bot-specific marker, and not the
  // bot service's own crash-looping container at all) when no token is
  // configured, completing the install with the bot pending configuration.
  it("gates first-install readiness on the bot-specific marker only when a token is configured", () => {
    const text = readFileSync(bootstrapScript, "utf8");
    expect(text).toContain('if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then');
    expect(text).toContain('validate_running_application "$target" 0 >/dev/null || return 1');
    expect(text.indexOf("recreate_application_services")).toBeLessThan(text.indexOf('if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then'));
  });
  // Regression: validate_first_install_intent used to run only after
  // clone_or_update_repo (git fetch + `pull --ff-only`, a real mutation of
  // an existing checkout), create_env_file, and install_cli had already
  // executed. A rerun against an already-canonical install was rejected
  // only then - leaving a fast-forwarded checkout, a possibly-replaced
  // .env, and a refreshed CLI sitting beside the still-running OLD
  // containers, none of it deployed or resynchronized. Guard before any of
  // that mutation using the EXISTING (not-yet-overwritten) checkout's own
  // common.sh - classify_installation only reads the canonical
  // deployment-state directory, independent of $APP_DIR's content, so this
  // is safe even before clone_or_update_repo runs.
  it("guards installer rerun intent before the checkout, .env, or CLI can be mutated", () => {
    const text = readFileSync(path.join(root, "scripts/install.sh"), "utf8");
    expect(text).toContain("guard_first_install_intent_before_mutation()");
    expect(text).toContain('[ -f "${APP_DIR}/scripts/lib/common.sh" ] || return 0');
    const main = text.slice(text.indexOf("\nmain() {"));
    expect(main.indexOf("guard_first_install_intent_before_mutation")).toBeGreaterThan(-1);
    expect(main.indexOf("guard_first_install_intent_before_mutation")).toBeLessThan(main.indexOf("clone_or_update_repo"));
    expect(main.indexOf("guard_first_install_intent_before_mutation")).toBeLessThan(main.indexOf("create_env_file"));
    expect(main.indexOf("guard_first_install_intent_before_mutation")).toBeLessThan(main.indexOf("install_cli"));
  });
  it("the pre-mutation guard is a no-op with no existing checkout, and delegates otherwise", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-install-guard-"));
    const text = readFileSync(path.join(root, "scripts/install.sh"), "utf8");
    const body = text.slice(text.indexOf("validate_first_install_intent() {"), text.indexOf("\nmain() {"));
    const fresh = spawnSync("bash", ["-c", `APP_DIR='${dir}/app'; ${body}\nguard_first_install_intent_before_mutation`], { encoding: "utf8" });
    expect(fresh.status, fresh.stderr).toBe(0);
    mkdirSync(path.join(dir, "app/scripts/lib"), { recursive: true });
    writeFileSync(path.join(dir, "app/scripts/lib/common.sh"), "");
    const delegates = spawnSync("bash", ["-c", `APP_DIR='${dir}/app'; ${body}\nvalidate_first_install_intent(){ echo called > '${dir}/called'; return 1; }\nguard_first_install_intent_before_mutation`], { encoding: "utf8" });
    expect(delegates.status).not.toBe(0);
    expect(existsSync(path.join(dir, "called"))).toBe(true);
  });
  // Regression: PostgreSQL only reads POSTGRES_PASSWORD on first
  // initialization of its data directory. A rerun that reuses an existing
  // data directory (an install interrupted before any deployment-state
  // metadata was written, so it still classifies as genuine-first-install)
  // but replaces .env with a freshly generated password used to connect
  // with a password Postgres never adopted, failing bootstrap after
  // partial deployment evidence was already written. sync_postgres_password
  // re-aligns Postgres's actual password to match .env; it existed but was
  // never called from main().
  it("re-aligns the PostgreSQL password after dependencies start and before canonical bootstrap", () => {
    const text = readFileSync(path.join(root, "scripts/install.sh"), "utf8");
    expect(text).toContain("sync_postgres_password() {");
    const main = text.slice(text.indexOf("\nmain() {"));
    const sync = main.indexOf("sync_postgres_password");
    expect(sync).toBeGreaterThan(-1);
    expect(sync).toBeGreaterThan(main.indexOf("start_dependencies"));
    expect(sync).toBeLessThan(main.indexOf('bash "${APP_DIR}/scripts/bootstrap-deployment.sh"'));
  });
  it("synchronizes the PostgreSQL password via ALTER USER over stdin, never on the command line", () => {
    const text = readFileSync(path.join(root, "scripts/install.sh"), "utf8");
    const body = text.slice(text.indexOf("sync_postgres_password() {"), text.indexOf("\nrun_migrations_if_available() {"));
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-postgres-sync-"));
    const envFile = path.join(dir, ".env");
    writeFileSync(envFile, "POSTGRES_USER='zedbot'\nPOSTGRES_PASSWORD='new-secret'\n");
    const bin = path.join(dir, "bin"); mkdirSync(bin);
    const trace = path.join(dir, "trace");
    writeFileSync(path.join(bin, "docker"), `#!/usr/bin/env bash
case "$*" in
  *pg_isready*) exit 0 ;;
  *psql*) printf '%s\\n' "$*" > '${trace}'; cat >> '${trace}' ;;
esac
`, { mode: 0o755 });
    const script = `ENV_FILE='${envFile}'; APP_DIR='${dir}'; COMPOSE_CMD=(docker); log_info(){ :; }; log_warn(){ :; }; ${body}\nsync_postgres_password`;
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    expect(result.status, result.stderr).toBe(0);
    const traced = readFileSync(trace, "utf8");
    expect(traced).toContain('ALTER USER "zedbot" WITH PASSWORD \'new-secret\';');
    expect(result.stdout).not.toContain("new-secret");
    expect(result.stderr).not.toContain("new-secret");
  });
  it("is a safe no-op when no password is configured", () => {
    const text = readFileSync(path.join(root, "scripts/install.sh"), "utf8");
    const body = text.slice(text.indexOf("sync_postgres_password() {"), text.indexOf("\nrun_migrations_if_available() {"));
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-postgres-sync-empty-"));
    const envFile = path.join(dir, ".env"); writeFileSync(envFile, "POSTGRES_USER='zedbot'\n");
    const script = `ENV_FILE='${envFile}'; APP_DIR='${dir}'; COMPOSE_CMD=(false); log_info(){ :; }; log_warn(){ :; }; ${body}\nsync_postgres_password`;
    const result = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
  it("update and rollback invoke the authoritative classifier after locking", () => { for (const file of ["scripts/update.sh", "scripts/rollback.sh"]) { const text = readFileSync(path.join(root, file), "utf8"); expect(text).toContain("classify_installation observe"); expect(text.indexOf("acquire_deployment_lock")).toBeLessThan(text.indexOf("classify_installation observe")); } });
  it("retry rejects changed bootstrap-bound source identity", () => { const dir = fixture(); const result = shell(dir, `begin_installation_bootstrap first-install '${generation}' '${sha}' '${tree}' '${operation}'; test "$(jq -r .sourceSha "$ZEDBOT_INSTALLATION_BOOTSTRAP")" = '${"f".repeat(40)}'`, true); expect(result.status).not.toBe(0); });
  it("temporary files, image tags and containers cannot create rollback eligibility", () => { const dir = fixture(); write(path.join(dir, ".image-tag"), "zedbot-app:latest"); expect(shell(dir, "classify_installation first-install").status).not.toBe(0); expect(existsSync(path.join(dir, "previous.json"))).toBe(false); });
  it("preserves legacy forensic evidence during failed conversion cleanup", () => { const dir = fixture(); const legacy = path.join(dir, "legacy-install-v1.json"); write(legacy, metadata()); const before = readFileSync(legacy, "utf8"); shell(dir, `begin_installation_bootstrap legacy-upgrade '${generation}' '${sha}' '${tree}' '${operation}'; ZEDBOT_OPERATION_INTERRUPTED=1; convert_supported_legacy_installation`, true); expect(readFileSync(legacy, "utf8")).toBe(before); });
});
