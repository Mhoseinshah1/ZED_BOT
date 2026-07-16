import {
  FreeTrialClaimStatus,
  FreeTrialEntitlementStatus,
  Prisma,
  prisma,
  type Admin,
  type FreeTrialClaim,
  type FreeTrialEntitlement,
  type User,
} from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import {
  computeTrialAllowance,
  computeTrialEligibility,
  CONSUMING_CLAIM_STATUSES,
  effectiveDefaultAllowance,
  LIVE_ELIGIBILITY_STATUSES,
  releaseClaimAllowance,
  TRIAL_GRANT_MAX_PER_OPERATION,
  type TrialEligibilityResult,
} from "./free-trial-entitlement.service.js";
import { reconcileTrialClaim } from "./free-trial.service.js";

// =============================================================================
// Trial-entitlement phase: ADMIN operations over per-user trial allowances.
// Every mutation here is (a) permission-checked by the CALLER's handler
// (OWNER-only where mandated - RBAC beyond roles is a documented separate
// task), (b) reason-carrying where mandated, (c) idempotent via an explicit
// idempotencyKey on the entitlement row or a CAS, and (d) written to the
// AuditLog table with SAFE before/after values (never secrets, links,
// tokens or raw panel data). Historical claims and services are NEVER
// deleted or edited by any operation in this file; resets only grant NEW
// eligibility and clear admin barriers.
// =============================================================================

export { TRIAL_GRANT_MAX_PER_OPERATION };

/** Interactive bulk-grant hard cap (selected-user batches). */
export const TRIAL_BULK_GRANT_MAX_USERS = 500;

// --- audit ---------------------------------------------------------------------------------------

/**
 * The first real AuditLog writer: one row per admin trial mutation, safe
 * metadata only. Auditing must never break the mutation - failures are
 * logged and swallowed (the operation itself already committed).
 */
export async function writeTrialAudit(
  admin: Pick<Admin, "id" | "telegramId">,
  action: string,
  entity: { type: string; id: string },
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        actorTelegramId: admin.telegramId,
        actorType: "ADMIN",
        action,
        entityType: entity.type,
        entityId: entity.id,
        metadata: { ...metadata, adminId: admin.id } as Prisma.InputJsonValue,
      },
    });
  } catch (err) {
    logger.error("trial audit write failed", { action, error: errorMessage(err) });
  }
}

// --- shared helpers ------------------------------------------------------------------------------

export type TrialAdminOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

const INVALID_COUNT_TEXT = `تعداد باید عددی بین 1 تا ${TRIAL_GRANT_MAX_PER_OPERATION} باشد.`;

/**
 * Parses a positive allowance count from admin text input. Persian and
 * Arabic-Indic digits are normalized; anything non-numeric, zero, negative
 * or above the per-operation cap is rejected.
 */
export function parseAllowanceCount(raw: string): number | null {
  const normalized = normalizeDigits(raw.trim());
  if (!/^\d{1,4}$/.test(normalized)) {
    return null;
  }
  const value = Number.parseInt(normalized, 10);
  if (!Number.isFinite(value) || value < 1 || value > TRIAL_GRANT_MAX_PER_OPERATION) {
    return null;
  }
  return value;
}

/** Persian (۰-۹) and Arabic-Indic (٠-٩) digits -> ASCII. */
export function normalizeDigits(raw: string): string {
  return raw
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));
}

async function requireUser(userId: string): Promise<User> {
  return prisma.user.findUniqueOrThrow({ where: { id: userId } });
}

// --- grant allowance -----------------------------------------------------------------------------

export interface GrantTrialAllowanceInput {
  admin: Pick<Admin, "id" | "telegramId">;
  userId: string;
  count: number;
  reason: string;
  /** GLOBAL by default; pass a panelId for a panel-scoped grant. */
  panelId?: string;
  expiresAt?: Date | null;
  /** One-shot key (trial-grant:<nonce>) - replays return the same row. */
  idempotencyKey: string;
  source?: "ADMIN_GRANT" | "ADMIN_RESET" | "COMPENSATION";
}

