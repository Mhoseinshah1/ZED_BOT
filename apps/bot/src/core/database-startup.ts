import { connectDatabase } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { logger } from "./logger.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const DATABASE_CONNECT_ATTEMPTS = 5;
export const DATABASE_CONNECT_RETRY_DELAY_MS = 2_000;

/**
 * Retries the initial database connection a bounded number of times before
 * giving up. docker-compose already gates the bot container on postgres's
 * own healthcheck (depends_on: condition: service_healthy), so a failed
 * FIRST attempt here is normally a brief startup race - connection-pool
 * warmup, api/worker connecting at the same moment - not a genuinely broken
 * database. Absorbing that here avoids the alternative: giving up after one
 * attempt lets completeBotStartupReadiness's hard throw reject bot.start(),
 * which index.ts's outer catch treats as non-retryable and exits the whole
 * process after a 30s cooldown - a full container restart cycle for a
 * condition a few seconds of patience would have resolved.
 */
export async function connectDatabaseWithRetry(
  attempts = DATABASE_CONNECT_ATTEMPTS,
  delayMs = DATABASE_CONNECT_RETRY_DELAY_MS,
  connect: () => Promise<void> = connectDatabase,
): Promise<boolean> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await connect();
      return true;
    } catch (err) {
      const isLastAttempt = attempt === attempts;
      logger.warn(
        isLastAttempt ? "database not reachable at startup, giving up" : "database not reachable at startup, retrying",
        { error: errorMessage(err), attempt, attempts },
      );
      if (!isLastAttempt) {
        await sleep(delayMs);
      }
    }
  }
  return false;
}
