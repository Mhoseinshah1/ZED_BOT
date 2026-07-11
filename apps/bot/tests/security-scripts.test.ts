import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// =============================================================================
// Phase 38 hardening scripts: bash syntax, CLI surface, firewall lockout
// safeguards (static) and the security-check audit against good/bad compose
// and .env fixtures. ufw is never enabled and no root is required.
// =============================================================================

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scriptsDir = path.join(repoRoot, "scripts");
const tempDir = path.join(os.tmpdir(), `zedbot-security-test-${Date.now()}-${process.pid}`);
mkdirSync(tempDir, { recursive: true });

function bash(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", args, { encoding: "utf8", env: { ...process.env, ...env } });
}

function runSecurityCheck(composeFile: string, envFile: string) {
  return bash([path.join(scriptsDir, "security-check.sh")], {
    ZEDBOT_APP_DIR: repoRoot,
    ZEDBOT_COMPOSE_FILE: composeFile,
    ZEDBOT_ENV_FILE: envFile,
  });
}

function writeTemp(name: string, content: string, mode?: number): string {
  const file = path.join(tempDir, name);
  writeFileSync(file, content);
  if (mode !== undefined) {
    chmodSync(file, mode);
  }
  return file;
}

describe("security hardening scripts (Phase 38)", () => {
  it("new scripts pass bash -n", () => {
    for (const name of ["firewall-setup.sh", "security-check.sh", "zedbot.sh", "install.sh"]) {
      const result = bash(["-n", path.join(scriptsDir, name)]);
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
    }
  });

  it("zedbot help lists firewall/security and stays non-destructive", () => {
    const result = bash([path.join(scriptsDir, "zedbot.sh"), "help"]);
    expect(result.status).toBe(0);
    for (const cmd of ["firewall", "security", "security-check", "nginx", "ssl", "backup", "env-check"]) {
      expect(result.stdout, `help must list ${cmd}`).toContain(cmd);
    }
    expect(result.stdout).not.toContain("uninstall");
    expect(result.stdout).not.toMatch(/restore <|Restore from a backup archive/);
  });

  it("firewall script keeps the SSH-lockout safeguards", () => {
    const script = readFileSync(path.join(scriptsDir, "firewall-setup.sh"), "utf8");
    // SSH detection + allow BEFORE enable.
    expect(script).toContain("sshd -T");
    expect(script.indexOf('ufw allow "${ssh_port}/tcp"')).toBeGreaterThan(-1);
    expect(script.indexOf('ufw allow "${ssh_port}/tcp"')).toBeLessThan(script.indexOf("ufw --force enable"));
    // Belt-and-braces re-check before enabling.
    expect(script).toContain("ufw show added");
    // Opt-in enabling only.
    expect(script).toContain("ZEDBOT_ENABLE_FIREWALL");
    expect(script).toContain("NOT enabling ufw");
    // Never resets or deletes rules.
    expect(script).not.toContain("ufw reset");
    expect(script).not.toContain("ufw delete");
    expect(script).not.toContain("ufw --force reset");
  });

  it("security-check flags public DB/Redis/API and a world-readable .env as serious", () => {
    const badCompose = writeTemp(
      "bad-compose.yml",
      [
        "services:",
        "  postgres:",
        "    image: postgres:16",
        "    ports:",
        '      - "5432:5432"',
        "  redis:",
        "    image: redis:7",
        "    ports:",
        '      - "6379:6379"',
        "  api:",
        "    image: app",
        "    ports:",
        '      - "3000:3000"',
        "",
      ].join("\n"),
    );
    const badEnv = writeTemp("bad.env", "APP_SECRET=whatever-not-printed\n", 0o644);

    const result = runSecurityCheck(badCompose, badEnv);
    expect(result.status).not.toBe(0);
    const out = result.stdout + result.stderr;
    expect(out).toContain("[FAIL] .env is group/world readable");
    expect(out).toContain("[FAIL] postgres: publishes host ports");
    expect(out).toContain("[FAIL] redis: publishes host ports");
    expect(out).toContain("[FAIL] api: published on a public interface");
    expect(out).toContain("4 serious problem(s)");
    // Never any secret value.
    expect(out).not.toContain("whatever-not-printed");
  });

  it("security-check passes a loopback API + private DB compose with a 600 .env", () => {
    const goodEnv = writeTemp("good.env", "APP_SECRET=whatever-not-printed\n", 0o600);
    const result = runSecurityCheck(path.join(repoRoot, "docker-compose.yml"), goodEnv);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const out = result.stdout;
    expect(out).toContain("[PASS] .env permissions are 600");
    expect(out).toContain("[PASS] postgres: no host ports published.");
    expect(out).toContain("[PASS] redis: no host ports published.");
    expect(out).toContain("[PASS] api: bound to 127.0.0.1 only.");
    expect(out).toContain("restart: unless-stopped");
    expect(out).toContain("[PASS] app services run with no-new-privileges.");
    expect(out).toContain("no serious problems");
  });

  it("the repo compose is hardened: loopback API, private DB/Redis, no-new-privileges + tmpfs", () => {
    const compose = readFileSync(path.join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose).toContain('"127.0.0.1:${API_PORT:-3000}:${API_PORT:-3000}"');
    expect(compose.match(/no-new-privileges:true/g)?.length).toBe(3);
    expect(compose.match(/tmpfs:\s*\n\s*- \/tmp/g)?.length).toBe(3);
    expect(compose.match(/restart: unless-stopped/g)?.length).toBe(5);
    // postgres/redis sections publish no ports.
    const postgresBlock = compose.slice(compose.indexOf("  postgres:"), compose.indexOf("  redis:"));
    const redisBlock = compose.slice(compose.indexOf("  redis:"), compose.indexOf("  api:"));
    expect(postgresBlock).not.toContain("ports:");
    expect(redisBlock).not.toContain("ports:");
  });

  it("nginx configs hide the server version", () => {
    const env = { APP_DOMAIN: "bot.example.com", ZEDBOT_ENV_FILE: "/nonexistent" };
    const http = bash([path.join(scriptsDir, "nginx-setup.sh"), "--print", "http"], env);
    const https = bash([path.join(scriptsDir, "nginx-setup.sh"), "--print", "https"], env);
    expect(http.status).toBe(0);
    expect(https.status).toBe(0);
    expect(http.stdout.match(/server_tokens off;/g)?.length).toBe(1);
    expect(https.stdout.match(/server_tokens off;/g)?.length).toBe(2);
  });

  it("install.sh offers the firewall without forcing it", () => {
    const install = readFileSync(path.join(scriptsDir, "install.sh"), "utf8");
    expect(install).toContain("setup_firewall_if_requested");
    expect(install).toContain("ZEDBOT_ENABLE_FIREWALL");
    expect(install).toContain("zedbot firewall");
    expect(install).toContain("zedbot security");
  });

  it("docs cover the firewall and audit behavior", () => {
    const doc = readFileSync(path.join(repoRoot, "docs/production-security-phase38.md"), "utf8");
    expect(doc).toContain("zedbot firewall");
    expect(doc).toContain("zedbot security");
    expect(doc).toContain("lockout");
    expect(doc).toContain("ZEDBOT_ENABLE_FIREWALL");
    expect(doc).toMatch(/cap_drop/);
  });
});
