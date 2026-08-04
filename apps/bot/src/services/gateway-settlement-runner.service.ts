import {
  OrderStatus,
  PaymentPurpose,
  PaymentSettlementStatus,
  PaymentStatus,
  prisma,
} from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import {
  blockedServiceUnboundCheckoutIds,
  notifyDuplicateSuccessCase,
  notifyServiceUsernameUnboundCase,
  sweepUnnotifiedServiceUnboundCases,
} from "./financial-reconciliation.service.js";
import {
  ONLINE_PROVIDER_TYPES,
  settleGatewayPayment,
  type SettleOutcome,
} from "./gateway-payment.service.js";
import { dispatchPaidOrderFulfillment } from "./order-fulfillment.service.js";
import { type DeliverySendApi } from "./other-product-delivery.service.js";
import { getMessageTemplate } from "./text.service.js";

// =============================================================================
// Gateway settlement RUNNER (split out of gateway-payment.service in the
// miniapp-commerce-parity phase): post-settlement fulfillment + the sweep
// loop. This is the Telegram-facing half - it sends user notices through a
// grammY Api and drives the unified fulfillment dispatcher, so it must only
// ever run in the BOT process. The grammY-free money core (create / record /
// settle) stays in gateway-payment.service, which the Mini App API imports;
// keeping this file separate is what keeps grammY out of the API's runtime
// import graph (enforced by apps/api/tests/miniapp-import-graph.test.ts).
// =============================================================================

const SWEEP_BATCH_SIZE = 20;
const SWEEP_INTERVAL_MS = 60_000;
/** Pass 2 only re-fulfills orders that stayed PAID at least this long. */
const UNFULFILLED_ORDER_MIN_AGE_MS = 2 * 60_000;
/** PENDING gateway payments are expired this long AFTER their expiresAt. */
const STALE_PENDING_GRACE_MS = 30 * 60_000;

// --- fulfillment -----------------------------------------------------------------------

function formatToman(value: number): string {
  return `${value.toLocaleString("en-US")} تومان`;
}

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
    logger.warn("gateway fulfillment notice failed", { error: errorMessage(err) });
  }
}

/**
 * Post-settlement fulfillment: wallet top-ups get their success notice;
 * orders go through the UNIFIED post-payment dispatcher shared with the
 * wallet and receipt-approval paths (all executors CAS-claimed / idempotent,
 * so repeats are safe). Never throws.
 */
export async function fulfillSettledGatewayOrder(
  api: DeliverySendApi,
  outcome: SettleOutcome,
): Promise<void> {
  try {
    if (outcome.kind !== "settled" && outcome.kind !== "already") {
      return;
    }
    const payment = outcome.payment;
    const user = await prisma.user.findUnique({ where: { id: payment.userId } });
    if (user === null) {
      return;
    }

    if (outcome.purpose === PaymentPurpose.WALLET_CHARGE) {
      const text = [
        await getMessageTemplate("payment_success_text"),
        "",
        `مبلغ شارژ: ${formatToman(payment.amountToman)}`,
        `موجودی جدید: ${formatToman(user.balanceToman)}`,
      ].join("\n");
      await sendSafe(api, user.telegramId.toString(), text);
      return;
    }

    const order = outcome.order;
    if (order === null) {
      logger.error("gateway fulfillment has no order", { paymentId: payment.id });
      return;
    }
    await dispatchPaidOrderFulfillment(api, order.id, { source: "GATEWAY", user });
    // §3: a NEWLY filed username-reconciliation case alerts the OWNER admins
    // exactly once — AFTER the settlement committed and fulfillment ran (which
    // already sent the user the safe hold notice and blocked provisioning). The
    // alert send is non-blocking and never throws, so it cannot roll back the
    // provider-success settlement or delete the durable case.
    if (outcome.kind === "settled" && outcome.serviceUnbound?.created === true) {
      await notifyServiceUsernameUnboundCase(
        api,
        outcome.serviceUnbound.reconciliationCase,
        payment,
      );
    }
  } catch (err) {
    logger.error("gateway fulfillment crashed", { error: errorMessage(err) });
  }
}


// --- settlement sweep loop ---------------------------------------------------------------

/**
 * One sweep, never throws:
 *  - Pass 1: settle+fulfill payments whose provider SUCCESS was recorded
 *    (IPN/callback/Stars) but whose settlement has not run yet (bot was
 *    down, user never pressed the check button).
 *  - Pass 2 (crash recovery): re-fulfill APPROVED order payments whose order
 *    is still PAID (settled but fulfillment crashed) after a 2-minute grace.
 *    Orders with an existing manual-delivery record are excluded - they
 *    legitimately stay PAID until the admin delivers.
 *  - Expiry: PENDING gateway payments 30+ minutes past their expiresAt with
 *    no provider event flip to EXPIRED (CAS via the status filter).
 */
