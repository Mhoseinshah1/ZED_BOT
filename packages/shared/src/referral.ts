// =============================================================================
// Referral affiliate commissions (Phase 1) — the dependency-free (no prisma /
// bullmq) shared contract: settings keys, validated config with code-defaults,
// and the PURE commission calculator the bot service, admin dry-run and tests all
// call. The whole payout is DISABLED by default; referral ATTRIBUTION (linking a
// referred user to a referrer) is a separate, always-on concern handled elsewhere.
// A commission is credited to the REFERRER's internal wallet when a REFERRED user
// completes a qualifying purchase — never more than the configured percent of the
// order, never on a below-minimum order, and (by default) only on the referred
// user's FIRST completed order.
// =============================================================================

import { createHash } from "node:crypto";

/**
 * A short, NON-REVERSIBLE correlation token for structured logs. Referral logs
 * must never carry a raw user / order / referral / commission id (see §5 of the
 * financial-safety audit); when a log genuinely needs to correlate lines for one
 * entity, it emits this 10-hex-char SHA-256 prefix instead — enough to group
 * related events, impossible to turn back into the original id.
 */
export function referralCorrelationHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 10);
}

// --- settings keys -----------------------------------------------------------

/** MASTER switch (false for every install until the OWNER enables it). */
export const REFERRAL_SYSTEM_ENABLED_KEY = "referral_system_enabled";
/** Commission as a whole-number percent of the qualifying order amount. */
export const REFERRAL_COMMISSION_PERCENT_KEY = "referral_commission_percent";
/** When true, only the referred user's FIRST completed order earns a commission. */
export const REFERRAL_FIRST_PURCHASE_ONLY_KEY = "referral_first_purchase_only";
/** Orders paid below this (Toman) never earn a commission. */
export const REFERRAL_MIN_PURCHASE_TOMAN_KEY = "referral_min_purchase_toman";
/**
 * Activation horizon (financial-safety phase). Stamped EXACTLY ONCE the first
 * time the OWNER enables payouts; kept as the earliest instant payouts were ever
 * active (window[0].from). Disabling and re-enabling preserves the original stamp.
 */
export const REFERRAL_COMMISSIONS_STARTED_AT_KEY = "referral_commissions_started_at";
/**
 * Payout ACTIVE-WINDOWS (review-blocker phase). A JSON array of intervals during
 * which payouts were switched ON: [{from, to|null}]. Enabling opens a window,
 * disabling closes it. An order earns a commission ONLY if it completed inside one
 * of these windows — so orders completed while payouts were PAUSED are never
 * back-filled after a later re-enable, and the horizon alone (a single instant) no
 * longer decides eligibility. Committed atomically with the enabled switch.
 */
export const REFERRAL_PAYOUT_WINDOWS_KEY = "referral_payout_windows";

// --- config ------------------------------------------------------------------

export interface ReferralConfig {
  /** Commission percent (0..100) of the qualifying order amount. */
  commissionPercent: number;
  /** Commission only on the referred user's first completed order. */
  firstPurchaseOnly: boolean;
  /** Minimum paid order amount (Toman) that can earn a commission. */
  minPurchaseToman: number;
}

export const DEFAULT_REFERRAL_CONFIG: ReferralConfig = {
  commissionPercent: 10,
  firstPurchaseOnly: true,
  minPurchaseToman: 0,
};

// bounds (all values validated + clamped; an invalid stored value → the default)
export const REFERRAL_MIN_COMMISSION_PERCENT = 0;
export const REFERRAL_MAX_COMMISSION_PERCENT = 100;
export const REFERRAL_MIN_PURCHASE_TOMAN_BOUND = 0;
export const REFERRAL_MAX_PURCHASE_TOMAN_BOUND = 1_000_000_000;

/** Clamp helper: an out-of-range / non-integer value returns the fallback. */
export function clampReferralInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    return fallback;
  }
  return value;
}

// --- pure commission calculator ----------------------------------------------

export interface ReferralCommissionDecision {
  /** True when a positive commission may be credited for this order. */
  eligible: boolean;
  /** The commission amount (Toman) — floored, never over-credited. */
  commissionToman: number;
  /** The percent applied (snapshotted onto the commission row). */
  percent: number;
  reason: "ok" | "invalid-amount" | "below-minimum" | "zero-percent" | "zero-commission";
}

