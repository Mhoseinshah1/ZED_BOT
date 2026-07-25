import { type ForceJoinChannel } from "@zedbot/database";
import { InlineKeyboard } from "grammy";

import { CB } from "../../core/callbacks.js";
import type { BotContext } from "../../core/context.js";
import { getButtonText, getMessageTemplate } from "../text.service.js";
import { listActiveChannels } from "./force-join-channel.service.js";
import { evaluateForceJoinMembership } from "./membership.service.js";

// =============================================================================
// Mandatory channel membership (Force Join): user-facing GATE + screen (§4.9).
//
// Resolves whether a user may proceed and, when not, builds the missing-channel
// screen. Shared by the access middleware (which passes the gate with the
// negative cache in play) and the "بررسی عضویت" callback (which bypasses the
// negative cache so a user who just joined is verified immediately). The active
// channel set is read ONCE here per request (§4.13).
// =============================================================================

// Exact spec strings (§4.9 / §D2). Seeded through the text registry in phase 6;
// these are the stable fallbacks. The page header is a NEW key (force_join_page)
// so the legacy force_join_text template stays untouched and operator-editable
// (§4.14).
export const FORCE_JOIN_PAGE_HEADER_FALLBACK =
  "📢 برای استفاده از ربات، ابتدا در کانال‌های زیر عضو شوید و سپس روی «بررسی عضویت» بزنید.";
export const FORCE_JOIN_CHECK_BUTTON_FALLBACK = "بررسی عضویت ✅";
export const FORCE_JOIN_JOIN_PREFIX_FALLBACK = "عضویت در ";
export const FORCE_JOIN_SUPPORT_BUTTON_FALLBACK = "پشتیبانی";
export const FORCE_JOIN_TEMP_FAILURE_FALLBACK =
  "بررسی عضویت موقتاً ممکن نیست. چند لحظه دیگر دوباره تلاش کنید.";
export const FORCE_JOIN_VERIFIED_ANSWER_FALLBACK = "عضویت شما تایید شد ✅";
export const FORCE_JOIN_STILL_MISSING_ANSWER_FALLBACK =
  "هنوز عضویت شما در همه کانال‌ها تایید نشد.";
export const FORCE_JOIN_DEBOUNCE_ANSWER_FALLBACK = "لطفاً چند لحظه صبر کنید و دوباره تلاش کنید.";

const MAX_BUTTON_TITLE_CHARS = 40;

/**
 * Makes a channel title safe for an inline button label: strips control
 * characters, collapses whitespace, and truncates. Button labels are never
 * parsed by Telegram, so no HTML/Markdown escaping is required (§4.9) — the
 * whole screen is sent as plain text.
 */
function safeButtonTitle(title: string): string {
  let cleaned = "";
  for (const ch of title) {
    const code = ch.codePointAt(0) ?? 0;
    cleaned += code < 0x20 || (code >= 0x7f && code <= 0x9f) ? " " : ch;
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) {
    return "کانال";
  }
  return cleaned.length > MAX_BUTTON_TITLE_CHARS
    ? `${cleaned.slice(0, MAX_BUTTON_TITLE_CHARS - 1)}…`
    : cleaned;
}

export interface ForceJoinScreen {
  text: string;
  keyboard: InlineKeyboard;
}

/** Builds the §4.9 missing-channel screen: one URL join button per missing channel. */
export async function buildMissingChannelScreen(
  missing: ForceJoinChannel[],
): Promise<ForceJoinScreen> {
  const header = await getMessageTemplate("force_join_page", FORCE_JOIN_PAGE_HEADER_FALLBACK);
  const joinPrefix = await getButtonText("force_join_join_prefix", FORCE_JOIN_JOIN_PREFIX_FALLBACK);
  const checkLabel = await getButtonText("force_join_check", FORCE_JOIN_CHECK_BUTTON_FALLBACK);
  const supportLabel = await getButtonText("force_join_support", FORCE_JOIN_SUPPORT_BUTTON_FALLBACK);

  const keyboard = new InlineKeyboard();
  for (const channel of missing) {
    keyboard.url(`${joinPrefix}${safeButtonTitle(channel.title)}`, channel.joinUrl).row();
  }
  keyboard.text(checkLabel, CB.FORCE_JOIN_CHECK).row();
  keyboard.text(supportLabel, CB.USER_SUPPORT);

  return { text: header, keyboard };
}

export type ForceJoinGateResolution =
  | { pass: true }
  | { pass: false; kind: "MISSING"; screen: ForceJoinScreen }
  | { pass: false; kind: "TEMP"; text: string };

/**
 * Resolves the force-join gate for a user against a single active-channel
 * snapshot. `pass: true` when force join is satisfied (including the D4 case of
 * zero active channels). Otherwise returns the screen (MISSING) or the temporary
 * failure message (TEMP, D2). Never throws for a Telegram hiccup — that surfaces
 * as TEMP.
 */
export async function resolveForceJoinGate(
  ctx: BotContext,
  userTelegramId: bigint,
  opts: {
    bypassNegativeCache: boolean;
    /**
     * An already-loaded active-channel snapshot. Callers that must inspect the
     * snapshot before deciding whether to check at all (the "بررسی عضویت"
     * callback) pass theirs so the set is still read exactly ONCE per request
     * (§4.13) instead of twice.
     */
    channels?: ForceJoinChannel[];
  },
): Promise<ForceJoinGateResolution> {
  const channels = opts.channels ?? (await listActiveChannels());
  if (channels.length === 0) {
    return { pass: true }; // D4: enabled + zero active valid channels → everyone passes
  }
  const api = {
    getChatMember: (chatId: number | string, userId: number) =>
      ctx.api.getChatMember(chatId, userId),
  };
  const outcome = await evaluateForceJoinMembership({
    api,
    userTelegramId,
    channels,
    bypassNegativeCache: opts.bypassNegativeCache,
  });
  if (outcome.decision === "PASS") {
    return { pass: true };
  }
  if (outcome.decision === "TEMP_FAILURE") {
    return {
      pass: false,
      kind: "TEMP",
      text: await getMessageTemplate("force_join_temp_failure", FORCE_JOIN_TEMP_FAILURE_FALLBACK),
    };
  }
  return { pass: false, kind: "MISSING", screen: await buildMissingChannelScreen(outcome.missing) };
}
