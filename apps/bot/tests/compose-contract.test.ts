import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const common = path.join(root, "scripts/lib/common.sh");

const validRendered = {
  name: "zedbot",
  services: {
    postgres: { image: "postgres:16-alpine" },
    redis: { image: "redis:7-alpine" },
    api: { image: "zedbot-app:latest" },
    bot: { image: "zedbot-app:latest" },
    worker: { image: "zedbot-app:latest" },
    unrelated: { image: "example.invalid/unrelated:1" },
  },
};

function composeFixture(rendered: unknown = validRendered) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zedbot-compose-contract-"));
  const project = path.join(dir, "app"); const bin = path.join(dir, "bin");
  const compose = path.join(project, "docker-compose.yml"); const envFile = path.join(project, ".env");
  const argv = path.join(dir, "argv"); const childEnv = path.join(dir, "child-env");
  mkdirSync(project); mkdirSync(bin);
  writeFileSync(compose, "name: zedbot\nservices: {}\n");
  writeFileSync(envFile, "POSTGRES_PASSWORD=synthetic\nREDIS_PASSWORD=synthetic\n"); chmodSync(envFile, 0o600);
  const json = typeof rendered === "string" ? rendered : JSON.stringify(rendered);
  writeFileSync(path.join(bin, "docker"), `#!/usr/bin/env bash
if [[ " $* " == *" compose version "* ]]; then exit 0; fi
if [[ " $* " == *" config --format json "* ]]; then printf '%s\\n' '${json.replaceAll("'", "'\\''")}'; exit 0; fi
printf '%s\\n' "$@" > '${argv}'
env | LC_ALL=C sort > '${childEnv}'
`, { mode: 0o755 });
  return { dir, project, compose, envFile, bin, argv, childEnv };
}

function shell(fixture: ReturnType<typeof composeFixture>, body: string, hostile: Record<string, string> = {}) {
  const setup = `. '${common}'; _ZEDBOT_FIXED_PROJECT_DIR='${fixture.project}'; _ZEDBOT_FIXED_RUNTIME_ENV_FILE='${fixture.envFile}'; _ZEDBOT_FIXED_DOCKER_PATH='${fixture.bin}:${process.env.PATH}'; ZEDBOT_CANONICAL_PROJECT_DIR='${fixture.project}'; ZEDBOT_CANONICAL_COMPOSE_FILE='${fixture.compose}'; ZEDBOT_CANONICAL_RUNTIME_ENV_FILE='${fixture.envFile}'; ZEDBOT_ENV_FILE='${fixture.envFile}';`;
  return spawnSync("bash", ["-c", `${setup} ${body}`], {
    cwd: fixture.dir, encoding: "utf8", env: { ...process.env, ...hostile, PATH: `${fixture.bin}:${process.env.PATH}` },
  });
}