/**
 * Resolves the referral commission for one qualifying order. Pure and deterministic
 * — no clock, no I/O. Never credits more than `percent`% of the order; the amount is
 * FLOORED to whole Toman so a rounding error can never over-credit the referrer. An
 * order below the configured minimum, a zero/invalid amount, a zero percent, or a
 * sub-1-Toman result yields NO commission (the caller records nothing / no wallet
 * credit). First-purchase-only and the enabled switch are enforced by the caller
 * against live DB state; this function only decides the money for an already-eligible
 * order.
 */
export function resolveReferralCommission(input: {
  orderAmountToman: number;
  config: ReferralConfig;
}): ReferralCommissionDecision {
  const { orderAmountToman, config } = input;
  const percent = config.commissionPercent;
  if (!Number.isInteger(orderAmountToman) || orderAmountToman <= 0) {
    return { eligible: false, commissionToman: 0, percent, reason: "invalid-amount" };
  }
  if (orderAmountToman < config.minPurchaseToman) {
    return { eligible: false, commissionToman: 0, percent, reason: "below-minimum" };
  }
  if (percent <= 0) {
    return { eligible: false, commissionToman: 0, percent, reason: "zero-percent" };
  }
  const commissionToman = Math.floor((orderAmountToman * percent) / 100);
  if (commissionToman <= 0) {
    return { eligible: false, commissionToman: 0, percent, reason: "zero-commission" };
  }
  return { eligible: true, commissionToman, percent, reason: "ok" };
}

/** The user-facing t.me deep link that attributes a new user to this referrer. */
export function referralDeepLink(botUsername: string, referralCode: string): string {
  return `https://t.me/${botUsername}?start=${referralCode}`;
}

// --- activation horizon (pure) -----------------------------------------------

/**
 * True when an order completed at/after the activation horizon and may earn a
 * commission. A null horizon means payouts were never properly activated → NO
 * order is eligible (fail-closed; never back-fill history). Deterministic in its
 * inputs — no clock, no I/O.
 */
export function isOrderWithinReferralHorizon(input: {
  orderCompletedAtEpoch: number | null;
  horizonEpoch: number | null;
}): boolean {
  if (input.horizonEpoch === null) {
    return false;
  }
  if (input.orderCompletedAtEpoch === null || !Number.isFinite(input.orderCompletedAtEpoch)) {
    return false;
  }
  return input.orderCompletedAtEpoch >= input.horizonEpoch;
}

// --- payout active-windows (pure) --------------------------------------------

/** One interval during which payouts were switched ON. `to` null = still open. */
export interface ReferralPayoutWindow {
  from: string;
  to: string | null;
}

/** The strict parse result: the usable windows plus an integrity verdict. */
export interface ParsedReferralPayoutWindows {
  /**
   * Sanitized, sorted, non-overlapping windows that are SAFE for eligibility.
   * Never contains a malformed interval and never more than one open window.
   * Eligibility ALWAYS uses this list, so a corrupt store fails CLOSED (an
   * order is only ever paid when it provably falls inside a trustworthy window).
   */
  windows: ReferralPayoutWindow[];
  /**
   * False when the stored value was corrupt (unparseable / not an array), an
   * individual window was malformed (bad `from`, non-null malformed `to`, a
   * reversed `to < from`), or a structural invariant was violated (more than one
   * open window). The OWNER integrity warning fires on `!valid`; the activation
   * gate refuses to enable payouts until windows are valid. A malformed window is
   * NEVER reclassified as an open window (that would reopen payouts).
   */
  valid: boolean;
  /** Safe, id-free reason codes for an OWNER-visible integrity warning. */
  issues: string[];
}

/**
 * STRICTLY parses the stored payout-windows JSON, FAIL-CLOSED. The contract:
 *   - `to === null` is the ONLY representation of an open window;
 *   - a non-null malformed `to` invalidates that window (never coerced to open);
 *   - an invalid `from` invalidates that window;
 *   - `to <= from` (a reversed / zero-length interval) invalidates that window;
 *   - MORE THAN ONE open window is a structural violation → the whole set is
 *     rejected (no eligible orders) so a corrupt "always open" state can't leak;
 *   - overlapping valid windows are safely NORMALIZED (merged into their union);
 *   - corrupt JSON (unparseable / not an array) → no windows + integrity warning.
 * A malformed individual window is DROPPED (its interval never contributes
 * eligibility) and marks the set `invalid` so the OWNER is warned, but the
 * remaining trustworthy windows still work. Deterministic — no clock / I/O.
 */
