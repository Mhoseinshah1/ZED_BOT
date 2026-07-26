import { prisma, UserStatus } from "@zedbot/database";
import {
  evaluateForceJoinMembership,
  httpForceJoinMembershipApi,
  listActiveChannels,
} from "@zedbot/force-join";

// =============================================================================
// Transport-independent Mini App access policy.
//
// The bot enforces the same gates through grammY middleware that renders
// Telegram messages. None of that can be imported here: the API must not depend
// on grammY, on `BotContext`, or on message rendering. What this module shares
// with the bot is the AUTHORITY — the same Setting rows, the same tables, and
// for Force Join the same `@zedbot/force-join` decision procedure — not the
// transport. Sharing the DECISION rather than re-deriving it is what keeps a
// gate satisfiable: whatever clears it in the bot clears it here.
//
// Every outcome is a structured code. No database error, internal id or gate
// detail ever reaches the client; the frontend maps the code to Persian text and
// (where the requirement can only be completed in Telegram) an "open bot" action.
//
// FAIL CLOSED. A gate that cannot be evaluated returns a retryable code rather
// than admitting the request. A transient database blip must never look like
// "maintenance is off" or "terms are accepted".
// =============================================================================

export type MiniAppAccessCode =
  | "MAINTENANCE"
  | "USER_BLOCKED"
  | "USER_DISABLED"
  | "USER_UNAVAILABLE"
  | "TERMS_REQUIRED"
  | "FORCE_JOIN_REQUIRED"
  | "ACCESS_CHECK_UNAVAILABLE";

export interface MiniAppAccessDenied {
  ok: false;
  code: MiniAppAccessCode;
  status: number;
  /** True when the only way forward is to open the bot in Telegram. */
  requiresBot: boolean;
}

export interface MiniAppAccessGranted {
  ok: true;
  user: MiniAppAccessUser;
}

export interface MiniAppAccessUser {
  id: string;
  telegramId: bigint;
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  status: UserStatus;
  group: string;
  balanceToman: number;
  joinedAt: Date;
  forceJoinBypass: boolean;
}

export type MiniAppAccessResult = MiniAppAccessGranted | MiniAppAccessDenied;

const STATUS_BY_CODE: Record<MiniAppAccessCode, number> = {
  MAINTENANCE: 503,
  USER_BLOCKED: 403,
  USER_DISABLED: 403,
  USER_UNAVAILABLE: 403,
  TERMS_REQUIRED: 428,
  FORCE_JOIN_REQUIRED: 403,
  ACCESS_CHECK_UNAVAILABLE: 503,
};

const BOT_REQUIRED: ReadonlySet<MiniAppAccessCode> = new Set<MiniAppAccessCode>([
  "TERMS_REQUIRED",
  "FORCE_JOIN_REQUIRED",
]);

function deny(code: MiniAppAccessCode): MiniAppAccessDenied {
  return { ok: false, code, status: STATUS_BY_CODE[code], requiresBot: BOT_REQUIRED.has(code) };
}

/**
 * Reads a boolean Setting and reports whether the read SUCCEEDED.
 *
 * The bot's `tryGetBooleanSettingFresh` exists for the same reason: a helper
 * that swallows the error and returns its fallback makes a database blip
 * indistinguishable from "the switch is off", and the guard then waves through
 * exactly the request it exists to stop.
 */
async function readBooleanSetting(
  key: string,
): Promise<{ ok: true; value: boolean } | { ok: false }> {
  try {
    const row = await prisma.setting.findUnique({ where: { key }, select: { value: true } });
    const raw = (row?.value ?? "").toLowerCase();
    return { ok: true, value: raw === "true" || raw === "1" || raw === "yes" };
  } catch {
    return { ok: false };
  }
}

/**
 * Evaluates every mandatory gate for one authenticated user id.
 *
 * Called on EVERY authenticated request, never cached in the session: a cookie
 * minted before someone was blocked must stop working the moment the row says
 * so. The order mirrors the bot's: platform-wide first, then account, then the
 * requirements a user can satisfy themselves.
 */