export async function runGatewaySettlementSweep(api: DeliverySendApi): Promise<void> {
  try {
    const ready = await prisma.payment.findMany({
      where: {
        provider: { in: ONLINE_PROVIDER_TYPES },
        providerStatus: "SUCCESS",
        status: { in: [PaymentStatus.PENDING, PaymentStatus.PROCESSING] },
        // P0 settlement phase: duplicate-review rows are locally terminal -
        // retrying them would loop forever (their checkout belongs to
        // another payment). The reconciliation queue owns them now.
        settlementStatus: PaymentSettlementStatus.UNSETTLED,
      },
      orderBy: { createdAt: "asc" },
      take: SWEEP_BATCH_SIZE,
      select: { id: true },
    });
    for (const row of ready) {
      const outcome = await settleGatewayPayment(row.id);
      if (outcome.kind === "settled" || outcome.kind === "already") {
        await fulfillSettledGatewayOrder(api, outcome);
      } else if (outcome.kind === "duplicate" && outcome.created) {
        // Notify exactly once - the case is already committed, so a crashed
        // notification is retried by the admin queue, never by re-filing.
        await notifyDuplicateSuccessCase(api, outcome.reconciliationCase, outcome.payment);
      }
    }

    const cutoff = new Date(Date.now() - UNFULFILLED_ORDER_MIN_AGE_MS);
    // Codex P1 fix: a SERVICE order whose username reservation could not be bound
    // is deliberately held PAID behind an OPEN/IN_REVIEW reconciliation case.
    // EXCLUDE those checkouts from the recovery batch so they are neither
    // re-notified on every one-minute sweep nor allowed to starve the bounded
    // batch and block genuinely unfulfilled orders. The case is resolved (and the
    // order provisioned) only via the OWNER retry-bind action.
    const blockedCheckoutIds = await blockedServiceUnboundCheckoutIds();
    const unfulfilled = await prisma.payment.findMany({
      where: {
        // miniapp-commerce-parity: wallet payments (provider null, purpose
        // PAY_WITH_WALLET) are included so a Mini-App-initiated wallet order
        // whose follow-up job was lost still gets fulfilled here. The bot's
        // own wallet flow dispatches inline, so for it this is pure backstop.
        OR: [
          { provider: { in: ONLINE_PROVIDER_TYPES }, purpose: PaymentPurpose.ORDER_PAYMENT },
          { provider: null, purpose: PaymentPurpose.PAY_WITH_WALLET },
        ],
        status: PaymentStatus.APPROVED,
        order: {
          is: {
            status: OrderStatus.PAID,
            updatedAt: { lt: cutoff },
            otherProductOrder: { is: null },
            ...(blockedCheckoutIds.length > 0
              ? { checkoutSessionId: { notIn: blockedCheckoutIds } }
              : {}),
          },
        },
      },
      include: { order: true },
      orderBy: { createdAt: "asc" },
      take: SWEEP_BATCH_SIZE,
    });
    for (const paymentWithOrder of unfulfilled) {
      if (paymentWithOrder.order === null) {
        continue;
      }
      await fulfillSettledGatewayOrder(api, {
        kind: "already",
        payment: paymentWithOrder,
        order: paymentWithOrder.order,
        purpose: paymentWithOrder.purpose,
      });
    }

    const expired = await prisma.payment.updateMany({
      where: {
        provider: { in: ONLINE_PROVIDER_TYPES },
        status: PaymentStatus.PENDING,
        providerStatus: null,
        expiresAt: { lt: new Date(Date.now() - STALE_PENDING_GRACE_MS) },
      },
      data: { status: PaymentStatus.EXPIRED },
    });
    if (expired.count > 0) {
      logger.info("expired stale gateway payments", { count: expired.count });
    }

    // Codex P2 fix: durably retry OWNER alerts for any SERVICE_USERNAME_UNBOUND
    // case that was committed but never notified (crash between commit and push,
    // or a transient send failure). Idempotent — each case is marked delivered.
    await sweepUnnotifiedServiceUnboundCases(api);
  } catch (err) {
    logger.error("gateway settlement sweep failed", { error: errorMessage(err) });
  }
}

/**
 * Self-rescheduling sweep loop: one sweep per minute, timers unref()ed so
 * they never keep the process alive, errors logged never thrown.
 */
export function startGatewaySettlementLoop(api: DeliverySendApi): void {
  const tick = (): void => {
    void runGatewaySettlementSweep(api)
      .catch((err: unknown) => {
        // runGatewaySettlementSweep never rejects, but the loop must survive
        // even if that guarantee is ever broken.
        logger.error("gateway settlement sweep rejected", { error: errorMessage(err) });
      })
      .finally(() => {
        setTimeout(tick, SWEEP_INTERVAL_MS).unref();
      });
  };
  setTimeout(tick, SWEEP_INTERVAL_MS).unref();
}
