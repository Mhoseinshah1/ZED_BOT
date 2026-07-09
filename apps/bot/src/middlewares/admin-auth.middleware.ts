import type { MiddlewareFn } from "grammy";

import type { BotContext } from "../core/context.js";
import { logger } from "../core/logger.js";
import { safeAnswerCallback, safeReply } from "../utils/safe-reply.js";

export const ADMIN_DENIED_TEXT = "شما به بخش مدیریت دسترسی ندارید.";

/**
 * Only ACTIVE admins pass (any role - role-based sections come later).
 * Admin access is independent of User.status: a blocked user row does not
 * lock an active admin out of /admin.
 */
export function adminAuthMiddleware(): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    if (ctx.admin === null) {
      logger.debug("admin access denied", { telegramId: String(ctx.from?.id ?? "unknown") });
      await safeAnswerCallback(ctx);
      await safeReply(ctx, ADMIN_DENIED_TEXT);
      return;
    }
    await next();
  };
}
