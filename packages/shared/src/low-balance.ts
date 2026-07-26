// =============================================================================
// Low wallet balance notifications — the ONE dependency-free (no prisma /
// bullmq) contract shared by the in-transaction wallet observer, the delivery
// re-validation, the reconciliation sweep, the backfill and the admin UI.
//
// CANONICAL MONEY UNIT
// --------------------
// This repository stores wallet money as WHOLE TOMAN in `User.balanceToman`,
// a Prisma `Int` (PostgreSQL INTEGER, 32-bit). Every amount in this module is
// therefore a plain integral JS `number` bounded by INT32 — deliberately NOT
// BigInt or Decimal, because introducing a second representation of the same
// money would be a second source of truth. INT32 (±2,147,483,647) is far inside
// Number.MAX_SAFE_INTEGER, so integer arithmetic here is exact.
//
// THE STATE MACHINE
// -----------------
//   alert boundary  = threshold
//   re-arm boundary = threshold + rearmMargin
//
// ARMED   --(committed balance <= threshold)-->        ALERTED  (notify once)
// ALERTED --(committed balance >  rearmBoundary)-->    ARMED    (silent re-arm)
//
// A zero margin means re-arm requires the balance to become STRICTLY GREATER
// than the threshold, so a balance resting exactly on the boundary never
// oscillates. Nothing else moves the machine: further decreases while ALERTED
// are silent, and a recovery that does not clear the re-arm boundary is silent.
// =============================================================================

// --- settings keys -----------------------------------------------------------

export const LOW_BALANCE_ENABLED_KEY = "low_balance_notification_enabled";
export const LOW_BALANCE_THRESHOLD_KEY = "low_balance_threshold";
export const LOW_BALANCE_REARM_MARGIN_KEY = "low_balance_rearm_margin";
/**
 * Monotonic counter bumped on every threshold/margin change. Stamped onto each
 * alert cycle so a queued notification is always interpreted under the config
 * it was created with (§13), never under unrelated newer settings.
 */
export const LOW_BALANCE_CONFIG_VERSION_KEY = "low_balance_config_version";
/** Reconciliation sweep cadence (minutes). */
export const LOW_BALANCE_RECONCILE_MINUTES_KEY = "low_balance_reconcile_minutes";

/** The user-facing message template key (editable through the text registry). */
export const LOW_BALANCE_TEMPLATE_KEY = "low_balance_notification_text";

// --- bounds ------------------------------------------------------------------

/**
 * PostgreSQL INTEGER bounds. `User.balanceToman` is an INT, so a threshold that
 * cannot fit in one could never be compared against a real balance — the admin
 * validator rejects it rather than silently overflowing at the database.
 */
export const INT32_MAX = 2_147_483_647;
export const INT32_MIN = -2_147_483_648;

/** Reconciliation defaults — bounded work per tick, never a full-table scan. */
export const DEFAULT_LOW_BALANCE_RECONCILE_MINUTES = 15;
export const LOW_BALANCE_RECONCILE_BATCH = 500;
export const LOW_BALANCE_RECONCILE_MAX_BATCHES = 20;

/** Backfill defaults — bounded enqueue per tick so a blast is spread out. */
export const LOW_BALANCE_BACKFILL_BATCH = 200;
export const LOW_BALANCE_BACKFILL_MAX_BATCHES = 10;

/**
 * Bumped when the dedupe/eligibility semantics of this rule change, so old
 * dedupe keys cannot suppress a corrected notification. Mirrors the existing
 * `AutomatedNotification.ruleVersion` convention.
 */
export const LOW_BALANCE_RULE_VERSION = 1;

// --- config ------------------------------------------------------------------

export interface LowBalanceConfig {
  enabled: boolean;
  /** Alert boundary, whole Toman. A balance <= this is "low". */
  thresholdToman: number;
  /** Added to the threshold to obtain the re-arm boundary. >= 0. */
  rearmMarginToman: number;
  /** Durable config version stamped onto each alert cycle. */
  configVersion: number;
}

export const DEFAULT_LOW_BALANCE_THRESHOLD_TOMAN = 100_000;
export const DEFAULT_LOW_BALANCE_REARM_MARGIN_TOMAN = 20_000;

