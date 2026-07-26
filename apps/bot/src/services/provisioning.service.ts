import {
  OrderStatus,
  OrderType,
  prisma,
  ServiceLocation,
  ServiceStatus,
  WalletTransactionSource,
  WalletTransactionType,
  type CheckoutSession,
  type Order,
  type Panel,
  type Product,
  type Service,
  type User,
} from "@zedbot/database";
import { type CreateServiceAccountResult } from "@zedbot/panel-adapters";
import { errorMessage, referralCorrelationHash } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { escapeHtml } from "../utils/html.js";
import { hasBlockingServiceUsernameUnboundCase } from "./financial-reconciliation.service.js";
import { buildAdapterForPanel, normalizeSubscriptionBase } from "./panel-adapter-factory.js";
import { enqueueReferralReverse } from "./ops-queue.service.js";
import {
  assessPanelConfig,
  parsePanelInboundIds,
  resolveProductInboundIds,
} from "./panel-readiness.service.js";
import {
  ensureOrderNamingSnapshot,
  parseNamingSnapshot,
  type NamingConfigSnapshot,
} from "./service-naming.service.js";
import {
  acquireServiceLock,
  SERVICE_LOCK_BUSY_TEXT,
  SERVICE_LOCK_LOST_TEXT,
  SERVICE_LOCK_UNAVAILABLE_TEXT,
  serviceProvisioningLockKey,
  type ServiceLock,
} from "./service-lock.service.js";
import {
  consumeReservationForOrder,
  hasForeignActiveReservationForUsername,
  releaseReservationForFailedOrder,
} from "./service-username-selection.service.js";
import { onWalletBalanceChanged } from "./low-balance/low-balance-hook.js";

// =============================================================================
// Provisioning (Phase 9): turns a PAID SERVICE_PURCHASE Order into a panel
// account + ACTIVE Service row, or FAILs the order and refunds the user's
// wallet. Core guarantee: the user is never left charged without either a
// service or a refund.
//
// Status flow: PAID -> PROVISIONING -> COMPLETED (success)
//                                   -> FAILED + wallet refund (failure)
//
// Idempotency:
//   - a Service already existing for the order short-circuits to success
//     (and repairs the order status to COMPLETED);
//   - the PAID -> PROVISIONING claim is a compare-and-set, so concurrent
//     calls cannot double-provision;
//   - the refund is created only by the call that flips the order to FAILED,
//     and never when a refund transaction for the order already exists;
//   - panel usernames are deterministic per order, and the Marzban adapter
//     recovers (not duplicates) an account left by a crashed attempt;
//   - (9.1) a DB failure AFTER panel success runs a recovery ladder
//     (existing service -> repair by username -> one retry -> refund), so
//     the order never stays PROVISIONING without a service or a refund.
//
// No renewal, extra volume/time, location change, service management or
// OtherProductOrder handling here - later phases.
// =============================================================================

export const REFUND_PROVISIONING_REASON = "REFUND_PROVISIONING_FAILED";

/** Customer-facing failure/refund notice (never contains adapter errors). */
export const PROVISION_FAILED_USER_TEXT =
  "پرداخت شما تایید شد ✅\n" +
  "اما ساخت سرویس با خطا مواجه شد.\n" +
  "مبلغ پرداختی به کیف پول شما برگشت داده شد.";

/**
 * Returned when the panel outcome is UNKNOWN/partial (e.g. timeout after the
 * request may have landed). The order stays PROVISIONING - never refunded on
 * uncertainty - and startup reconciliation settles it from panel truth.
 */
export const PROVISION_UNKNOWN_OUTCOME_TEXT =
  "نتیجه ساخت سرویس نامشخص ماند؛ وضعیت سفارش به‌صورت خودکار بررسی و اصلاح می‌شود.";

export type ProvisionOutcome =
  | { ok: true; service: Service; alreadyExisted: boolean }
  | { ok: false; refunded: boolean; error: string };

export type OrderForProvisioning = Order & {
  user: User;
  product: (Product & { panel: Panel | null }) | null;
  checkoutSession?: CheckoutSession | null;
};

/**
 * LEGACY deterministic username: zed_<telegramId>_<orderShortId>, lowercase
 * [a-z0-9_], shortened via the telegramId's last 8 digits when it would
 * exceed 32 chars. Naming phase: NEW orders resolve their identity from the
 * admin-selected strategy via the Order.namingSnapshot instead - this
 * generator remains ONLY as the identity of pre-naming-phase orders, so
 * their reconciliation/recovery keeps probing the exact historical name.
 */
