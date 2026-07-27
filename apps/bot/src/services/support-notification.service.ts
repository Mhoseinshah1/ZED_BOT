import { errorMessage } from "@zedbot/shared";
import {
  claimDueIntents,
  type DeliverableIntent,
  isSupportNotificationKind,
  markIntentFailed,
  markIntentSent,
  NOTIFICATION_MAX_ATTEMPTS,
  recoverStaleClaims,
} from "@zedbot/support-tickets";

import { logger } from "../core/logger.js";
import { supportNotificationErrorCode } from "./support-notification-errors.js";
import type { DeliverySendApi } from "./other-product-delivery.service.js";
import { renderAdminTicketNotification } from "./support-ticket.service.js";

// =============================================================================
// Turning notification intents into Telegram messages.
//
// The intent is written in the same transaction as the message it describes, so
// by the time anything here runs the decision to notify is already durable.
// What is left is the part that can fail for reasons nothing in the database
// controls: Telegram being down, an admin having blocked the bot, a process
// dying halfway through a fan-out.
//
// TWO CALLERS, ONE PATH. The handler that just wrote a ticket delivers
// immediately, because an admin waiting a sweep interval for a new ticket is a
// worse product. The sweep delivers whatever the immediate attempt did not.
// Both go through the same claim/settle cycle, so "did someone already send
// this?" is answered by the status-guarded claim rather than by hoping the two
// never overlap.
//
// WHY THE IMMEDIATE PATH STILL CLAIMS. It would be simpler to send first and
// mark the row afterwards. But then a crash between the send and the mark leaves
// a SENT-in-fact, PENDING-in-the-database intent that the sweep re-sends — and
// the sweep would ALSO be racing the in-flight immediate attempt every time.
// Claiming first makes the overlap a no-op instead of a duplicate.
// =============================================================================

/** How often the sweep looks for intents nobody delivered. */
const SWEEP_INTERVAL_MS = 60_000;

/** Bounded per tick: a backlog drains over several ticks rather than in one. */
const SWEEP_BATCH = 20;

/**
 * Deliver ONE claimed intent.
 *
 * A partial fan-out counts as a success when at least one admin was reached:
 * support has been told. Retrying the whole fan-out to reach the last admin
 * would re-message everyone who already got it, which is how a notification
 * channel becomes noise people mute.
 */
async function deliverClaimed(api: DeliverySendApi, intent: DeliverableIntent): Promise<number> {
  try {
    if (!isSupportNotificationKind(intent.kind)) {
      // A code this build does not know — most likely a downgrade past the
      // version that introduced it. Park it rather than retrying forever.
      await markIntentFailed(intent.id, NOTIFICATION_MAX_ATTEMPTS, "unknown-kind");
      return 0;
    }
    const rendered = await renderAdminTicketNotification(intent.ticketId, intent.kind);
    if (rendered === null) {
      // The ticket is gone. Nothing to say, and retrying cannot change that.
      await markIntentSent(intent.id, 0);
      return 0;
    }
    let reached = 0;
    let lastError: unknown = null;
    for (const chatId of rendered.adminChatIds) {
      try {
        await api.sendMessage(chatId, rendered.text, { reply_markup: rendered.keyboard });
        reached += 1;
      } catch (err) {
        lastError = err;
        logger.warn("support notification send failed for one admin", {
          intentId: intent.id,
          ticketId: intent.ticketId,
          error: errorMessage(err),
        });
      }
    }
    if (reached > 0 || rendered.adminChatIds.length === 0) {
      await markIntentSent(intent.id, reached);
      return reached;
    }
    await markIntentFailed(intent.id, intent.attempts, supportNotificationErrorCode(lastError));
    return 0;
  } catch (err) {
    logger.error("support notification delivery rejected", {
      intentId: intent.id,
      ticketId: intent.ticketId,
      error: errorMessage(err),
    });
    await markIntentFailed(intent.id, intent.attempts, supportNotificationErrorCode(err));
    return 0;
  }
}

/**
 * Deliver every intent that is currently due.
 *
 * Returns how many INTENTS were settled, not how many admins were reached: the
 * caller is a sweep, and "did the backlog move?" is the question it needs
 * answered. Never throws — a sweep that dies on one bad row stops delivering
 * every other one.
 */
export async function deliverPendingNotifications(
  api: DeliverySendApi,
  limit = SWEEP_BATCH,
): Promise<number> {
  try {
    const claimed = await claimDueIntents(limit);
    for (const intent of claimed) {
      await deliverClaimed(api, intent);
    }
    return claimed.length;
  } catch (err) {
    logger.error("support notification claim rejected", { error: errorMessage(err) });
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

/** Starts the periodic sweep. Unref'd so it never holds the process open. */
export function startSupportNotificationLoop(api: DeliverySendApi): void {
  const tick = (): void => {
    void runSupportNotificationSweep(api).catch((err: unknown) => {
      logger.error("support notification sweep rejected", { error: errorMessage(err) });
    });
  };
  setInterval(tick, SWEEP_INTERVAL_MS).unref();
}