/**
 * Seeded default. DISABLED on purpose: §2 requires that deploying this feature
 * changes nothing until an OWNER turns it on deliberately.
 */
export const DEFAULT_LOW_BALANCE_CONFIG: LowBalanceConfig = {
  enabled: false,
  thresholdToman: DEFAULT_LOW_BALANCE_THRESHOLD_TOMAN,
  rearmMarginToman: DEFAULT_LOW_BALANCE_REARM_MARGIN_TOMAN,
  configVersion: 1,
};

// --- boundaries --------------------------------------------------------------

/**
 * The re-arm boundary. Kept as one function so the worker, the delivery
 * re-validation, the reconciliation query and the admin overview can never
 * disagree about where the boundary sits.
 *
 * Saturates at INT32_MAX: threshold and margin are each individually bounded,
 * but their sum is not, and an overflowed boundary would silently stop every
 * re-arm.
 */
export function rearmBoundaryToman(config: Pick<LowBalanceConfig, "thresholdToman" | "rearmMarginToman">): number {
  const sum = config.thresholdToman + config.rearmMarginToman;
  return sum > INT32_MAX ? INT32_MAX : sum;
}

/** A balance is LOW when it is at or below the alert boundary. */
export function isLowBalance(balanceToman: number, config: Pick<LowBalanceConfig, "thresholdToman">): boolean {
  return balanceToman <= config.thresholdToman;
}

/**
 * A balance RE-ARMS only when strictly above the re-arm boundary. Strictness is
 * what makes a zero margin behave as documented: sitting exactly on the
 * threshold is still low, so the machine cannot flip-flop on the boundary.
 */
export function isRearmed(
  balanceToman: number,
  config: Pick<LowBalanceConfig, "thresholdToman" | "rearmMarginToman">,
): boolean {
  return balanceToman > rearmBoundaryToman(config);
}

// --- transition --------------------------------------------------------------

export type LowBalanceState = "ARMED" | "ALERTED";

export type LowBalanceTransition =
  /** ARMED -> ALERTED: the one transition that produces a user-facing message. */
  | { kind: "alert" }
  /** ALERTED -> ARMED: silent; re-opens the machine for a future alert. */
  | { kind: "rearm" }
  /** No state change. */
  | { kind: "none" };

/**
 * The complete decision, as a pure function of the COMMITTED balance and the
 * current state. Deliberately takes only the post-mutation balance: the "before"
 * value is irrelevant once the durable state row records where the machine
 * already is, which is what makes concurrent debits converge on one alert
 * instead of one alert per debit.
 */
export function evaluateLowBalanceTransition(
  state: LowBalanceState,
  balanceToman: number,
  config: Pick<LowBalanceConfig, "thresholdToman" | "rearmMarginToman">,
): LowBalanceTransition {
  if (state === "ARMED") {
    return isLowBalance(balanceToman, config) ? { kind: "alert" } : { kind: "none" };
  }
  return isRearmed(balanceToman, config) ? { kind: "rearm" } : { kind: "none" };
}

// --- idempotency -------------------------------------------------------------

/**
 * The deterministic notification identity for ONE alert cycle.
 *
 * `cycle` is a per-user counter that only advances on a COMMITTED ARMED->ALERTED
 * transition, so every retry, replica, replayed webhook and duplicated queue
 * delivery for the same crossing derives the same key and collides on
 * `AutomatedNotification.dedupeKey`'s unique index. A second message is only
 * possible after a durable re-arm has incremented the counter.
 *
 * The rule version is included so a future semantics change is not suppressed by
 * historical keys.
 */
export function lowBalanceDedupeKey(userId: string, cycle: number): string {
  return `wallet-low-balance:v${LOW_BALANCE_RULE_VERSION}:${userId}:${cycle}`;
}

/** Backfill-originated cycles share the same key space — one message per cycle. */
export function lowBalanceBackfillDedupeKey(userId: string, cycle: number): string {
  return lowBalanceDedupeKey(userId, cycle);
}

// --- validation --------------------------------------------------------------

export type LowBalanceAmountError =
  | "NOT_A_NUMBER"
  | "NOT_AN_INTEGER"
  | "NEGATIVE"
  | "TOO_LARGE";

