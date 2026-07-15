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
  }
  return result;
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
    }
  >;
  page: number;
  pages: number;
  total: number;
}

/** Newest-first page of duplicate-success cases for the admin queue. */
export async function listReconciliationCases(page: number): Promise<ReconciliationCasePage> {
  const total = await prisma.financialReconciliationCase.count();
  const pages = Math.max(1, Math.ceil(total / RECONCILIATION_PAGE_SIZE));
  const current = Math.min(Math.max(1, page), pages);
  const rows = await prisma.financialReconciliationCase.findMany({
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
      select: { provider: true },
    }),
  ]);
  return {
    ...row,
    userTelegramId: user?.telegramId.toString() ?? "-",
    primaryProvider: primary?.provider ?? "-",
    duplicateProvider: duplicate?.provider ?? "-",
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
