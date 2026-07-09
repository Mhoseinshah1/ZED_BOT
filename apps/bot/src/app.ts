import { Bot, Composer, session } from "grammy";

import type { BotContext } from "./core/context.js";
import { registerErrorHandler } from "./core/errors.js";
import { initialSession } from "./core/session.js";
import { adminAuthMiddleware } from "./middlewares/admin-auth.middleware.js";
import { attachUserMiddleware } from "./middlewares/attach-user.middleware.js";
import { rateLimitMiddleware } from "./middlewares/rate-limit.middleware.js";
import { userAccessMiddleware } from "./middlewares/user-access.middleware.js";
import { adminHandler } from "./handlers/admin.handler.js";
import { adminPlaceholdersHandler } from "./handlers/admin-placeholders.handler.js";
import { forceJoinHandler } from "./handlers/force-join.handler.js";
import { menuHandler } from "./handlers/menu.handler.js";
import { pingHandler } from "./handlers/ping.handler.js";
import { startHandler } from "./handlers/start.handler.js";
import { termsHandler } from "./handlers/terms.handler.js";
import { userPlaceholdersHandler } from "./handlers/user-placeholders.handler.js";
import { safeAnswerCallback } from "./utils/safe-reply.js";

/**
 * Builds the bot with the full middleware chain:
 *
 *   rate limit -> session -> attach user/admin
 *     ├─ /ping                         (no gates)
 *     ├─ /start                        (registers, referral, gates inline)
 *     ├─ terms/force-join callbacks    (handle their own gate re-check)
 *     ├─ admin composer                (admin auth guard)
 *     └─ user composer                 (user access guard)
 */
export function createBot(token: string): Bot<BotContext> {
  const bot = new Bot<BotContext>(token);

  registerErrorHandler(bot);

  bot.use(rateLimitMiddleware());
  bot.use(session({ initial: initialSession }));
  bot.use(attachUserMiddleware());

  // Gate-free basics.
  bot.use(pingHandler);
  bot.use(startHandler);

  // Gate actions run their own access re-check after mutating state.
  bot.use(termsHandler);
  bot.use(forceJoinHandler);

  // Admin area: /admin + admin:* callbacks behind admin auth. Admin access is
  // intentionally independent of the user-facing gates.
  const adminArea = new Composer<BotContext>();
  adminArea.use(adminAuthMiddleware());
  adminArea.use(adminHandler);
  adminArea.use(adminPlaceholdersHandler);
  bot.command("admin", adminArea.middleware());
  bot.callbackQuery(/^admin:/, adminArea.middleware());

  // User area: /menu + user:* / common:* callbacks behind the access gates.
  const userArea = new Composer<BotContext>();
  userArea.use(userAccessMiddleware());
  userArea.use(menuHandler);
  userArea.use(userPlaceholdersHandler);
  bot.command("menu", userArea.middleware());
  bot.callbackQuery(/^(user|common):/, userArea.middleware());

  // Any other callback (old keyboards, future features): clear the spinner.
  bot.on("callback_query:data", async (ctx) => {
    await safeAnswerCallback(ctx);
  });

  return bot;
}
