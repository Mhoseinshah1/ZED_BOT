// =============================================================================
// Representative Program (feat/representative-program) — shared contract.
// Language-neutral, dependency-free typed vocabulary for the reseller-price
// program: application + representative statuses, price modes, validation
// bounds + normalizers, INTEGER-only price math, the rollout setting keys, and
// the safe logging buckets.
//
// Design rules (same as admin-service-operations.ts / referral.ts):
//   * Behaviour is driven by these machine CODES ONLY — never by comparing
//     Persian strings. Persian rendering lives in the bot view layer.
//   * This module imports NOTHING from @zedbot/database or the bot — pure data +
//     pure functions, so the api/worker/tests can consume it too.
//   * Money is exact INTEGER Toman arithmetic — never floating point.
//   * NO national id / bank card / password / token / panel credential is part
//     of the application contract.
// =============================================================================

import { createHash } from "node:crypto";

import { clampInt } from "./auto-renewal.js";

// --- rollout settings --------------------------------------------------------

/** Master switch — the whole program (menu entry, dashboard, applications,
 * checkout) is dormant until the OWNER enables it. Default FALSE. */
export const REPRESENTATIVE_PROGRAM_ENABLED_KEY = "representative_program_enabled";
/** Gates NEW applications only — never deletes/cancels existing ones. Default FALSE. */
export const REPRESENTATIVE_APPLICATIONS_ENABLED_KEY = "representative_applications_enabled";
/** Gates NEW reseller-priced checkout creation — never cancels settled payments
 * or paid orders, never revokes a provisioned Service. Default FALSE. */
export const REPRESENTATIVE_CHECKOUT_ENABLED_KEY = "representative_checkout_enabled";

// --- application status machine ----------------------------------------------

export const REPRESENTATIVE_APPLICATION_STATUSES = [
  "DRAFT",
  "PENDING_REVIEW",
  "APPROVED",
  "REJECTED",
  "WITHDRAWN",
] as const;
export type RepresentativeApplicationStatus =
  (typeof REPRESENTATIVE_APPLICATION_STATUSES)[number];

const APP_STATUS_SET: ReadonlySet<string> = new Set(REPRESENTATIVE_APPLICATION_STATUSES);
export function isRepresentativeApplicationStatus(
  value: unknown,
): value is RepresentativeApplicationStatus {
  return typeof value === "string" && APP_STATUS_SET.has(value);
}

/** An open application the user is still acting on (only one may exist). */
export const REPRESENTATIVE_APPLICATION_OPEN_STATUSES: readonly RepresentativeApplicationStatus[] = [
  "DRAFT",
  "PENDING_REVIEW",
];
export const REPRESENTATIVE_APPLICATION_TERMINAL_STATUSES: readonly RepresentativeApplicationStatus[] =
  ["APPROVED", "REJECTED", "WITHDRAWN"];

const APP_TRANSITIONS: Readonly<
  Record<RepresentativeApplicationStatus, readonly RepresentativeApplicationStatus[]>
> = {
  DRAFT: ["PENDING_REVIEW", "WITHDRAWN"],
  PENDING_REVIEW: ["APPROVED", "REJECTED", "WITHDRAWN"],
  APPROVED: [],
  REJECTED: [],
  WITHDRAWN: [],
};
export function canTransitionApplication(
  from: RepresentativeApplicationStatus,
  to: RepresentativeApplicationStatus,
): boolean {
  return APP_TRANSITIONS[from].includes(to);
}

// --- representative status machine -------------------------------------------

export const REPRESENTATIVE_STATUSES = ["ACTIVE", "SUSPENDED", "TERMINATED"] as const;
export type RepresentativeStatus = (typeof REPRESENTATIVE_STATUSES)[number];

const REP_STATUS_SET: ReadonlySet<string> = new Set(REPRESENTATIVE_STATUSES);
export function isRepresentativeStatus(value: unknown): value is RepresentativeStatus {
  return typeof value === "string" && REP_STATUS_SET.has(value);
}

