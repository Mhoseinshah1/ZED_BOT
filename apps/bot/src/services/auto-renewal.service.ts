import {
  AutoRenewalAttemptStatus,
  AutoRenewalMandateStatus,
  AutoRenewalPauseReason,
  PanelStatus,
  Prisma,
  prisma,
  type Service,
  type ServiceAutoRenewalAttempt,
  type ServiceAutoRenewalMandate,
  type User,
} from "@zedbot/database";
import {
  AUTO_RENEWAL_MIN_CHARGE_LEAD_MINUTES,
  AUTO_RENEWAL_MAX_CHARGE_LEAD_MINUTES,
  AUTO_RENEWAL_MIN_MAX_ATTEMPTS,
  AUTO_RENEWAL_MAX_MAX_ATTEMPTS,
  buildAutoRenewalCycleFingerprint,
  clampInt,
  DEFAULT_WALLET_AUTO_RENEWAL_CONFIG,
  errorMessage,
  isValidCeiling,
  parseRetryIntervals,
  resolveAutoRenewalCharge,
  WALLET_AUTO_RENEWAL_CONSENT_VERSION_KEY,
  WALLET_AUTO_RENEWAL_DEFAULT_CHARGE_LEAD_MINUTES_KEY,
  WALLET_AUTO_RENEWAL_ENABLED_KEY,
  WALLET_AUTO_RENEWAL_INSUFFICIENT_RETRY_INTERVALS_KEY,
  WALLET_AUTO_RENEWAL_MAX_ATTEMPTS_PER_CYCLE_KEY,
} from "@zedbot/shared";

import { logger } from "../core/logger.js";
import type { DeliverySendApi } from "./other-product-delivery.service.js";
import {
  dispatchPaidOrderFulfillment,
  type DispatchResult,
} from "./order-fulfillment.service.js";
import { isWalletPaymentEnabled } from "./payment-settings.service.js";
import type { ProductWithRelations } from "./product.service.js";
import { isRenewalPlanValid } from "./renewal-checkout.service.js";
import { getBooleanSetting, getSetting } from "./settings.service.js";
import { payAutoRenewalWithWallet } from "./wallet-payment.service.js";

// =============================================================================
// Wallet auto-renewal — bot-side mandate lifecycle + EXECUTE engine (Phase 1).
//
// CONSENT is the ONLY door to a mandate: createMandate is the single writer and
// requires an explicit, versioned, ceiling-bounded, owner-scoped confirmation.
// There is no admin/migration/seed/default path that ENABLES renewal — admins
// may only pause or cancel (never raise the authorization). Mandates are
// disabled-by-default at the system level (the master switch).
//
// The EXECUTE engine runs in the bot process (co-located with the fulfillment
// dispatcher). The worker owns discovery: it creates ONE durable attempt per
// expiry cycle and enqueues an EXECUTE job. Here we, under a CAS claim:
//   * re-validate the mandate is ACTIVE, the Service cycle is unchanged (a
//     manual renewal moves the expiry → the attempt is cancelled, never a
//     double charge), the plan/price/panel still qualify, and the ceiling holds;
//   * charge the wallet through the SAME atomic settlement used by manual
//     renewals (never above the ceiling, never a negative balance, idempotent
//     on the mandate+cycle key);
//   * fulfil through the SAME dispatcher / renewal executor (in-place renewal,
//     existing refund on definite failure, existing reconciliation on an
//     uncertain panel outcome — we NEVER refund here ourselves);
//   * record the attempt outcome and update the mandate.
//
// A Telegram send failure NEVER rolls back a completed renewal — every notice
// is best-effort (sendSafe). No secrets are logged; jobs carry only ids.
// =============================================================================

const CONSENT_VERSION_FALLBACK = DEFAULT_WALLET_AUTO_RENEWAL_CONFIG.consentVersion;

/** Threshold of consecutive fulfilment failures before a mandate is paused. */
const FULFILLMENT_FAILURE_PAUSE_THRESHOLD = 1;

// --- notification texts ------------------------------------------------------

export const AUTO_RENEWAL_CHARGING_TEXT =
  "سرویس شما هم‌اکنون به‌صورت خودکار از کیف پول تمدید می‌شود… 🔁";

