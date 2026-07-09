import { errorMessage } from "@zedbot/shared";
import type { MiddlewareFn } from "grammy";

import type { BotContext } from "../core/context.js";
import { logger } from "../core/logger.js";
import { getActiveAdminByTelegramId } from "../services/admin.service.js";
import { getUserByTelegramId, touchLastSeen } from "../services/user.service.js";

// Throttle lastSeenAt writes: at most one per user per interval.
const LAST_SEEN_INTERVAL_MS = 5 * 60_000;
const lastSeenWrites = new Map<string, number>();

/**
 * Loads the database user and (active) admin row for the update's sender and
 * attaches them to the context. A database outage degrades gracefully: both
 * stay null and downstream guards decide what still works.
 */
export function attachUserMiddleware(): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    ctx.dbUser = null;
    ctx.admin = null;
    const from = ctx.from;
    if (from !== undefined && !from.is_bot) {
      const telegramId = BigInt(from.id);
      try {
        ctx.dbUser = await getUserByTelegramId(telegramId);
        ctx.admin = await getActiveAdminByTelegramId(telegramId);
        if (ctx.dbUser !== null) {
          const lastWrite = lastSeenWrites.get(ctx.dbUser.id) ?? 0;
          if (Date.now() - lastWrite >= LAST_SEEN_INTERVAL_MS) {
            lastSeenWrites.set(ctx.dbUser.id, Date.now());
            touchLastSeen(ctx.dbUser.id).catch((err: unknown) => {
              logger.debug("lastSeen update failed", { error: errorMessage(err) });
            });
          }
        }
      } catch (err) {
        logger.warn("attach-user lookup failed", { error: errorMessage(err) });
      }
    }
    await next();
  };
}