export function generatePanelUsername(telegramId: bigint, orderId: string): string {
  const orderShort = orderId.replace(/-/g, "").slice(0, 8).toLowerCase();
  const tg = telegramId.toString();
  let username = `zed_${tg}_${orderShort}`;
  if (username.length > 32) {
    username = `zed_${tg.slice(-8)}_${orderShort}`;
  }
  return username.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

/**
 * Naming config captured on the checkout's productSnapshot at checkout time
 * (naming phase). Null for legacy checkouts - resolution then falls back to
 * the panel's CURRENT config, exactly once, before the first remote call.
 */
export function checkoutNamingCapture(
  checkout: CheckoutSession | null | undefined,
): NamingConfigSnapshot | null {
  const snapshot = checkout?.productSnapshot;
  if (snapshot === null || snapshot === undefined || typeof snapshot !== "object") {
    return null;
  }
  const record = snapshot as Record<string, unknown>;
  if (typeof record.namingStrategy !== "string") {
    return null;
  }
  return {
    strategy: record.namingStrategy as NamingConfigSnapshot["strategy"],
    customText: typeof record.namingCustomText === "string" ? record.namingCustomText : null,
    randomLength:
      typeof record.namingRandomLength === "number" ? record.namingRandomLength : null,
    representativePrefix:
      typeof record.namingRepresentativePrefix === "string"
        ? record.namingRepresentativePrefix
        : null,
    // Service-checkout username selection (feat/service-checkout-username-note):
    // a buyer-chosen username captured at checkout is used verbatim by the naming
    // resolver (no panel strategy / counter is run). Absent on legacy checkouts.
    userSelectedUsername:
      typeof record.serviceUsername === "string" ? record.serviceUsername : null,
    userSelectionSource:
      record.serviceUsernameSelectionSource === "USER_RANDOM"
        ? "USER_RANDOM"
        : record.serviceUsernameSelectionSource === "USER_CUSTOM"
          ? "USER_CUSTOM"
          : null,
  };
}

/**
 * Marks the order FAILED and refunds finalPriceToman to the user's wallet,
 * all in one transaction. Only the caller that actually flips the status
 * creates the refund; an existing refund transaction for this order is never
 * duplicated. Returns true when a refund is in place (created now or before).
 * Shared with the Phase 12 renewal pipeline.
 */
export async function failOrderWithRefund(
  order: OrderForProvisioning,
  internalError: string,
): Promise<boolean> {
  const refunded = await prisma.$transaction(async (tx) => {
    const flipped = await tx.order.updateMany({
      where: { id: order.id, status: { in: [OrderStatus.PAID, OrderStatus.PROVISIONING] } },
      data: { status: OrderStatus.FAILED, failureReason: internalError.slice(0, 500) },
    });
    const existingRefund = await tx.walletTransaction.findFirst({
      where: { relatedOrderId: order.id, reason: REFUND_PROVISIONING_REASON },
    });
    if (existingRefund !== null) {
      return true;
    }
    if (flipped.count === 0) {
      // Someone else owns the failure path; do not double-refund.
      return false;
    }
    // Codex P2 fix: this call owns the FAILED transition, so free the order's own
    // username reservation in the SAME transaction. A refunded SERVICE order must
    // never keep a BOUND hold occupying the global activeUsernameKey; cleanup would
    // never reclaim it (the checkout is not terminal/expired), blocking that
    // username on every panel forever.
    await releaseReservationForFailedOrder(tx, {
      orderId: order.id,
      checkoutSessionId: order.checkoutSessionId,
    });
    if (order.finalPriceToman <= 0) {
      // Fully-discounted order: nothing to move, FAILED is enough.
      return true;
    }
    // LEDGER-CRITICAL: the increment UPDATE takes the row lock and returns
    // the post-update row, so balanceBefore/balanceAfter always describe
    // the real transition. A plain pre-read here would race a concurrent
    // wallet operation and record a before/after pair that never existed.
    const credited = await tx.user.update({
      where: { id: order.userId },
      data: {
        balanceToman: { increment: order.finalPriceToman },
        totalRefundedToman: { increment: order.finalPriceToman },
      },
      select: { balanceToman: true },
    });
    const balanceAfter = credited.balanceToman;
    const balanceBefore = balanceAfter - order.finalPriceToman;
    await tx.walletTransaction.create({
      data: {
        userId: order.userId,
        amountToman: order.finalPriceToman,
        type: WalletTransactionType.REFUND,
        source: WalletTransactionSource.SYSTEM,
        reason: REFUND_PROVISIONING_REASON,
        relatedOrderId: order.id,
        relatedPaymentId: order.paymentId,
        balanceBeforeToman: balanceBefore,
        balanceAfterToman: balanceAfter,
      },
    });

    // Low-balance state machine: same transaction, committed balance, no I/O.
    await onWalletBalanceChanged(tx, {
      userId: order.userId,
      balanceAfterToman: balanceAfter,
      source: "REFUND",
    });
    return true;
  });
  logger.warn("provisioning failed - order FAILED", {
    orderId: order.id,
    refunded,
    error: internalError,
  });
  // Referral affiliate commissions: if this order had already earned a commission,
  // claw it back. DURABLE + fail-soft — enqueue a retryable reversal execute job
  // (this refund IS authoritative evidence) rather than reversing inline, so a
  // crash between the refund and the clawback recovers automatically; the worker
  // reversal scan is the authoritative catch-all, so we never rely on this single
  // call site. A no-op for the common pre-completion failure (no commission).
  if (refunded) {
    void enqueueReferralReverse(order.id).catch((err) => {
      logger.warn("referral commission reversal enqueue skipped", { corr: referralCorrelationHash(order.id), error: errorMessage(err) });
    });
  }
  return refunded;
}

/**
 * Provisions one PAID SERVICE_PURCHASE order. Safe to call repeatedly:
 * every path is guarded (see module header). All returned error strings are
 * admin-safe Persian; adapter internals only go to logs.
 *
 * CONCURRENCY: no Service row exists yet, so the distributed lock keys on
 * the panel + the order's deterministic username - the same key startup
 * reconciliation uses, so a stale-order sweep can never probe/adopt while
 * this pipeline is creating the account. Contention or an unavailable lock
 * backend leaves the order PAID and retryable - no panel call, no refund.
 */
/** The panel the checkout FROZE at pre-invoice (`productSnapshot.panelId`), or
 * null for a legacy/OTHER checkout with no frozen panel. Used to detect a
 * post-checkout Product panel reassignment (Codex P1). */
function checkoutSnapshotPanelId(checkout: CheckoutSession | null | undefined): string | null {
  if (checkout === null || checkout === undefined) {
    return null;
  }
  const snap = checkout.productSnapshot;
  if (snap === null || typeof snap !== "object" || Array.isArray(snap)) {
    return null;
  }
  const panelId = (snap as Record<string, unknown>).panelId;
  return typeof panelId === "string" && panelId !== "" ? panelId : null;
}

export async function provisionPaidOrder(orderId: string): Promise<ProvisionOutcome> {
  // Pre-lock reads only feed the lock key (deterministic username + panel).
  const head = (await prisma.order.findUnique({
    where: { id: orderId },
    include: { user: true, product: { include: { panel: true } }, checkoutSession: true },
  })) as OrderForProvisioning | null;
  if (head === null) {
    return { ok: false, refunded: false, error: "سفارش یافت نشد." };
  }
  const headPanel = head.product?.panel ?? null;
  if (head.type !== OrderType.SERVICE_PURCHASE || headPanel === null) {
    // Type mismatch errors and the missing-panel preflight refund need no
    // shared-state protection - delegate to the unguarded body.
    return provisionPaidOrderUnlocked(orderId, null);
  }
  // Codex P1 fix (gate reconciliation BEFORE naming): an OPEN/IN_REVIEW
  // SERVICE_USERNAME_UNBOUND case deliberately keeps this order PAID for the OWNER
  // retry-bind. Its reservation is intentionally unbound, so if naming resolution
  // (below) ran first it would see a "foreign" active hold, fail, and REFUND an
  // externally-paid order that must stay PAID for review — the exact bug a direct
  // caller like provisionNextPaidOrders hits. Gate HERE, before both the drift
  // refund and naming, and ONLY for a still-PAID order (an already-provisioned
  // order replays through the existing-Service idempotency check in the unlocked
  // body). Money untouched. The unlocked body keeps the same guard as a backstop.
  if (
    head.status === OrderStatus.PAID &&
    head.checkoutSessionId !== null &&
    (await hasBlockingServiceUsernameUnboundCase(head.checkoutSessionId))
  ) {
    return {
      ok: false,
      refunded: false,
      error: "ساخت سرویس به دلیل نیاز به بررسی رزرو نام کاربری، متوقف شد.",
    };
  }
  // Codex P1 fix (post-checkout panel drift): the username + reservation were
  // frozen against the checkout's panel. If an admin reassigned the Product's
  // panel AFTER checkout but before settlement, the live product.panel now
  // differs from the frozen one — provisioning here would create the account on
  // a panel where availability was never checked and the reservation does not
  // apply. Refund ONLY an unstarted (still-PAID) order: a PROVISIONING order may
  // already have created the remote account on the frozen panel, so refunding it
  // would violate the unknown-outcome rule and orphan a free service. In-flight /
  // completed drifted orders fall through to the idempotency-aware unlocked body,
  // which replays an existing Service or returns "in progress" WITHOUT any panel
  // call. Legacy orders without a frozen panelId are unaffected.
  const frozenPanelId = checkoutSnapshotPanelId(head.checkoutSession);
  if (frozenPanelId !== null && frozenPanelId !== headPanel.id) {
    if (head.status !== OrderStatus.PAID) {
      // Never refund a possibly-provisioned order; reconcile it against the frozen
      // panel via the idempotency-aware body (no lock needed — it makes no panel call).
      return provisionPaidOrderUnlocked(orderId, null);
    }
    const refunded = await failOrderWithRefund(
      head,
      `panel drift after checkout: frozen ${frozenPanelId.slice(0, 8)} != live ${headPanel.id.slice(0, 8)}`,
    );
    return {
      ok: false,
      refunded,
      error: "پیکربندی سرور این سرویس پس از ثبت سفارش تغییر کرده است؛ سفارش بازگردانده شد.",
    };
  }
  // Naming phase: the lock key derives from the order's IMMUTABLE identity.
  // Stored snapshot first; a PAID order without one gets it resolved and
  // persisted exactly once RIGHT HERE - before any lock or remote call.
  // Non-PAID legacy in-flight orders keep the historical generator so their
  // reconciliation probes the exact name their remote account carries.
  let username: string;
  const storedIdentity = parseNamingSnapshot(head.namingSnapshot);
  if (storedIdentity !== null) {
    username = storedIdentity.resolvedRemoteUsername;
  } else if (head.status === OrderStatus.PAID) {
    const ensured = await ensureOrderNamingSnapshot(
      head,
      headPanel,
      checkoutNamingCapture(head.checkoutSession),
    );
    if (!ensured.ok) {
      // Definite pre-remote failure (incomplete naming config): nothing was
      // attempted on the panel, so the existing FAIL+refund semantics apply.
      const refunded = await failOrderWithRefund(head, ensured.error);
      return { ok: false, refunded, error: ensured.safeUserMessage };
    }
    username = ensured.identity.resolvedRemoteUsername;
  } else {
    username = generatePanelUsername(head.user.telegramId, head.id);
  }
  const acquisition = await acquireServiceLock(
    serviceProvisioningLockKey(headPanel.id, username),
  );
  if (!acquisition.ok) {
    return {
      ok: false,
      refunded: false,
      error:
        acquisition.reason === "contended"
          ? SERVICE_LOCK_BUSY_TEXT
          : SERVICE_LOCK_UNAVAILABLE_TEXT,
    };
  }
  try {
    return await provisionPaidOrderUnlocked(orderId, acquisition.lock);
  } finally {
    await acquisition.lock.release();
  }
}

async function provisionPaidOrderUnlocked(
  orderId: string,
  lock: ServiceLock | null,
): Promise<ProvisionOutcome> {
  const order = (await prisma.order.findUnique({
    where: { id: orderId },
    include: { user: true, product: { include: { panel: true } }, checkoutSession: true },
  })) as OrderForProvisioning | null;
  if (order === null) {
    return { ok: false, refunded: false, error: "سفارش یافت نشد." };
  }

  // Idempotency: an existing Service wins over everything.
  const existingService = await prisma.service.findFirst({ where: { orderId: order.id } });
  if (existingService !== null) {
    if (order.status !== OrderStatus.COMPLETED) {
      await prisma.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.COMPLETED, completedAt: new Date() },
      });
    }
    return { ok: true, service: existingService, alreadyExisted: true };
  }

  if (order.type !== OrderType.SERVICE_PURCHASE) {
    return { ok: false, refunded: false, error: "این سفارش از نوع خرید سرویس نیست." };
  }
  if (order.status === OrderStatus.PROVISIONING) {
    return { ok: false, refunded: false, error: "ساخت سرویس این سفارش هم‌اکنون در حال انجام است." };
  }
  if (order.status === OrderStatus.FAILED) {
    // No automatic retry in this phase.
    return { ok: false, refunded: false, error: "این سفارش قبلاً ناموفق شده است." };
  }
  if (order.status !== OrderStatus.PAID) {
    return { ok: false, refunded: false, error: "وضعیت سفارش برای ساخت سرویس معتبر نیست." };
  }

  // §5: the provisioning-authority defense. An OPEN/IN_REVIEW
  // SERVICE_USERNAME_UNBOUND reconciliation case blocks provisioning HERE, inside
  // the authority itself — not only in the outer Telegram dispatcher — so a
  // direct/internal provisionPaidOrder call (settlement sweep, startup recovery,
  // an admin action) can never bypass an unresolved case and create a service on
  // an unbound username. Money is untouched: the order stays PAID for the OWNER
  // retry-bind to resolve. An already-provisioned order returns above via the
  // existing-Service idempotency check, so this never blocks a legitimate replay.
  if (
    order.checkoutSessionId !== null &&
    (await hasBlockingServiceUsernameUnboundCase(order.checkoutSessionId))
  ) {
    return {
      ok: false,
      refunded: false,
      error: "ساخت سرویس به دلیل نیاز به بررسی رزرو نام کاربری، متوقف شد.",
    };
  }

  // Pre-flight configuration checks. The order is PAID, so any dead end here
  // is a provisioning failure: FAIL + refund, never a silent charge.
  const product = order.product;
  const panel = product?.panel ?? null;
  // XUI entitlement: a paid order provisions the EXACT inbound set sold at
  // checkout (Order.inboundIdsSnapshot) - product/panel edits after payment
  // never change it. Legacy orders without a snapshot resolve from live
  // config (panel allowlist + product subset) exactly as before.
  const soldInboundIds =
    panel !== null && panel.type === "XUI"
      ? parsePanelInboundIds(order.inboundIdsSnapshot)
      : [];
  const inboundResolution =
    panel !== null && panel.type === "XUI" && soldInboundIds.length === 0 && product !== null
      ? resolveProductInboundIds(panel, product.inboundIds)
      : null;
  const preflightError =
    product === null
      ? "product row no longer exists"
      : product.type !== "SERVICE_PRODUCT"
        ? "product is not a SERVICE_PRODUCT"
        : panel === null
          ? "product has no panel"
          : panel.status !== "ACTIVE"
            ? `panel status is ${panel.status}`
            : !assessPanelConfig(panel).ok
              ? `panel provisioning config incomplete: ${assessPanelConfig(panel).reason ?? "unknown"}`
              : inboundResolution !== null && !inboundResolution.ok
                ? `product inbound selection invalid: ${inboundResolution.reason}` +
                  (inboundResolution.invalidIds !== undefined
                    ? ` (${inboundResolution.invalidIds.join(", ")})`
                    : "")
                : null;
  if (preflightError !== null || product === null || panel === null) {
    const refunded = await failOrderWithRefund(order, preflightError ?? "invalid configuration");
    return { ok: false, refunded, error: "ساخت سرویس ناموفق بود." };
  }

  // Claim the order: only one caller wins PAID -> PROVISIONING.
  const claimed = await prisma.order.updateMany({
    where: { id: order.id, status: OrderStatus.PAID },
    data: { status: OrderStatus.PROVISIONING },
  });
  if (claimed.count === 0) {
    return { ok: false, refunded: false, error: "سفارش توسط فرایند دیگری در حال پردازش است." };
  }
  logger.info("provisioning started", {
    orderId: order.id,
    panelId: panel.id,
    panelType: panel.type,
  });

  // Immutable sold values: order snapshots first, Product fields as fallback.
  const volumeGb = order.volumeGbSnapshot ?? product.volumeGb ?? 0;
  const durationDays = order.durationDaysSnapshot ?? product.durationDays ?? 0;
  const volumeBytes = volumeGb > 0 ? BigInt(volumeGb) * 1024n * 1024n * 1024n : null;
  const now = new Date();
  const expiresAt = durationDays > 0 ? new Date(now.getTime() + durationDays * 86_400_000) : null;
  // Naming phase: the snapshot IS the identity - the locked wrapper ensured
  // it for PAID orders; this re-check keeps any other entry path honest.
  const naming = await ensureOrderNamingSnapshot(
    order,
    panel,
    checkoutNamingCapture(order.checkoutSession),
  );
  if (!naming.ok) {
    const refunded = await failOrderWithRefund(order, naming.error);
    return { ok: false, refunded, error: naming.safeUserMessage };
  }
  const username = naming.identity.resolvedRemoteUsername;

  // Codex P1 fix (cross-path namespace, race-safe): under the per-(panel,
  // username) provisioning lock, refuse to create a Service on a remote username
  // that a FOREIGN active reservation holds. The naming resolver already avoids
  // held names, but this closes the check-then-insert race — the reservation row
  // is durable and this runs under the same lock the holder's own provisioning
  // takes, so the reservation always wins. A SERVICE order's own reservation
  // (bound to THIS order) is excluded, so it never blocks itself.
  if (await hasForeignActiveReservationForUsername(username, order.id)) {
    const refunded = await failOrderWithRefund(
      order,
      `remote username held by a foreign reservation: ${username.slice(0, 4)}…`,
    );
    return { ok: false, refunded, error: "نام کاربری این سرویس در دسترس نیست؛ سفارش بازگردانده شد." };
  }

  const note = `zedbot order:${order.id.slice(0, 8)} tg:${order.user.telegramId}`;

  let created: CreateServiceAccountResult;
  try {
    const adapter = buildAdapterForPanel(panel);
    created = await adapter.createServiceAccount({
      username,
      note,
      volumeBytes,
      durationDays,
      expiresAt,
      templateUsername: panel.templateUsername,
      dataLimitResetStrategy: panel.resetStrategy,
      trafficResetCycle: product.trafficResetCycle,
      subscriptionBaseUrl: normalizeSubscriptionBase(panel),
      inboundIds:
        soldInboundIds.length > 0
          ? soldInboundIds
          : inboundResolution !== null && inboundResolution.ok
            ? inboundResolution.inboundIds
            : parsePanelInboundIds(panel.inboundIds),
      protocolSettings:
        panel.protocolSettings !== null && typeof panel.protocolSettings === "object"
          ? (panel.protocolSettings as Record<string, unknown>)
          : null,
    });
  } catch (err) {
    // Covers credential decryption/config errors - never exposed to users.
    created = { ok: false, errorMessage: errorMessage(err) };
  }

  if (!created.ok) {
    // Structured sanitized diagnostic (never credentials/cookies/tokens).
    logger.warn("panel create-service failed", {
      orderId: order.id,
      panelId: panel.id,
      panelType: panel.type,
      code: created.diagnostic?.code ?? null,
      httpStatus: created.diagnostic?.httpStatus ?? null,
      endpointPath: created.diagnostic?.endpointPath ?? null,
      uncertain: created.uncertain === true,
      error: created.errorMessage ?? "unknown adapter error",
    });
    if (created.uncertain === true) {
      // UNKNOWN/partial remote state (e.g. timeout after the request may
      // have landed, or a multi-inbound cleanup that could not be
      // confirmed). NEVER refund on uncertainty: the order stays
      // PROVISIONING and startup reconciliation - which probes the panel
      // under the same lock - completes or refunds it on positive proof.
      return { ok: false, refunded: false, error: PROVISION_UNKNOWN_OUTCOME_TEXT };
    }
    const refunded = await failOrderWithRefund(order, created.errorMessage ?? "unknown adapter error");
    return { ok: false, refunded, error: "ساخت سرویس ناموفق بود." };
  }

  // Confirmed lock loss after the panel write: persisting could interleave
  // with a new lock owner. Leave the order PROVISIONING - startup
  // reconciliation adopts/refunds it from panel truth under the same lock.
  if (lock !== null && lock.isLost()) {
    logger.error("provisioning: lock ownership lost after panel call - deferring to reconciliation", {
      orderId: order.id,
      panelId: panel.id,
    });
    return { ok: false, refunded: false, error: SERVICE_LOCK_LOST_TEXT };
  }

  // The panel account now exists (or was recovered). From here on the user
  // must end up with a recorded Service OR a refund - never a silent charge.
  const persistService = (): Promise<Service> =>
    prisma.$transaction(async (tx) => {
      // Last-line duplicate guard (username is also unique per order).
      const duplicate = await tx.service.findFirst({ where: { orderId: order.id } });
      if (duplicate !== null) {
        return duplicate;
      }
      const row = await tx.service.create({
        data: {
          userId: order.userId,
          orderId: order.id,
          panelId: panel.id,
          productId: product.id,
          panelType: panel.type,
          username: created.username ?? username,
          note,
          // Service-checkout username selection (feat/service-checkout-username-note):
          // the buyer's optional subscription note, copied from the immutable order
          // snapshot (null when skipped / legacy). Distinct from `note` above (the
          // internal recovery marker) and never pushed to the remote panel.
          userNote: order.serviceNoteSnapshot,
          // Naming phase: how this username was resolved (strategy, version,
          // resolved values). Lifecycle ops always use the stored username.
          namingStrategySnapshot: {
            strategy: naming.identity.strategy,
            version: naming.identity.version,
            resolvedRemoteUsername: naming.identity.resolvedRemoteUsername,
            resolvedDisplayName: naming.identity.resolvedDisplayName,
          },
          status: ServiceStatus.ACTIVE,
          serviceLocation: product.serviceLocation ?? ServiceLocation.MULTI_LOCATION,
          productNameSnapshot: order.productNameSnapshot ?? product.name,
          panelNameSnapshot: order.panelNameSnapshot ?? panel.name,
          volumeBytes: volumeBytes ?? 0n,
          usedBytes: 0n,
          remainingBytes: volumeBytes ?? 0n,
          durationDays,
          startsAt: now,
          expiresAt,
          subscriptionUrl: created.subscriptionUrl ?? null,
          subscriptionToken: created.subscriptionToken ?? null,
          ...(created.configLinks !== undefined ? { configLinks: created.configLinks } : {}),
          // Remote client identifiers (XUI): needed for later sync/cleanup.
          remoteClientId: created.remoteClientId ?? null,
          ...(created.remoteInboundIds !== undefined
            ? { remoteInboundIds: created.remoteInboundIds }
            : {}),
          ...(created.remoteMetadata !== undefined
            ? { remoteMetadata: created.remoteMetadata as object }
            : {}),
        },
      });
      // Service-checkout username selection: mark the buyer's reservation
      // CONSUMED in the SAME transaction (matched by orderId + the exact
      // username, so a foreign/mismatched reservation is never consumed). A
      // no-op for legacy / strategy-named orders that carry no reservation.
      await consumeReservationForOrder(tx, order.id, row.id, row.username);
      await tx.order.updateMany({
        where: { id: order.id, status: OrderStatus.PROVISIONING },
        data: { status: OrderStatus.COMPLETED, completedAt: now },
      });
      return row;
    });

  let service: Service;
  try {
    service = await persistService();
  } catch (err) {
    // Phase 9.1: panel success + DB failure must never strand the user.
    logger.error("provisioning persistence failed after panel success", {
      orderId: order.id,
      panelId: panel.id,
      username: created.username ?? username,
      error: errorMessage(err),
    });
    return recoverOrRefundAfterPanelSuccess(order, panel, created.username ?? username, persistService);
  }
  logger.info("provisioning succeeded", {
    orderId: order.id,
    serviceId: service.id,
    panelId: panel.id,
  });
  return { ok: true, service, alreadyExisted: false };
}