export function parseReferralPayoutWindowsStrict(
  raw: string | null | undefined,
): ParsedReferralPayoutWindows {
  // Unset / blank = payouts never configured. Valid + empty (fail-closed, no warning).
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) {
    return { windows: [], valid: true, issues: [] };
  }
  if (typeof raw !== "string") {
    return { windows: [], valid: false, issues: ["corrupt-type"] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { windows: [], valid: false, issues: ["corrupt-json"] };
  }
  if (!Array.isArray(parsed)) {
    return { windows: [], valid: false, issues: ["not-an-array"] };
  }

  const issues: string[] = [];
  const addIssue = (code: string): void => {
    if (!issues.includes(code)) issues.push(code);
  };

  // --- validate each entry (malformed ones are dropped, never reopened) --------
  const clean: Array<{ fromMs: number; toMs: number | null }> = [];
  let malformedEntry = false;
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      malformedEntry = true;
      addIssue("non-object-window");
      continue;
    }
    const o = entry as Record<string, unknown>;
    const fromMs = typeof o.from === "string" ? Date.parse(o.from) : Number.NaN;
    if (!Number.isFinite(fromMs)) {
      malformedEntry = true;
      addIssue("invalid-from");
      continue;
    }
    let toMs: number | null;
    if (o.to === null) {
      toMs = null; // the ONLY open-window representation
    } else if (typeof o.to === "string" && Number.isFinite(Date.parse(o.to))) {
      toMs = Date.parse(o.to);
      if (toMs <= fromMs) {
        malformedEntry = true;
        addIssue("reversed-interval");
        continue;
      }
    } else {
      // A non-null, non-parseable `to` is MALFORMED — dropped, never opened.
      malformedEntry = true;
      addIssue("malformed-to");
      continue;
    }
    clean.push({ fromMs, toMs });
  }

  // --- structural invariant: at most one open window ---------------------------
  const openCount = clean.filter((w) => w.toMs === null).length;
  if (openCount > 1) {
    // Two "still open" windows both extend to +∞ → the stored state is untrustworthy.
    // Reject the whole set (fail closed) rather than pay from an ambiguous overlap.
    addIssue("multiple-open-windows");
    return { windows: [], valid: false, issues };
  }

  // --- normalize overlaps by merging into the union (a tested, safe policy) ----
  clean.sort((a, b) => a.fromMs - b.fromMs);
  const merged: Array<{ fromMs: number; toMs: number | null }> = [];
  for (const w of clean) {
    const last = merged[merged.length - 1];
    const lastEnd = last ? (last.toMs === null ? Number.POSITIVE_INFINITY : last.toMs) : null;
    if (last && lastEnd !== null && w.fromMs <= lastEnd) {
      addIssue("overlapping-windows");
      if (last.toMs !== null) {
        if (w.toMs === null) {
          last.toMs = null; // an open window swallows the tail
        } else if (w.toMs > last.toMs) {
          last.toMs = w.toMs;
        }
      }
      continue;
    }
    merged.push({ fromMs: w.fromMs, toMs: w.toMs });
  }

  const windows: ReferralPayoutWindow[] = merged.map((w) => ({
    from: new Date(w.fromMs).toISOString(),
    to: w.toMs === null ? null : new Date(w.toMs).toISOString(),
  }));
  // Overlap normalization alone is a SAFE, defined policy → still valid. Only a
  // malformed entry (dropped interval) marks the set invalid for the OWNER warning.
  return { windows, valid: !malformedEntry, issues };
}

/**
 * Defensively parses the stored windows JSON to the SAFE, fail-closed window list
 * (the strict parse's `.windows`). A malformed / corrupt store yields the
 * trustworthy subset (often []), never an open window synthesised from garbage.
 * Callers that must surface an OWNER integrity warning use the strict parser.
 */
export function parseReferralPayoutWindows(raw: string | null | undefined): ReferralPayoutWindow[] {
  return parseReferralPayoutWindowsStrict(raw).windows;
}

/**
 * True when an order completed inside an ACTIVE payout window (i.e. payouts were
 * switched on at the moment the order completed). Deterministic — no clock/I/O.
 * An empty windows list (payouts never enabled) is fail-closed: nothing eligible.
 * A malformed closing bound is FAIL-CLOSED too — it is skipped, never treated as
 * an open window (defence-in-depth atop the strict parser).
 */
