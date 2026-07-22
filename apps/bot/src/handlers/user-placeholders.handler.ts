import { Composer } from "grammy";

import { CB } from "../core/callbacks.js";
import type { BotContext } from "../core/context.js";
import { buildBackToMenuKeyboard } from "../keyboards/common.keyboard.js";
import { getButtonText } from "../services/text.service.js";
import { safeAnswerCallback, safeEditOrReply } from "../utils/safe-reply.js";

export const PLACEHOLDER_TEXT = "این بخش هنوز فعال نشده است.";

// callback -> ButtonText key used as the section title.
// user:buy and user:other_products are handled by the real checkout flow
// (handlers/user-checkout), user:services by the real "My Services" handler
// (Phase 10), user:renew by the real renewal flow (Phase 12) and
// user:wallet by the real wallet page (Phase 13); everything else stays
// placeholder in this phase.
// user:support left this list in Phase 32 - the real ticket system
// (handlers/user-support) owns CB.USER_SUPPORT now.
// These sections are HIDDEN from the main menu
// (keyboards/user-main.keyboard.ts) until their real flows land. The
// callbacks stay registered here ONLY so buttons on old Telegram messages
// keep answering instead of dead-ending.
// user:free_test left this list in the free-trial phase - the real trial
// flow (handlers/user-free-trial) owns CB.USER_FREE_TEST now.
const USER_SECTIONS: Array<{ callback: string; buttonKey: string }> = [
  // CB.USER_REFERRAL left this list in the referral affiliate phase — the real
  // referral page (handlers/user-referral) owns it now.
  // CB.USER_REPRESENTATIVE left this list in the representative-program phase —
  // the real representative page (handlers/user-representative) owns it now.
  { callback: CB.USER_WHEEL, buttonKey: "lucky_wheel" },
  { callback: CB.USER_TUTORIALS, buttonKey: "tutorials" },
  { callback: CB.USER_PRICING, buttonKey: "pricing" },
];

/** Every user menu button opens a placeholder page in this phase. */
export const userPlaceholdersHandler = new Composer<BotContext>();

for (const section of USER_SECTIONS) {
  userPlaceholdersHandler.callbackQuery(section.callback, async (ctx) => {
    await safeAnswerCallback(ctx);
    const title = await getButtonText(section.buttonKey);
    const keyboard = await buildBackToMenuKeyboard();
    await safeEditOrReply(ctx, `${title}\n\n${PLACEHOLDER_TEXT}`, keyboard);
    ctx.session.lastMenu = section.callback;
  });
}
