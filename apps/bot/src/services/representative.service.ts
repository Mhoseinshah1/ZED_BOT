import {
  Prisma,
  prisma,
  type Representative,
  type RepresentativeApplication,
  type RepresentativeTier,
} from "@zedbot/database";
import {
  errorMessage,
  isRepresentativeSalesChannel,
  isValidRepExperience,
  isValidRepExplanation,
  isValidRepFullName,
  isValidRepLocation,
  isValidRepReason,
  normalizeIranMobile,
  parseExpectedMonthlyCustomers,
  REPRESENTATIVE_PRICING_MODE,
  representativeShortId,
  representativeValueBucket,
  type RepresentativeErrorCode,
} from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { writeSystemLog } from "./system-log.service.js";
import type { EffectiveProductPrice } from "./representative-pricing.service.js";

// =============================================================================
// Representative Program — core service (§9, §12, §13, §16, §20, §25).
//
// The authoritative, financially-isolated data layer for the reseller-price
// program. Everything here is careful about:
//   * IDEMPOTENCY — a duplicate application converges to ONE open row; a
//     duplicate approval converges to ONE Representative (userId unique); a
//     completed purchase is linked exactly once.
//   * CONVERGENCE — a repeated Telegram update (sourceUpdateId) or a P2002 on a
//     unique constraint resolves to the existing row, never a second one.
//   * ISOLATION — this module NEVER moves money. It records applications,
//     representative status, tier assignment and NON-financial purchase markers.
//     Settled Payments / paid Orders are authoritative and are never cancelled
//     here (suspend/terminate change future eligibility only).
//   * PRIVACY (§24) — audit logs carry relational IDs (columns) + status codes +
//     coarse value buckets ONLY. Applicant free-text (explanation/reason/phone/
//     city) is stored in its table column but NEVER written to a log.
// =============================================================================

type Ok<T> = { ok: true } & T;
type Err = { ok: false; code: RepresentativeErrorCode };

function err(code: RepresentativeErrorCode): Err {
  return { ok: false, code };
}

// --- application submission (§9, §25) ----------------------------------------

/** Validated applicant profile (re-validated defensively against the shared
 * contract; the handler validates first for UX). Phone is the normalized
 * 09XXXXXXXXX form. */
export interface RepresentativeApplicationInput {
  fullName: string;
  phone: string;
  province: string;
  city: string;
  salesChannel: string;
  expectedMonthlyCustomers: number;
  experience: string | null;
  explanation: string;
}

export type SubmitApplicationResult =
  | Ok<{ application: RepresentativeApplication; replayed: boolean }>
  | Err;

/** Defensive server-side validation mirroring the shared contract. */
function validateApplicationInput(input: RepresentativeApplicationInput): boolean {
  return (
    isValidRepFullName(input.fullName) &&
    normalizeIranMobile(input.phone) === input.phone &&
    isValidRepLocation(input.province) &&
    isValidRepLocation(input.city) &&
    isRepresentativeSalesChannel(input.salesChannel) &&
    Number.isInteger(input.expectedMonthlyCustomers) &&
    parseExpectedMonthlyCustomers(String(input.expectedMonthlyCustomers)) ===
      input.expectedMonthlyCustomers &&
    isValidRepExperience(input.experience ?? "") &&
    isValidRepExplanation(input.explanation)
  );
}

/**
 * Submits a new representative application as PENDING_REVIEW. Idempotent and
 * concurrency-safe:
 *   - a repeated Telegram update (same sourceUpdateId) converges to the row it
 *     already created (replayed=true);
 *   - the DB partial unique index guarantees AT MOST ONE open application per
 *     user, so two racing submits resolve to one (the loser returns ALREADY_APPLIED);
 *   - a user who is already an ACTIVE/SUSPENDED representative cannot apply.
 * Never moves money; writes only the application row + a privacy-safe audit log.
 */
