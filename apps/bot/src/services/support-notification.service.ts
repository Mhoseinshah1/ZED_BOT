import {
  abandonIntent,
  claimDueIntents,
  claimDueRecipients,
  claimIntentForTicket,
  type DeliverableIntent,
  expandRecipients,
  isSupportNotificationKind,
  markRecipientFailed,
  markRecipientSent,
  recoverStaleClaims,
  settleIntent,
  type SupportNotificationKind,
} from "@zedbot/support-tickets";

import { logger } from "../core/logger.js";
import type { DeliverySendApi } from "./other-product-delivery.service.js";
import { supportNotificationErrorCode } from "./support-notification-errors.js";
import { renderAdminTicketNotification } from "./support-ticket.service.js";

// =============================================================================
// Turning notification intents into Telegram messages.
//
// The intent is written in the same transaction as the message it describes, so
// by the time anything here runs the decision to notify is already durable, and
// each administrator has a durable obligation of their own. What is left is the
// part that fails for reasons the database does not control: Telegram being
// down, an administrator having blocked the bot, a process dying mid-fan-out.
//
// TWO CALLERS, ONE PATH. The handler that just wrote a ticket delivers
// immediately — an administrator waiting a sweep interval for a new ticket is a
// worse product — and the sweep delivers whatever the immediate attempt did
// not. Both go through the same guarded claim, so "did someone already send
// this?" is answered by the database rather than by hoping the two never
// overlap.
//
// WHY THE IMMEDIATE PATH STILL CLAIMS. It would be simpler to send first and
// mark afterwards. But a crash between send and mark leaves a sent-in-fact,
// pending-in-the-database row that the sweep re-sends — and the sweep would
// also be racing the in-flight immediate attempt every single time. Claiming
// first makes an overlap a no-op instead of a duplicate.
//
// NOTHING SENSITIVE IS LOGGED HERE. Not a raw Telegram error, not a chat id,
// not a username, not a subject, not a message, not a full ticket uuid, not an
// administrator id. A Telegram error string can contain any of those, and no
// amount of path-based redaction in the logger can find an arbitrary substring
// inside an arbitrary string — so the raw error never reaches the logger at
// all. What is logged is the intent id, a stable event code, a classified
// failure code, an attempt count and aggregate counts.
// =============================================================================

/** How often the sweep looks for work nobody delivered. */
const SWEEP_INTERVAL_MS = 60_000;

/** Bounded per tick: a backlog drains over several ticks rather than in one. */
const SWEEP_BATCH = 20;

/** What one intent's fan-out achieved. Aggregates only — no recipient identity. */
export interface IntentDeliveryResult {
  sent: number;
  failed: number;
  skipped: number;
  complete: boolean;
}

/**
 * Work ONE claimed intent: expand its fan-out, deliver what is due, settle.
 *
 * A recipient that succeeds is terminal and is never sent to again, so a retry
 * of this intent reaches only the administrators who did not get it. That is
 * the whole point of the recipient rows.
 */
async function deliverClaimedIntent(
  api: DeliverySendApi,
  intent: DeliverableIntent,
): Promise<IntentDeliveryResult> {
  if (!isSupportNotificationKind(intent.kind)) {
    // A code this build does not know — most likely a downgrade past the
    // version that introduced it. Park it rather than retrying forever.
    await abandonIntent(intent.id, "unknown-kind");
    logger.warn("support notification parked", {
      intentId: intent.id,
      reason: "unknown-kind",
    });
    return { sent: 0, failed: 0, skipped: 0, complete: true };
  }

  const rendered = await renderAdminTicketNotification(intent.ticketId, intent.kind);
  if (rendered === null) {
    // The ticket is gone. There is nothing to say and no retry can change that.
    await abandonIntent(intent.id, "ticket-missing");
    logger.warn("support notification parked", {
      intentId: intent.id,
      event: intent.kind,
      reason: "ticket-missing",
    });
    return { sent: 0, failed: 0, skipped: 0, complete: true };
  }

  await expandRecipients(intent.id);
  const recipients = await claimDueRecipients(intent.id);

  let sent = 0;
  let failed = 0;
  for (const recipient of recipients) {
    try {
      await api.sendMessage(recipient.adminChatId, rendered.text, {
        reply_markup: rendered.keyboard,
      });
      await markRecipientSent(recipient.id);
      sent += 1;
    } catch (err) {
      // The classified code, never the error itself: a Telegram error can echo
      // the chat id, the username or the message body.
      const code = supportNotificationErrorCode(err);
      await markRecipientFailed(recipient.id, recipient.attempts, code);
      failed += 1;
      logger.warn("support notification recipient failed", {
        intentId: intent.id,
        event: intent.kind,
        code,
        attempt: recipient.attempts,
      });
    }
  }

  const outcome = await settleIntent(intent.id, intent.attempts);
  return {
    sent,
    failed,
    skipped: outcome.skipped,
    complete: outcome.complete,
  };
}

