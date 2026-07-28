import { PaymentStatus, prisma } from "@zedbot/database";
import { createLogger, errorMessage } from "@zedbot/shared";

// =============================================================================
// Browser receipt-upload retention sweep (miniapp-commerce-parity §13).
//
// MiniAppReceiptUpload rows carry the raw bytes of card-to-card receipts
// uploaded from the Mini App. Retention policy, enforced here:
//
//   1. ABANDONED uploads — never consumed into a ManualReceipt and past their
//      expiresAt — are DELETED. Nothing referenced them; nothing can.
//   2. CONSUMED uploads are kept while their payment can still be reviewed or
//      disputed, then DELETED once the linked payment reached a TERMINAL
//      state longer than the retention window ago. The ManualReceipt row (the
//      financial record) is never touched — only the bytes go; its uploadId
//      simply stops resolving, exactly like a Telegram file_id that aged out.
//
// Deletes are bounded per run and idempotent; counts only in logs — never a
// user id, byte size pattern, hash or filename.
// =============================================================================

const log = createLogger("worker:receipt-upload-cleanup");

const SCAN_BATCH = 200;
export const RECEIPT_UPLOAD_CLEANUP_INTERVAL_MS = 15 * 60_000;
/** How long consumed evidence outlives its payment's terminal state. */
export const CONSUMED_RETENTION_MS = 30 * 24 * 60 * 60_000;

const TERMINAL_PAYMENT_STATUSES = [
  PaymentStatus.APPROVED,
  PaymentStatus.REJECTED,
  PaymentStatus.FAILED,
  PaymentStatus.EXPIRED,
  PaymentStatus.CANCELLED,
  PaymentStatus.DELETED,
];

export interface ReceiptUploadCleanupResult {
  abandonedDeleted: number;
  retainedExpiredDeleted: number;
}

export async function runReceiptUploadCleanup(
  now: Date = new Date(),
): Promise<ReceiptUploadCleanupResult> {
  const result: ReceiptUploadCleanupResult = {
    abandonedDeleted: 0,
    retainedExpiredDeleted: 0,
  };
  try {
    // Pass 1: abandoned (unconsumed, expired). No receipt references these —
    // the FK from ManualReceipt is only ever written together with consumedAt.
    const abandoned = await prisma.miniAppReceiptUpload.findMany({
      where: { consumedAt: null, expiresAt: { lt: now }, manualReceipt: null },
      select: { id: true },
      take: SCAN_BATCH,
    });
    if (abandoned.length > 0) {
      const deleted = await prisma.miniAppReceiptUpload.deleteMany({
        where: {
          id: { in: abandoned.map((r) => r.id) },
          consumedAt: null,
          manualReceipt: null,
        },
      });
      result.abandonedDeleted = deleted.count;
    }

    // Pass 2: consumed evidence whose payment has been terminal long enough.
    const cutoff = new Date(now.getTime() - CONSUMED_RETENTION_MS);
    const retired = await prisma.miniAppReceiptUpload.findMany({
      where: {
        consumedAt: { not: null, lt: cutoff },
        manualReceipt: {
          is: {
            payment: {
              is: { status: { in: TERMINAL_PAYMENT_STATUSES }, updatedAt: { lt: cutoff } },
            },
          },
        },
      },
      select: { id: true },
      take: SCAN_BATCH,
    });
    if (retired.length > 0) {
      const deleted = await prisma.miniAppReceiptUpload.deleteMany({
        where: { id: { in: retired.map((r) => r.id) } },
      });
      result.retainedExpiredDeleted = deleted.count;
    }

    if (result.abandonedDeleted > 0 || result.retainedExpiredDeleted > 0) {
      log.info("receipt upload cleanup", { ...result });
    }
  } catch (err) {
    log.warn("receipt upload cleanup failed", { error: errorMessage(err) });
  }
  return result;
}

/** Self-rescheduling loop; timers unref()ed, errors logged never thrown. */
export function startReceiptUploadCleanupLoop(): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const tick = (): void => {
    void runReceiptUploadCleanup()
      .catch((err: unknown) => {
        log.warn("receipt upload cleanup rejected", { error: errorMessage(err) });
      })
      .finally(() => {
        if (!stopped) {
          timer = setTimeout(tick, RECEIPT_UPLOAD_CLEANUP_INTERVAL_MS);
          timer.unref();
        }
      });
  };
  timer = setTimeout(tick, RECEIPT_UPLOAD_CLEANUP_INTERVAL_MS);
  timer.unref();
  return (): void => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
    }
  };
}