export async function submitRepresentativeApplication(args: {
  userId: string;
  sourceUpdateId: bigint | null;
  input: RepresentativeApplicationInput;
}): Promise<SubmitApplicationResult> {
  if (!validateApplicationInput(args.input)) {
    return err("VALIDATION");
  }

  // Replay convergence: a resent update that already created a row returns it.
  if (args.sourceUpdateId !== null) {
    const prior = await prisma.representativeApplication.findUnique({
      where: { sourceUpdateId: args.sourceUpdateId },
    });
    if (prior !== null) {
      return { ok: true, application: prior, replayed: true };
    }
  }

  // A user with any live Representative record (ACTIVE or SUSPENDED) is already
  // in the program; a TERMINATED one is irreversible and cannot re-apply.
  const existingRep = await prisma.representative.findUnique({
    where: { userId: args.userId },
    select: { status: true },
  });
  if (existingRep !== null) {
    return existingRep.status === "TERMINATED"
      ? err("TERMINATED")
      : err("ALREADY_REPRESENTATIVE");
  }

  try {
    const application = await prisma.representativeApplication.create({
      data: {
        userId: args.userId,
        status: "PENDING_REVIEW",
        fullName: args.input.fullName,
        phone: args.input.phone,
        province: args.input.province,
        city: args.input.city,
        salesChannel: args.input.salesChannel,
        expectedMonthlyCustomers: args.input.expectedMonthlyCustomers,
        experience: args.input.experience,
        explanation: args.input.explanation,
        submittedAt: new Date(),
        sourceUpdateId: args.sourceUpdateId,
      },
    });
    await audit("INFO", "representative.application_submitted", {
      userId: args.userId,
      metadata: {
        applicationId: application.id,
        salesChannel: args.input.salesChannel,
        expectedBucket: representativeValueBucket(args.input.expectedMonthlyCustomers),
      },
    });
    return { ok: true, application, replayed: false };
  } catch (e) {
    // P2002 on the partial-unique open guard OR the sourceUpdateId unique =
    // a concurrent submit won; converge to the existing open application.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      if (args.sourceUpdateId !== null) {
        const byUpdate = await prisma.representativeApplication.findUnique({
          where: { sourceUpdateId: args.sourceUpdateId },
        });
        if (byUpdate !== null) {
          return { ok: true, application: byUpdate, replayed: true };
        }
      }
      const open = await findOpenApplication(args.userId);
      if (open !== null) {
        return { ok: true, application: open, replayed: true };
      }
      return err("ALREADY_APPLIED");
    }
    throw e;
  }
}

/** The single open (DRAFT/PENDING_REVIEW) application of a user, or null. */
export async function findOpenApplication(
  userId: string,
): Promise<RepresentativeApplication | null> {
  return prisma.representativeApplication.findFirst({
    where: { userId, status: { in: ["DRAFT", "PENDING_REVIEW"] } },
    orderBy: { createdAt: "desc" },
  });
}

/** The most recent application of a user (any status), or null. */
export async function findLatestApplication(
  userId: string,
): Promise<RepresentativeApplication | null> {
  return prisma.representativeApplication.findFirst({
    where: { userId },
    orderBy: { createdAt: "desc" },
  });
}

export type WithdrawResult = Ok<{ application: RepresentativeApplication }> | Err;

/** Withdraws the user's own OPEN application (DRAFT/PENDING_REVIEW → WITHDRAWN).
 * Idempotent: a status-guarded update means a double tap resolves to the same
 * terminal row. Never deletes the application (§5 no hard-delete). */
export async function withdrawRepresentativeApplication(args: {
  userId: string;
  applicationId: string;
}): Promise<WithdrawResult> {
  const updated = await prisma.representativeApplication.updateMany({
    where: {
      id: args.applicationId,
      userId: args.userId,
      status: { in: ["DRAFT", "PENDING_REVIEW"] },
    },
    data: { status: "WITHDRAWN", decidedAt: new Date() },
  });
  const application = await prisma.representativeApplication.findFirst({
    where: { id: args.applicationId, userId: args.userId },
  });
  if (application === null) {
    return err("NOT_FOUND");
  }
  if (updated.count === 0 && application.status !== "WITHDRAWN") {
    // Already decided (approved/rejected) by an admin in the meantime.
    return err("INELIGIBLE_STATUS");
  }
  return { ok: true, application };
}