// --- representative purchase link status -------------------------------------
// The RepresentativePurchase row is a NON-financial link/marker between a
// representative-priced checkout and the reused CheckoutSession/Payment/Order.
// It never holds money and never gates settlement: PENDING is stamped when the
// reseller checkout is created; COMPLETED when the paid Order is fulfilled;
// FAILED/CANCELLED when the checkout is abandoned/cancelled BEFORE settlement.
// A settled Payment/paid Order is authoritative regardless of this status, so a
// later suspension never flips a COMPLETED purchase back (§16, §25).
export const REPRESENTATIVE_PURCHASE_STATUSES = [
  "PENDING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;
export type RepresentativePurchaseStatus = (typeof REPRESENTATIVE_PURCHASE_STATUSES)[number];

const REP_PURCHASE_STATUS_SET: ReadonlySet<string> = new Set(REPRESENTATIVE_PURCHASE_STATUSES);
export function isRepresentativePurchaseStatus(
  value: unknown,
): value is RepresentativePurchaseStatus {
  return typeof value === "string" && REP_PURCHASE_STATUS_SET.has(value);
}

// --- price modes -------------------------------------------------------------

export const REPRESENTATIVE_PRICE_MODES = ["FIXED_TOMAN", "PERCENT_DISCOUNT"] as const;
export type RepresentativePriceMode = (typeof REPRESENTATIVE_PRICE_MODES)[number];

const PRICE_MODE_SET: ReadonlySet<string> = new Set(REPRESENTATIVE_PRICE_MODES);
export function isRepresentativePriceMode(value: unknown): value is RepresentativePriceMode {
  return typeof value === "string" && PRICE_MODE_SET.has(value);
}

/** The stable checkout pricing-mode marker written into the CheckoutSession
 * snapshot. Financial isolation (referral exclusion etc.) keys on this. */
export const REPRESENTATIVE_PRICING_MODE = "REPRESENTATIVE" as const;

// --- sales channels ----------------------------------------------------------

export const REPRESENTATIVE_SALES_CHANNELS = [
  "TELEGRAM",
  "INSTAGRAM",
  "WEBSITE",
  "IN_PERSON",
  "WORD_OF_MOUTH",
  "OTHER",
] as const;
export type RepresentativeSalesChannel = (typeof REPRESENTATIVE_SALES_CHANNELS)[number];

const SALES_CHANNEL_SET: ReadonlySet<string> = new Set(REPRESENTATIVE_SALES_CHANNELS);
export function isRepresentativeSalesChannel(
  value: unknown,
): value is RepresentativeSalesChannel {
  return typeof value === "string" && SALES_CHANNEL_SET.has(value);
}

// --- application field bounds + validators -----------------------------------

export const REP_FULL_NAME_MIN = 2;
export const REP_FULL_NAME_MAX = 100;
export const REP_LOCATION_MIN = 2;
export const REP_LOCATION_MAX = 60;
export const REP_EXPERIENCE_MAX = 2000;
export const REP_EXPLANATION_MIN = 20;
export const REP_EXPLANATION_MAX = 3000;
export const REP_EXPECTED_CUSTOMERS_MIN = 0;
export const REP_EXPECTED_CUSTOMERS_MAX = 100000;
/** Mandatory internal admin reason (approve/suspend/terminate) + user-facing
 * rejection/suspension/termination reason. */
export const REP_REASON_MIN = 3;
export const REP_REASON_MAX = 500;

function inRange(value: string, min: number, max: number): boolean {
  const n = value.trim().length;
  return n >= min && n <= max;
}

export function isValidRepFullName(value: string): boolean {
  return inRange(value, REP_FULL_NAME_MIN, REP_FULL_NAME_MAX);
}
export function isValidRepLocation(value: string): boolean {
  return inRange(value, REP_LOCATION_MIN, REP_LOCATION_MAX);
}
export function isValidRepExperience(value: string): boolean {
  // Optional field: empty is allowed, otherwise bounded.
  return value.trim().length <= REP_EXPERIENCE_MAX;
}
export function isValidRepExplanation(value: string): boolean {
  return inRange(value, REP_EXPLANATION_MIN, REP_EXPLANATION_MAX);
}
export function isValidRepReason(value: string): boolean {
  return inRange(value, REP_REASON_MIN, REP_REASON_MAX);
}

/** Parse a bounded non-negative integer count from raw text. */
export function parseExpectedMonthlyCustomers(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{1,6}$/.test(trimmed)) {
    return null;
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(n) || n < REP_EXPECTED_CUSTOMERS_MIN || n > REP_EXPECTED_CUSTOMERS_MAX) {
    return null;
  }
  return n;
}

/**
 * Normalizes an Iranian mobile number to the canonical `09XXXXXXXXX` (11 digits)
 * form, accepting `+98`, `0098`, `98` and `9XXXXXXXXX` variants (and Persian/
 * Arabic-Indic digits). Returns null when it is not a valid Iranian mobile.
 */
