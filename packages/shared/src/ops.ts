// =============================================================================
// Ops contract (production backups + Telegram operational logging): the ONE
// place that defines queue/job/lock/heartbeat names, backup filename
// conventions, log-topic keys and the metadata sanitizer shared by the bot,
// the worker and the API. Everything here is dependency-free (no prisma, no
// bullmq) so every package can import it.
// =============================================================================

import type { TelegramBotTokenSource } from "./telegram-token.js";

// --- queues / jobs -------------------------------------------------------------------------------

export const BACKUP_QUEUE_NAME = "database-backup";
export const LOG_DELIVERY_QUEUE_NAME = "telegram-operational-logs";

export const BACKUP_JOB_NAMES = {
  CREATE: "CREATE_DATABASE_BACKUP",
  VERIFY: "VERIFY_DATABASE_BACKUP",
  CLEANUP: "CLEANUP_DATABASE_BACKUPS",
  NOTIFY: "SEND_BACKUP_NOTIFICATION",
} as const;
export type BackupJobName = (typeof BACKUP_JOB_NAMES)[keyof typeof BACKUP_JOB_NAMES];

export const LOG_DELIVERY_JOB_NAME = "DELIVER_SYSTEM_LOG";

/** Repeatable-job id for the scheduled backup (one per installation). */
export const SCHEDULED_BACKUP_JOB_ID = "scheduled-database-backup";

// Direct-log-group-setup phase: the durable topic-provisioning + activation
// queue. The bot enqueues one job per LogGroupSetupAttempt (jobId
// log-group-setup-<attemptId>, so a repeated OWNER confirmation reuses the
// same job); the worker creates the default forum topics, sends the direct
// SYSTEM test and activates the group atomically - NEVER inline in a
// callback.
export const LOG_GROUP_SETUP_QUEUE_NAME = "telegram-log-group-setup";
export const LOG_GROUP_SETUP_JOB_NAME = "PROVISION_LOG_GROUP";

/** BullMQ job id for one setup attempt (idempotent across repeated confirms). */
export function logGroupSetupJobId(attemptId: string): string {
  return `log-group-setup-${attemptId}`;
}

// --- locks / heartbeat / capabilities -------------------------------------------------------------

/** Only one database backup may run at a time (worker-held Redis lock). */
export const BACKUP_LOCK_KEY = "zedbot:backup:database";

/** Only one log-group setup provisioning may run at a time (worker lock). */
export const LOG_GROUP_SETUP_LOCK_KEY = "zedbot:log-group:setup";

// The log-group binding lives in two Settings; the string keys are shared so
// BOTH the bot (validation / group-side flows / status page) and the worker
// (atomic activation) read and write the identical Setting rows.
export const LOG_GROUP_CHAT_ID_SETTING_KEY = "log_group_chat_id";
export const LOG_GROUP_TITLE_SETTING_KEY = "log_group_title";

/** Worker liveness: SET with TTL every WORKER_HEARTBEAT_INTERVAL_MS. */
export const WORKER_HEARTBEAT_KEY = "zedbot:worker:heartbeat";
export const WORKER_HEARTBEAT_INTERVAL_MS = 15_000;
export const WORKER_HEARTBEAT_TTL_SECONDS = 45;

/**
 * Worker-published capability snapshot (JSON, same TTL cadence as the
 * heartbeat): { pgDumpVersion: string|null, backupDirWritable: boolean,
 * backupDir: string, gitSha: string|null, checkedAt: iso }. The bot's
 * health page reads this - the bot's own mount is read-only, so write
 * access and pg_dump presence are the WORKER's facts, never probed from
 * the bot container. gitSha is the worker image's baked build identity.
 */
export const WORKER_CAPABILITIES_KEY = "zedbot:worker:capabilities";

export interface WorkerCapabilities {
  pgDumpVersion: string | null;
  backupDirWritable: boolean;
  backupDir: string;
  /** Baked image build identity (GIT_SHA); null when built without it. */
  gitSha?: string | null;
  /**
   * Whether the WORKER resolves a usable Telegram bot token
   * (fix/worker-telegram-token-env-contract). Presence only — never token bytes.
   * Optional so a snapshot published by an older worker still parses.
   */
  telegramBotTokenConfigured?: boolean;
  /**
   * Which env key the worker's token came from, or why none is usable:
   * "TELEGRAM_BOT_TOKEN" | "BOT_TOKEN" | "MISSING" | "CONFLICT". Reveals only the
   * KEY NAME, never any token data.
   */
  telegramBotTokenSource?: TelegramBotTokenSource;
  checkedAt: string;
}

// --- deployment identity ---------------------------------------------------------------------------

/**
 * Setting key holding the repository HEAD SHA recorded by the LAST completed
 * deploy (scripts/update.sh / install.sh via the worker record-deploy CLI).
 * The bot compares its own baked GIT_SHA against this value to detect stale
 * running containers after an update.
 */
export const DEPLOYED_REPO_SHA_SETTING_KEY = "deployed_repo_sha";

/** Setting key with the ISO timestamp of the last deploy-SHA recording. */
export const DEPLOYED_REPO_SHA_AT_SETTING_KEY = "deployed_repo_sha_recorded_at";

/**
 * Normalizes a git SHA candidate (env var, CLI arg, capability snapshot):
 * returns the lowercased hex SHA, or null for empty / placeholder ("unknown")
 * / non-hex values. Images built without the GIT_SHA build arg carry the
 * literal "unknown" and must read as "no identity", never as a real version.
 */
