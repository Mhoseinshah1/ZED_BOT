import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scripts = path.join(root, "scripts");
const migration = (n: number) => `20260808${String(n).padStart(6, "0")}_migration_${n}`;
const healthy = (shipped: string[], applied: string[], pending: string[] = []): MigrationSnapshot => ({
  shipped, applied, pending, failed: [], databaseOnly: [], incomplete: [],
});
const manifest = (names: string[]) => ({ formatVersion: 2 as const, backwardCompatibleMigrations: names.map((name) => ({ name, sqlSha256: "a".repeat(64) })) });

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
});

describe("deployment shell safety", () => {
  const update = readFileSync(path.join(scripts, "update.sh"), "utf8");
  const rollback = readFileSync(path.join(scripts, "rollback.sh"), "utf8");
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

  it("documents rate-limit defaults and recreation semantics", () => {
    const env = readFileSync(path.join(root, ".env.example"), "utf8");
    const docs = readFileSync(path.join(root, "docs/telegram-miniapp-foundation.md"), "utf8");
    expect(env).toContain("MINIAPP_COMMERCE_RATE_LIMIT=30");
    expect(env).toContain("1..10000");
    expect(env).toContain("default 90");
    expect(docs).toContain("no image rebuild is required");
  });
});
