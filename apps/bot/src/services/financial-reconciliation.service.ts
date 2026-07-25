import {
  FinancialReconciliationStatus,
  FinancialReconciliationType,
  PaymentSettlementStatus,
  PaymentStatus,
  Prisma,
  prisma,
  type FinancialReconciliationCase,
  type Payment,
} from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { bindSettledReservationFromSnapshot } from "./service-username-selection.service.js";
import { OPS_EVENTS, writeSystemLog } from "./system-log.service.js";

// =============================================================================
// Financial reconciliation (P0 settlement phase): the persistent review
// queue for DUPLICATE successful payments - a provider collected real money
// but another Payment already owned the checkout's local settlement. Policy
// for this phase is FINANCIAL_REVIEW: no automatic refund (no audited
// idempotent refund API exists across providers) and no automatic wallet
// credit (that would change the user's entitlement without business
// approval). Provider SUCCESS is never downgraded; the duplicate is filed
// visibly and financial admins are alerted.
//
// Safe fields only - case rows and alerts carry ids/providers/amounts,
// never payloads, signatures or credentials.
// =============================================================================

/** Telegram-facing user notice for a duplicate successful charge. */
export const DUPLICATE_SUCCESS_USER_TEXT =
  "پرداخت شما در درگاه با موفقیت ثبت شد، اما این پیش‌فاکتور قبلاً با روش دیگری پرداخت شده است.\n\n" +
  "پرداخت دوم برای بررسی مالی ثبت شد و نتیجه از طریق ربات اطلاع‌رسانی می‌شود.";

/** Telegram-facing admin alert header. */
export const DUPLICATE_SUCCESS_ADMIN_HEADER =
  "⚠️ پرداخت موفق تکراری برای یک پیش‌فاکتور\n\n" +
  "یک پیش‌فاکتور از بیش از یک روش پرداخت با موفقیت پرداخت شده است و نیاز به بررسی مالی دارد.";

export interface DuplicateSuccessInput {
  checkoutSessionId: string;
  duplicatePaymentId: string;
  /** Null when the checkout was settled before ownership tracking existed. */
  primaryPaymentId: string | null;
  userId: string;
  expectedAmountToman: number;
  /** Short SAFE English marker - never raw provider data. */
  safeReason: string;
}

export interface DuplicateSuccessRecord {
  reconciliationCase: FinancialReconciliationCase;
  /** true only on the call that created the case (drives notifications). */
  created: boolean;
}

/**
 * Files ONE reconciliation case for a duplicate successful payment and marks
 * the payment's LOCAL settlement as DUPLICATE_SUCCESS_REVIEW - atomically,
 * and idempotently: duplicatePaymentId is unique, so repeated settlement
 * attempts (sweeps, button mashes, crash retries) converge on the same case.
 * Provider status and Payment.status are never touched here.
 */
export async function recordDuplicateSuccess(
  input: DuplicateSuccessInput,
): Promise<DuplicateSuccessRecord> {
  const result = await prisma.$transaction(async (tx) => {
    // Local settlement marker (never Payment.status / providerStatus).
    await tx.payment.updateMany({
      where: {
        id: input.duplicatePaymentId,
        settlementStatus: PaymentSettlementStatus.UNSETTLED,
      },
      data: {
        settlementStatus: PaymentSettlementStatus.DUPLICATE_SUCCESS_REVIEW,
        settlementReason: input.safeReason.slice(0, 200),
      },
    });
    const existing = await tx.financialReconciliationCase.findUnique({
      where: { duplicatePaymentId: input.duplicatePaymentId },
    });
    if (existing !== null) {
      return { reconciliationCase: existing, created: false };
    }
    try {
      const created = await tx.financialReconciliationCase.create({
        data: {
          type: FinancialReconciliationType.DUPLICATE_CHECKOUT_PAYMENT,
          checkoutSessionId: input.checkoutSessionId,
          primaryPaymentId: input.primaryPaymentId,
          duplicatePaymentId: input.duplicatePaymentId,
          userId: input.userId,
          expectedAmountToman: input.expectedAmountToman,
          safeReason: input.safeReason.slice(0, 200),
        },
      });
      return { reconciliationCase: created, created: true };
    } catch (err) {
      // P2002 = a concurrent settlement attempt filed the case first.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const winner = await tx.financialReconciliationCase.findUnique({
          where: { duplicatePaymentId: input.duplicatePaymentId },
        });
        if (winner !== null) {
          return { reconciliationCase: winner, created: false };
        }
      }
      throw err;
    }
  });
  if (result.created) {
    logger.warn("duplicate successful payment detected - reconciliation case created", {
      caseId: result.reconciliationCase.id,
      checkoutSessionId: input.checkoutSessionId,
      duplicatePaymentId: input.duplicatePaymentId,
      primaryPaymentId: input.primaryPaymentId,
      userId: input.userId,
    });
    // Ops log (PAYMENT topic) - ids/amounts only, never provider payloads.
    void writeSystemLog({
      level: "WARN",
      eventType: OPS_EVENTS.PAYMENT_DUPLICATE_SUCCESS,
      message: "duplicate successful payment filed for financial review",
      metadata: {
        caseId: result.reconciliationCase.id,
        expectedAmountToman: input.expectedAmountToman,
      },
      topicKey: "PAYMENT",
      userId: input.userId,
      paymentId: input.duplicatePaymentId,
    });
  }
  return result;
}

