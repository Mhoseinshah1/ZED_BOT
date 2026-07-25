import { errorMessage } from "@zedbot/shared";
import { Composer } from "grammy";

import { CB } from "../core/callbacks.js";
import type { BotContext } from "../core/context.js";
import { GENERIC_ERROR_TEXT } from "../core/errors.js";
import { logger } from "../core/logger.js";
import {
  ensurePreTermsAccess,
  ensureUserAccess,
  type EnsureAccessOptions,
} from "../middlewares/user-access.middleware.js";
import {
  parseTermsAcceptCallback,
  TERMS_ACCEPT_ROUTE_PATTERN,
} from "../services/terms/terms-callbacks.js";
import {
  clearSettingCacheKeys,
  getBooleanSettingFresh,
} from "../services/settings.service.js";
import {
  getPublishedTerms,
  recordTermsAcceptance,
  resolveTermsDocumentByShortId,
  TERMS_REQUIRED_KEY,
} from "../services/terms/terms-document.service.js";
import {
  buildTermsScreen,
  TERMS_ACCEPTED_TOAST_FALLBACK,
  TERMS_STALE_TEXT_FALLBACK,
} from "../services/terms/terms-views.js";
import { getMessageTemplate } from "../services/text.service.js";
import { registerOrUpdateUser } from "../services/user.service.js";
import { safeAnswerCallback, safeReply } from "../utils/safe-reply.js";
import { showUserMenu } from "./menu.handler.js";

// =============================================================================
// Versioned mandatory terms: the USER acceptance action (§4, §6).
//
// One invariant governs this whole file: a user can accept ONLY the exact
// document body that was rendered with the button they pressed. The button
// carries a document id, the service refuses any id that is not the currently
// published document, and a refusal records nothing. There is no code path
// from a stale button to an acceptance.
//
// A refusal re-draws the CURRENT terms only when there IS a current version to
// show (STALE). When the refusal says the requirement itself is gone —
// enforcement switched off (DISABLED) or nothing published at all (NOT_FOUND) —
// re-drawing would strand the user on a screen no acceptance can ever satisfy,
// so the access path runs instead and decides where they belong.
//
// After a successful acceptance the full access path is re-run, so the user
// continues to the force-join screen or the normal menu exactly as the gate
// order dictates. Nothing else about the user is touched.
// =============================================================================

export const termsHandler = new Composer<BotContext>();

/**
 * Re-draws the CURRENT terms after a stale/unknown button.
 *
 * Returns false — having sent nothing — when there is no published document to
 * draw. Callers must then hand the user to the access path rather than report
 * the absence: "enforcement on, nothing published" is the recoverable
 * misconfiguration `ensureUserAccess` deliberately steps aside for, and a
 * message about it is a dead end no button can clear.
 */
async function redrawCurrentTerms(ctx: BotContext, notice: string): Promise<boolean> {
  const published = await getPublishedTerms();
  if (published === null) {
    return false;
  }
  await safeAnswerCallback(ctx, notice);
  const screen = await buildTermsScreen(published);
  await safeReply(ctx, screen.text, screen.keyboard);
  return true;
}

/** Acknowledges the press and lets the access path decide where the user goes. */
async function continueThroughAccessPath(
  ctx: BotContext,
  options: EnsureAccessOptions = {},
): Promise<void> {
  await safeAnswerCallback(ctx);
  if (await ensureUserAccess(ctx, options)) {
    await showUserMenu(ctx);
  }
}

