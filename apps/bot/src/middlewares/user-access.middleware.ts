import { UserStatus } from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";
import { type MiddlewareFn } from "grammy";

import { CB } from "../core/callbacks.js";
import type { BotContext } from "../core/context.js";
import { GENERIC_ERROR_TEXT } from "../core/errors.js";
import { logger } from "../core/logger.js";
import { resolveForceJoinGate } from "../services/force-join/force-join-gate.js";
import { getBooleanSetting, tryGetBooleanSettingFresh } from "../services/settings.service.js";
import { OPS_EVENTS, writeSystemLog } from "../services/system-log.service.js";
import { isTermsAcceptCallback } from "../services/terms/terms-callbacks.js";
import {
  getPublishedTerms,
  hasAcceptedTermsDocument,
  TERMS_REQUIRED_KEY,
} from "../services/terms/terms-document.service.js";
import { buildTermsScreen } from "../services/terms/terms-views.js";
import { getMessageTemplate } from "../services/text.service.js";
import { registerOrUpdateUser } from "../services/user.service.js";
import { safeAnswerCallback, safeReply } from "../utils/safe-reply.js";

export const ACCESS_DENIED_TEXT =
  "حساب کاربری شما مسدود شده است. برای بررسی بیشتر با پشتیبانی تماس بگیرید.";

/**
 * "Terms enforcement is on with no published document" is unreachable through
 * the bot, so alerting on every gated request would be noise if it ever did
 * happen. One alert per process per interval is enough to reach the OWNER.
 */
const TERMS_MISCONFIG_ALERT_INTERVAL_MS = 10 * 60_000;
let lastTermsMisconfigAlertAt = 0;

async function reportTermsMisconfiguration(): Promise<void> {
  const now = Date.now();
  if (now - lastTermsMisconfigAlertAt < TERMS_MISCONFIG_ALERT_INTERVAL_MS) {
    return;
  }
  lastTermsMisconfigAlertAt = now;
  logger.warn("terms enforcement enabled with no published document; gate skipped");
  await writeSystemLog({
    level: "WARN",
    eventType: OPS_EVENTS.TERMS_ENFORCEMENT_MISCONFIGURED,
    message:
      "Terms enforcement is enabled but no terms version is published; the terms gate is being skipped.",
    // Counts/flags only — no user identity and no terms content.
    metadata: { publishedVersions: 0 },
    topicKey: "SYSTEM",
  });
}

/** Test hook: forgets the alert de-duplication window. */
export function resetTermsMisconfigAlertForTests(): void {
  lastTermsMisconfigAlertAt = 0;
}

/**
 * User access gate, in spec order:
 *   1. bot disabled (maintenance_mode)      -> bot_off_text
 *   2. user status BLOCKED/DISABLED/DELETED -> access denied
 *   3. terms placeholder (terms_required)   -> accept button
 *   4. force-join placeholder               -> check button
 *
 * Returns true when the user may proceed. Sends the blocking message itself
 * otherwise. Also guarantees ctx.dbUser is set for downstream handlers.
 */
export interface EnsureAccessOptions {
  /**
   * Normally the terms step skips itself for the accept action, so pressing
   * accept is not gated into the very screen it is trying to satisfy. AFTER the
   * acceptance is recorded that skip becomes wrong: if a newer version was
   * published in between, the user still owes it, and keeping the skip would
   * walk them past the gate into the menu. The accept handler therefore re-runs
   * the gate with this set.
   */
  enforceTerms?: boolean;
}

