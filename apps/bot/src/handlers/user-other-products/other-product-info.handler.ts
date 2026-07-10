import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import {
  getPendingInfoOrderByShortId,
  notifyAdminsAboutManualOrder,
  submitUserInfo,
  USER_INFO_SAVED_TEXT,
  userInfoPromptText,
} from "../../services/other-product-delivery.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";

// =============================================================================
// OTHER_PRODUCT required-info intake (Phase 23). The «تکمیل اطلاعات سفارش 📝»
// button (sent with the payment-approval notice, and re-sendable by admins)
// opens a one-step text flow; the submitted text lands on the order's
// OtherProductOrder record and the order becomes ready for admin delivery.
// Owner-scoped on every step; no payment/order/wallet mutation here beyond
// the info/status fields.
// =============================================================================

const NOT_PENDING_TEXT = "سفارشی در انتظار اطلاعات یافت نشد.";
const INFO_FLOW = "other_product:info";

export const otherProductInfoHandler = new Composer<BotContext>();

/** Leaves the info flow without touching other flows. */
export function clearOtherProductInfoState(ctx: BotContext): void {
  if (ctx.session.currentFlow === INFO_FLOW) {
    ctx.session.currentFlow = null;
  }
  delete ctx.session.temp.otherProductInfoRecordId;
}

otherProductInfoHandler.callbackQuery(/^user:op:info:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    return;
  }
  const record = await getPendingInfoOrderByShortId(ctx.match[1], user.id);
  if (record === null) {
    await safeAnswerCallback(ctx, NOT_PENDING_TEXT);
    return;
  }
  ctx.session.currentFlow = INFO_FLOW;
  ctx.session.temp.otherProductInfoRecordId = record.id;
  await safeAnswerCallback(ctx);
  await safeEditOrReply(
    ctx,
    userInfoPromptText(record.product.requiredUserInfoPromptText),
    new InlineKeyboard().text("انصراف", CB.USER_MENU),
  );
});

/** Text intake for the "other_product:info" flow (routed from app.ts). */
export const otherProductInfoTextHandler = new Composer<BotContext>();

otherProductInfoTextHandler.on("message:text", async (ctx, next) => {
  if (ctx.session.currentFlow !== INFO_FLOW) {
    return next();
  }
  const text = ctx.message.text;
  // Commands abandon the flow; the button on the original message resumes it.
  if (text.startsWith("/")) {
    clearOtherProductInfoState(ctx);
    return next();
  }
  const user = ctx.dbUser;
  const recordId = ctx.session.temp.otherProductInfoRecordId;
  if (user === null || recordId === undefined) {
    clearOtherProductInfoState(ctx);
    await safeReply(ctx, NOT_PENDING_TEXT);
    return;
  }
  const outcome = await submitUserInfo(user.id, recordId, text);
  if (!outcome.ok) {
    // Invalid length keeps the flow open for another try; a stale/foreign
    // record ends it.
    if (outcome.error === "invalid info length") {
      await safeReply(ctx, outcome.safeUserMessage);
      return;
    }
    clearOtherProductInfoState(ctx);
    await safeReply(ctx, outcome.safeUserMessage);
    return;
  }
  clearOtherProductInfoState(ctx);
  await safeReply(ctx, USER_INFO_SAVED_TEXT);
  // The order just became ready for delivery - tell the admins (never
  // blocks or rolls back the submission).
  await notifyAdminsAboutManualOrder(ctx.api, outcome.record);
});
