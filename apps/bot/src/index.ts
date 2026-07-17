import { connectDatabase, disconnectDatabase } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { createBot } from "./app.js";
import { getBotToken } from "./config/env.js";
import { logger } from "./core/logger.js";
import { runningGitSha } from "./services/backup-health.service.js";
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
