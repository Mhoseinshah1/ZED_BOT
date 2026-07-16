import { type Panel } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";
import { Composer, InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { logger } from "../../core/logger.js";
import {
  freeTrialNoticeText,
  isFreeTrialEnabled,
} from "../../services/free-trial-settings.service.js";
import {
  buildTrialSuccessMessage,
  checkTrialEligibility,
  claimFreeTrial,
  formatTrialDuration,
  formatTrialTraffic,
  listTrialReadyPanels,
  TRIAL_NO_PANEL_TEXT,
  TRIAL_TEMP_UNAVAILABLE_TEXT,
  TRIAL_UNCERTAIN_TEXT,
} from "../../services/free-trial.service.js";
import { safeAnswerCallback, safeEditOrReply, safeReply } from "../../utils/safe-reply.js";
import { svcCb } from "../user-services/service-views.js";

// =============================================================================
// User free-trial flow (free-trial phase): «اکانت تست رایگان 🎁» ->
// availability + eligibility -> panel/location selection -> confirmation ->
// atomic claim + remote provisioning (free-trial.service owns every check;
// NOTHING from callback data is trusted - panel ids resolve by short id and
// every value is re-fetched from the database before the claim).
// =============================================================================

export const ftCb = {
  root: CB.USER_FREE_TEST, // "user:free_test"
  panel: (sid: string): string => `user:ft:p:${sid}`,
  confirm: (sid: string): string => `user:ft:go:${sid}`,
} as const;

const TRIAL_LIST_HEADER = "🎁 اکانت تست رایگان\n\nلوکیشن مورد نظر را انتخاب کنید:";

function backToMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("بازگشت به منوی اصلی", CB.USER_MENU);
}

/** Safe display name for a trial panel - never base URL/credentials/ids. */
function trialPanelLabel(panel: Panel): string {
  const name = panel.testLocation ?? panel.name;
  const duration = formatTrialDuration(panel.testDurationMinutes ?? 0);
  const traffic = formatTrialTraffic(panel.testVolumeMb ?? 0);
  return `${name} — تست ${duration} / ${traffic}`;
}

/** Owner-scoped short-id lookup over the CURRENT trial-ready panel set. */
async function trialPanelByShortId(shortId: string): Promise<Panel | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const ready = await listTrialReadyPanels();
  const matches = ready.filter((panel) => panel.id.startsWith(shortId.toLowerCase()));
  return matches.length === 1 ? matches[0] : null;
}

export const freeTrialHandler = new Composer<BotContext>();

// --- entry: availability + eligibility + panel list ------------------------------------------

freeTrialHandler.callbackQuery(ftCb.root, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    await safeAnswerCallback(ctx);
    return;
  }
  try {
    if (!(await isFreeTrialEnabled())) {
      await safeAnswerCallback(ctx);
      await safeEditOrReply(ctx, TRIAL_NO_PANEL_TEXT, backToMenuKeyboard());
      return;
    }
    const eligibility = await checkTrialEligibility(user);
    if (!eligibility.ok) {
      await safeAnswerCallback(ctx);
      await safeEditOrReply(ctx, eligibility.text, backToMenuKeyboard());
      return;
    }
    const panels = await listTrialReadyPanels();
    if (panels.length === 0) {
      await safeAnswerCallback(ctx);
      await safeEditOrReply(ctx, TRIAL_NO_PANEL_TEXT, backToMenuKeyboard());
      return;
    }
    await safeAnswerCallback(ctx);
    const kb = new InlineKeyboard();
    for (const panel of panels) {
      kb.text(trialPanelLabel(panel), ftCb.panel(panel.id.slice(0, 8))).row();
    }
    kb.text("بازگشت به منوی اصلی", CB.USER_MENU);
    await safeEditOrReply(ctx, TRIAL_LIST_HEADER, kb);
    ctx.session.lastMenu = ftCb.root;
  } catch (err) {
    logger.error("free trial entry failed", { error: errorMessage(err) });
    await safeAnswerCallback(ctx);
    await safeReply(ctx, TRIAL_TEMP_UNAVAILABLE_TEXT, backToMenuKeyboard());
  }
});

