import {
  FreeTrialClaimStatus,
  FreeTrialEntitlementStatus,
  Prisma,
  prisma,
  UserStatus,
  type FreeTrialEntitlement,
  type User,
} from "@zedbot/database";

import { logger } from "../core/logger.js";
import {
  freeTrialCooldownDays,
  freeTrialRequiresChannelMembership,
  freeTrialRequiresNoPreviousPurchase,
  isFreeTrialEnabled,
  isFreeTrialOncePerUser,
} from "./free-trial-settings.service.js";
import { getBooleanSetting, getSetting } from "./settings.service.js";

// =============================================================================
// Trial-entitlement phase: the ONE shared eligibility/allowance policy for
// free trials. A FreeTrialClaim is one actual request/provisioning attempt;
// a FreeTrialEntitlement is PERMISSION for one or more claims. The default
// policy allowance is virtual - derived from the global setting and the
// user's unlinked claims - and is never materialized as rows. Every surface
// (user trial flow, forged-callback re-validation, admin user view, grant/
// reset/campaign previews) consumes computeTrialEligibility; the atomic
// reservation runs INSIDE the claim-insert transaction under a per-user
// advisory lock, and the database CHECK constraints plus conditional
// UPDATE ... WHERE consumed < allowance are the authoritative overdraw
// guards. Release is exactly-once via the claim's allowanceReleasedAt CAS
// and never happens while a remote outcome is uncertain.
// =============================================================================

/** Global default allowance setting ("" = legacy once-per-user semantics). */
export const FREE_TRIAL_DEFAULT_ALLOWANCE_KEY = "free_trial_default_allowance";

/** Hard cap for one admin grant operation. */
export const TRIAL_GRANT_MAX_PER_OPERATION = 100;

/** Claim statuses that consume an allowance unit (EXPIRED = used trial). */
export const CONSUMING_CLAIM_STATUSES: FreeTrialClaimStatus[] = [
  FreeTrialClaimStatus.CLAIMED,
  FreeTrialClaimStatus.PROVISIONING,
  FreeTrialClaimStatus.ACTIVE,
  FreeTrialClaimStatus.MANUAL_REVIEW,
  FreeTrialClaimStatus.EXPIRED,
];

/** Claim statuses that occupy the single per-user live slot. */
export const LIVE_ELIGIBILITY_STATUSES: FreeTrialClaimStatus[] = [
  FreeTrialClaimStatus.CLAIMED,
  FreeTrialClaimStatus.PROVISIONING,
  FreeTrialClaimStatus.MANUAL_REVIEW,
];

// --- Persian denial texts (task-mandated, verbatim) -------------------------------------------

// Shared with (and re-exported by) free-trial.service.ts - defined here so
// the dependency stays one-directional (engine -> entitlement policy).
export const TRIAL_ALREADY_USED_TEXT = "شما قبلاً از اکانت تست رایگان استفاده کرده‌اید.";
export const TRIAL_IN_PROGRESS_TEXT =
  "یک درخواست اکانت تست برای شما در حال پردازش یا بررسی است.";

export const TRIAL_NO_ALLOWANCE_TEXT = "سهمیه اکانت تست شما به پایان رسیده است.";
export const TRIAL_ENTITLEMENT_EXPIRED_TEXT =
  "اعتبار سهمیه اکانت تست شما به پایان رسیده است.";
export const TRIAL_REVOKED_TEXT =
  "در حال حاضر امکان دریافت اکانت تست برای حساب شما فعال نیست.";
export const TRIAL_HAS_ALLOWANCE_BUT_DISABLED_TEXT =
  "شما سهمیه تست دارید، اما اکانت تست در حال حاضر به‌صورت سراسری غیرفعال است.";
export const TRIAL_PANEL_NOT_ALLOWED_TEXT =
  "سهمیه تست شما برای این لوکیشن قابل استفاده نیست.";

export function trialCooldownText(date: Date): string {
  return `امکان دریافت تست بعدی از تاریخ ${formatPersianDate(date)} فعال می‌شود.`;
}

export function trialDeniedUntilText(date: Date): string {
  return `دسترسی شما به اکانت تست تا تاریخ ${formatPersianDate(date)} غیرفعال است.`;
}

/** Safe Persian date for user-facing barrier messages. */
export function formatPersianDate(date: Date): string {
  try {
    return new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "short" }).format(
      date,
    );
  } catch {
    return date.toISOString().slice(0, 16).replace("T", " ");
  }
}

