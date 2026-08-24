import { disconnectDatabase } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { createBot } from "./app.js";
import { getBotToken, getTelegramApiRoot } from "./config/env.js";
import { connectDatabaseWithRetry } from "./core/database-startup.js";
import { logger } from "./core/logger.js";
import { completeBotStartupReadiness, removeBotReadiness } from "./core/readiness-marker.js";
import { runShutdownSequence } from "./core/shutdown.js";
import { startAutoRenewalConsumer } from "./services/auto-renewal-consumer.js";
import { startMiniAppCommerceConsumer } from "./services/miniapp-commerce-consumer.js";
import { startReferralExecuteConsumer } from "./services/referral-execute-consumer.js";
import { startStarsSubscriptionConsumer } from "./services/stars-subscription-consumer.js";
import {
  startSupportNotificationLoop,
  type SupportNotificationLoopController,
} from "./services/support-notification.service.js";
import { runningGitSha } from "./services/backup-health.service.js";
import { startCheckoutInputRetentionLoop } from "./services/checkout-customer-input.service.js";
import { startFreeTrialLoop } from "./services/free-trial.service.js";
import { startFreeTrialCampaignLoop } from "./services/free-trial-campaign.service.js";
import {
  startGatewaySettlementLoop,
} from "./services/gateway-settlement-runner.service.js";
import {
  RECOVERY_RECHECK_DELAY_MS,
  runStartupRecovery,
} from "./services/startup-recovery.service.js";
import { OPS_EVENTS, writeSystemLog } from "./services/system-log.service.js";

const token = getBotToken();
if (token === null) {
  logger.error(
    "TELEGRAM_BOT_TOKEN is not set. Add it to /opt/zedbot/app/.env and run 'zedbot restart'.",
  );
  // Delay the exit so `restart: unless-stopped` does not turn this into a
  // tight crash loop while the operator fixes the configuration.
  setTimeout(() => process.exit(1), 60_000);
} else {
  run(token).catch(async (err: unknown) => {
    await removeBotReadiness().catch(() => undefined);
    // start() rejects for non-retryable failures, e.g. 401 from an invalid
    // token. Network errors are retried internally by grammY and never land
    // here. Exit slowly to keep the restart loop calm.
    logger.error("bot failed to start", { error: errorMessage(err) });
    setTimeout(() => process.exit(1), 30_000);
  });
}

