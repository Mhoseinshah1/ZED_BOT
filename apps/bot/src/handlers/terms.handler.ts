import { errorMessage } from "@zedbot/shared";
import { Composer } from "grammy";

import { CB } from "../core/callbacks.js";
import type { BotContext } from "../core/context.js";
import { GENERIC_ERROR_TEXT } from "../core/errors.js";
import { logger } from "../core/logger.js";
import {
  ensurePreTermsAccess,
  ensureUserAccess,
} from "../middlewares/user-access.middleware.js";
import {
  parseTermsAcceptCallback,
  TERMS_ACCEPT_ROUTE_PATTERN,
} from "../services/terms/terms-callbacks.js";
import {
  getPublishedTerms,
  recordTermsAcceptance,
  resolveTermsDocumentByShortId,
} from "../services/terms/terms-document.service.js";
import {
  buildTermsScreen,
  TERMS_ACCEPTED_TOAST_FALLBACK,
  TERMS_STALE_TEXT_FALLBACK,
  TERMS_UNAVAILABLE_TEXT_FALLBACK,
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
// published document, and a refusal re-draws the CURRENT terms rather than
// accepting anything. There is no code path from a stale button to an
// acceptance.
//
// After a successful acceptance the full access path is re-run, so the user
// continues to the force-join screen or the normal menu exactly as the gate
// order dictates. Nothing else about the user is touched.
// =============================================================================

export const termsHandler = new Composer<BotContext>();

/** Re-draws the CURRENT terms after a stale/unknown button, or reports absence. */
async function redrawCurrentTerms(ctx: BotContext, notice: string): Promise<void> {
  const published = await getPublishedTerms();
  if (published === null) {
    await safeAnswerCallback(ctx);
    await safeReply(
      ctx,
      await getMessageTemplate("terms_unavailable_text", TERMS_UNAVAILABLE_TEXT_FALLBACK),
    );
    return;
  }
  await safeAnswerCallback(ctx, notice);
  const screen = await buildTermsScreen(published);
  await safeReply(ctx, screen.text, screen.keyboard);
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
      await redrawCurrentTerms(ctx, staleNotice);
      return;
    }

    const result = await recordTermsAcceptance(ctx.dbUser.id, document.id);
    if (!result.ok) {
      // STALE: a newer version was published between render and press (or the
      // button was for an archived version). NOT_FOUND: nothing is published.
      // Neither records an acceptance of the current version.
      await redrawCurrentTerms(ctx, staleNotice);
      return;
    }

    // Re-read the user so the freshly stamped termsAcceptedAt is in context.
    ctx.dbUser = await registerOrUpdateUser(from);
    await safeAnswerCallback(
      ctx,
      await getMessageTemplate("terms_accepted_toast", TERMS_ACCEPTED_TOAST_FALLBACK),
    );
  } catch (err) {
    logger.error("accepting terms failed", { error: errorMessage(err) });
    await safeAnswerCallback(ctx);
    await safeReply(ctx, GENERIC_ERROR_TEXT);
    return;
  }

  // Re-run the FULL access path: maintenance, account status and force join all
  // still apply, in that order, before the menu is shown.
  if (await ensureUserAccess(ctx)) {
    await showUserMenu(ctx);
  }
});

/**
 * Keyboards sent BEFORE this upgrade carry the old version-less `terms:accept`.
 * That payload names no document, so it can never satisfy the "accept exactly
 * what you were shown" invariant and accepts nothing. It is answered here (
 * rather than left to fall through unhandled) with the current terms and the
 * current button, which is precisely what the user needs to proceed.
 */
termsHandler.callbackQuery(CB.TERMS_ACCEPT, async (ctx) => {
  try {
    await redrawCurrentTerms(
      ctx,
      await getMessageTemplate("terms_stale_text", TERMS_STALE_TEXT_FALLBACK),
    );
  } catch (err) {
    logger.error("legacy terms callback failed", { error: errorMessage(err) });
    await safeAnswerCallback(ctx);
    await safeReply(ctx, GENERIC_ERROR_TEXT);
  }
});