// --- eligibility result ------------------------------------------------------------------------

export type TrialDenialReason =
  | "GLOBAL_DISABLED"
  | "USER_BLOCKED"
  | "ACTIVE_CLAIM"
  | "NO_ALLOWANCE"
  | "COOLDOWN"
  | "PREVIOUS_PURCHASE"
  | "MEMBERSHIP_REQUIRED"
  | "PANEL_NOT_ALLOWED"
  | "ENTITLEMENT_EXPIRED"
  | "ADMIN_DENIED";

export interface TrialEligibilityResult {
  eligible: boolean;
  /** Effective remaining claims (Infinity-safe: capped for display). */
  remainingClaims: number;
  /** True when the user has unlimited legacy allowance (once-per-user off, no explicit default). */
  unlimitedDefault: boolean;
  activeClaimExists: boolean;
  cooldownEndsAt?: Date;
  entitlementIds: string[];
  denialReason?: TrialDenialReason;
  /** Safe Persian denial message matching denialReason. */
  denialText?: string;
}

// --- allowance summary -------------------------------------------------------------------------

export interface TrialAllowanceSummary {
  /** null = unlimited (legacy once-per-user off without explicit default). */
  defaultAllowance: number | null;
  defaultConsumed: number;
  /** null = unlimited. */
  defaultRemaining: number | null;
  /** Usable (ACTIVE, in-window, remaining > 0) entitlements, consumption-ordered. */
  usableEntitlements: FreeTrialEntitlement[];
  entitlementRemaining: number;
  /** null = unlimited. */
  totalRemaining: number | null;
  /** True when an EXPIRED grant with unused units exists (for messaging). */
  hasExpiredUnusedGrant: boolean;
}

/**
 * The user's effective DEFAULT allowance. Explicit setting (or per-user
 * override) wins; otherwise the legacy semantics are preserved exactly:
 * once-per-user on -> 1, off -> unlimited (cooldown-gated repeats).
 */