async function run(botToken: string): Promise<void> {
  await removeBotReadiness();
  const bot = createBot(botToken, getTelegramApiRoot());
  let databaseInitialized = false;

  // Wallet auto-renewal EXECUTE consumer (Phase 1): the bot's only BullMQ
  // consumer. It runs the wallet charge + in-place renewal for attempts the
  // worker enqueues (co-located with the fulfillment dispatcher). Null when
  // Redis is unconfigured; the whole feature is disabled-by-default regardless.
  const autoRenewalConsumer = startAutoRenewalConsumer(bot.api);

  // Telegram Stars subscription EXECUTE consumer (Phase 2.1): settles worker-
  // recovered charges, executes bounded refund retries and re-drives stuck-charge
  // reconciliation with the bot's grammY Api + existing services. Null when Redis
  // is unconfigured; the feature is disabled-by-default regardless.
  const starsSubscriptionConsumer = startStarsSubscriptionConsumer(bot.api);

  // Mini App commerce follow-up consumer (miniapp-commerce-parity): runs the
  // Telegram-facing half of Mini-App-initiated settlements (fulfilment,
  // notices, admin receipt fan-out). Null when Redis is unconfigured; the
  // settlement sweep remains the recovery path either way.
  const miniAppCommerceConsumer = startMiniAppCommerceConsumer(bot.api);

  // Referral commission EXECUTE consumer (financial-safety phase): runs the
  // idempotent wallet credit / no-overdraft reversal / debt recovery for jobs the
  // worker (and the live after-commit hook) enqueue. Null when Redis is
  // unconfigured; the whole feature is disabled-by-default regardless.
  const referralExecuteConsumer = startReferralExecuteConsumer();

  // Assigned after startup below; declared here so the shutdown closure can
  // stop it. Null only in the window before startup reaches the start call.
  let supportNotificationLoop: SupportNotificationLoopController | null = null;
  // Assigned once bot.start() is called below. bot.stop() only flips
  // polling off and aborts the in-flight getUpdates call - it does not wait
  // for a handler already running against the current batch of updates to
  // finish. Only the promise bot.start() returned settles once that drain
  // completes, so shutdown must hold onto it and await it after stop().
  let pollingPromise: Promise<void> | null = null;
  // A second SIGTERM/SIGINT (or SIGINT racing a just-received SIGTERM) must
  // not start a second concurrent runShutdownSequence: that would double-run
  // drainSupportNotifications and disconnectDatabase while the first pass is
  // still mid-sequence, exactly the interleaving the ordered-sequence
  // contract exists to prevent. One in-flight shutdown, always the same one.
  let shuttingDown: Promise<void> | null = null;

  const shutdown = (signal: string): Promise<void> => {
    if (shuttingDown !== null) {
      return shuttingDown;
    }
    shuttingDown = (async () => {
      await removeBotReadiness().catch(() => undefined);
      logger.info(`received ${signal}, stopping bot`);
      // The order — and the fact that each step FINISHES before the next starts
      // — is the contract, so it lives in runShutdownSequence where a test can
      // execute it rather than read it. Stopping the notification loop is not
      // enough on its own: a sweep already running holds claims in SENDING, and
      // disconnecting underneath it strands them until the next process's stale
      // sweep. So ticks are stopped, then drained, and only then does anything
      // else tear down.
      await runShutdownSequence(
        {
          stopSupportNotificationTicks: () => supportNotificationLoop?.stop(),
          drainSupportNotifications: async () => {
            await supportNotificationLoop?.drain();
          },
          writeStoppingLog: () =>
            writeSystemLog({
              level: "INFO",
              eventType: OPS_EVENTS.BOT_STOPPED,
              message: "bot service stopping",
              metadata: { signal },
              topicKey: "SYSTEM",
            }),
          stopBot: async () => {
            await bot.stop();
            if (pollingPromise !== null) {
              await pollingPromise;
            }
          },
          stopConsumers: async () => {
            if (autoRenewalConsumer !== null) {
              await autoRenewalConsumer.stop();
            }
            if (miniAppCommerceConsumer !== null) {
              await miniAppCommerceConsumer.stop();
            }
            if (starsSubscriptionConsumer !== null) {
              await starsSubscriptionConsumer.stop();
            }
            if (referralExecuteConsumer !== null) {
              await referralExecuteConsumer.stop();
            }
          },
          disconnectDatabase: () => disconnectDatabase(),
        },
        (step, err) => {
          logger.warn("error during shutdown", { step, error: errorMessage(err) });
        },
      );
      process.exit(0);
    })();
    return shuttingDown;
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // See connectDatabaseWithRetry's own comment for why a bounded retry here
  // matters: without it, a single failed attempt eventually reaches
  // completeBotStartupReadiness's hard throw below, which the outer catch
  // (bottom of this file) treats as non-retryable and exits the whole
  // process after a 30s cooldown - a full container restart cycle for a
  // condition a few seconds of patience would have resolved.
  databaseInitialized = await connectDatabaseWithRetry();
  if (databaseInitialized) {
    logger.info("database connection established");
    // Ops log (SYSTEM topic): fire-and-forget, never blocks startup.
    void writeSystemLog({
      level: "INFO",
      eventType: OPS_EVENTS.BOT_STARTED,
      message: "bot service started",
      topicKey: "SYSTEM",
    });
  }

  // Crash recovery: resolve orders stuck in PROVISIONING and broadcasts
  // stuck in RUNNING by a previous process death (runStartupRecovery never
  // throws). Once now for old orphans, once after the stale threshold so
  // rows orphaned seconds before this restart are caught too - a crash is
  // always followed by a restart, so every orphan meets one of these runs.
  void runStartupRecovery();
  setTimeout(() => {
    void runStartupRecovery();
  }, RECOVERY_RECHECK_DELAY_MS).unref();

  // Gateway settlement sweep: every minute settle payments whose provider
  // SUCCESS arrived while nobody was pressing buttons (IPNs, lost redirects)
  // and re-fulfill settled-but-unfulfilled orders. Errors are logged inside;
  // the loop never throws and its timers never keep the process alive.
  startGatewaySettlementLoop(bot.api);

  // Free-trial sweep: expire finished trials, reconcile uncertain
  // provisioning outcomes (exact username + ownership marker) and escalate
  // stale claims to manual review. Same never-throws loop contract.
  startFreeTrialLoop(bot.api);

  // Trial-entitlement campaign queue (free-trial-entitlement-campaign):
  // processes bulk reset/grant campaigns in small idempotent batches off
  // the durable campaign/recipient rows - resumable after restarts,
  // cancellation-safe. Same never-throws loop contract.
  startFreeTrialCampaignLoop(bot.api);

  // Hourly redaction of dead-end pre-settlement customer-input rows (same never-throws loop contract).
  startCheckoutInputRetentionLoop();

  // Durable support-notification delivery. This is the ONLY thing that can turn
  // an intent written by the API — which has no bot token and never talks to
  // Telegram — into a message an administrator actually receives, and it is
  // what recovers a backlog left by a process that died mid-fan-out.
  //
  // Started HERE, after the Api exists, after the database connection has been
  // attempted and after the shutdown handlers are registered, so a SIGTERM
  // arriving during the first tick is handled rather than racing an unarmed
  // handler. It runs one bounded tick immediately — a backlog from the previous
  // process is exactly what a restart should clear, not something to leave
  // sitting for a full interval — then sweeps periodically. The function
  // latches, so a second call anywhere is a no-op; its timer is unref'd so it
  // never holds the process open; and a failed tick is swallowed so it cannot
  // stop the ones after it.
  supportNotificationLoop = startSupportNotificationLoop(bot.api);

  pollingPromise = bot.start({
    onStart: async (botInfo) => {
      const generation = runningGitSha();
      if (generation === null) throw new Error("bot-readiness-generation-unavailable");
      await completeBotStartupReadiness({ databaseInitialized, generation });
      // Deployment identity in the boot line: "unknown" = image built
      // without the GIT_SHA build arg (e.g. local dev).
      logger.info(`ZED_BOT bot service started (long polling) as @${botInfo.username}`, {
        gitSha: generation,
      });
    },
  });
  await pollingPromise;
}
