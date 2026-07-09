import { connectDatabase, disconnectDatabase, prisma } from "@zedbot/database";
import { createLogger, errorMessage, optionalEnv } from "@zedbot/shared";
import { Bot, GrammyError, HttpError } from "grammy";

const logger = createLogger("bot");

const token = optionalEnv("TELEGRAM_BOT_TOKEN");
if (token === "") {
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
  const bot = new Bot(botToken);

  // Phase 1 placeholder: /start only confirms the installation works and
  // /ping answers pong. No menus, purchases, wallets or admin flows exist
  // yet. The user upsert below is TEMPORARY smoke-test behaviour proving the
  // bot -> database path; the real registration flow replaces it in a later
  // phase.
  bot.command("start", async (ctx) => {
    const from = ctx.from;
    if (from === undefined) {
      return;
    }
    try {
      await prisma.user.upsert({
        where: { telegramId: BigInt(from.id) },
        update: {
          username: from.username ?? null,
          firstName: from.first_name ?? null,
          lastName: from.last_name ?? null,
          languageCode: from.language_code ?? null,
          lastSeenAt: new Date(),
        },
        create: {
          telegramId: BigInt(from.id),
          username: from.username ?? null,
          firstName: from.first_name ?? null,
          lastName: from.last_name ?? null,
          languageCode: from.language_code ?? null,
          lastSeenAt: new Date(),
        },
      });
    } catch (err) {
      // The welcome reply must go out even when the database hiccups.
      logger.error("failed to upsert user on /start", { error: errorMessage(err) });
    }
    await ctx.reply("ZED_BOT is running. Menus will be configured in the next step.");
  });

  bot.command("ping", async (ctx) => {
    await ctx.reply("pong");
  });

  // Central error handler: never rethrow, never log anything that could
  // contain the token (only error class + message/description).
  bot.catch((err) => {
    const e = err.error;
    if (e instanceof GrammyError) {
      logger.error("telegram api error", {
        method: e.method,
        error_code: e.error_code,
        description: e.description,
      });
    } else if (e instanceof HttpError) {
      logger.error("network error while contacting telegram", { error: errorMessage(e.error) });
    } else {
      logger.error("unhandled bot error", { error: errorMessage(e) });
    }
  });

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

  // bot.start() resolves only when the bot is stopped; onStart confirms the
  // long-polling loop is live.
  await bot.start({
    onStart: (botInfo) => {
      logger.info(`ZED_BOT bot service started (long polling) as @${botInfo.username}`);
    },
  });
}