export async function evaluateMiniAppAccess(userId: string): Promise<MiniAppAccessResult> {
  // 1. Maintenance — platform-wide, checked before anything user-specific.
  const maintenance = await readBooleanSetting("maintenance_mode");
  if (!maintenance.ok) {
    return deny("ACCESS_CHECK_UNAVAILABLE");
  }
  if (maintenance.value) {
    return deny("MAINTENANCE");
  }

  // 2. Account status, read fresh from the authoritative row.
  let user: MiniAppAccessUser | null;
  try {
    user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        telegramId: true,
        firstName: true,
        lastName: true,
        username: true,
        status: true,
        group: true,
        balanceToman: true,
        joinedAt: true,
        forceJoinBypass: true,
      },
    });
  } catch {
    return deny("ACCESS_CHECK_UNAVAILABLE");
  }
  // A user row is never hard-deleted; DELETED is a status. Treating it as
  // "unavailable" rather than "disabled" keeps the two apart for the UI without
  // telling the caller which one it hit.
  if (user === null || user.status === UserStatus.DELETED) {
    return deny("USER_UNAVAILABLE");
  }
  if (user.status === UserStatus.BLOCKED) {
    return deny("USER_BLOCKED");
  }
  if (user.status !== UserStatus.ACTIVE) {
    return deny("USER_DISABLED");
  }

  // 3. Versioned mandatory terms. Acceptance is recorded against a specific
  //    document id, so publishing a new version re-gates everyone — exactly as
  //    it does in the bot.
  const termsGate = await evaluateTermsGate(user.id);
  if (termsGate !== null) {
    return termsGate;
  }

  // 4. Mandatory channel membership.
  const forceJoinGate = await evaluateForceJoinGate(user.telegramId, user.forceJoinBypass);
  if (forceJoinGate !== null) {
    return forceJoinGate;
  }

  return { ok: true, user };
}

async function evaluateTermsGate(userId: string): Promise<MiniAppAccessDenied | null> {
  // `terms_required` is the key the bot's terms service owns.
  const enabled = await readBooleanSetting("terms_required");
  if (!enabled.ok) {
    return deny("ACCESS_CHECK_UNAVAILABLE");
  }
  if (!enabled.value) {
    return null;
  }
  try {
    const published = await prisma.termsDocument.findFirst({
      where: { status: "PUBLISHED" },
      orderBy: { version: "desc" },
      select: { id: true },
    });
    if (published === null) {
      // Enabled with nothing published gates nobody — the same conclusion the
      // bot reaches, and not a reason to lock the account out.
      return null;
    }
    const accepted = await prisma.termsAcceptance.findFirst({
      where: { userId, termsDocumentId: published.id },
      select: { id: true },
    });
    return accepted === null ? deny("TERMS_REQUIRED") : null;
  } catch {
    return deny("ACCESS_CHECK_UNAVAILABLE");
  }
}

/**
 * Mandatory channel membership.
 *
 * Evaluated for real, against the same authority the bot uses: a LIVE
 * `getChatMember` for every currently active required channel, through the
 * shared `@zedbot/force-join` checker. Same Redis verdict cache, same error
 * classification, same unhealthy-channel rule. Only the transport differs — the
 * bot passes grammY's `ctx.api`, the API passes a plain fetch client — because
 * grammY must not enter this process.
 *
 * Sharing the checker is the point. An earlier version answered
 * `FORCE_JOIN_REQUIRED` whenever the gate was armed, without ever establishing
 * membership: a user who joined and verified in the bot was refused by the Mini
 * App forever, with no action available anywhere that could clear it.
 *
 * Nothing the frontend says is consulted. There is no "I joined" claim to
 * trust, and no membership fact is stored in the session — every request
 * re-derives it.
 *
 * Fails CLOSED on uncertainty: a transient Telegram failure, an unreadable
 * setting, an unreadable channel list, or a missing bot token all deny rather
 * than admit. The one case that deliberately passes is the bot's own D4 rule —
 * when every active channel is unverifiable the gate enforces nothing, so users
 * are not bricked by a broken configuration.
 */
async function evaluateForceJoinGate(
  telegramId: bigint,
  bypass: boolean,
): Promise<MiniAppAccessDenied | null> {
  if (bypass) {
    return null;
  }
  const enabled = await readBooleanSetting("force_join_enabled");
  if (!enabled.ok) {
    return deny("ACCESS_CHECK_UNAVAILABLE");
  }
  if (!enabled.value) {
    return null;
  }

  let channels;
  try {
    channels = await listActiveChannels();
  } catch {
    return deny("ACCESS_CHECK_UNAVAILABLE");
  }
  if (channels.length === 0) {
    // Enabled with zero active channels enforces nothing (D4) — the same
    // conclusion `resolveForceJoinGate` reaches in the bot.
    return null;
  }

  const api = httpForceJoinMembershipApi();
  if (api === null) {
    // No bot token in this process: membership is UNKNOWABLE, not satisfied.
    return deny("ACCESS_CHECK_UNAVAILABLE");
  }

  let outcome;
  try {
    outcome = await evaluateForceJoinMembership({
      api,
      userTelegramId: telegramId,
      channels,
      // The Mini App has no "بررسی عضویت" button; a user who just joined clears
      // the short negative TTL on their next request, exactly as the bot's
      // middleware does. Bypassing the cache here would let a reload loop hammer
      // the Bot API.
      bypassNegativeCache: false,
    });
  } catch {
    return deny("ACCESS_CHECK_UNAVAILABLE");
  }

  if (outcome.decision === "PASS") {
    return null;
  }
  // TEMP_FAILURE is uncertainty, not a verdict: retryable, and never rendered as
  // "you are not a member".
  return deny(outcome.decision === "TEMP_FAILURE" ? "ACCESS_CHECK_UNAVAILABLE" : "FORCE_JOIN_REQUIRED");
}
