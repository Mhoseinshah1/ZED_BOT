import { logger } from "../core/logger.js";
import { generateQrPng } from "./qr-code.service.js";

// =============================================================================
// QR photo DELIVERY (service-config-qrcode phase) - the safe, bounded, fail-soft
// layer that turns stored subscription / config strings into Telegram QR photos.
// Shared by the user-service callbacks and the post-purchase fulfillment path so
// the captions, ordering, bounds and failure handling can never drift.
//
// SAFETY: the raw subscription URL, config strings, QR payloads and image bytes
// NEVER appear in a caption, filename, log, metric or exception. Logs carry only
// safe event names and counts. Delivery is fail-soft: a generation or Telegram
// send failure is counted and the caller falls back to the copyable text link -
// it never crashes the bot and never marks anything failed.
// =============================================================================

/** Telegram-facing filenames - deliberately generic, they never carry the payload. */
export const SUBSCRIPTION_QR_FILENAME = "subscription-qr.png";
export const CONFIG_QR_FILENAME = "config-qr.png";

/** At most this many config QRs are ever generated/sent for one service. */
export const MAX_CONFIG_QRS = 10;

// --- user-facing texts (§8) --------------------------------------------------
export const QR_NO_SUBSCRIPTION_TEXT = "لینک اشتراک برای این سرویس ثبت نشده است.";
export const QR_NO_CONFIGS_TEXT = "کانفیگی برای این سرویس ثبت نشده است.";
export const QR_GENERATION_FAILED_TEXT =
  "ساخت کیوآرکد این کانفیگ ممکن نشد؛ لینک متنی همچنان قابل استفاده است.";
export const QR_SEND_FAILED_TEXT = "ارسال تصویر کیوآرکد ناموفق بود؛ از لینک متنی استفاده کنید.";

// --- captions (plain text - NEVER the raw payload) ---------------------------
/** Subscription QR caption: a fixed label + the public account identity only. */
export function subscriptionQrCaption(accountLabel: string): string {
  return `کیوآرکد لینک اشتراک\nنام سرویس: ${accountLabel}`;
}

/** Per-config QR caption: the position + the public account identity only. */
export function configQrCaption(index: number, total: number, accountLabel: string): string {
  return `کانفیگ ${index} از ${total}\nنام سرویس: ${accountLabel}`;
}

/** Trailing summary when more than MAX_CONFIG_QRS configs exist (counts only). */
export function configOverflowSummary(remaining: number): string {
  return `۱۰ کانفیگ اول به‌صورت QR ارسال شد.\n${remaining} کانفیگ دیگر نمایش داده نشد.`;
}

/** Trailing summary when some configs could not be turned into a QR (count only). */
export function configFailureSummary(failedCount: number): string {
  return `ساخت کیوآرکد ${failedCount} کانفیگ ممکن نشد؛ لینک متنی همچنان قابل استفاده است.`;
}

/**
 * A fail-soft photo sender the caller supplies. It receives an in-memory PNG plus
 * a safe caption/filename and returns whether the Telegram send SUCCEEDED. It must
 * never throw - a blocked user / deleted chat resolves to `false`, not an exception.
 */
export type QrPhotoSender = (args: {
  png: Buffer;
  caption: string;
  filename: string;
}) => Promise<boolean>;

export type SubscriptionQrOutcome = "SENT" | "GEN_FAILED" | "SEND_FAILED";

/**
 * Generates the subscription QR from the EXACT stored subscriptionUrl and sends it
 * once. Returns a typed outcome so the caller can show the right fallback; logs
 * only the outcome, never the URL.
 */
export async function deliverSubscriptionQr(
  subscriptionUrl: string,
  accountLabel: string,
  send: QrPhotoSender,
): Promise<SubscriptionQrOutcome> {
  const qr = await generateQrPng(subscriptionUrl);
  if (!qr.ok) {
    logger.warn("qr subscription generation failed", { reason: qr.reason });
    return "GEN_FAILED";
  }
  const sent = await send({
    png: qr.png,
    caption: subscriptionQrCaption(accountLabel),
    filename: SUBSCRIPTION_QR_FILENAME,
  });
  logger.info("qr subscription delivery", { sent });
  return sent ? "SENT" : "SEND_FAILED";
}

export interface ConfigQrDeliveryResult {
  /** Total valid config links stored for the service. */
  total: number;
  /** How many we attempted (min(total, MAX_CONFIG_QRS)). */
  attempted: number;
  /** Photos successfully delivered. */
  sent: number;
  /** Links whose QR could not be generated (payload never leaked). */
  genFailed: number;
  /** Photos whose Telegram send failed (fail-soft, counted). */
  sendFailed: number;
  /** Configs beyond the cap that were deliberately not shown (never leaked). */
  skipped: number;
}

/**
 * Generates exactly ONE QR per individual config link (never one QR containing
 * several joined configs), preserving the original order, bounded to the first
 * MAX_CONFIG_QRS. Sends them SEQUENTIALLY so at most one QR buffer is alive at a
 * time (no unbounded simultaneous generation) and Telegram limits are respected.
 * A single config that cannot be encoded or sent is counted and skipped - the
 * rest continue. Returns the delivery counts so the caller can render a safe
 * trailing summary; the raw configs never appear anywhere.
 */
export async function deliverConfigQrCodes(
  links: string[],
  accountLabel: string,
  send: QrPhotoSender,
): Promise<ConfigQrDeliveryResult> {
  const shown = links.slice(0, MAX_CONFIG_QRS);
  let sent = 0;
  let genFailed = 0;
  let sendFailed = 0;
  for (let i = 0; i < shown.length; i += 1) {
    const qr = await generateQrPng(shown[i] ?? "");
    if (!qr.ok) {
      genFailed += 1;
      continue;
    }
    const ok = await send({
      png: qr.png,
      caption: configQrCaption(i + 1, shown.length, accountLabel),
      filename: CONFIG_QR_FILENAME,
    });
    if (ok) {
      sent += 1;
    } else {
      sendFailed += 1;
    }
  }
  const result: ConfigQrDeliveryResult = {
    total: links.length,
    attempted: shown.length,
    sent,
    genFailed,
    sendFailed,
    skipped: Math.max(0, links.length - MAX_CONFIG_QRS),
  };
  logger.info("qr config delivery", {
    total: result.total,
    attempted: result.attempted,
    sent: result.sent,
    genFailed: result.genFailed,
    sendFailed: result.sendFailed,
    skipped: result.skipped,
  });
  return result;
}
