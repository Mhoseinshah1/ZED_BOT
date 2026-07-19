import { Bot, Composer, session } from "grammy";

import type { BotContext } from "./core/context.js";
import { registerErrorHandler } from "./core/errors.js";
import { initialSession } from "./core/session.js";
import { adminAuthMiddleware } from "./middlewares/admin-auth.middleware.js";
import { attachUserMiddleware } from "./middlewares/attach-user.middleware.js";
import { rateLimitMiddleware } from "./middlewares/rate-limit.middleware.js";
import { userAccessMiddleware } from "./middlewares/user-access.middleware.js";
import { adminHandler } from "./handlers/admin.handler.js";
import { financialReconciliationHandler } from "./handlers/admin-finance/financial-reconciliation.handler.js";
import { financialReportsHandler } from "./handlers/admin-finance/financial-reports.handler.js";
import { paymentsListHandler } from "./handlers/admin-finance/payments-list.handler.js";
import {
  adminFinanceHandler,
  adminFinanceTextHandler,
} from "./handlers/admin-finance/admin-finance.handler.js";
import { adminPlaceholdersHandler } from "./handlers/admin-placeholders.handler.js";
import {
  adminUsersHandler,
  adminUsersTextHandler,
} from "./handlers/admin-users/admin-users.handler.js";
import {
  manualOrdersHandler,
  manualOrdersTextHandler,
} from "./handlers/admin-manual-orders/manual-orders.handler.js";
import { stockHandler, stockTextHandler } from "./handlers/admin-stock/stock.handler.js";
import {
  otherProductInfoHandler,
  otherProductInfoTextHandler,
} from "./handlers/user-other-products/other-product-info.handler.js";
import { panelHandler, panelTextHandler } from "./handlers/panels/panel.handler.js";
import { productHandler, productTextHandler } from "./handlers/products/product.handler.js";
import {
  checkoutHandler,
  checkoutTextHandler,
} from "./handlers/user-checkout/checkout.handler.js";
import {
  customerInputFormHandler,
  customerInputFormTextHandler,
} from "./handlers/user-checkout/customer-input-form.handler.js";
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
import {
  autoRenewalHandler,
  autoRenewalTextHandler,
} from "./handlers/user-renewal/auto-renewal.handler.js";
import { userOrdersHandler } from "./handlers/user-orders/orders.handler.js";
import { servicesHandler } from "./handlers/user-services/services.handler.js";
import {
  supportHandler,
  supportTextHandler,
} from "./handlers/user-support/support.handler.js";
import {
  adminSupportHandler,
  adminSupportTextHandler,
} from "./handlers/admin-support/support-admin.handler.js";
import {
  adminBroadcastHandler,
  adminBroadcastTextHandler,
} from "./handlers/admin-broadcast/broadcast.handler.js";
import {
  adminTextSettingsHandler,
  adminTextSettingsTextHandler,
} from "./handlers/admin-settings/text-settings.handler.js";
import {
  adminNotificationsHandler,
  adminNotificationsTextHandler,
} from "./handlers/admin-settings/notifications.handler.js";
import { autoRenewalAdminHandler } from "./handlers/admin-settings/auto-renewal-admin.handler.js";
import { userNotificationsHandler } from "./handlers/user-notifications/notification.handler.js";
import {
  reportsBackupHandler,
  reportsBackupTextHandler,
} from "./handlers/admin-reports-backup/reports-backup.handler.js";
import {
  analyticsHandler,
  analyticsTextHandler,
} from "./handlers/admin-reports-backup/analytics.handler.js";
import { logGroupSetupHandler } from "./handlers/admin-settings/log-group-setup.handler.js";
import {
  logGroupIdHandler,
  logGroupIdTextHandler,
} from "./handlers/admin-settings/log-group-id.handler.js";
import {
  walletHandler,
  walletTopupTextHandler,
} from "./handlers/user-wallet/wallet.handler.js";
import { pingHandler } from "./handlers/ping.handler.js";
import { starsPaymentHandler } from "./handlers/stars-payment.handler.js";
import { startHandler } from "./handlers/start.handler.js";
import { termsHandler } from "./handlers/terms.handler.js";
import { freeTrialHandler } from "./handlers/user-free-trial/free-trial.handler.js";
import { adminMenuTextRouter } from "./handlers/admin-menu-actions.js";
import { userMenuTextRouter } from "./handlers/user-menu-actions.js";
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

  // Telegram Stars payment updates (pre_checkout_query / successful_payment)
  // run BEFORE every gate and flow router: a user who paid Stars must always
  // reach settlement, and the update must never be swallowed by a text flow.
  bot.use(starsPaymentHandler);

  // Gate-free basics.
  bot.use(pingHandler);

  // Log-group setup wizard (group side): MUST run BEFORE the generic
  // startHandler because the wizard's start-group deep link makes Telegram
  // post "/start zedlog" in the candidate group, and that payload has to be
  // consumed here - the composer only intercepts /start for group chats
  // with exactly this payload, so private-chat /start (and group /start
  // with any other payload) is completely unaffected. /setloggroup and the
  // lgset:* confirmation callbacks live here too: they must be reachable
  // INSIDE the (super)group being bound, so they cannot sit behind the
  // admin-area callback gating - the handlers verify the sender is an
  // active OWNER admin themselves.
  bot.use(logGroupSetupHandler);
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
  adminArea.use(adminFinanceHandler);
  // Phase 31: read-only financial reports («گزارش مالی 📊»).
  adminArea.use(financialReportsHandler);
  // Gateway phase: read-only payments list («لیست پرداخت‌ها 💳»).
  adminArea.use(paymentsListHandler);
  // Settlement phase: read-only, OWNER-only reconciliation queue
  // («تطبیق مالی ⚖️»).
  adminArea.use(financialReconciliationHandler);
  adminArea.use(manualOrdersHandler);
  adminArea.use(stockHandler);
  // Phase 32: support tickets («تیکت‌های پشتیبانی 🎫»).
  adminArea.use(adminSupportHandler);
  // Phase 33: text broadcasts («پیام همگانی 📣»).
  adminArea.use(adminBroadcastHandler);
  // Phase 34: general settings + text management («مدیریت متن‌ها ✍️») -
  // must run before the placeholder handler.
  adminArea.use(adminTextSettingsHandler);
  // Notification-engine phase: «اعلان‌ها و یادآوری‌ها 🔔» admin settings +
  // health page (admin:ntf*). Reads for any admin; mutations OWNER-only.
  adminArea.use(adminNotificationsHandler);
  // Wallet auto-renewal (Phase 1): OWNER-only «تمدید خودکار 🔁» admin page
  // (admin:war:*) — master switch, dry-run preview, paused-mandate review,
  // admin pause/cancel, manual scan. Never enables a user's mandate.
  adminArea.use(autoRenewalAdminHandler);
  // Direct-log-group-setup phase: the numeric-ID connection UI (admin:lg:id*,
  // admin:lg:op:*). The status-page keyboards (log-group.handler.ts) mount
  // via adminTextSettingsHandler above; this composer owns the new flow.
  adminArea.use(logGroupIdHandler);
  // Phase 35: backup / health («گزارشات / بکاپ 🛡»).
  adminArea.use(reportsBackupHandler);
  // Phase 4: notification analytics («تحلیل اعلان‌ها 📈», admin:analytics / admin:an:*).
  adminArea.use(analyticsHandler);
  adminArea.use(adminPlaceholdersHandler);
  bot.command("admin", adminArea.middleware());
  bot.callbackQuery(/^admin:/, adminArea.middleware());
  // Payment provider pages (provider-navigation phase) use the stable
  // payprov:* callbacks - same gated admin area, so a non-admin (or a
  // forged callback) is denied by adminAuthMiddleware before any handler.
  bot.callbackQuery(/^payprov:/, adminArea.middleware());

  // Flow input router. Receipt upload accepts text/photo/document; the admin
  // reject-reason flow and discount entry are text-only; panel/product/category
  // wizards are text-only and require an active admin. Everything else falls
  // through untouched.
  const adminFlowText = new Composer<BotContext>();
  adminFlowText.use(panelTextHandler);
  adminFlowText.use(productTextHandler);
  adminFlowText.use(adminUsersTextHandler);
  adminFlowText.use(adminFinanceTextHandler);
  adminFlowText.use(manualOrdersTextHandler);
  adminFlowText.use(stockTextHandler);
  adminFlowText.use(adminSupportTextHandler);
  adminFlowText.use(adminBroadcastTextHandler);
  adminFlowText.use(adminTextSettingsTextHandler);
  // Checkout-payment reminders (Phase 2): numeric config input for the two
  // checkout rule pages ("admin_ntf_co:cfg"). Self-gates on currentFlow.
  adminFlowText.use(adminNotificationsTextHandler);
  // Production-backup rework: scheduled-backup hour input.
  adminFlowText.use(reportsBackupTextHandler);
  // Phase 4: analytics custom date-range input ("admin_analytics:range"). Self-
  // gates on currentFlow.
  adminFlowText.use(analyticsTextHandler);
  // Direct-log-group-setup phase: numeric chat-id input ("lg:chat_id"). Self-
  // gates on currentFlow, so it passes through for every other admin flow.
  adminFlowText.use(logGroupIdTextHandler);
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
    // Wallet auto-renewal (Phase 1): the ceiling-amount entry step. Self-gates
    // on currentFlow so every other text passes through untouched.
    if (flow === "arn:ceiling") {
      await autoRenewalTextHandler.middleware()(ctx, next);
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
    // Specialized-workflows phase: the structured pre-settlement customer
    // input form. MUST be dispatched BEFORE the legacy other_product:info
    // branch - both consume plain user text from the same surface, and a
    // buyer inside "customer_input:form" must never fall through to the
    // legacy free-text intake (which would persist raw text on the order).
    if (flow === "customer_input:form") {
      await customerInputFormTextHandler.middleware()(ctx, next);
      return;
    }
    if (flow === "other_product:info") {
      await otherProductInfoTextHandler.middleware()(ctx, next);
      return;
    }
    // Phase 32 user ticket flows (subject / first message / reply).
    if (flow === "support:subject" || flow === "support:message" || flow === "support:reply") {
      await supportTextHandler.middleware()(ctx, next);
      return;
    }
    if (ctx.admin === null) {
      return next();
    }
    await adminFlowText.middleware()(ctx, next);
  });

  // Menu-keyboard-mode phases: reply-keyboard main-menu text routing. Both
  // routers run AFTER the flow dispatcher above, so every active
  // conversational flow has already consumed its text; inside, each only
  // acts in ITS OWN REPLY mode on exact current main-menu labels (commands
  // and arbitrary text fall through). The admin router runs first - the
  // approved priority is command -> flow -> admin action -> user action ->
  // fallback - and denies unauthorized senders of admin labels itself.
  bot.on("message:text", adminMenuTextRouter.middleware());
  bot.on("message:text", userMenuTextRouter.middleware());

  // User area: /menu + user:* / common:* callbacks behind the access gates.
  const userArea = new Composer<BotContext>();
  userArea.use(userAccessMiddleware());
  userArea.use(menuHandler);
  userArea.use(checkoutHandler);
  userArea.use(paymentHandler);
  userArea.use(servicesHandler);
  userArea.use(renewalHandler);
  // Wallet auto-renewal (Phase 1): consent flow, per-service status, my-renewals
  // (user:arn:*). Registered before the placeholder handler so its routes win.
  userArea.use(autoRenewalHandler);
  userArea.use(extraVolumeHandler);
  userArea.use(extraTimeHandler);
  userArea.use(walletHandler);
  // Specialized-workflows phase: structured customer-input form callbacks
  // (cinput:*). Registered BEFORE otherProductInfoHandler so the structured
  // flow always wins over the legacy free-text intake for specialized
  // products; the legacy handler keeps its own user:op:info:* routes.
  userArea.use(customerInputFormHandler);
  userArea.use(otherProductInfoHandler);
  // Phase 29: read-only OTHER_PRODUCT order tracking («سفارش‌های من 🧾»).
  userArea.use(userOrdersHandler);
  // Phase 32: support tickets - must run before the placeholder handler,
  // which used to own CB.USER_SUPPORT.
  userArea.use(supportHandler);
  // Free-trial phase: the real trial flow - must run before the placeholder
  // handler, which used to own CB.USER_FREE_TEST.
  userArea.use(freeTrialHandler);
  // Notification-engine phase: notification action callbacks (ntf:*) + the
  // user notification settings pages (user:nset:* / user:nsvc:*). Registered
  // before the placeholder handler so its user:* routes always win.
  userArea.use(userNotificationsHandler);
  userArea.use(userPlaceholdersHandler);
  bot.command("menu", userArea.middleware());
  bot.callbackQuery(/^(user|common):/, userArea.middleware());
  // Customer-input form callbacks (cinput:*) go through the same gated user
  // area - the access gates and owner checks apply exactly as for user:*.
  bot.callbackQuery(/^cinput:/, userArea.middleware());
  // Notification action callbacks (ntf:*) go through the same gated user area,
  // so the access gates + owner scoping apply exactly as for user:* callbacks.
  bot.callbackQuery(/^ntf:/, userArea.middleware());

  // Any other callback (old keyboards, future features): clear the spinner.
  bot.on("callback_query:data", async (ctx) => {
    await safeAnswerCallback(ctx);
  });

  return bot;
}
