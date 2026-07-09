import { Composer } from "grammy";

import { CB } from "../core/callbacks.js";
import type { BotContext } from "../core/context.js";
import { buildBackToMenuKeyboard } from "../keyboards/common.keyboard.js";
import { getButtonText, getMessageTemplate } from "../services/text.service.js";
import { safeAnswerCallback, safeEditOrReply } from "../utils/safe-reply.js";

export const PLACEHOLDER_TEXT = "این بخش در فاز بعدی تکمیل می‌شود.";

// callback -> ButtonText key used as the section title.
// user:buy and user:other_products are handled by the real checkout flow
// (handlers/user-checkout), user:services by the real "My Services" handler
// (Phase 10) and user:renew by the real renewal flow (Phase 12); everything
// else stays placeholder in this phase.
const USER_SECTIONS: Array<{ callback: string; buttonKey: string }> = [
  { callback: CB.USER_WALLET, buttonKey: "wallet" },
  { callback: CB.USER_REFERRAL, buttonKey: "referral" },
  { callback: CB.USER_FREE_TEST, buttonKey: "free_test" },
  { callback: CB.USER_WHEEL, buttonKey: "lucky_wheel" },
  { callback: CB.USER_TUTORIALS, buttonKey: "tutorials" },
  { callback: CB.USER_SUPPORT, buttonKey: "support" },
  { callback: CB.USER_PRICING, buttonKey: "pricing" },
  { callback: CB.USER_REPRESENTATIVE, buttonKey: "representative_request" },
];

/** Every user menu button opens a placeholder page in this phase. */
export const userPlaceholdersHandler = new Composer<BotContext>();

for (const section of USER_SECTIONS) {
  userPlaceholdersHandler.callbackQuery(section.callback, async (ctx) => {
    await safeAnswerCallback(ctx);
    const title = await getButtonText(section.buttonKey);
    // The support section already has seeded operator-editable copy.
    const body =
      section.callback === CB.USER_SUPPORT
        ? await getMessageTemplate("support_text")
        : PLACEHOLDER_TEXT;
    const keyboard = await buildBackToMenuKeyboard();
    await safeEditOrReply(ctx, `${title}\n\n${body}`, keyboard);
    ctx.session.lastMenu = section.callback;
  });
}
