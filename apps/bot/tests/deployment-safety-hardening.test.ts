import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  evaluateRollbackCompatibility,
  evaluateUpdateCompatibility,
  parseRollbackCompatibilityManifest,
  type MigrationSnapshot,
} from "../../../packages/database/src/deployment-rollback.js";
import {
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ALLOWLIST,
  REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_CRLF,
  REFERRAL_AFFILIATE_MIGRATION_NAME,
} from "../../../packages/database/src/migration-checksum.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scripts = path.join(root, "scripts");
const migration = (n: number) => `20260808${String(n).padStart(6, "0")}_migration_${n}`;
// Every applied migration defaults to the SAME placeholder checksum manifest() declares
// below, so tests that are not about checksums at all stay unaffected by the checksum
// comparison; tests that ARE about checksums pass an explicit override.
const PLACEHOLDER_CHECKSUM = "a".repeat(64);
const healthy = (shipped: string[], applied: string[], pending: string[] = [], appliedChecksums?: Record<string, string>): MigrationSnapshot => ({
  shipped, applied, pending, failed: [], databaseOnly: [], incomplete: [],
  appliedChecksums: appliedChecksums ?? Object.fromEntries(applied.map((name) => [name, PLACEHOLDER_CHECKSUM])),
});
const manifest = (names: string[]) => ({ formatVersion: 2 as const, backwardCompatibleMigrations: names.map((name) => ({ name, sqlSha256: PLACEHOLDER_CHECKSUM })) });

describe("typed rollback migration compatibility", () => {
  it("permits a deployment with no new migration", () => {
    const base = [migration(1)];
    expect(evaluateUpdateCompatibility(base, healthy(base, base), manifest(base))).toMatchObject({ ok: true, newlyPending: [] });
  });

  it("permits only explicitly compatible new migrations", () => {
    const base = [migration(1)]; const added = migration(2);
    expect(evaluateUpdateCompatibility(base, healthy([...base, added], base, [added]), manifest([...base, added])).ok).toBe(true);
    expect(evaluateUpdateCompatibility(base, healthy([...base, added], base, [added]), manifest(base)).ok).toBe(false);
  });

  it("blocks failed, incomplete and database-only state", () => {
    const base = [migration(1)];
    for (const key of ["failed", "incomplete", "databaseOnly"] as const) {
      const snapshot = healthy(base, base); snapshot[key] = [migration(2)];
      expect(evaluateUpdateCompatibility(base, snapshot, manifest(base)).ok).toBe(false);
    }
  });

  it("rechecks applied post-baseline migrations for rollback", () => {
    const base = [migration(1)]; const added = migration(2);
    expect(evaluateRollbackCompatibility(base, healthy([...base, added], [...base, added]), manifest([...base, added])).ok).toBe(true);
    expect(evaluateRollbackCompatibility(base, healthy([...base, added], [...base, added]), manifest(base)).ok).toBe(false);
  });

  it("rejects malformed manifests", () => {
    expect(parseRollbackCompatibilityManifest({ formatVersion: 2, backwardCompatibleMigrations: [{ name: "bad", sqlSha256: "a".repeat(64) }] })).toBeNull();
    expect(parseRollbackCompatibilityManifest({ formatVersion: 1, backwardCompatibleMigrations: [] })).toBeNull();
  });

  it("blocks an applied migration whose recorded checksum does not match its declaration", () => {
    // A name match alone (shipped + applied) previously satisfied compatibility even if
    // the bytes actually applied to the database were not the declared, verified ones -
    // e.g. a tampered or corrupted migration file applied under a trusted name.
    const base = [migration(1)];
    const mismatched = healthy(base, base, [], { [base[0]]: "b".repeat(64) });
    expect(evaluateUpdateCompatibility(base, mismatched, manifest(base))).toMatchObject({ ok: false, blocker: `checksum-mismatch:${base[0]}` });
  });

  it("blocks an applied migration with no recorded checksum", () => {
    const base = [migration(1)];
    const missing = healthy(base, base, [], {});
    expect(evaluateUpdateCompatibility(base, missing, manifest(base))).toMatchObject({ ok: false, blocker: `checksum-missing:${base[0]}` });
  });

  it("does not require a checksum for a declared migration that has not been applied yet", () => {
    const base = [migration(1)]; const added = migration(2);
    const snapshot = healthy([...base, added], base, [added]);
    expect(evaluateUpdateCompatibility(base, snapshot, manifest([...base, added])).ok).toBe(true);
  });

  it("accepts any empirically verified historical byte-variant checksum for the referral affiliate migration", () => {
    // This migration shipped in two logical SQL forms across two byte encodings, so a
    // database that applied any of the four verified historical variants (not just the
    // one the manifest currently declares, which matches today's on-disk file) is still
    // genuinely compatible - see migration-checksum.ts.
    const name = REFERRAL_AFFILIATE_MIGRATION_NAME;
    const referralManifest = { formatVersion: 2 as const, backwardCompatibleMigrations: [{ name, sqlSha256: REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ALLOWLIST.ORIGINAL_LF }] };
    const snapshot = healthy([name], [name], [], { [name]: REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ORIGINAL_CRLF });
    expect(evaluateUpdateCompatibility([name], snapshot, referralManifest).ok).toBe(true);
  });

  it("still rejects a checksum for the referral affiliate migration outside the empirically verified allowlist", () => {
    const name = REFERRAL_AFFILIATE_MIGRATION_NAME;
    const referralManifest = { formatVersion: 2 as const, backwardCompatibleMigrations: [{ name, sqlSha256: REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ALLOWLIST.ORIGINAL_LF }] };
    const snapshot = healthy([name], [name], [], { [name]: "c".repeat(64) });
    expect(evaluateUpdateCompatibility([name], snapshot, referralManifest)).toMatchObject({ ok: false, blocker: `checksum-mismatch:${name}` });
  });

  // Regression: the historical-allowlist path only checked the APPLIED
  // checksum against the four verified variants - it never checked that
  // the MANIFEST's own declared checksum was one of them too. An edited or
  // corrupted manifest declaring an unverified checksum for this name
  // would still be accepted as long as the database happened to have
  // applied any of the four allowlisted variants, regardless of what the
  // manifest itself actually claims.
  it("rejects the referral affiliate migration when the manifest's own declared checksum is not itself a verified historical variant", () => {
    const name = REFERRAL_AFFILIATE_MIGRATION_NAME;
    const referralManifest = { formatVersion: 2 as const, backwardCompatibleMigrations: [{ name, sqlSha256: "9".repeat(64) }] };
    const snapshot = healthy([name], [name], [], { [name]: REFERRAL_AFFILIATE_MIGRATION_CHECKSUM_ALLOWLIST.ORIGINAL_LF });
    expect(evaluateUpdateCompatibility([name], snapshot, referralManifest)).toMatchObject({ ok: false, blocker: `checksum-declaration-unverified:${name}` });
  });
});