export const AUTO_RENEWAL_INSUFFICIENT_RETRY_TEXT =
  "تمدید خودکار سرویس شما به دلیل کافی‌نبودن موجودی کیف پول انجام نشد.\n" +
  "لطفاً کیف پول خود را شارژ کنید؛ تلاش دوباره به‌صورت خودکار انجام خواهد شد.";

export const AUTO_RENEWAL_INSUFFICIENT_PAUSED_TEXT =
  "تمدید خودکار سرویس شما به دلیل کافی‌نبودن موجودی کیف پول متوقف شد.\n" +
  "پس از شارژ کیف پول می‌توانید تمدید خودکار را دوباره فعال کنید.";

export const AUTO_RENEWAL_PRICE_ABOVE_LIMIT_TEXT =
  "قیمت فعلی تمدید از سقف مجاز شما بیشتر شده است؛ تمدید خودکار متوقف شد.\n" +
  "برای ادامه، تمدید خودکار را با سقف جدید دوباره فعال کنید.";

export const AUTO_RENEWAL_PLAN_UNAVAILABLE_TEXT =
  "طرح تمدید انتخابی شما دیگر در دسترس نیست؛ تمدید خودکار متوقف شد.\n" +
  "برای ادامه، تمدید خودکار را با یک طرح معتبر دوباره فعال کنید.";

export const AUTO_RENEWAL_REQUIRES_ACTION_TEXT =
  "وضعیت تمدید خودکار سرویس شما نامشخص است و در حال بررسی خودکار می‌باشد.\n" +
  "در صورت نیاز، نتیجه به شما اطلاع داده خواهد شد.";

// --- config (bot side) -------------------------------------------------------

/** The current consent version (a bump requires fresh consent to keep renewing). */
export async function getConsentVersion(): Promise<number> {
  const raw = await getSetting(WALLET_AUTO_RENEWAL_CONSENT_VERSION_KEY, "");
  const parsed = Number.parseInt(raw, 10);
  return clampInt(parsed, 1, 1_000_000, CONSENT_VERSION_FALLBACK);
}

/** Default charge-lead minutes for a new mandate (bounded/clamped). */
export async function getDefaultChargeLeadMinutes(): Promise<number> {
  const raw = await getSetting(WALLET_AUTO_RENEWAL_DEFAULT_CHARGE_LEAD_MINUTES_KEY, "");
  const parsed = Number.parseInt(raw, 10);
  return clampInt(
    parsed,
    AUTO_RENEWAL_MIN_CHARGE_LEAD_MINUTES,
    AUTO_RENEWAL_MAX_CHARGE_LEAD_MINUTES,
    DEFAULT_WALLET_AUTO_RENEWAL_CONFIG.defaultChargeLeadMinutes,
  );
}

async function getMaxAttemptsPerCycle(): Promise<number> {
  const raw = await getSetting(WALLET_AUTO_RENEWAL_MAX_ATTEMPTS_PER_CYCLE_KEY, "");
  const parsed = Number.parseInt(raw, 10);
  return clampInt(
    parsed,
    AUTO_RENEWAL_MIN_MAX_ATTEMPTS,
    AUTO_RENEWAL_MAX_MAX_ATTEMPTS,
    DEFAULT_WALLET_AUTO_RENEWAL_CONFIG.maxAttemptsPerCycle,
  );
}

async function getRetryIntervals(): Promise<number[]> {
  const raw = await getSetting(WALLET_AUTO_RENEWAL_INSUFFICIENT_RETRY_INTERVALS_KEY, "");
  return parseRetryIntervals(
    raw === "" ? undefined : raw,
    DEFAULT_WALLET_AUTO_RENEWAL_CONFIG.insufficientRetryIntervalsMinutes,
  );
}

/** Master switch — the whole system is dormant until an operator enables it. */
export async function isWalletAutoRenewalEnabled(): Promise<boolean> {
  return getBooleanSetting(WALLET_AUTO_RENEWAL_ENABLED_KEY, false);
}

// --- helpers -----------------------------------------------------------------

/** Best-effort Telegram send; a delivery failure never affects a renewal. */
async function sendSafe(api: DeliverySendApi, chatId: string, text: string): Promise<void> {
  try {
    await api.sendMessage(chatId, text);
  } catch (err) {
    logger.warn("auto-renewal notice failed", { error: errorMessage(err) });
  }
}

