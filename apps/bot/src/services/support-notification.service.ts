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
 * The handle a caller uses to wind the loop down.
 *
 * Shutdown needs BOTH halves of this. Stopping alone was not enough: it
 * cleared the interval and returned immediately, leaving a sweep that was
 * already running to finish against a database the next shutdown step was
 * about to disconnect. That sweep holds claims — rows sitting in SENDING — and
 * killing its connection mid-settle strands every one of them until the next
 * process's stale sweep rescues them, which is the outage this mechanism
 * exists to prevent.
 *
 * So stopping and draining are separate, and shutdown does both.
 */
export interface SupportNotificationLoopController {
  /**
   * Idempotently prevent any NEW tick. The interval is cleared and a callback
   * already queued on the event loop becomes a no-op. A tick already in flight
   * is NOT interrupted — killing it mid-send is how duplicates happen.
   */
  stop(): void;
  /**
   * Resolve once no tick is running.
   *
   * Never rejects: a tick's own failure is already contained, and a shutdown
   * step that throws would skip the steps after it. Safe to call before stop()
   * — it then waits out whatever is running plus anything the interval starts
   * while it waits — but shutdown calls stop() first so it terminates.
   */
  drain(): Promise<void>;
  /** stop() then drain(), in that order. What shutdown actually wants. */
  stopAndDrain(): Promise<void>;
}

/**
 * At most one loop per process.
 *
 * Startup is not the only place that could reach for this — a test harness, a
 * future admin "retry now" button, a second call added during a refactor — and
 * two loops would double every sweep's claim contention for no benefit.
 */
let activeLoop: SupportNotificationLoopController | null = null;

/**
 * Exposed for tests: stops any live timer AND waits for its tick, so neither a
 * timer nor an in-flight database query leaks into the next suite.
 */
export async function resetSupportNotificationLoopForTests(): Promise<void> {
  await activeLoop?.stopAndDrain();
}

export function supportNotificationLoopStarted(): boolean {
  return activeLoop !== null;
}

/** The sweep signature, injectable so fake-timer tests can count ticks. */
export type SupportSweepRunner = (
  api: DeliverySendApi,
) => Promise<{ recovered: number; delivered: number }>;

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
 * unref'd so it never holds the process open, and every tick's failure is
 * contained, so one failed tick cannot stop future ticks.
 *
 * NO OVERLAP. A tick that is still running when the interval fires suppresses
 * that firing rather than starting a second sweep beside it. Two sweeps in one
 * process would contend for the same claims and, after a stale recovery,
 * could work the same recovered rows — all to do work the next tick will find
 * waiting anyway.
 *
 * Calling this while a loop is already running returns the EXISTING controller
 * and arms nothing — two controllers over one timer would make stop() a
 * half-measure. After stop(), a fresh start builds a fresh loop, which is what
 * lets tests reset without process-global leakage.
 */
export function startSupportNotificationLoop(
  api: DeliverySendApi,
  sweep: SupportSweepRunner = runSupportNotificationSweep,
): SupportNotificationLoopController {
  if (activeLoop !== null) {
    return activeLoop;
  }

  let stopped = false;
  /**
   * The ticks that have started and not yet finished — what drain() awaits.
   * A Set rather than a single promise because "is anything running?" is the
   * question both the overlap guard and shutdown need answered.
   */
  const inFlight = new Set<Promise<void>>();

  const tick = (): void => {
    if (stopped) {
      // The interval is cleared in stop(), so this only guards the window
      // where a tick was already queued on the event loop when stop ran.
      return;
    }
    if (inFlight.size > 0) {
      // Still working. The backlog does not evaporate; the next tick gets it.
      return;
    }
    let started: Promise<{ recovered: number; delivered: number }>;
    try {
      started = sweep(api);
    } catch (err) {
      // A sweep that throws synchronously never produced a promise, so there
      // is nothing to track and nothing to drain.
      logger.error("support notification sweep rejected", {
        code: supportNotificationErrorCode(err),
      });
      return;
    }
    const run: Promise<void> = started
      .then(({ recovered, delivered }) => {
        if (recovered > 0 || delivered > 0) {
          logger.info("support notification sweep", { recovered, delivered });
        }
      })
      .catch((err: unknown) => {
        // Contained on purpose: the next tick is already scheduled, and a
        // rejected promise here would otherwise take the process down. It also
        // keeps drain() a promise that never rejects.
        logger.error("support notification sweep rejected", {
          code: supportNotificationErrorCode(err),
        });
      })
      .finally(() => {
        inFlight.delete(run);
      });
    inFlight.add(run);
  };

  tick();
  const timer = setInterval(tick, SWEEP_INTERVAL_MS);
  timer.unref();

  const controller: SupportNotificationLoopController = {
    stop(): void {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(timer);
      if (activeLoop === controller) {
        activeLoop = null;
      }
    },
    async drain(): Promise<void> {
      // Loops rather than awaiting once: called without stop() first, the
      // interval can start another tick while this awaits, and a drain that
      // returned with a sweep running would be exactly the lie this exists to
      // remove. After stop() the second pass finds an empty set immediately.
      while (inFlight.size > 0) {
        await Promise.allSettled([...inFlight]);
      }
    },
    async stopAndDrain(): Promise<void> {
      controller.stop();
      await controller.drain();
    },
  };
  activeLoop = controller;
  return controller;
}
