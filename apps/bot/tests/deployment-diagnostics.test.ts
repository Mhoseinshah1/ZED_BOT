import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.APP_SECRET ??= "deployment-diagnostics-tests-secret";

import {
  BackupOperationStatus,
  BackupTrigger,
  prisma,
  type Admin,
} from "@zedbot/database";
import {
  BACKUP_QUEUE_NAME,
  DEPLOYED_REPO_SHA_SETTING_KEY,
  getRedisOptions,
  normalizeGitSha,
  shortGitSha,
  WORKER_CAPABILITIES_KEY,
  WORKER_HEARTBEAT_KEY,
} from "@zedbot/shared";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

import { CB } from "../src/core/callbacks.js";
import { initialSession } from "../src/core/session.js";
import { reportsBackupHandler } from "../src/handlers/admin-reports-backup/reports-backup.handler.js";
import {
  getDeploymentDiagnostics,
  getSystemHealth,
  runningGitSha,
} from "../src/services/backup-health.service.js";
import { resetOpsQueueForTests } from "../src/services/ops-queue.service.js";
import {
  clearSettingsCache,
  deleteSetting,
  setSetting,
} from "../src/services/settings.service.js";

// =============================================================================
// Deployment identity (legacy-upgrade self-healing phase): normalizeGitSha /
// shortGitSha / runningGitSha semantics, SystemHealth.version (running vs
// deployed SHA with prefix-tolerant mismatch), getDeploymentDiagnostics
// (repo/bot/worker identity, migration completeness, mount + pg_dump facts),
// the rendered health/deploy pages (version line, mismatch warning, the
// OWNER-only «اجرای تست بکاپ» flow) and static secret-hygiene assertions
// over the self-healing deploy scripts. No secret-shaped input may ever
// surface in any rendered output.
// =============================================================================

const hasDb = typeof process.env.DATABASE_URL === "string" && process.env.DATABASE_URL !== "";
const hasRedis = (process.env.REDIS_URL ?? "") !== "" || (process.env.REDIS_HOST ?? "") !== "";

const runTag = BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000));
const tempDir = path.join(os.tmpdir(), `zedbot-deploy-diag-test-${Date.now()}-${process.pid}`);
mkdirSync(tempDir, { recursive: true });
// backupDir() reads BACKUP_DIR lazily on every call (established pattern).
process.env.BACKUP_DIR = tempDir;

const FULL_A = "0123456789abcdef0123456789abcdef01234567";
const SHORT_A = FULL_A.slice(0, 12);
const FULL_B = "89abcdef0123456789abcdef0123456789abcdef";

const OWNER_ONLY_TEXT = "این عملیات فقط برای مدیر اصلی (OWNER) مجاز است.";
const VERSION_MISMATCH_TEXT =
  "نسخه در حال اجرای ربات با نسخه نصب‌شده روی سرور یکسان نیست ⚠️";

const ORIGINAL_GIT_SHA = process.env.GIT_SHA;

function setGitSha(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.GIT_SHA;
  } else {
    process.env.GIT_SHA = value;
  }
}

async function setDeployedSha(value: string | null): Promise<void> {
  if (value === null) {
    await deleteSetting(DEPLOYED_REPO_SHA_SETTING_KEY);
  } else {
    await setSetting(DEPLOYED_REPO_SHA_SETTING_KEY, value, "STRING");
  }
  clearSettingsCache();
}

interface SentMessage {
  text: string;
  other: Record<string, unknown> | undefined;
}

interface InlineButton {
  text?: string;
  callback_data?: string;
}

/** Minimal BotContext stand-in for admin callback-query updates. */
function fakeCallbackCtx(data: string, admin: Admin | null) {
  const sent: SentMessage[] = [];
  const toasts: Array<string | undefined> = [];
  const from = {
    id: Number(admin?.telegramId ?? 999_999_002n),
    is_bot: false,
    first_name: "Tester",
  };
  const callbackQuery = { id: "cbq-1", chat_instance: "ci-1", from, data };
  const ctx = {
    session: initialSession(),
    dbUser: null,
    admin,
    from,
    callbackQuery,
    update: { update_id: 1, callback_query: callbackQuery },
    reply: async (text: string, other?: Record<string, unknown>) => {
      sent.push({ text, other });
      return {};
    },
    answerCallbackQuery: async (payload?: { text?: string }) => {
      toasts.push(payload?.text);
      return true;
    },
  };
  return { ctx: ctx as never, sent, toasts };
}

