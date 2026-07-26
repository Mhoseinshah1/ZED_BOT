// =============================================================================
// Display formatting.
//
// Pure functions over primitives, kept out of the components so they can be
// tested without a DOM. Every one of them is defensive about its input: these
// values arrive over the network, and a component that throws while rendering a
// malformed date takes the whole screen down.
//
// Numbers are rendered with Persian digits because the rest of the product is
// Persian and mixing Latin numerals into an RTL layout reads badly. Dates use
// the Persian (Jalali) calendar via `Intl`, which every engine Telegram embeds
// supports; if a runtime somehow lacks the calendar data, the formatter falls
// back rather than failing.
// =============================================================================

const PERSIAN_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

/** Rewrites ASCII digits as Persian ones, leaving everything else alone. */
export function toPersianDigits(input: string): string {
  return input.replace(/[0-9]/g, (digit) => PERSIAN_DIGITS[Number(digit)]);
}

/** Thousands-separated Persian numerals. Non-finite input renders as "۰". */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return toPersianDigits("0");
  }
  const rounded = Math.round(value);
  const sign = rounded < 0 ? "−" : "";
  const grouped = Math.abs(rounded)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, "٬");
  return sign + toPersianDigits(grouped);
}

/** A Toman amount with its unit, sign-aware for ledger rows. */
export function formatToman(value: number): string {
  return `${formatNumber(value)} تومان`;
}

/** Signed amount for a wallet row: credits carry "+", debits "−". */
export function formatSignedToman(value: number): string {
  if (value > 0) {
    return `+${formatToman(value)}`;
  }
  return formatToman(value);
}

const BYTE_UNITS = ["بایت", "کیلوبایت", "مگابایت", "گیگابایت", "ترابایت", "پتابایت"];

/**
 * Human-readable data volume.
 *
 * Takes a STRING because the API sends BigInt columns as decimal strings — a
 * volume above 2^53 is representable on a large plan and must not be rounded on
 * its way through a double. The conversion to a display number happens only
 * after the unit has been chosen, where the loss is below the rendered
 * precision anyway.
 */
export function formatBytes(raw: string): string {
  if (!/^-?\d+$/.test(raw)) {
    return "—";
  }
  let value: bigint;
  try {
    value = BigInt(raw);
  } catch {
    return "—";
  }
  if (value < 0n) {
    return "—";
  }
  if (value === 0n) {
    return `${toPersianDigits("0")} ${BYTE_UNITS[0]}`;
  }
  let unit = 0;
  let scaled = value;
  // Integer division down to the right unit first; only the last step becomes a
  // double, so the exponent is always chosen from the exact value.
  while (scaled >= 1024n && unit < BYTE_UNITS.length - 1) {
    scaled /= 1024n;
    unit += 1;
  }
  const divisor = 1024 ** unit;
  const display = Number(value) / divisor;
  const text = display >= 100 || unit === 0 ? display.toFixed(0) : display.toFixed(1);
  return `${toPersianDigits(text.replace(".", "٫"))} ${BYTE_UNITS[unit]}`;
}

/** Percentage of a quota consumed, clamped to 0-100 for the progress bar. */
export function usagePercent(usedRaw: string, totalRaw: string): number {
  if (!/^\d+$/.test(usedRaw) || !/^\d+$/.test(totalRaw)) {
    return 0;
  }
  const total = BigInt(totalRaw);
  if (total <= 0n) {
    return 0;
  }
  const used = BigInt(usedRaw);
  const percent = Number((used * 1000n) / total) / 10;
  return Math.max(0, Math.min(100, percent));
}

const dateFormatter = buildDateFormatter();

function buildDateFormatter(): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return null;
  }
}

/** An ISO timestamp as a Persian-calendar date. Invalid input renders "—". */
export function formatDate(iso: string | null): string {
  if (iso === null || iso === "") {
    return "—";
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  if (dateFormatter === null) {
    return toPersianDigits(date.toISOString().slice(0, 10));
  }
  return dateFormatter.format(date);
}

/**
 * Whole days from now until `iso`.
 *
 * Negative when the instant has passed, `null` when there is nothing to count
 * down to. Callers decide how to phrase it; this only does the arithmetic.
 */
export function daysUntil(iso: string | null, nowMs = Date.now()): number | null {
  if (iso === null || iso === "") {
    return null;
  }
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) {
    return null;
  }
  return Math.ceil((target - nowMs) / (24 * 60 * 60 * 1000));
}

/** The display name for a user, falling back through the fields we have. */
export function displayName(user: {
  firstName: string | null;
  lastName: string | null;
  username: string | null;
}): string {
  const parts = [user.firstName, user.lastName].filter(
    (part): part is string => typeof part === "string" && part.trim() !== "",
  );
  if (parts.length > 0) {
    return parts.join(" ");
  }
  if (user.username !== null && user.username.trim() !== "") {
    return `@${user.username}`;
  }
  return "کاربر";
}