// --- service-username reservation-bind reconciliation (hotfix §2) -------------------------

/** Telegram-facing user notice when a paid SERVICE could not bind its username. */
export const SERVICE_UNBOUND_USER_TEXT =
  "پرداخت شما با موفقیت ثبت شد، اما به دلیل یک مغایرت در رزرو نام کاربری، ساخت سرویس نیاز به بررسی دارد.\n\n" +
  "این مورد برای بررسی ثبت شد و نتیجه از طریق ربات اطلاع‌رسانی می‌شود.";

/** Admin-facing safe message when a settlement is held for username reconciliation. */
export const SERVICE_UNBOUND_ADMIN_TEXT =
  "این پرداخت به دلیل مغایرت در رزرو نام کاربری سرویس، برای بررسی نگه داشته شد و به‌صورت خودکار سرویس ساخته نشد.";

export interface ServiceUsernameUnboundInput {
  checkoutSessionId: string;
  /** The settling payment — occupies the unique idempotency slot. */
  paymentId: string;
  userId: string;
  expectedAmountToman: number;
  /** Short SAFE English marker — never a username / note / raw provider data. */
  safeReason: string;
}

/**
 * Files ONE durable reconciliation case (§2) for an external-success settlement
 * whose paid SERVICE order could not be bound to its exact BOUND username
 * reservation. Runs INSIDE the settlement transaction (uses `tx`) so the case
 * commits atomically with the paid Order: provider SUCCESS is preserved and the
 * order is deliberately left un-provisioned. Idempotent — the settling payment id
 * occupies the `duplicatePaymentId @unique` slot, so duplicate callbacks / sweeps /
 * retries converge on ONE case. Carries only ids + amount + a SAFE reason, never a
 * username or note.
 */
export async function fileServiceUsernameUnboundCase(
  tx: Prisma.TransactionClient,
  input: ServiceUsernameUnboundInput,
): Promise<{ created: boolean; reconciliationCase: FinancialReconciliationCase }> {
  const existing = await tx.financialReconciliationCase.findUnique({
    where: { duplicatePaymentId: input.paymentId },
  });
  if (existing !== null) {
    return { created: false, reconciliationCase: existing };
  }
  try {
    const created = await tx.financialReconciliationCase.create({
      data: {
        type: FinancialReconciliationType.SERVICE_USERNAME_UNBOUND,
        checkoutSessionId: input.checkoutSessionId,
        primaryPaymentId: null,
        duplicatePaymentId: input.paymentId,
        userId: input.userId,
        expectedAmountToman: input.expectedAmountToman,
        safeReason: input.safeReason.slice(0, 200),
      },
    });
    return { created: true, reconciliationCase: created };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // A concurrent settlement filed the case first — return the winner so the
      // caller never treats a lost race as "created" (no duplicate alert).
      const winner = await tx.financialReconciliationCase.findUnique({
        where: { duplicatePaymentId: input.paymentId },
      });
      if (winner !== null) {
        return { created: false, reconciliationCase: winner };
      }
    }
    throw err;
  }
}

/**
 * Notifies the OWNER-role admins about a NEWLY created SERVICE_USERNAME_UNBOUND
 * case (§3). Mirror of {@link notifyDuplicateSuccessCase} but with the dedicated
 * username-reconciliation copy — it must NEVER send the duplicate-success alert.
 * Called exactly once (the caller gates on `created === true`) AFTER the settling
 * transaction committed, so a crashed/repeated send can never create or duplicate
 * a case. Never throws. Carries only safe short identifiers, provider, amount and
 * timestamp — never a raw username, note, reservation id or provider payload.
 */