/** Loads the mandate's live Service, owner-scoped, not deleted, finite expiry. */
async function loadEligibleService(mandate: ServiceAutoRenewalMandate): Promise<Service | null> {
  const service = await prisma.service.findUnique({ where: { id: mandate.serviceId } });
  if (
    service === null ||
    service.userId !== mandate.userId ||
    service.deletedAt !== null ||
    service.status === "DELETED" ||
    service.expiresAt === null
  ) {
    return null;
  }
  return service;
}

async function loadRenewalProduct(productId: string): Promise<ProductWithRelations | null> {
  return prisma.product.findUnique({
    where: { id: productId },
    include: { category: true, panel: true },
  });
}

// --- mandate lifecycle -------------------------------------------------------

export type CreateMandateResult =
  | { ok: true; mandate: ServiceAutoRenewalMandate }
  | { ok: false; error: string };

export const MANDATE_EXISTS_TEXT = "برای این سرویس، تمدید خودکار از قبل فعال است.";
export const MANDATE_INELIGIBLE_TEXT = "این سرویس برای تمدید خودکار واجد شرایط نیست.";
export const MANDATE_PLAN_INVALID_TEXT = "طرح تمدید انتخابی معتبر نیست.";
export const MANDATE_CEILING_INVALID_TEXT = "سقف مبلغ واردشده معتبر نیست.";
export const MANDATE_SYSTEM_DISABLED_TEXT = "تمدید خودکار در حال حاضر غیرفعال است.";

export interface CreateMandateInput {
  service: Service;
  product: ProductWithRelations;
  /** The user-approved wallet-charge ceiling (Toman). */
  maximumChargeToman: number;
}

/**
 * The SINGLE writer of a mandate. Requires the caller to have run the explicit
 * versioned-consent confirmation. Re-validates eligibility, the plan and the
 * ceiling against live state — nothing from a stale keyboard is trusted — and
 * stores the consented price + version + timestamp. The serviceId @unique
 * guarantees one mandate per Service; a second consent for a service that
 * already has a mandate returns MANDATE_EXISTS_TEXT.
 */
export async function createMandate(
  user: User,
  input: CreateMandateInput,
): Promise<CreateMandateResult> {
  if (!(await isWalletAutoRenewalEnabled())) {
    return { ok: false, error: MANDATE_SYSTEM_DISABLED_TEXT };
  }
  const { service, product } = input;
  if (
    service.userId !== user.id ||
    service.deletedAt !== null ||
    service.status === "DELETED" ||
    service.expiresAt === null
  ) {
    return { ok: false, error: MANDATE_INELIGIBLE_TEXT };
  }
  if (!isRenewalPlanValid(product, service, user.group)) {
    return { ok: false, error: MANDATE_PLAN_INVALID_TEXT };
  }
  if (product.panel === null || product.panel.status !== PanelStatus.ACTIVE) {
    return { ok: false, error: MANDATE_PLAN_INVALID_TEXT };
  }
  if (!isValidCeiling(input.maximumChargeToman, product.priceToman)) {
    return { ok: false, error: MANDATE_CEILING_INVALID_TEXT };
  }

  const [consentVersion, chargeLeadMinutes] = await Promise.all([
    getConsentVersion(),
    getDefaultChargeLeadMinutes(),
  ]);
  const now = new Date();
  try {
    const mandate = await prisma.serviceAutoRenewalMandate.create({
      data: {
        userId: user.id,
        serviceId: service.id,
        productId: product.id,
        status: AutoRenewalMandateStatus.ACTIVE,
        maximumChargeToman: input.maximumChargeToman,
        consentedPriceToman: product.priceToman,
        chargeLeadMinutes,
        consentVersion,
        consentedAt: now,
        // Evaluate soon so the worker scan picks it up on its next pass; the
        // scan defers it to the real charge-lead boundary.
        nextEvaluationAt: now,
      },
    });
    logger.info("auto-renewal mandate created", {
      mandateId: mandate.id,
      serviceId: service.id.slice(0, 8),
      userId: user.id,
      consentVersion,
    });
    return { ok: true, mandate };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      return { ok: false, error: MANDATE_EXISTS_TEXT };
    }
    throw err;
  }
}