export type ParsedAmount =
  | { ok: true; value: number }
  | { ok: false; error: LowBalanceAmountError };

/** Persian and Arabic-Indic digits, mapped to ASCII before parsing. */
const DIGIT_MAP: Record<string, string> = {
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

/**
 * Parses an operator-typed Toman amount.
 *
 * Accepts Persian/Arabic digits and thousands separators (space, comma, ٬, ،)
 * because that is how the amount is actually typed in this bot; rejects anything
 * else. Decimals are rejected outright rather than rounded — the canonical unit
 * is a whole Toman integer, and silently truncating an operator's input would
 * change the boundary they believe they configured.
 */
export function parseTomanAmount(raw: string): ParsedAmount {
  let normalized = "";
  for (const ch of raw.trim()) {
    if (ch === "," || ch === " " || ch === " " || ch === "٬" || ch === "،" || ch === "_") {
      continue;
    }
    normalized += DIGIT_MAP[ch] ?? ch;
  }
  if (normalized === "") {
    return { ok: false, error: "NOT_A_NUMBER" };
  }
  if (/^[-+]?\d+([.٫]\d+)$/.test(normalized)) {
    return { ok: false, error: "NOT_AN_INTEGER" };
  }
  if (!/^[-+]?\d+$/.test(normalized)) {
    return { ok: false, error: "NOT_A_NUMBER" };
  }
  const value = Number(normalized);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, error: "NOT_A_NUMBER" };
  }
  if (value < 0) {
    return { ok: false, error: "NEGATIVE" };
  }
  if (value > INT32_MAX) {
    return { ok: false, error: "TOO_LARGE" };
  }
  return { ok: true, value };
}

/** The canonical money rendering used across this feature's screens. */
export function formatTomanAmount(value: number): string {
  return `${value.toLocaleString("en-US")} تومان`;
}

// --- payload snapshot ---------------------------------------------------------

/**
 * Everything needed to build one low-balance notification's payload snapshot.
 *
 * All three producers — the in-transaction observer, the reconciliation sweep
 * and the backfill — go through this ONE builder, so an alert is byte-identical
 * regardless of which of them opened the cycle.
 */
export interface LowBalanceSnapshotArgs {
  /** The committed post-mutation balance, whole Toman. */
  balanceToman: number;
  thresholdToman: number;
  rearmBoundaryToman: number;
  configVersion: number;
  alertCycle: number;
  origin: "event" | "backfill" | "reconcile";
}

/**
 * Builds the payload snapshot.
 *
 * PRIVACY. The snapshot carries exactly two rendered figures — the user's own
 * balance and the operator's threshold — plus non-rendered diagnostics. It never
 * holds a name, username, phone number, chat id, ledger id or payment token, so
 * a snapshot that leaks into a log cannot identify anyone.
 *
 * The amounts are stored PRE-FORMATTED. The rendering worker performs plain
 * substitution, so formatting here is what guarantees a user never sees a raw
 * integer where a Toman amount belongs.
 */
export function buildLowBalanceSnapshot(args: LowBalanceSnapshotArgs): {
  templateKey: string;
  variables: Record<string, string | number>;
  buttons: { action: string; buttonTextKey: string }[];
  meta: Record<string, string | number>;
} {
  return {
    templateKey: LOW_BALANCE_TEMPLATE_KEY,
    variables: {
      balance: formatTomanAmount(args.balanceToman),
      threshold: formatTomanAmount(args.thresholdToman),
    },
    // Constant action codes: relabelling a button in the text registry can never
    // change where it routes. Neither button charges anything.
    buttons: [
      { action: "t", buttonTextKey: "low_balance_topup" },
      { action: "w", buttonTextKey: "low_balance_view_wallet" },
    ],
    meta: {
      kind: "low-balance",
      // Deliberately NOT `cycle`: the shared re-validation meta already uses
      // that name for the expiry fingerprint, which is a string.
      alertCycle: args.alertCycle,
      // The configuration the cycle was OPENED under. Delivery interprets the
      // alert with these numbers, never with unrelated newer settings (§13).
      configVersion: args.configVersion,
      thresholdToman: args.thresholdToman,
      rearmBoundaryToman: args.rearmBoundaryToman,
      origin: args.origin,
    },
  };
}