/** Completes an order that still sits in the provisioning pipeline. */
async function completeOrder(orderId: string): Promise<void> {
  await prisma.order.updateMany({
    where: { id: orderId, status: { in: [OrderStatus.PAID, OrderStatus.PROVISIONING] } },
    data: { status: OrderStatus.COMPLETED, completedAt: new Date() },
  });
}

/**
 * Phase 9.1: recovery ladder for "panel account exists but DB persistence
 * threw". In order:
 *
 *   1. a Service for this order already exists -> complete the order, done;
 *   2. a Service with this username exists and belongs to this user (orderId
 *      null or this order) -> link/repair it, complete the order, done -
 *      another user's service is never touched;
 *   3. otherwise retry the identical persistence transaction ONCE;
 *   4. still failing -> Order FAILED + wallet refund (panel delete/revoke is
 *      not implemented yet, so the refund is the safe business outcome; the
 *      possibly-orphaned panel account is logged for manual cleanup).
 *
 * The order is never left stuck in PROVISIONING without a service or refund.
 */
async function recoverOrRefundAfterPanelSuccess(
  order: OrderForProvisioning,
  panel: Panel,
  username: string,
  persistService: () => Promise<Service>,
): Promise<ProvisionOutcome> {
  let usernameTakenByOtherUser = false;
  try {
    const byOrder = await prisma.service.findFirst({ where: { orderId: order.id } });
    if (byOrder !== null) {
      await completeOrder(order.id);
      return { ok: true, service: byOrder, alreadyExisted: true };
    }
    const byUsername = await prisma.service.findUnique({ where: { username } });
    if (byUsername !== null) {
      if (
        byUsername.userId === order.userId &&
        (byUsername.orderId === null || byUsername.orderId === order.id)
      ) {
        const repaired =
          byUsername.orderId === null
            ? await prisma.service.update({
                where: { id: byUsername.id },
                data: { orderId: order.id },
              })
            : byUsername;
        await completeOrder(order.id);
        logger.info("provisioning recovery: existing service repaired", {
          orderId: order.id,
          serviceId: repaired.id,
        });
        return { ok: true, service: repaired, alreadyExisted: true };
      }
      // Foreign service owns this username - never touch it, and a retry
      // would hit the same unique constraint, so skip straight to refund.
      usernameTakenByOtherUser = true;
    }
    if (!usernameTakenByOtherUser) {
      // One retry of the identical transaction (covers transient DB errors).
      const service = await persistService();
      logger.info("provisioning persistence retry succeeded", {
        orderId: order.id,
        serviceId: service.id,
      });
      return { ok: true, service, alreadyExisted: false };
    }
  } catch (err) {
    logger.error("provisioning recovery attempt failed", {
      orderId: order.id,
      error: errorMessage(err),
    });
  }

  // Refund is the safe outcome; the panel account may be orphaned until an
  // admin cleans it up manually (delete/revoke arrives in a later phase).
  logger.warn("possible orphan panel account - manual cleanup may be needed", {
    orderId: order.id,
    panelId: panel.id,
    username,
  });
  const refunded = await failOrderWithRefund(
    order,
    "service persistence failed after panel success",
  );
  return { ok: false, refunded, error: "ساخت سرویس ناموفق بود." };
}

