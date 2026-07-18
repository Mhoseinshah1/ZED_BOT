import {
  AutomatedNotificationCategory,
  AutomatedNotificationStatus,
  Prisma,
  prisma,
} from "@zedbot/database";
import {
  NOTIF_BUTTON_KEYS,
  NOTIF_CHECKOUT_TEMPLATE_KEYS,
  NTF_ACTION_CODES,
  checkoutAbandonedDedupeKey,
  createLogger,
  errorMessage,
  paymentRetryDedupeKey,
  type NotificationButtonSpec,
  type NotificationPayloadSnapshot,
} from "@zedbot/shared";
import type { Queue } from "bullmq";

import { enqueueNotificationDelivery } from "./queues.js";
import {
  loadAbandonedCandidatePage,
  loadFailedPaymentCandidatePage,
  type CheckoutDisplay,
} from "./checkout-eligibility.js";
import {
  getAbandonedCheckoutConfig,
  getFailedPaymentConfig,
  isCheckoutRuleEnabled,
  isNotificationSystemEnabled,
} from "./settings.js";

// =============================================================================
// Checkout-payment SCAN (Phase 2). Reuses the notification scan queue: creates
// dedupe-guarded SCHEDULED AutomatedNotification rows for abandoned checkouts
// (per stage) and definitively-failed online payments (per payment), then
// enqueues each for the SAME delivery worker. Every eligibility decision comes
// from the shared evaluator (checkout-eligibility.ts) - identical to the admin
// preview and the delivery re-validation. The payload snapshot carries only safe
// display values + button specs; no secret, provider payload or full id.
// =============================================================================

const log = createLogger("worker:checkout-scan");

/** Cursor-batch size + a hard per-run cap (logged if hit) so one sweep is bounded. */
const BATCH_SIZE = 300;
const MAX_PER_SCAN = 3000;

export interface CheckoutScanResult {
  abandonedScanned: number;
  abandonedCreated: number;
  paymentScanned: number;
  paymentCreated: number;
  skipped: string | null;
  capped: boolean;
}

function abandonedButtons(): NotificationButtonSpec[] {
  return [
    { action: NTF_ACTION_CODES.CONTINUE_CHECKOUT, buttonTextKey: NOTIF_BUTTON_KEYS.CONTINUE_CHECKOUT },
    { action: NTF_ACTION_CODES.VIEW_CHECKOUT, buttonTextKey: NOTIF_BUTTON_KEYS.CHECKOUT_DETAILS },
    { action: NTF_ACTION_CODES.SUPPRESS_CHECKOUT, buttonTextKey: NOTIF_BUTTON_KEYS.STOP_CHECKOUT_REMINDERS },
  ];
}

function paymentButtons(): NotificationButtonSpec[] {
  return [
    { action: NTF_ACTION_CODES.CONTINUE_CHECKOUT, buttonTextKey: NOTIF_BUTTON_KEYS.RESELECT_PAYMENT },
    { action: NTF_ACTION_CODES.VIEW_CHECKOUT, buttonTextKey: NOTIF_BUTTON_KEYS.VIEW_ORDER },
    { action: NTF_ACTION_CODES.SUPPRESS_CHECKOUT, buttonTextKey: NOTIF_BUTTON_KEYS.STOP_PAYMENT_REMINDERS },
  ];
}

function abandonedPayload(display: CheckoutDisplay, stage: number, checkoutShort: string): NotificationPayloadSnapshot {
  const variables: Record<string, string | number> = {
    product_name: display.productName,
    payable_amount: display.payableAmount,
    checkout_reference: display.checkoutReference,
  };
  if (display.expiresIn !== "") {
    variables.expires_in = display.expiresIn;
  }
  return {
    templateKey: NOTIF_CHECKOUT_TEMPLATE_KEYS.ABANDONED_CHECKOUT,
    variables,
    buttons: abandonedButtons(),
    meta: { kind: "abandoned", stage, checkout: checkoutShort },
  };
}

function paymentPayload(display: CheckoutDisplay, checkoutShort: string): NotificationPayloadSnapshot {
  return {
    templateKey: NOTIF_CHECKOUT_TEMPLATE_KEYS.PAYMENT_RETRY,
    variables: {
      product_name: display.productName,
      payable_amount: display.payableAmount,
      checkout_reference: display.checkoutReference,
      payment_method: display.paymentMethod ?? "",
    },
    buttons: paymentButtons(),
    meta: { kind: "payment_retry", checkout: checkoutShort },
  };
}

interface CreateInput {
  type: "ABANDONED_CHECKOUT" | "PAYMENT_RETRY";
  userId: string;
  checkoutId: string;
  paymentId?: string;
  dedupeKey: string;
  availableUntil: Date | null;
  payload: NotificationPayloadSnapshot;
}