export function normalizeIranMobile(raw: string): string | null {
  const latin = raw
    .trim()
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
  let digits = latin.replace(/[^\d]/g, "");
  if (digits.startsWith("0098")) {
    digits = digits.slice(4);
  } else if (digits.startsWith("98") && digits.length === 12) {
    digits = digits.slice(2);
  } else if (digits.startsWith("0")) {
    digits = digits.slice(1);
  }
  // Now expect a 10-digit subscriber number starting with 9.
  if (!/^9\d{9}$/.test(digits)) {
    return null;
  }
  return `0${digits}`;
}

// --- price math (INTEGER Toman only) -----------------------------------------

export const REP_PERCENT_MIN = 1;
export const REP_PERCENT_MAX = 95;
export const REP_FIXED_PRICE_MIN = 1;

/** Valid percent discount: integer in [1, 95]. */
export function isValidRepPercent(value: number): boolean {
  return Number.isInteger(value) && value >= REP_PERCENT_MIN && value <= REP_PERCENT_MAX;
}

/** Parse an integer percent in [1,95] from raw text. */
export function parseRepPercent(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{1,3}$/.test(trimmed)) {
    return null;
  }
  const n = Number.parseInt(trimmed, 10);
  return isValidRepPercent(n) ? n : null;
}

/** Parse an integer fixed Toman price (>= 1) from raw text. */
export function parseRepFixedToman(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d{1,12}$/.test(trimmed)) {
    return null;
  }
  const n = Number.parseInt(trimmed, 10);
  return Number.isInteger(n) && n >= REP_FIXED_PRICE_MIN ? n : null;
}

/**
 * PERCENT_DISCOUNT amount, EXACT integer Toman. Rounding is defined explicitly:
 * the discount is FLOORED (the customer never underpays vs. the stated
 * percentage). `discount = floor(retail * percent / 100)`. Inputs are integer
 * Toman well within the safe-integer range (retail * 95 « 2^53).
 */
export function representativePercentDiscountToman(retailToman: number, percent: number): number {
  if (!Number.isInteger(retailToman) || retailToman < 0) {
    return 0;
  }
  if (!isValidRepPercent(percent)) {
    return 0;
  }
  return Math.floor((retailToman * percent) / 100);
}

export interface RepresentativePriceInput {
  mode: RepresentativePriceMode;
  retailToman: number;
  /** FIXED_TOMAN mode. */
  fixedPriceToman?: number | null;
  /** PERCENT_DISCOUNT mode. */
  percentDiscount?: number | null;
}

export type RepresentativePriceResult =
  | { ok: true; representativePriceToman: number; savedAmountToman: number }
  | { ok: false; reason: "INVALID_MODE" | "INVALID_FIXED" | "INVALID_PERCENT" | "ABOVE_RETAIL" };

/**
 * Resolves the representative BASE price from a tier price record against the
 * CURRENT retail price, in exact integer Toman. FIXED_TOMAN must be ≥1 and ≤
 * current retail (a stale fixed price above retail fails closed). PERCENT is
 * floored. Never returns a negative price. A zero result is possible only when
 * a fixed price of ... (fixed ≥1 so never zero) — callers still block a final
 * zero unless the checkout layer has a safe free-checkout contract.
 */
export function resolveRepresentativeBasePrice(
  input: RepresentativePriceInput,
): RepresentativePriceResult {
  const { retailToman } = input;
  if (!Number.isInteger(retailToman) || retailToman < 0) {
    return { ok: false, reason: "INVALID_MODE" };
  }
  if (input.mode === "FIXED_TOMAN") {
    const fixed = input.fixedPriceToman ?? null;
    if (fixed === null || !Number.isInteger(fixed) || fixed < REP_FIXED_PRICE_MIN) {
      return { ok: false, reason: "INVALID_FIXED" };
    }
    if (fixed > retailToman) {
      // Stale fixed price above the current retail — never charge MORE than retail.
      return { ok: false, reason: "ABOVE_RETAIL" };
    }
    return { ok: true, representativePriceToman: fixed, savedAmountToman: retailToman - fixed };
  }
  if (input.mode === "PERCENT_DISCOUNT") {
    const percent = input.percentDiscount ?? null;
    if (percent === null || !isValidRepPercent(percent)) {
      return { ok: false, reason: "INVALID_PERCENT" };
    }
    const saved = representativePercentDiscountToman(retailToman, percent);
    const price = retailToman - saved;
    return { ok: true, representativePriceToman: price < 0 ? 0 : price, savedAmountToman: saved };
  }
  return { ok: false, reason: "INVALID_MODE" };
}

// --- stale-price fingerprints (§16) ------------------------------------------
// Frozen into the immutable checkout snapshot at reseller-checkout creation and
// re-computed from LIVE data at every settlement boundary. If either changes,
// the price the user agreed to is stale and the checkout fails closed BEFORE
// money moves. Raw ids never enter a Telegram callback — these are internal
// keys only (32-hex, like the auto-renewal cycle fingerprint).

