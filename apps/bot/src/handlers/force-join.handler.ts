import { Composer } from "grammy";

import { CB } from "../core/callbacks.js";
import type { BotContext } from "../core/context.js";
import { ensureUserAccess } from "../middlewares/user-access.middleware.js";
import {
  FORCE_JOIN_DEBOUNCE_ANSWER_FALLBACK,
  FORCE_JOIN_STILL_MISSING_ANSWER_FALLBACK,
  FORCE_JOIN_VERIFIED_ANSWER_FALLBACK,
  resolveForceJoinGate,
} from "../services/force-join/force-join-gate.js";
import { acquireForceJoinCheckSlot } from "../services/force-join/membership.service.js";
import { getButtonText } from "../services/text.service.js";
import { safeAnswerCallback, safeEditOrReply } from "../utils/safe-reply.js";
import { showUserMenu } from "./menu.handler.js";

/**
 * "بررسی عضویت" — the user taps this to re-verify their channel membership. It
 * debounces per user (§4.9), re-checks LIVE membership bypassing the negative
 * cache (so a user who just joined is seen immediately), and:
 *   - on success: answers "عضویت شما تایید شد ✅", then runs the full access gate
 *     and shows the normal user menu — nothing about balance / orders / referral
 *     / payment state changes,
 *   - on still-missing: answers a short notice and redraws the missing-channel
 *     screen (never claims membership was confirmed),
 *   - on a temporary failure: answers the temporary-failure notice (D2).
 */
export const forceJoinHandler = new Composer<BotContext>();

forceJoinHandler.callbackQuery(CB.FORCE_JOIN_CHECK, async (ctx) => {
  const from = ctx.from;
  if (from === undefined || from.is_bot) {
    await safeAnswerCallback(ctx);
    return;
  }
  const userTelegramId = BigInt(from.id);

  // Per-user debounce: a rapid double-tap gets a "please wait" notice, never a
  // false "not joined" (the check simply does not re-run this tap).
  if (!(await acquireForceJoinCheckSlot(userTelegramId))) {
    await safeAnswerCallback(
      ctx,
      await getButtonText("force_join_debounce", FORCE_JOIN_DEBOUNCE_ANSWER_FALLBACK),
    );
    return;
  }

  const resolution = await resolveForceJoinGate(ctx, userTelegramId, { bypassNegativeCache: true });

  if (resolution.pass) {
    await safeAnswerCallback(
      ctx,
      await getButtonText("force_join_verified", FORCE_JOIN_VERIFIED_ANSWER_FALLBACK),
    );
    // Re-run the full access gate (maintenance/blocked/terms) then show the menu.
    if (await ensureUserAccess(ctx)) {
      await showUserMenu(ctx);
    }
    return;
  }

  if (resolution.kind === "TEMP") {
    await safeAnswerCallback(ctx, resolution.text);
    return;
  }

  // Still missing: short notice + redraw of the missing-channel screen.
  await safeAnswerCallback(
    ctx,
    await getButtonText("force_join_still_missing", FORCE_JOIN_STILL_MISSING_ANSWER_FALLBACK),
  );
  await safeEditOrReply(ctx, resolution.screen.text, resolution.screen.keyboard);
});