/** Creates one auditable entitlement. Never touches old claims. */
export async function grantTrialAllowance(
  input: GrantTrialAllowanceInput,
): Promise<TrialAdminOutcome<FreeTrialEntitlement>> {
  if (
    !Number.isInteger(input.count) ||
    input.count < 1 ||
    input.count > TRIAL_GRANT_MAX_PER_OPERATION
  ) {
    return { ok: false, error: INVALID_COUNT_TEXT };
  }
  if (input.reason.trim() === "") {
    return { ok: false, error: "دلیل الزامی است." };
  }
  if (input.panelId !== undefined) {
    const panel = await prisma.panel.findUnique({ where: { id: input.panelId } });
    if (panel === null) {
      return { ok: false, error: "پنل انتخاب‌شده یافت نشد." };
    }
  }
  let entitlement: FreeTrialEntitlement;
  try {
    entitlement = await prisma.freeTrialEntitlement.create({
      data: {
        userId: input.userId,
        allowance: input.count,
        scope: input.panelId === undefined ? "GLOBAL" : "PANEL",
        panelId: input.panelId ?? null,
        source: input.source ?? "ADMIN_GRANT",
        expiresAt: input.expiresAt ?? null,
        reason: input.reason.trim().slice(0, 500),
        createdByAdminId: input.admin.id,
        idempotencyKey: input.idempotencyKey,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Replayed confirmation: reuse the one row this key already created.
      const existing = await prisma.freeTrialEntitlement.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });
      if (existing !== null) {
        return { ok: true, value: existing };
      }
    }
    throw err;
  }
  await writeTrialAudit(input.admin, "trial.allowance.granted", {
    type: "FreeTrialEntitlement",
    id: entitlement.id,
  }, {
    userId: input.userId,
    allowance: input.count,
    scope: entitlement.scope,
    panelId: input.panelId ?? null,
    expiresAt: input.expiresAt?.toISOString() ?? null,
    reason: entitlement.reason,
    source: entitlement.source,
  });
  return { ok: true, value: entitlement };
}

// --- set effective remaining (OWNER) ---------------------------------------------------------------

export interface SetRemainingResult {
  before: number;
  after: number;
}

/**
 * OWNER operation: makes the user's effective remaining allowance exactly
 * `desired`, deterministically - every usable entitlement remainder is
 * revoked (rows keep their historical allowance/consumed values), the
 * per-user default-allowance override pins the default remainder to zero,
 * and one fresh ADMIN_RESET row carries the new remaining. Historical
 * claims are untouched and the result can never be negative.
 */