export async function notifyServiceUsernameUnboundCase(
  api: NotifyApi,
  reconciliationCase: FinancialReconciliationCase,
  settlingPayment: Payment,
): Promise<void> {
  try {
    const user = await prisma.user.findUnique({ where: { id: reconciliationCase.userId } });
    const lines = [
      "⚠️ مغایرت رزرو یوزرنیم سرویس",
      "",
      SERVICE_UNBOUND_ADMIN_TEXT,
      "",
      `شناسه بررسی: ${shortId(reconciliationCase.id)}`,
      `پیش‌فاکتور: ${shortId(reconciliationCase.checkoutSessionId)}`,
      `کاربر: ${user?.telegramId.toString() ?? "-"}`,
      `پرداخت: ${settlingPayment.provider ?? "-"} (${shortId(settlingPayment.id)})`,
      `مبلغ: ${reconciliationCase.expectedAmountToman.toLocaleString("en-US")} تومان`,
      `زمان: ${reconciliationCase.createdAt.toISOString().replace("T", " ").slice(0, 16)} UTC`,
    ].join("\n");
    const owners = await prisma.admin.findMany({
      where: { isActive: true, role: "OWNER" },
      select: { telegramId: true },
    });
    for (const owner of owners) {
      try {
        await api.sendMessage(owner.telegramId.toString(), lines);
      } catch (err) {
        logger.warn("service-username-unbound admin alert failed", { error: errorMessage(err) });
      }
    }
  } catch (err) {
    logger.error("service-username-unbound notification crashed", { error: errorMessage(err) });
  }
}

/**
 * True when an OPEN or IN_REVIEW SERVICE_USERNAME_UNBOUND case exists for this
 * checkout. The order-fulfillment dispatcher consults this before provisioning a
 * SERVICE order, so neither the direct settlement dispatch nor the background
 * settlement sweep can provision an order whose username reservation is unresolved.
 */
export async function hasBlockingServiceUsernameUnboundCase(
  checkoutSessionId: string,
): Promise<boolean> {
  const row = await prisma.financialReconciliationCase.findFirst({
    where: {
      checkoutSessionId,
      type: FinancialReconciliationType.SERVICE_USERNAME_UNBOUND,
      status: {
        in: [FinancialReconciliationStatus.OPEN, FinancialReconciliationStatus.IN_REVIEW],
      },
    },
    select: { id: true },
  });
  return row !== null;
}

// --- notifications ------------------------------------------------------------------------

