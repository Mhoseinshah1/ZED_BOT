import { OrderType, prisma, type Order, type User } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { TRIAL_CONVERTED_USER_TEXT } from "./trial-conversion.service.js";
import {
  buildExtraTimeSuccessMessage,
  executeExtraTimeOrder,
  EXTRA_TIME_FAILED_USER_TEXT,
} from "./extra-time.service.js";
import {
  buildExtraVolumeSuccessMessage,
  executeExtraVolumeOrder,
  EXTRA_VOLUME_FAILED_USER_TEXT,
} from "./extra-volume.service.js";
import {
  initManualDelivery,
  notifyAdminsAboutManualOrder,
  userInfoButtonKeyboard,
  userInfoPromptText,
  type DeliverySendApi,
} from "./other-product-delivery.service.js";
import {
  autoDeliverStockOrder,
  notifyAdminsAboutStockAlert,
  type AutoDeliverOutcome,
} from "./other-product-stock.service.js";
import {
  buildServiceInfoMessage,
  PROVISION_FAILED_USER_TEXT,
  provisionPaidOrder,
} from "./provisioning.service.js";
import { approvalUserNotice } from "./receipt-review.service.js";
import {
  buildRenewalSuccessMessage,
  executeRenewalOrder,
  RENEWAL_FAILED_USER_TEXT,
} from "./service-renewal.service.js";
import { OPS_EVENTS, writeSystemLog } from "./system-log.service.js";

// =============================================================================
// Unified post-payment fulfillment (other-product-wallet phase): ONE dispatch
// for every definitively-successful payment, no matter how the money arrived
// (wallet / card-to-card receipt approval / Zarinpal / NOWPayments / Stars).
// Payment handlers commit their financial transaction first and then call
// dispatchPaidOrderFulfillment - never the executors directly - so the
// post-payment behavior is identical across methods and never duplicated.
//
// Idempotency: this function performs NO financial writes itself. Every
// executor it dispatches to is CAS-claimed (provisioning/renewal/extras),
// stock delivery resumes its own reserved item, and the manual-delivery init
// is unique per order - repeated dispatches converge on the existing state
// and the `created` flag gates prompts/notifications so users and admins are
// never spammed twice. Telegram sends happen strictly AFTER the payment
// transaction committed (this function must never run inside one).
//
// No secrets in logs: stock content, user-provided info and delivery texts
// never appear here.
// =============================================================================

/** Which payment method completed - picks the confirmation line only. */
export type FulfillmentSource = "WALLET" | "RECEIPT" | "GATEWAY";

/** First line of the OTHER_PRODUCT confirmation, per payment method. */
export function fulfillmentConfirmationLine(source: FulfillmentSource): string {
  switch (source) {
    case "WALLET":
      return "پرداخت از کیف پول با موفقیت انجام شد ✅";
    case "RECEIPT":
      return "رسید پرداخت شما تایید شد ✅";
    case "GATEWAY":
      return "پرداخت شما تایید شد ✅";
  }
}

/** Second line when the product requires user information. */
export const INFO_REQUIRED_FOLLOWUP_TEXT =
  "برای تکمیل سفارش، اطلاعات خواسته‌شده را ارسال کنید.";

/** Second line when the order waits for the admin delivery step. */
export const WAITING_FOR_DELIVERY_TEXT = "سفارش شما ثبت شد و در انتظار تحویل است.";

/** Structured outcome so callers can render their own admin-side summaries. */
export type DispatchResult =
  | {
      kind: "SERVICE";
      op: "provision" | "renew" | "extra_volume" | "extra_time";
      ok: boolean;
      refunded: boolean;
      error: string | null;
    }
  | {
      kind: "OTHER_PRODUCT";
      /** Stock auto-delivery outcome ("NOT_ELIGIBLE" = manual-only product). */
      auto: AutoDeliverOutcome["status"];
      /** Manual record state; null when the stock path finished the order. */
      manual: {
        ok: boolean;
        created: boolean;
        requiresInfo: boolean;
        recordShortId: string | null;
      } | null;
    }
  | { kind: "NONE"; reason: string };

/** Send helper that never throws (blocked users, closed chats, ...). */
async function sendSafe(
  api: DeliverySendApi,
  chatId: string,
  text: string,
  other?: Record<string, unknown>,
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, other);
  } catch (err) {
    logger.warn("fulfillment notice failed", { error: errorMessage(err) });
  }
}