export async function setEffectiveRemaining(input: {
  admin: Pick<Admin, "id" | "telegramId">;
  userId: string;
  desired: number;
  reason: string;
  idempotencyKey: string;
}): Promise<TrialAdminOutcome<SetRemainingResult>> {
  if (!Number.isInteger(input.desired) || input.desired < 0) {
    return { ok: false, error: "مقدار باید عددی صفر یا بزرگ‌تر باشد." };
  }
  if (input.desired > TRIAL_GRANT_MAX_PER_OPERATION) {
    return { ok: false, error: INVALID_COUNT_TEXT };
  }
  if (input.reason.trim() === "") {
    return { ok: false, error: "دلیل الزامی است." };
  }
  const user = await requireUser(input.userId);
  const now = new Date();
  const summary = await computeTrialAllowance(user);
  const before =
    summary.totalRemaining === null ? Number.MAX_SAFE_INTEGER : summary.totalRemaining;

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`zedbot-free-trial-user:${user.id}`}))`;
    // Revoke every usable remainder (values preserved for history/audit).
    await tx.freeTrialEntitlement.updateMany({
      where: {
        userId: user.id,
        status: FreeTrialEntitlementStatus.ACTIVE,
      },
      data: {
        status: FreeTrialEntitlementStatus.REVOKED,
        revokedAt: now,
        revokedByAdminId: input.admin.id,
      },
    });
    // Pin the default remainder to zero: override = units already consumed
    // from the default pool (default remaining becomes exactly 0).
    const defaultConsumed = await tx.freeTrialClaim.count({
      where: {
        userId: user.id,
        entitlementId: null,
        status: { in: CONSUMING_CLAIM_STATUSES },
      },
    });
    await tx.user.update({
      where: { id: user.id },
      data: { freeTrialDefaultAllowanceOverride: defaultConsumed },
    });
    if (input.desired > 0) {
      await tx.freeTrialEntitlement.create({
        data: {
          userId: user.id,
          allowance: input.desired,
          scope: "GLOBAL",
          source: "ADMIN_RESET",
          reason: input.reason.trim().slice(0, 500),
          createdByAdminId: input.admin.id,
          idempotencyKey: input.idempotencyKey,
        },
      });
    }
  });

  await writeTrialAudit(input.admin, "trial.remaining.set", { type: "User", id: user.id }, {
    before: summary.totalRemaining === null ? "unlimited" : before,
    after: input.desired,
    reason: input.reason.trim().slice(0, 500),
  });
  return { ok: true, value: { before, after: input.desired } };
}

// --- reset access ---------------------------------------------------------------------------------

export const TRIAL_RESET_BLOCKED_TEXT =
  "برای این کاربر یک درخواست تست در حال پردازش یا بررسی است. ابتدا وضعیت آن را مشخص کنید.";

/**
 * Reset = keep ALL history (claims, services, conversions), clear the admin
 * barriers (revoke / temporary denial / custom cooldown; the setting-based
 * cooldown is waived) and grant fresh allowance. Refused while a live or
 * manual-review claim exists - force resolution must decide it first. The
 * reset never touches remote accounts.
 */
export async function resetTrialAccess(input: {
  admin: Pick<Admin, "id" | "telegramId">;
  userId: string;
  allowance?: number;
  reason: string;
  idempotencyKey: string;
}): Promise<TrialAdminOutcome<FreeTrialEntitlement>> {
  if (input.reason.trim() === "") {
    return { ok: false, error: "دلیل الزامی است." };
  }
  const blocking = await prisma.freeTrialClaim.findFirst({
    where: { userId: input.userId, status: { in: LIVE_ELIGIBILITY_STATUSES } },
    select: { id: true, status: true },
  });
  if (blocking !== null) {
    return { ok: false, error: TRIAL_RESET_BLOCKED_TEXT };
  }
  const now = new Date();
  await prisma.user.update({
    where: { id: input.userId },
    data: {
      freeTrialRevokedAt: null,
      freeTrialRevokedByAdminId: null,
      freeTrialDeniedUntil: null,
      freeTrialCooldownUntil: null,
      freeTrialCooldownClearedAt: now,
    },
  });
  const granted = await grantTrialAllowance({
    admin: input.admin,
    userId: input.userId,
    count: input.allowance ?? 1,
    reason: input.reason,
    idempotencyKey: input.idempotencyKey,
    source: "ADMIN_RESET",
  });
  if (!granted.ok) {
    return granted;
  }
  await writeTrialAudit(input.admin, "trial.access.reset", { type: "User", id: input.userId }, {
    allowance: input.allowance ?? 1,
    reason: input.reason.trim().slice(0, 500),
    barriersCleared: true,
  });
  return granted;
}

// --- revoke / cooldown / denial --------------------------------------------------------------------

/** Blocks FUTURE claims only; services and history stay untouched. */
export async function revokeTrialAccess(input: {
  admin: Pick<Admin, "id" | "telegramId">;
  userId: string;
  reason: string;
}): Promise<TrialAdminOutcome<null>> {
  if (input.reason.trim() === "") {
    return { ok: false, error: "دلیل الزامی است." };
  }
  const user = await requireUser(input.userId);
  const before = user.freeTrialRevokedAt?.toISOString() ?? null;
  await prisma.user.update({
    where: { id: input.userId },
    data: { freeTrialRevokedAt: new Date(), freeTrialRevokedByAdminId: input.admin.id },
  });
  await writeTrialAudit(input.admin, "trial.access.revoked", { type: "User", id: input.userId }, {
    before: { revokedAt: before },
    after: { revokedAt: new Date().toISOString() },
    reason: input.reason.trim().slice(0, 500),
  });
  return { ok: true, value: null };
}

/** Clears BOTH the custom barrier and the setting-computed cooldown. */
export async function clearTrialCooldown(input: {
  admin: Pick<Admin, "id" | "telegramId">;
  userId: string;
}): Promise<TrialAdminOutcome<null>> {
  const user = await requireUser(input.userId);
  const now = new Date();
  await prisma.user.update({
    where: { id: input.userId },
    data: { freeTrialCooldownUntil: null, freeTrialCooldownClearedAt: now },
  });
  await writeTrialAudit(input.admin, "trial.cooldown.cleared", { type: "User", id: input.userId }, {
    before: { cooldownUntil: user.freeTrialCooldownUntil?.toISOString() ?? null },
    after: { cooldownUntil: null, clearedAt: now.toISOString() },
  });
  return { ok: true, value: null };
}

/** Hard per-user cooldown barrier until the given date. */
export async function setTrialCooldown(input: {
  admin: Pick<Admin, "id" | "telegramId">;
  userId: string;
  until: Date;
  reason: string;
}): Promise<TrialAdminOutcome<null>> {
  if (input.until.getTime() <= Date.now()) {
    return { ok: false, error: "تاریخ باید در آینده باشد." };
  }
  const user = await requireUser(input.userId);
  await prisma.user.update({
    where: { id: input.userId },
    data: { freeTrialCooldownUntil: input.until },
  });
  await writeTrialAudit(input.admin, "trial.cooldown.set", { type: "User", id: input.userId }, {
    before: { cooldownUntil: user.freeTrialCooldownUntil?.toISOString() ?? null },
    after: { cooldownUntil: input.until.toISOString() },
    reason: input.reason.trim().slice(0, 500),
  });
  return { ok: true, value: null };
}

/** Temporary denial (distinct message from cooldown) until the given date. */
export async function setTrialTemporaryDenial(input: {
  admin: Pick<Admin, "id" | "telegramId">;
  userId: string;
  until: Date;
  reason: string;
}): Promise<TrialAdminOutcome<null>> {
  if (input.until.getTime() <= Date.now()) {
    return { ok: false, error: "تاریخ باید در آینده باشد." };
  }
  const user = await requireUser(input.userId);
  await prisma.user.update({
    where: { id: input.userId },
    data: { freeTrialDeniedUntil: input.until },
  });
  await writeTrialAudit(input.admin, "trial.denial.set", { type: "User", id: input.userId }, {
    before: { deniedUntil: user.freeTrialDeniedUntil?.toISOString() ?? null },
    after: { deniedUntil: input.until.toISOString() },
    reason: input.reason.trim().slice(0, 500),
  });
  return { ok: true, value: null };
}

// --- per-user summary -------------------------------------------------------------------------------

export interface TrialManagementSummary {
  eligibility: TrialEligibilityResult;
  defaultAllowance: number | null;
  usedCount: number;
  remaining: number | null;
  activeTrialExists: boolean;
  provisioningExists: boolean;
  lastTrialAt: Date | null;
  cooldownEndsAt: Date | null;
  accessRevoked: boolean;
  deniedUntil: Date | null;
  claimCounts: Record<string, number>;
  convertedServiceCount: number;
  activeGrantCount: number;
  expiredGrantCount: number;
  revokedGrantCount: number;
}

/** Everything the per-user admin page shows - no secrets anywhere. */
export async function trialManagementSummary(userId: string): Promise<TrialManagementSummary> {
  const user = await requireUser(userId);
  const [eligibility, allowance, defaultAllowance, byStatus, converted, grants, lastClaim] =
    await Promise.all([
      computeTrialEligibility(user),
      computeTrialAllowance(user),
      effectiveDefaultAllowance(user),
      prisma.freeTrialClaim.groupBy({
        by: ["status"],
        where: { userId },
        _count: { _all: true },
      }),
      prisma.service.count({
        where: { userId, source: "FREE_TRIAL", convertedToPaidAt: { not: null } },
      }),
      prisma.freeTrialEntitlement.groupBy({
        by: ["status"],
        where: { userId },
        _count: { _all: true },
      }),
      prisma.freeTrialClaim.findFirst({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ]);
  const claimCounts: Record<string, number> = {};
  for (const row of byStatus) {
    claimCounts[row.status] = row._count._all;
  }
  const grantCount = (status: FreeTrialEntitlementStatus): number =>
    grants.find((g) => g.status === status)?._count._all ?? 0;
  const usedCount = CONSUMING_CLAIM_STATUSES.reduce(
    (sum, status) => sum + (claimCounts[status] ?? 0),
    0,
  );
  return {
    eligibility,
    defaultAllowance,
    usedCount,
    remaining: allowance.totalRemaining,
    activeTrialExists: (claimCounts[FreeTrialClaimStatus.ACTIVE] ?? 0) > 0,
    provisioningExists:
      (claimCounts[FreeTrialClaimStatus.CLAIMED] ?? 0) +
        (claimCounts[FreeTrialClaimStatus.PROVISIONING] ?? 0) >
      0,
    lastTrialAt: lastClaim?.createdAt ?? null,
    cooldownEndsAt: eligibility.cooldownEndsAt ?? user.freeTrialCooldownUntil,
    accessRevoked: user.freeTrialRevokedAt !== null,
    deniedUntil: user.freeTrialDeniedUntil,
    claimCounts,
    convertedServiceCount: converted,
    activeGrantCount: grantCount(FreeTrialEntitlementStatus.ACTIVE),
    expiredGrantCount: grantCount(FreeTrialEntitlementStatus.EXPIRED),
    revokedGrantCount: grantCount(FreeTrialEntitlementStatus.REVOKED),
  };
}

// --- force resolution (OWNER) ------------------------------------------------------------------------

export const TRIAL_FORCE_WARNING_TEXT =
  "نتیجه ساخت این اکانت تست قطعی نیست.\n\nآزادسازی سهمیه ممکن است باعث ساخته‌شدن بیش از یک اکانت تست شود. فقط پس از بررسی پنل ادامه دهید.";

/** Claims an OWNER may force-resolve. */
export const FORCE_RESOLVABLE_STATUSES: FreeTrialClaimStatus[] = [
  FreeTrialClaimStatus.PROVISIONING,
  FreeTrialClaimStatus.MANUAL_REVIEW,
];

/**
 * OWNER force "the account was NOT created": cancels the claim and releases
 * its allowance exactly once. Automatic reconciliation must have been
 * attempted first (callers run reconcileTrialClaim before offering this).
 */
export async function forceClaimNotCreated(input: {
  admin: Pick<Admin, "id" | "telegramId">;
  claimId: string;
  reason: string;
}): Promise<TrialAdminOutcome<null>> {
  if (input.reason.trim() === "") {
    return { ok: false, error: "دلیل الزامی است." };
  }
  const claim = await prisma.freeTrialClaim.findUnique({ where: { id: input.claimId } });
  if (claim === null || !FORCE_RESOLVABLE_STATUSES.includes(claim.status)) {
    return { ok: false, error: "این درخواست قابل تعیین وضعیت نیست." };
  }
  const cancelled = await prisma.freeTrialClaim.updateMany({
    where: { id: input.claimId, status: { in: FORCE_RESOLVABLE_STATUSES } },
    data: { status: FreeTrialClaimStatus.CANCELLED, failureReasonCode: "forced-not-created" },
  });
  if (cancelled.count !== 1) {
    return { ok: false, error: "این درخواست قابل تعیین وضعیت نیست." };
  }
  const released = await releaseClaimAllowance(input.claimId, "forced-not-created");
  await writeTrialAudit(input.admin, "trial.claim.forced_not_created", {
    type: "FreeTrialClaim",
    id: input.claimId,
  }, {
    before: { status: claim.status },
    after: { status: FreeTrialClaimStatus.CANCELLED, allowanceReleased: released },
    reason: input.reason.trim().slice(0, 500),
  });
  return { ok: true, value: null };
}

/**
 * OWNER force "the account WAS created": runs the reconciler, which
 * verifies the account on the panel by its frozen username and, when found,
 * persists the Service and activates the claim (allowance stays consumed).
 * When the panel does not report the account, nothing is forced blindly.
 */
export async function forceClaimCreated(input: {
  admin: Pick<Admin, "id" | "telegramId">;
  claimId: string;
  reason: string;
}): Promise<TrialAdminOutcome<"APPLIED" | "NOT_APPLIED" | "UNKNOWN">> {
  if (input.reason.trim() === "") {
    return { ok: false, error: "دلیل الزامی است." };
  }
  const claim = await prisma.freeTrialClaim.findUnique({ where: { id: input.claimId } });
  if (claim === null || !FORCE_RESOLVABLE_STATUSES.includes(claim.status)) {
    return { ok: false, error: "این درخواست قابل تعیین وضعیت نیست." };
  }
  const outcome = await reconcileTrialClaim(input.claimId);
  await writeTrialAudit(input.admin, "trial.claim.forced_created", {
    type: "FreeTrialClaim",
    id: input.claimId,
  }, {
    before: { status: claim.status },
    after: { reconcileOutcome: outcome },
    reason: input.reason.trim().slice(0, 500),
  });
  return { ok: true, value: outcome };
}

// --- paginated per-user history ------------------------------------------------------------------------

export const TRIAL_HISTORY_PAGE_SIZE = 5;

export interface TrialHistoryPage {
  claims: (FreeTrialClaim & { panel: { name: string } })[];
  page: number;
  pages: number;
  total: number;
}

export async function listTrialHistory(userId: string, page: number): Promise<TrialHistoryPage> {
  const total = await prisma.freeTrialClaim.count({ where: { userId } });
  const pages = Math.max(1, Math.ceil(total / TRIAL_HISTORY_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const claims = await prisma.freeTrialClaim.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    skip: (safePage - 1) * TRIAL_HISTORY_PAGE_SIZE,
    take: TRIAL_HISTORY_PAGE_SIZE,
    include: { panel: { select: { name: true } } },
  });
  return { claims: claims as TrialHistoryPage["claims"], page: safePage, pages, total };
}
