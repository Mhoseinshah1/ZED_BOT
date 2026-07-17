import {
  FreeTrialClaimStatus,
  PanelStatus,
  Prisma,
  prisma,
  ServiceStatus,
  UserStatus,
  type FreeTrialClaim,
  type Panel,
  type Service,
  type User,
} from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import {
  computeTrialEligibility,
  releaseClaimAllowance,
  reserveTrialAllowance,
  TRIAL_ALREADY_USED_TEXT as ENTITLEMENT_ALREADY_USED_TEXT,
  TRIAL_IN_PROGRESS_TEXT as ENTITLEMENT_IN_PROGRESS_TEXT,
  type TrialDenialReason,
  expireTrialEntitlements,
} from "./free-trial-entitlement.service.js";
import { isFreeTrialEnabled } from "./free-trial-settings.service.js";
import type { DeliverySendApi } from "./other-product-delivery.service.js";
import {
  buildAdapterForPanel,
  normalizeSubscriptionBase,
} from "./panel-adapter-factory.js";
import {
  assessPanelConfig,
  panelSupportsOperation,
  parsePanelInboundIds,
} from "./panel-readiness.service.js";
import {
  acquireServiceLock,
  isLockBackendAvailable,
  serviceProvisioningLockKey,
} from "./service-lock.service.js";
import {
  namingConfigFromPanel,
  resolveVpnRemoteIdentity,
  validateNamingConfig,
} from "./service-naming.service.js";

// =============================================================================
// Free-trial VPN accounts (free-trial phase). A trial is a SEPARATE
// entitlement type: FreeTrialClaim -> real remote panel account -> real
// local Service (source FREE_TRIAL, location TEST, orderId null). It is
// NEVER a zero-price checkout - no Payment, no WalletTransaction, no Order,
// no discount usage, no paid counters, no referral effects.
//
// Concurrency model (security-critical):
//   1. DB-authoritative claim: a partial unique index on
//      FreeTrialClaim.userId over in-progress/active statuses means two
//      simultaneous confirms can never both insert a live claim (P2002).
//   2. Per-panel capacity is decided under pg_advisory_xact_lock inside the
//      claim transaction - count-then-insert cannot over-allocate.
//   3. Redis provisioning lock (fail-closed) serializes the remote call;
//      when Redis is down the claim is safely CANCELLED (the entitlement is
//      NOT consumed) and the user is asked to retry later.
//
// Provider truth: an UNKNOWN remote outcome never issues a second account
// and never consumes/releases the entitlement without reconciliation - the
// claim stays PROVISIONING and the sweep re-checks by the exact frozen
// username (the ownership marker is persisted on the account note for
// manual audits). No secrets (tokens, passwords, subscription links) are
// ever logged.
// =============================================================================

export const TRIAL_MAX_PROVISION_ATTEMPTS = 3;
/** CLAIMED rows that never reached provisioning are cancelled after this. */
const STALE_CLAIM_MINUTES = 15;
/** PROVISIONING/UNKNOWN older than this alerts the admins (manual review). */
const MANUAL_REVIEW_ALERT_MINUTES = 60;
const SWEEP_INTERVAL_MS = 60_000;
const SWEEP_BATCH = 20;

// --- Persian texts (task-mandated, verbatim) -----------------------------------------------

// Trial-entitlement phase: the already-used / in-progress texts moved into
// the entitlement policy module (one-directional dependency); re-exported
// here so existing imports keep working.
export { TRIAL_ALREADY_USED_TEXT, TRIAL_IN_PROGRESS_TEXT } from "./free-trial-entitlement.service.js";
export const TRIAL_NO_PANEL_TEXT = "در حال حاضر پنل فعالی برای ارائه اکانت تست وجود ندارد.";
/** Shown when the GLOBAL switch is off (distinct from "no ready panel"). */
export const TRIAL_GLOBALLY_DISABLED_TEXT = "اکانت تست رایگان در حال حاضر غیرفعال است.";
export const TRIAL_TEMP_UNAVAILABLE_TEXT =
  "ساخت اکانت تست موقتاً امکان‌پذیر نیست. لطفاً کمی بعد دوباره تلاش کنید.";
export const TRIAL_NO_PURCHASE_ONLY_TEXT =
  "اکانت تست فقط برای کاربرانی فعال است که قبلاً خرید موفق نداشته‌اند.";
export const TRIAL_MEMBERSHIP_REQUIRED_TEXT =
  "برای دریافت اکانت تست، ابتدا در کانال‌های مشخص‌شده عضو شوید.";
export const TRIAL_SUCCESS_HEADER_TEXT = "اکانت تست شما با موفقیت ساخته شد ✅";
export const TRIAL_UNCERTAIN_TEXT =
  "نتیجه ساخت اکانت تست هنوز مشخص نیست و در حال بررسی است.";
export const TRIAL_CAPACITY_FULL_TEXT =
  "ظرفیت اکانت تست این لوکیشن تکمیل شده است. لطفاً بعداً تلاش کنید.";
export const TRIAL_SERVICE_PRODUCT_NAME = "اکانت تست رایگان";

// --- formatting helpers ---------------------------------------------------------------------

/** Human Persian duration for whole-minute trial windows. */
export function formatTrialDuration(minutes: number): string {
  if (minutes % 1440 === 0) {
    return `${minutes / 1440} روز`;
  }
  if (minutes % 60 === 0) {
    return `${minutes / 60} ساعت`;
  }
  return `${minutes} دقیقه`;
}

/** Human Persian traffic for MB-configured trial quotas. */
export function formatTrialTraffic(volumeMb: number): string {
  if (volumeMb % 1024 === 0) {
    return `${volumeMb / 1024} گیگابایت`;
  }
  return `${volumeMb} مگابایت`;
}