async function fulfillOtherProduct(
  api: DeliverySendApi,
  order: Order,
  chatId: string,
  source: FulfillmentSource,
): Promise<DispatchResult> {
  const line = fulfillmentConfirmationLine(source);
  // Stock-eligible products (deliveryType STOCK_ITEM or stockEnabled, without
  // required user info) auto-deliver from the encrypted inventory; the stock
  // service itself sends the delivery message. Everything else - including
  // NO_STOCK and a send failure where the user received nothing - falls back
  // to the manual-delivery queue.
  const auto = await autoDeliverStockOrder(api, order.id);
  if (auto.status === "DELIVERED") {
    // Fresh deliveries only: an ALREADY_DELIVERED repeat did not change the
    // remaining count, so it must never re-alert the admins.
    await notifyAdminsAboutStockAlert(api, {
      productId: auto.item.productId,
      orderId: order.id,
    });
    return { kind: "OTHER_PRODUCT", auto: auto.status, manual: null };
  }
  if (auto.status === "ALREADY_DELIVERED") {
    return { kind: "OTHER_PRODUCT", auto: auto.status, manual: null };
  }
  if (auto.status === "SEND_FAILED") {
    logger.warn("stock auto-delivery failed; falling back to manual", { orderId: order.id });
  }

  const init = await initManualDelivery(order.id);
  if (!init.ok) {
    logger.error("manual delivery init after payment failed", {
      orderId: order.id,
      error: init.error,
    });
    await sendSafe(api, chatId, approvalUserNotice(OrderType.OTHER_PRODUCT));
    return {
      kind: "OTHER_PRODUCT",
      auto: auto.status,
      manual: { ok: false, created: false, requiresInfo: false, recordShortId: null },
    };
  }
  const manual = {
    ok: true,
    created: init.created,
    requiresInfo: init.requiresInfo,
    recordShortId: init.record.id.slice(0, 8),
  };
  if (!init.created) {
    // Repeat dispatch (sweep, replay, retry): the record and its prompts /
    // notifications already exist - converge silently on the current state.
    return { kind: "OTHER_PRODUCT", auto: auto.status, manual };
  }
  if (init.requiresInfo) {
    // Payment confirmed -> WAITING_USER_INFO. Admins are NOT notified yet -
    // that happens when the user submits the info (other-product-info
    // handler); the customer gets the configured prompt + the info button.
    await sendSafe(
      api,
      chatId,
      `${line}\n\n${INFO_REQUIRED_FOLLOWUP_TEXT}\n\n${userInfoPromptText(init.promptText)}`,
      { reply_markup: userInfoButtonKeyboard(order.id) },
    );
    return { kind: "OTHER_PRODUCT", auto: auto.status, manual };
  }
  // Payment confirmed -> WAITING_ADMIN_DELIVERY: tell the customer once and
  // tell the active admins the order is ready for delivery.
  await sendSafe(api, chatId, `${line}\n\n${WAITING_FOR_DELIVERY_TEXT}`);
  await notifyAdminsAboutManualOrder(api, init.record);
  return { kind: "OTHER_PRODUCT", auto: auto.status, manual };
}

/**
 * Ops-logging phase: ONE central event per SERVICE-kind dispatch outcome.
 * Provisioning goes to the ORDER topic, lifecycle ops (renew/extras) to the
 * SERVICE topic; a failure that kept the order PAID (refunded=false) is the
 * "remote-unknown / kept for review" case. Allowlisted fields only - the
 * executor's error text never enters the ops log.
 */
function logDispatchOpsEvent(orderId: string, result: DispatchResult): void {
  if (result.kind !== "SERVICE") {
    return;
  }
  const isProvision = result.op === "provision";
  void writeSystemLog({
    level: result.ok ? "INFO" : "ERROR",
    eventType: isProvision
      ? result.ok
        ? OPS_EVENTS.ORDER_PROVISIONED
        : OPS_EVENTS.ORDER_PROVISION_FAILED
      : result.ok
        ? OPS_EVENTS.SERVICE_OP_COMPLETED
        : OPS_EVENTS.SERVICE_OP_FAILED,
    message: result.ok
      ? `${result.op} completed`
      : `${result.op} failed (${result.refunded ? "refunded" : "kept-paid-for-review"})`,
    metadata: {
      op: result.op,
      outcome: result.ok ? "completed" : result.refunded ? "failed-refunded" : "failed-kept-paid",
    },
    topicKey: isProvision ? "ORDER" : "SERVICE",
    orderId,
  });
}

/**
 * Dispatches the post-payment fulfillment for one PAID order. Call it AFTER
 * the financial transaction committed - from the wallet handler, the receipt
 * approval handler or the gateway settlement - and never from inside a
 * database transaction. Safe to call repeatedly; never throws.
 */
