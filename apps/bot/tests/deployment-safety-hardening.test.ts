import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
const manifest = (names: string[]) => ({ formatVersion: 1 as const, backwardCompatibleMigrations: names });

describe("typed rollback migration compatibility", () => {
  it("permits a deployment with no new migration", () => {
    const base = [migration(1)];
    expect(evaluateUpdateCompatibility(base, healthy(base, base), manifest([]))).toMatchObject({ ok: true, newlyPending: [] });
  });

  it("permits only explicitly compatible new migrations", () => {
    const base = [migration(1)]; const added = migration(2);
    expect(evaluateUpdateCompatibility(base, healthy([...base, added], base, [added]), manifest([added])).ok).toBe(true);
    expect(evaluateUpdateCompatibility(base, healthy([...base, added], base, [added]), manifest([]))).toMatchObject({ ok: false, unsafe: [added] });
  });

  it("blocks failed, incomplete and database-only state", () => {
    const base = [migration(1)];
    for (const key of ["failed", "incomplete", "databaseOnly"] as const) {
      const snapshot = healthy(base, base); snapshot[key] = [migration(2)];
      expect(evaluateUpdateCompatibility(base, snapshot, manifest([])).ok).toBe(false);
    }
  });

  it("rechecks applied post-baseline migrations for rollback", () => {
    const base = [migration(1)]; const added = migration(2);
    expect(evaluateRollbackCompatibility(base, healthy([...base, added], [...base, added]), manifest([added])).ok).toBe(true);
    expect(evaluateRollbackCompatibility(base, healthy([...base, added], [...base, added]), manifest([])).ok).toBe(false);
  });

  it("rejects malformed manifests", () => {
    expect(parseRollbackCompatibilityManifest({ formatVersion: 1, backwardCompatibleMigrations: ["bad"] })).toBeNull();
    expect(parseRollbackCompatibilityManifest({ formatVersion: 2, backwardCompatibleMigrations: [] })).toBeNull();
  });
});

describe("deployment shell safety", () => {
  const update = readFileSync(path.join(scripts, "update.sh"), "utf8");
  const rollback = readFileSync(path.join(scripts, "rollback.sh"), "utf8");

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  }

  function repositoryPair() {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-git-safety-"));
    const origin = path.join(dir, "origin.git"); const seed = path.join(dir, "seed"); const app = path.join(dir, "app");
    git(dir, "init", "--bare", origin); git(dir, "init", "-b", "main", seed);
    git(seed, "config", "user.email", "test@example.invalid"); git(seed, "config", "user.name", "test");
    writeFileSync(path.join(seed, "version"), "one\n"); git(seed, "add", "version"); git(seed, "commit", "-m", "one");
    git(seed, "remote", "add", "origin", origin); git(seed, "push", "-u", "origin", "main");
    git(dir, "clone", "-b", "main", origin, app); git(app, "config", "user.email", "test@example.invalid"); git(app, "config", "user.name", "test");
    return { dir, origin, seed, app };
  }

  function prepare(app: string, extraEnv: Record<string, string> = {}) {
    return spawnSync("bash", ["-c", `. '${path.join(scripts, "lib/common.sh")}'; prepare_exact_origin_main`], {
      encoding: "utf8", env: { ...process.env, ZEDBOT_APP_DIR: app, ...extraEnv },
    });
  }

  it("has fail-closed source preparation before build/migrate/recreate and two SHA rechecks", () => {
    expect(update).toContain('target_deploy_sha="$(prepare_exact_origin_main)"');
    expect(update.indexOf("prepare_exact_origin_main")).toBeLessThan(update.indexOf("run_compose build"));
    expect(update.indexOf("run_compose build")).toBeLessThan(update.indexOf('bash "${SCRIPT_DIR}/migrate.sh"'));
    expect(update.match(/repo_head_sha\)" = "\$target_deploy_sha"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(update).not.toContain("Continuing with the current code");
  });

  it("fails when fetch fails", () => {
    const pair = repositoryPair(); git(pair.app, "remote", "set-url", "origin", path.join(pair.dir, "missing.git"));
    expect(prepare(pair.app).status).not.toBe(0);
  });

  it("fails on a non-fast-forward target", () => {
    const pair = repositoryPair();
    writeFileSync(path.join(pair.seed, "version"), "remote\n"); git(pair.seed, "commit", "-am", "remote"); git(pair.seed, "push");
    writeFileSync(path.join(pair.app, "local"), "local\n"); git(pair.app, "add", "local"); git(pair.app, "commit", "-m", "local");
    expect(prepare(pair.app).status).not.toBe(0);
  });

  it("fails when final HEAD verification disagrees with fetched SHA", () => {
    const pair = repositoryPair(); const shim = path.join(pair.dir, "bin"); mkdirSync(shim);
    const realGit = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    writeFileSync(path.join(shim, "git"), `#!/usr/bin/env bash\nif [[ "$*" == *"rev-parse HEAD"* ]]; then printf '%040d\\n' 0; exit 0; fi\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    expect(prepare(pair.app, { PATH: `${shim}:${process.env.PATH}` }).status).not.toBe(0);
  });

  it("keeps preDeploy and target identities distinct", () => {
    expect(update).toContain("preDeploySha:$preDeploySha");
    expect(update).toContain("preDeployImageId:$preDeployImageId");
    expect(update).toContain("targetDeploySha:$targetDeploySha");
    expect(update.indexOf("validate_running_application")).toBeLessThan(update.indexOf("prepare_exact_origin_main"));
    expect(update).toContain("cannot be retained as known-good");
  });

  it("rollback targets only application services with mandatory isolation flags", () => {
    expect(rollback).toContain("up -d --no-deps --no-build --force-recreate api bot worker");
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
    execFileSync("bash", ["-c", `. '${path.join(scripts, "lib/common.sh")}'; atomic_write_metadata '${source}'`], {
      env: { ...process.env, ZEDBOT_BASE_DIR: dir, ZEDBOT_DEPLOYMENT_DIR: dir, ZEDBOT_ROLLBACK_METADATA: output },
    });
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(readFileSync(output, "utf8")).not.toMatch(/TOKEN|PASSWORD|DATABASE_URL|REDIS_URL/);
  });

  it("shared deployment lock fails immediately under contention", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-lock-test-"));
    const holder = spawnSync("bash", ["-c", `exec 8>'${dir}/lock'; flock 8; bash -c ". '${path.join(scripts, "lib/common.sh")}'; acquire_deployment_lock"`], {
      encoding: "utf8", env: { ...process.env, ZEDBOT_BASE_DIR: dir, ZEDBOT_DEPLOYMENT_DIR: dir, ZEDBOT_DEPLOYMENT_LOCK: `${dir}/lock` },
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