// --- application review: approve / reject (§12, §13) -------------------------

export type ApproveResult =
  | Ok<{ representative: Representative; alreadyRepresentative: boolean }>
  | Err;

/**
 * OWNER-only approval. Transactional and convergent: sets the application
 * APPROVED and creates exactly ONE ACTIVE Representative for the applicant
 * (Representative.userId is unique, so a concurrent double-approve resolves to
 * the same row). An optional tier may be assigned at approval time. Never moves
 * money and never provisions anything.
 */
export async function approveRepresentativeApplication(args: {
  applicationId: string;
  adminId: string;
  tierId?: string | null;
}): Promise<ApproveResult> {
  const application = await prisma.representativeApplication.findUnique({
    where: { id: args.applicationId },
    select: { id: true, userId: true, status: true },
  });
  if (application === null) {
    return err("NOT_FOUND");
  }

  // Validate the requested tier (must exist + be active) BEFORE the transaction.
  let tierId: string | null = null;
  if (args.tierId != null) {
    const tier = await prisma.representativeTier.findUnique({
      where: { id: args.tierId },
      select: { id: true, isActive: true },
    });
    if (tier === null) {
      return err("NOT_FOUND");
    }
    if (!tier.isActive) {
      return err("TIER_INACTIVE");
    }
    tierId = tier.id;
  }

  try {
    const outcome = await prisma.$transaction(async (tx): Promise<ApproveResult> => {
      // Converge on an existing Representative for this user (unique userId).
      const existing = await tx.representative.findUnique({
        where: { userId: application.userId },
      });
      if (existing !== null) {
        if (existing.status === "TERMINATED") {
          return err("TERMINATED");
        }
        // Already a representative (this or another application) → idempotent.
        // Make sure THIS application is marked resolved so the queue converges.
        if (application.status !== "APPROVED") {
          await tx.representativeApplication.updateMany({
            where: { id: application.id, status: { in: ["DRAFT", "PENDING_REVIEW"] } },
            data: { status: "APPROVED", decidedAt: new Date(), reviewedByAdminId: args.adminId },
          });
        }
        return { ok: true, representative: existing, alreadyRepresentative: true };
      }

      // Claim the application (only an OPEN one can be approved).
      const claimed = await tx.representativeApplication.updateMany({
        where: { id: application.id, status: { in: ["DRAFT", "PENDING_REVIEW"] } },
        data: {
          status: "APPROVED",
          decidedAt: new Date(),
          reviewedByAdminId: args.adminId,
        },
      });
      if (claimed.count === 0) {
        return err("INELIGIBLE_STATUS");
      }

      const representative = await tx.representative.create({
        data: {
          userId: application.userId,
          approvedApplicationId: application.id,
          status: "ACTIVE",
          tierId,
          checkoutEnabled: true,
          approvedByAdminId: args.adminId,
          approvedAt: new Date(),
        },
      });
      return { ok: true, representative, alreadyRepresentative: false };
    });

    if (outcome.ok) {
      await audit("INFO", "representative.approved", {
        userId: outcome.representative.userId,
        adminId: args.adminId,
        metadata: {
          applicationId: application.id,
          representativeId: outcome.representative.id,
          tierId: outcome.representative.tierId,
          converged: outcome.alreadyRepresentative,
        },
      });
    }
    return outcome;
  } catch (e) {
    // A concurrent approve created the Representative first → converge.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const existing = await prisma.representative.findUnique({
        where: { userId: application.userId },
      });
      if (existing !== null) {
        return { ok: true, representative: existing, alreadyRepresentative: true };
      }
    }
    throw e;
  }
}

export type RejectResult = Ok<{ application: RepresentativeApplication }> | Err;

/** OWNER-only rejection with a MANDATORY user-facing reason (§13). The reason is
 * stored (shown to the applicant), never logged (§24). Status-guarded so only an
 * OPEN application is rejected; idempotent under a double tap. */