interface NotifyApi {
  sendMessage(chatId: string | number, text: string, other?: object): Promise<unknown>;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/**
 * Notifies the paying user and the OWNER-role financial admins about a new
 * duplicate-success case. Retry-safe by construction: this function only
 * SENDS - the case itself was committed before it is ever called, so a
 * crashed or repeated notification can never create a second case. Never
 * throws. RBAC note: centralized role-based permissions remain a separate
 * task; OWNER is the strongest financial role available today.
 */
export async function notifyDuplicateSuccessCase(
  api: NotifyApi,
  reconciliationCase: FinancialReconciliationCase,
  duplicatePayment: Payment,
  options: { skipUser?: boolean } = {},
): Promise<void> {
  try {
    const user = await prisma.user.findUnique({ where: { id: reconciliationCase.userId } });
    if (user !== null && options.skipUser !== true) {
      try {
        await api.sendMessage(user.telegramId.toString(), DUPLICATE_SUCCESS_USER_TEXT);
      } catch (err) {
        logger.warn("duplicate-success user notice failed", { error: errorMessage(err) });
      }
    }

    const primaryPayment =
      reconciliationCase.primaryPaymentId !== null
        ? await prisma.payment.findUnique({ where: { id: reconciliationCase.primaryPaymentId } })
        : null;
    const lines = [
      DUPLICATE_SUCCESS_ADMIN_HEADER,
      "",
      `شناسه بررسی: ${shortId(reconciliationCase.id)}`,
      `پیش‌فاکتور: ${shortId(reconciliationCase.checkoutSessionId)}`,
      `کاربر: ${user?.telegramId.toString() ?? "-"}`,
      `پرداخت اصلی: ${
        primaryPayment !== null
          ? `${primaryPayment.provider ?? "-"} (${shortId(primaryPayment.id)})`
          : "-"
      }`,
      `پرداخت تکراری: ${duplicatePayment.provider ?? "-"} (${shortId(duplicatePayment.id)})`,
      `مبلغ: ${reconciliationCase.expectedAmountToman.toLocaleString("en-US")} تومان`,
      `زمان: ${reconciliationCase.createdAt.toISOString().replace("T", " ").slice(0, 16)} UTC`,
    ].join("\n");

    const owners = await prisma.admin.findMany({
      where: { isActive: true, role: "OWNER" },
      select: { telegramId: true },
    });
    for (const owner of owners) {
      try {
        await api.sendMessage(owner.telegramId.toString(), lines);
      } catch (err) {
        logger.warn("duplicate-success admin alert failed", { error: errorMessage(err) });
      }
    }
  } catch (err) {
    logger.error("duplicate-success notification crashed", { error: errorMessage(err) });
  }
}

// --- admin read-only queue ----------------------------------------------------------------

export const RECONCILIATION_PAGE_SIZE = 5;

export interface ReconciliationCasePage {
  cases: Array<
    FinancialReconciliationCase & {
      userTelegramId: string;
      primaryProvider: string;
      duplicateProvider: string;
      /** Short id of the paid Order the settling payment created (service-username
       * cases). Null when the payment carries no order. */
      settlementOrderShortId: string | null;
    }
  >;
  page: number;
  pages: number;
  total: number;
}

/**
 * Newest-first page of reconciliation cases FILTERED to one
 * {@link FinancialReconciliationType} at the DATABASE query — the count, the page
 * count and the rows are all type-specific, so the two queues (duplicate-success
 * vs. service-username reconciliation) never bleed into each other's totals or
 * pagination. Callers must always pass the type they are rendering.
 */
export async function listReconciliationCases(
  type: FinancialReconciliationType,
  page: number,
): Promise<ReconciliationCasePage> {
  const total = await prisma.financialReconciliationCase.count({ where: { type } });
  const pages = Math.max(1, Math.ceil(total / RECONCILIATION_PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const rows = await prisma.financialReconciliationCase.findMany({
    where: { type },
    orderBy: { createdAt: "desc" },
    skip: (current - 1) * RECONCILIATION_PAGE_SIZE,
    take: RECONCILIATION_PAGE_SIZE,
  });
  const cases = await Promise.all(rows.map((row) => enrichCase(row)));
  return { cases, page: current, pages, total };
}

async function enrichCase(
  row: FinancialReconciliationCase,
): Promise<ReconciliationCasePage["cases"][number]> {
  const [user, primary, duplicate] = await Promise.all([
    prisma.user.findUnique({ where: { id: row.userId }, select: { telegramId: true } }),
    row.primaryPaymentId !== null
      ? prisma.payment.findUnique({
          where: { id: row.primaryPaymentId },
          select: { provider: true },
        })
      : Promise.resolve(null),
    prisma.payment.findUnique({
      where: { id: row.duplicatePaymentId },
      select: { provider: true, orderId: true },
    }),
  ]);
  return {
    ...row,
    userTelegramId: user?.telegramId.toString() ?? "-",
    primaryProvider: primary?.provider ?? "-",
    duplicateProvider: duplicate?.provider ?? "-",
    settlementOrderShortId:
      duplicate?.orderId !== undefined && duplicate.orderId !== null
        ? duplicate.orderId.slice(0, 8)
        : null,
  };
}

/** One case by 8-char short id (prefix match, ambiguity fails safe). */
export async function getReconciliationCaseByShortId(
  shortIdValue: string,
): Promise<ReconciliationCasePage["cases"][number] | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortIdValue)) {
    return null;
  }
  const matches = await prisma.financialReconciliationCase.findMany({
    where: { id: { startsWith: shortIdValue } },
    take: 2,
  });
  if (matches.length !== 1) {
    return null;
  }
  return enrichCase(matches[0]);
}

/** The existing case for a duplicate payment (settlement retry path). */
export async function findCaseForDuplicatePayment(
  duplicatePaymentId: string,
): Promise<FinancialReconciliationCase | null> {
  return prisma.financialReconciliationCase.findUnique({ where: { duplicatePaymentId } });
}

// --- service-username retry-bind (§4) -----------------------------------------------------

/** Typed outcome of an OWNER retry-bind attempt on a SERVICE_USERNAME_UNBOUND case. */
export type RetryBindResult =
  | { ok: true; orderId: string; userId: string }
  | {
      ok: false;
      reason: "NOT_FOUND" | "WRONG_TYPE" | "NO_ORDER" | "NO_CHECKOUT" | "BIND_FAILED";
    };