/**
 * Provisions up to `limit` of the oldest PAID SERVICE_PURCHASE orders.
 * Foundation for a future worker; nothing schedules it automatically yet.
 */
export async function provisionNextPaidOrders(
  limit: number,
): Promise<Array<{ orderId: string; outcome: ProvisionOutcome }>> {
  const orders = await prisma.order.findMany({
    where: { status: OrderStatus.PAID, type: OrderType.SERVICE_PURCHASE },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(limit, 50)),
  });
  const results: Array<{ orderId: string; outcome: ProvisionOutcome }> = [];
  for (const order of orders) {
    results.push({ orderId: order.id, outcome: await provisionPaidOrder(order.id) });
  }
  return results;
}

const MAX_CONFIG_LINKS_SHOWN = 10;

/** HTML service-info message for the user after successful provisioning. */
export function buildServiceInfoMessage(service: Service): string {
  const gb = service.volumeBytes > 0n ? Number(service.volumeBytes / (1024n * 1024n * 1024n)) : 0;
  const lines = [
    "سرویس شما با موفقیت ساخته شد ✅",
    "",
    `نام سرویس: ${escapeHtml(service.productNameSnapshot ?? "-")}`,
    `نام کاربری: <code>${escapeHtml(service.username)}</code>`,
    `حجم: ${service.volumeBytes > 0n ? `${gb} گیگابایت` : "نامحدود"}`,
    `مدت: ${service.durationDays > 0 ? `${service.durationDays} روز` : "نامحدود"}`,
  ];
  if (service.expiresAt !== null) {
    lines.push(`تاریخ انقضا: ${service.expiresAt.toISOString().slice(0, 10)}`);
  }
  if (service.subscriptionUrl !== null) {
    lines.push("", "لینک اشتراک:", `<code>${escapeHtml(service.subscriptionUrl)}</code>`);
  }
  const links = Array.isArray(service.configLinks)
    ? service.configLinks.filter((l): l is string => typeof l === "string" && l !== "")
    : [];
  if (links.length > 0) {
    lines.push("", "کانفیگ‌ها:");
    for (const link of links.slice(0, MAX_CONFIG_LINKS_SHOWN)) {
      lines.push(`<code>${escapeHtml(link)}</code>`);
    }
    if (links.length > MAX_CONFIG_LINKS_SHOWN) {
      lines.push(`(+${links.length - MAX_CONFIG_LINKS_SHOWN} کانفیگ دیگر)`);
    }
  }
  if (service.subscriptionUrl === null && links.length === 0) {
    lines.push("", "اطلاعات اتصال کامل از پنل دریافت نشد؛ لطفاً با پشتیبانی تماس بگیرید.");
  }
  return lines.join("\n");
}