describe("immutable Compose contract", () => {
  it("uses the fixed project directory, file, name, env file and application-only recreation argv", () => {
    const fixture = composeFixture();
    expect(shell(fixture, "recreate_application_services").status).toBe(0);
    expect(readFileSync(fixture.argv, "utf8").trim().split("\n")).toEqual([
      "--context", "default", "compose", "--project-directory", fixture.project,
      "-f", fixture.compose, "--project-name", "zedbot", "--env-file", fixture.envFile,
      "up", "-d", "--no-deps", "--no-build", "--pull", "never", "--force-recreate", "api", "bot", "worker",
    ]);
  });

  it("is unaffected by current working directory and an implicit hostile .env", () => {
    const fixture = composeFixture(); writeFileSync(path.join(fixture.dir, ".env"), "COMPOSE_FILE=/evil\nAPP_IMAGE=evil.invalid/app:tag\n");
    expect(shell(fixture, "cd /; recreate_application_services").status).toBe(0);
    expect(readFileSync(fixture.argv, "utf8")).toContain(fixture.compose);
  });

  it.each([
    "COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_PROFILES", "COMPOSE_PATH_SEPARATOR", "COMPOSE_ENV_FILES",
    "COMPOSE_DISABLE_ENV_FILE", "COMPOSE_CONVERT_WINDOWS_PATHS", "COMPOSE_IGNORE_ORPHANS", "COMPOSE_MENU",
    "COMPOSE_PARALLEL_LIMIT", "COMPOSE_PROGRESS", "COMPOSE_STATUS_STDOUT", "DOCKER_HOST", "DOCKER_CONTEXT",
    "DOCKER_CONFIG", "DOCKER_API_VERSION", "BUILDKIT_HOST", "BUILDKIT_PROGRESS", "DOCKER_BUILDKIT",
  ])("removes hostile %s from the Compose child", (name) => {
    const fixture = composeFixture();
    expect(shell(fixture, "recreate_application_services", { [name]: "hostile-value" }).status).toBe(0);
    const environment = readFileSync(fixture.childEnv, "utf8");
    expect(environment).not.toContain(`${name}=hostile-value`);
    expect(environment).toContain("COMPOSE_DISABLE_ENV_FILE=1");
  });

  it("removes combinations of hostile Docker and Compose variables", () => {
    const fixture = composeFixture();
    const hostile = { COMPOSE_FILE: "/evil", COMPOSE_PROFILES: "evil", COMPOSE_ENV_FILES: "/evil.env",
      DOCKER_HOST: "tcp://evil.invalid:2375", DOCKER_CONTEXT: "evil", DOCKER_CONFIG: "/evil", BUILDKIT_HOST: "tcp://evil" };
    expect(shell(fixture, "recreate_application_services", hostile).status).toBe(0);
    const environment = readFileSync(fixture.childEnv, "utf8");
    for (const name of Object.keys(hostile)) expect(environment).not.toContain(`${name}=`);
  });

  it.each(["ZEDBOT_COMPOSE_CONTEXT", "ZEDBOT_ENV_FILE"])("rejects process override %s", (name) => {
    const fixture = composeFixture();
    const result = spawnSync("bash", ["-c", `. '${common}'; validate_compose_contract_paths`], {
      env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}`, [name]: "/attacker/path" },
    });
    expect(result.status).not.toBe(0);
  });

  it("cannot erase captured process overrides by sourcing later values", () => {
    const fixture = composeFixture();
    const sourced = path.join(fixture.dir, "synthetic.env");
    writeFileSync(sourced, "ZEDBOT_ENV_FILE_WAS_OVERRIDDEN=0\nZEDBOT_COMPOSE_CONTEXT_WAS_OVERRIDDEN=0\n");
    const result = spawnSync("bash", ["-c", `. '${common}'; . '${sourced}'; reset_compose_fixed_identity; validate_compose_contract_paths`], {
      env: { ...process.env, PATH: `${fixture.bin}:${process.env.PATH}`, ZEDBOT_ENV_FILE: "/attacker/env" },
    });
    expect(result.status).not.toBe(0);
  });

  it("does not use a hostile ambient PATH to resolve env or Docker", () => {
    const fixture = composeFixture();
    const hostileBin = path.join(fixture.dir, "hostile-bin");
    mkdirSync(hostileBin);
    writeFileSync(path.join(hostileBin, "env"), `#!/bin/sh\necho hostile > '${fixture.argv}'\nexit 99\n`, { mode: 0o755 });
    const result = shell(fixture, "recreate_application_services", { PATH: hostileBin });
    expect(result.status).toBe(0);
    expect(readFileSync(fixture.argv, "utf8")).not.toContain("hostile");
  });

  it.each(["compose-symlink", "env-symlink", "missing-compose", "compose-directory", "env-directory"])("fails closed for canonical path fault: %s", (fault) => {
    const fixture = composeFixture();
    if (fault === "compose-symlink") { const real = `${fixture.compose}.real`; writeFileSync(real, "services: {}\n"); writeFileSync(fixture.compose, ""); symlinkSync(real, `${fixture.compose}.link`); fixture.compose = `${fixture.compose}.link`; }
    if (fault === "env-symlink") { const real = `${fixture.envFile}.real`; writeFileSync(real, "X=1\n"); symlinkSync(real, `${fixture.envFile}.link`); fixture.envFile = `${fixture.envFile}.link`; }
    if (fault === "missing-compose") fixture.compose = path.join(fixture.project, "missing.yml");
    if (fault === "compose-directory") { fixture.compose = path.join(fixture.project, "compose-dir"); mkdirSync(fixture.compose); }
    if (fault === "env-directory") { fixture.envFile = path.join(fixture.project, "env-dir"); mkdirSync(fixture.envFile); }
    expect(shell(fixture, "validate_compose_contract_paths").status).not.toBe(0);
  });

  it.each([
    ["missing api", (v: typeof validRendered) => { delete v.services.api; }],
    ["missing bot", (v: typeof validRendered) => { delete v.services.bot; }],
    ["missing worker", (v: typeof validRendered) => { delete v.services.worker; }],
    ["missing image", (v: typeof validRendered) => { delete v.services.api.image; }],
    ["empty image", (v: typeof validRendered) => { v.services.bot.image = ""; }],
    ["substituted repository", (v: typeof validRendered) => { v.services.api.image = "evil.invalid/app:latest"; }],
    ["substituted tag", (v: typeof validRendered) => { v.services.bot.image = "zedbot-app:evil"; }],
    ["substituted digest", (v: typeof validRendered) => { v.services.worker.image = `zedbot-app@sha256:${"a".repeat(64)}`; }],
  ])("rejects rendered configuration with %s", (_label, mutate) => {
    const rendered = structuredClone(validRendered); mutate(rendered);
    expect(shell(composeFixture(rendered), "validate_compose_application_images").status).not.toBe(0);
  });

  it.each(["not-json", "[]", '{"services":[]}', '{"services":{"api":"bad"}}'])("rejects malformed structured output %s", (rendered) => {
    expect(shell(composeFixture(rendered), "validate_compose_application_images").status).not.toBe(0);
  });

  it("rejects duplicate application image keys in raw rendered JSON", () => {
    const rendered = '{"name":"zedbot","services":{"api":{"image":"zedbot-app:latest","image":"zedbot-app:latest"},"bot":{"image":"zedbot-app:latest"},"worker":{"image":"zedbot-app:latest"}}}';
    expect(shell(composeFixture(rendered), "validate_compose_application_images").status).not.toBe(0);
  });

  it("rejects a rendered project-name substitution", () => {
    expect(shell(composeFixture({ ...validRendered, name: "attacker-project" }), "validate_compose_application_images").status).not.toBe(0);
  });

  it("rejects a sourced image substitution after structured rendering", () => {
    const fixture = composeFixture({ ...validRendered, services: { ...validRendered.services, api: { image: "evil.invalid/injected:1" } } });
    writeFileSync(fixture.envFile, "APP_IMAGE=evil.invalid/injected:1\n");
    expect(shell(fixture, `. '${fixture.envFile}'; validate_compose_application_images`).status).not.toBe(0);
  });

  it("suppresses every later mocked mutation after Compose identity failure", () => {
    const rendered = structuredClone(validRendered); rendered.services.worker.image = "evil.invalid/worker:latest";
    const fixture = composeFixture(rendered); const record = path.join(fixture.dir, "mutations");
    const stages = `retain(){ echo retain >>'${record}'; }; tag(){ echo tag >>'${record}'; }; build(){ echo build >>'${record}'; }; compatibility(){ echo compatibility >>'${record}'; }; migrate(){ echo migrate >>'${record}'; }; recreate(){ echo recreate >>'${record}'; }; promote(){ echo promote >>'${record}'; }; validate_compose_application_images && retain && tag && build && compatibility && migrate && recreate && promote`;
    expect(shell(fixture, stages).status).not.toBe(0);
    expect(() => readFileSync(record)).toThrow();
  });

  it("uses the same validated contract for mocked update and rollback recreation flows", () => {
    let fixture = composeFixture();
    let result = shell(fixture, `require_source_integrity(){ return 0; }; register_source_snapshot(){ return 0; }; set_update_compose_contract '${fixture.project}' '${"a".repeat(40)}' '${"b".repeat(40)}' && validate_compose_application_images && recreate_application_services`);
    expect(result.status).toBe(0);
    expect(readFileSync(fixture.argv, "utf8")).toContain("api\nbot\nworker\n");

    fixture = composeFixture();
    const checksum = createHash("sha256").update(readFileSync(fixture.compose)).digest("hex");
    result = shell(fixture, `set_rollback_compose_contract '${fixture.project}' '${checksum}' && validate_compose_application_images && recreate_application_services`);
    expect(result.status).toBe(0);
    const rollbackArgv = readFileSync(fixture.argv, "utf8");
    expect(rollbackArgv).toContain("api\nbot\nworker\n");
    expect(rollbackArgv).not.toMatch(/\n(postgres|redis)\n/);
  });

  it("source integrity failure in the mocked update flow suppresses all later mutation", () => {
    const fixture = composeFixture(); const record = path.join(fixture.dir, "mutations");
    const command = `require_source_integrity(){ return 1; }; register_source_snapshot(){ return 0; }; mutate(){ echo called >'${record}'; }; set_update_compose_contract '${fixture.project}' '${"a".repeat(40)}' '${"b".repeat(40)}' && validate_compose_application_images && mutate`;
    expect(shell(fixture, command).status).not.toBe(0);
    expect(() => readFileSync(record)).toThrow();
  });
});