export async function dispatchPaidOrderFulfillment(
  api: DeliverySendApi,
  orderId: string,
  options: { source: FulfillmentSource; user?: User },
): Promise<DispatchResult> {
  const result = await dispatchPaidOrderFulfillmentInner(api, orderId, options);
  logDispatchOpsEvent(orderId, result);
  return result;
}

async function dispatchPaidOrderFulfillmentInner(
  api: DeliverySendApi,
  orderId: string,
  options: { source: FulfillmentSource; user?: User },
): Promise<DispatchResult> {
  try {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (order === null) {
      return { kind: "NONE", reason: "order not found" };
    }
    const user =
      options.user !== undefined && options.user.id === order.userId
        ? options.user
        : await prisma.user.findUnique({ where: { id: order.userId } });
    if (user === null) {
      return { kind: "NONE", reason: "order has no user" };
    }
    const chatId = user.telegramId.toString();

    if (order.type === OrderType.SERVICE_PURCHASE) {
      const result = await provisionPaidOrder(order.id);
      if (result.ok) {
        await sendSafe(api, chatId, buildServiceInfoMessage(result.service), {
          parse_mode: "HTML",
        });
        return { kind: "SERVICE", op: "provision", ok: true, refunded: false, error: null };
      }
      await sendSafe(
        api,
        chatId,
        result.refunded ? PROVISION_FAILED_USER_TEXT : approvalUserNotice(order.type),
      );
      return {
        kind: "SERVICE",
        op: "provision",
        ok: false,
        refunded: result.refunded,
        error: result.error,
      };
    }

    if (order.type === OrderType.SERVICE_RENEWAL) {
      const result = await executeRenewalOrder(order.id);
      if (result.ok) {
        await sendSafe(api, chatId, buildRenewalSuccessMessage(result.service), {
          parse_mode: "HTML",
        });
        if (result.trialConverted === true) {
          // Trial-lifecycle phase: the ONE operation that converted the
          // trial sends the one-time notice (idempotent replays return
          // alreadyApplied and never re-enter this branch).
          await sendSafe(api, chatId, TRIAL_CONVERTED_USER_TEXT);
        }
        return { kind: "SERVICE", op: "renew", ok: true, refunded: false, error: null };
      }
      await sendSafe(
        api,
        chatId,
        result.refunded ? RENEWAL_FAILED_USER_TEXT : approvalUserNotice(order.type),
      );
      return {
        kind: "SERVICE",
        op: "renew",
        ok: false,
        refunded: result.refunded,
        error: result.error,
      };
    }

    if (order.type === OrderType.EXTRA_VOLUME) {
      const result = await executeExtraVolumeOrder(order.id);
      if (result.ok) {
        await sendSafe(
          api,
          chatId,
          buildExtraVolumeSuccessMessage(result.service, result.addedVolumeGb),
          { parse_mode: "HTML" },
        );
        if (result.trialConverted === true) {
          await sendSafe(api, chatId, TRIAL_CONVERTED_USER_TEXT);
        }
        return { kind: "SERVICE", op: "extra_volume", ok: true, refunded: false, error: null };
      }
      await sendSafe(
        api,
        chatId,
        result.refunded ? EXTRA_VOLUME_FAILED_USER_TEXT : approvalUserNotice(order.type),
      );
      return {
        kind: "SERVICE",
        op: "extra_volume",
        ok: false,
        refunded: result.refunded,
        error: result.error,
      };
    }

    if (order.type === OrderType.EXTRA_TIME) {
      const result = await executeExtraTimeOrder(order.id);
      if (result.ok) {
        await sendSafe(api, chatId, buildExtraTimeSuccessMessage(result.service, result.addedDays), {
          parse_mode: "HTML",
        });
        if (result.trialConverted === true) {
          await sendSafe(api, chatId, TRIAL_CONVERTED_USER_TEXT);
        }
        return { kind: "SERVICE", op: "extra_time", ok: true, refunded: false, error: null };
      }
      await sendSafe(
        api,
        chatId,
        result.refunded ? EXTRA_TIME_FAILED_USER_TEXT : approvalUserNotice(order.type),
      );
      return {
        kind: "SERVICE",
        op: "extra_time",
        ok: false,
        refunded: result.refunded,
        error: result.error,
      };
    }

    if (order.type === OrderType.OTHER_PRODUCT) {
      return fulfillOtherProduct(api, order, chatId, options.source);
    }

    await sendSafe(api, chatId, approvalUserNotice(order.type));
    return { kind: "NONE", reason: `unsupported order type ${order.type}` };
  } catch (err) {
    logger.error("paid order fulfillment dispatch crashed", {
      orderId,
      error: errorMessage(err),
    });
    return { kind: "NONE", reason: "dispatch crashed" };
  }
}
