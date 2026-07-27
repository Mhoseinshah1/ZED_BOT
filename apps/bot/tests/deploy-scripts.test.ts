import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "phase36-test-secret-phase36-test-secret";

import { isBackupFileName } from "../src/services/backup-health.service.js";

// =============================================================================
// Phase 36 deploy scripts: bash syntax, env validation (never prints
// secrets), the zedbot CLI surface (no destructive restore/uninstall) and
// the Phase 35-aligned backup filename. Pure filesystem/spawn tests - no
// database needed.
// =============================================================================

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const scriptsDir = path.join(repoRoot, "scripts");
const tempDir = path.join(os.tmpdir(), `zedbot-scripts-test-${Date.now()}-${process.pid}`);
mkdirSync(tempDir, { recursive: true });

function bash(args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

const REQUIRED_SCRIPTS = [
  "install.sh",
  "zedbot.sh",
  "validate-env.sh",
  "backup-db.sh",
] as const;

describe("deploy scripts (Phase 36)", () => {
  it("all required scripts exist and pass bash -n", () => {
    for (const name of REQUIRED_SCRIPTS) {
      const result = bash(["-n", path.join(scriptsDir, name)]);
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
    }
  });

  it("zedbot help lists the required commands and no destructive ones", () => {
    const result = bash([path.join(scriptsDir, "zedbot.sh"), "help"]);
    expect(result.status).toBe(0);
    const out = result.stdout;
    for (const cmd of [
      "status",
      "logs",
      "restart",
      "stop",
      "start",
      "update",
      "backup",
      "health",
      "doctor",
      "ps",
      "shell",
      "env-check",
      "restore-help",
    ]) {
      expect(out, `help must list ${cmd}`).toContain(cmd);
    }
    expect(out).not.toContain("uninstall");
    // The only restore surface is the instructions-only helper.
    expect(out).toContain("restore-help");
    expect(out).not.toMatch(/restore <|restore-file|Restore from a backup archive/);
  });

  it("zedbot restore prints manual instructions only and exits 0", () => {
    for (const cmd of ["restore", "restore-help"]) {
      const result = bash([path.join(scriptsDir, "zedbot.sh"), cmd]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("INSTRUCTIONS ONLY");
      expect(result.stdout).toContain("executes NOTHING");
      expect(result.stdout).toContain("zedbot backup");
      expect(result.stdout).toContain("<POSTGRES_USER>");
      expect(result.stdout).not.toMatch(/postgres(ql)?:\/\//);
    }
  });

  it("the zedbot wrapper stays as a thin exec of zedbot.sh", () => {
    const wrapper = readFileSync(path.join(scriptsDir, "zedbot"), "utf8");
    expect(wrapper).toContain('zedbot.sh');
    expect(bash(["-n", path.join(scriptsDir, "zedbot")]).status).toBe(0);
    // Wrapper must not carry its own command implementations.
    expect(wrapper).not.toContain("run_compose");
  });

  it("install.sh installs the CLI from zedbot.sh and advertises the required commands", () => {
    const install = readFileSync(path.join(scriptsDir, "install.sh"), "utf8");
    expect(install).toContain('scripts/zedbot.sh" "$CLI_PATH"');
    for (const cmd of ["zedbot status", "zedbot logs", "zedbot doctor", "zedbot backup", "zedbot env-check"]) {
      expect(install).toContain(cmd);
    }
  });

  it("backup-db.sh uses the Phase 35 filename format and safe cleanup", () => {
    const script = readFileSync(path.join(scriptsDir, "backup-db.sh"), "utf8");
    expect(script).toContain("date +%Y%m%d-%H%M%S");
    expect(script).toContain('zedbot-db-${ts}.sql.gz');
    expect(script).toContain("pg_dump");
    expect(script).toContain("gzip");
    expect(script).toContain("'zedbot-db-*.sql.gz'"); // retention deletes matching files only
    // The generated names are exactly what the in-bot Phase 35 list accepts.
    expect(isBackupFileName("zedbot-db-20260710-183000.sql.gz")).toBe(true);
    // DB-only backup: the script never copies or archives the env file.
    expect(script).not.toMatch(/cp\s+[^\n]*\.env|tar\s|ZEDBOT_ENV_FILE/);
  });

  describe("validate-env.sh", () => {
    const script = path.join(scriptsDir, "validate-env.sh");
    const SECRET = "super-secret-value-that-must-never-print-1234567890";
    const TOKEN = "123456:AAAbbbCCCdddEEE-secret-token";

    function runWithEnvFile(content: string) {
      const file = path.join(tempDir, `env-${Math.random().toString(36).slice(2)}`);
      writeFileSync(file, content);
      return bash([script, file]);
    }

    it("passes a complete production .env and prints key names only", () => {
      const result = runWithEnvFile(
        [
          `TELEGRAM_BOT_TOKEN='${TOKEN}'`,
          "ADMIN_TELEGRAM_IDS=123456789, 987654321",
          `APP_SECRET='${SECRET}'`,
          "DATABASE_URL='postgresql://zedbot:pw@postgres:5432/zedbot'",
          "REDIS_URL='redis://redis:6379'",
          "NODE_ENV=production",
          "BACKUP_DIR=/opt/zedbot/backups",
        ].join("\n"),
      );
      expect(result.status).toBe(0);
      const out = result.stdout + result.stderr;
      expect(out).toContain("TELEGRAM_BOT_TOKEN");
      expect(out).toContain("env check passed");
      // NEVER any value or secret.
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain("123456789");
      expect(out).not.toContain("postgresql://");
    });

    it("flags missing and invalid keys without printing the values", () => {
      const result = runWithEnvFile(
        [
          "BOT_TOKEN=", // empty -> missing token pair
          "ADMIN_TELEGRAM_IDS=abc,123", // invalid
          "APP_SECRET=too-short", // invalid
          // DATABASE_URL missing
          // REDIS missing
          "NODE_ENV=development", // invalid
        ].join("\n"),
      );
      expect(result.status).not.toBe(0);
      const out = result.stdout + result.stderr;
      expect(out).toContain("[MISSING] TELEGRAM_BOT_TOKEN");
      expect(out).toContain("[INVALID] ADMIN_TELEGRAM_IDS");
      expect(out).toContain("[INVALID] APP_SECRET");
      expect(out).toContain("[MISSING] DATABASE_URL");
      expect(out).toContain("[MISSING] REDIS_URL");
      expect(out).toContain("[INVALID] NODE_ENV");
      expect(out).toContain("BACKUP_DIR (default"); // defaultable
      expect(out).not.toContain("too-short");
      expect(out).not.toContain("abc,123");
      expect(out).not.toContain("development");
    });

    it("accepts the OWNER_TELEGRAM_ID / BOT_TOKEN / REDIS_HOST alternates", () => {
      const result = runWithEnvFile(
        [
          `BOT_TOKEN='${TOKEN}'`,
          "OWNER_TELEGRAM_ID=123456789",
          `APP_SECRET='${SECRET}'`,
          "DATABASE_URL='postgresql://zedbot:pw@postgres:5432/zedbot'",
          "REDIS_HOST=redis",
          "NODE_ENV=production",
        ].join("\n"),
      );
      expect(result.status).toBe(0);
      const out = result.stdout;
      expect(out).toContain("BOT_TOKEN");
      expect(out).toContain("OWNER_TELEGRAM_ID");
      expect(out).toContain("REDIS_HOST");
    });

    it("warns (does not fail) when the legacy BOT_TOKEN alias is used alone", () => {
      const result = runWithEnvFile(
        [
          `BOT_TOKEN='${TOKEN}'`,
          "OWNER_TELEGRAM_ID=123456789",
          `APP_SECRET='${SECRET}'`,
          "DATABASE_URL='postgresql://zedbot:pw@postgres:5432/zedbot'",
          "REDIS_HOST=redis",
          "NODE_ENV=production",
        ].join("\n"),
      );
      expect(result.status).toBe(0);
      const out = result.stdout + result.stderr;
      // The legacy name still resolves, but env-check nudges toward the canonical key.
      expect(out).toMatch(/\[ WARN {2}\].*legacy BOT_TOKEN/);
    });

    it("warns on a duplicate token pair (both set to the SAME value) without printing it", () => {
      const result = runWithEnvFile(
        [
          `TELEGRAM_BOT_TOKEN='${TOKEN}'`,
          `BOT_TOKEN='${TOKEN}'`,
          "OWNER_TELEGRAM_ID=123456789",
          `APP_SECRET='${SECRET}'`,
          "DATABASE_URL='postgresql://zedbot:pw@postgres:5432/zedbot'",
          "REDIS_HOST=redis",
          "NODE_ENV=production",
        ].join("\n"),
      );
      // A matching duplicate is safe: the runtime resolver uses the canonical key.
      expect(result.status).toBe(0);
      const out = result.stdout + result.stderr;
      expect(out).toContain("[ OK    ] TELEGRAM_BOT_TOKEN");
      expect(out).toMatch(/\[ WARN {2}\].*duplicate key/);
      expect(out).not.toContain(TOKEN);
    });

    it("FAILS a conflicting token pair (both set to DIFFERENT values), value-safe", () => {
      const TOKEN2 = "987654:ZZZyyyXXXwww-other-secret-token";
      const result = runWithEnvFile(
        [
          `TELEGRAM_BOT_TOKEN='${TOKEN}'`,
          `BOT_TOKEN='${TOKEN2}'`,
          "OWNER_TELEGRAM_ID=123456789",
          `APP_SECRET='${SECRET}'`,
          "DATABASE_URL='postgresql://zedbot:pw@postgres:5432/zedbot'",
          "REDIS_HOST=redis",
          "NODE_ENV=production",
        ].join("\n"),
      );
      // Diverging tokens are the exact bug this contract prevents: fail closed,
      // matching the runtime resolver's CONFLICT, so env-check never green-lights
      // a bot/worker token split.
      expect(result.status).not.toBe(0);
      const out = result.stdout + result.stderr;
      expect(out).toContain("[INVALID] TELEGRAM_BOT_TOKEN");
      expect(out).toContain("TELEGRAM_BOT_TOKEN and BOT_TOKEN conflict");
      // NEVER print either token value.
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain(TOKEN2);
    });

    it("fails safely on a missing env file", () => {
      const result = bash([script, path.join(tempDir, "does-not-exist")]);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("env file not found");
    });

    // Whitespace-only token normalization (matches the runtime resolver's
    // value.trim()): a "   " value must read as unset, never resolved and never a
    // false conflict. NO token value ever appears in the output.
    const REST = [
      "OWNER_TELEGRAM_ID=123456789",
      `APP_SECRET='${SECRET}'`,
      "DATABASE_URL='postgresql://zedbot:pw@postgres:5432/zedbot'",
      "REDIS_HOST=redis",
      "NODE_ENV=production",
    ];

    it("treats a whitespace-only TELEGRAM_BOT_TOKEN as missing (fails)", () => {
      const result = runWithEnvFile([`TELEGRAM_BOT_TOKEN='   '`, ...REST].join("\n"));
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("[MISSING] TELEGRAM_BOT_TOKEN");
    });

    it("treats a whitespace-only BOT_TOKEN as missing (fails)", () => {
      const result = runWithEnvFile([`BOT_TOKEN='   '`, ...REST].join("\n"));
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("[MISSING] TELEGRAM_BOT_TOKEN");
    });

    it("whitespace-only canonical + a valid legacy → legacy fallback OK + warning", () => {
      const result = runWithEnvFile(
        [`TELEGRAM_BOT_TOKEN='   '`, `BOT_TOKEN='${TOKEN}'`, ...REST].join("\n"),
      );
      expect(result.status).toBe(0);
      const out = result.stdout + result.stderr;
      expect(out).toContain("[ OK    ] BOT_TOKEN");
      expect(out).toMatch(/\[ WARN {2}\].*legacy BOT_TOKEN/);
      expect(out).not.toContain("[ OK    ] TELEGRAM_BOT_TOKEN");
      expect(out).not.toContain("conflict");
      expect(out).not.toContain(TOKEN);
    });

    it("a valid canonical + whitespace-only legacy → canonical OK (no duplicate/conflict)", () => {
      const result = runWithEnvFile(
        [`TELEGRAM_BOT_TOKEN='${TOKEN}'`, `BOT_TOKEN='   '`, ...REST].join("\n"),
      );
      expect(result.status).toBe(0);
      const out = result.stdout + result.stderr;
      expect(out).toContain("[ OK    ] TELEGRAM_BOT_TOKEN");
      expect(out).not.toContain("duplicate key");
      expect(out).not.toContain("conflict");
      expect(out).not.toContain(TOKEN);
    });

    it("both whitespace-padded but EQUAL after trimming → duplicate warning, OK", () => {
      const result = runWithEnvFile(
        [`TELEGRAM_BOT_TOKEN='  ${TOKEN}  '`, `BOT_TOKEN='${TOKEN}'`, ...REST].join("\n"),
      );
      expect(result.status).toBe(0);
      const out = result.stdout + result.stderr;
      expect(out).toContain("[ OK    ] TELEGRAM_BOT_TOKEN");
      expect(out).toMatch(/\[ WARN {2}\].*duplicate key/);
      expect(out).not.toContain("conflict");
      expect(out).not.toContain(TOKEN);
    });

    it("both whitespace-padded and DIFFERENT after trimming → conflict (fails)", () => {
      const TOKEN2 = "987654:ZZZyyyXXXwww-other-secret-token";
      const result = runWithEnvFile(
        [`TELEGRAM_BOT_TOKEN='  ${TOKEN}  '`, `BOT_TOKEN='  ${TOKEN2}  '`, ...REST].join("\n"),
      );
      expect(result.status).not.toBe(0);
      const out = result.stdout + result.stderr;
      expect(out).toContain("[INVALID] TELEGRAM_BOT_TOKEN");
      expect(out).toContain("TELEGRAM_BOT_TOKEN and BOT_TOKEN conflict");
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain(TOKEN2);
    });

    // Source-level guard: Telegram-token resolution must NOT fall back to the
    // untrimmed generic has_value (the exact defect this fixes). We assert the
    // token section reads the two keys through trim_env_token_value and that no
    // `has_value TELEGRAM_BOT_TOKEN` / `has_value BOT_TOKEN` call remains.
    it("token resolution never uses the untrimmed has_value helper", () => {
      const src = readFileSync(script, "utf8");
      expect(src).toContain('trim_env_token_value "$(env_get TELEGRAM_BOT_TOKEN)"');
      expect(src).toContain('trim_env_token_value "$(env_get BOT_TOKEN)"');
      expect(src).not.toMatch(/has_value\s+TELEGRAM_BOT_TOKEN/);
      expect(src).not.toMatch(/has_value\s+BOT_TOKEN/);
    });

    // Source-parity: validate-env.sh keeps a behaviourally identical inline copy
    // of the shared helper because it is deliberately dependency-free. The two
    // function bodies must stay byte-identical so they can never diverge.
    it("its inline trim_env_token_value matches scripts/lib/common.sh verbatim", () => {
      const extract = (file: string): string => {
        const text = readFileSync(file, "utf8");
        const match = text.match(/^trim_env_token_value\(\) \{\n[\s\S]*?^\}/m);
        expect(match, `trim_env_token_value not found in ${file}`).toBeTruthy();
        return (match as RegExpMatchArray)[0];
      };
      const inline = extract(script);
      const shared = extract(path.join(scriptsDir, "lib", "common.sh"));
      expect(inline).toBe(shared);
    });
  });

  // doctor.sh `check_telegram_token` sourced directly (BASH_SOURCE guard) so the
  // REAL function is exercised: it must trim edge whitespace exactly like the
  // runtime resolver, so a whitespace-only value never PASSes / never counts as
  // configured, and equal-after-trim is not a conflict. No value is ever printed.
  describe("doctor.sh check_telegram_token (whitespace-safe)", () => {
    const doctorScript = path.join(scriptsDir, "doctor.sh");
    const TOKEN = "123456:doctor-check-secret-token";
    const OTHER = "987654:doctor-other-secret-token";

    function tokenCheck(tg: string, bt: string) {
      const snippet =
        `source '${doctorScript}' >/dev/null 2>&1 || true\n` +
        `if check_telegram_token; then echo TOKEN_PASS; else echo TOKEN_FAIL; fi`;
      return bash(["-c", snippet], { TELEGRAM_BOT_TOKEN: tg, BOT_TOKEN: bt });
    }

    it("does NOT pass a whitespace-only canonical token", () => {
      const r = tokenCheck("   ", "");
      expect(r.stdout).toContain("TOKEN_FAIL");
      expect(r.stdout).not.toContain("TOKEN_PASS");
    });

    it("does NOT count a whitespace-only legacy token as configured", () => {
      const r = tokenCheck("", "   ");
      expect(r.stdout).toContain("TOKEN_FAIL");
      expect(r.stdout).not.toContain("TOKEN_PASS");
    });

    it("passes a valid canonical token (no value printed)", () => {
      const r = tokenCheck(TOKEN, "");
      expect(r.stdout).toContain("TOKEN_PASS");
      expect(r.stdout + r.stderr).not.toContain(TOKEN);
    });

    it("whitespace-only canonical + valid legacy → not a canonical PASS", () => {
      // tg trims to empty → check returns non-zero (WARN at the doctor level),
      // never a canonical PASS. bt being present does not rescue the canonical.
      const r = tokenCheck("   ", TOKEN);
      expect(r.stdout).toContain("TOKEN_FAIL");
      expect(r.stdout + r.stderr).not.toContain(TOKEN);
    });

    it("valid canonical + whitespace-only legacy → canonical ready", () => {
      const r = tokenCheck(TOKEN, "   ");
      expect(r.stdout).toContain("TOKEN_PASS");
    });

    it("passes a padded pair equal after trimming (not a conflict)", () => {
      const r = tokenCheck(`  ${TOKEN}  `, TOKEN);
      expect(r.stdout).toContain("TOKEN_PASS");
    });

    it("fails a padded pair that differs after trimming (conflict)", () => {
      const r = tokenCheck(`  ${TOKEN}  `, `  ${OTHER}  `);
      expect(r.stdout).toContain("TOKEN_FAIL");
      const out = r.stdout + r.stderr;
      expect(out).not.toContain(TOKEN);
      expect(out).not.toContain(OTHER);
    });
  });
});

// =============================================================================
// The Dockerfile enumerates workspace packages by hand.
//
// It has to: the manifest-copy layers exist so `pnpm install` can be cached
// separately from the sources, which means naming each `package.json`. The cost
// is that adding a workspace package and forgetting the Dockerfile produces a
// green typecheck, a green test run, a green local build — and an image build
// that dies inside CI with `ERR_PNPM_OUTDATED_LOCKFILE`, because the lockfile
// references a package whose manifest was never copied in.
//
// That is exactly what happened when `@zedbot/force-join` was added. This test
// derives the expected list from the filesystem so the next one cannot.
// =============================================================================

describe("Dockerfile workspace coverage", () => {
  const dockerfile = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

  /**
   * Every workspace member, discovered the way pnpm discovers them.
   *
   * The globs are read from pnpm-workspace.yaml rather than hard-coded, because
   * a hard-coded ["apps", "packages"] is the same class of bug one level up: it
   * would silently stop covering a third root the day someone adds one.
   */
  const workspaceRoots = (() => {
    const yaml = readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8");
    const roots: string[] = [];
    for (const line of yaml.split("\n")) {
      // Only the simple `- "dir/*"` form this repo uses. A nested or negated
      // glob would need a real parser, and reaching that point should be a
      // deliberate change to this test rather than a silent miss.
      const match = /^\s*-\s*"?([A-Za-z0-9_-]+)\/\*"?\s*$/.exec(line);
      if (match !== null) {
        roots.push(match[1]);
      }
    }
    return roots;
  })();

  interface Member {
    /** Path relative to the repo root, e.g. "packages/support-tickets". */
    dir: string;
    manifest: { scripts?: Record<string, string> };
  }

  const members: Member[] = workspaceRoots.flatMap((root) =>
    readdirSync(path.join(repoRoot, root), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .flatMap((entry) => {
        const dir = `${root}/${entry.name}`;
        try {
          const manifest = JSON.parse(
            readFileSync(path.join(repoRoot, dir, "package.json"), "utf8"),
          ) as Member["manifest"];
          return [{ dir, manifest }];
        } catch {
          // A directory with no manifest is not a workspace member.
          return [];
        }
      }),
  );

  it("discovers the workspace from pnpm-workspace.yaml, not from a hard-coded list", () => {
    // A guard on the guard: if the discovery silently found nothing, every
    // assertion below would vacuously pass and the whole file would be theatre.
    expect(workspaceRoots).toContain("apps");
    expect(workspaceRoots).toContain("packages");
    expect(members.length).toBeGreaterThanOrEqual(8);
    expect(members.map((m) => m.dir)).toContain("packages/support-tickets");
  });

  it("copies every workspace manifest into BOTH dependency-install stages", () => {
    for (const member of members) {
      const line = `COPY ${member.dir}/package.json ${member.dir}/`;
      // Twice: the build stage and the --prod runtime-deps stage. A member
      // missing from either one breaks a different half of the image — the
      // build stage fails the lockfile check, the prod stage silently ships an
      // image whose runtime dependencies were resolved without it.
      const occurrences = dockerfile.split(line).length - 1;
      expect(occurrences, `${line} (expected in both install stages)`).toBe(2);
    }
  });

  it("copies the built output of every member that produces one into Runtime", () => {
    // A member with no build script emits no dist and must not be asserted on;
    // everything that does build has to reach the runtime image, or the app
    // starts and then throws ERR_MODULE_NOT_FOUND on first use.
    const built = members.filter((m) => m.manifest.scripts?.build !== undefined);
    expect(built.length, "some member must build, or this asserts nothing").toBeGreaterThan(0);
    for (const member of built) {
      expect(
        dockerfile,
        `${member.dir}/dist must be copied into the runtime image`,
      ).toContain(`COPY --from=build /repo/${member.dir}/dist ${member.dir}/dist`);
    }
  });
});
