import { connectDatabase, disconnectDatabase } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { createBot } from "./app.js";
import { getBotToken } from "./config/env.js";
import { logger } from "./core/logger.js";
import { startAutoRenewalConsumer } from "./services/auto-renewal-consumer.js";
import { startReferralExecuteConsumer } from "./services/referral-execute-consumer.js";
import { startStarsSubscriptionConsumer } from "./services/stars-subscription-consumer.js";
import { startSupportNotificationLoop } from "./services/support-notification.service.js";
import { runningGitSha } from "./services/backup-health.service.js";
import { startCheckoutInputRetentionLoop } from "./services/checkout-customer-input.service.js";
import { startFreeTrialLoop } from "./services/free-trial.service.js";
import { startFreeTrialCampaignLoop } from "./services/free-trial-campaign.service.js";
import { startGatewaySettlementLoop } from "./services/gateway-payment.service.js";
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
  run(token).catch((err: unknown) => {
    // start() rejects for non-retryable failures, e.g. 401 from an invalid
    // token. Network errors are retried internally by grammY and never land
    // here. Exit slowly to keep the restart loop calm.
    logger.error("bot failed to start", { error: errorMessage(err) });
    setTimeout(() => process.exit(1), 30_000);
  });
}

async function run(botToken: string): Promise<void> {
  const bot = createBot(botToken);

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

  // Referral commission EXECUTE consumer (financial-safety phase): runs the
  // idempotent wallet credit / no-overdraft reversal / debt recovery for jobs the
  // worker (and the live after-commit hook) enqueue. Null when Redis is
  // unconfigured; the whole feature is disabled-by-default regardless.
  const referralExecuteConsumer = startReferralExecuteConsumer();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`received ${signal}, stopping bot`);
    try {
      // Ops log BEFORE the database disconnects; writeSystemLog never throws.
      await writeSystemLog({
        level: "INFO",
        eventType: OPS_EVENTS.BOT_STOPPED,
        message: "bot service stopping",
        metadata: { signal },
        topicKey: "SYSTEM",
      });
      await bot.stop();
      if (autoRenewalConsumer !== null) {
        await autoRenewalConsumer.stop();
      }
      if (starsSubscriptionConsumer !== null) {
        await starsSubscriptionConsumer.stop();
      }
      if (referralExecuteConsumer !== null) {
        await referralExecuteConsumer.stop();
      }
      await disconnectDatabase();
    } catch (err) {
      logger.warn("error during shutdown", { error: errorMessage(err) });
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  try {
    await connectDatabase();
    logger.info("database connection established");
    // Ops log (SYSTEM topic): fire-and-forget, never blocks startup.
    void writeSystemLog({
      level: "INFO",
      eventType: OPS_EVENTS.BOT_STARTED,
      message: "bot service started",
      topicKey: "SYSTEM",
    });
  } catch (err) {
    logger.warn("database not reachable at startup, continuing", { error: errorMessage(err) });
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
  startSupportNotificationLoop(bot.api);

  await bot.start({
    onStart: (botInfo) => {
      // Deployment identity in the boot line: "unknown" = image built
      // without the GIT_SHA build arg (e.g. local dev).
      logger.info(`ZED_BOT bot service started (long polling) as @${botInfo.username}`, {
        gitSha: runningGitSha() ?? "unknown",
      });
    },
  });
}
