import type { MiddlewareFn } from "grammy";

import type { BotContext } from "../core/context.js";
import { logger } from "../core/logger.js";
import { OPS_EVENTS, writeSystemLog } from "../services/system-log.service.js";
import { safeAnswerCallback, safeReply } from "../utils/safe-reply.js";

export const ADMIN_DENIED_TEXT = "شما به بخش مدیریت دسترسی ندارید.";

/**
 * THE reusable active-admin gate: true only when the middleware-attached
 * ctx.admin is present (attach-user resolves ACTIVE admins only, so
 * deactivated/deleted admins - including ones tapping a stale reply
 * keyboard - always land in the denial branch). Denial behavior is the
 * authoritative one the admin area has always had: safe debug log, the
 * SECURITY ops event and the fixed Persian denial text; no role or
 * admin-record details ever leak. Button visibility is NEVER authorization -
 * every entry path calls this immediately before opening the panel.
 */
export async function ensureActiveAdminAccess(ctx: BotContext): Promise<boolean> {
  if (ctx.admin !== null) {
    return true;
  }
  logger.debug("admin access denied", { telegramId: String(ctx.from?.id ?? "unknown") });
  // Ops log (SECURITY topic): unauthorized admin-area access attempt.
  // Callback data is bot-authored route text (no user secrets).
  void writeSystemLog({
    level: "WARN",
    eventType: OPS_EVENTS.SECURITY_ADMIN_DENIED,
    message: "admin area access denied",
    metadata: {
      telegramId: String(ctx.from?.id ?? "unknown"),
      callback: ctx.callbackQuery?.data?.slice(0, 64) ?? null,
    },
    topicKey: "SECURITY",
    userId: ctx.dbUser?.id,
  });
  await safeAnswerCallback(ctx);
  await safeReply(ctx, ADMIN_DENIED_TEXT);
  return false;
}

/**
 * Only ACTIVE admins pass (any role - role-based sections come later).
 * Admin access is independent of User.status: a blocked user row does not
 * lock an active admin out of /admin. Exactly the shared gate above -
 * behavior unchanged.
 */
export function adminAuthMiddleware(): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    if (!(await ensureActiveAdminAccess(ctx))) {
      return;
    }
    await next();
  };
}