export async function effectiveDefaultAllowance(user: User): Promise<number | null> {
  if (user.freeTrialDefaultAllowanceOverride !== null) {
    return Math.max(0, user.freeTrialDefaultAllowanceOverride);
  }
  const raw = (await getSetting(FREE_TRIAL_DEFAULT_ALLOWANCE_KEY, "")).trim();
  if (raw !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return (await isFreeTrialOncePerUser()) ? 1 : null;
}

function usableEntitlementWhere(
  userId: string,
  now: Date,
  panelId?: string,
): Prisma.FreeTrialEntitlementWhereInput {
  return {
    userId,
    status: FreeTrialEntitlementStatus.ACTIVE,
    OR: [{ startsAt: null }, { startsAt: { lte: now } }],
    AND: [
      { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      // Panel-scoped rows count only for their panel (or when no panel is
      // being targeted yet - the overview still lists them as remaining).
      panelId === undefined
        ? {}
        : { OR: [{ scope: "GLOBAL" }, { scope: "PANEL", panelId }] },
    ],
  };
}

/**
 * Deterministic consumption order (task-mandated):
 *   1. matching panel-specific grant, nearest expiration first
 *   2. global admin grant (grant/reset/compensation/migration), nearest expiration
 *   3. campaign entitlement, nearest expiration
 *   4. default policy allowance (virtual - not a row)
 * Ties break by createdAt then id so retries pick the same row.
 */
export function orderEntitlementsForConsumption(
  rows: FreeTrialEntitlement[],
  panelId?: string,
): FreeTrialEntitlement[] {
  const bucket = (row: FreeTrialEntitlement): number => {
    if (row.scope === "PANEL" && panelId !== undefined && row.panelId === panelId) {
      return 0;
    }
    if (row.source === "CAMPAIGN_RESET") {
      return 2;
    }
    return 1;
  };
  return [...rows].sort((a, b) => {
    const byBucket = bucket(a) - bucket(b);
    if (byBucket !== 0) {
      return byBucket;
    }
    const aExp = a.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const bExp = b.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (aExp !== bExp) {
      return aExp - bExp;
    }
    const byCreated = a.createdAt.getTime() - b.createdAt.getTime();
    return byCreated !== 0 ? byCreated : a.id.localeCompare(b.id);
  });
}

type Db = Prisma.TransactionClient | typeof prisma;

async function countDefaultConsumed(
  db: Db,
  userId: string,
  excludeClaimId?: string,
): Promise<number> {
  return db.freeTrialClaim.count({
    where: {
      userId,
      entitlementId: null,
      status: { in: CONSUMING_CLAIM_STATUSES },
      // Insert-first claiming: the claim being funded RIGHT NOW must not
      // count against the allowance it is trying to reserve.
      ...(excludeClaimId === undefined ? {} : { id: { not: excludeClaimId } }),
    },
  });
}

/** Allowance breakdown for one user (optionally scoped to one panel). */
export async function computeTrialAllowance(
  user: User,
  options: { panelId?: string; db?: Db } = {},
): Promise<TrialAllowanceSummary> {
  const db = options.db ?? prisma;
  const now = new Date();
  const [defaultAllowance, defaultConsumed, rows, expiredUnused] = await Promise.all([
    effectiveDefaultAllowance(user),
    countDefaultConsumed(db, user.id),
    db.freeTrialEntitlement.findMany({
      where: usableEntitlementWhere(user.id, now, options.panelId),
    }),
    db.freeTrialEntitlement.findFirst({
      where: {
        userId: user.id,
        OR: [
          { status: FreeTrialEntitlementStatus.EXPIRED },
          { status: FreeTrialEntitlementStatus.ACTIVE, expiresAt: { lte: now } },
        ],
      },
      select: { id: true, allowance: true, consumed: true },
    }),
  ]);
  const usable = orderEntitlementsForConsumption(
    rows.filter((row) => row.consumed < row.allowance),
    options.panelId,
  );
  const entitlementRemaining = usable.reduce(
    (sum, row) => sum + (row.allowance - row.consumed),
    0,
  );
  const defaultRemaining =
    defaultAllowance === null ? null : Math.max(0, defaultAllowance - defaultConsumed);
  return {
    defaultAllowance,
    defaultConsumed,
    defaultRemaining,
    usableEntitlements: usable,
    entitlementRemaining,
    totalRemaining:
      defaultRemaining === null ? null : defaultRemaining + entitlementRemaining,
    hasExpiredUnusedGrant:
      expiredUnused !== null && expiredUnused.consumed < expiredUnused.allowance,
  };
}

// --- the central eligibility calculator ----------------------------------------------------------

function denial(
  reason: TrialDenialReason,
  text: string,
  base: Omit<TrialEligibilityResult, "eligible" | "denialReason" | "denialText">,
): TrialEligibilityResult {
  return { eligible: false, denialReason: reason, denialText: text, ...base };
}

/**
 * ONE calculator for every trial surface. Order of checks preserves the
 * historical engine's semantics (user state -> live claim -> active trial ->
 * global switch -> admin barriers -> cooldown -> purchase/membership policy
 * -> allowance), with the admin revoke/denial barriers and the allowance
 * model layered in. Never trusted alone for the claim - the claim-insert
 * transaction re-runs the barrier checks and makes the reservation.
 */
export async function computeTrialEligibility(
  user: User,
  options: { panelId?: string } = {},
): Promise<TrialEligibilityResult> {
  const now = new Date();
  const allowance = await computeTrialAllowance(user, { panelId: options.panelId });
  const remainingClaims =
    allowance.totalRemaining === null
      ? Number.MAX_SAFE_INTEGER
      : allowance.totalRemaining;
  const entitlementIds = allowance.usableEntitlements.map((row) => row.id);

  const live = await prisma.freeTrialClaim.findFirst({
    where: { userId: user.id, status: { in: LIVE_ELIGIBILITY_STATUSES } },
    select: { id: true },
  });
  const activeTrial = await prisma.freeTrialClaim.findFirst({
    where: { userId: user.id, status: FreeTrialClaimStatus.ACTIVE },
    select: { id: true },
  });

  const base = {
    remainingClaims,
    unlimitedDefault: allowance.totalRemaining === null,
    activeClaimExists: live !== null || activeTrial !== null,
    entitlementIds,
  };

  if (user.status !== UserStatus.ACTIVE) {
    return denial("USER_BLOCKED", TRIAL_REVOKED_TEXT, base);
  }
  // Admin barriers come before everything except the user state: a revoked
  // or denied user is refused even while a stale live claim exists.
  if (user.freeTrialRevokedAt !== null) {
    return denial("ADMIN_DENIED", TRIAL_REVOKED_TEXT, base);
  }
  if (user.freeTrialDeniedUntil !== null && user.freeTrialDeniedUntil > now) {
    return {
      ...denial("ADMIN_DENIED", trialDeniedUntilText(user.freeTrialDeniedUntil), base),
      cooldownEndsAt: user.freeTrialDeniedUntil,
    };
  }
  if (live !== null) {
    return denial("ACTIVE_CLAIM", TRIAL_IN_PROGRESS_TEXT, base);
  }
  if (activeTrial !== null) {
    return denial("ACTIVE_CLAIM", TRIAL_ALREADY_USED_TEXT, base);
  }
  if (!(await isFreeTrialEnabled())) {
    return denial(
      "GLOBAL_DISABLED",
      remainingClaims > 0
        ? TRIAL_HAS_ALLOWANCE_BUT_DISABLED_TEXT
        : "اکانت تست رایگان در حال حاضر غیرفعال است.",
      base,
    );
  }
  // Custom per-user cooldown barrier (admin-set), then the setting-computed
  // cooldown off the most recent consuming claim - unless waived.
  if (user.freeTrialCooldownUntil !== null && user.freeTrialCooldownUntil > now) {
    return {
      ...denial("COOLDOWN", trialCooldownText(user.freeTrialCooldownUntil), base),
      cooldownEndsAt: user.freeTrialCooldownUntil,
    };
  }
  const cooldownDays = await freeTrialCooldownDays();
  if (cooldownDays !== null) {
    const lastConsuming = await prisma.freeTrialClaim.findFirst({
      where: { userId: user.id, status: { in: CONSUMING_CLAIM_STATUSES } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (
      lastConsuming !== null &&
      (user.freeTrialCooldownClearedAt === null ||
        user.freeTrialCooldownClearedAt < lastConsuming.createdAt)
    ) {
      const endsAt = new Date(lastConsuming.createdAt.getTime() + cooldownDays * 86_400_000);
      if (endsAt > now) {
        return { ...denial("COOLDOWN", trialCooldownText(endsAt), base), cooldownEndsAt: endsAt };
      }
    }
  }
  if (await freeTrialRequiresNoPreviousPurchase()) {
    if (user.paidOrdersCount > 0) {
      return denial(
        "PREVIOUS_PURCHASE",
        "اکانت تست فقط برای کاربرانی فعال است که قبلاً خرید موفق نداشته‌اند.",
        base,
      );
    }
  }
  if (await freeTrialRequiresChannelMembership()) {
    const forceJoinOn = await getBooleanSetting("force_join_enabled", false);
    if (forceJoinOn && !user.forceJoinBypass) {
      return denial(
        "MEMBERSHIP_REQUIRED",
        "برای دریافت اکانت تست، ابتدا در کانال‌های مشخص‌شده عضو شوید.",
        base,
      );
    }
  }
  if (allowance.totalRemaining !== null && allowance.totalRemaining <= 0) {
    // Distinguish "your grant expired" from plain exhaustion when a
    // panel-agnostic remaining exists but not for THIS panel.
    if (options.panelId !== undefined) {
      const anywhere = await computeTrialAllowance(user, {});
      if (anywhere.totalRemaining === null || anywhere.totalRemaining > 0) {
        return denial("PANEL_NOT_ALLOWED", TRIAL_PANEL_NOT_ALLOWED_TEXT, base);
      }
    }
    if (allowance.hasExpiredUnusedGrant) {
      return denial("ENTITLEMENT_EXPIRED", TRIAL_ENTITLEMENT_EXPIRED_TEXT, base);
    }
    return denial("NO_ALLOWANCE", TRIAL_NO_ALLOWANCE_TEXT, base);
  }
  return {
    eligible: true,
    remainingClaims,
    unlimitedDefault: allowance.totalRemaining === null,
    activeClaimExists: false,
    entitlementIds,
  };
}

// --- atomic reservation -------------------------------------------------------------------------

export type TrialReservation =
  | { ok: true; entitlementId: string | null }
  | { ok: false; reason: TrialDenialReason; text: string };

/**
 * Reserves ONE allowance unit inside the caller's transaction. The caller
 * MUST hold the per-user advisory lock (reserveTrialAllowance takes it) and
 * MUST create the FreeTrialClaim with the returned entitlementId in the
 * SAME transaction - the claim row is the reservation receipt.
 */
export async function reserveTrialAllowance(
  tx: Prisma.TransactionClient,
  user: User,
  panelId: string,
  options: { excludeClaimId?: string } = {},
): Promise<TrialReservation> {
  const now = new Date();
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`zedbot-free-trial-user:${user.id}`}))`;

  // Entitlements first, in the deterministic order. The conditional
  // increment (consumed < allowance re-checked BY the row update) is the
  // authoritative reservation - a concurrent transaction cannot overdraw.
  const rows = await tx.freeTrialEntitlement.findMany({
    where: usableEntitlementWhere(user.id, now, panelId),
  });
  for (const candidate of orderEntitlementsForConsumption(
    rows.filter((row) => row.consumed < row.allowance),
    panelId,
  )) {
    const updated = await tx.$executeRaw`
      UPDATE "FreeTrialEntitlement"
      SET "consumed" = "consumed" + 1,
          "status" = CASE WHEN "consumed" + 1 >= "allowance" THEN 'CONSUMED'::"FreeTrialEntitlementStatus" ELSE "status" END,
          "updatedAt" = NOW()
      WHERE "id" = ${candidate.id}
        AND "status" = 'ACTIVE'
        AND "consumed" < "allowance"
        AND ("startsAt" IS NULL OR "startsAt" <= NOW())
        AND ("expiresAt" IS NULL OR "expiresAt" > NOW())`;
    if (updated === 1) {
      return { ok: true, entitlementId: candidate.id };
    }
  }

  // Default policy allowance - virtual, counted from unlinked claims. The
  // per-user advisory lock serializes this count against concurrent
  // reservations; the live-claim partial unique index is the second guard.
  const defaultAllowance = await effectiveDefaultAllowance(user);
  if (defaultAllowance === null) {
    return { ok: true, entitlementId: null };
  }
  const defaultConsumed = await countDefaultConsumed(tx, user.id, options.excludeClaimId);
  if (defaultConsumed < defaultAllowance) {
    return { ok: true, entitlementId: null };
  }
  return { ok: false, reason: "NO_ALLOWANCE", text: TRIAL_NO_ALLOWANCE_TEXT };
}

// --- exactly-once release -----------------------------------------------------------------------

/**
 * Returns the claim's allowance unit exactly once. Only callers that have
 * POSITIVELY established non-creation (validation failure before the remote
 * call, panel rejection without an account, reconciliation NOT_APPLIED,
 * owner-forced not-created) may call this; UNKNOWN outcomes must never
 * reach it. Idempotent: the CAS on allowanceReleasedAt IS NULL guarantees
 * at most one decrement per claim, even under concurrent sweeps.
 */
export async function releaseClaimAllowance(claimId: string, reason: string): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const stamped = await tx.freeTrialClaim.updateMany({
      where: {
        id: claimId,
        allowanceReleasedAt: null,
        status: { in: [FreeTrialClaimStatus.FAILED, FreeTrialClaimStatus.CANCELLED] },
      },
      data: { allowanceReleasedAt: new Date() },
    });
    if (stamped.count !== 1) {
      return false;
    }
    const claim = await tx.freeTrialClaim.findUnique({
      where: { id: claimId },
      select: { entitlementId: true },
    });
    if (claim?.entitlementId != null) {
      // Give the unit back and reopen a fully-consumed row - but never
      // resurrect a REVOKED or EXPIRED row (their remaining stays unusable).
      const released = await tx.$executeRaw`
        UPDATE "FreeTrialEntitlement"
        SET "consumed" = "consumed" - 1,
            "status" = CASE WHEN "status" = 'CONSUMED' THEN 'ACTIVE'::"FreeTrialEntitlementStatus" ELSE "status" END,
            "updatedAt" = NOW()
        WHERE "id" = ${claim.entitlementId}
          AND "consumed" > 0`;
      if (released !== 1) {
        logger.warn("trial allowance release found no consumable unit", {
          claimId,
          entitlementId: claim.entitlementId,
          reason,
        });
      }
    }
    logger.info("trial allowance released", { claimId, reason });
    return true;
  });
}

// --- entitlement expiry sweep --------------------------------------------------------------------

/**
 * Deterministic expiry: ACTIVE rows past their expiresAt become EXPIRED
 * (never deleted; unused units become unusable, history stays). Idempotent
 * - called from the trial sweep loop.
 */
export async function expireTrialEntitlements(now: Date = new Date()): Promise<number> {
  const expired = await prisma.freeTrialEntitlement.updateMany({
    where: { status: FreeTrialEntitlementStatus.ACTIVE, expiresAt: { lte: now } },
    data: { status: FreeTrialEntitlementStatus.EXPIRED },
  });
  if (expired.count > 0) {
    logger.info("trial entitlements expired", { count: expired.count });
  }
  return expired.count;
}