export interface RepresentativeTierFingerprintInput {
  tierId: string;
  tierSlug: string;
  tierActive: boolean;
  checkoutEnabled: boolean;
}

/** Identity+state of the assigned tier at agreement time. Changes if the tier
 * is archived or the representative's per-account checkout permission flips. */
export function buildRepresentativeTierFingerprint(
  input: RepresentativeTierFingerprintInput,
): string {
  const material = `${input.tierId}|${input.tierSlug}|${input.tierActive ? 1 : 0}|${
    input.checkoutEnabled ? 1 : 0
  }`;
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

export interface RepresentativePriceFingerprintInput {
  tierId: string;
  productId: string;
  priceMode: RepresentativePriceMode;
  fixedPriceToman: number | null;
  percentValue: number | null;
  /** Live retail at agreement time (a PERCENT price tracks retail). */
  retailToman: number;
  /** The resolved reseller base price the user agreed to. */
  representativePriceToman: number;
}

/** The exact resolved-price inputs at agreement time. Changes if the tier price
 * row is edited (mode/fixed/percent) OR the product retail changes OR the
 * resolved base moves — so a stale preview can never settle at an old price. */
export function buildRepresentativePriceFingerprint(
  input: RepresentativePriceFingerprintInput,
): string {
  const material = [
    input.tierId,
    input.productId,
    input.priceMode,
    input.fixedPriceToman ?? "-",
    input.percentValue ?? "-",
    input.retailToman,
    input.representativePriceToman,
  ].join("|");
  return createHash("sha256").update(material).digest("hex").slice(0, 32);
}

// --- tier config bounds ------------------------------------------------------

export const REP_TIER_NAME_MIN = 2;
export const REP_TIER_NAME_MAX = 60;
export const REP_TIER_DESC_MAX = 500;
export const REP_TIER_SLUG_MAX = 40;

export function isValidRepTierName(value: string): boolean {
  return inRange(value, REP_TIER_NAME_MIN, REP_TIER_NAME_MAX);
}

/** Slugify a tier name into a stable, safe [a-z0-9-] slug (bounded). */
export function representativeTierSlug(name: string, fallback: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^\da-z]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, REP_TIER_SLUG_MAX);
  return slug === "" ? fallback.slice(0, REP_TIER_SLUG_MAX) : slug;
}

// --- safe logging buckets ----------------------------------------------------

/** Coarse, non-reversible bucket for a purchase value (never the exact amount). */
export function representativeValueBucket(toman: number | null): string {
  if (toman === null || !Number.isFinite(toman) || toman <= 0) {
    return "none";
  }
  if (toman <= 100_000) return "toman:0-100k";
  if (toman <= 500_000) return "toman:100k-500k";
  if (toman <= 1_000_000) return "toman:500k-1m";
  if (toman <= 5_000_000) return "toman:1m-5m";
  return "toman:5m+";
}

/** Typed, safe machine error codes the representative flows can record/display. */
export const REPRESENTATIVE_ERROR_CODES = [
  "PROGRAM_DISABLED",
  "APPLICATIONS_DISABLED",
  "CHECKOUT_DISABLED",
  "NOT_OWNER",
  "NOT_FOUND",
  "STALE",
  "VALIDATION",
  "ALREADY_APPLIED",
  "ALREADY_REPRESENTATIVE",
  "NOT_REPRESENTATIVE",
  "NOT_ACTIVE",
  "SUSPENDED",
  "TERMINATED",
  "INELIGIBLE_STATUS",
  "PRODUCT_INELIGIBLE",
  "TIER_INACTIVE",
  "PRICE_INACTIVE",
  "PRICE_INVALID",
  "PRICE_ABOVE_RETAIL",
  "DISCOUNT_NOT_STACKABLE",
  "ZERO_PRICE_BLOCKED",
  "STALE_PREVIEW",
  "LOCK_BUSY",
  "CONFLICTING_OPERATION",
] as const;
export type RepresentativeErrorCode = (typeof REPRESENTATIVE_ERROR_CODES)[number];

/** Numeric config read from a Setting string, clamped to safe bounds. */
export function resolveRepresentativeConfigInt(
  raw: string | null,
  min: number,
  max: number,
  fallback: number,
): number {
  const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
  return clampInt(n, min, max, fallback);
}

// --- short ids ---------------------------------------------------------------

/** The 8-char short id used in callback data (well under Telegram's 64 bytes). */
export function representativeShortId(id: string): string {
  return id.slice(0, 8);
}