export function normalizeGitSha(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

/** Short display form of a git SHA (health page, deploy-status). */
export function shortGitSha(sha: string): string {
  return sha.slice(0, 10);
}

// --- backup files ---------------------------------------------------------------------------------

/** In-container backup directory (bind-mounted from ZEDBOT_BACKUP_DIR). */
export const DEFAULT_CONTAINER_BACKUP_DIR = "/var/lib/zedbot/backups";

export const BACKUP_PARTIAL_SUFFIX = ".partial";
export const BACKUP_MANIFEST_SUFFIX = ".manifest.json";

/** New custom-format dumps (optionally encrypted) + legacy plain gzip SQL. */
export const BACKUP_DUMP_RE = /^zedbot-db-(\d{8}-\d{6})\.dump(\.enc)?$/;
export const BACKUP_LEGACY_RE = /^zedbot-db-(\d{8}-\d{6})\.sql\.gz$/;

export type BackupFileKind = "dump" | "dump-encrypted" | "legacy-sql-gz";

export function classifyBackupFileName(
  name: string,
): { kind: BackupFileKind; shortId: string } | null {
  const dump = BACKUP_DUMP_RE.exec(name);
  if (dump !== null) {
    return { kind: dump[2] === undefined ? "dump" : "dump-encrypted", shortId: dump[1] };
  }
  const legacy = BACKUP_LEGACY_RE.exec(name);
  if (legacy !== null) {
    return { kind: "legacy-sql-gz", shortId: legacy[1] };
  }
  return null;
}

export function backupDumpFileName(stamp: string, encrypted: boolean): string {
  return `zedbot-db-${stamp}.dump${encrypted ? ".enc" : ""}`;
}

// --- log group setup -------------------------------------------------------------------------------

/**
 * Deep-link payload for the log-group connection wizard. The wizard shows a
 * URL button https://t.me/<bot_username>?startgroup=<payload>; Telegram adds
 * the bot to the chosen group and posts "/start <payload>" there, which the
 * group-side setup handler turns into the binding confirmation prompt.
 */
export const LOG_GROUP_STARTGROUP_PAYLOAD = "zedlog";

// --- log topics ------------------------------------------------------------------------------------

/** Stable operational topic keys (behavior binds to keys, never titles). */
export const OPS_LOG_TOPIC_KEYS = [
  "SYSTEM",
  "ERROR",
  "PAYMENT",
  "ORDER",
  "SERVICE",
  "PANEL",
  "SECURITY",
  "BACKUP",
  "SUPPORT",
  "BROADCAST",
  "AUDIT",
] as const;
export type OpsLogTopicKey = (typeof OPS_LOG_TOPIC_KEYS)[number];

/** Default (operator-editable) Persian titles per stable key. */
export const OPS_LOG_TOPIC_TITLES: Record<OpsLogTopicKey, string> = {
  SYSTEM: "سیستم",
  ERROR: "خطاها",
  PAYMENT: "پرداخت‌ها",
  ORDER: "سفارش‌ها",
  SERVICE: "سرویس‌ها",
  PANEL: "پنل‌ها",
  SECURITY: "امنیت",
  BACKUP: "بکاپ‌ها",
  SUPPORT: "پشتیبانی",
  BROADCAST: "پیام همگانی",
  AUDIT: "گزارش حسابرسی",
};

// --- secret redaction --------------------------------------------------------------------------------

const SECRET_KEY_RE =
  /token|password|passwd|secret|authorization|cookie|database_url|api_?key|merchant_?id|subscription_?url|subscription_?token|sub_?id|remote_?client_?id|config|credential|private_?key|encrypted/i;

const SECRET_VALUE_RES: RegExp[] = [
  /postgres(?:ql)?:\/\/\S+/gi,
  /redis:\/\/\S+/gi,
  /(?:vless|vmess|trojan|ss):\/\/\S+/gi,
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, // Telegram bot token shape
  /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /\b[A-Fa-f0-9]{48,}\b/g, // long hex secrets
];

export const REDACTED_VALUE = "[redacted]";

/** Scrubs secret-looking substrings out of a free-text string. */
export function scrubSecretsFromText(text: string): string {
  let out = text;
  for (const re of SECRET_VALUE_RES) {
    out = out.replace(re, REDACTED_VALUE);
  }
  return out;
}

/**
 * Deep-sanitizes structured metadata before it is persisted or delivered:
 * every key matching the secret denylist is replaced with [redacted], every
 * string value is scrubbed for secret-shaped substrings, depth/size are
 * bounded so a hostile payload cannot explode the log row. Callers should
 * STILL prefer explicit allowlisted fields - this is the last line, not the
 * policy.
 */
export function sanitizeOpsMetadata(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return "[truncated]";
  }
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    const scrubbed = scrubSecretsFromText(value);
    return scrubbed.length > 500 ? `${scrubbed.slice(0, 500)}…` : scrubbed;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeOpsMetadata(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (count >= 30) {
        out["…"] = "[truncated]";
        break;
      }
      count += 1;
      out[key] = SECRET_KEY_RE.test(key) ? REDACTED_VALUE : sanitizeOpsMetadata(val, depth + 1);
    }
    return out;
  }
  return String(value);
}
