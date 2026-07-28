import {
  prisma,
  type CheckoutSession,
  type Payment,
  type User,
} from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";
import { InlineKeyboard, InputFile } from "grammy";

import { CB } from "../core/callbacks.js";
import { logger } from "../core/logger.js";
import { maskCardNumber } from "./admin-payment-method.service.js";
import { escapeHtml } from "../utils/html.js";

// =============================================================================
// Admin receipt notification (Phase 21.1): right after a user submits a
// manual receipt, every ACTIVE admin gets the actual receipt (photo/document
// forwarded by file_id, or the text) with full review context and a button
// into the EXISTING admin:rec:view detail page (approve/reject live there -
// nothing is duplicated here). Pure notification: no payment/order state
// changes, card numbers only ever MASKED, and any send failure is logged
// safely without affecting the submitted receipt.
// =============================================================================

export type ReceiptKind = "PHOTO" | "DOCUMENT" | "TEXT";

/** The Telegram API surface this service needs (mock-friendly). */
export interface ReceiptNotifyApi {
  sendPhoto(
    chatId: string,
    photo: string | InputFile,
    other?: Record<string, unknown>,
  ): Promise<unknown>;
  sendDocument(
    chatId: string,
    document: string | InputFile,
    other?: Record<string, unknown>,
  ): Promise<unknown>;
  sendMessage(chatId: string, text: string, other?: Record<string, unknown>): Promise<unknown>;
}

export interface ReceiptNotifyArgs {
  payment: Payment;
  checkout: CheckoutSession;
  user: User;
  receiptKind: ReceiptKind;
  receiptFileId?: string;
  receiptText?: string;
  /** Raw card number the user paid to (masked before sending; never logged). */
  cardNumber?: string;
  cardAccountId?: string;
  /** Browser-uploaded receipt (Mini App): MiniAppReceiptUpload row id. Sent
   * as bytes via InputFile — there is no Telegram file_id to re-send. */
  uploadId?: string;
}

const ORDER_TYPE_LABELS: Record<string, string> = {
  SERVICE_PURCHASE: "خرید سرویس",
  SERVICE_RENEWAL: "تمدید سرویس",
  EXTRA_VOLUME: "حجم اضافه",
  EXTRA_TIME: "زمان اضافه",
  OTHER_PRODUCT: "محصول دیگر",
};

function paymentTypeLabel(checkout: CheckoutSession): string {
  if (checkout.purpose === "WALLET_CHARGE") {
    return "شارژ کیف پول 🏦";
  }
  if (checkout.orderType !== null && ORDER_TYPE_LABELS[checkout.orderType] !== undefined) {
    return ORDER_TYPE_LABELS[checkout.orderType];
  }
  return "پرداخت سفارش";
}

function formatToman(value: number): string {
  return `${value.toLocaleString("en-US")} تومان`;
}

/** Caption/message shown to admins - card number MASKED, receipt text capped. */
export function buildReceiptNotificationText(
  args: ReceiptNotifyArgs,
  cardOwnerName: string | null,
): string {
  const { payment, checkout, user } = args;
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ");
  const userParts = [`<code>${user.telegramId}</code>`];
  if (user.username !== null && user.username !== "") {
    userParts.push(`@${escapeHtml(user.username)}`);
  }
  if (fullName !== "") {
    userParts.push(escapeHtml(fullName));
  }
  const lines = [
    "رسید پرداخت جدید 🧾",
    "",
    `نوع پرداخت: ${paymentTypeLabel(checkout)}`,
    `مبلغ: <b>${formatToman(payment.amountToman)}</b>`,
    `کاربر: ${userParts.join(" | ")}`,
  ];
  if (args.cardNumber !== undefined) {
    const owner = cardOwnerName === null ? "" : ` (${escapeHtml(cardOwnerName)})`;
    lines.push(`شماره کارت پرداخت: <code>${maskCardNumber(args.cardNumber)}</code>${owner}`);
  }
  lines.push(
    `رسید: <code>${payment.id.slice(0, 8)}</code> | پیش‌فاکتور: <code>${checkout.id.slice(0, 8)}</code>`,
    `تاریخ ثبت: ${payment.createdAt.toISOString().replace("T", " ").slice(0, 16)} (UTC)`,
    "وضعیت: در انتظار بررسی ⏳",
  );
  if (args.receiptText !== undefined && args.receiptText !== "") {
    // Telegram photo/document captions are capped at 1024 chars - keep room.
    lines.push("", `متن رسید: ${escapeHtml(args.receiptText.slice(0, 500))}`);
  }
  return lines.join("\n");
}

