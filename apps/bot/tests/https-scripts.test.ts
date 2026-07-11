import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// =============================================================================
// Phase 37 HTTPS scripts: bash syntax, CLI surface, generated Nginx config
// (via the root-free --print mode) and domain validation. certbot is never
// executed; no root required.
// =============================================================================

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scriptsDir = path.join(repoRoot, "scripts");

function bash(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", args, {
    encoding: "utf8",
    env: { ...process.env, ...env, ZEDBOT_ENV_FILE: "/nonexistent-env-for-tests" },
  });
}

function printConfig(kind: "http" | "https", domain: string, port = "3000") {
  return bash([path.join(scriptsDir, "nginx-setup.sh"), "--print", kind], {
    APP_DOMAIN: domain,
    API_PORT: port,
  });
}

describe("HTTPS deploy scripts (Phase 37)", () => {
  it("new scripts pass bash -n", () => {
    for (const name of ["nginx-setup.sh", "ssl-setup.sh", "ssl-renew.sh"]) {
      const result = bash(["-n", path.join(scriptsDir, name)]);
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
    }
  });

  it("zedbot help lists the HTTPS commands and stays non-destructive", () => {
    const result = bash([path.join(scriptsDir, "zedbot.sh"), "help"]);
    expect(result.status).toBe(0);
    for (const cmd of ["nginx", "ssl", "renew-cert", "https-status", "backup", "env-check", "restore-help"]) {
      expect(result.stdout, `help must list ${cmd}`).toContain(cmd);
    }
    expect(result.stdout).not.toContain("uninstall");
    expect(result.stdout).not.toMatch(/restore <|Restore from a backup archive/);
  });

  it("renders the HTTP bootstrap config with proxy + ACME location", () => {
    const result = printConfig("http", "bot.example.com", "3210");
    expect(result.status, result.stderr).toBe(0);
    const conf = result.stdout;
    expect(conf).toContain("server_name bot.example.com;");
    expect(conf).toContain("proxy_pass http://127.0.0.1:3210;");
    expect(conf).toContain("location /.well-known/acme-challenge/");
    expect(conf).toContain("root /var/www/letsencrypt;");
    expect(conf).toContain("listen 80;");
    // HTTPS-only bits must NOT be in the bootstrap config.
    expect(conf).not.toContain("ssl_certificate");
    expect(conf).not.toContain("Strict-Transport-Security");
    expect(conf).not.toContain("return 301");
  });

  it("renders the HTTPS config with redirect, cert paths and hardening headers", () => {
    const result = printConfig("https", "bot.example.com");
    expect(result.status, result.stderr).toBe(0);
    const conf = result.stdout;
    expect(conf).toContain("server_name bot.example.com;");
    expect(conf).toContain("return 301 https://$host$request_uri;");
    expect(conf).toContain("listen 443 ssl;");
    expect(conf).toContain("ssl_certificate /etc/letsencrypt/live/bot.example.com/fullchain.pem;");
    expect(conf).toContain("ssl_certificate_key /etc/letsencrypt/live/bot.example.com/privkey.pem;");
    expect(conf).toContain('add_header X-Content-Type-Options "nosniff" always;');
    expect(conf).toContain('add_header X-Frame-Options "DENY" always;');
    expect(conf).toContain('add_header Referrer-Policy "no-referrer" always;');
    expect(conf).toContain("Strict-Transport-Security");
    expect(conf).toContain("proxy_pass http://127.0.0.1:3000;");
    expect(conf).toContain("location /.well-known/acme-challenge/");
    // No secrets ever appear - the config carries only domain + port.
    // (server_tokens off; is an nginx directive, not a secret - hence BOT_TOKEN.)
    expect(conf).not.toMatch(/APP_SECRET|BOT_TOKEN|PASSWORD|postgres(ql)?:\/\//i);
  });

  it("rejects unsafe or invalid domains", () => {
    for (const bad of ["example.com; rm -rf /", "http://example.com", "127.0.0.1", "", "bot_example.com", "-bad.example.com"]) {
      const result = printConfig("http", bad);
      expect(result.status, `must reject: ${JSON.stringify(bad)}`).not.toBe(0);
      expect(result.stdout).not.toContain("server_name");
    }
    // Uppercase input is normalized, not rejected.
    const upper = printConfig("http", "BOT.Example.COM");
    expect(upper.status).toBe(0);
    expect(upper.stdout).toContain("server_name bot.example.com;");
  });

  it("rejects invalid ports", () => {
    for (const bad of ["0", "70000", "abc", "80; ls"]) {
      const result = printConfig("http", "bot.example.com", bad);
      expect(result.status, `must reject port: ${bad}`).not.toBe(0);
    }
  });

  it("install.sh offers HTTPS setup without forcing it and compose binds the API to loopback", () => {
    const install = readFileSync(path.join(scriptsDir, "install.sh"), "utf8");
    expect(install).toContain("setup_https_if_requested");
    expect(install).toContain("ZEDBOT_SETUP_SSL");
    expect(install).toContain("zedbot nginx");
    expect(install).toContain("zedbot ssl");
    const compose = readFileSync(path.join(repoRoot, "docker-compose.yml"), "utf8");
    expect(compose).toContain('"127.0.0.1:${API_PORT:-3000}:${API_PORT:-3000}"');
    expect(compose).not.toMatch(/ports:\s*\n\s*- "(?:\$\{)?(?:POSTGRES|REDIS)/);
  });

  it("docs cover the DNS and port prerequisites", () => {
    const doc = readFileSync(path.join(repoRoot, "docs/production-https-phase37.md"), "utf8");
    expect(doc).toContain("A record");
    expect(doc).toMatch(/80 and 443|80\/443/);
    expect(doc).toContain("zedbot nginx");
    expect(doc).toContain("zedbot ssl");
    expect(doc).toContain("zedbot https-status");
    expect(doc).toContain("zedbot renew-cert");
  });
});