export async function ensureUserAccess(
  ctx: BotContext,
  options: EnsureAccessOptions = {},
): Promise<boolean> {
  const from = ctx.from;
  if (from === undefined || from.is_bot) {
    return false;
  }

  // Callbacks arriving before the user ever sent /start (fresh database,
  // old chat keyboards): register on the fly.
  if (ctx.dbUser === null) {
    try {
      ctx.dbUser = await registerOrUpdateUser(from);
    } catch (err) {
      logger.error("user registration failed", { error: errorMessage(err) });
      await safeAnswerCallback(ctx);
      await safeReply(ctx, GENERIC_ERROR_TEXT);
      return false;
    }
  }
  const user = ctx.dbUser;
  const callbackData = ctx.callbackQuery?.data;

  // 1. Bot disabled
  if (await getBooleanSetting("maintenance_mode", false)) {
    await safeAnswerCallback(ctx);
    await safeReply(ctx, await getMessageTemplate("bot_off_text"));
    return false;
  }

  // 2. Blocked / disabled / deleted users never reach the user menu.
  if (user.status !== UserStatus.ACTIVE) {
    await safeAnswerCallback(ctx);
    await safeReply(ctx, await getMessageTemplate("blocked_text", ACCESS_DENIED_TEXT));
    return false;
  }

  // 3. Versioned mandatory terms (skipped for the accept action itself, which
  //    records the acceptance and then re-enters this gate).
  //
  //    Acceptance is keyed to the PUBLISHED DOCUMENT, never to the legacy
  //    `termsAcceptedAt` timestamp: a user who accepted version 3 has no
  //    acceptance row for version 4, so publishing a new version re-gates
  //    everyone without touching a single user row.
  if (
    (options.enforceTerms === true || !isTermsAcceptCallback(callbackData)) &&
    (await getBooleanSetting(TERMS_REQUIRED_KEY, false))
  ) {
    const published = await getPublishedTerms();
    if (published === null) {
      // Enforcement is on but nothing is published. The admin UI and the
      // service both refuse to reach this state, so it means external/manual
      // tampering or a partial restore. Blocking here would deny every user
      // access with NO action they could take to recover (only the OWNER can
      // publish), so — as with an unverifiable force-join channel — the gate
      // steps aside and raises a durable OWNER alert instead of bricking the bot.
      await reportTermsMisconfiguration();
    } else if (!(await hasAcceptedTermsDocument(user.id, published.id))) {
      await safeAnswerCallback(ctx);
      const screen = await buildTermsScreen(published);
      await safeReply(ctx, screen.text, screen.keyboard);
      return false;
    }
  }

  // 4. Mandatory channel membership (force join). Skipped for the check action
  //    itself — that callback verifies membership on its own (bypassing the
  //    negative cache) and re-enters this gate only after success. forceJoinBypass
  //    users skip the whole check (§4.8). The active set is read once here.
  if (
    callbackData !== CB.FORCE_JOIN_CHECK &&
    !user.forceJoinBypass &&
    (await getBooleanSetting("force_join_enabled", false))
  ) {
    const gate = await resolveForceJoinGate(ctx, user.telegramId, { bypassNegativeCache: false });
    if (!gate.pass) {
      await safeAnswerCallback(ctx);
      if (gate.kind === "TEMP") {
        await safeReply(ctx, gate.text);
      } else {
        await safeReply(ctx, gate.screen.text, gate.screen.keyboard);
      }
      return false;
    }
  }

  return true;
}

/**
 * Gate steps 1-2 ONLY: maintenance mode and account status.
 *
 * The terms-accept action needs these applied BEFORE it records anything — a
 * blocked user pressing a stale accept button must not write an acceptance row,
 * and maintenance mode must not admit database writes. It cannot simply call
 * `ensureUserAccess` first, because that would run the FORCE-JOIN step ahead of
 * terms and invert the documented gate order. Returns true when the caller may
 * proceed; sends its own message otherwise.
 */
export async function ensurePreTermsAccess(ctx: BotContext): Promise<boolean> {
  const from = ctx.from;
  if (from === undefined || from.is_bot) {
    return false;
  }
  // Maintenance FIRST, and read FRESH. registerOrUpdateUser is itself a write
  // (it upserts the user and touches profile / last-seen), so checking after it
  // would let the very scenario this guard exists to stop through. The cached
  // reader can serve a stale `false` for its TTL — and in a multi-process
  // deployment for longer — which is exactly the window in which an operator
  // has just declared an emergency, so this one precondition pays for a real
  // read rather than trusting the cache.
  //
  // And it FAILS CLOSED. The ordinary fresh reader returns its fallback when
  // the query errors, so a transient database failure would read exactly like
  // "maintenance is off" and this guard would wave through the write it exists
  // to stop — while the later cached gate could still say `true` and block the
  // user, after the acceptance had already been recorded. "We could not read
  // the switch" is not "the switch is off".
  const maintenance = await tryGetBooleanSettingFresh("maintenance_mode", false);
  if (!maintenance.ok) {
    await safeAnswerCallback(ctx);
    await safeReply(ctx, GENERIC_ERROR_TEXT);
    return false;
  }
  if (maintenance.value) {
    await safeAnswerCallback(ctx);
    await safeReply(ctx, await getMessageTemplate("bot_off_text"));
    return false;
  }
  if (ctx.dbUser === null) {
    try {
      ctx.dbUser = await registerOrUpdateUser(from);
    } catch (err) {
      logger.error("user registration failed", { error: errorMessage(err) });
      await safeAnswerCallback(ctx);
      await safeReply(ctx, GENERIC_ERROR_TEXT);
      return false;
    }
  }
  if (ctx.dbUser.status !== UserStatus.ACTIVE) {
    await safeAnswerCallback(ctx);
    await safeReply(ctx, await getMessageTemplate("blocked_text", ACCESS_DENIED_TEXT));
    return false;
  }
  return true;
}

/** Middleware form of ensureUserAccess for user-facing composers. */
export function userAccessMiddleware(): MiddlewareFn<BotContext> {
  return async (ctx, next) => {
    if (await ensureUserAccess(ctx)) {
      await next();
    }
  };
}
