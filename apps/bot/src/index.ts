import { connectDatabase, disconnectDatabase } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { createBot } from "./app.js";
import { getBotToken } from "./config/env.js";
import { logger } from "./core/logger.js";

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
  } catch (err) {
    logger.warn("database not reachable at startup, continuing", { error: errorMessage(err) });
  }

  await bot.start({
    onStart: (botInfo) => {
      logger.info(`ZED_BOT bot service started (long polling) as @${botInfo.username}`);
    },
  });
}