/**
 * The OWNER-only «بررسی مجدد رزرو و ادامه ساخت» action (§4). Inside ONE
 * transaction it: locks the reconciliation case row (serializing concurrent
 * button presses); requires it to be a SERVICE_USERNAME_UNBOUND case that is
 * still OPEN/IN_REVIEW; reads the reservation identity ONLY from the immutable
 * CheckoutSession snapshot; and re-runs the SAME strict
 * {@link bindSettledReservationFromSnapshot}/attachReservationToOrder contract
 * (exact user + checkout + panel + username + order in BOUND state, row-locked).
 * It marks the case RESOLVED (with OWNER audit identity + timestamp) ONLY after a
 * successful exact bind — a still-impossible bind leaves the case blocking and
 * changes nothing. It NEVER regenerates or substitutes the username, and never
 * marks a case resolved without a real bind. The CALLER dispatches the paid Order
 * fulfillment once after this commits (idempotent). Already-RESOLVED is reported
 * as NO_ORDER only if the order vanished; otherwise the caller re-dispatches.
 */
export async function retryBindServiceUsernameUnboundCase(
  caseId: string,
  adminId: string,
): Promise<RetryBindResult> {
  return prisma.$transaction(async (tx) => {
    // 1. Lock the case row FOR UPDATE so concurrent retry presses serialize.
    const locked = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM "FinancialReconciliationCase" WHERE id = ${caseId} FOR UPDATE`,
    );
    if (locked.length === 0) {
      return { ok: false, reason: "NOT_FOUND" };
    }
    const rc = await tx.financialReconciliationCase.findUnique({ where: { id: caseId } });
    if (rc === null) {
      return { ok: false, reason: "NOT_FOUND" };
    }
    // 2. Require the exact type. Only OPEN/IN_REVIEW cases are re-bindable; an
    //    already-RESOLVED case is idempotent — report its order so the caller can
    //    re-dispatch fulfillment (which is itself idempotent).
    if (rc.type !== FinancialReconciliationType.SERVICE_USERNAME_UNBOUND) {
      return { ok: false, reason: "WRONG_TYPE" };
    }
    const settlingPayment = await tx.payment.findUnique({
      where: { id: rc.duplicatePaymentId },
    });
    if (settlingPayment === null || settlingPayment.orderId === null) {
      return { ok: false, reason: "NO_ORDER" };
    }
    if (rc.status === FinancialReconciliationStatus.RESOLVED) {
      return { ok: true, orderId: settlingPayment.orderId, userId: rc.userId };
    }
    // 3. Load the exact checkout + order.
    const checkout = await tx.checkoutSession.findUnique({
      where: { id: rc.checkoutSessionId },
    });
    if (checkout === null) {
      return { ok: false, reason: "NO_CHECKOUT" };
    }
    const order = await tx.order.findUnique({ where: { id: settlingPayment.orderId } });
    if (order === null) {
      return { ok: false, reason: "NO_ORDER" };
    }
    // 4-7. Reservation identity ONLY from the immutable snapshot; the SAME strict
    //      bind (exact user/checkout/panel/username/order + BOUND, row-locked).
    const snapshot = (checkout.productSnapshot ?? {}) as Record<string, unknown>;
    const bind = await bindSettledReservationFromSnapshot(tx, snapshot, {
      userId: rc.userId,
      checkoutSessionId: rc.checkoutSessionId,
      orderId: order.id,
    });
    if (!bind.bound) {
      // 8 (negative): still impossible — do NOT resolve, do NOT provision.
      return { ok: false, reason: "BIND_FAILED" };
    }
    // 8. Only after a successful EXACT bind: mark RESOLVED + OWNER audit identity.
    await tx.financialReconciliationCase.update({
      where: { id: rc.id },
      data: {
        status: FinancialReconciliationStatus.RESOLVED,
        resolvedAt: new Date(),
        resolvedByAdminId: adminId,
      },
    });
    return { ok: true, orderId: order.id, userId: rc.userId };
  });
}

/** Status label used by the read-only admin pages. */
export function reconciliationStatusLabel(status: FinancialReconciliationStatus): string {
  switch (status) {
    case FinancialReconciliationStatus.OPEN:
      return "نیازمند بررسی";
    case FinancialReconciliationStatus.IN_REVIEW:
      return "در حال بررسی";
    case FinancialReconciliationStatus.RESOLVED:
      return "بررسی‌شده";
  }
}

/** Non-owner payments that still count as duplicate-review targets. */
export function isReviewablePaymentStatus(status: PaymentStatus): boolean {
  return status === PaymentStatus.PENDING || status === PaymentStatus.PROCESSING;
}