export async function rejectRepresentativeApplication(args: {
  applicationId: string;
  adminId: string;
  reason: string;
}): Promise<RejectResult> {
  if (!isValidRepReason(args.reason)) {
    return err("VALIDATION");
  }
  const application = await prisma.representativeApplication.findUnique({
    where: { id: args.applicationId },
    select: { id: true, userId: true, status: true },
  });
  if (application === null) {
    return err("NOT_FOUND");
  }
  const updated = await prisma.representativeApplication.updateMany({
    where: { id: application.id, status: { in: ["DRAFT", "PENDING_REVIEW"] } },
    data: {
      status: "REJECTED",
      decisionReason: args.reason,
      decidedAt: new Date(),
      reviewedByAdminId: args.adminId,
    },
  });
  if (updated.count === 0) {
    return err("INELIGIBLE_STATUS");
  }
  await audit("INFO", "representative.rejected", {
    userId: application.userId,
    adminId: args.adminId,
    metadata: { applicationId: application.id },
  });
  const fresh = await prisma.representativeApplication.findUniqueOrThrow({
    where: { id: application.id },
  });
  return { ok: true, application: fresh };
}

// --- representative lifecycle (§20) ------------------------------------------

export type LifecycleResult = Ok<{ representative: Representative }> | Err;

/** ACTIVE → SUSPENDED. Reseller pricing stops for NEW checkouts; settled
 * Payments / paid Orders are untouched (§16). Status-guarded + idempotent. */
export async function suspendRepresentative(args: {
  representativeId: string;
  adminId: string;
  reason: string | null;
}): Promise<LifecycleResult> {
  return transition({
    representativeId: args.representativeId,
    adminId: args.adminId,
    from: ["ACTIVE"],
    to: "SUSPENDED",
    reason: args.reason,
    stamp: { suspendedByAdminId: args.adminId, suspendedAt: new Date() },
    event: "representative.suspended",
  });
}

/** SUSPENDED → ACTIVE. */
export async function reactivateRepresentative(args: {
  representativeId: string;
  adminId: string;
}): Promise<LifecycleResult> {
  return transition({
    representativeId: args.representativeId,
    adminId: args.adminId,
    from: ["SUSPENDED"],
    to: "ACTIVE",
    reason: null,
    stamp: { approvedByAdminId: args.adminId },
    event: "representative.reactivated",
  });
}

/** ACTIVE/SUSPENDED → TERMINATED. IRREVERSIBLE (§20); history is retained. The
 * handler double-confirms. Settled Payments / paid Orders remain valid. */
export async function terminateRepresentative(args: {
  representativeId: string;
  adminId: string;
  reason: string | null;
}): Promise<LifecycleResult> {
  return transition({
    representativeId: args.representativeId,
    adminId: args.adminId,
    from: ["ACTIVE", "SUSPENDED"],
    to: "TERMINATED",
    reason: args.reason,
    stamp: { terminatedByAdminId: args.adminId, terminatedAt: new Date() },
    event: "representative.terminated",
  });
}

async function transition(args: {
  representativeId: string;
  adminId: string;
  from: Array<"ACTIVE" | "SUSPENDED" | "TERMINATED">;
  to: "ACTIVE" | "SUSPENDED" | "TERMINATED";
  reason: string | null;
  stamp: Prisma.RepresentativeUpdateManyMutationInput;
  event: string;
}): Promise<LifecycleResult> {
  const rep = await prisma.representative.findUnique({
    where: { id: args.representativeId },
    select: { id: true, userId: true, status: true },
  });
  if (rep === null) {
    return err("NOT_FOUND");
  }
  if (rep.status === args.to) {
    const same = await prisma.representative.findUniqueOrThrow({ where: { id: rep.id } });
    return { ok: true, representative: same };
  }
  const updated = await prisma.representative.updateMany({
    where: { id: rep.id, status: { in: args.from } },
    data: { ...args.stamp, ...(args.reason !== null ? { statusReason: args.reason } : {}) },
  });
  if (updated.count === 0) {
    return err("INELIGIBLE_STATUS");
  }
  await audit("INFO", args.event, {
    userId: rep.userId,
    adminId: args.adminId,
    metadata: { representativeId: rep.id, to: args.to },
  });
  const fresh = await prisma.representative.findUniqueOrThrow({ where: { id: rep.id } });
  return { ok: true, representative: fresh };
}