/** Creates one SCHEDULED row (dedupe-guarded) + enqueues delivery. */
async function persist(deliveryQueue: Queue, input: CreateInput, now: Date): Promise<boolean> {
  try {
    const row = await prisma.automatedNotification.create({
      data: {
        type: input.type,
        category: AutomatedNotificationCategory.PAYMENT,
        status: AutomatedNotificationStatus.SCHEDULED,
        userId: input.userId,
        checkoutSessionId: input.checkoutId,
        paymentId: input.paymentId ?? null,
        dedupeKey: input.dedupeKey,
        ruleVersion: 1,
        scheduledFor: now,
        availableUntil: input.availableUntil,
        payloadSnapshot: input.payload as unknown as Prisma.InputJsonObject,
      },
      select: { id: true },
    });
    await enqueueNotificationDelivery(deliveryQueue, row.id);
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return false; // dedupe row already exists for this (checkout, stage) / payment.
    }
    log.warn("checkout notification create failed", { error: errorMessage(err) });
    return false;
  }
}

/**
 * One checkout-payment scan sweep. Returns counts; `skipped` is a safe reason
 * when the whole sweep short-circuits (system disabled, no rule enabled).
 */
export async function runCheckoutNotificationScan(deliveryQueue: Queue): Promise<CheckoutScanResult> {
  const result: CheckoutScanResult = {
    abandonedScanned: 0,
    abandonedCreated: 0,
    paymentScanned: 0,
    paymentCreated: 0,
    skipped: null,
    capped: false,
  };
  if (!(await isNotificationSystemEnabled())) {
    return { ...result, skipped: "system-disabled" };
  }
  const [abandonedOn, paymentOn] = await Promise.all([
    isCheckoutRuleEnabled("abandoned"),
    isCheckoutRuleEnabled("payment"),
  ]);
  if (!abandonedOn && !paymentOn) {
    return { ...result, skipped: "no-rule-enabled" };
  }
  const now = new Date();

  // Payment retry first: it owns any checkout that also looks abandoned (Part S).
  if (paymentOn) {
    const config = await getFailedPaymentConfig();
    let cursor: string | undefined;
    for (;;) {
      const page = await loadFailedPaymentCandidatePage(config, now, BATCH_SIZE, cursor);
      if (page.length === 0) {
        break;
      }
      cursor = page[page.length - 1].paymentId;
      for (const c of page) {
        if (result.paymentScanned >= MAX_PER_SCAN) {
          result.capped = true;
          break;
        }
        result.paymentScanned += 1;
        if (!c.eligibility.eligible) {
          continue;
        }
        const created = await persist(
          deliveryQueue,
          {
            type: "PAYMENT_RETRY",
            userId: c.userId,
            checkoutId: c.checkoutId,
            paymentId: c.paymentId,
            dedupeKey: paymentRetryDedupeKey(c.paymentId),
            availableUntil: null,
            payload: paymentPayload(c.display, c.display.checkoutReference),
          },
          now,
        );
        if (created) {
          result.paymentCreated += 1;
        }
      }
      if (result.capped || page.length < BATCH_SIZE) {
        break;
      }
    }
  }

  if (abandonedOn) {
    const config = await getAbandonedCheckoutConfig();
    let cursor: string | undefined;
    for (;;) {
      const page = await loadAbandonedCandidatePage(config, now, BATCH_SIZE, cursor);
      if (page.length === 0) {
        break;
      }
      cursor = page[page.length - 1].checkoutId;
      for (const c of page) {
        if (result.abandonedScanned >= MAX_PER_SCAN) {
          result.capped = true;
          break;
        }
        result.abandonedScanned += 1;
        if (!c.eligibility.eligible) {
          continue;
        }
        // Conflict policy: prefer the payment-retry reminder for a checkout with
        // a retry-eligible failed payment when that rule is on.
        if (paymentOn && c.hasRetryableFailedPayment) {
          continue;
        }
        const created = await persist(
          deliveryQueue,
          {
            type: "ABANDONED_CHECKOUT",
            userId: c.userId,
            checkoutId: c.checkoutId,
            dedupeKey: checkoutAbandonedDedupeKey(c.checkoutId, c.eligibility.stage),
            availableUntil: null,
            payload: abandonedPayload(c.display, c.eligibility.stage, c.display.checkoutReference),
          },
          now,
        );
        if (created) {
          result.abandonedCreated += 1;
        }
      }
      if (result.capped || page.length < BATCH_SIZE) {
        break;
      }
    }
  }

  if (result.capped) {
    log.warn("checkout scan hit the per-run cap", { cap: MAX_PER_SCAN });
  }
  log.info("checkout notification scan complete", {
    abandonedScanned: result.abandonedScanned,
    abandonedCreated: result.abandonedCreated,
    paymentScanned: result.paymentScanned,
    paymentCreated: result.paymentCreated,
  });
  return result;
}