/** The user's mandate for one Service (owner-scoped), or null. */
export async function getMandateForService(
  userId: string,
  serviceId: string,
): Promise<ServiceAutoRenewalMandate | null> {
  const mandate = await prisma.serviceAutoRenewalMandate.findUnique({ where: { serviceId } });
  return mandate !== null && mandate.userId === userId ? mandate : null;
}

/** Owner-scoped mandate by id (my-renewals detail). */
export async function getOwnedMandate(
  mandateId: string,
  userId: string,
): Promise<ServiceAutoRenewalMandate | null> {
  const mandate = await prisma.serviceAutoRenewalMandate.findUnique({ where: { id: mandateId } });
  return mandate !== null && mandate.userId === userId ? mandate : null;
}

/** Owner-scoped mandate by uuid-prefix short id (callbacks carry short ids). */
export async function getOwnedMandateByShortId(
  shortId: string,
  userId: string,
): Promise<ServiceAutoRenewalMandate | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.serviceAutoRenewalMandate.findMany({
    where: { id: { startsWith: shortId }, userId },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

export function mandateShortId(mandate: { id: string }): string {
  return mandate.id.slice(0, 8);
}

/** Non-cancelled mandates for a user, newest first (my-renewals list). */
export async function listUserMandates(userId: string): Promise<ServiceAutoRenewalMandate[]> {
  return prisma.serviceAutoRenewalMandate.findMany({
    where: { userId, status: { not: AutoRenewalMandateStatus.CANCELLED } },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}

/**
 * User-initiated cancellation. Owner-scoped and terminal: a cancelled mandate
 * never charges again (the scan only evaluates ACTIVE mandates, and any
 * in-flight attempt is re-validated against the mandate before any charge).
 */
export async function cancelMandate(mandateId: string, userId: string): Promise<boolean> {
  const res = await prisma.serviceAutoRenewalMandate.updateMany({
    where: { id: mandateId, userId, status: { not: AutoRenewalMandateStatus.CANCELLED } },
    data: {
      status: AutoRenewalMandateStatus.CANCELLED,
      cancelledAt: new Date(),
      nextEvaluationAt: null,
    },
  });
  return res.count > 0;
}

/**
 * User-initiated pause (reversible). Distinct from cancellation: the consent
 * and ceiling are preserved so the user may resume without re-consenting (the
 * consent version is re-checked at resume).
 */
export async function pauseMandateByUser(mandateId: string, userId: string): Promise<boolean> {
  const res = await prisma.serviceAutoRenewalMandate.updateMany({
    where: { id: mandateId, userId, status: AutoRenewalMandateStatus.ACTIVE },
    data: {
      status: AutoRenewalMandateStatus.PAUSED,
      pauseReason: AutoRenewalPauseReason.USER_PAUSED,
      pausedAt: new Date(),
      nextEvaluationAt: null,
    },
  });
  return res.count > 0;
}

/**
 * Resume a paused mandate. Re-checks that the stored consent is still current
 * (a consent-version bump forces re-consent) and that the plan/ceiling still
 * hold against live state — resume can never bypass consent or a raised price.
 */
export type ResumeMandateResult = { ok: true } | { ok: false; error: string };

export async function resumeMandateByUser(
  mandateId: string,
  user: User,
): Promise<ResumeMandateResult> {
  const mandate = await getOwnedMandate(mandateId, user.id);
  if (mandate === null || mandate.status !== AutoRenewalMandateStatus.PAUSED) {
    return { ok: false, error: MANDATE_INELIGIBLE_TEXT };
  }
  if (!(await isWalletAutoRenewalEnabled())) {
    return { ok: false, error: MANDATE_SYSTEM_DISABLED_TEXT };
  }
  const consentVersion = await getConsentVersion();
  if (mandate.consentVersion !== consentVersion) {
    // The consent contract changed — the user must re-consent (re-create).
    return { ok: false, error: "برای ادامه، لطفاً تمدید خودکار را دوباره فعال کنید." };
  }
  const service = await loadEligibleService(mandate);
  if (service === null) {
    return { ok: false, error: MANDATE_INELIGIBLE_TEXT };
  }
  const product = await loadRenewalProduct(mandate.productId);
  if (
    product === null ||
    !isRenewalPlanValid(product, service, user.group) ||
    !isValidCeiling(mandate.maximumChargeToman, product.priceToman)
  ) {
    return { ok: false, error: MANDATE_PLAN_INVALID_TEXT };
  }
  const res = await prisma.serviceAutoRenewalMandate.updateMany({
    where: { id: mandateId, userId: user.id, status: AutoRenewalMandateStatus.PAUSED },
    data: {
      status: AutoRenewalMandateStatus.ACTIVE,
      pauseReason: null,
      pausedAt: null,
      safeLastErrorCode: null,
      consecutiveFailureCount: 0,
      nextEvaluationAt: new Date(),
    },
  });
  return res.count > 0 ? { ok: true } : { ok: false, error: MANDATE_INELIGIBLE_TEXT };
}

/**
 * Admin-initiated pause / cancel. An admin may STOP a mandate but can NEVER
 * enable one or raise its authorization (there is no admin create/resume/
 * ceiling-increase path anywhere). `cancel` is terminal; otherwise it pauses.
 */
export async function adminStopMandate(
  mandateId: string,
  cancel: boolean,
): Promise<boolean> {
  const now = new Date();
  const res = await prisma.serviceAutoRenewalMandate.updateMany({
    where: {
      id: mandateId,
      status: cancel ? { not: AutoRenewalMandateStatus.CANCELLED } : AutoRenewalMandateStatus.ACTIVE,
    },
    data: cancel
      ? {
          status: AutoRenewalMandateStatus.CANCELLED,
          cancelledAt: now,
          nextEvaluationAt: null,
        }
      : {
          status: AutoRenewalMandateStatus.PAUSED,
          pauseReason: AutoRenewalPauseReason.ADMIN_PAUSED,
          pausedAt: now,
          nextEvaluationAt: null,
        },
  });
  return res.count > 0;
}

// --- execute engine ----------------------------------------------------------

async function pauseMandateForAttempt(
  mandateId: string,
  reason: AutoRenewalPauseReason,
  safeErrorCode: string,
): Promise<void> {
  await prisma.serviceAutoRenewalMandate.updateMany({
    where: { id: mandateId, status: AutoRenewalMandateStatus.ACTIVE },
    data: {
      status: AutoRenewalMandateStatus.PAUSED,
      pauseReason: reason,
      pausedAt: new Date(),
      safeLastErrorCode: safeErrorCode,
      lastAttemptAt: new Date(),
      lastEvaluatedAt: new Date(),
    },
  });
}

async function transitionAttempt(
  attemptId: string,
  status: AutoRenewalAttemptStatus,
  data: Prisma.ServiceAutoRenewalAttemptUpdateManyMutationInput = {},
): Promise<void> {
  await prisma.serviceAutoRenewalAttempt.updateMany({
    where: { id: attemptId },
    data: { status, ...data },
  });
}

export interface ExecuteAttemptResult {
  status: string;
}

/**
 * Executes ONE auto-renewal attempt end-to-end. Safe to call repeatedly and
 * across worker restarts (every money move is idempotent on the mandate+cycle
 * key). Never throws to the queue — a crash returns a status the caller logs.
 */
export async function executeAutoRenewalAttempt(
  api: DeliverySendApi,
  attemptId: string,
  now: Date = new Date(),
): Promise<ExecuteAttemptResult> {
  const attempt = await prisma.serviceAutoRenewalAttempt.findUnique({ where: { id: attemptId } });
  if (attempt === null) {
    return { status: "not-found" };
  }
  // Idempotent: only a SCHEDULED attempt is claimable; anything else has
  // already been handled (terminal) or is being handled (claimed elsewhere).
  if (attempt.status !== AutoRenewalAttemptStatus.SCHEDULED) {
    return { status: `already-${attempt.status.toLowerCase()}` };
  }
  // Not-due guard: a bounded retry sets a future nextAttemptAt; an early
  // reconcile re-arm must not consume an attempt before its interval elapses.
  if (attempt.nextAttemptAt !== null && attempt.nextAttemptAt.getTime() > now.getTime()) {
    return { status: "not-due" };
  }
  // Master switch: while disabled, leave the attempt SCHEDULED (dormant).
  if (!(await isWalletAutoRenewalEnabled())) {
    return { status: "system-disabled" };
  }

  // CAS claim: exactly one caller wins SCHEDULED -> CLAIMED.
  const claim = await prisma.serviceAutoRenewalAttempt.updateMany({
    where: { id: attemptId, status: AutoRenewalAttemptStatus.SCHEDULED },
    data: { status: AutoRenewalAttemptStatus.CLAIMED, claimedAt: now },
  });
  if (claim.count === 0) {
    return { status: "claim-lost" };
  }

  try {
    return await runClaimedAttempt(api, attempt, now);
  } catch (err) {
    logger.error("auto-renewal execute crashed", {
      attemptId: attemptId.slice(0, 8),
      error: errorMessage(err),
    });
    // Leave the attempt CLAIMED; the worker reconcile re-arms it (idempotent).
    return { status: "error" };
  }
}

async function runClaimedAttempt(
  api: DeliverySendApi,
  attempt: ServiceAutoRenewalAttempt,
  now: Date,
): Promise<ExecuteAttemptResult> {
  const mandate = await prisma.serviceAutoRenewalMandate.findUnique({
    where: { id: attempt.mandateId },
  });
  if (mandate === null || mandate.status !== AutoRenewalMandateStatus.ACTIVE) {
    await transitionAttempt(attempt.id, AutoRenewalAttemptStatus.CANCELLED, {
      cancelledAt: now,
      safeErrorCode: "mandate-inactive",
    });
    return { status: "mandate-inactive" };
  }

  const user = await prisma.user.findUnique({ where: { id: mandate.userId } });
  const service = await loadEligibleService(mandate);
  if (user === null || service === null) {
    await pauseMandateForAttempt(
      mandate.id,
      AutoRenewalPauseReason.SERVICE_INELIGIBLE,
      "service-ineligible",
    );
    await transitionAttempt(attempt.id, AutoRenewalAttemptStatus.CANCELLED, {
      cancelledAt: now,
      safeErrorCode: "service-ineligible",
    });
    return { status: "service-ineligible" };
  }

  // Manual+auto race safety: the cycle fingerprint must still match the live
  // Service. A manual renewal (or any expiry change) moves the fingerprint →
  // this attempt is stale and is cancelled WITHOUT a charge.
  const liveFingerprint = buildAutoRenewalCycleFingerprint({
    serviceId: service.id,
    expiresAtEpoch: service.expiresAt?.getTime() ?? null,
    productId: mandate.productId,
  });
  if (liveFingerprint !== attempt.expiryCycleFingerprint) {
    await transitionAttempt(attempt.id, AutoRenewalAttemptStatus.CANCELLED, {
      cancelledAt: now,
      safeErrorCode: "cycle-changed",
    });
    // Re-arm the mandate so a fresh (valid) cycle is evaluated next scan.
    await prisma.serviceAutoRenewalMandate.updateMany({
      where: { id: mandate.id, status: AutoRenewalMandateStatus.ACTIVE },
      data: { lastEvaluatedAt: now, nextEvaluationAt: now },
    });
    return { status: "cycle-changed" };
  }

  const product = await loadRenewalProduct(mandate.productId);
  if (
    product === null ||
    !isRenewalPlanValid(product, service, user.group) ||
    product.panel === null ||
    product.panel.status !== PanelStatus.ACTIVE
  ) {
    await pauseMandateForAttempt(
      mandate.id,
      product?.panel?.status !== undefined && product.panel.status !== PanelStatus.ACTIVE
        ? AutoRenewalPauseReason.PANEL_UNAVAILABLE
        : AutoRenewalPauseReason.PRODUCT_UNAVAILABLE,
      "plan-unavailable",
    );
    await transitionAttempt(attempt.id, AutoRenewalAttemptStatus.FAILED, {
      failedAt: now,
      safeErrorCode: "plan-unavailable",
    });
    await sendSafe(api, user.telegramId.toString(), AUTO_RENEWAL_PLAN_UNAVAILABLE_TEXT);
    return { status: "plan-unavailable" };
  }

  // Ceiling re-check before the charge (defense in depth; also enforced inside
  // the wallet settlement).
  const preCharge = resolveAutoRenewalCharge(product.priceToman, attempt.authorizedMaximumChargeToman);
  if (preCharge.reason === "price-above-limit") {
    await pauseMandateForAttempt(
      mandate.id,
      AutoRenewalPauseReason.PRICE_ABOVE_LIMIT,
      "price-above-limit",
    );
    await transitionAttempt(attempt.id, AutoRenewalAttemptStatus.FAILED, {
      failedAt: now,
      safeErrorCode: "price-above-limit",
    });
    await sendSafe(api, user.telegramId.toString(), AUTO_RENEWAL_PRICE_ABOVE_LIMIT_TEXT);
    return { status: "price-above-limit" };
  }

  // Pre-charge notice (best-effort): tell the user the renewal is happening now.
  await sendSafe(api, user.telegramId.toString(), AUTO_RENEWAL_CHARGING_TEXT);

  const outcome = await payAutoRenewalWithWallet(user, {
    product,
    service,
    authorizedMaximumChargeToman: attempt.authorizedMaximumChargeToman,
    idempotencyKey: attempt.idempotencyKey,
  });

  if (outcome.status === "price-above-limit") {
    await pauseMandateForAttempt(
      mandate.id,
      AutoRenewalPauseReason.PRICE_ABOVE_LIMIT,
      "price-above-limit",
    );
    await transitionAttempt(attempt.id, AutoRenewalAttemptStatus.FAILED, {
      failedAt: now,
      safeErrorCode: "price-above-limit",
    });
    await sendSafe(api, user.telegramId.toString(), AUTO_RENEWAL_PRICE_ABOVE_LIMIT_TEXT);
    return { status: "price-above-limit" };
  }
  if (outcome.status === "plan-invalid") {
    await pauseMandateForAttempt(
      mandate.id,
      AutoRenewalPauseReason.PRODUCT_UNAVAILABLE,
      "plan-invalid",
    );
    await transitionAttempt(attempt.id, AutoRenewalAttemptStatus.FAILED, {
      failedAt: now,
      safeErrorCode: "plan-invalid",
    });
    await sendSafe(api, user.telegramId.toString(), AUTO_RENEWAL_PLAN_UNAVAILABLE_TEXT);
    return { status: "plan-invalid" };
  }
  if (outcome.status === "wallet-disabled" || outcome.status === "error") {
    // Transient operator state / unexpected: revert the claim so a later scan
    // or reconcile re-attempts. No money moved.
    await transitionAttempt(attempt.id, AutoRenewalAttemptStatus.SCHEDULED, {
      nextAttemptAt: new Date(now.getTime() + 15 * 60_000),
      safeErrorCode: outcome.status,
    });
    return { status: outcome.status };
  }
  if (outcome.status === "insufficient-balance") {
    return handleInsufficientBalance(api, mandate, attempt, user.telegramId.toString(), now);
  }

  // settled / already-settled: the wallet is charged and the Order is PAID.
  const { order } = outcome.result;
  await transitionAttempt(attempt.id, AutoRenewalAttemptStatus.PAYMENT_CREATED, {
    paymentCreatedAt: now,
    checkoutSessionId: outcome.result.checkout.id,
    paymentId: outcome.result.payment.id,
    orderId: order.id,
  });
  await transitionAttempt(attempt.id, AutoRenewalAttemptStatus.FULFILLING);

  // Fulfil through the SAME dispatcher / renewal executor as every manual
  // renewal: in-place renewal, existing refund on definite failure, existing
  // reconciliation on an uncertain panel outcome. We NEVER refund here.
  const dispatch = await dispatchPaidOrderFulfillment(api, order.id, { source: "WALLET", user });
  return finishFulfillment(mandate, attempt.id, order.id, dispatch, user.telegramId.toString(), api, now);
}

/** Bounded insufficient-balance retry: reschedule within the cycle, or pause. */
async function handleInsufficientBalance(
  api: DeliverySendApi,
  mandate: ServiceAutoRenewalMandate,
  attempt: ServiceAutoRenewalAttempt,
  chatId: string,
  now: Date,
): Promise<ExecuteAttemptResult> {
  const [maxAttempts, intervals] = await Promise.all([
    getMaxAttemptsPerCycle(),
    getRetryIntervals(),
  ]);
  const nextNumber = attempt.attemptNumber + 1;
  const retriesAllowed = mandate.insufficientBalanceRetryEnabled;
  const nextIntervalMinutes = intervals[attempt.attemptNumber];
  const canRetry =
    retriesAllowed && nextNumber <= maxAttempts && nextIntervalMinutes !== undefined;

  if (!canRetry) {
    await pauseMandateForAttempt(
      mandate.id,
      AutoRenewalPauseReason.INSUFFICIENT_BALANCE,
      "insufficient-balance",
    );
    await transitionAttempt(attempt.id, AutoRenewalAttemptStatus.INSUFFICIENT_BALANCE, {
      failedAt: now,
      safeErrorCode: "insufficient-balance",
    });
    await sendSafe(api, chatId, AUTO_RENEWAL_INSUFFICIENT_PAUSED_TEXT);
    return { status: "insufficient-paused" };
  }

  const nextAt = new Date(now.getTime() + nextIntervalMinutes * 60_000);
  // Keep the attempt SCHEDULED (re-armed by the worker scan when the mandate's
  // nextEvaluationAt elapses); the not-due guard protects against early re-arms.
  await transitionAttempt(attempt.id, AutoRenewalAttemptStatus.SCHEDULED, {
    attemptNumber: nextNumber,
    nextAttemptAt: nextAt,
    claimedAt: null,
    safeErrorCode: "insufficient-balance",
  });
  await prisma.serviceAutoRenewalMandate.updateMany({
    where: { id: mandate.id, status: AutoRenewalMandateStatus.ACTIVE },
    data: { lastAttemptAt: now, lastEvaluatedAt: now, nextEvaluationAt: nextAt },
  });
  await sendSafe(api, chatId, AUTO_RENEWAL_INSUFFICIENT_RETRY_TEXT);
  return { status: "insufficient-retry" };
}

/** Maps the dispatcher outcome to the attempt/mandate final state. */
async function finishFulfillment(
  mandate: ServiceAutoRenewalMandate,
  attemptId: string,
  orderId: string,
  dispatch: DispatchResult,
  chatId: string,
  api: DeliverySendApi,
  now: Date,
): Promise<ExecuteAttemptResult> {
  const renewed = dispatch.kind === "SERVICE" && dispatch.op === "renew";

  if (renewed && dispatch.ok) {
    await transitionAttempt(attemptId, AutoRenewalAttemptStatus.COMPLETED, {
      completedAt: now,
      safeErrorCode: null,
    });
    await prisma.serviceAutoRenewalMandate.updateMany({
      where: { id: mandate.id },
      data: {
        lastSuccessfulAt: now,
        lastSuccessfulOrderId: orderId,
        lastAttemptAt: now,
        lastEvaluatedAt: now,
        consecutiveFailureCount: 0,
        safeLastErrorCode: null,
        // Let the next scan re-evaluate the new (extended) cycle and defer it.
        nextEvaluationAt: null,
      },
    });
    // The dispatcher already sent the standard renewal-success message.
    return { status: "completed" };
  }

  if (renewed && !dispatch.ok && dispatch.refunded) {
    // Definite failure — the wallet was refunded through the existing path.
    await transitionAttempt(attemptId, AutoRenewalAttemptStatus.FAILED, {
      failedAt: now,
      safeErrorCode: "fulfillment-failed",
    });
    const failures = mandate.consecutiveFailureCount + 1;
    if (failures >= FULFILLMENT_FAILURE_PAUSE_THRESHOLD) {
      await pauseMandateForAttempt(
        mandate.id,
        AutoRenewalPauseReason.FULFILLMENT_REVIEW,
        "fulfillment-failed",
      );
    } else {
      await prisma.serviceAutoRenewalMandate.updateMany({
        where: { id: mandate.id, status: AutoRenewalMandateStatus.ACTIVE },
        data: {
          consecutiveFailureCount: failures,
          lastAttemptAt: now,
          lastEvaluatedAt: now,
          safeLastErrorCode: "fulfillment-failed",
        },
      });
    }
    // The dispatcher already sent the refund notice.
    return { status: "fulfillment-failed-refunded" };
  }

  // Uncertain outcome (refunded=false) or an unexpected dispatch kind: the
  // Order stays PAID for the existing reconciliation to complete or refund on
  // proof. NEVER refund here. Surface for review; do not silently re-charge.
  await transitionAttempt(attemptId, AutoRenewalAttemptStatus.REQUIRES_ACTION, {
    safeErrorCode: "outcome-uncertain",
  });
  await pauseMandateForAttempt(
    mandate.id,
    AutoRenewalPauseReason.FULFILLMENT_REVIEW,
    "outcome-uncertain",
  );
  await sendSafe(api, chatId, AUTO_RENEWAL_REQUIRES_ACTION_TEXT);
  return { status: "requires-action" };
}