/** Assigns (or clears) the representative's pricing tier. A cleared/absent tier
 * means retail pricing. The target tier must be active. */
export async function assignRepresentativeTier(args: {
  representativeId: string;
  adminId: string;
  tierId: string | null;
}): Promise<LifecycleResult> {
  const rep = await prisma.representative.findUnique({
    where: { id: args.representativeId },
    select: { id: true, userId: true, status: true },
  });
  if (rep === null) {
    return err("NOT_FOUND");
  }
  if (rep.status === "TERMINATED") {
    return err("TERMINATED");
  }
  if (args.tierId !== null) {
    const tier = await prisma.representativeTier.findUnique({
      where: { id: args.tierId },
      select: { isActive: true },
    });
    if (tier === null) {
      return err("NOT_FOUND");
    }
    if (!tier.isActive) {
      return err("TIER_INACTIVE");
    }
  }
  const updated = await prisma.representative.update({
    where: { id: rep.id },
    data: { tierId: args.tierId },
  });
  await audit("INFO", "representative.tier_assigned", {
    userId: rep.userId,
    adminId: args.adminId,
    metadata: { representativeId: rep.id, tierId: args.tierId },
  });
  return { ok: true, representative: updated };
}

/** Toggles the per-representative reseller-checkout permission (§13). Independent
 * of the global switch; never cancels a settled Payment/paid Order. */
export async function setRepresentativeCheckoutEnabled(args: {
  representativeId: string;
  adminId: string;
  enabled: boolean;
}): Promise<LifecycleResult> {
  const rep = await prisma.representative.findUnique({
    where: { id: args.representativeId },
    select: { id: true, userId: true, status: true },
  });
  if (rep === null) {
    return err("NOT_FOUND");
  }
  if (rep.status === "TERMINATED") {
    return err("TERMINATED");
  }
  const updated = await prisma.representative.update({
    where: { id: rep.id },
    data: { checkoutEnabled: args.enabled },
  });
  await audit("INFO", "representative.checkout_permission_changed", {
    userId: rep.userId,
    adminId: args.adminId,
    metadata: { representativeId: rep.id, enabled: args.enabled },
  });
  return { ok: true, representative: updated };
}

// --- purchase linkage (§16, §25) ---------------------------------------------

export type RepresentativeWithTier = Representative & { tier: RepresentativeTier | null };

/** Loads the user's Representative (with its tier), or null. */
export async function getRepresentativeByUserId(
  userId: string,
): Promise<RepresentativeWithTier | null> {
  return prisma.representative.findUnique({
    where: { userId },
    include: { tier: true },
  });
}

/** Loads a Representative (with its tier) by id, or null. */
export async function getRepresentativeById(
  representativeId: string,
): Promise<RepresentativeWithTier | null> {
  return prisma.representative.findUnique({
    where: { id: representativeId },
    include: { tier: true },
  });
}

/**
 * Records the NON-financial RepresentativePurchase marker for a reseller-priced
 * checkout, keyed by the (unique) checkoutSessionId — one marker per checkout
 * (§25). Accepts an optional transaction client so it can be created atomically
 * with the checkout/settlement. A P2002 (marker already exists for this
 * checkout) converges to the existing row. Requires a REPRESENTATIVE-priced
 * result; a RETAIL result is a programming error and throws.
 */
