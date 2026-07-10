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
import {
  adminUsersHandler,
  adminUsersTextHandler,
} from "./handlers/admin-users/admin-users.handler.js";
import { panelHandler, panelTextHandler } from "./handlers/panels/panel.handler.js";
import { productHandler, productTextHandler } from "./handlers/products/product.handler.js";
import {
  checkoutHandler,
  checkoutTextHandler,
} from "./handlers/user-checkout/checkout.handler.js";
import {
  paymentHandler,
  paymentReceiptHandler,
} from "./handlers/user-checkout/payment.handler.js";
import {
  receiptReviewTextHandler,
  receiptsHandler,
} from "./handlers/admin-receipts/receipts.handler.js";
import { forceJoinHandler } from "./handlers/force-join.handler.js";
import { menuHandler } from "./handlers/menu.handler.js";
import {
  extraTimeHandler,
  extraTimeTextHandler,
} from "./handlers/user-extra-time/extra-time.handler.js";
import {
  extraVolumeHandler,
  extraVolumeTextHandler,
} from "./handlers/user-extra-volume/extra-volume.handler.js";
import {
  renewalHandler,
  renewalTextHandler,
} from "./handlers/user-renewal/renewal.handler.js";
import { servicesHandler } from "./handlers/user-services/services.handler.js";
import {
  walletHandler,
  walletTopupTextHandler,
} from "./handlers/user-wallet/wallet.handler.js";
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
  // intentionally independent of the user-facing gates. panelHandler owns the
  // real admin:panels* / admin:panel:* routes; the placeholder handler covers
  // the other admin sections.
  const adminArea = new Composer<BotContext>();
  adminArea.use(adminAuthMiddleware());
  adminArea.use(adminHandler);
  adminArea.use(panelHandler);
  adminArea.use(productHandler);
  adminArea.use(receiptsHandler);
  adminArea.use(adminUsersHandler);
  adminArea.use(adminPlaceholdersHandler);
  bot.command("admin", adminArea.middleware());
  bot.callbackQuery(/^admin:/, adminArea.middleware());

  // Flow input router. Receipt upload accepts text/photo/document; the admin
  // reject-reason flow and discount entry are text-only; panel/product/category
  // wizards are text-only and require an active admin. Everything else falls
  // through untouched.
  const adminFlowText = new Composer<BotContext>();
  adminFlowText.use(panelTextHandler);
  adminFlowText.use(productTextHandler);
  adminFlowText.use(adminUsersTextHandler);
  bot.on("message", async (ctx, next) => {
    const flow = ctx.session.currentFlow;
    if (flow === null) {
      return next();
    }
    if (flow === "payment:receipt") {
      await paymentReceiptHandler.middleware()(ctx, next);
      return;
    }
    if (ctx.message.text === undefined) {
      return next();
    }
    // Admin receipt rejection reason - before any user text flow. The handler
    // itself passes through when ctx.admin is null.
    if (flow === "receipt:reject") {
      await receiptReviewTextHandler.middleware()(ctx, next);
      return;
    }
    if (flow === "checkout:discount") {
      await checkoutTextHandler.middleware()(ctx, next);
      return;
    }
    if (flow === "renew:discount") {
      await renewalTextHandler.middleware()(ctx, next);
      return;
    }
    if (flow === "extra_volume:discount") {
      await extraVolumeTextHandler.middleware()(ctx, next);
      return;
    }
    if (flow === "extra_time:discount") {
      await extraTimeTextHandler.middleware()(ctx, next);
      return;
    }
    if (flow === "wallet:topup:amount") {
      await walletTopupTextHandler.middleware()(ctx, next);
      return;
    }
    if (ctx.admin === null) {
      return next();
    }
    await adminFlowText.middleware()(ctx, next);
  });

  // User area: /menu + user:* / common:* callbacks behind the access gates.
  const userArea = new Composer<BotContext>();
  userArea.use(userAccessMiddleware());
  userArea.use(menuHandler);
  userArea.use(checkoutHandler);
  userArea.use(paymentHandler);
  userArea.use(servicesHandler);
  userArea.use(renewalHandler);
  userArea.use(extraVolumeHandler);
  userArea.use(extraTimeHandler);
  userArea.use(walletHandler);
  userArea.use(userPlaceholdersHandler);
  bot.command("menu", userArea.middleware());
  bot.callbackQuery(/^(user|common):/, userArea.middleware());

  // Any other callback (old keyboards, future features): clear the spinner.
  bot.on("callback_query:data", async (ctx) => {
    await safeAnswerCallback(ctx);
  });

  return bot;
}