export function isWithinReferralPayoutWindows(
  completedAtEpoch: number | null,
  windows: ReferralPayoutWindow[],
): boolean {
  if (completedAtEpoch === null || !Number.isFinite(completedAtEpoch)) {
    return false;
  }
  for (const w of windows) {
    const fromMs = Date.parse(w.from);
    if (!Number.isFinite(fromMs) || completedAtEpoch < fromMs) {
      continue;
    }
    if (w.to === null) {
      return true; // open window — anything from `from` onward is inside it
    }
    const toMs = Date.parse(w.to);
    if (!Number.isFinite(toMs)) {
      continue; // malformed closed bound → NEVER match (fail closed, not "open")
    }
    if (completedAtEpoch <= toMs) {
      return true;
    }
  }
  return false;
}

/** Opens a new payout window at `nowIso` unless one is already open (idempotent). */
export function openReferralPayoutWindow(
  windows: ReferralPayoutWindow[],
  nowIso: string,
): ReferralPayoutWindow[] {
  if (windows.some((w) => w.to === null)) {
    return windows;
  }
  return [...windows, { from: nowIso, to: null }];
}

/** Closes the currently-open payout window at `nowIso` (no-op if none open). */
export function closeReferralPayoutWindow(
  windows: ReferralPayoutWindow[],
  nowIso: string,
): ReferralPayoutWindow[] {
  let closed = false;
  return windows.map((w) => {
    if (!closed && w.to === null) {
      closed = true;
      return { from: w.from, to: nowIso };
    }
    return w;
  });
}

// --- no-overdraft clawback (pure) --------------------------------------------

export interface ReferralClawbackPlan {
  /** How much can be debited NOW without overdrawing (== outstanding when allowed negative). */
  recoverNow: number;
  /** Amount still owed AFTER this step. */
  remainingOutstanding: number;
  /** True when this step clears the whole debt (→ REVERSED). */
  fullyRecovered: boolean;
}

/**
 * Decides how much of an outstanding referral debt to claw back in one step
 * WITHOUT driving the wallet below zero (unless the user is explicitly allowed a
 * negative balance). Never returns a negative amount and never exceeds the
 * outstanding debt, so the same debt can never be over-collected. Pure and
 * deterministic — the row-locked recovery transaction supplies the live balance.
 */
export function planReferralClawback(input: {
  outstandingToman: number;
  currentBalanceToman: number;
  allowNegativeBalance: boolean;
}): ReferralClawbackPlan {
  const outstanding = Math.max(0, Math.trunc(input.outstandingToman));
  let recoverNow: number;
  if (input.allowNegativeBalance) {
    recoverNow = outstanding;
  } else {
    const affordable = Math.max(0, Math.trunc(input.currentBalanceToman));
    recoverNow = Math.min(outstanding, affordable);
  }
  const remainingOutstanding = outstanding - recoverNow;
  return { recoverNow, remainingOutstanding, fullyRecovered: remainingOutstanding === 0 };
}

// --- durable reconciliation: queue / job / scheduler identifiers -------------

/** Worker-owned control queue: scan credits / scan reversals / recover / cleanup. */
export const REFERRAL_QUEUE_NAME = "referral-commissions";
/** EXECUTE queue consumed by the BOT process (co-located with the wallet ledger). */
export const REFERRAL_EXECUTE_QUEUE_NAME = "referral-commissions-execute";

export const REFERRAL_JOB_NAMES = {
  /** Control (worker): find COMPLETED post-horizon orders missing a commission. */
  SCAN_REFERRAL_CREDITS: "SCAN_REFERRAL_CREDITS",
  /** Control (worker): find PAID commissions whose source order was refunded. */
  SCAN_REFERRAL_REVERSALS: "SCAN_REFERRAL_REVERSALS",
  /** Control (worker): retry REVERSAL_PENDING debts as funds become available. */
  RECOVER_REFERRAL_DEBTS: "RECOVER_REFERRAL_DEBTS",
  /** Control (worker): terminal-row retention cleanup. */
  CLEANUP_REFERRAL_COMMISSIONS: "CLEANUP_REFERRAL_COMMISSIONS",
  /** Execute (bot): credit ONE order's commission (idempotent, orderId only). */
  CREDIT_REFERRAL_COMMISSION: "CREDIT_REFERRAL_COMMISSION",
  /** Execute (bot): reverse ONE refunded order's commission (orderId only). */
  REVERSE_REFERRAL_COMMISSION: "REVERSE_REFERRAL_COMMISSION",
  /** Execute (bot): recover more of ONE REVERSAL_PENDING debt (commissionId only). */
  RECOVER_REFERRAL_COMMISSION: "RECOVER_REFERRAL_COMMISSION",
} as const;
export type ReferralJobName = (typeof REFERRAL_JOB_NAMES)[keyof typeof REFERRAL_JOB_NAMES];