/**
 * Deliver the pending intent for this ticket NOW.
 *
 * Returns how many administrators were reached ON THIS ATTEMPT, so existing
 * callers that reported that number keep reporting something meaningful. Never
 * throws: the mutation that caused this is already committed, and the intent
 * guarantees another attempt — failing the caller here would turn a delayed
 * notification into a failed ticket.
 */
export async function deliverTicketNotificationNow(
  api: DeliverySendApi,
  ticketId: string,
  kind: SupportNotificationKind,
): Promise<number> {
  try {
    const intent = await claimIntentForTicket(ticketId, kind);
    if (intent === null) {
      // Nothing to claim, or the sweep already owns it. Sending anyway is how
      // one ticket becomes two messages to every administrator.
      return 0;
    }
    const result = await deliverClaimedIntent(api, intent);
    return result.sent;
  } catch (err) {
    logger.warn("support notification attempt rejected", {
      event: kind,
      code: supportNotificationErrorCode(err),
    });
    return 0;
  }
}

/**
 * Deliver every intent that is currently due.
 *
 * Returns how many INTENTS were worked, not how many administrators were
 * reached: the caller is a sweep, and "did the backlog move?" is the question
 * it needs answered. Never throws — a sweep that dies on one bad row stops
 * delivering every other one.
 */
export async function deliverPendingNotifications(
  api: DeliverySendApi,
  limit = SWEEP_BATCH,
): Promise<number> {
  try {
    const claimed = await claimDueIntents(limit);
    for (const intent of claimed) {
      try {
        await deliverClaimedIntent(api, intent);
      } catch (err) {
        // One unworkable intent must not abort the rest of the batch. The claim
        // stays until the stale sweep returns it, which is the correct outcome
        // for a row that just made a worker throw.
        logger.error("support notification intent rejected", {
          intentId: intent.id,
          code: supportNotificationErrorCode(err),
        });
      }
    }
    return claimed.length;
  } catch (err) {
    logger.error("support notification claim rejected", {
      code: supportNotificationErrorCode(err),
    });
    return 0;
  }
}

/**
 * The sweep: recover abandoned claims, then deliver what is due.
 *
 * Recovery runs FIRST. A row stuck in SENDING is invisible to the claim query,
 * so a sweep that only claimed would step over exactly the rows that most need
 * attention.
 */
export async function runSupportNotificationSweep(api: DeliverySendApi): Promise<{
  recovered: number;
  delivered: number;
}> {
  const recovered = await recoverStaleClaims();
  if (recovered > 0) {
    logger.warn("support notification claims recovered", { recovered });
  }
  const delivered = await deliverPendingNotifications(api, SWEEP_BATCH);
  return { recovered, delivered };
}

// --- the production loop -----------------------------------------------------

/**
 * At most one loop per process.
 *
 * Startup is not the only place that could reach for this — a test harness, a
 * future admin "retry now" button, a second call added during a refactor — and
 * two loops would double every sweep's claim contention for no benefit.
 */
let loopStarted = false;

/** Exposed for tests: a module-level latch is otherwise unresettable. */
export function resetSupportNotificationLoopForTests(): void {
  loopStarted = false;
}

export function supportNotificationLoopStarted(): boolean {
  return loopStarted;
}

/**
 * Start durable notification delivery for this process.
 *
 * ONE BOUNDED TICK IMMEDIATELY, then the periodic sweep. Without the immediate
 * tick a backlog left by the previous process — the crash this whole mechanism
 * exists for — would sit untouched for a full interval after the restart that
 * was supposed to recover it.
 *
 * The first tick is fire-and-forget: startup must not block on Telegram, and a
 * failed tick must not prevent the interval from being armed. The interval is
 * unref'd so it never holds the process open, and its callback swallows
 * everything, so one failed tick cannot stop future ticks.
 */
export function startSupportNotificationLoop(api: DeliverySendApi): void {
  if (loopStarted) {
    return;
  }
  loopStarted = true;

  const tick = (): void => {
    void runSupportNotificationSweep(api)
      .then(({ recovered, delivered }) => {
        if (recovered > 0 || delivered > 0) {
          logger.info("support notification sweep", { recovered, delivered });
        }
      })
      .catch((err: unknown) => {
        // Swallowed on purpose: the next tick is already scheduled, and a
        // rejected promise here would otherwise take the process down.
        logger.error("support notification sweep rejected", {
          code: supportNotificationErrorCode(err),
        });
      });
  };

  tick();
  setInterval(tick, SWEEP_INTERVAL_MS).unref();
}