// Routed on the PREFIX, not the strict payload shape: a malformed short id must
// reach this handler and be told the button is stale. Binding the strict pattern
// here would let `user:terms:accept:zzz` fall through unanswered while the access
// gate had already skipped itself for it.
termsHandler.callbackQuery(TERMS_ACCEPT_ROUTE_PATTERN, async (ctx) => {
  const from = ctx.from;
  if (from === undefined) {
    return;
  }

  // Maintenance mode and account status apply BEFORE anything is recorded: a
  // blocked user pressing a stale accept button must not write an acceptance
  // row. (The terms and force-join steps are deliberately NOT applied here —
  // this action is the terms step, and force join must stay after it.)
  if (!(await ensurePreTermsAccess(ctx))) {
    return;
  }

  const staleNotice = await getMessageTemplate("terms_stale_text", TERMS_STALE_TEXT_FALLBACK);

  try {
    if (ctx.dbUser === null) {
      ctx.dbUser = await registerOrUpdateUser(from);
    }

    // The short id identifies WHICH document this button was rendered for. An
    // unknown, ambiguous or malformed prefix resolves to null and accepts
    // nothing — the user is shown the current terms and must press the current
    // button.
    const shortId = parseTermsAcceptCallback(ctx.callbackQuery.data);
    const document = shortId === null ? null : await resolveTermsDocumentByShortId(shortId);
    if (document === null) {
      // No document id to hand to the service, so its authoritative switch
      // check never runs — this branch has to make it itself, exactly as the
      // legacy route does. Disabling enforcement does NOT unpublish the current
      // version, so without this the user would be re-shown terms the bot no
      // longer requires and would need a second press to get past them.
      //
      // ...and if enforcement IS on but nothing is published, there is no
      // current button to point at either. Both ways out are the access path.
      const stillRequired = await getBooleanSettingFresh(TERMS_REQUIRED_KEY, false);
      if (!stillRequired) {
        await continueThroughAccessPath(ctx);
        return;
      }
      if (await redrawCurrentTerms(ctx, staleNotice)) {
        return;
      }
      await continueThroughAccessPath(ctx, { enforceTerms: true });
      return;
    }

    const result = await recordTermsAcceptance(ctx.dbUser.id, document.id);
    if (!result.ok && result.code === "STALE") {
      // A newer version was published between render and press (or the button
      // was for an archived version). No acceptance of the current version was
      // recorded, so the user is shown the version they actually owe. STALE
      // means a published document existed a moment ago; if it has since been
      // archived, fall through to the access path rather than a dead end.
      if (await redrawCurrentTerms(ctx, staleNotice)) {
        return;
      }
      await continueThroughAccessPath(ctx, { enforceTerms: true });
      return;
    }

    if (result.ok) {
      // Re-read the user so the freshly stamped termsAcceptedAt is in context.
      ctx.dbUser = await registerOrUpdateUser(from);
      await safeAnswerCallback(
        ctx,
        await getMessageTemplate("terms_accepted_toast", TERMS_ACCEPTED_TOAST_FALLBACK),
      );
    } else {
      // DISABLED: enforcement was switched off after this keyboard was rendered.
      // NOT_FOUND: enforcement is on but nothing is published — the same
      // "unreachable misconfiguration" state the access gate deliberately steps
      // aside for (only the OWNER can publish, so blocking would be a lockout
      // with no user-side recovery). Both wrote nothing, so acknowledge without
      // claiming an acceptance and let the access path decide what comes next.
      //
      // DISABLED was decided against the DATABASE inside the acceptance
      // transaction, but `ensureUserAccess` reads the switch through the 30s
      // settings cache. If another worker flipped it off, this worker's cache
      // can still say `true` and would re-draw the very screen the switch just
      // retired — an unacceptable loop, since pressing accept again returns
      // DISABLED again. Drop the cached entry so the re-entry re-reads it.
      if (result.code === "DISABLED") {
        clearSettingCacheKeys([TERMS_REQUIRED_KEY]);
      }
      await safeAnswerCallback(ctx);
    }
  } catch (err) {
    logger.error("accepting terms failed", { error: errorMessage(err) });
    await safeAnswerCallback(ctx);
    await safeReply(ctx, GENERIC_ERROR_TEXT);
    return;
  }

  // Re-run the FULL access path with the terms step ENFORCED. The default skip
  // exists so the accept action is not gated into its own screen, but the
  // acceptance has now been recorded — and if a newer version was published
  // while this callback was in flight, the user owes that one and must see it
  // rather than the menu.
  if (await ensureUserAccess(ctx, { enforceTerms: true })) {
    await showUserMenu(ctx);
  }
});

/**
 * Keyboards sent BEFORE this upgrade carry the old version-less `terms:accept`.
 * That payload names no document, so it can never satisfy the "accept exactly
 * what you were shown" invariant and accepts nothing. It is answered here
 * (rather than left to fall through unhandled) with the current terms and the
 * current button — or, when the requirement is switched off or has no current
 * version, with the access path, which is what the user needs to proceed.
 */
termsHandler.callbackQuery(CB.TERMS_ACCEPT, async (ctx) => {
  // Same preflight as the versioned button: maintenance mode and account status
  // decide whether this user gets any answer at all. It records nothing either
  // way, but a blocked user or a bot in maintenance must not be handed a terms
  // screen instead of the message that explains why they are stopped.
  if (!(await ensurePreTermsAccess(ctx))) {
    return;
  }

  try {
    // Respect the CURRENT switch. If enforcement was turned off since this
    // keyboard was sent there is nothing to accept, so re-drawing the terms
    // would strand the user on a screen the bot no longer requires.
    if (!(await getBooleanSettingFresh(TERMS_REQUIRED_KEY, false))) {
      await continueThroughAccessPath(ctx);
      return;
    }

    // Enforcement IS on — but if nothing is published there is no current
    // button to hand over, and reporting that is a dead end. The access gate
    // steps aside for exactly this state (§4), so this path must too; the
    // repair migration reaches it whenever it archives an unusable version 1.
    if (
      !(await redrawCurrentTerms(
        ctx,
        await getMessageTemplate("terms_stale_text", TERMS_STALE_TEXT_FALLBACK),
      ))
    ) {
      await continueThroughAccessPath(ctx);
    }
  } catch (err) {
    logger.error("legacy terms callback failed", { error: errorMessage(err) });
    await safeAnswerCallback(ctx);
    await safeReply(ctx, GENERIC_ERROR_TEXT);
  }
});