export async function recordRepresentativePurchase(
  client: Prisma.TransactionClient | typeof prisma,
  args: {
    checkoutSessionId: string;
    userId: string;
    productId: string;
    price: Extract<EffectiveProductPrice, { pricingMode: typeof REPRESENTATIVE_PRICING_MODE }>;
    status?: "PENDING" | "COMPLETED";
    paymentId?: string | null;
    orderId?: string | null;
  },
): Promise<void> {
  const { price } = args;
  try {
    await client.representativePurchase.create({
      data: {
        representativeId: price.representativeId,
        userId: args.userId,
        tierId: price.tierId,
        productId: args.productId,
        checkoutSessionId: args.checkoutSessionId,
        paymentId: args.paymentId ?? null,
        orderId: args.orderId ?? null,
        status: args.status ?? "PENDING",
        pricingMode: REPRESENTATIVE_PRICING_MODE,
        priceMode: price.priceMode,
        retailPriceToman: price.retailPriceToman,
        basePriceToman: price.basePriceToman,
        discountAmountToman: price.discountAmountToman,
        finalPriceToman: price.finalPriceToman,
        tierFingerprint: price.tierFingerprint,
        priceFingerprint: price.priceFingerprint,
        ...(args.status === "COMPLETED" ? { completedAt: new Date() } : {}),
      },
    });
  } catch (e) {
    // Converge on the unique checkoutSessionId — the marker already exists.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return;
    }
    throw e;
  }
}

/**
 * Fulfillment hook (§16): links + completes the RepresentativePurchase for a
 * paid order. Idempotent via a status/CAS guard so a re-fired dispatch never
 * double-completes. Never throws for a business reason; safe to call for every
 * paid order (a non-representative order simply matches nothing). A later
 * suspension NEVER un-completes a settled purchase.
 */
export async function completeRepresentativePurchaseForOrder(orderId: string): Promise<void> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, checkoutSessionId: true, paymentId: true },
    });
    if (order === null || order.checkoutSessionId === null) {
      return;
    }
    const marker = await prisma.representativePurchase.findUnique({
      where: { checkoutSessionId: order.checkoutSessionId },
      select: { id: true, status: true },
    });
    if (marker === null) {
      return;
    }
    await prisma.representativePurchase.updateMany({
      where: { id: marker.id, status: { in: ["PENDING"] } },
      data: {
        status: "COMPLETED",
        orderId: order.id,
        paymentId: order.paymentId,
        completedAt: new Date(),
      },
    });
  } catch (e) {
    logger.warn("representative purchase completion skipped", {
      orderShort: representativeShortId(orderId),
      error: errorMessage(e),
    });
  }
}

// --- dashboard stats (§14) ---------------------------------------------------

export interface RepresentativeDashboardStats {
  representative: RepresentativeWithTier | null;
  openApplication: RepresentativeApplication | null;
  latestApplication: RepresentativeApplication | null;
  completedPurchaseCount: number;
  totalFinalPaidToman: number;
  totalSavedToman: number;
}

/** Aggregates the user's representative dashboard figures. Read-only. Savings =
 * Σ(retail − final) over COMPLETED reseller purchases. */
export async function getRepresentativeDashboardStats(
  userId: string,
): Promise<RepresentativeDashboardStats> {
  const [representative, openApplication, latestApplication, completed] = await Promise.all([
    getRepresentativeByUserId(userId),
    findOpenApplication(userId),
    findLatestApplication(userId),
    prisma.representativePurchase.findMany({
      where: { userId, status: "COMPLETED" },
      select: { retailPriceToman: true, finalPriceToman: true },
    }),
  ]);
  let totalFinalPaidToman = 0;
  let totalSavedToman = 0;
  for (const row of completed) {
    totalFinalPaidToman += row.finalPriceToman;
    totalSavedToman += Math.max(0, row.retailPriceToman - row.finalPriceToman);
  }
  return {
    representative,
    openApplication,
    latestApplication,
    completedPurchaseCount: completed.length,
    totalFinalPaidToman,
    totalSavedToman,
  };
}

/** Recent COMPLETED reseller purchases for the "خریدهای من" list. */
export async function listRepresentativePurchases(userId: string, take = 10) {
  return prisma.representativePurchase.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take,
    select: {
      id: true,
      status: true,
      productId: true,
      retailPriceToman: true,
      finalPriceToman: true,
      createdAt: true,
      completedAt: true,
    },
  });
}

// --- privacy-safe audit (§24) ------------------------------------------------

async function audit(
  level: "INFO" | "WARN" | "ERROR",
  eventType: string,
  args: {
    userId?: string;
    adminId?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await writeSystemLog({
    level,
    eventType,
    message: eventType,
    userId: args.userId,
    adminId: args.adminId,
    metadata: args.metadata,
  });
}