describe("deployment shell safety", () => {
  const update = readFileSync(path.join(scripts, "update.sh"), "utf8");
  const rollback = readFileSync(path.join(scripts, "rollback.sh"), "utf8");
  const migrate = readFileSync(path.join(scripts, "migrate.sh"), "utf8");
  const commonShell = readFileSync(path.join(scripts, "lib/common.sh"), "utf8");

  it("forwards only a validated deployment SHA through the clean Compose environment", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-compose-sha-"));
    const recorder = path.join(dir, "compose-recorder"); const output = path.join(dir, "observed");
    writeFileSync(recorder, `#!/usr/bin/env bash\nprintf '%s\\n' "\${GIT_SHA:-missing}" > '${output}'\nenv | LC_ALL=C sort >> '${output}'\nprintf '%s\\n' -- "$@" >> '${output}'\n`, { mode: 0o755 });
    const sha = "a".repeat(40);
    const command = `. '${path.join(scripts, "lib/common.sh")}'; detect_compose_command(){ :; }; validate_compose_contract_paths(){ :; }; run_operation_child(){ "$@"; }; COMPOSE_CMD=('${recorder}'); run_compose_with_deployment_sha '${sha}' build`;
    const result = spawnSync("bash", ["-c", command], { encoding: "utf8", env: { ...process.env, SHOULD_NOT_SURVIVE: "sensitive-fixture" } });
    expect(result.status, result.stderr).toBe(0);
    const observed = readFileSync(output, "utf8");
    expect(observed.split("\n")[0]).toBe(sha);
    expect(observed).toContain(`GIT_SHA=${sha}`);
    expect(observed).not.toContain("SHOULD_NOT_SURVIVE");
    expect(observed).toContain("build");
  });

  it("rejects an unvalidated deployment SHA before invoking Compose", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-compose-bad-sha-")); const invoked = path.join(dir, "invoked");
    const command = `. '${path.join(scripts, "lib/common.sh")}'; detect_compose_command(){ echo yes > '${invoked}'; }; run_compose_with_deployment_sha unknown build`;
    expect(spawnSync("bash", ["-c", command], { env: process.env }).status).not.toBe(0);
    expect(existsSync(invoked)).toBe(false);
  });

  it("binds the validated SHA build argument to exactly api, bot, and worker", () => {
    const compose = readFileSync(path.join(root, "docker-compose.yml"), "utf8");
    const services = [...compose.matchAll(/^ {2}(api|bot|worker):\n(?:^(?: {4}.*|\s*)\n)*?^ {8}GIT_SHA: \$\{GIT_SHA:-unknown\}$/gm)].map((match) => match[1]);
    expect(services).toEqual(["api", "bot", "worker"]);
  });

  it("observes only allowlisted running Compose services through hardened wrappers", () => {
    const json = JSON.stringify([{ State: { Running: true }, Config: { Labels: { "com.docker.compose.project": "zedbot", "com.docker.compose.service": "worker" } } }]);
    const setup = `. '${path.join(scripts, "lib/common.sh")}'; run_compose(){ echo container-id; }; run_clean_docker(){ printf '%s' '${json}'; };`;
    expect(spawnSync("bash", ["-c", `${setup} compose_service_running worker`], { env: process.env }).status).toBe(0);
    expect(spawnSync("bash", ["-c", `${setup} compose_service_running attacker`], { env: process.env }).status).not.toBe(0);
  });

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  }

  function repositoryPair(originUrl = "https://github.com/Mhoseinshah1/ZED_BOT.git") {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-git-safety-"));
    const origin = path.join(dir, "origin.git"); const seed = path.join(dir, "seed"); const app = path.join(dir, "app");
    git(dir, "init", "--bare", origin); git(dir, "init", "-b", "main", seed);
    git(seed, "config", "user.email", "test@example.invalid"); git(seed, "config", "user.name", "test");
    writeFileSync(path.join(seed, "version"), "one\n");
    writeFileSync(path.join(seed, ".gitignore"), "node_modules/\ndist/\ncoverage/\n");
    git(seed, "add", "version", ".gitignore"); git(seed, "commit", "-m", "one");
    git(seed, "remote", "add", "origin", origin); git(seed, "push", "-u", "origin", "main");
    git(dir, "clone", "-b", "main", origin, app); git(app, "config", "user.email", "test@example.invalid"); git(app, "config", "user.name", "test");
    git(app, "remote", "set-url", "origin", originUrl);
    git(app, "config", "url.file://" + origin + ".insteadOf", originUrl);
    return { dir, origin, seed, app };
  }

  function prepare(app: string, extraEnv: Record<string, string> = {}) {
    return spawnSync("bash", ["-c", `. '${path.join(scripts, "lib/common.sh")}'; prepare_exact_origin_main`], {
      encoding: "utf8", env: { ...process.env, ZEDBOT_APP_DIR: app, ...extraEnv },
    });
  }

  it.each([
    "https://github.com/Mhoseinshah1/ZED_BOT.git",
    "https://github.com/Mhoseinshah1/ZED_BOT",
    "git@github.com:Mhoseinshah1/ZED_BOT",
    "git@github.com:Mhoseinshah1/ZED_BOT.git",
    "ssh://git@github.com/Mhoseinshah1/ZED_BOT",
    "ssh://git@github.com/Mhoseinshah1/ZED_BOT.git",
  ])("accepts the exact canonical origin spelling %s", (originUrl) => {
    const result = prepare(repositoryPair(originUrl).app);
    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    "https://github.com/someone/ZED_BOT.git",
    "https://github.com/Mhoseinshah1/ZED_BOT.evil.git",
    "https://github.com.evil.invalid/Mhoseinshah1/ZED_BOT.git",
    "ssh://git@github.com:22/Mhoseinshah1/ZED_BOT.git",
  ])("rejects wrong and lookalike origins: %s", (originUrl) => {
    expect(prepare(repositoryPair(originUrl).app).status).not.toBe(0);
  });

  it.each(["tracked", "staged", "untracked"])("rejects %s build-context content", (kind) => {
    const pair = repositoryPair();
    if (kind === "tracked") writeFileSync(path.join(pair.app, "version"), "dirty\n");
    else if (kind === "staged") { writeFileSync(path.join(pair.app, "version"), "staged\n"); git(pair.app, "add", "version"); }
    else writeFileSync(path.join(pair.app, "overlay"), "overlay\n");
    expect(prepare(pair.app).status).not.toBe(0);
  });

  it("allows ignored dependency and build output because it cannot enter the commit snapshot", () => {
    const pair = repositoryPair();
    mkdirSync(path.join(pair.app, "node_modules")); writeFileSync(path.join(pair.app, "node_modules", "dependency"), "ignored\n");
    mkdirSync(path.join(pair.app, "dist")); writeFileSync(path.join(pair.app, "dist", "bundle.js"), "ignored\n");
    expect(prepare(pair.app).status).toBe(0);
  });

  it("rejects detached HEAD and wrong branches", () => {
    let pair = repositoryPair(); git(pair.app, "checkout", "--detach"); expect(prepare(pair.app).status).not.toBe(0);
    pair = repositoryPair(); git(pair.app, "checkout", "-b", "other"); expect(prepare(pair.app).status).not.toBe(0);
  });

  it("captures the fetched commit/tree and verifies the exact immutable snapshot tree", () => {
    const pair = repositoryPair(); const result = prepare(pair.app);
    expect(result.status, result.stderr).toBe(0);
    const [sha, tree, snapshot] = result.stdout.trim().split(" ");
    expect(git(snapshot, "rev-parse", "HEAD")).toBe(sha);
    expect(git(snapshot, "rev-parse", "HEAD^{tree}")).toBe(tree);
    expect(git(snapshot, "status", "--porcelain", "--untracked-files=all")).toBe("");
    chmodSync(path.join(snapshot, "version"), 0o644); writeFileSync(path.join(snapshot, "version"), "mutated\n");
    const verify = spawnSync("bash", ["-c", `. '${path.join(scripts, "lib/common.sh")}'; verify_source_snapshot '${snapshot}' '${sha}' '${tree}'`], { env: { ...process.env, ZEDBOT_APP_DIR: pair.app } });
    expect(verify.status).not.toBe(0);
  });

  it("passes the already verified snapshot directory itself to the mocked Docker build", () => {
    const pair = repositoryPair(); const prepared = prepare(pair.app);
    const [sha, tree, snapshot] = prepared.stdout.trim().split(" ");
    const bin = path.join(pair.dir, "bin"); const record = path.join(pair.dir, "docker-args"); mkdirSync(bin);
    writeFileSync(path.join(bin, "docker"), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${record}'\n`, { mode: 0o755 });
    const result = spawnSync("bash", ["-c", `. '${path.join(scripts, "lib/common.sh")}'; _ZEDBOT_FIXED_DOCKER_PATH='${bin}:${process.env.PATH}'; build_verified_source_snapshot '${sha}' '${tree}' '${snapshot}'`], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ZEDBOT_APP_DIR: pair.app },
    });
    expect(result.status).toBe(0);
    const args = readFileSync(record, "utf8").trim().split("\n");
    expect(args.slice(0, 3)).toEqual(["--context", "default", "build"]);
    expect(args.at(-1)).toBe(snapshot);
  });

  it("rejects a local-only commit ahead of origin/main", () => {
    const pair = repositoryPair();
    writeFileSync(path.join(pair.app, "local"), "local\n"); git(pair.app, "add", "local"); git(pair.app, "commit", "-m", "local");
    expect(prepare(pair.app).status).not.toBe(0);
  });

  it("fast-forwards identity for a checkout behind fetched origin/main", () => {
    const pair = repositoryPair();
    writeFileSync(path.join(pair.seed, "version"), "remote\n"); git(pair.seed, "commit", "-am", "remote"); git(pair.seed, "push");
    const result = prepare(pair.app);
    expect(result.status, result.stderr).toBe(0);
    const [sha, , snapshot] = result.stdout.trim().split(" ");
    // snapshot must reflect the NEW remote commit, not the stale local HEAD.
    expect(git(snapshot, "rev-parse", "HEAD")).toBe(sha);
    expect(readFileSync(path.join(snapshot, "version"), "utf8")).toBe("remote\n");
    // the local checkout itself is never mutated: it stays behind.
    expect(git(pair.app, "rev-parse", "HEAD")).not.toBe(sha);
  });

  it("still accepts a checkout already exactly at the fetched origin/main (no regression)", () => {
    const pair = repositoryPair();
    const result = prepare(pair.app);
    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects divergence from fetched origin/main", () => {
    const pair = repositoryPair();
    writeFileSync(path.join(pair.seed, "version"), "remote\n"); git(pair.seed, "commit", "-am", "remote"); git(pair.seed, "push");
    writeFileSync(path.join(pair.app, "local"), "local\n"); git(pair.app, "add", "local"); git(pair.app, "commit", "-m", "local");
    expect(prepare(pair.app).status).not.toBe(0);
  });

  it("blocks every later stage when checkout or snapshot integrity changes", () => {
    for (const mutation of ["checkout", "snapshot"] as const) {
      const pair = repositoryPair(); const prepared = prepare(pair.app);
      expect(prepared.status, prepared.stderr).toBe(0);
      const [sha, tree, snapshot] = prepared.stdout.trim().split(" ");
      if (mutation === "checkout") writeFileSync(path.join(pair.app, "overlay"), "late\n");
      else { chmodSync(path.join(snapshot, "version"), 0o644); writeFileSync(path.join(snapshot, "version"), "late\n"); }
      const record = path.join(pair.dir, "stages");
      const command = `. '${path.join(scripts, "lib/common.sh")}'; build(){ echo build >>'${record}'; }; migrate(){ echo migrate >>'${record}'; }; tag_image(){ echo tag >>'${record}'; }; recreate(){ echo recreate >>'${record}'; }; require_source_integrity '${sha}' '${tree}' '${snapshot}' && build && migrate && tag_image && recreate`;
      const result = spawnSync("bash", ["-c", command], { env: { ...process.env, ZEDBOT_APP_DIR: pair.app } });
      expect(result.status).not.toBe(0);
      expect(existsSync(record)).toBe(false);
    }
  });

  it("rejects substitution of the verified snapshot path", () => {
    const pair = repositoryPair(); const prepared = prepare(pair.app);
    const [sha, tree, snapshot] = prepared.stdout.trim().split(" ");
    const displaced = `${snapshot}-displaced`; renameSync(snapshot, displaced); mkdirSync(snapshot);
    const result = spawnSync("bash", ["-c", `. '${path.join(scripts, "lib/common.sh")}'; verify_source_snapshot '${snapshot}' '${sha}' '${tree}'`], { env: { ...process.env, ZEDBOT_APP_DIR: pair.app } });
    expect(result.status).not.toBe(0);
  });

  it("interruption cleanup removes only the registered owned snapshot", () => {
    const pair = repositoryPair(); const prepared = prepare(pair.app);
    const [sha, tree, snapshot] = prepared.stdout.trim().split(" ");
    const substitute = `${snapshot}-substitute`; mkdirSync(substitute);
    const command = `. '${path.join(scripts, "lib/common.sh")}'; register_source_snapshot '${snapshot}' '${sha}' '${tree}'; trap 'cleanup_source_snapshot "$SOURCE_SNAPSHOT_OWNED_PATH" "${sha}" "${tree}"' EXIT; exit 130`;
    expect(spawnSync("bash", ["-c", command], { env: { ...process.env, ZEDBOT_APP_DIR: pair.app } }).status).toBe(130);
    expect(existsSync(snapshot)).toBe(false);
    expect(existsSync(substitute)).toBe(true);
  });

  it("keeps preDeploy and target identities distinct", () => {
    expect(update).toContain("preDeploySha:$preDeploySha");
    expect(update).toContain("preDeployImageId:$preDeployImageId");
    expect(update).toContain("targetDeploySha:$targetDeploySha");
    expect(update.indexOf("validate_running_application")).toBeLessThan(update.indexOf("prepare_exact_origin_main"));
    expect(update).toContain("cannot be retained as known-good");
  });

  // Regression: bootstrap-deployment.sh explicitly supports installing with
  // an empty TELEGRAM_BOT_TOKEN, promoting via
  // validate_running_application "$target" 0 (require_bot_readiness=0) in
  // that case - apps/bot/src/index.ts never calls run() without a token, so
  // it never publishes the bot-specific readiness marker, and generic
  // application readiness (containers running, healthy, correct image) is
  // all that is achievable. Every `zedbot update` nevertheless validated the
  // CURRENT running application as its own rollback candidate with the
  // default STRICT form (require_bot_readiness=1), so a supported,
  // intentionally-tokenless install could never be updated - not even for a
  // security fix - until an operator configured the token and restarted.
  it("validates the current running application without requiring bot-specific readiness when TELEGRAM_BOT_TOKEN is not configured, matching bootstrap-deployment.sh's own gate", () => {
    const start = update.indexOf('if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then');
    expect(start).toBeGreaterThan(-1);
    const end = update.indexOf('\n  read -r pre_deploy_sha', start);
    expect(end).toBeGreaterThan(start);
    const guard = update.slice(start, end);
    expect(guard).toContain('identity="$(validate_running_application)"');
    expect(guard).toContain('identity="$(validate_running_application "" 0)"');

    const run = (token: string | undefined) => {
      const trace = path.join(os.tmpdir(), `zedbot-token-gate-trace-${process.pid}-${Date.now()}-${Math.random()}`);
      // "no token at all" must mean genuinely unset, not "whatever this
      // process happened to inherit" - explicitly unset it (in addition to
      // omitting it from the spawned env below) so the case is deterministic
      // regardless of the ambient environment (e.g. a CI runner that has
      // TELEGRAM_BOT_TOKEN set for an unrelated job/step).
      const command = `unset TELEGRAM_BOT_TOKEN; ${token !== undefined ? `TELEGRAM_BOT_TOKEN='${token}'; ` : ""}log_error(){ :; }; log_warn(){ :; }; validate_running_application(){ printf '%s\\n' "$#:$*" >> '${trace}'; printf 'sha imageid\\n'; }; ${guard}`;
      const { TELEGRAM_BOT_TOKEN: _unused, ...envWithoutToken } = process.env;
      const result = spawnSync("bash", ["-c", command], { encoding: "utf8", env: envWithoutToken });
      return { result, trace: existsSync(trace) ? readFileSync(trace, "utf8").trim() : "" };
    };

    // Token configured: the default, strict (bot-readiness-required) form.
    const withToken = run("123456:abcdefILoveYouIWantYou");
    expect(withToken.result.status, withToken.result.stderr).toBe(0);
    expect(withToken.trace).toBe("0:");

    // No token at all, and an explicitly empty token (the exact shape
    // bootstrap-deployment.sh itself accepts and installs with): both take
    // the relaxed, require_bot_readiness=0 form.
    const withoutToken = run(undefined);
    expect(withoutToken.result.status, withoutToken.result.stderr).toBe(0);
    expect(withoutToken.trace).toBe("2: 0");

    const emptyToken = run("");
    expect(emptyToken.result.status, emptyToken.result.stderr).toBe(0);
    expect(emptyToken.trace).toBe("2: 0");
  });

  // Regression: since prepare_exact_origin_main no longer requires the
  // persistent checkout to already equal the fetched target, update.sh's
  // record_deployed_sha call must pass target_deploy_sha explicitly - its
  // no-argument fallback (repo_head_sha) would otherwise record the stale
  // local HEAD, and the installed CLI (which dispatches every future
  // command through this checkout's own scripts/) must be fast-forwarded to
  // what was actually deployed once the update is verified successful, or
  // deployment tooling silently freezes at an old commit.
  it("records the exact deployed SHA and syncs the deployment checkout only after a verified success", () => {
    expect(update).toContain('record_deployed_sha "$target_deploy_sha"');
    expect(update).not.toMatch(/\brecord_deployed_sha\s*\n/);
    expect(update).toContain("sync_deployment_checkout");
    expect(update.indexOf("finalize_promoted_operation_state")).toBeLessThan(update.indexOf("sync_deployment_checkout"));
    expect(commonShell).toContain("sync_deployment_checkout() {");
  });

  it("fast-forwards the persistent checkout to the deployed target once an update succeeds", () => {
    const pair = repositoryPair();
    writeFileSync(path.join(pair.seed, "version"), "remote\n"); git(pair.seed, "commit", "-am", "remote"); git(pair.seed, "push");
    const prepared = prepare(pair.app);
    expect(prepared.status, prepared.stderr).toBe(0);
    const [sha] = prepared.stdout.trim().split(" ");
    expect(git(pair.app, "rev-parse", "HEAD")).not.toBe(sha);
    const sync = spawnSync("bash", ["-c", `. '${path.join(scripts, "lib/common.sh")}'; set_deployment_state_paths '${pair.dir}'; acquire_deployment_lock; sync_deployment_checkout '${sha}'`], {
      encoding: "utf8", env: { ...process.env, ZEDBOT_APP_DIR: pair.app },
    });
    expect(sync.status, sync.stderr).toBe(0);
    expect(git(pair.app, "rev-parse", "HEAD")).toBe(sha);
    expect(readFileSync(path.join(pair.app, "version"), "utf8")).toBe("remote\n");
  });

  it("sync_deployment_checkout is a safe no-op when the checkout already matches the target", () => {
    const pair = repositoryPair();
    const head = git(pair.app, "rev-parse", "HEAD");
    const sync = spawnSync("bash", ["-c", `. '${path.join(scripts, "lib/common.sh")}'; set_deployment_state_paths '${pair.dir}'; acquire_deployment_lock; sync_deployment_checkout '${head}'`], {
      encoding: "utf8", env: { ...process.env, ZEDBOT_APP_DIR: pair.app },
    });
    expect(sync.status, sync.stderr).toBe(0);
    expect(git(pair.app, "rev-parse", "HEAD")).toBe(head);
  });

  // Regression (P1, PR #155 review of scripts/update.sh:394 - "Keep the
  // installed CLI aligned with its script bundle"): the installed CLI used
  // to be refreshed at old step 6 of 14 - long before the update had
  // actually succeeded - while the persistent checkout (whose
  // lib/common.sh the installed zedbot.sh ALWAYS sources at runtime,
  // regardless of the installed CLI's own version: zedbot.sh hardcodes
  // ZEDBOT_APP_DIR, it never resolves its own path via BASH_SOURCE) was
  // only fast-forwarded at the very end, and only on success. Any failure
  // after that early refresh - or the final checkout sync itself merely
  // warning and continuing - left a NEW installed CLI paired with the OLD
  // checkout's common.sh: exactly the one combination that can
  // command-not-found on newly added helpers (e.g.
  // bind_current_generation_compose_contract), precisely when an operator
  // needs `zedbot restart`/`doctor` most. The fix moves the install to the
  // very end, nested inside - and gated on - the checkout sync's own
  // success, so that combination can no longer occur.
  it("refreshes the installed CLI only at promotion time, nested inside the checkout sync's own success branch (not at the old early step)", () => {
    // The old early refresh - long before the update had succeeded - is gone.
    expect(update).not.toMatch(/install -m 0755 "\$SOURCE_SNAPSHOT\/scripts\/zedbot\.sh"/);
    expect(update).not.toMatch(/Refreshing the installed zedbot CLI/);
    // No leftover "N/14" step label survives the step-6 removal, and the
    // renumbered final step is present.
    expect(update).not.toMatch(/\[\d+\/14\]/);
    expect(update).toContain('log_info "[13/13] Running health checks');

    // refresh_cli (common.sh's own install+verify helper - reused here
    // rather than duplicating a raw `install` call) is what performs the
    // refresh now, and it runs strictly after promotion has committed, and
    // strictly inside the success branch of the checkout sync call - never
    // independently of it.
    expect(update).toContain("refresh_cli");
    expect(commonShell).toContain("refresh_cli() {");
    const promotedIndex = update.indexOf("advance_operation_state promotion-prepared promoted");
    const syncIndex = update.indexOf('if sync_deployment_checkout "$target_deploy_sha"; then');
    const refreshIndex = update.indexOf("refresh_cli", syncIndex);
    const elseIndex = update.indexOf("\n    else\n", syncIndex);
    expect(promotedIndex).toBeGreaterThan(-1);
    expect(syncIndex).toBeGreaterThan(promotedIndex);
    expect(refreshIndex).toBeGreaterThan(syncIndex);
    expect(refreshIndex).toBeLessThan(elseIndex);
  });

  // Behavioral: the checkout sync and the CLI refresh switch as one unit.
  // Extracts update.sh's own promotion-tail if/else/fi block (the exact
  // code proven above to run only after promotion) and runs it for real
  // against a fabricated git checkout pair and a real file standing in for
  // $ZEDBOT_CLI_PATH, mirroring this file's own repositoryPair()/prepare()
  // harness conventions.
  {
    const tailStart = 'if sync_deployment_checkout "$target_deploy_sha"; then';
    const tailEnd = '\n    log_success "ZED_BOT update completed successfully."';
    const promotionTail = update.slice(update.indexOf(tailStart), update.indexOf(tailEnd));

    const addCommit = (pair: ReturnType<typeof repositoryPair>, relativePath: string, content: string) => {
      const abs = path.join(pair.seed, relativePath);
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(abs, content);
      git(pair.seed, "add", relativePath);
      git(pair.seed, "commit", "-m", `add ${relativePath}`);
      git(pair.seed, "push");
    };

    const runPromotionTail = (pair: ReturnType<typeof repositoryPair>, sha: string, cliPath: string) => {
      const trace = `${cliPath}.trace`;
      const command = `. '${path.join(scripts, "lib/common.sh")}'; set_deployment_state_paths '${pair.dir}'; acquire_deployment_lock; target_deploy_sha='${sha}'; log_warn(){ printf 'WARN:%s\\n' "$*" >> '${trace}'; }; ${promotionTail}`;
      const result = spawnSync("bash", ["-c", command], {
        encoding: "utf8",
        env: { ...process.env, ZEDBOT_APP_DIR: pair.app, ZEDBOT_CLI_PATH: cliPath },
      });
      return { result, trace: existsSync(trace) ? readFileSync(trace, "utf8") : "" };
    };

    it("a full success fast-forwards the checkout AND installs the new CLI content", () => {
      const pair = repositoryPair();
      addCommit(pair, "scripts/zedbot.sh", "#!/usr/bin/env bash\necho new-cli\n");
      const prepared = prepare(pair.app);
      expect(prepared.status, prepared.stderr).toBe(0);
      const [sha] = prepared.stdout.trim().split(" ");
      const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-cli-promote-ok-"));
      const cliPath = path.join(dir, "zedbot");
      writeFileSync(cliPath, "#!/usr/bin/env bash\necho old-cli\n");

      const { result, trace } = runPromotionTail(pair, sha, cliPath);
      expect(result.status, result.stderr).toBe(0);
      expect(trace).toBe("");
      expect(git(pair.app, "rev-parse", "HEAD")).toBe(sha);
      expect(readFileSync(cliPath, "utf8")).toBe("#!/usr/bin/env bash\necho new-cli\n");
    });

    it("a checkout-sync failure leaves BOTH the checkout and the installed CLI on the old, consistent pair (byte-identical, untouched)", () => {
      const pair = repositoryPair();
      addCommit(pair, "scripts/zedbot.sh", "#!/usr/bin/env bash\necho new-cli\n");
      const prepared = prepare(pair.app);
      expect(prepared.status, prepared.stderr).toBe(0);
      const [sha] = prepared.stdout.trim().split(" ");
      // Diverge the app checkout locally AFTER the fetch (unexpected
      // external interference - the one way sync_deployment_checkout's own
      // comment says a fast-forward can fail) so `git merge --ff-only`
      // refuses outright, without touching anything.
      writeFileSync(path.join(pair.app, "local-drift.txt"), "drift\n");
      git(pair.app, "add", "local-drift.txt");
      git(pair.app, "commit", "-m", "local drift");
      const preHead = git(pair.app, "rev-parse", "HEAD");
      expect(preHead).not.toBe(sha);

      const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-cli-promote-syncfail-"));
      const cliPath = path.join(dir, "zedbot");
      const oldContent = "#!/usr/bin/env bash\necho old-cli\n";
      writeFileSync(cliPath, oldContent);

      const { result, trace } = runPromotionTail(pair, sha, cliPath);
      // Best-effort: the surrounding if/else never itself fails the update.
      expect(result.status, result.stderr).toBe(0);
      expect(trace).toContain("Could not fast-forward the deployment checkout");
      // The checkout never advanced ...
      expect(git(pair.app, "rev-parse", "HEAD")).toBe(preHead);
      // ... and the CLI is left exactly as it was: never installed ahead of
      // a checkout that did not itself move.
      expect(readFileSync(cliPath, "utf8")).toBe(oldContent);
    });

    it("a CLI-refresh failure after a successful checkout sync leaves the OLD CLI byte-identical in place against the NEW checkout (the one safe residual mismatch: common.sh only ever gains helpers)", () => {
      const pair = repositoryPair();
      // scripts/zedbot.sh lands as a DIRECTORY in the new commit (a broken
      // release tree) - refresh_cli's own precondition check on its source
      // fails deterministically, regardless of privilege level, before it
      // ever touches the destination.
      addCommit(pair, "scripts/zedbot.sh/inner", "oops\n");
      const prepared = prepare(pair.app);
      expect(prepared.status, prepared.stderr).toBe(0);
      const [sha] = prepared.stdout.trim().split(" ");

      const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-cli-promote-refreshfail-"));
      const cliPath = path.join(dir, "zedbot");
      const oldContent = "#!/usr/bin/env bash\necho old-cli\n";
      writeFileSync(cliPath, oldContent);

      const { result, trace } = runPromotionTail(pair, sha, cliPath);
      expect(result.status, result.stderr).toBe(0);
      expect(trace).toContain("Could not refresh the installed zedbot CLI");
      // The checkout DID advance - sync itself succeeded ...
      expect(git(pair.app, "rev-parse", "HEAD")).toBe(sha);
      // ... but the installed CLI is untouched, byte-identical to before.
      expect(readFileSync(cliPath, "utf8")).toBe(oldContent);
    });
  }

  it("rollback targets only application services with mandatory isolation flags", () => {
    expect(rollback).toContain("execute_validated_rollback_transition");
    expect(commonShell).toContain("execute_validated_rollback_transition()");
    expect(commonShell).toContain("recreate_application_services || return 1");
    expect(commonShell).toContain("up -d --no-deps --no-build --pull never --force-recreate api bot worker");
    expect(rollback).not.toMatch(/run_compose\s+(down|stop|restart)\b/);
    expect(rollback).not.toMatch(/run_compose\s+up(?![^\n]*api bot worker)/);
    expect(rollback).not.toMatch(/docker\s+(system|image)\s+prune/);
    expect(rollback).not.toMatch(/pg_restore|psql|migrate\.sh|prisma migrate|\bseed\b/);
    expect(rollback.indexOf('validate_running_application "$pre"')).toBeLessThan(rollback.indexOf("Application rollback completed"));
    expect(rollback).toContain("Post-rollback application health validation failed");
  });

  // Regression: build_verified_source_snapshot retags zedbot-app:latest to
  // the candidate the moment the build succeeds - long before compatibility
  // validation, migrations, or recreation. A failure anywhere in that window
  // used to leave the tag on the unvalidated candidate while the old
  // containers kept running: `zedbot restart`/`start` force-recreate
  // straight from that tag, so an unrelated restart could start new code
  // before its compatibility gate or migrations ever succeeded.
  function mockDocker(bin: string, stateDir: string) {
    mkdirSync(bin, { recursive: true }); mkdirSync(stateDir, { recursive: true });
    writeFileSync(path.join(bin, "docker"), `#!/usr/bin/env bash
state='${stateDir}'
# The real invocation is "docker --context default image inspect|tag ...";
# shift the fixed prefix off before pattern-matching the subcommand.
[ "$1" = "--context" ] && shift 2
if [ "$1 $2" = "image inspect" ]; then
  ref="\${@: -1}"; file="$state/$(printf '%s' "$ref" | tr '/:' '__')"
  [ -f "$file" ] && cat "$file" || exit 1
elif [ "$1 $2" = "image tag" ]; then
  printf '%s' "$3" > "$state/$(printf '%s' "$4" | tr '/:' '__')"
fi
`, { mode: 0o755 });
  }
  function restore(bin: string, imageId: string) {
    return spawnSync("bash", ["-c", `. '${path.join(scripts, "lib/common.sh")}'; _ZEDBOT_FIXED_DOCKER_PATH='${bin}:${process.env.PATH}'; restore_deployment_reference '${imageId}'`], { encoding: "utf8" });
  }

  it("restore_deployment_reference retags latest back onto the known-good image", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-restore-ref-")); const bin = path.join(dir, "bin"); const state = path.join(dir, "state");
    const goodId = `sha256:${"1".repeat(64)}`; const candidateId = `sha256:${"2".repeat(64)}`;
    mockDocker(bin, state);
    writeFileSync(path.join(state, `${goodId.replace(":", "_")}`), goodId);
    writeFileSync(path.join(state, "zedbot-app_latest"), candidateId);
    const result = restore(bin, goodId);
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(path.join(state, "zedbot-app_latest"), "utf8")).toBe(goodId);
  });

  it("restore_deployment_reference is a no-op when latest already matches the target", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-restore-ref-noop-")); const bin = path.join(dir, "bin"); const state = path.join(dir, "state");
    const goodId = `sha256:${"3".repeat(64)}`;
    mockDocker(bin, state);
    writeFileSync(path.join(state, `${goodId.replace(":", "_")}`), goodId);
    writeFileSync(path.join(state, "zedbot-app_latest"), goodId);
    expect(restore(bin, goodId).status).toBe(0);
  });

  it("restore_deployment_reference fails when the restore target no longer exists", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-restore-ref-missing-")); const bin = path.join(dir, "bin"); const state = path.join(dir, "state");
    mockDocker(bin, state);
    expect(restore(bin, `sha256:${"4".repeat(64)}`).status).not.toBe(0);
  });

  it("restore_deployment_reference rejects a malformed image ID without invoking docker", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-restore-ref-malformed-")); const bin = path.join(dir, "bin"); const state = path.join(dir, "state");
    mockDocker(bin, state);
    expect(restore(bin, "not-an-image-id").status).not.toBe(0);
  });

  it("update.sh arms the restore before the build and disarms once recreation starts", () => {
    const restoreArm = update.indexOf('DEPLOYMENT_REFERENCE_RESTORE_ID="$pre_deploy_image_id"');
    const buildCall = update.indexOf('build_verified_source_snapshot "$target_deploy_sha"');
    expect(restoreArm).toBeGreaterThan(-1);
    expect(buildCall).toBeGreaterThan(-1);
    expect(restoreArm).toBeLessThan(buildCall);
    const disarm = update.indexOf('DEPLOYMENT_REFERENCE_RESTORE_ID=""', buildCall);
    const recreateCall = update.indexOf("recreate_application_services", buildCall);
    expect(disarm).toBeGreaterThan(buildCall);
    expect(disarm).toBeLessThan(recreateCall);
    expect(update).toContain("restore_deployment_reference");
    expect(commonShell).toContain("restore_deployment_reference() {");
  });

  // Regression: update.sh replaced the legacy migrate.sh's migration step
  // (which always ran packages/database/dist/seed.js afterward - OWNER
  // admins from ADMIN_TELEGRAM_IDS, default settings, log topics, message
  // templates, button texts) with a direct `prisma migrate deploy` call,
  // but dropped the seed step. A release shipping new seed-registry entries,
  // or a changed ADMIN_TELEGRAM_IDS, was promoted by `zedbot update` without
  // ever creating the required rows - matching the identical bug already
  // fixed for the first-install path in bootstrap-deployment.sh.
  it("update.sh seeds baseline data after migrations and before recreation, matching the legacy installer's seed step", () => {
    expect(update).toContain("packages/database/dist/seed.js");
    const migrateIndex = update.indexOf("prisma migrate deploy");
    // The no-op guard (checked separately below) also re-runs seed.js
    // earlier in the file - search from the real migration step onward for
    // THIS step's own seed call, not that one.
    const seedIndex = update.indexOf("packages/database/dist/seed.js", migrateIndex);
    const confirmedIndex = update.indexOf("advance_operation_state compatibility-confirmed migrations-confirmed");
    // update_owned_cleanup's own explanatory comment (checked separately
    // below) also mentions recreate_application_services in prose, earlier
    // in the file - search from the migrations-confirmed marker onward for
    // the real call.
    const recreateIndex = update.indexOf("recreate_application_services", confirmedIndex);
    expect(migrateIndex).toBeGreaterThan(-1);
    expect(seedIndex).toBeGreaterThan(-1);
    expect(confirmedIndex).toBeGreaterThan(-1);
    expect(recreateIndex).toBeGreaterThan(-1);
    expect(migrateIndex).toBeLessThan(seedIndex);
    expect(seedIndex).toBeLessThan(confirmedIndex);
    expect(confirmedIndex).toBeLessThan(recreateIndex);
  });

  // Regression: when origin/main is already the SHA recorded as running
  // (current.json's own targetDeploySha, captured as pre_deploy_sha), a
  // routine repeated `zedbot update` still built a new candidate,
  // retagged the running image under a fresh generation, and promoted it -
  // which unconditionally overwrites previous.json with a duplicate of the
  // generation that is already current (promote_healthy_candidate ->
  // write_lifecycle_role), permanently losing the real prior release as a
  // rollback target even though nothing was actually deployed. The guard
  // must fire (and exit successfully) before ANY candidate generation
  // state is created, and must NOT fire when the source genuinely changed.
  it("update.sh finishes without rotating generation metadata when origin/main has not moved past what is already running, but still re-seeds baseline data", () => {
    const guardStart = update.indexOf('if [ "$target_deploy_sha" = "$pre_deploy_sha" ]; then');
    expect(guardStart).toBeGreaterThan(-1);
    const guardEnd = update.indexOf('\n\n  log_info "[5/13]', guardStart);
    expect(guardEnd).toBeGreaterThan(guardStart);
    const guard = update.slice(guardStart, guardEnd);

    const rotationStart = update.indexOf('CANDIDATE_METADATA="$ZEDBOT_DEPLOYMENT_DIR/candidate-');
    expect(rotationStart).toBeGreaterThan(guardStart);
    // Regression: an operator can change ADMIN_TELEGRAM_IDS (or pick up any
    // other missing idempotent seed-registry default) with no new source
    // commit to deploy. The no-op guard must still re-run seed.js - the
    // `zedbot restart` it points operators at for a drift repair only
    // recreates containers, it never seeds.
    expect(guard).toContain("packages/database/dist/seed.js");

    const NOOP_HASH = "7".repeat(64);
    const run = (targetSha: string, preSha: string, compat: { ok: boolean; manifestSha256: string } = { ok: true, manifestSha256: NOOP_HASH }) =>
      spawnSync(
        "bash",
        [
          "-c",
          `target_deploy_sha='${targetSha}'; pre_deploy_sha='${preSha}'; target_tree='${"c".repeat(40)}'; SOURCE_SNAPSHOT='/snapshot'; baseline_csv='${migration(1)}'; ` +
            `log_success(){ printf 'SUCCESS:%s\\n' "$*"; }; log_info(){ printf 'INFO:%s\\n' "$*"; }; log_error(){ printf 'ERROR:%s\\n' "$*"; }; log_warn(){ :; }; ` +
            `require_source_integrity(){ :; }; validate_migration_declaration_pair(){ MIGRATION_MANIFEST_SHA256='${NOOP_HASH}'; }; finalize_stale_promoted_operation_state(){ :; }; ` +
            `run_compose(){ case "$*" in *rollback-compatibility.js*) printf '{"ok":${compat.ok},"manifestSha256":"${compat.manifestSha256}","blocker":"drift-detected"}'; ${compat.ok ? "return 0" : "return 1"} ;; *) printf 'RUN_COMPOSE:%s\\n' "$*" ;; esac; }; ` +
            `${guard}\necho REACHED_STEP_5`,
        ],
        { encoding: "utf8" },
      );

    const sha = "a".repeat(40);
    const noop = run(sha, sha);
    expect(noop.status, noop.stderr).toBe(0);
    expect(noop.stdout).toContain("SUCCESS:Already up to date");
    expect(noop.stdout).toContain("RUN_COMPOSE:run --rm --no-deps api node packages/database/dist/seed.js");
    expect(noop.stdout).not.toContain("REACHED_STEP_5");

    const changed = run(sha, "b".repeat(40));
    expect(changed.status).toBe(0);
    expect(changed.stdout).toContain("REACHED_STEP_5");
    expect(changed.stdout).not.toContain("SUCCESS:Already up to date");
    expect(changed.stdout).not.toContain("RUN_COMPOSE:");
  });

  // Regression: a no-op update (origin/main already at what current.json
  // says is running) used to exit successfully right after the plain
  // migration-status name comparison from step 3 - not checksum-aware, blind
  // to an applied database-only migration or a shipped migration whose
  // manifest-declared checksum has since changed. The no-op guard must run
  // the exact same strict, checksum-aware validation the normal path runs at
  // steps 6/8 (validate_migration_declaration_pair, then the
  // rollback-compatibility CLI) and fail closed - exactly like the normal
  // path does - the instant either one detects drift, never silently
  // succeeding over a compromised/drifted database just because there was
  // no new source commit to deploy.
  it("the no-op path still runs strict, checksum-aware migration validation before exiting, and fails closed on detected drift", () => {
    const guardStart = update.indexOf('if [ "$target_deploy_sha" = "$pre_deploy_sha" ]; then');
    const guardEnd = update.indexOf('\n\n  log_info "[5/13]', guardStart);
    const guard = update.slice(guardStart, guardEnd);
    expect(guard).toContain("validate_migration_declaration_pair");
    expect(guard).toContain("rollback-compatibility.js");
    expect(guard.indexOf("validate_migration_declaration_pair")).toBeLessThan(guard.indexOf('log_success "Already up to date'));

    const HASH = "7".repeat(64);
    const runNoop = (compat: { ok: boolean; manifestSha256: string }) =>
      spawnSync(
        "bash",
        [
          "-c",
          `target_deploy_sha='${"a".repeat(40)}'; pre_deploy_sha='${"a".repeat(40)}'; target_tree='${"c".repeat(40)}'; SOURCE_SNAPSHOT='/snapshot'; baseline_csv='${migration(1)}'; ` +
            `log_success(){ printf 'SUCCESS:%s\\n' "$*"; }; log_info(){ printf 'INFO:%s\\n' "$*"; }; log_error(){ printf 'ERROR:%s\\n' "$*"; }; log_warn(){ :; }; ` +
            `require_source_integrity(){ :; }; validate_migration_declaration_pair(){ MIGRATION_MANIFEST_SHA256='${HASH}'; }; finalize_stale_promoted_operation_state(){ :; }; ` +
            `run_compose(){ case "$*" in *rollback-compatibility.js*) printf '{"ok":${compat.ok},"manifestSha256":"${compat.manifestSha256}","blocker":"drift-detected"}'; ${compat.ok ? "return 0" : "return 1"} ;; *) printf 'RUN_COMPOSE:%s\\n' "$*" ;; esac; }; ` +
            `${guard}\necho REACHED_STEP_5`,
        ],
        { encoding: "utf8" },
      );

    // The compatibility CLI itself reports incompatible (e.g. an applied
    // database-only migration): must fail closed before "Already up to
    // date" is ever declared or seed.js ever runs.
    const incompatible = runNoop({ ok: false, manifestSha256: HASH });
    expect(incompatible.status).not.toBe(0);
    expect(incompatible.stdout).not.toContain("SUCCESS:Already up to date");
    expect(incompatible.stdout).not.toContain("RUN_COMPOSE:");

    // The compatibility CLI reports ok, but its manifestSha256 does not
    // match what validate_migration_declaration_pair itself just computed
    // (source changed mid-flight, or a tampered/edited manifest): must also
    // fail closed.
    const mismatched = runNoop({ ok: true, manifestSha256: "9".repeat(64) });
    expect(mismatched.status).not.toBe(0);
    expect(mismatched.stdout).not.toContain("SUCCESS:Already up to date");
    expect(mismatched.stdout).not.toContain("RUN_COMPOSE:");

    // Genuinely compatible and matching: the no-op path still succeeds.
    const compatible = runNoop({ ok: true, manifestSha256: HASH });
    expect(compatible.status, compatible.stderr).toBe(0);
    expect(compatible.stdout).toContain("SUCCESS:Already up to date");
    expect(compatible.stdout).toContain("RUN_COMPOSE:run --rm --no-deps api node packages/database/dist/seed.js");
  });

  it("update_owned_cleanup restores the reference only when recreation was never attempted", () => {
    const body = update.slice(update.indexOf("update_owned_cleanup() {"), update.indexOf("\n# Finds the newest database backup"));
    const trace = path.join(os.tmpdir(), `zedbot-cleanup-trace-${process.pid}-${Date.now()}`);
    const harness = (recreationAttempted: 0 | 1, restoreId: string) => `ZEDBOT_OPERATION_INTERRUPTED=0; APPLICATION_RECREATION_ATTEMPTED=${recreationAttempted}; DEPLOYMENT_REFERENCE_RESTORE_ID='${restoreId}'; CANDIDATE_METADATA=''; ZEDBOT_CURRENT_DEPLOYMENT_METADATA=''; log_error(){ :; }; restore_deployment_reference(){ echo "restore:$1" >> '${trace}'; return 0; }; cleanup_source_snapshot(){ :; }; ${body}\nupdate_owned_cleanup`;
    spawnSync("bash", ["-c", harness(0, `sha256:${"5".repeat(64)}`)], { encoding: "utf8" });
    expect(readFileSync(trace, "utf8")).toContain(`restore:sha256:${"5".repeat(64)}`);
    rmSync(trace, { force: true });
    spawnSync("bash", ["-c", harness(1, `sha256:${"5".repeat(64)}`)], { encoding: "utf8" });
    expect(existsSync(trace)).toBe(false);
  });

  // Regression: a crash between recover_metadata_transition durably
  // committing a promotion (current.json already rewritten to the new
  // generation, the consumed candidate and transition.json both already
  // deleted - see that function's own comment) and this script's own next
  // line actually recording that fact (advance_operation_state
  // promotion-prepared promoted / finalize_promoted_operation_state) leaves
  // operation-state.json parked forever - a fully successful,
  // already-promoted deployment that `zedbot doctor` / `zedbot
  // rollback-status` nonetheless keeps reporting as an incomplete
  // operation. A normal update always mints a brand new generation, so
  // initialize_operation_state's own self-heal would clear a marker like
  // this for free - but the no-op path never reaches that call.
  it("finalize_stale_promoted_operation_state advances or clears an operation-state marker that already names the currently-promoted generation, but never touches an unrelated one", () => {
    const body = update.slice(update.indexOf("finalize_stale_promoted_operation_state() {"), update.indexOf("\n\n# Clears any OTHER candidate-"));
    expect(body).toContain("confirm_operation_state promotion-prepared promoted");
    expect(body).toContain("finalize_promoted_operation_state");

    const currentGeneration = "20260101T000000Z-aaaaaaaaaaaa";
    const foreignGeneration = "20260102T000000Z-bbbbbbbbbbbb";

    function setup() {
      const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-finalize-stale-"));
      chmodSync(dir, 0o700);
      const write = (file: string, value: unknown) => { writeFileSync(file, JSON.stringify(value)); chmodSync(file, 0o600); };
      write(path.join(dir, "current.json"), {
        formatVersion: 2, lifecycleRole: "current", generation: currentGeneration, sourceTree: "a".repeat(40),
        preDeploySha: "b".repeat(40), preDeployImageId: `sha256:${"1".repeat(64)}`, targetDeploySha: "c".repeat(40),
        targetImageId: `sha256:${"2".repeat(64)}`, retainedImageTag: `zedbot-app:rollback-${currentGeneration}`,
        immutableImageTag: `zedbot-app:generation-${currentGeneration}`, failedTargetTag: `zedbot-app:failed-${currentGeneration}`,
        capturedAt: "2026-01-01T00:00:00Z", preDeployMigrations: [], declarationFormatVersion: 2, declarationSourceCategory: "generation-evidence",
        migrationEvidencePath: `${dir}/evidence-${currentGeneration}`, composeEvidencePath: `${dir}/evidence-${currentGeneration}/docker-compose.yml`,
        composeEvidenceSha256: "d".repeat(64), composeProjectName: "zedbot", composeApplicationImage: "zedbot-app:latest",
        compatibilityManifestSha256: "e".repeat(64), compatibilityDeclarations: [],
        recreationAttempted: true, healthConfirmed: true, state: "known-good",
      });
      return { dir, write };
    }

    function run(dir: string) {
      const command = `. '${path.join(scripts, "lib/common.sh")}'; set_deployment_state_paths '${dir}'; acquire_deployment_lock; ${body}\nfinalize_stale_promoted_operation_state; echo "EXIT:$?"`;
      return spawnSync("bash", ["-c", command], { encoding: "utf8" });
    }

    // Stuck at "promotion-prepared", same generation as current.json: must
    // advance to "promoted" and then be removed entirely.
    {
      const { dir, write } = setup();
      const opPath = path.join(dir, "operation-state.json");
      write(opPath, { formatVersion: 1, kind: "update", generation: currentGeneration, stage: "promotion-prepared" });
      const result = run(dir);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("EXIT:0");
      expect(existsSync(opPath)).toBe(false);
    }

    // Stuck at "promoted" (the advance already happened; only the removal
    // never ran): must still end up removed.
    {
      const { dir, write } = setup();
      const opPath = path.join(dir, "operation-state.json");
      write(opPath, { formatVersion: 1, kind: "update", generation: currentGeneration, stage: "promoted" });
      run(dir);
      expect(existsSync(opPath)).toBe(false);
    }

    // A DIFFERENT generation (a genuinely unrelated or still-live marker):
    // must be left completely untouched.
    {
      const { dir, write } = setup();
      const opPath = path.join(dir, "operation-state.json");
      const fixture = { formatVersion: 1, kind: "update", generation: foreignGeneration, stage: "promotion-prepared" };
      write(opPath, fixture);
      run(dir);
      expect(existsSync(opPath)).toBe(true);
      expect(JSON.parse(readFileSync(opPath, "utf8"))).toEqual(fixture);
    }

    // A DIFFERENT kind (rollback), even naming the same generation: must
    // also be left completely untouched.
    {
      const { dir, write } = setup();
      const opPath = path.join(dir, "operation-state.json");
      const fixture = { formatVersion: 1, kind: "rollback", generation: currentGeneration, stage: "promoted" };
      write(opPath, fixture);
      run(dir);
      expect(existsSync(opPath)).toBe(true);
      expect(JSON.parse(readFileSync(opPath, "utf8"))).toEqual(fixture);
    }

    // An earlier stage that happens to (implausibly) already name the
    // current generation: left alone rather than force-advanced.
    {
      const { dir, write } = setup();
      const opPath = path.join(dir, "operation-state.json");
      const fixture = { formatVersion: 1, kind: "update", generation: currentGeneration, stage: "health-confirmed" };
      write(opPath, fixture);
      run(dir);
      expect(existsSync(opPath)).toBe(true);
      expect(JSON.parse(readFileSync(opPath, "utf8"))).toEqual(fixture);
    }

    // No operation-state.json at all: safe no-op.
    {
      const { dir } = setup();
      const result = run(dir);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("EXIT:0");
    }
  });

  // Regression: an update that fails after candidate metadata is written but
  // before application recreation ever starts (state stays "prepared", no
  // failed.json is ever published - on_update_error/update_owned_cleanup
  // only publish one once recreation was actually attempted) used to leave
  // that candidate-<gen>.json (and its evidence-<gen>/ directory) behind
  // forever: a retry only clears the abandoned operation-state.json marker
  // (initialize_operation_state's own self-heal) and mints a brand new
  // generation/candidate, never touching the old one. rollback-status treats
  // ANY candidate-*.json file's mere presence as an unresolved operation
  // regardless of content, so this silently and permanently blocked `zedbot
  // rollback-status` after every early-failing retry.
  it("cleanup_abandoned_prepared_candidates clears an abandoned prepared candidate and its evidence, but leaves a recreated one, this run's own new candidate, and every other canonical state file alone", () => {
    const body = update.slice(update.indexOf("cleanup_abandoned_prepared_candidates() {"), update.indexOf("\n\n# Best-effort housekeeping only, called after a successful promotion."));
    expect(body).toContain("remove_canonical_state_file");
    expect(body).toContain("remove_generation_evidence_directory");

    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-cleanup-candidates-"));
    chmodSync(dir, 0o700);
    const write = (file: string, value: unknown) => { writeFileSync(file, JSON.stringify(value)); chmodSync(file, 0o600); };
    const preparedFixture = (generation: string) => ({
      formatVersion: 2, lifecycleRole: "candidate", generation, sourceTree: "a".repeat(40),
      preDeploySha: "b".repeat(40), preDeployImageId: `sha256:${"1".repeat(64)}`, targetDeploySha: "c".repeat(40),
      retainedImageTag: `zedbot-app:rollback-${generation}`, capturedAt: "2026-01-01T00:00:00Z",
      preDeployMigrations: [], declarationFormatVersion: 2, declarationSourceCategory: "generation-evidence",
      migrationEvidencePath: `${dir}/evidence-${generation}`, composeEvidencePath: `${dir}/evidence-${generation}/docker-compose.yml`,
      composeEvidenceSha256: "d".repeat(64), composeProjectName: "zedbot", composeApplicationImage: "zedbot-app:latest",
      compatibilityManifestSha256: "e".repeat(64), compatibilityDeclarations: [],
      recreationAttempted: false, healthConfirmed: false, state: "prepared",
    });
    const recreatedFixture = (generation: string) => ({
      ...preparedFixture(generation),
      targetImageId: `sha256:${"2".repeat(64)}`, immutableImageTag: `zedbot-app:generation-${generation}`, failedTargetTag: `zedbot-app:failed-${generation}`,
      recreationAttempted: true, state: "application-recreated",
    });

    const abandonedGen = "20260101T000000Z-aaaaaaaaaaaa";
    const recreatedGen = "20260102T000000Z-bbbbbbbbbbbb";
    const thisRunGen = "20260103T000000Z-cccccccccccc";
    const abandonedPath = path.join(dir, `candidate-${abandonedGen}.json`);
    const recreatedPath = path.join(dir, `candidate-${recreatedGen}.json`);
    const thisRunPath = path.join(dir, `candidate-${thisRunGen}.json`);
    write(abandonedPath, preparedFixture(abandonedGen));
    write(recreatedPath, recreatedFixture(recreatedGen));
    // This run's own new candidate: cleanup runs BEFORE update.sh itself
    // ever creates this file, but must never remove it even if (as here,
    // defensively tested) it already exists at call time.
    write(thisRunPath, preparedFixture(thisRunGen));
    mkdirSync(path.join(dir, `evidence-${abandonedGen}`));
    writeFileSync(path.join(dir, `evidence-${abandonedGen}`, "docker-compose.yml"), "services: {}\n");
    mkdirSync(path.join(dir, `evidence-${recreatedGen}`));
    writeFileSync(path.join(dir, `evidence-${recreatedGen}`, "docker-compose.yml"), "services: {}\n");

    // Every other canonical state file: content the function must never
    // even read, let alone modify - its glob (candidate-*.json) cannot
    // match any of these names, but this proves it end to end anyway.
    const untouched: Record<string, string> = {
      "current.json": "current-placeholder",
      "previous.json": "previous-placeholder",
      "failed.json": "failed-placeholder",
      "legacy-install-v1.json": "legacy-placeholder",
      "bootstrap.json": "bootstrap-placeholder",
    };
    for (const [name, content] of Object.entries(untouched)) {
      const p = path.join(dir, name);
      writeFileSync(p, content);
      chmodSync(p, 0o600);
    }

    const command = `. '${path.join(scripts, "lib/common.sh")}'; set_deployment_state_paths '${dir}'; acquire_deployment_lock; CANDIDATE_METADATA='${thisRunPath}'; ${body}\ncleanup_abandoned_prepared_candidates; echo "EXIT:$?"`;
    const result = spawnSync("bash", ["-c", command], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("EXIT:0");

    expect(existsSync(abandonedPath)).toBe(false);
    expect(existsSync(path.join(dir, `evidence-${abandonedGen}`))).toBe(false);

    expect(existsSync(recreatedPath)).toBe(true);
    expect(existsSync(path.join(dir, `evidence-${recreatedGen}`))).toBe(true);

    expect(existsSync(thisRunPath)).toBe(true);
    expect(JSON.parse(readFileSync(thisRunPath, "utf8"))).toEqual(preparedFixture(thisRunGen));

    for (const [name, content] of Object.entries(untouched)) {
      expect(readFileSync(path.join(dir, name), "utf8")).toBe(content);
    }
  });

  // Regression: every successful update permanently tags the candidate
  // zedbot-app:generation-<gen> and retains the prior image
  // zedbot-app:rollback-<gen> - tagged images are not eligible for ordinary
  // Docker pruning, so on a long-lived installation these accumulate
  // unbounded. Only a tag no longer referenced by current.json, previous.json,
  // or an UNRESOLVED failed.json may be pruned.
  it("prune_stale_generation_image_tags removes only tags no longer referenced by current, previous, or an unresolved failed generation", () => {
    const body = update.slice(update.indexOf("prune_stale_generation_image_tags() {"), update.indexOf("\n\nmain() {"));
    expect(body).toContain("run_clean_docker image rm");

    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-prune-tags-"));
    chmodSync(dir, 0o700);
    const write = (file: string, value: unknown) => { writeFileSync(file, JSON.stringify(value)); chmodSync(file, 0o600); };

    const currentGen = "20260103T000000Z-cccccccccccc";
    const previousGen = "20260102T000000Z-bbbbbbbbbbbb";
    const failedGen = "20260104T000000Z-dddddddddddd";
    const staleGen = "20260101T000000Z-aaaaaaaaaaaa";

    const genFixture = (role: "current" | "previous" | "failed", generation: string, extra: Record<string, unknown> = {}) => ({
      formatVersion: 2, lifecycleRole: role, generation, sourceTree: "a".repeat(40),
      preDeploySha: "b".repeat(40), preDeployImageId: `sha256:${"1".repeat(64)}`, targetDeploySha: "c".repeat(40),
      targetImageId: `sha256:${"2".repeat(64)}`, retainedImageTag: `zedbot-app:rollback-${generation}`,
      immutableImageTag: `zedbot-app:generation-${generation}`, failedTargetTag: `zedbot-app:failed-${generation}`,
      capturedAt: "2026-01-01T00:00:00Z", preDeployMigrations: [], declarationFormatVersion: 2, declarationSourceCategory: "generation-evidence",
      migrationEvidencePath: `${dir}/evidence-${generation}`, composeEvidencePath: `${dir}/evidence-${generation}/docker-compose.yml`,
      composeEvidenceSha256: "d".repeat(64), composeProjectName: "zedbot", composeApplicationImage: "zedbot-app:latest",
      compatibilityManifestSha256: "e".repeat(64), compatibilityDeclarations: [],
      recreationAttempted: true, healthConfirmed: role !== "failed", state: role === "failed" ? "failed-after-recreation" : "known-good",
      rollbackTargetGeneration: role === "failed" ? previousGen : undefined,
      rollbackTargetImageId: role === "failed" ? `sha256:${"9".repeat(64)}` : undefined,
      ...extra,
    });
    const strip = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

    write(path.join(dir, "current.json"), strip(genFixture("current", currentGen)));
    write(path.join(dir, "previous.json"), strip(genFixture("previous", previousGen)));
    write(path.join(dir, "failed.json"), strip(genFixture("failed", failedGen)));

    const bin = path.join(dir, "bin");
    const removed = path.join(dir, "removed");
    mkdirSync(bin);
    // Fakes exactly the two docker subcommands prune_stale_generation_image_tags
    // uses: `image ls --format ... zedbot-app` lists every present tag, and
    // `image rm -- <tag>` records what was actually removed.
    writeFileSync(
      path.join(bin, "docker"),
      `#!/usr/bin/env bash
[ "$1" = "--context" ] && shift 2
if [ "$1 $2" = "image ls" ]; then
  cat <<'TAGS'
zedbot-app:generation-${currentGen}
zedbot-app:rollback-${currentGen}
zedbot-app:generation-${previousGen}
zedbot-app:rollback-${previousGen}
zedbot-app:generation-${failedGen}
zedbot-app:failed-${failedGen}
zedbot-app:generation-${staleGen}
zedbot-app:rollback-${staleGen}
zedbot-app:latest
TAGS
elif [ "$1 $2" = "image rm" ]; then
  printf '%s\\n' "$4" >> '${removed}'
fi
`,
      { mode: 0o755 },
    );

    const command = `. '${path.join(scripts, "lib/common.sh")}'; set_deployment_state_paths '${dir}'; acquire_deployment_lock; _ZEDBOT_FIXED_DOCKER_PATH='${bin}:${process.env.PATH}'; ${body}\nprune_stale_generation_image_tags; echo "EXIT:$?"`;
    const result = spawnSync("bash", ["-c", command], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("EXIT:0");

    const removedTags = existsSync(removed) ? readFileSync(removed, "utf8").trim().split("\n").filter(Boolean) : [];
    // The stale generation's two tags (current, previous, and failed do not
    // reference it) are the only ones pruned.
    expect(removedTags.sort()).toEqual([`zedbot-app:generation-${staleGen}`, `zedbot-app:rollback-${staleGen}`].sort());
    // Everything current/previous/unresolved-failed still names is kept.
    for (const gen of [currentGen, previousGen, failedGen]) {
      expect(removedTags).not.toContain(`zedbot-app:generation-${gen}`);
    }
    expect(removedTags).not.toContain("zedbot-app:latest");
  });

  it("prune_stale_generation_image_tags no longer protects a RESOLVED (rolled-back) failed generation's tags", () => {
    const body = update.slice(update.indexOf("prune_stale_generation_image_tags() {"), update.indexOf("\n\nmain() {"));

    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-prune-tags-resolved-"));
    chmodSync(dir, 0o700);
    const write = (file: string, value: unknown) => { writeFileSync(file, JSON.stringify(value)); chmodSync(file, 0o600); };

    const currentGen = "20260103T000000Z-cccccccccccc";
    const failedGen = "20260104T000000Z-dddddddddddd";
    const genFixture = (role: "current" | "failed", generation: string) => ({
      formatVersion: 2, lifecycleRole: role, generation, sourceTree: "a".repeat(40),
      preDeploySha: "b".repeat(40), preDeployImageId: `sha256:${"1".repeat(64)}`, targetDeploySha: "c".repeat(40),
      targetImageId: `sha256:${"2".repeat(64)}`, retainedImageTag: `zedbot-app:rollback-${generation}`,
      immutableImageTag: `zedbot-app:generation-${generation}`, failedTargetTag: `zedbot-app:failed-${generation}`,
      capturedAt: "2026-01-01T00:00:00Z", preDeployMigrations: [], declarationFormatVersion: 2, declarationSourceCategory: "generation-evidence",
      migrationEvidencePath: `${dir}/evidence-${generation}`, composeEvidencePath: `${dir}/evidence-${generation}/docker-compose.yml`,
      composeEvidenceSha256: "d".repeat(64), composeProjectName: "zedbot", composeApplicationImage: "zedbot-app:latest",
      compatibilityManifestSha256: "e".repeat(64), compatibilityDeclarations: [],
      recreationAttempted: true, healthConfirmed: role !== "failed", state: role === "failed" ? "rolled-back" : "known-good",
      rollbackTargetGeneration: role === "failed" ? currentGen : undefined,
      rollbackTargetImageId: role === "failed" ? `sha256:${"9".repeat(64)}` : undefined,
    });
    const strip = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

    write(path.join(dir, "current.json"), strip(genFixture("current", currentGen)));
    write(path.join(dir, "failed.json"), strip(genFixture("failed", failedGen)));

    const bin = path.join(dir, "bin");
    const removed = path.join(dir, "removed");
    mkdirSync(bin);
    writeFileSync(
      path.join(bin, "docker"),
      `#!/usr/bin/env bash
[ "$1" = "--context" ] && shift 2
if [ "$1 $2" = "image ls" ]; then
  cat <<'TAGS'
zedbot-app:generation-${currentGen}
zedbot-app:generation-${failedGen}
zedbot-app:failed-${failedGen}
TAGS
elif [ "$1 $2" = "image rm" ]; then
  printf '%s\\n' "$4" >> '${removed}'
fi
`,
      { mode: 0o755 },
    );

    const command = `. '${path.join(scripts, "lib/common.sh")}'; set_deployment_state_paths '${dir}'; acquire_deployment_lock; _ZEDBOT_FIXED_DOCKER_PATH='${bin}:${process.env.PATH}'; ${body}\nprune_stale_generation_image_tags; echo "EXIT:$?"`;
    const result = spawnSync("bash", ["-c", command], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);

    const removedTags = existsSync(removed) ? readFileSync(removed, "utf8").trim().split("\n").filter(Boolean) : [];
    expect(removedTags.sort()).toEqual([`zedbot-app:generation-${failedGen}`, `zedbot-app:failed-${failedGen}`].sort());
  });

  // Regression: operation_signal_handler (common.sh) handles a SIGINT/
  // SIGTERM/SIGHUP entirely on its own and exits straight to the EXIT trap;
  // it never runs on_update_error (whose ERR trap is explicitly removed
  // before this cleanup runs, and a signal-driven `exit` does not trigger
  // ERR anyway). A signal landing while recreate_application_services is
  // partially recreating the api/bot/worker services previously left the
  // host on a mix of old/new-image containers, with current.json still
  // naming the old generation and NO failed.json recorded anywhere -
  // exactly the evidence on_update_error publishes for an ordinary post-
  // recreation error, just missing for this one exit path.
  // Regression (found by review of an earlier version of this same fix): the
  // first version of this test stubbed set_rollback_state/
  // publish_failed_generation with trace-writing fakes, which is exactly why
  // it never caught that both real functions - and atomic_write_metadata
  // underneath them - gate on operation_assert_active, which unconditionally
  // refuses further work once ZEDBOT_OPERATION_INTERRUPTED is set. That is
  // precisely the condition this whole branch only runs under, so the real
  // calls always failed, silently, via the `|| true` meant only to make each
  // step best-effort - the fix compiled, the mocked test passed, and it
  // still did not work. This version runs the REAL functions against real
  // metadata fixtures so that gate is actually exercised.
  it("update_owned_cleanup actually persists failed-generation evidence on a signal-driven exit (real functions, not stubs)", () => {
    const setRollbackState = update.slice(update.indexOf("set_rollback_state() {"), update.indexOf("\non_update_error() {"));
    const body = update.slice(update.indexOf("update_owned_cleanup() {"), update.indexOf("\n# Finds the newest database backup"));
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-signal-cleanup-real-"));
    chmodSync(dir, 0o700);
    const write = (file: string, value: unknown) => {
      writeFileSync(file, JSON.stringify(value));
      chmodSync(file, 0o600);
    };
    const candidateGeneration = "20260101T000000Z-aaaaaaaaaaaa";
    const currentGeneration = "20251231T000000Z-bbbbbbbbbbbb";
    const candidatePath = path.join(dir, `candidate-${candidateGeneration}.json`);
    write(candidatePath, {
      // targetImageId/immutableImageTag/failedTargetTag are populated by
      // step 8 (candidate-image-built), well before recreation begins (step
      // 11) and APPLICATION_RECREATION_ATTEMPTED is set - a real candidate
      // reaching this cleanup always has them, and publish_failed_generation
      // copies them as-is into failed.json, whose own schema requires them.
      formatVersion: 2, lifecycleRole: "candidate", generation: candidateGeneration, sourceTree: "a".repeat(40),
      preDeploySha: "b".repeat(40), preDeployImageId: `sha256:${"1".repeat(64)}`, targetDeploySha: "c".repeat(40),
      targetImageId: `sha256:${"7".repeat(64)}`, retainedImageTag: `zedbot-app:rollback-${candidateGeneration}`,
      immutableImageTag: `zedbot-app:generation-${candidateGeneration}`, failedTargetTag: `zedbot-app:failed-${candidateGeneration}`,
      capturedAt: "2026-01-01T00:00:00Z",
      preDeployMigrations: [], declarationFormatVersion: 2, declarationSourceCategory: "generation-evidence",
      migrationEvidencePath: `${dir}/evidence-${candidateGeneration}`, composeEvidencePath: `${dir}/evidence-${candidateGeneration}/docker-compose.yml`,
      composeEvidenceSha256: "d".repeat(64), composeProjectName: "zedbot", composeApplicationImage: "zedbot-app:latest",
      compatibilityManifestSha256: "e".repeat(64), compatibilityDeclarations: [],
      recreationAttempted: true, healthConfirmed: false, state: "application-recreated",
    });
    const currentPath = path.join(dir, "current.json");
    write(currentPath, {
      formatVersion: 2, lifecycleRole: "current", generation: currentGeneration, sourceTree: "f".repeat(40),
      preDeploySha: "1".repeat(40), preDeployImageId: `sha256:${"2".repeat(64)}`, targetDeploySha: "3".repeat(40),
      targetImageId: `sha256:${"4".repeat(64)}`, retainedImageTag: `zedbot-app:rollback-${currentGeneration}`,
      immutableImageTag: `zedbot-app:generation-${currentGeneration}`, failedTargetTag: `zedbot-app:failed-${currentGeneration}`,
      capturedAt: "2025-12-31T00:00:00Z", preDeployMigrations: [], declarationFormatVersion: 2, declarationSourceCategory: "generation-evidence",
      migrationEvidencePath: `${dir}/evidence-${currentGeneration}`, composeEvidencePath: `${dir}/evidence-${currentGeneration}/docker-compose.yml`,
      composeEvidenceSha256: "5".repeat(64), composeProjectName: "zedbot", composeApplicationImage: "zedbot-app:latest",
      compatibilityManifestSha256: "6".repeat(64), compatibilityDeclarations: [],
      recreationAttempted: true, healthConfirmed: true, state: "known-good",
    });
    const failedPath = path.join(dir, "failed.json");

    const command = `. '${path.join(scripts, "lib/common.sh")}'; set_deployment_state_paths '${dir}'; acquire_deployment_lock; CANDIDATE_METADATA='${candidatePath}'; DEPLOYMENT_METADATA_ACTIVE=1; ZEDBOT_OPERATION_INTERRUPTED=1; APPLICATION_RECREATION_ATTEMPTED=1; DEPLOYMENT_REFERENCE_RESTORE_ID=''; SOURCE_SNAPSHOT=''; SOURCE_SHA=''; SOURCE_TREE=''; log_error(){ :; }; restore_deployment_reference(){ :; }; cleanup_source_snapshot(){ :; }; ${setRollbackState}\n${body}\nupdate_owned_cleanup`;
    const result = spawnSync("bash", ["-c", command], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(candidatePath, "utf8")).state).toBe("failed-after-recreation");
    expect(existsSync(failedPath)).toBe(true);
    expect(JSON.parse(readFileSync(failedPath, "utf8")).lifecycleRole).toBe("failed");
  });

  it("update_owned_cleanup never publishes failed-generation evidence on the ordinary ERR-trap path or without recreation", () => {
    const body = update.slice(update.indexOf("update_owned_cleanup() {"), update.indexOf("\n# Finds the newest database backup"));
    const trace = path.join(os.tmpdir(), `zedbot-signal-cleanup-trace-${process.pid}-${Date.now()}`);
    const harness = (interrupted: 0 | 1, recreationAttempted: 0 | 1) =>
      `ZEDBOT_OPERATION_INTERRUPTED=${interrupted}; APPLICATION_RECREATION_ATTEMPTED=${recreationAttempted}; DEPLOYMENT_REFERENCE_RESTORE_ID=''; CANDIDATE_METADATA='/candidate.json'; ZEDBOT_CURRENT_DEPLOYMENT_METADATA='/current.json'; log_error(){ :; }; restore_deployment_reference(){ :; }; cleanup_source_snapshot(){ :; }; set_rollback_state(){ echo "rollback-state:$1" >> '${trace}'; }; publish_failed_generation(){ echo "publish-failed:$1:$2" >> '${trace}'; }; ${body}\nupdate_owned_cleanup`;

    // Ordinary (non-signal) exit: on_update_error already covers this
    // itself before update_owned_cleanup ever runs - must NOT double-publish.
    spawnSync("bash", ["-c", harness(0, 1)], { encoding: "utf8" });
    expect(existsSync(trace)).toBe(false);

    // Interrupted, but recreation never attempted: nothing to fail-record.
    spawnSync("bash", ["-c", harness(1, 0)], { encoding: "utf8" });
    expect(existsSync(trace)).toBe(false);
  });

  // Regression: the interactive confirmation prompt used to run AFTER
  // retag_validated_previous_reference had already retagged zedbot-app:latest
  // to the previous image - a real, externally visible mutation. If the
  // operator answered "no" at that point, perform_rollback returned without
  // undoing the retag, contradicting its own "nothing was changed" message.
  // Confirmation must be the last gate before the first mutation.
  it("asks for rollback confirmation before the first infrastructure mutation", () => {
    const perform = rollback.slice(rollback.indexOf("perform_rollback() {"), rollback.indexOf("\nmain() {"));
    const confirmIndex = perform.indexOf('confirm "Restore application version');
    expect(confirmIndex).toBeGreaterThan(-1);
    // Anchored from confirmIndex onward: the compatibility-retry guard's own
    // explanatory comment, above, mentions retag_validated_previous_reference
    // in prose earlier in the file.
    expect(confirmIndex).toBeLessThan(perform.indexOf("retag_validated_previous_reference", confirmIndex));
    expect(confirmIndex).toBeLessThan(perform.indexOf("execute_validated_rollback_transition"));
    expect(perform.indexOf("Rollback cancelled; nothing was changed")).toBeLessThan(perform.indexOf("retag_validated_previous_reference", confirmIndex));
  });

  // Regression: operation-state.json has already advanced to
  // compatibility-confirmed by the time confirmation is asked, but the
  // strictly read-only `zedbot rollback-status` treats ANY operation-state
  // marker as an incomplete operation regardless of stage - answering "no"
  // here used to leave rollback-status reporting a blocked deployment until
  // another, mutating rollback attempt happened to clear it. The marker
  // must be cleared on cancellation, but only when it is identity-checked
  // to belong to THIS exact rollback attempt (kind rollback, matching
  // generation) - never an unrelated marker.
  it("clears the operation-state marker on cancellation when it belongs to this rollback attempt, but leaves an unrelated one alone", () => {
    const perform = rollback.slice(rollback.indexOf("perform_rollback() {"), rollback.indexOf("\nmain() {"));
    const guardStart = perform.indexOf('if [ "$assume_yes" -ne 1 ]');
    expect(guardStart).toBeGreaterThan(-1);
    const guardEnd = perform.indexOf("\n\n  # Armed before the retag below", guardStart);
    expect(guardEnd).toBeGreaterThan(guardStart);
    const guard = perform.slice(guardStart, guardEnd);
    expect(guard).toContain("remove_canonical_state_file");

    const thisGeneration = "20260101T000000Z-aaaaaaaaaaaa";
    function run(operationState: Record<string, unknown> | null) {
      const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-rollback-cancel-"));
      chmodSync(dir, 0o700);
      const rollbackMetadata = path.join(dir, "previous.json");
      writeFileSync(rollbackMetadata, JSON.stringify({ generation: thisGeneration }));
      const operationStatePath = path.join(dir, "operation-state.json");
      if (operationState) {
        writeFileSync(operationStatePath, JSON.stringify(operationState));
        chmodSync(operationStatePath, 0o600);
      }
      const command = `. '${path.join(scripts, "lib/common.sh")}'; set_deployment_state_paths '${dir}'; ZEDBOT_ROLLBACK_METADATA='${rollbackMetadata}'; acquire_deployment_lock; metadata_field(){ jq -er "$1" "$ZEDBOT_ROLLBACK_METADATA"; }; assume_yes=0; pre='${"a".repeat(40)}'; confirm(){ return 1; }; run_guard(){ ${guard}\n}; run_guard`;
      const result = spawnSync("bash", ["-c", command], { encoding: "utf8" });
      return { result, exists: existsSync(operationStatePath) };
    }

    const matching = run({ formatVersion: 1, kind: "rollback", generation: thisGeneration, stage: "compatibility-confirmed" });
    expect(matching.result.status, matching.result.stderr).toBe(1);
    expect(matching.exists).toBe(false);

    const foreignGeneration = run({ formatVersion: 1, kind: "rollback", generation: "20260102T000000Z-bbbbbbbbbbbb", stage: "compatibility-confirmed" });
    expect(foreignGeneration.exists).toBe(true);

    const foreignKind = run({ formatVersion: 1, kind: "update", generation: thisGeneration, stage: "compatibility-confirmed" });
    expect(foreignKind.exists).toBe(true);

    const none = run(null);
    expect(none.result.status).toBe(1);
  });

  // Regression: validate_compatibility deliberately runs the CURRENT (about-
  // to-be-rolled-back-from) worker's rollback-compatibility CLI, because only
  // that image's manifest knows about the newest migration's own backward-
  // compatibility declaration. configure_rollback_compose_contract rebinds
  // run_compose to the PREVIOUS generation's docker-compose.yml - if that
  // switch happened first, the compatibility check would run under the
  // wrong generation's command/environment/mounts even though it still used
  // the current image, and could be wrongly rejected or inspect the wrong
  // runtime inputs.
  it("checks compatibility under the current generation's Compose contract, before switching to the previous one", () => {
    const perform = rollback.slice(rollback.indexOf("perform_rollback() {"), rollback.indexOf("\nmain() {"));
    const compatibilityIndex = perform.indexOf("validate_compatibility");
    const contractSwitchIndex = perform.indexOf("configure_rollback_compose_contract");
    expect(compatibilityIndex).toBeGreaterThan(-1);
    expect(contractSwitchIndex).toBeGreaterThan(-1);
    expect(compatibilityIndex).toBeLessThan(contractSwitchIndex);
  });

  // Regression: retag_validated_previous_reference (further down) retags
  // zedbot-app:latest to the PREVIOUS image once compatibility-confirmed is
  // reached. The worker service always runs image zedbot-app:latest (per
  // docker-compose.yml), so a RETRY of a rollback attempt that already
  // passed this stage - e.g. one that failed later, during application
  // recreation - would run validate_compatibility against the PREVIOUS
  // image's CLI and manifest instead of current's, and reject every retry
  // even though compatibility was already genuinely proven the first time.
  it("skips re-running the compatibility probe on a retry that already confirmed it, but not on a fresh attempt", () => {
    const perform = rollback.slice(rollback.indexOf("perform_rollback() {"), rollback.indexOf("\nmain() {"));
    const guardStart = perform.indexOf('if [ "$(operation_stage_number rollback');
    expect(guardStart).toBeGreaterThan(-1);
    const guardEnd = perform.indexOf("\n  confirm_operation_state retained-image-validated compatibility-confirmed", guardStart);
    expect(guardEnd).toBeGreaterThan(guardStart);
    const guard = perform.slice(guardStart, guardEnd);
    expect(guard).toContain("bind_current_generation_compose_contract");
    expect(guard).toContain("validate_compatibility");

    function run(stage: string) {
      const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-rollback-compat-retry-"));
      chmodSync(dir, 0o700);
      const generation = "20260101T000000Z-aaaaaaaaaaaa";
      const operationStatePath = path.join(dir, "operation-state.json");
      writeFileSync(operationStatePath, JSON.stringify({ formatVersion: 1, kind: "rollback", generation, stage }));
      chmodSync(operationStatePath, 0o600);
      const trace = path.join(dir, "trace");
      const command = `. '${path.join(scripts, "lib/common.sh")}'; set_deployment_state_paths '${dir}'; bind_current_generation_compose_contract(){ echo bind >> '${trace}'; }; validate_compatibility(){ echo validate >> '${trace}'; }; confirm_operation_state(){ :; }; ${guard}\nconfirm_operation_state retained-image-validated compatibility-confirmed`;
      spawnSync("bash", ["-c", command], { encoding: "utf8" });
      return existsSync(trace) ? readFileSync(trace, "utf8") : "";
    }

    // Fresh attempt, not yet at compatibility-confirmed: must run the probe.
    expect(run("retained-image-validated")).toContain("validate");
    // Already at compatibility-confirmed (retag has not necessarily happened
    // yet, but compatibility was already proven): must skip.
    expect(run("compatibility-confirmed")).toBe("");
    // Past it - the exact retry scenario the review describes (retag/
    // recreation already started, then failed): must skip.
    expect(run("deployment-reference-retagged")).toBe("");
  });

  // Regression: an interruption or state-write failure after
  // retag_validated_previous_reference retags zedbot-app:latest to the
  // previous image, but before recreate_application_services actually runs,
  // used to leave that mismatch in place forever - a later `zedbot restart`
  // would force-recreate straight from the tag, deploying the previous
  // application without ever completing rollback readiness or metadata
  // promotion. Mirrors update.sh's own DEPLOYMENT_REFERENCE_RESTORE_ID gate.
  it("rollback.sh arms the restore before the retag and disarms once recreation starts", () => {
    const perform = rollback.slice(rollback.indexOf("perform_rollback() {"), rollback.indexOf("\nmain() {"));
    const restoreArm = perform.indexOf('DEPLOYMENT_REFERENCE_RESTORE_ID="$target_running_id"');
    // Anchored from restoreArm onward: the compatibility-retry guard's own
    // explanatory comment, above, mentions retag_validated_previous_reference
    // in prose earlier in the file.
    const retagCall = perform.indexOf("retag_validated_previous_reference", restoreArm);
    expect(restoreArm).toBeGreaterThan(-1);
    expect(retagCall).toBeGreaterThan(-1);
    expect(restoreArm).toBeLessThan(retagCall);
    const disarm = perform.indexOf('DEPLOYMENT_REFERENCE_RESTORE_ID=""', retagCall);
    const recreateCall = perform.indexOf("execute_validated_rollback_transition", retagCall);
    expect(disarm).toBeGreaterThan(retagCall);
    expect(disarm).toBeLessThan(recreateCall);
    expect(rollback).toContain("restore_deployment_reference");
    expect(rollback).toContain("install_operation_traps rollback_owned_cleanup");
  });

  it("rollback_owned_cleanup restores the reference only when recreation was never attempted", () => {
    const body = rollback.slice(rollback.indexOf("rollback_owned_cleanup() {"), rollback.indexOf("\nmetadata_field()"));
    const trace = path.join(os.tmpdir(), `zedbot-rollback-cleanup-trace-${process.pid}-${Date.now()}`);
    const harness = (recreationAttempted: 0 | 1, restoreId: string) => `APPLICATION_RECREATION_ATTEMPTED=${recreationAttempted}; DEPLOYMENT_REFERENCE_RESTORE_ID='${restoreId}'; log_error(){ :; }; restore_deployment_reference(){ echo "restore:$1" >> '${trace}'; return 0; }; ${body}\nrollback_owned_cleanup`;
    spawnSync("bash", ["-c", harness(0, `sha256:${"6".repeat(64)}`)], { encoding: "utf8" });
    expect(readFileSync(trace, "utf8")).toContain(`restore:sha256:${"6".repeat(64)}`);
    rmSync(trace, { force: true });
    spawnSync("bash", ["-c", harness(1, `sha256:${"6".repeat(64)}`)], { encoding: "utf8" });
    expect(existsSync(trace)).toBe(false);
    rmSync(trace, { force: true });
    // Also a no-op when nothing is armed (every service was already on the
    // previous image before this attempt started).
    spawnSync("bash", ["-c", harness(0, "")], { encoding: "utf8" });
    expect(existsSync(trace)).toBe(false);
  });

  // Regression (P1, PR #155 review of rollback.sh:215 - "Permit rollback
  // when an application container is stopped"): a failed update can leave a
  // service stopped (Compose removed the old container and the candidate
  // exited, or creation was interrupted) or entirely absent. `ps` (no
  // --all) omits stopped/exited containers, so the loop's own unconditional
  // nonempty check used to reject the rollback before it could recreate
  // anything - even though the container's real identity (once actually
  // inspected via --all) was perfectly legitimate. --all is required to see
  // it, matching record_bot_recreation_boundary_core's own `ps --all -q
  // bot` (lib/common.sh). A missing service carries no image at all, so it
  // cannot be the unknown third image this loop actually guards against;
  // only an available container whose identity is unrecognized is rejected.
  it("permits rollback when an application container is stopped (visible only via --all) or entirely absent, but still rejects an unrecognized or inconsistent image", () => {
    const start = rollback.indexOf("for service in api bot worker; do");
    const end = rollback.indexOf("\n  # Confirmation happens here", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const loop = rollback.slice(start, end);
    expect(loop).toContain("run_compose ps --all -q");

    const target = "a".repeat(40);
    const pre = "b".repeat(40);
    const targetImageId = `sha256:${"1".repeat(64)}`;
    const preImageId = `sha256:${"2".repeat(64)}`;

    function run(stubs: string) {
      // metadata_field reads previous.json - its own ".targetImageId" field
      // records what image THAT generation was deployed as, i.e. the "pre"
      // image id from the current rollback's point of view.
      const command = `. '${path.join(scripts, "lib/common.sh")}'; target='${target}'; pre='${pre}'; target_running_id=""; metadata_field(){ printf '%s' '${preImageId}'; }; ${stubs} run_loop(){ local service cid image_id image_sha\n${loop}\n}\nrun_loop && printf 'LOOP_OK:%s\\n' "$target_running_id"`;
      return spawnSync("bash", ["-c", command], { encoding: "utf8" });
    }

    // Stubs only answer the exact `ps --all -q <service>` form the fixed
    // loop must call - a pre-fix `ps -q <service>` (no --all) would match
    // no case here and get empty output for every service.
    const stubs = `
      run_compose(){ case "$*" in
        "ps --all -q api") printf '%s\\n' cid-api-stopped ;;
        "ps --all -q bot") : ;;
        "ps --all -q worker") printf '%s\\n' cid-worker-running ;;
      esac; }
      run_clean_docker(){ case "$3:$4" in
        '{{.Image}}:cid-api-stopped') printf '%s' '${targetImageId}' ;;
        '{{.Image}}:cid-worker-running') printf '%s' '${preImageId}' ;;
        *':cid-api-stopped') printf 'GIT_SHA=%s\\n' '${target}' ;;
        *':cid-worker-running') printf 'GIT_SHA=%s\\n' '${pre}' ;;
      esac; }
    `;
    const ok = run(stubs);
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout.trim()).toBe(`LOOP_OK:${targetImageId}`);

    // Still rejects a container whose available identity is unrecognized.
    const unknownStubs = `
      run_compose(){ case "$*" in "ps --all -q api") printf '%s\\n' cid-api ;; *) : ;; esac; }
      run_clean_docker(){ case "$3" in '{{.Image}}') printf '%s' '${targetImageId}' ;; *) printf 'GIT_SHA=%s\\n' '${"c".repeat(40)}' ;; esac; }
    `;
    const unknown = run(unknownStubs);
    expect(unknown.status).not.toBe(0);
    expect(unknown.stderr).toContain("api carries an unknown application SHA");

    // Still rejects two target-image containers that disagree on image id.
    const inconsistentStubs = `
      run_compose(){ case "$*" in
        "ps --all -q api") printf '%s\\n' cid-api ;;
        "ps --all -q bot") printf '%s\\n' cid-bot ;;
        "ps --all -q worker") : ;;
      esac; }
      run_clean_docker(){ case "$3:$4" in
        '{{.Image}}:cid-api') printf '%s' '${targetImageId}' ;;
        '{{.Image}}:cid-bot') printf '%s' '${preImageId}' ;;
        *':cid-api') printf 'GIT_SHA=%s\\n' '${target}' ;;
        *':cid-bot') printf 'GIT_SHA=%s\\n' '${target}' ;;
      esac; }
    `;
    const inconsistent = run(inconsistentStubs);
    expect(inconsistent.status).not.toBe(0);
    expect(inconsistent.stderr).toContain("Target containers use inconsistent images");
  });

  // Regression (P1): "Roll back to the failed update's retained target" -
  // when an update fails AFTER application recreation begins, current.json
  // is never touched (it still names the exact generation that was running
  // right before the failed candidate started recreating), so
  // select_rollback_generation (lib/common.sh) redirects the rollback
  // target to current.json's own generation instead of previous.json's -
  // "pre" and "target" above both become that SAME generation's own sha.
  // A service may still legitimately be running the FAILED candidate's own
  // image at that point (exactly the state this recovery exists to clear),
  // but the loop above used to reject that SHA outright as unrecognized -
  // it must instead accept it as a KNOWN state, identity-checked against
  // failed.json's own recorded targetDeploySha/targetImageId specifically,
  // not any unrecognized third image.
  it("also permits a container still running the recorded failed candidate's own image during failed-generation recovery", () => {
    const start = rollback.indexOf("for service in api bot worker; do");
    const end = rollback.indexOf("\n  # Confirmation happens here", start);
    const loop = rollback.slice(start, end);
    expect(loop).toContain("failed_sha");

    // Recovery mode: "pre" and "target" are the same (current's own) sha -
    // select_rollback_generation synthesizes previous.json from current.json
    // itself in this case, so metadata_field('.targetImageId') also reports
    // current's own image id.
    const target = "a".repeat(40);
    const pre = target;
    const targetImageId = `sha256:${"1".repeat(64)}`;
    const failedSha = "f".repeat(40);
    const failedImageId = `sha256:${"3".repeat(64)}`;

    function run(recoveryFlag: string, stubs: string) {
      const command = `. '${path.join(scripts, "lib/common.sh")}'; target='${target}'; pre='${pre}'; target_running_id=""; recovering_failed_generation=${recoveryFlag}; failed_sha=''; failed_image_id=''; metadata_field(){ printf '%s' '${targetImageId}'; }; ${stubs} run_loop(){ local service cid image_id image_sha\n${loop}\n}\nrun_loop && printf 'LOOP_OK:%s\\n' "$target_running_id"`;
      return spawnSync("bash", ["-c", command], { encoding: "utf8" });
    }

    const stubs = `
      run_compose(){ case "$*" in
        "ps --all -q api") printf '%s\\n' cid-api-failed ;;
        "ps --all -q bot") printf '%s\\n' cid-bot-target ;;
        "ps --all -q worker") : ;;
      esac; }
      run_clean_docker(){ case "$3:$4" in
        '{{.Image}}:cid-api-failed') printf '%s' '${failedImageId}' ;;
        '{{.Image}}:cid-bot-target') printf '%s' '${targetImageId}' ;;
        *':cid-api-failed') printf 'GIT_SHA=%s\\n' '${failedSha}' ;;
        *':cid-bot-target') printf 'GIT_SHA=%s\\n' '${target}' ;;
      esac; }
    `;

    // recovering_failed_generation=0: the loop must behave exactly as
    // before and reject the failed candidate's SHA as unrecognized, even
    // though it happens to be running.
    const notRecovering = run("0", stubs);
    expect(notRecovering.status).not.toBe(0);
    expect(notRecovering.stderr).toContain("api carries an unknown application SHA");

    // recovering_failed_generation=1 with the failed candidate's identity
    // populated (as perform_rollback itself populates it from failed.json):
    // must be accepted.
    const recoveringStubs = `failed_sha='${failedSha}'; failed_image_id='${failedImageId}'; ${stubs}`;
    const recovering = run("1", recoveringStubs);
    expect(recovering.status, recovering.stderr).toBe(0);
    expect(recovering.stdout.trim()).toBe(`LOOP_OK:${targetImageId}`);

    // Still rejects a container whose image id disagrees with the recorded
    // failed candidate's own targetImageId, even though its SHA matches.
    const mismatchedStubs = `failed_sha='${failedSha}'; failed_image_id='sha256:${"9".repeat(64)}'; ${stubs}`;
    const mismatched = run("1", mismatchedStubs);
    expect(mismatched.status).not.toBe(0);
    expect(mismatched.stderr).toContain("api carries an unknown application SHA");
  });

  it("metadata writes atomically at mode 600 without secret-shaped fields", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-metadata-test-"));
    const source = path.join(dir, "source.json"); const output = path.join(dir, "previous.json");
    writeFileSync(source, '{"formatVersion":1,"preDeploySha":"' + "a".repeat(40) + '"}\n');
    execFileSync("bash", ["-c", `. '${path.join(scripts, "lib/common.sh")}'; set_deployment_state_paths '${dir}'; acquire_deployment_lock; atomic_write_metadata '${source}'`], {
      env: process.env,
    });
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(readFileSync(output, "utf8")).not.toMatch(/TOKEN|PASSWORD|DATABASE_URL|REDIS_URL/);
  });

  it("shared deployment lock fails immediately under contention", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-lock-test-"));
    const holder = spawnSync("bash", ["-c", `exec 8>'${dir}/deployment.lock'; chmod 600 '${dir}/deployment.lock'; flock 8; bash -c ". '${path.join(scripts, "lib/common.sh")}'; set_deployment_state_paths '${dir}'; acquire_deployment_lock"`], {
      encoding: "utf8", env: process.env,
    });
    expect(holder.status).not.toBe(0);
    expect(holder.stderr).toContain("already running");
  });

  // Regression: migrate.sh is documented as runnable standalone (see its
  // own header comment), not just as install.sh/update.sh's internal
  // migration step, but main() never acquired the deployment lock unless
  // the legacy_install_detected branch happened to run. A standalone
  // `bash scripts/migrate.sh` overlapping an in-progress update or
  // rollback (which holds this same lock throughout) could apply new
  // migrations after that operation already captured its pre-deploy
  // migration baseline or compatibility snapshot, invalidating a decision
  // it already made before application recreation. The lock is now held
  // for the whole script; legacy_self_heal must not acquire it a second
  // time (acquire_deployment_lock hard-fails when already held by this
  // same process).
  it("migrate.sh main() acquires the deployment lock before the preflight/migration sequence", () => {
    const mainStart = migrate.indexOf("main() {");
    const lockIndex = migrate.indexOf("acquire_deployment_lock", mainStart);
    const preflightIndex = migrate.indexOf("referral-migration-preflight.js", mainStart);
    expect(lockIndex).toBeGreaterThan(mainStart);
    expect(preflightIndex).toBeGreaterThan(lockIndex);
  });

  // Regression: recover_first_install_promotion/recover_legacy_upgrade_
  // promotion were wired into bootstrap-deployment.sh and rollback.sh, but
  // not into update.sh's or migrate.sh's own classify_installation-gated
  // paths - a stuck bootstrap identity of either kind would keep rejecting
  // `zedbot update` and standalone `bash scripts/migrate.sh` forever, even
  // though rollback could already recover it. Both recoveries are cheap,
  // identity-checked no-ops in every other case, so both scripts call both
  // unconditionally, after the deployment lock and before anything that
  // depends on installation classification.
  it("update.sh main() recovers a stuck bootstrap promotion of either kind before classifying the installation", () => {
    const mainStart = update.indexOf("main() {");
    const lockIndex = update.indexOf("acquire_deployment_lock", mainStart);
    const firstInstallIndex = update.indexOf("recover_first_install_promotion", mainStart);
    const legacyIndex = update.indexOf("recover_legacy_upgrade_promotion", mainStart);
    const classifyIndex = update.indexOf("classify_installation observe", mainStart);
    expect(lockIndex).toBeGreaterThan(mainStart);
    expect(firstInstallIndex).toBeGreaterThan(lockIndex);
    expect(legacyIndex).toBeGreaterThan(firstInstallIndex);
    expect(classifyIndex).toBeGreaterThan(legacyIndex);
  });

  it("migrate.sh main() recovers a stuck bootstrap promotion of either kind after acquiring the lock, before any migration work", () => {
    const mainStart = migrate.indexOf("main() {");
    const lockIndex = migrate.indexOf("acquire_deployment_lock", mainStart);
    const firstInstallIndex = migrate.indexOf("recover_first_install_promotion", mainStart);
    const legacyIndex = migrate.indexOf("recover_legacy_upgrade_promotion", mainStart);
    const preflightIndex = migrate.indexOf("referral-migration-preflight.js", mainStart);
    expect(lockIndex).toBeGreaterThan(mainStart);
    expect(firstInstallIndex).toBeGreaterThan(lockIndex);
    expect(legacyIndex).toBeGreaterThan(firstInstallIndex);
    expect(preflightIndex).toBeGreaterThan(legacyIndex);
  });

  it("legacy_self_heal no longer acquires the lock a second time", () => {
    const body = migrate.slice(migrate.indexOf("legacy_self_heal() {"), migrate.indexOf("\nmain() {"));
    expect(body).not.toMatch(/\n\s*acquire_deployment_lock\n/);
    // Still re-derives deployment-state paths after migrate_legacy_env.
    expect(body).toContain("reset_deployment_state_fixed_identity");
  });

  // Regression (P1, PR #155 review of migrate.sh:94 - "Keep legacy
  // conversion retryable until metadata is published"): legacy_self_heal's
  // own early steps (migrate_legacy_env, refresh_cli) fix the exact env/CLI
  // staleness legacy_install_detected checks. An interruption AFTER those
  // steps but BEFORE publish_validated_legacy_self_heal durably publishes
  // current.json used to make a rerun's legacy_install_detected return
  // false, silently skipping the whole function - even though
  // legacy-install-v1.json was still unconverted and no current.json
  // existed. legacy_self_heal must keep running while that evidence shape
  // (legacy record present, no current.json yet) persists, independent of
  // env/CLI staleness.
  it("legacy_self_heal keeps retrying an unconverted legacy record even after env/CLI staleness is already fixed", () => {
    const body = migrate.slice(migrate.indexOf("legacy_self_heal() {"), migrate.indexOf("\nmain() {"));
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-legacy-selfheal-retry-"));
    const trace = path.join(dir, "trace");
    writeFileSync(path.join(dir, "legacy-install-v1.json"), "{}");
    const command = `. '${path.join(scripts, "lib/common.sh")}'; set_deployment_state_paths '${dir}'; legacy_install_detected(){ return 1; }; migrate_legacy_env(){ :; }; ensure_backup_dir_permissions(){ :; }; refresh_cli(){ :; }; repo_head_sha(){ :; }; run_compose_with_deployment_sha(){ :; }; run_compose(){ :; }; reset_deployment_state_fixed_identity(){ set_deployment_state_paths '${dir}'; }; prepare_exact_origin_main(){ echo 'sha tree snapshot'; }; register_source_snapshot(){ :; }; publish_validated_legacy_self_heal(){ echo publish-called >> '${trace}'; }; record_deployed_sha(){ :; }; cleanup_source_snapshot(){ :; }; release_deployment_lock(){ :; }; ${body}\nlegacy_self_heal`;
    const result = spawnSync("bash", ["-c", command], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(trace)).toBe(true);
    expect(readFileSync(trace, "utf8")).toContain("publish-called");
  });

  it("legacy_self_heal is still a true no-op once conversion has actually published current.json", () => {
    const body = migrate.slice(migrate.indexOf("legacy_self_heal() {"), migrate.indexOf("\nmain() {"));
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-legacy-selfheal-done-"));
    const trace = path.join(dir, "trace");
    writeFileSync(path.join(dir, "legacy-install-v1.json"), "{}");
    writeFileSync(path.join(dir, "current.json"), "{}");
    const command = `. '${path.join(scripts, "lib/common.sh")}'; set_deployment_state_paths '${dir}'; legacy_install_detected(){ return 1; }; publish_validated_legacy_self_heal(){ echo publish-called >> '${trace}'; }; ${body}\nlegacy_self_heal`;
    const result = spawnSync("bash", ["-c", command], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(trace)).toBe(false);
  });

  it("a standalone migrate.sh run fails closed while an update/rollback already holds the lock", () => {
    const mainOpen = migrate.indexOf("main() {") + "main() {".length;
    const preamble = migrate.slice(mainOpen, migrate.indexOf("acquire_deployment_lock") + "acquire_deployment_lock".length);
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-migrate-lock-"));
    const holder = spawnSync(
      "bash",
      [
        "-c",
        `exec 8>'${dir}/deployment.lock'; chmod 600 '${dir}/deployment.lock'; flock 8; bash -c ". '${path.join(scripts, "lib/common.sh")}'; set_deployment_state_paths '${dir}'; require_root(){ :; }; reset_deployment_state_fixed_identity(){ :; }; app_cd(){ :; }; load_env_if_exists(){ :; }; reset_compose_fixed_identity(){ :; }; detect_compose_command(){ :; }; ${preamble}"`,
      ],
      { encoding: "utf8", env: process.env },
    );
    expect(holder.status).not.toBe(0);
    expect(holder.stderr).toContain("already running");
  });

  it("documents rate-limit defaults and recreation semantics", () => {
    const env = readFileSync(path.join(root, ".env.example"), "utf8");
    const docs = readFileSync(path.join(root, "docs/telegram-miniapp-foundation.md"), "utf8");
    expect(env).toContain("MINIAPP_COMMERCE_RATE_LIMIT=30");
    expect(env).toContain("1..10000");
    expect(env).toContain("default 90");
    expect(docs).toContain("no image rebuild is required");
  });
});