// --- confirmation page --------------------------------------------------------------------------

freeTrialHandler.callbackQuery(/^user:ft:p:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    await safeAnswerCallback(ctx);
    return;
  }
  try {
    const panel = await trialPanelByShortId(ctx.match[1]);
    if (panel === null) {
      await safeAnswerCallback(ctx, TRIAL_NO_PANEL_TEXT);
      return;
    }
    const eligibility = await checkTrialEligibility(user);
    if (!eligibility.ok) {
      await safeAnswerCallback(ctx);
      await safeEditOrReply(ctx, eligibility.text, backToMenuKeyboard());
      return;
    }
    await safeAnswerCallback(ctx);
    const notice = await freeTrialNoticeText();
    const lines = [
      "🎁 اکانت تست رایگان",
      "",
      `لوکیشن:\n${panel.testLocation ?? panel.name}`,
      "",
      `مدت اعتبار:\n${formatTrialDuration(panel.testDurationMinutes ?? 0)}`,
      "",
      `حجم:\n${formatTrialTraffic(panel.testVolumeMb ?? 0)}`,
      "",
      "هر کاربر فقط طبق قوانین تعیین‌شده امکان دریافت تست دارد.",
    ];
    if (notice !== "") {
      lines.push("", notice);
    }
    await safeEditOrReply(
      ctx,
      lines.join("\n"),
      new InlineKeyboard()
        .text("دریافت اکانت تست ✅", ftCb.confirm(panel.id.slice(0, 8)))
        .row()
        .text("بازگشت", ftCb.root),
    );
  } catch (err) {
    logger.error("free trial confirm page failed", { error: errorMessage(err) });
    await safeAnswerCallback(ctx);
    await safeReply(ctx, TRIAL_TEMP_UNAVAILABLE_TEXT, backToMenuKeyboard());
  }
});

// --- the claim ------------------------------------------------------------------------------------

freeTrialHandler.callbackQuery(/^user:ft:go:([0-9a-f-]+)$/, async (ctx) => {
  const user = ctx.dbUser;
  if (user === null) {
    await safeAnswerCallback(ctx);
    return;
  }
  try {
    // Short id only selects WHICH ready panel; every value (quota, duration,
    // expiry, config) is re-read from the database inside the service.
    const panel = await trialPanelByShortId(ctx.match[1]);
    if (panel === null) {
      await safeAnswerCallback(ctx, TRIAL_NO_PANEL_TEXT);
      return;
    }
    await safeAnswerCallback(ctx, "در حال ساخت اکانت تست...");
    const outcome = await claimFreeTrial(user, panel.id);

    if (outcome.kind === "created") {
      await safeEditOrReply(
        ctx,
        buildTrialSuccessMessage(outcome.service, outcome.claim.durationMinutes ?? 0),
        new InlineKeyboard()
          .text("مشاهده سرویس", svcCb.view(outcome.service.id.slice(0, 8)))
          .row()
          .text("بازگشت به منوی اصلی", CB.USER_MENU),
      );
      return;
    }
    if (outcome.kind === "uncertain") {
      // Never invite an immediate retry on an unknown remote result - the
      // sweep reconciles and notifies once the outcome is known.
      await safeEditOrReply(ctx, TRIAL_UNCERTAIN_TEXT, backToMenuKeyboard());
      return;
    }
    await safeEditOrReply(ctx, outcome.text, backToMenuKeyboard());
  } catch (err) {
    logger.error("free trial claim handler failed", { error: errorMessage(err) });
    await safeAnswerCallback(ctx);
    await safeReply(ctx, TRIAL_TEMP_UNAVAILABLE_TEXT, backToMenuKeyboard());
  }
});