async function dispatch(ctx: never): Promise<void> {
  await reportsBackupHandler.middleware()(ctx, async () => {});
}

function flatButtons(sent: SentMessage): InlineButton[] {
  const markup = sent.other?.reply_markup as { inline_keyboard?: InlineButton[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat();
}

/** Every secret-shaped pattern that must never surface in rendered pages. */
function expectNoSecrets(text: string): void {
  expect(text).not.toMatch(/postgres(ql)?:\/\//i);
  expect(text).not.toMatch(/redis:\/\//i);
  const dbUrl = process.env.DATABASE_URL;
  if (typeof dbUrl === "string" && dbUrl !== "") {
    expect(text).not.toContain(dbUrl);
  }
  const redisUrl = process.env.REDIS_URL;
  if (typeof redisUrl === "string" && redisUrl !== "") {
    expect(text).not.toContain(redisUrl);
    try {
      const password = new URL(redisUrl).password;
      if (password !== "") {
        expect(text).not.toContain(password);
      }
    } catch {
      // Non-URL REDIS_URL form - the raw-string check above still applies.
    }
  }
}

// --- pure sha helpers ----------------------------------------------------------------------------

describe("git sha helpers (pure)", () => {
  afterEach(() => {
    setGitSha(ORIGINAL_GIT_SHA);
  });

  it("normalizeGitSha accepts 7-40 hex chars, lowercased and trimmed", () => {
    expect(normalizeGitSha(FULL_A)).toBe(FULL_A);
    expect(normalizeGitSha(FULL_A.toUpperCase())).toBe(FULL_A);
    expect(normalizeGitSha("  abc1234  ")).toBe("abc1234");
    expect(normalizeGitSha("abc1234")).toBe("abc1234"); // short form ok
  });

  it("normalizeGitSha rejects placeholders, junk and secret-shaped values", () => {
    expect(normalizeGitSha("unknown")).toBeNull(); // unbaked image marker
    expect(normalizeGitSha("UNKNOWN")).toBeNull();
    expect(normalizeGitSha("")).toBeNull();
    expect(normalizeGitSha("   ")).toBeNull();
    expect(normalizeGitSha(undefined)).toBeNull();
    expect(normalizeGitSha(null)).toBeNull();
    expect(normalizeGitSha(1234567)).toBeNull(); // non-string
    expect(normalizeGitSha("abc123")).toBeNull(); // 6 chars - too short
    expect(normalizeGitSha(`${FULL_A}0`)).toBeNull(); // 41 chars - too long
    expect(normalizeGitSha("gggggggg")).toBeNull(); // non-hex
    expect(normalizeGitSha("main")).toBeNull(); // branch name
    expect(normalizeGitSha("postgresql://zedbot:pw@postgres:5432/zedbot")).toBeNull();
    expect(normalizeGitSha("redis://:secret-pw@redis:6379")).toBeNull();
  });

  it("shortGitSha keeps the first 10 characters", () => {
    expect(shortGitSha(FULL_A)).toBe(FULL_A.slice(0, 10));
    expect(shortGitSha("abc1234")).toBe("abc1234"); // shorter stays whole
  });

  it("runningGitSha reads the baked GIT_SHA env honestly", () => {
    setGitSha(FULL_A);
    expect(runningGitSha()).toBe(FULL_A);
    setGitSha(FULL_A.toUpperCase());
    expect(runningGitSha()).toBe(FULL_A);
    setGitSha("unknown"); // image built without the arg
    expect(runningGitSha()).toBeNull();
    setGitSha(undefined);
    expect(runningGitSha()).toBeNull();
  });
});

// --- SystemHealth.version + the rendered health page ---------------------------------------------

describe.runIf(hasDb && hasRedis)("deployment identity in system health", () => {
  let admin: Admin;
  let originalDeployedSha: string | null = null;

  beforeAll(async () => {
    admin = await prisma.admin.create({
      data: { telegramId: runTag + 11n, role: "OWNER", isActive: true },
    });
    const row = await prisma.setting.findUnique({
      where: { key: DEPLOYED_REPO_SHA_SETTING_KEY },
    });
    originalDeployedSha = row?.value ?? null;
  });

  afterEach(async () => {
    setGitSha(ORIGINAL_GIT_SHA);
    await setDeployedSha(null);
  });

  afterAll(async () => {
    await setDeployedSha(originalDeployedSha);
    await prisma.admin.deleteMany({ where: { id: admin.id } });
    await resetOpsQueueForTests();
  });

  it("mismatch is false while EITHER sha is unknown", async () => {
    setGitSha(undefined);
    await setDeployedSha(null);
    let health = await getSystemHealth();
    expect(health.version).toEqual({ runningSha: null, deployedSha: null, mismatch: false });

    // Only the deployed side known.
    await setDeployedSha(FULL_A);
    health = await getSystemHealth();
    expect(health.version).toEqual({ runningSha: null, deployedSha: FULL_A, mismatch: false });

    // Only the running side known.
    setGitSha(FULL_A);
    await setDeployedSha(null);
    health = await getSystemHealth();
    expect(health.version).toEqual({ runningSha: FULL_A, deployedSha: null, mismatch: false });

    // The unknown-running case renders as «نامشخص» without the warning.
    setGitSha(undefined);
    const { ctx, sent } = fakeCallbackCtx("admin:rb:health", admin);
    await dispatch(ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("نسخه در حال اجرا: نامشخص");
    expect(sent[0].text).not.toContain(VERSION_MISMATCH_TEXT);
  });

  it("equal and prefix-related shas are the SAME commit - no mismatch", async () => {
    setGitSha(FULL_A);
    await setDeployedSha(FULL_A);
    expect((await getSystemHealth()).version.mismatch).toBe(false);

    // Short running form vs full deployed form of the same commit.
    setGitSha(SHORT_A);
    await setDeployedSha(FULL_A);
    let version = (await getSystemHealth()).version;
    expect(version).toEqual({ runningSha: SHORT_A, deployedSha: FULL_A, mismatch: false });

    // And the reverse orientation.
    setGitSha(FULL_A);
    await setDeployedSha(SHORT_A);
    version = (await getSystemHealth()).version;
    expect(version.mismatch).toBe(false);

    // Uppercase Setting values normalize before comparison.
    await setDeployedSha(FULL_A.toUpperCase());
    expect((await getSystemHealth()).version.mismatch).toBe(false);

    // No warning line on the rendered page.
    const { ctx, sent } = fakeCallbackCtx("admin:rb:health", admin);
    await dispatch(ctx);
    expect(sent[0].text).toContain(`نسخه در حال اجرا: ${shortGitSha(FULL_A)}`);
    expect(sent[0].text).not.toContain(VERSION_MISMATCH_TEXT);
  });

  it("different shas flag the stale container and render the warning line", async () => {
    setGitSha(FULL_A);
    await setDeployedSha(FULL_B);
    const health = await getSystemHealth();
    expect(health.version).toEqual({ runningSha: FULL_A, deployedSha: FULL_B, mismatch: true });

    const { ctx, sent } = fakeCallbackCtx("admin:rb:health", admin);
    await dispatch(ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain(`نسخه در حال اجرا: ${shortGitSha(FULL_A)}`);
    expect(sent[0].text).toContain(VERSION_MISMATCH_TEXT);
    // The health page never carries a raw connection URL or password.
    expectNoSecrets(sent[0].text);
  });
});

// --- getDeploymentDiagnostics + the deploy page --------------------------------------------------

describe.runIf(hasDb && hasRedis)("deployment diagnostics («بررسی نصب و بروزرسانی 🧪»)", () => {
  let owner: Admin;
  let support: Admin;
  let redis: Redis;
  let originalDeployedSha: string | null = null;
  const createdOpIds: string[] = [];

  beforeAll(async () => {
    owner = await prisma.admin.create({
      data: { telegramId: runTag + 21n, role: "OWNER", isActive: true },
    });
    support = await prisma.admin.create({
      data: { telegramId: runTag + 22n, role: "SUPPORT", isActive: true },
    });
    redis = new Redis(process.env.REDIS_URL ?? "");
    const row = await prisma.setting.findUnique({
      where: { key: DEPLOYED_REPO_SHA_SETTING_KEY },
    });
    originalDeployedSha = row?.value ?? null;
    // A crashed earlier run may have left active operations behind - the
    // one-active-op guard would then return those instead of creating ours.
    await prisma.backupOperation.updateMany({
      where: {
        status: {
          in: [
            BackupOperationStatus.QUEUED,
            BackupOperationStatus.RUNNING,
            BackupOperationStatus.VERIFYING,
          ],
        },
      },
      data: { status: BackupOperationStatus.CANCELLED },
    });
  });

  afterEach(async () => {
    setGitSha(ORIGINAL_GIT_SHA);
    await setDeployedSha(null);
    await redis.del(WORKER_CAPABILITIES_KEY, WORKER_HEARTBEAT_KEY).catch(() => undefined);
  });

  afterAll(async () => {
    await setDeployedSha(originalDeployedSha);
    if (createdOpIds.length > 0) {
      await prisma.backupOperation.deleteMany({ where: { id: { in: createdOpIds } } });
    }
    await prisma.admin.deleteMany({ where: { id: { in: [owner.id, support.id] } } });
    redis.disconnect();
    const options = getRedisOptions();
    if (options !== null) {
      const queue = new Queue(BACKUP_QUEUE_NAME, {
        connection: { ...options, maxRetriesPerRequest: null },
      });
      await queue.obliterate({ force: true }).catch(() => undefined);
      await queue.close();
    }
    await resetOpsQueueForTests();
    await prisma.$disconnect();
  });

  async function publishCapabilities(overrides: Record<string, unknown> = {}): Promise<void> {
    await redis.set(
      WORKER_CAPABILITIES_KEY,
      JSON.stringify({
        pgDumpVersion: "pg_dump (PostgreSQL) 16.4",
        backupDirWritable: true,
        backupDir: tempDir,
        checkedAt: new Date().toISOString(),
        ...overrides,
      }),
      "EX",
      45,
    );
  }

  it("reports honest nulls without a capability snapshot; migrations read as complete", async () => {
    setGitSha(undefined);
    await setDeployedSha(null);
    await redis.del(WORKER_CAPABILITIES_KEY);
    const diag = await getDeploymentDiagnostics();
    expect(diag.repoSha).toBeNull();
    expect(diag.botSha).toBeNull();
    expect(diag.workerSha).toBeNull();
    expect(diag.workerWritable).toBeNull();
    expect(diag.pgDumpAvailable).toBeNull();
    expect(diag.pgDumpVersion).toBeNull();
    expect(diag.mismatch).toBe(false);
    expect(diag.botReadable).toBe(true); // the temp BACKUP_DIR is readable
    // The migrated test DB matches the shipped migration directories.
    expect(diag.migration.known).toBe(true);
    expect(diag.migration.upToDate).toBe(true);
    expect(diag.migration.pendingCount).toBe(0);
    expect(diag.migration.appliedCount).toBeGreaterThan(0);
  });

  it("mismatch is pairwise over the non-null repo/bot/worker shas", async () => {
    // All three agree (worker publishes the same identity).
    setGitSha(FULL_A);
    await setDeployedSha(FULL_A);
    await publishCapabilities({ gitSha: FULL_A });
    let diag = await getDeploymentDiagnostics();
    expect([diag.repoSha, diag.botSha, diag.workerSha]).toEqual([FULL_A, FULL_A, FULL_A]);
    expect(diag.workerWritable).toBe(true);
    expect(diag.pgDumpAvailable).toBe(true);
    expect(diag.pgDumpVersion).toBe("pg_dump (PostgreSQL) 16.4");
    expect(diag.mismatch).toBe(false);

    // Short bot form of the same commit - still no alarm.
    setGitSha(SHORT_A);
    diag = await getDeploymentDiagnostics();
    expect(diag.mismatch).toBe(false);

    // A stale worker image alone trips the pairwise mismatch.
    setGitSha(FULL_A);
    await publishCapabilities({ gitSha: FULL_B });
    diag = await getDeploymentDiagnostics();
    expect(diag.workerSha).toBe(FULL_B);
    expect(diag.mismatch).toBe(true);

    // repo vs bot difference trips it too.
    await publishCapabilities({ gitSha: FULL_A });
    await setDeployedSha(FULL_B);
    diag = await getDeploymentDiagnostics();
    expect(diag.mismatch).toBe(true);

    // An old worker without a baked identity never causes a false alarm.
    await setDeployedSha(FULL_A);
    await publishCapabilities({ gitSha: "unknown" });
    diag = await getDeploymentDiagnostics();
    expect(diag.workerSha).toBeNull();
    expect(diag.mismatch).toBe(false);
  });

  it("secret-shaped identity inputs collapse to null and never render", async () => {
    setGitSha("redis://:secret-pw@redis:6379"); // hostile env value
    await setDeployedSha("postgresql://zedbot:pw@postgres:5432/zedbot");
    await publishCapabilities({ gitSha: "postgresql://leak@db/x" });
    const diag = await getDeploymentDiagnostics();
    expect(diag.repoSha).toBeNull();
    expect(diag.botSha).toBeNull();
    expect(diag.workerSha).toBeNull();
    expect(diag.mismatch).toBe(false);

    const { ctx, sent } = fakeCallbackCtx("admin:rb:deploy", owner);
    await dispatch(ctx);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("بررسی نصب و بروزرسانی 🧪");
    expect(sent[0].text).toContain("نامشخص");
    expectNoSecrets(sent[0].text);
    // The deploy page keyboard carries the OWNER test-backup entry.
    const buttons = flatButtons(sent[0]);
    expect(buttons).toContainEqual({ text: "اجرای تست بکاپ", callback_data: "admin:rb:testbk" });
    expect(buttons.some((b) => b.callback_data === "admin:rb:deploy")).toBe(true); // refresh
  });

  it("renders the deploy page with short shas and the mismatch warning", async () => {
    setGitSha(FULL_A);
    await setDeployedSha(FULL_B);
    await publishCapabilities({ gitSha: FULL_A });
    const { ctx, sent } = fakeCallbackCtx("admin:rb:deploy", owner);
    await dispatch(ctx);
    const text = sent[0].text;
    expect(text).toContain("نسخه مخزن:");
    expect(text).toContain(shortGitSha(FULL_B));
    expect(text).toContain("نسخه ربات:");
    expect(text).toContain("نسخه Worker:");
    expect(text).toContain(shortGitSha(FULL_A));
    expect(text).toContain(VERSION_MISMATCH_TEXT);
    expect(text).toContain("Migration:");
    expect(text).toContain("بروزرسانی‌شده ✅");
    // Full shas never render - only the 10-char display form.
    expect(text).not.toContain(FULL_A);
    expect(text).not.toContain(FULL_B);
    expectNoSecrets(text);
  });

  it("the reports/backup landing offers «بررسی نصب و بروزرسانی 🧪»", async () => {
    const { ctx, sent } = fakeCallbackCtx(CB.ADMIN_REPORTS_BACKUP, owner);
    await dispatch(ctx);
    expect(sent).toHaveLength(1);
    expect(flatButtons(sent[0])).toContainEqual({
      text: "بررسی نصب و بروزرسانی 🧪",
      callback_data: "admin:rb:deploy",
    });
  });

  it("«اجرای تست بکاپ» is OWNER-only and its confirmation requests a REAL backup", async () => {
    // SUPPORT admin: refused at the confirmation gate already.
    const refused = fakeCallbackCtx("admin:rb:testbk", support);
    await dispatch(refused.ctx);
    expect(refused.toasts).toContain(OWNER_ONLY_TEXT);
    expect(refused.sent).toHaveLength(0);

    // And at the final confirm, defensively.
    const refusedYes = fakeCallbackCtx("admin:rb:testbk_yes", support);
    await dispatch(refusedYes.ctx);
    expect(refusedYes.toasts).toContain(OWNER_ONLY_TEXT);
    const foreignOps = await prisma.backupOperation.count({
      where: { requestedByAdminId: support.id },
    });
    expect(foreignOps).toBe(0);

    // OWNER: confirmation page with the exact yes/cancel wiring.
    const confirm = fakeCallbackCtx("admin:rb:testbk", owner);
    await dispatch(confirm.ctx);
    expect(confirm.sent[0].text).toContain("اجرای تست بکاپ");
    expect(confirm.sent[0].text).toContain("بکاپ واقعی");
    expect(flatButtons(confirm.sent[0])).toEqual([
      { text: "تایید و اجرا ✅", callback_data: "admin:rb:testbk_yes" },
      { text: "انصراف", callback_data: "admin:rb:deploy" },
    ]);

    // Confirming creates ONE queued MANUAL BackupOperation via the worker queue.
    const go = fakeCallbackCtx("admin:rb:testbk_yes", owner);
    await dispatch(go.ctx);
    const op = await prisma.backupOperation.findFirst({
      where: { requestedByAdminId: owner.id },
      orderBy: { queuedAt: "desc" },
    });
    expect(op).not.toBeNull();
    if (op !== null) {
      createdOpIds.push(op.id);
      expect(op.trigger).toBe(BackupTrigger.MANUAL);
      expect(op.status).toBe(BackupOperationStatus.QUEUED);
    }
    expect(go.sent[0].text).toContain("در حال ساخت بکاپ… ⏳");
    expectNoSecrets(go.sent[0].text);

    // Neutralize the QUEUED row so later suites can request backups freely.
    if (op !== null) {
      await prisma.backupOperation.update({
        where: { id: op.id },
        data: { status: BackupOperationStatus.CANCELLED },
      });
    }
  });
});

// --- static secret hygiene over the self-healing deploy scripts ----------------------------------

describe("legacy-upgrade deploy scripts stay secret-free (static)", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const scriptsDir = path.join(repoRoot, "scripts");
  const SCRIPTS = [
    "update.sh",
    "migrate.sh",
    "zedbot.sh",
    path.join("tests", "legacy-upgrade-test.sh"),
  ] as const;

  function bash(args: string[]) {
    return spawnSync("bash", args, { encoding: "utf8", env: { ...process.env } });
  }

  it("all self-healing scripts pass bash -n", () => {
    for (const name of SCRIPTS) {
      const result = bash(["-n", path.join(scriptsDir, name)]);
      expect(result.status, `${name}: ${result.stderr}`).toBe(0);
    }
  });

  it("zedbot help lists deploy-status and zedbot.sh implements it", () => {
    const help = bash([path.join(scriptsDir, "zedbot.sh"), "help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("deploy-status");
    const script = readFileSync(path.join(scriptsDir, "zedbot.sh"), "utf8");
    expect(script).toContain("deploy_status()");
  });

  it("update pins fetched target SHA while legacy self-heal pins repository HEAD", () => {
    const update = readFileSync(path.join(scriptsDir, "update.sh"), "utf8");
    expect(update).toContain('snapshot_result="$(prepare_exact_origin_main)"');
    expect(update).toContain('read -r target_deploy_sha target_tree SOURCE_SNAPSHOT <<< "$snapshot_result"');
    expect(update).toContain('GIT_SHA="$target_deploy_sha"');
    expect(update).toContain("export GIT_SHA");
    const migrate = readFileSync(path.join(scriptsDir, "migrate.sh"), "utf8");
    expect(migrate).toContain('GIT_SHA="$(repo_head_sha)"');
    expect(migrate).toContain('export GIT_SHA="${GIT_SHA:-unknown}"');
    expect(migrate).toContain('run_compose_with_deployment_sha "$GIT_SHA" build');
    expect(migrate).not.toMatch(/^\s*run_compose build\s*$/m);
  });

  it("runs the complete workspace test under sudo with one trusted nested-pnpm PATH and an exact environment allowlist", () => {
    const workflow = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as { scripts: { test: string } };
    expect(rootPackage.scripts.test).toBe("pnpm -r --if-present run test");
    expect(workflow).toContain('node_path="$(realpath -e -- "$node_command")"');
    expect(workflow).toContain('pnpm_path="$(realpath -e -- "$pnpm_command")"');
    expect(workflow).toContain('test "$node_path" = "$node_bin/node"');
    expect(workflow).toContain('test "$pnpm_path" = "$tool_root/lib/node_modules/corepack/dist/pnpm.js"');
    expect(workflow).toContain('test ! -L "$trusted"');
    expect(workflow).toContain('test "$owner" = 0 || test "$owner" = "$runner_uid"');
    expect(workflow).toContain('test $((8#$mode & 8#022)) -eq 0');
    expect(workflow).toContain("sudo --preserve-env=CI,NODE_ENV,APP_NAME,APP_DOMAIN,APP_BASE_URL,API_PORT,LOG_LEVEL,TELEGRAM_BOT_TOKEN,ADMIN_TELEGRAM_IDS,POSTGRES_DB,POSTGRES_USER,POSTGRES_PASSWORD,DATABASE_URL,REDIS_HOST,REDIS_PORT,REDIS_PASSWORD,REDIS_URL \\");
    expect(workflow).toContain('PATH="${node_bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"');
    expect(workflow).toContain('"$pnpm_path" test');
    expect(workflow).not.toMatch(/pnpm_path.*test.*(?:--filter|--exclude|--skip)/);
    expect(workflow).not.toContain("--preserve-env ");
  });

  it("no print-like line ever expands a secret variable directly", () => {
    // Lines that write to the terminal/logs (echo/printf/loggers) must never
    // interpolate the secret-bearing variables - key NAMES are fine, `$VALUES`
    // are not. Assignments, heredocs and grep probes are exempt by design.
    const printLike =
      /^\s*(echo|printf|log_info|log_warn|log_error|log_success|log_step|phase|fail)\b/;
    const secretVar =
      /\$\{?(POSTGRES_PASSWORD|DATABASE_URL|REDIS_URL|TELEGRAM_BOT_TOKEN|BOT_TOKEN|APP_SECRET|REDIS_PASSWORD|BACKUP_ENCRYPTION_PASSWORD|PG_PW|REDIS_PW|BOT_TOKEN_VALUE|app_secret)\b/;
    for (const name of SCRIPTS) {
      const lines = readFileSync(path.join(scriptsDir, name), "utf8").split("\n");
      lines.forEach((line, index) => {
        if (!printLike.test(line)) {
          return;
        }
        expect(
          secretVar.test(line),
          `${name}:${index + 1} prints a secret variable: ${line.trim()}`,
        ).toBe(false);
      });
    }
  });

  it("the legacy-upgrade harness keeps its runtime secret-leak scan", () => {
    const script = readFileSync(
      path.join(scriptsDir, "tests", "legacy-upgrade-test.sh"),
      "utf8",
    );
    expect(script).toContain("scan_for_secret_leaks");
    expect(script).toContain('scan_one "POSTGRES_PASSWORD"');
    expect(script).toContain('scan_one "REDIS_PASSWORD"');
    expect(script).toContain('scan_one "TELEGRAM_BOT_TOKEN"');
    expect(script).toContain("api container GIT_SHA");
    expect(script).toContain("worker container GIT_SHA");
    expect(script).toContain("bot container GIT_SHA");
    expect(script).toContain("command not found");
  });
});

describe.skipIf(hasDb && hasRedis)("deployment diagnostics (skipped)", () => {
  it("diagnostics integration tests require DATABASE_URL and REDIS_URL - see docs/testing.md", () => {
    expect(hasDb && hasRedis).toBe(false);
  });
});