export const REFERRAL_SCHEDULER_IDS = {
  credits: "ref-sched-credits",
  reversals: "ref-sched-reversals",
  recovery: "ref-sched-recovery",
  cleanup: "ref-sched-cleanup",
} as const;

/** Redis lock: only one referral reconciliation scan runs at a time. */
export const REFERRAL_SCAN_LOCK_KEY = "zedbot:referral-scan-lock";
/** Worker-published referral reconciliation status snapshot (heartbeat/dry-run). */
export const REFERRAL_WORKER_STATUS_KEY = "zedbot:referral-worker-status";

/**
 * Liveness key the BOT's referral EXECUTE consumer refreshes on an interval. Its
 * presence (TTL-bounded) proves the consumer that performs the actual wallet
 * mutations is alive — a precondition the activation integrity gate checks before
 * the OWNER can enable payouts (no durable crediting without a live consumer).
 */
export const REFERRAL_EXECUTE_HEARTBEAT_KEY = "zedbot:referral-execute-heartbeat";
/** How often the execute consumer refreshes its heartbeat. */
export const REFERRAL_EXECUTE_HEARTBEAT_INTERVAL_MS = 15_000;
/** Heartbeat TTL — a few missed refreshes and the key expires (consumer is down). */
export const REFERRAL_EXECUTE_HEARTBEAT_TTL_SECONDS = 45;

/** Idempotent per-order credit execute job id (retry/duplicate collapse onto one). */
export function referralCreditJobId(orderId: string): string {
  return `ref-credit-${orderId}`;
}
/** Idempotent per-order reversal execute job id. */
export function referralReverseJobId(orderId: string): string {
  return `ref-reverse-${orderId}`;
}
/** Idempotent per-commission recovery execute job id. */
export function referralRecoverJobId(commissionId: string): string {
  return `ref-recover-${commissionId}`;
}

/** How often the worker reconciliation scans run (safe on any cadence). */
export const REFERRAL_RECONCILE_INTERVAL_MS = 5 * 60_000;
/** Terminal-row retention cleanup cadence. */
export const REFERRAL_CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;
/** Bounded batch: max orders/commissions examined per scan run. */
export const REFERRAL_SCAN_BATCH = 500;
/**
 * Reversal/credit look-back: a worker down for up to a week still catches every
 * missed credit and every refund on restart. Comfortably exceeds the scan cadence.
 */
export const REFERRAL_SCAN_LOOKBACK_MS = 7 * 24 * 3_600_000;
/** How long terminal (REVERSED/CANCELLED) rows are retained before cleanup (days). */
export const REFERRAL_COMMISSION_RETENTION_DAYS = 730;

// --- worker status snapshot --------------------------------------------------

/**
 * The referral reconciliation heartbeat/status snapshot the worker publishes to
 * Redis each scan. Counts + timestamps only — NEVER a user id, telegram id,
 * referral code, order id or wallet balance.
 */
export interface ReferralWorkerStatus {
  enabled: boolean;
  /** ISO instant of the last credit/reversal/recovery scan (null before the first). */
  lastScanAt: string | null;
  /** Orders the last credit scan enqueued for crediting. */
  creditScanEnqueued: number;
  /** Commissions the last reversal scan enqueued for clawback. */
  reversalScanEnqueued: number;
  /** REVERSAL_PENDING debts the last recovery scan retried. */
  recoveryScanEnqueued: number;
  /** Live count of PAID commissions (retained payouts). */
  paidCount: number;
  /** Live count of fully-reversed commissions. */
  reversedCount: number;
  /** Live count of REVERSAL_PENDING commissions (debt still owed). */
  reversalPendingCount: number;
  /** Live sum of outstanding (uncollected) debt across REVERSAL_PENDING rows. */
  reversalPendingOutstandingToman: number;
  /** Execute jobs that exhausted their retries since the last reset (observability). */
  executeFailures: number;
  checkedAt: string;
}
