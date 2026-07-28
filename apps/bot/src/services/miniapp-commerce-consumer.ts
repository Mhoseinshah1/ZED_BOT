import {
  CheckoutStatus,
  OrderStatus,
  PaymentStatus,
  prisma,
} from "@zedbot/database";
import {
  createLogger,
  errorMessage,
  getRedisOptions,
  MINIAPP_COMMERCE_JOB_NAMES,
  MINIAPP_COMMERCE_QUEUE_NAME,
} from "@zedbot/shared";
import { Worker, type Job } from "bullmq";

import {
  decryptSecret,
} from "@zedbot/shared";
import { notifyAdminsAboutReceipt } from "./admin-receipt-notification.service.js";
import { fulfillSettledGatewayOrder } from "./gateway-settlement-runner.service.js";
import { dispatchPaidOrderFulfillment } from "./order-fulfillment.service.js";
import type { DeliverySendApi } from "./other-product-delivery.service.js";

// =============================================================================
// Mini App commerce follow-up consumer (miniapp-commerce-parity).
//
// The API process settles Mini-App-initiated payments (wallet CAS, gateway
// settle-on-poll) but owns no Telegram Api and no panel adapters — so it
// enqueues ONE durable follow-up job per settlement and THIS consumer, in the
// bot process, runs the Telegram-facing half: the unified fulfilment
// dispatcher, post-settlement notices and the admin receipt fan-out. Same
// producer/consumer split as the wallet auto-renewal engine.
//
// Every handler is idempotent: fulfilment executors are CAS-claimed, the
// receipt fan-out re-checks the payment is still PENDING_REVIEW, and the
// settlement sweep remains the recovery path for lost jobs — so duplicate
// delivery, retries and restarts converge, never double-execute.
//
// Redis unconfigured → the consumer does not start; the sweeps carry alone.
// =============================================================================

const log = createLogger("bot:miniapp-consumer");

export interface MiniAppCommerceConsumer {
  stop: () => Promise<void>;
}

/** The grammY api surface the follow-ups need (send* only — never receives). */
type FollowUpApi = DeliverySendApi &
  Parameters<typeof notifyAdminsAboutReceipt>[0] &
  Parameters<typeof fulfillSettledGatewayOrder>[0];

async function fulfillOrderJob(api: FollowUpApi, orderId: string): Promise<string> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { user: true },
  });
  if (order === null) {
    return "order-missing";
  }
  if (order.status !== OrderStatus.PAID) {
    return "not-paid"; // already dispatched (or terminal) — idempotent no-op
  }
  await dispatchPaidOrderFulfillment(api, order.id, {
    source: "WALLET",
    user: order.user,
  });
  return "dispatched";
}

async function gatewayFulfillJob(api: FollowUpApi, paymentId: string): Promise<string> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { order: true },
  });
  if (payment === null) {
    return "payment-missing";
  }
  if (payment.status !== PaymentStatus.APPROVED || payment.settlementStatus !== "SETTLED") {
    return "not-settled";
  }
  await fulfillSettledGatewayOrder(api, {
    kind: "already",
    payment,
    order: payment.order,
    purpose: payment.purpose,
  });
  return "fulfilled";
}

async function notifyReceiptJob(api: FollowUpApi, paymentId: string): Promise<string> {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { user: true, checkoutSession: true, receipts: true },
  });
  if (payment === null || payment.checkoutSession === null) {
    return "payment-missing";
  }
  if (payment.status !== PaymentStatus.PENDING_REVIEW) {
    return "not-pending-review"; // reviewed before the job ran — nothing to announce
  }
  if (payment.checkoutSession.status !== CheckoutStatus.PENDING) {
    return "checkout-not-pending";
  }
  const receipt = payment.receipts.find((r) => r.status === PaymentStatus.PENDING_REVIEW);
  const payload =
    typeof payment.callbackPayload === "object" &&
    payment.callbackPayload !== null &&
    !Array.isArray(payment.callbackPayload)
      ? (payment.callbackPayload as Record<string, unknown>)
      : {};
  const cardAccountId =
    typeof payload.cardAccountId === "string" ? payload.cardAccountId : undefined;
  let cardNumber: string | undefined;
  if (cardAccountId !== undefined) {
    const account = await prisma.cardToCardAccount.findUnique({
      where: { id: cardAccountId },
      select: { cardNumberEncrypted: true },
    });
    if (account !== null) {
      try {
        cardNumber = decryptSecret(account.cardNumberEncrypted);
      } catch {
        cardNumber = undefined; // masked line simply omitted
      }
    }
  }
  const reached = await notifyAdminsAboutReceipt(api, {
    payment,
    checkout: payment.checkoutSession,
    user: payment.user,
    receiptKind: "TEXT",
    ...(receipt?.text != null && receipt.text !== "" ? { receiptText: receipt.text } : {}),
    ...(receipt?.uploadId != null ? { uploadId: receipt.uploadId } : {}),
    ...(cardNumber !== undefined ? { cardNumber } : {}),
    ...(cardAccountId !== undefined ? { cardAccountId } : {}),
  });
  return `notified:${reached}`;
}

/** Starts the follow-up consumer. Returns null when Redis is unconfigured. */
export function startMiniAppCommerceConsumer(
  api: FollowUpApi,
): MiniAppCommerceConsumer | null {
  const options = getRedisOptions();
  if (options === null) {
    log.warn("redis not configured; miniapp commerce follow-up consumer not started");
    return null;
  }
  const worker = new Worker(
    MINIAPP_COMMERCE_QUEUE_NAME,
    async (job: Job): Promise<Record<string, unknown>> => {
      const data = (job.data ?? {}) as Record<string, unknown>;
      if (job.name === MINIAPP_COMMERCE_JOB_NAMES.FULFILL_ORDER) {
        const orderId = typeof data.orderId === "string" ? data.orderId : "";
        return { outcome: await fulfillOrderJob(api, orderId) };
      }
      if (job.name === MINIAPP_COMMERCE_JOB_NAMES.GATEWAY_FULFILL) {
        const paymentId = typeof data.paymentId === "string" ? data.paymentId : "";
        return { outcome: await gatewayFulfillJob(api, paymentId) };
      }
      if (job.name === MINIAPP_COMMERCE_JOB_NAMES.NOTIFY_RECEIPT) {
        const paymentId = typeof data.paymentId === "string" ? data.paymentId : "";
        return { outcome: await notifyReceiptJob(api, paymentId) };
      }
      throw new Error(`unknown job: ${job.name}`);
    },
    {
      connection: {
        host: options.host,
        port: options.port,
        password: options.password,
        maxRetriesPerRequest: null,
      },
      concurrency: 2,
    },
  );
  worker.on("failed", (job, err) => {
    log.warn("miniapp commerce follow-up job failed", {
      job: job?.name ?? "unknown",
      error: errorMessage(err),
    });
  });
  log.info("miniapp commerce follow-up consumer started");
  return {
    stop: async (): Promise<void> => {
      await worker.close();
    },
  };
}