export function receiptNotificationKeyboard(paymentSid: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("بررسی رسید 🧾", `admin:rec:view:${paymentSid}`)
    .row()
    .text("رسیدهای تایید نشده 💵", CB.ADMIN_RECEIPTS);
}

/**
 * Sends the review notification to every ACTIVE admin. NEVER throws and
 * never changes payment/order state: each admin send has its own try/catch
 * (one blocked admin never silences the rest) and total failure only logs a
 * safe warning - the user's submitted receipt stays untouched either way.
 * Returns how many admins were reached (for logging/tests).
 */
export async function notifyAdminsAboutReceipt(
  api: ReceiptNotifyApi,
  args: ReceiptNotifyArgs,
): Promise<number> {
  let reached = 0;
  try {
    const admins = await prisma.admin.findMany({
      where: { isActive: true },
      select: { telegramId: true },
    });
    if (admins.length === 0) {
      logger.warn("receipt notification: no active admins to notify", {
        paymentId: args.payment.id,
      });
      return 0;
    }
    const ownerName =
      args.cardAccountId === undefined
        ? null
        : ((
            await prisma.cardToCardAccount.findUnique({
              where: { id: args.cardAccountId },
              select: { ownerName: true },
            })
          )?.ownerName ?? null);

    const text = buildReceiptNotificationText(args, ownerName);
    const keyboard = receiptNotificationKeyboard(args.payment.id.slice(0, 8));
    // Browser-uploaded evidence: fetched once, sent to every admin as bytes.
    // The bytes never touch a log and never gain a public URL.
    let uploadFile: { file: InputFile; asPhoto: boolean } | null = null;
    if (args.uploadId !== undefined) {
      const upload = await prisma.miniAppReceiptUpload.findUnique({
        where: { id: args.uploadId },
        select: { bytes: true, mimeType: true },
      });
      if (upload !== null) {
        const name =
          upload.mimeType === "image/png"
            ? "receipt.png"
            : upload.mimeType === "image/jpeg"
              ? "receipt.jpg"
              : "receipt.pdf";
        uploadFile = {
          file: new InputFile(Buffer.from(upload.bytes), name),
          asPhoto: upload.mimeType !== "application/pdf",
        };
      }
    }
    for (const admin of admins) {
      const chatId = admin.telegramId.toString();
      try {
        if (uploadFile !== null) {
          if (uploadFile.asPhoto) {
            await api.sendPhoto(chatId, uploadFile.file, {
              caption: text,
              parse_mode: "HTML",
              reply_markup: keyboard,
            });
          } else {
            await api.sendDocument(chatId, uploadFile.file, {
              caption: text,
              parse_mode: "HTML",
              reply_markup: keyboard,
            });
          }
        } else if (args.receiptKind === "PHOTO" && args.receiptFileId !== undefined) {
          await api.sendPhoto(chatId, args.receiptFileId, {
            caption: text,
            parse_mode: "HTML",
            reply_markup: keyboard,
          });
        } else if (args.receiptKind === "DOCUMENT" && args.receiptFileId !== undefined) {
          await api.sendDocument(chatId, args.receiptFileId, {
            caption: text,
            parse_mode: "HTML",
            reply_markup: keyboard,
          });
        } else {
          await api.sendMessage(chatId, text, {
            parse_mode: "HTML",
            reply_markup: keyboard,
          });
        }
        reached += 1;
      } catch (err) {
        logger.warn("receipt notification: admin send failed", {
          paymentId: args.payment.id,
          error: errorMessage(err),
        });
      }
    }
  } catch (err) {
    logger.warn("receipt notification failed", {
      paymentId: args.payment.id,
      error: errorMessage(err),
    });
  }
  return reached;
}
