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
import {
  FORCE_JOIN_ENABLED_KEY,
  listActiveChannels,
} from "../services/force-join/force-join-channel.service.js";
import { acquireForceJoinCheckSlot } from "../services/force-join/membership.service.js";
import { getBooleanSetting } from "../services/settings.service.js";
import { getButtonText } from "../services/text.service.js";
import { safeAnswerCallback, safeEditOrReply } from "../utils/safe-reply.js";
import { showUserMenu } from "./menu.handler.js";

/**
 * "بررسی عضویت" — the user taps this to re-verify their channel membership.
 *
 * This button lives on a message that can be arbitrarily old. By the time it is
 * tapped, force join may have been switched off, the user may have been granted
 * a bypass or been blocked, and every channel may have been removed. So the
 * handler re-derives the CURRENT state before spending anything:
 *
 *   1. `ensureUserAccess` — registers/loads the user and applies the
 *      maintenance → blocked → terms rules (it deliberately skips its own
 *      force-join gate for this callback; that is what we are doing here);
 *   2. the master switch, the per-user bypass, and the live active-channel set.
 *
 * If force join is off, the user is bypassed, or there are zero active channels,
 * the tap costs NO Redis lookup, NO debounce slot and NO getChatMember call —
 * the user simply lands back on the normal menu. Only when a check is genuinely
 * required do we take the per-user debounce slot and query Telegram, bypassing
 * the negative cache so a user who just joined is seen immediately.
 */
export const forceJoinHandler = new Composer<BotContext>();

forceJoinHandler.callbackQuery(CB.FORCE_JOIN_CHECK, async (ctx) => {
  const from = ctx.from;
  if (from === undefined || from.is_bot) {
    await safeAnswerCallback(ctx);
    return;
  }

  // 1. Access rules first: a stale keyboard must not let a blocked / unaccepted
  //    user drive Telegram calls. ensureUserAccess sends its own message and
  //    returns false when the user may not proceed.
  if (!(await ensureUserAccess(ctx))) {
    return;
  }
  const user = ctx.dbUser;
  if (user === null) {
    await safeAnswerCallback(ctx);
    return;
  }

  // 2. Is a membership check still required at all?
  const enabled = await getBooleanSetting(FORCE_JOIN_ENABLED_KEY, false);
  if (!enabled || user.forceJoinBypass) {
    await safeAnswerCallback(
      ctx,
      await getButtonText("force_join_verified", FORCE_JOIN_VERIFIED_ANSWER_FALLBACK),
    );
    await showUserMenu(ctx);
    return;
  }

  // 3. The active-channel snapshot, read ONCE and reused by the gate (§4.13).
  //    Zero active channels is the D4 never-brick case: nothing to verify.
  const channels = await listActiveChannels();
  if (channels.length === 0) {
    await safeAnswerCallback(
      ctx,
      await getButtonText("force_join_verified", FORCE_JOIN_VERIFIED_ANSWER_FALLBACK),
    );
    await showUserMenu(ctx);
    return;
  }

  const userTelegramId = user.telegramId;

  // 4. Per-user debounce: a rapid double-tap gets a "please wait" notice, never
  //    a false "not joined" (the check simply does not re-run this tap).
  if (!(await acquireForceJoinCheckSlot(userTelegramId))) {
    await safeAnswerCallback(
      ctx,
      await getButtonText("force_join_debounce", FORCE_JOIN_DEBOUNCE_ANSWER_FALLBACK),
    );
    return;
  }

  const resolution = await resolveForceJoinGate(ctx, userTelegramId, {
    bypassNegativeCache: true,
    channels,
  });

  if (resolution.pass) {
    await safeAnswerCallback(
      ctx,
      await getButtonText("force_join_verified", FORCE_JOIN_VERIFIED_ANSWER_FALLBACK),
    );
    await showUserMenu(ctx);
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
