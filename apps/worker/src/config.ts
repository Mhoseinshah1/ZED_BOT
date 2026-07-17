import { DEFAULT_CONTAINER_BACKUP_DIR, intEnv, normalizeGitSha, optionalEnv } from "@zedbot/shared";

// =============================================================================
// Worker configuration - every env read lives here so the rest of the worker
// never touches process.env directly (except DATABASE_URL, which is consumed
// only by the pg_dump spawner and never logged).
// =============================================================================

/** Directory that receives backup dumps (bind-mounted volume in prod). */
export function backupDir(): string {
  return optionalEnv("BACKUP_DIR", DEFAULT_CONTAINER_BACKUP_DIR);
}

/** Watchdog for pg_dump / pg_restore child processes (default 10 minutes). */
export function backupTimeoutMs(): number {
  const value = intEnv("BACKUP_TIMEOUT_MS", 10 * 60_000);
  return value > 0 ? value : 10 * 60_000;
}

/** Backups older than this many days become cleanup candidates. */
export function backupRetentionDays(): number {
  const value = intEnv("BACKUP_RETENTION_DAYS", 14);
  return value > 0 ? value : 14;
}

/** The newest N backups are never deleted regardless of age. */
export function backupMinRetained(): number {
  const value = intEnv("BACKUP_MIN_RETAINED", 3);
  return value >= 0 ? value : 3;
}

/** Scheduled-backup preflight refuses to run below this much free disk. */
export function backupMinFreeDiskMb(): number {
  const value = intEnv("BACKUP_MIN_FREE_DISK_MB", 500);
  return value > 0 ? value : 500;
}

/** Non-empty BACKUP_ENCRYPTION_PASSWORD switches dumps to the ZBK1 envelope. */
export function backupEncryptionPassword(): string | null {
  const value = optionalEnv("BACKUP_ENCRYPTION_PASSWORD");
  return value === "" ? null : value;
}

/** Telegram bot token for notifications; the token itself is never logged. */
export function botToken(): string | null {
  const value = optionalEnv("BOT_TOKEN");
  return value === "" ? null : value;
}

/** Baked image build identity (GIT_SHA); null when built without it. */
export function gitSha(): string | null {
  return normalizeGitSha(optionalEnv("GIT_SHA"));
}

/** App version recorded into manifests (APP_VERSION, else GIT_SHA, else null). */
export function appVersion(): string | null {
  const version = optionalEnv("APP_VERSION");
  if (version !== "") {
    return version;
  }
  const sha = optionalEnv("GIT_SHA");
  return sha === "" ? null : sha;
}
