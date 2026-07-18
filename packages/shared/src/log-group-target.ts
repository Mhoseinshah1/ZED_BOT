// =============================================================================
// Direct-log-group-setup phase: numeric chat-id normalization + the ONE
// shared log-group validation policy. Dependency-free (no prisma, no grammY,
// no fetch) so the bot (grammY probe) and any other caller normalize their
// raw API responses into LogGroupTargetProbe and reach an identical verdict.
// Persian strings here are the exact safe operator-facing messages.
// =============================================================================

// --- numeric chat-id normalization -------------------------------------------

// Persian (U+06F0..U+06F9) and Arabic-Indic (U+0660..U+0669) digit maps.
const PERSIAN_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const ARABIC_DIGITS = "٠١٢٣٤٥٦٧٨٩";

// Every Unicode dash/minus variant a copy-paste can carry, folded to ASCII
// '-': hyphen-minus is left as-is; these are the look-alikes.
const MINUS_VARIANTS = /[\u2010-\u2015\u2212\u2043\uFE58\uFE63\uFF0D]/g;

// Whitespace incl. NBSP + zero-width/bidi/format marks that frame pasted ids
// (\s covers ordinary spaces/tabs/newlines; the rest are explicit \u code
// points STRIPPED individually - the ZWJ trips no-misleading-character-class
// which does not apply here since nothing is meant to combine).
// eslint-disable-next-line no-misleading-character-class
const STRIP_CHARS = /[\s\u00A0\u200B\u200C\u200D\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * A Telegram supergroup chat id after normalization: `-100` followed by
 * 6-20 digits. Deliberately conservative - the prefix alone is NEVER proof
 * the group exists; the caller must still validate via Telegram.
 */
export const LOG_GROUP_CHAT_ID_RE = /^-100[0-9]{6,20}$/;

export type NormalizeChatIdResult =
  | { ok: true; chatId: string }
  | { ok: false };

/**
 * Normalizes user-entered supergroup chat id: Persian/Arabic digits -> latin,
 * Unicode minus look-alikes -> '-', all whitespace/zero-width stripped, then
 * validates the `-100…` shape. Rejects empty, positive ids, decimals,
 * scientific notation, usernames, links, invite links, mixed text and
 * over-long values. The value is kept as a STRING and never passed through
 * Number() (a 64-bit chat id would lose precision as a float).
 */
export function normalizeChatIdInput(raw: unknown): NormalizeChatIdResult {
  if (typeof raw !== "string") {
    return { ok: false };
  }
  // Hard length cap BEFORE work: a real id is ~14 chars; anything much longer
  // is pasted junk (and bounds the regex/loop cost).
  if (raw.length > 64) {
    return { ok: false };
  }
  let out = "";
  for (const ch of raw.normalize("NFKC")) {
    const p = PERSIAN_DIGITS.indexOf(ch);
    if (p >= 0) {
      out += String(p);
      continue;
    }
    const a = ARABIC_DIGITS.indexOf(ch);
    if (a >= 0) {
      out += String(a);
      continue;
    }
    out += ch;
  }
  out = out.replace(MINUS_VARIANTS, "-").replace(STRIP_CHARS, "").trim();
  if (!LOG_GROUP_CHAT_ID_RE.test(out)) {
    return { ok: false };
  }
  return { ok: true, chatId: out };
}

// --- shared validation policy ------------------------------------------------

/** The normalized target snapshot both transports produce for the policy. */
export interface LogGroupTargetProbe {
  /** getChat succeeded (chat exists and the bot can see it). */
  found: boolean;
  /** "supergroup" | "group" | "channel" | "private" | null. */
  chatType: string | null;
  /** Forum/Topics mode enabled. */
  isForum: boolean;
  /** Public @username, or null for a private group. */
  username: string | null;
  /** Safe display title (already length-bounded by the caller). */
  title: string | null;
  /** getChatMember(bot) status: administrator|member|left|kicked|... */
  botStatus: string | null;
  /** Bot admin right to manage forum topics. */
  botCanManageTopics: boolean;
  /**
   * Explicit send permission when Telegram exposes one (restricted members);
   * for admins Telegram reports no per-admin send flag, so true = "not
   * denied". Set false ONLY when an explicit deny is observed.
   */
  botCanSend: boolean;
  /** The requesting OWNER is a present member of the target group. */
  ownerIsMember: boolean;
}

export type LogGroupSafeCode =
  | "NOT_FOUND"
  | "NOT_SUPERGROUP"
  | "TOPICS_DISABLED"
  | "BOT_NOT_MEMBER"
  | "BOT_NOT_ADMIN"
  | "MISSING_TOPIC_PERMISSION"
  | "SEND_UNAVAILABLE"
  | "OWNER_NOT_MEMBER";

/** Exact safe Persian messages per validation failure (spec verbatim). */
export const LOG_GROUP_SAFE_MESSAGES: Record<LogGroupSafeCode, string> = {
  NOT_FOUND: "گروه پیدا نشد.\n\nمطمئن شوید آیدی صحیح است و ربات داخل گروه حضور دارد.",
  NOT_SUPERGROUP: "گروه انتخاب‌شده سوپرگروه نیست.",
  TOPICS_DISABLED: "قابلیت موضوعات گروه فعال نیست.\n\nابتدا Topics را در تنظیمات گروه فعال کنید.",
  BOT_NOT_MEMBER: "ربات داخل این گروه عضو نیست.\n\nابتدا ربات را به گروه اضافه کنید.",
  BOT_NOT_ADMIN: "ربات باید در این گروه مدیر باشد.",
  MISSING_TOPIC_PERMISSION: "دسترسی مدیریت موضوعات برای ربات فعال نیست.",
  SEND_UNAVAILABLE: "ربات اجازه ارسال پیام در این گروه را ندارد.",
  OWNER_NOT_MEMBER: "مدیر اصلی ربات باید عضو گروه انتخاب‌شده باشد.",
};

export type EvaluateLogGroupResult =
  | { ok: true; isPublic: boolean; title: string }
  | { ok: false; safeCode: LogGroupSafeCode; safeMessage: string };

/**
 * The single log-group acceptance policy. Checks run in a fixed order so the
 * FIRST unmet requirement is the reported one. Never inspects raw Telegram
 * payloads - only the normalized probe.
 */
export function evaluateLogGroupTarget(probe: LogGroupTargetProbe): EvaluateLogGroupResult {
  const fail = (safeCode: LogGroupSafeCode): EvaluateLogGroupResult => ({
    ok: false,
    safeCode,
    safeMessage: LOG_GROUP_SAFE_MESSAGES[safeCode],
  });

  if (!probe.found) {
    return fail("NOT_FOUND");
  }
  if (probe.chatType !== "supergroup") {
    return fail("NOT_SUPERGROUP");
  }
  if (!probe.isForum) {
    return fail("TOPICS_DISABLED");
  }
  if (probe.botStatus === null || probe.botStatus === "left" || probe.botStatus === "kicked") {
    return fail("BOT_NOT_MEMBER");
  }
  if (probe.botStatus !== "administrator" && probe.botStatus !== "creator") {
    return fail("BOT_NOT_ADMIN");
  }
  if (!probe.botCanManageTopics) {
    return fail("MISSING_TOPIC_PERMISSION");
  }
  if (!probe.botCanSend) {
    return fail("SEND_UNAVAILABLE");
  }
  if (!probe.ownerIsMember) {
    return fail("OWNER_NOT_MEMBER");
  }
  return { ok: true, isPublic: probe.username !== null, title: probe.title ?? "بدون نام" };
}