/** The trial ownership marker persisted as the remote account note. */
export function trialOwnershipMarker(claimId: string, telegramId: bigint): string {
  return `zedbot trial:${claimId.slice(0, 8)} tg:${telegramId}`;
}

// --- per-panel trial readiness ---------------------------------------------------------------

export interface TrialPanelAssessment {
  ok: boolean;
  /** Machine-readable reasons (safe, English) - empty when ok. */
  reasons: string[];
}

/**
 * Local validation that a panel's trial configuration is complete and the
 * panel could actually provision a trial RIGHT NOW. Used by the admin
 * activation guard and by user-facing availability (belt over testEnabled).
 */
export function assessTrialPanelConfig(panel: Panel): TrialPanelAssessment {
  const reasons: string[] = [];
  if (panel.status !== PanelStatus.ACTIVE) {
    reasons.push("panel-not-active");
  }
  if (!panelSupportsOperation(panel, "createService")) {
    reasons.push("create-capability-missing");
  }
  const config = assessPanelConfig(panel);
  if (!config.ok) {
    reasons.push(config.reason ?? "panel-config-incomplete");
  }
  if (panel.provisioningReady === false) {
    reasons.push("provisioning-readiness-failed");
  }
  if (!Number.isInteger(panel.testDurationMinutes) || (panel.testDurationMinutes ?? 0) <= 0) {
    reasons.push("trial-duration-missing");
  }
  // Unlimited trial traffic is deliberately unsupported: quota must be > 0.
  if (!Number.isInteger(panel.testVolumeMb) || (panel.testVolumeMb ?? 0) <= 0) {
    reasons.push("trial-traffic-missing");
  }
  if (
    panel.testMaxConcurrentAccounts !== null &&
    (!Number.isInteger(panel.testMaxConcurrentAccounts) || panel.testMaxConcurrentAccounts <= 0)
  ) {
    reasons.push("trial-capacity-invalid");
  }
  const naming = validateNamingConfig(namingConfigFromPanel(panel));
  if (!naming.ok) {
    reasons.push("naming-config-incomplete");
  }
  if (panel.type === "XUI") {
    const allowed = parsePanelInboundIds(panel.inboundIds);
    const trial = parsePanelInboundIds(panel.testInboundIds);
    if (trial.length === 0) {
      reasons.push("trial-inbounds-missing");
    } else if (!trial.every((id) => allowed.includes(id))) {
      reasons.push("trial-inbounds-outside-allowlist");
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/** Statuses that occupy a user's single live-claim slot / panel capacity. */
const LIVE_CLAIM_STATUSES: FreeTrialClaimStatus[] = [
  FreeTrialClaimStatus.CLAIMED,
  FreeTrialClaimStatus.PROVISIONING,
  FreeTrialClaimStatus.MANUAL_REVIEW,
];

/** Unexpired ACTIVE + in-flight claims currently counted against capacity. */
function capacityWhere(panelId: string, now: Date): Prisma.FreeTrialClaimWhereInput {
  return {
    panelId,
    OR: [
      { status: { in: LIVE_CLAIM_STATUSES } },
      {
        status: FreeTrialClaimStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
    ],
  };
}

export async function countActiveTrialsForPanel(panelId: string): Promise<number> {
  return prisma.freeTrialClaim.count({ where: capacityWhere(panelId, new Date()) });
}

// --- shared availability (ONE policy for user menu, panel list and admin diagnostics) ---------

/** A trial-enabled panel that is NOT ready, with its safe reason codes. */
export interface TrialPanelDiagnostic {
  panel: Panel;
  /** assessTrialPanelConfig codes, or "capacity-full" when only capacity blocks. */
  reasons: string[];
}

interface TrialPanelClassification {
  /** ACTIVE + testEnabled panels, user-sortable. */
  candidates: Panel[];
  /** Complete config AND free capacity - claimable RIGHT NOW. */
  ready: Panel[];
  /** Candidates that are not ready (config incomplete or capacity full). */
  incomplete: TrialPanelDiagnostic[];
}

/**
 * The single classifier every trial-availability surface derives from: the
 * user main-menu button, the user panel list and the admin diagnostics page
 * all share this exact policy. Capacity counts toward readiness: a panel
 * whose testMaxConcurrentAccounts is exhausted is NOT ready (reason code
 * "capacity-full") even when its configuration is complete.
 */
async function classifyTrialPanels(): Promise<TrialPanelClassification> {
  const candidates = await prisma.panel.findMany({
    where: { status: PanelStatus.ACTIVE, testEnabled: true },
    orderBy: [{ displayOrder: "asc" }, { name: "asc" }],
  });
  const ready: Panel[] = [];
  const incomplete: TrialPanelDiagnostic[] = [];
  for (const panel of candidates) {
    const reasons = [...assessTrialPanelConfig(panel).reasons];
    if (reasons.length === 0 && panel.testMaxConcurrentAccounts !== null) {
      const used = await countActiveTrialsForPanel(panel.id);
      if (used >= panel.testMaxConcurrentAccounts) {
        reasons.push("capacity-full");
      }
    }
    if (reasons.length === 0) {
      ready.push(panel);
    } else {
      incomplete.push({ panel, reasons });
    }
  }
  return { candidates, ready, incomplete };
}

/** Trial panels a user may claim on RIGHT NOW (complete config + capacity). */
export async function listTrialReadyPanels(): Promise<Panel[]> {
  return (await classifyTrialPanels()).ready;
}

/** Trial-enabled panels that are NOT ready, with safe reason codes (admin diagnostics). */
export async function listTrialIncompletePanels(): Promise<TrialPanelDiagnostic[]> {
  return (await classifyTrialPanels()).incomplete;
}

export type FreeTrialMenuReason =
  | "AVAILABLE"
  | "GLOBAL_DISABLED"
  | "NO_READY_PANEL"
  | "NO_VALID_XUI_INBOUND"
  | "PANEL_CONFIG_INCOMPLETE";

export interface FreeTrialMenuAvailability {
  visible: boolean;
  globallyEnabled: boolean;
  readyPanelCount: number;
  incompletePanelCount: number;
  reason: FreeTrialMenuReason;
}

const XUI_INBOUND_REASONS = new Set([
  "trial-inbounds-missing",
  "trial-inbounds-outside-allowlist",
]);

/**
 * Why the user main-menu trial button is (in)visible - shared by the menu
 * renderer and the OWNER admin diagnostics page. Panel counts are always
 * computed (the admin page needs them even while globally disabled).
 */
export async function getFreeTrialMenuAvailability(): Promise<FreeTrialMenuAvailability> {
  const globallyEnabled = await isFreeTrialEnabled();
  const { candidates, ready, incomplete } = await classifyTrialPanels();
  let reason: FreeTrialMenuReason;
  if (!globallyEnabled) {
    reason = "GLOBAL_DISABLED";
  } else if (ready.length > 0) {
    reason = "AVAILABLE";
  } else if (candidates.length === 0) {
    reason = "NO_READY_PANEL";
  } else if (
    incomplete.every((entry) => entry.reasons.every((code) => XUI_INBOUND_REASONS.has(code)))
  ) {
    reason = "NO_VALID_XUI_INBOUND";
  } else {
    reason = "PANEL_CONFIG_INCOMPLETE";
  }
  return {
    visible: globallyEnabled && ready.length > 0,
    globallyEnabled,
    readyPanelCount: ready.length,
    incompletePanelCount: incomplete.length,
    reason,
  };
}

/** True when the main-menu trial button should be rendered at all. */
export async function isFreeTrialVisible(): Promise<boolean> {
  return (await getFreeTrialMenuAvailability()).visible;
}

/**
 * Safe Persian sentence for a per-panel trial problem code (admin
 * diagnostics). NEVER exposes URLs, credentials or raw errors; unknown
 * codes collapse into the generic "not ready" sentence.
 */
export function trialPanelProblemLabel(reasonCode: string): string {
  switch (reasonCode) {
    case "panel-not-active":
      return "پنل غیرفعال است.";
    case "trial-duration-missing":
      return "مدت تست معتبر نیست.";
    case "trial-traffic-missing":
      return "حجم تست معتبر نیست.";
    case "trial-inbounds-missing":
      return "اینباند تست XUI انتخاب نشده است.";
    case "trial-inbounds-outside-allowlist":
      return "اینباند انتخاب‌شده دیگر معتبر نیست.";
    case "capacity-full":
      return "ظرفیت اکانت‌های تست تکمیل شده است.";
    default:
      // provisioning-readiness-failed / create-capability-missing /
      // naming-config-incomplete / panel-config-incomplete / anything else.
      return "پنل برای ساخت سرویس آماده نیست.";
  }
}

// --- eligibility ------------------------------------------------------------------------------

export type TrialEligibility =
  | { ok: true }
  | { ok: false; code: string; text: string };

/** Legacy machine codes for each entitlement denial reason (logs/tests). */
const DENIAL_CODES: Record<TrialDenialReason, string> = {
  GLOBAL_DISABLED: "globally-disabled",
  USER_BLOCKED: "user-not-active",
  ACTIVE_CLAIM: "claim-in-progress",
  NO_ALLOWANCE: "no-allowance",
  COOLDOWN: "cooldown",
  PREVIOUS_PURCHASE: "has-purchase",
  MEMBERSHIP_REQUIRED: "membership-required",
  PANEL_NOT_ALLOWED: "panel-not-allowed",
  ENTITLEMENT_EXPIRED: "entitlement-expired",
  ADMIN_DENIED: "admin-denied",
};

/**
 * Full user-level eligibility - delegates to the ONE shared entitlement
 * calculator (trial-entitlement phase) and adapts its result to the
 * engine's historical {ok, code, text} shape. Panel-level availability/
 * capacity is checked separately, and the claim transaction re-checks the
 * barriers and makes the allowance reservation - this function alone is
 * never trusted for the claim.
 */
export async function checkTrialEligibility(
  user: User,
  options: { panelId?: string } = {},
): Promise<TrialEligibility> {
  const result = await computeTrialEligibility(user, options);
  if (result.eligible) {
    return { ok: true };
  }
  const reason = result.denialReason ?? "NO_ALLOWANCE";
  const code =
    reason === "ACTIVE_CLAIM" && result.denialText === ENTITLEMENT_ALREADY_USED_TEXT
      ? "trial-active"
      : DENIAL_CODES[reason];
  return { ok: false, code, text: result.denialText ?? TRIAL_TEMP_UNAVAILABLE_TEXT };
}

// --- claim + provisioning ----------------------------------------------------------------------

export type TrialClaimOutcome =
  | { kind: "created"; claim: FreeTrialClaim; service: Service }
  | { kind: "uncertain"; claim: FreeTrialClaim }
  | { kind: "denied"; code: string; text: string };

class TrialDenied extends Error {
  constructor(
    readonly code: string,
    readonly text: string,
  ) {
    super(`trial denied: ${code}`);
  }
}

/**
 * The atomic claim, insert-first: the partial unique index IS the
 * concurrency guard (twenty simultaneous confirms -> one insert inside its
 * transaction, nineteen instant P2002 aborts with no long lock waits).
 * Trial-entitlement phase: the SAME transaction re-checks the admin
 * barriers on a fresh user row and reserves exactly one allowance unit
 * (conditional UPDATE ... WHERE consumed < allowance under a per-user
 * advisory lock) - the claim row is the reservation receipt, so a rollback
 * releases everything together. Capacity is then decided deterministically
 * in a TINY transaction under a per-panel advisory lock: the oldest claims
 * within the limit win; a losing insert cancels ITSELF and returns its
 * allowance unit - over-allocation is impossible.
 */
async function insertClaim(user: User, panel: Panel): Promise<FreeTrialClaim> {
  const now = new Date();
  let claim: FreeTrialClaim;
  try {
    claim = await prisma.$transaction(async (tx) => {
      // Insert FIRST: concurrent same-user claims die here immediately on
      // the partial unique index, before any lock is taken.
      const created = await tx.freeTrialClaim.create({
        data: {
          userId: user.id,
          panelId: panel.id,
          status: FreeTrialClaimStatus.CLAIMED,
          durationMinutes: panel.testDurationMinutes,
          trafficBytes: BigInt(panel.testVolumeMb ?? 0) * 1024n * 1024n,
        },
      });
      // Fresh barrier re-check: a revoke/denial that landed after the
      // outer eligibility read must win over this claim.
      const freshUser = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
      if (freshUser.status !== UserStatus.ACTIVE) {
        throw new TrialDenied("user-not-active", TRIAL_TEMP_UNAVAILABLE_TEXT);
      }
      if (freshUser.freeTrialRevokedAt !== null) {
        throw new TrialDenied(
          "admin-denied",
          "در حال حاضر امکان دریافت اکانت تست برای حساب شما فعال نیست.",
        );
      }
      if (freshUser.freeTrialDeniedUntil !== null && freshUser.freeTrialDeniedUntil > now) {
        throw new TrialDenied("admin-denied", TRIAL_TEMP_UNAVAILABLE_TEXT);
      }
      if (freshUser.freeTrialCooldownUntil !== null && freshUser.freeTrialCooldownUntil > now) {
        throw new TrialDenied("cooldown", ENTITLEMENT_ALREADY_USED_TEXT);
      }
      const reservation = await reserveTrialAllowance(tx, freshUser, panel.id, {
        excludeClaimId: created.id,
      });
      if (!reservation.ok) {
        throw new TrialDenied(DENIAL_CODES[reservation.reason], reservation.text);
      }
      if (reservation.entitlementId === null) {
        return created;
      }
      return tx.freeTrialClaim.update({
        where: { id: created.id },
        data: { entitlementId: reservation.entitlementId },
      });
    });
  } catch (err) {
    if (err instanceof TrialDenied) {
      throw err;
    }
    // Partial unique index: a concurrent claim by the same user won.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new TrialDenied("claim-in-progress", ENTITLEMENT_IN_PROGRESS_TEXT);
    }
    throw err;
  }

  if (panel.testMaxConcurrentAccounts !== null) {
    const limit = panel.testMaxConcurrentAccounts;
    const lost = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`zedbot-free-trial-panel:${panel.id}`}))`;
      // Decision-order capacity, NOT createdAt order: deciders serialize on
      // the panel advisory lock and each one self-cancels iff the OTHER
      // capacity-consuming claims already fill the limit. Age-based winner
      // selection is unsafe here - since the claim insert moved into a
      // multi-statement transaction (entitlement reservation), an OLDER
      // claim can become visible only after a younger claim's capacity
      // check ran, and both would then consider themselves winners. With
      // the others-count rule every prior decision is visible to the next
      // decider (commits release the xact lock), so the cap can never be
      // exceeded.
      const others = await tx.freeTrialClaim.count({
        where: { AND: [capacityWhere(panel.id, now), { id: { not: claim.id } }] },
      });
      if (others < limit) {
        return false;
      }
      await tx.freeTrialClaim.updateMany({
        where: { id: claim.id, status: FreeTrialClaimStatus.CLAIMED },
        data: { status: FreeTrialClaimStatus.CANCELLED, failureReasonCode: "capacity-full" },
      });
      return true;
    });
    if (lost) {
      // The claim self-cancelled inside the capacity transaction; give its
      // reserved allowance unit back (exactly-once via the claim CAS).
      await releaseClaimAllowance(claim.id, "capacity-full");
      throw new TrialDenied("capacity-full", TRIAL_CAPACITY_FULL_TEXT);
    }
  }
  return claim;
}

/**
 * CAS release used when nothing remote can have happened yet. Definite
 * non-creation, so the reserved allowance unit is returned (exactly once).
 */
async function cancelClaimSafely(claimId: string, reason: string): Promise<void> {
  const cancelled = await prisma.freeTrialClaim.updateMany({
    where: {
      id: claimId,
      status: { in: [FreeTrialClaimStatus.CLAIMED, FreeTrialClaimStatus.PROVISIONING] },
    },
    data: { status: FreeTrialClaimStatus.CANCELLED, failureReasonCode: reason.slice(0, 120) },
  });
  if (cancelled.count === 1) {
    await releaseClaimAllowance(claimId, reason.slice(0, 120));
  }
}

/**
 * Claims and provisions one free trial for the user on the given panel.
 * Callers must have answered the Telegram callback already; this performs
 * no Telegram sends itself (the handler renders from the outcome).
 */
export async function claimFreeTrial(user: User, panelId: string): Promise<TrialClaimOutcome> {
  const panel = await prisma.panel.findUnique({ where: { id: panelId } });
  if (panel === null || !panel.testEnabled || !assessTrialPanelConfig(panel).ok) {
    return { kind: "denied", code: "panel-not-ready", text: TRIAL_NO_PANEL_TEXT };
  }
  // Panel-scoped: a user whose only remaining allowance is a grant for a
  // DIFFERENT panel is denied here (PANEL_NOT_ALLOWED) before any write.
  const eligibility = await checkTrialEligibility(user, { panelId: panel.id });
  if (!eligibility.ok) {
    return { kind: "denied", code: eligibility.code, text: eligibility.text };
  }
  // Fail closed when the coordination backend is down - BEFORE any claim is
  // written, so nothing is consumed.
  if (!(await isLockBackendAvailable())) {
    return { kind: "denied", code: "lock-backend-down", text: TRIAL_TEMP_UNAVAILABLE_TEXT };
  }

  let claim: FreeTrialClaim;
  try {
    claim = await insertClaim(user, panel);
  } catch (err) {
    if (err instanceof TrialDenied) {
      return { kind: "denied", code: err.code, text: err.text };
    }
    logger.error("free trial claim failed", { userId: user.id, error: errorMessage(err) });
    return { kind: "denied", code: "claim-error", text: TRIAL_TEMP_UNAVAILABLE_TEXT };
  }

  logger.info("free trial claimed", {
    claimId: claim.id,
    userId: user.id,
    panelId: panel.id,
  });
  return provisionTrialClaim(claim, user, panel);
}

/**
 * Provisions one CLAIMED/PROVISIONING claim: freeze identity -> Redis lock
 * -> remote create -> verify -> Service + ACTIVE. Used by the fresh claim
 * path and by sweep retries; every step is CAS-guarded and reuses the
 * frozen identity so retries never mint a second account.
 */
export async function provisionTrialClaim(
  claim: FreeTrialClaim,
  user: User,
  panel: Panel,
): Promise<TrialClaimOutcome> {
  // (a) Freeze the remote identity ONCE (deterministic for retries).
  let username = claim.usernameSnapshot;
  let namingSnapshot = claim.namingSnapshot as Record<string, unknown> | null;
  if (username === null) {
    const resolved = await resolveVpnRemoteIdentity(
      { id: claim.id },
      user,
      panel.id,
      namingConfigFromPanel(panel),
    );
    if (!resolved.ok) {
      await cancelClaimSafely(claim.id, "naming-failed");
      return { kind: "denied", code: "naming-failed", text: TRIAL_TEMP_UNAVAILABLE_TEXT };
    }
    username = resolved.identity.resolvedRemoteUsername;
    namingSnapshot = {
      strategy: resolved.identity.strategy,
      version: resolved.identity.version,
      resolvedRemoteUsername: resolved.identity.resolvedRemoteUsername,
      resolvedDisplayName: resolved.identity.resolvedDisplayName,
      trialMarker: trialOwnershipMarker(claim.id, user.telegramId),
    };
    const frozen = await prisma.freeTrialClaim.updateMany({
      where: { id: claim.id, usernameSnapshot: null },
      data: {
        usernameSnapshot: username,
        namingSnapshot: namingSnapshot as Prisma.InputJsonObject,
      },
    });
    if (frozen.count === 0) {
      // A concurrent attempt froze it first - reuse the stored identity.
      const fresh = await prisma.freeTrialClaim.findUnique({ where: { id: claim.id } });
      username = fresh?.usernameSnapshot ?? username;
      namingSnapshot = (fresh?.namingSnapshot as Record<string, unknown> | null) ?? namingSnapshot;
    }
  }

  // (b) Move to PROVISIONING (CAS; counts attempts for manual-review).
  await prisma.freeTrialClaim.updateMany({
    where: {
      id: claim.id,
      status: { in: [FreeTrialClaimStatus.CLAIMED, FreeTrialClaimStatus.PROVISIONING] },
    },
    data: { status: FreeTrialClaimStatus.PROVISIONING, attemptCount: { increment: 1 } },
  });

  // (c) Remote call under the provisioning lock (fail closed, release claim).
  const lockAcq = await acquireServiceLock(serviceProvisioningLockKey(panel.id, username));
  if (!lockAcq.ok) {
    if (claim.attemptCount === 0 && lockAcq.reason === "unavailable") {
      // Nothing remote has ever been attempted for this claim - release it.
      await cancelClaimSafely(claim.id, "lock-unavailable");
      return { kind: "denied", code: "lock-unavailable", text: TRIAL_TEMP_UNAVAILABLE_TEXT };
    }
    // A previous attempt may have reached the panel - keep the claim for
    // reconciliation instead of releasing the entitlement.
    const fresh = await prisma.freeTrialClaim.findUnique({ where: { id: claim.id } });
    return { kind: "uncertain", claim: fresh ?? claim };
  }
  try {
    const durationMinutes = claim.durationMinutes ?? panel.testDurationMinutes ?? 0;
    const trafficBytes = claim.trafficBytes ?? BigInt(panel.testVolumeMb ?? 0) * 1024n * 1024n;
    const expiresAt = new Date(Date.now() + durationMinutes * 60_000);
    const note = trialOwnershipMarker(claim.id, user.telegramId);
    const adapter = buildAdapterForPanel(panel);
    const created = await adapter.createServiceAccount({
      username,
      note,
      volumeBytes: trafficBytes,
      durationDays: Math.max(1, Math.ceil(durationMinutes / 1440)),
      expiresAt,
      templateUsername: panel.templateUsername,
      dataLimitResetStrategy: panel.resetStrategy,
      subscriptionBaseUrl: normalizeSubscriptionBase(panel),
      inboundIds:
        panel.type === "XUI" ? parsePanelInboundIds(panel.testInboundIds) : undefined,
      protocolSettings:
        typeof panel.protocolSettings === "object" &&
        panel.protocolSettings !== null &&
        !Array.isArray(panel.protocolSettings)
          ? (panel.protocolSettings as Record<string, unknown>)
          : null,
    });

    if (!created.ok) {
      if (created.uncertain === true) {
        // UNKNOWN: never a second account, never a permanent consume without
        // reconciliation - the sweep re-checks by exact username + marker.
        logger.warn("free trial remote outcome unknown", {
          claimId: claim.id,
          panelId: panel.id,
        });
        const fresh = await prisma.freeTrialClaim.findUnique({ where: { id: claim.id } });
        return { kind: "uncertain", claim: fresh ?? claim };
      }
      // DEFINITE failure: nothing exists remotely - release the entitlement.
      const failed = await prisma.freeTrialClaim.updateMany({
        where: { id: claim.id, status: FreeTrialClaimStatus.PROVISIONING },
        data: {
          status: FreeTrialClaimStatus.FAILED,
          failureReasonCode: "remote-create-failed",
        },
      });
      if (failed.count === 1) {
        await releaseClaimAllowance(claim.id, "remote-create-failed");
      }
      logger.warn("free trial remote create failed", {
        claimId: claim.id,
        panelId: panel.id,
        error: created.errorMessage,
      });
      return { kind: "denied", code: "remote-failed", text: TRIAL_TEMP_UNAVAILABLE_TEXT };
    }

    const service = await persistTrialService(claim, user, panel, {
      username: created.username ?? username,
      note,
      trafficBytes,
      durationMinutes,
      expiresAt,
      subscriptionUrl: created.subscriptionUrl ?? null,
      subscriptionToken: created.subscriptionToken ?? null,
      configLinks: created.configLinks ?? null,
      remoteClientId: created.remoteClientId ?? null,
      remoteInboundIds: created.remoteInboundIds ?? null,
      remoteMetadata: created.remoteMetadata ?? null,
      namingSnapshot,
    });
    const freshClaim = await prisma.freeTrialClaim.findUniqueOrThrow({ where: { id: claim.id } });
    logger.info("free trial provisioned", {
      claimId: claim.id,
      serviceId: service.id,
      panelId: panel.id,
      userId: user.id,
    });
    return { kind: "created", claim: freshClaim, service };
  } catch (err) {
    logger.error("free trial provisioning crashed", {
      claimId: claim.id,
      error: errorMessage(err),
    });
    const fresh = await prisma.freeTrialClaim.findUnique({ where: { id: claim.id } });
    return { kind: "uncertain", claim: fresh ?? claim };
  } finally {
    await lockAcq.lock.release();
  }
}

interface TrialServiceInput {
  username: string;
  note: string;
  trafficBytes: bigint;
  durationMinutes: number;
  expiresAt: Date;
  subscriptionUrl: string | null;
  subscriptionToken: string | null;
  configLinks: string[] | null;
  remoteClientId: string | null;
  remoteInboundIds: number[] | null;
  remoteMetadata: Record<string, unknown> | null;
  namingSnapshot: Record<string, unknown> | null;
}

/** One transaction: Service (FREE_TRIAL) + claim ACTIVE + trial counters. */
async function persistTrialService(
  claim: FreeTrialClaim,
  user: User,
  panel: Panel,
  input: TrialServiceInput,
): Promise<Service> {
  const now = new Date();
  const serviceData: Prisma.ServiceUncheckedCreateInput = {
    userId: user.id,
    orderId: null,
    panelId: panel.id,
    productId: null,
    panelType: panel.type,
    username: input.username,
    note: input.note,
    namingStrategySnapshot: (input.namingSnapshot ?? undefined) as
      | Prisma.InputJsonObject
      | undefined,
    status: ServiceStatus.ACTIVE,
    source: "FREE_TRIAL",
    serviceLocation: "TEST",
    productNameSnapshot: panel.testProductName ?? TRIAL_SERVICE_PRODUCT_NAME,
    panelNameSnapshot: panel.name,
    volumeBytes: input.trafficBytes,
    usedBytes: 0n,
    remainingBytes: input.trafficBytes,
    durationDays: Math.max(1, Math.ceil(input.durationMinutes / 1440)),
    startsAt: now,
    expiresAt: input.expiresAt,
    subscriptionUrl: input.subscriptionUrl,
    subscriptionToken: input.subscriptionToken,
    ...(input.configLinks !== null ? { configLinks: input.configLinks } : {}),
    remoteClientId: input.remoteClientId,
    ...(input.remoteInboundIds !== null ? { remoteInboundIds: input.remoteInboundIds } : {}),
    ...(input.remoteMetadata !== null
      ? { remoteMetadata: input.remoteMetadata as Prisma.InputJsonObject }
      : {}),
  };
  return prisma.$transaction(async (tx) => {
    let service: Service;
    try {
      service = await tx.service.create({ data: serviceData });
    } catch (err) {
      // Unique username: a concurrent/prior attempt already persisted it.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const existing = await tx.service.findUnique({ where: { username: input.username } });
        if (existing !== null && existing.userId === user.id) {
          service = existing;
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    }
    const activated = await tx.freeTrialClaim.updateMany({
      where: {
        id: claim.id,
        status: { in: [FreeTrialClaimStatus.PROVISIONING, FreeTrialClaimStatus.MANUAL_REVIEW] },
      },
      data: {
        status: FreeTrialClaimStatus.ACTIVE,
        serviceId: service.id,
        provisionedAt: now,
        expiresAt: input.expiresAt,
        failureReasonCode: null,
      },
    });
    if (activated.count === 1) {
      // Trial counters only - NEVER paid statistics/wallet/revenue fields.
      await tx.user.update({
        where: { id: user.id },
        data: {
          testAccountsCreatedCount: { increment: 1 },
          lastTestAccountCreatedAt: now,
        },
      });
    }
    return service;
  });
}

// --- reconciliation + sweep ---------------------------------------------------------------------

export type TrialReconcileOutcome = "APPLIED" | "NOT_APPLIED" | "UNKNOWN";

/**
 * Re-checks one PROVISIONING claim against the panel using the exact frozen
 * username. APPLIED -> recover the Service and activate; NOT_APPLIED
 * (positively absent) -> release as FAILED (retryable); UNKNOWN -> defer.
 */
export async function reconcileTrialClaim(claimId: string): Promise<TrialReconcileOutcome> {
  const claim = await prisma.freeTrialClaim.findUnique({
    where: { id: claimId },
    include: { user: true, panel: true },
  });
  if (
    claim === null ||
    (claim.status !== FreeTrialClaimStatus.PROVISIONING &&
      claim.status !== FreeTrialClaimStatus.MANUAL_REVIEW) ||
    claim.usernameSnapshot === null
  ) {
    return "UNKNOWN";
  }
  try {
    const adapter = buildAdapterForPanel(claim.panel);
    const remote = await adapter.getServiceAccount({
      username: claim.usernameSnapshot,
      subscriptionBaseUrl: normalizeSubscriptionBase(claim.panel),
    });
    if (remote.ok) {
      const durationMinutes = claim.durationMinutes ?? claim.panel.testDurationMinutes ?? 0;
      const trafficBytes =
        claim.trafficBytes ?? BigInt(claim.panel.testVolumeMb ?? 0) * 1024n * 1024n;
      await persistTrialService(claim, claim.user, claim.panel, {
        username: remote.username ?? claim.usernameSnapshot,
        note: trialOwnershipMarker(claim.id, claim.user.telegramId),
        trafficBytes,
        durationMinutes,
        expiresAt:
          remote.expiresAt ?? new Date(claim.createdAt.getTime() + durationMinutes * 60_000),
        subscriptionUrl: remote.subscriptionUrl ?? null,
        subscriptionToken: remote.subscriptionToken ?? null,
        configLinks: remote.configLinks ?? null,
        remoteClientId: null,
        remoteInboundIds: null,
        remoteMetadata: (remote.remoteMetadata as Record<string, unknown> | undefined) ?? null,
        namingSnapshot: claim.namingSnapshot as Record<string, unknown> | null,
      });
      logger.info("free trial reconciliation applied", { claimId: claim.id });
      return "APPLIED";
    }
    if (remote.notFound === true) {
      const failed = await prisma.freeTrialClaim.updateMany({
        where: { id: claim.id, status: { in: [FreeTrialClaimStatus.PROVISIONING, FreeTrialClaimStatus.MANUAL_REVIEW] } },
        data: {
          status: FreeTrialClaimStatus.FAILED,
          failureReasonCode: "reconciled-not-applied",
        },
      });
      if (failed.count === 1) {
        // NOT_APPLIED: positively established non-creation - the reserved
        // allowance unit is returned exactly once (claim CAS guard).
        await releaseClaimAllowance(claim.id, "reconciled-not-applied");
      }
      logger.info("free trial reconciliation: not applied", { claimId: claim.id });
      return "NOT_APPLIED";
    }
    return "UNKNOWN";
  } catch (err) {
    logger.warn("free trial reconciliation failed", {
      claimId,
      error: errorMessage(err),
    });
    return "UNKNOWN";
  }
}

/** Alert every active OWNER admin about a claim needing manual review. */
async function alertOwnersAboutClaim(
  api: DeliverySendApi,
  claim: FreeTrialClaim,
): Promise<void> {
  try {
    const owners = await prisma.admin.findMany({
      where: { isActive: true, role: "OWNER" },
      select: { telegramId: true },
    });
    const text = [
      "⚠️ اکانت تست نیازمند بررسی",
      "",
      `شناسه: ${claim.id.slice(0, 8)}`,
      `وضعیت: ${claim.status}`,
      `تعداد تلاش: ${claim.attemptCount}`,
    ].join("\n");
    for (const owner of owners) {
      try {
        await api.sendMessage(owner.telegramId.toString(), text);
      } catch (err) {
        logger.warn("trial manual-review alert failed", { error: errorMessage(err) });
      }
    }
  } catch (err) {
    logger.warn("trial manual-review alert crashed", { error: errorMessage(err) });
  }
}

/** Notify the user ONCE that a reconciled trial is ready (never throws). */
async function notifyRecoveredTrial(api: DeliverySendApi, claimId: string): Promise<void> {
  try {
    const claim = await prisma.freeTrialClaim.findUnique({
      where: { id: claimId },
      include: { user: true, service: true },
    });
    if (claim === null || claim.service === null) {
      return;
    }
    await api.sendMessage(
      claim.user.telegramId.toString(),
      buildTrialSuccessMessage(claim.service, claim.durationMinutes ?? 0),
    );
  } catch (err) {
    logger.warn("trial recovery notice failed", { error: errorMessage(err) });
  }
}

/**
 * One sweep, never throws:
 *  - expire ACTIVE claims (+ mark the trial Service EXPIRED, optionally
 *    disable the remote account when the panel is configured for it);
 *  - cancel stale CLAIMED rows that never reached the panel;
 *  - reconcile PROVISIONING claims (recover/release);
 *  - escalate exhausted claims to MANUAL_REVIEW and alert OWNER admins.
 */
export async function runFreeTrialSweep(api: DeliverySendApi): Promise<void> {
  try {
    const now = new Date();

    // (0) Trial-entitlement phase: ACTIVE grants past their expiresAt
    // become EXPIRED deterministically (idempotent; rows never deleted).
    await expireTrialEntitlements(now);

    // (1) Expiry: claim -> EXPIRED, service -> EXPIRED (CAS both).
    const expiring = await prisma.freeTrialClaim.findMany({
      where: { status: FreeTrialClaimStatus.ACTIVE, expiresAt: { lt: now } },
      take: SWEEP_BATCH,
      include: { panel: true, service: true },
    });
    for (const claim of expiring) {
      await prisma.freeTrialClaim.updateMany({
        where: { id: claim.id, status: FreeTrialClaimStatus.ACTIVE },
        data: { status: FreeTrialClaimStatus.EXPIRED },
      });
      // Trial-lifecycle phase: a CONVERTED service (or one whose paid
      // renewal already moved its own expiry into the future) is a normal
      // paid-lifecycle service now - the trial claim still expires above,
      // but the service is never expired or remotely disabled by the sweep.
      const converted =
        claim.service !== null &&
        (claim.service.convertedToPaidAt !== null ||
          (claim.service.expiresAt !== null && claim.service.expiresAt > now));
      if (claim.serviceId !== null && !converted) {
        await prisma.service.updateMany({
          where: {
            id: claim.serviceId,
            status: { in: [ServiceStatus.ACTIVE, ServiceStatus.LIMITED] },
            convertedToPaidAt: null,
          },
          data: { status: ServiceStatus.EXPIRED },
        });
      }
      if (claim.panel.testAutoDisableAfterExpiry && claim.service !== null && !converted) {
        try {
          const adapter = buildAdapterForPanel(claim.panel);
          await adapter.setServiceStatus({ username: claim.service.username, enabled: false });
        } catch (err) {
          logger.warn("trial remote auto-disable failed", {
            claimId: claim.id,
            error: errorMessage(err),
          });
        }
      }
      logger.info("free trial expired", { claimId: claim.id });
    }

    // (2) Stale CLAIMED rows: never touched the panel - cancel safely one
    // by one so each reserved allowance unit is released exactly once.
    const staleClaims = await prisma.freeTrialClaim.findMany({
      where: {
        status: FreeTrialClaimStatus.CLAIMED,
        createdAt: { lt: new Date(now.getTime() - STALE_CLAIM_MINUTES * 60_000) },
      },
      take: SWEEP_BATCH,
      select: { id: true },
    });
    for (const stale of staleClaims) {
      await cancelClaimSafely(stale.id, "stale-claim");
    }

    // (3) Reconcile PROVISIONING claims older than a minute.
    const provisioning = await prisma.freeTrialClaim.findMany({
      where: {
        status: FreeTrialClaimStatus.PROVISIONING,
        updatedAt: { lt: new Date(now.getTime() - 60_000) },
      },
      take: SWEEP_BATCH,
    });
    for (const claim of provisioning) {
      const outcome = await reconcileTrialClaim(claim.id);
      if (outcome === "APPLIED") {
        await notifyRecoveredTrial(api, claim.id);
      } else if (outcome === "UNKNOWN") {
        const ageMinutes = (now.getTime() - claim.updatedAt.getTime()) / 60_000;
        if (
          claim.attemptCount >= TRIAL_MAX_PROVISION_ATTEMPTS ||
          ageMinutes >= MANUAL_REVIEW_ALERT_MINUTES
        ) {
          const escalated = await prisma.freeTrialClaim.updateMany({
            where: { id: claim.id, status: FreeTrialClaimStatus.PROVISIONING },
            data: { status: FreeTrialClaimStatus.MANUAL_REVIEW },
          });
          if (escalated.count === 1) {
            const fresh = await prisma.freeTrialClaim.findUnique({ where: { id: claim.id } });
            if (fresh !== null) {
              await alertOwnersAboutClaim(api, fresh);
            }
          }
        }
      }
    }
  } catch (err) {
    logger.error("free trial sweep failed", { error: errorMessage(err) });
  }
}

/** Self-rescheduling sweep loop (same pattern as the settlement sweep). */
export function startFreeTrialLoop(api: DeliverySendApi): void {
  const tick = (): void => {
    void runFreeTrialSweep(api)
      .catch((err: unknown) => {
        logger.error("free trial sweep rejected", { error: errorMessage(err) });
      })
      .finally(() => {
        setTimeout(tick, SWEEP_INTERVAL_MS).unref();
      });
  };
  setTimeout(tick, SWEEP_INTERVAL_MS).unref();
}

// --- user-facing success message -----------------------------------------------------------------

/** The post-provisioning success message (credentials go ONLY to the owner). */
export function buildTrialSuccessMessage(service: Service, durationMinutes: number): string {
  const lines = [
    TRIAL_SUCCESS_HEADER_TEXT,
    "",
    `نام کاربری:\n${service.username}`,
    "",
    `مدت اعتبار:\n${formatTrialDuration(Math.max(1, durationMinutes))}`,
    "",
    `حجم:\n${formatTrialTraffic(Number(service.volumeBytes / (1024n * 1024n)))}`,
  ];
  if (service.subscriptionUrl !== null && service.subscriptionUrl !== "") {
    lines.push("", `لینک اشتراک:\n${service.subscriptionUrl}`);
  }
  return lines.join("\n");
}

// --- admin statistics ------------------------------------------------------------------------------

export interface TrialPanelStats {
  total: number;
  active: number;
  provisioning: number;
  expired: number;
  failed: number;
  manualReview: number;
  lastCreatedAt: Date | null;
  capacityLimit: number | null;
  capacityUsed: number;
}

export async function trialStatsForPanel(panel: Panel): Promise<TrialPanelStats> {
  const [total, active, provisioning, expired, failed, manualReview, last, capacityUsed] =
    await Promise.all([
      prisma.freeTrialClaim.count({ where: { panelId: panel.id } }),
      prisma.freeTrialClaim.count({
        where: { panelId: panel.id, status: FreeTrialClaimStatus.ACTIVE },
      }),
      prisma.freeTrialClaim.count({
        where: {
          panelId: panel.id,
          status: { in: [FreeTrialClaimStatus.CLAIMED, FreeTrialClaimStatus.PROVISIONING] },
        },
      }),
      prisma.freeTrialClaim.count({
        where: { panelId: panel.id, status: FreeTrialClaimStatus.EXPIRED },
      }),
      prisma.freeTrialClaim.count({
        where: {
          panelId: panel.id,
          status: { in: [FreeTrialClaimStatus.FAILED, FreeTrialClaimStatus.CANCELLED] },
        },
      }),
      prisma.freeTrialClaim.count({
        where: { panelId: panel.id, status: FreeTrialClaimStatus.MANUAL_REVIEW },
      }),
      prisma.freeTrialClaim.findFirst({
        where: { panelId: panel.id },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      countActiveTrialsForPanel(panel.id),
    ]);
  return {
    total,
    active,
    provisioning,
    expired,
    failed,
    manualReview,
    lastCreatedAt: last?.createdAt ?? null,
    capacityLimit: panel.testMaxConcurrentAccounts,
    capacityUsed,
  };
}
