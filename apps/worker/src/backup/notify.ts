import { BackupOperationStatus, prisma } from "@zedbot/database";
import { createLogger } from "@zedbot/shared";

import { botToken } from "../config.js";
import { sendTelegramMessage } from "../telegram.js";

// =============================================================================
// SEND_BACKUP_NOTIFICATION: a short, safe Persian summary to the requesting
// OWNER's private chat. Skips silently when there is no requesting admin,
// no resolvable Telegram id or no resolvable Telegram token (botToken() → the
// shared resolver: TELEGRAM_BOT_TOKEN canonical / BOT_TOKEN legacy fallback).
// Message content is built ONLY from safe fields (filename, size, status,
// safeErrorCode).
// =============================================================================

const logger = createLogger("worker:backup-notify");

function humanSize(bytes: bigint | null): string {
  if (bytes === null) {
    return "-";
  }
  const mb = Number(bytes) / (1024 * 1024);
  if (mb >= 1) {
    return `${mb.toFixed(1)} MB`;
  }
  return `${(Number(bytes) / 1024).toFixed(0)} KB`;
}

function composeMessage(operation: {
  status: BackupOperationStatus;
  filename: string | null;
  sizeBytes: bigint | null;
  safeErrorCode: string | null;
}): string {
  const failed =
    operation.status === BackupOperationStatus.FAILED ||
    operation.status === BackupOperationStatus.CANCELLED;
  if (failed) {
    const reason = operation.safeErrorCode ?? "unknown";
    return ["ساخت بکاپ ناموفق بود ❌", `دلیل: ${reason}`].join("\n");
  }
  const verifiedLine =
    operation.status === BackupOperationStatus.VERIFIED
      ? "تایید صحت: انجام شد ✅"
      : operation.status === BackupOperationStatus.CORRUPT
        ? "تایید صحت: ناموفق ⚠️"
        : "تایید صحت: در انتظار";
  return [
    "بکاپ دیتابیس با موفقیت ساخته شد ✅",
    `فایل: ${operation.filename ?? "-"}`,
    `حجم: ${humanSize(operation.sizeBytes)}`,
    verifiedLine,
  ].join("\n");
}

export interface NotifyResult {
  sent: boolean;
  reason: string | null;
}

/** Notifies the requesting owner about the operation's final state. */
export async function sendBackupNotification(operationId: string): Promise<NotifyResult> {
  const operation = await prisma.backupOperation.findUnique({ where: { id: operationId } });
  if (operation === null) {
    return { sent: false, reason: "operation-missing" };
  }
  if (operation.requestedByAdminId === null) {
    return { sent: false, reason: "no-requesting-admin" }; // Scheduled runs, etc.
  }
  const token = botToken();
  if (token === null) {
    return { sent: false, reason: "no-bot-token" };
  }
  const admin = await prisma.admin.findUnique({ where: { id: operation.requestedByAdminId } });
  if (admin === null) {
    return { sent: false, reason: "admin-missing" };
  }

  const result = await sendTelegramMessage({
    token,
    chatId: admin.telegramId.toString(),
    text: composeMessage(operation),
  });
  if (result.ok) {
    return { sent: true, reason: null };
  }
  if (result.retryable) {
    // Let BullMQ retry with backoff (429 / network / 5xx).
    throw new Error(`backup notification failed: ${result.safeErrorCode}`);
  }
  // Permanent (forbidden, chat-not-found): log locally and give up quietly.
  logger.warn("backup notification skipped", { safeErrorCode: result.safeErrorCode });
  return { sent: false, reason: result.safeErrorCode };
}
