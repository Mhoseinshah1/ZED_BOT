import {
  OrderStatus,
  prisma,
  ServiceStatus,
  UserStatus,
  WalletTransactionSource,
  WalletTransactionType,
  type Order,
  type Payment,
  type Prisma,
  type Service,
  type User,
  type WalletTransaction,
} from "@zedbot/database";
import { errorMessage } from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { OPS_EVENTS, writeSystemLog } from "./system-log.service.js";
import { onWalletBalanceChanged } from "./low-balance/low-balance-hook.js";

// =============================================================================
// Admin manual wallet management (Phase 20): an admin increases/decreases a
// selected user's balance with a mandatory reason. Every change is atomic,
// writes an accurate WalletTransaction ledger row and can NEVER drive the
// balance negative (the decrease is a conditional updateMany, the same
// pattern as the Phase 15 wallet-payment race fix). No CheckoutSession, no
// Payment, no Order, no panel calls, no provisioning - only User counters +
// one WalletTransaction per applied change.
//
// Enum mapping (schema already has dedicated values - no migration):
//   increase -> type MANUAL_ADD,    source ADMIN, user.totalManualAddedToman
//   decrease -> type MANUAL_DEDUCT, source ADMIN, user.totalManualDeductedToman
//   WalletTransaction.adminId = acting Admin.id; WalletTransaction.reason =
//   the admin-entered text (the type/source/adminId columns are the machine
//   identifiers, so no ADMIN_MANUAL_* magic reason string is needed).
// =============================================================================

export type WalletAdjustAction = "INCREASE" | "DECREASE";

export const MAX_MANUAL_ADJUST_TOMAN = 100_000_000;
export const REASON_MIN_LENGTH = 3;
export const REASON_MAX_LENGTH = 500;

export const TARGET_NOT_FOUND_TEXT = "کاربر یافت نشد.";
export const INSUFFICIENT_USER_BALANCE_TEXT = "موجودی کاربر نمی‌تواند منفی شود.";
export const ADJUST_FAILED_TEXT = "ثبت تغییر موجودی با خطا مواجه شد. لطفاً دوباره تلاش کنید.";
export const INVALID_AMOUNT_TEXT = "مبلغ نامعتبر است.";
export const INVALID_REASON_TEXT = `دلیل باید بین ${REASON_MIN_LENGTH} تا ${REASON_MAX_LENGTH} کاراکتر باشد.`;

/** Amount must be a positive safe integer within the manual-adjust cap. */
export function isValidAdjustAmount(amountToman: number): boolean {
  return (
    Number.isSafeInteger(amountToman) && amountToman > 0 && amountToman <= MAX_MANUAL_ADJUST_TOMAN
  );
}

/** Reason is mandatory: trimmed free text, 3..500 characters. */
export function normalizeAdjustReason(raw: string): string | null {
  const reason = raw.trim();
  return reason.length >= REASON_MIN_LENGTH && reason.length <= REASON_MAX_LENGTH ? reason : null;
}

// --- admin-side user lookup ---------------------------------------------------------

const SEARCH_LIMIT = 10;

/**
 * Admin user search. Numeric input matches the exact telegramId (and phone
 * numbers containing the digits); "@name" matches the exact username
 * (case-insensitive); anything else searches username/first/last/phone.
 * Capped at 10 results, newest first.
 */
export async function searchUsersForAdmin(rawQuery: string): Promise<User[]> {
  const query = rawQuery.trim();
  if (query === "" || query.length > 100) {
    return [];
  }
  if (/^\d+$/.test(query)) {
    const or: Prisma.UserWhereInput[] = [{ phoneNumber: { contains: query } }];
    if (query.length <= 15) {
      or.push({ telegramId: BigInt(query) });
    }
    return prisma.user.findMany({ where: { OR: or }, orderBy: { createdAt: "desc" }, take: SEARCH_LIMIT });
  }
  // Fix C: internal short id (uuid prefix) - exact prefix, ambiguity-safe.
  if (/^[0-9a-f]{4,32}$/i.test(query) || /^[0-9a-f-]{9,36}$/i.test(query)) {
    const byShortId = await getAdminTargetUserByShortId(query.toLowerCase());
    if (byShortId !== null) {
      return [byShortId];
    }
  }
  if (query.startsWith("@")) {
    const username = query.slice(1);
    if (username === "") {
      return [];
    }
    return prisma.user.findMany({
      where: { username: { equals: username, mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
      take: SEARCH_LIMIT,
    });
  }
  return prisma.user.findMany({
    where: {
      OR: [
        { username: { contains: query, mode: "insensitive" } },
        { firstName: { contains: query, mode: "insensitive" } },
        { lastName: { contains: query, mode: "insensitive" } },
        { phoneNumber: { contains: query } },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: SEARCH_LIMIT,
  });
}

/** Newest users for the «کاربران اخیر 👤» shortcut. */
export async function listRecentUsers(limit = 5): Promise<User[]> {
  return prisma.user.findMany({ orderBy: { createdAt: "desc" }, take: limit });
}

/**
 * Resolves a target user by uuid-prefix short id (admin context - any user).
 * Unknown or AMBIGUOUS prefixes come back null; ambiguity must fail, never
 * pick one of two users.
 */
export async function getAdminTargetUserByShortId(shortId: string): Promise<User | null> {
  if (!/^[0-9a-f-]{4,32}$/i.test(shortId)) {
    return null;
  }
  const matches = await prisma.user.findMany({ where: { id: { startsWith: shortId } }, take: 2 });
  return matches.length === 1 ? matches[0] : null;
}

/** Exact-id re-read for steps that already hold the full target user id. */
export async function getUserById(userId: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id: userId } });
}

/** Latest wallet transactions for the admin wallet page (newest first). */
export async function listUserWalletTransactionsForAdmin(
  userId: string,
  limit = 5,
): Promise<WalletTransaction[]> {
  return prisma.walletTransaction.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

// --- Fix C: user landing filters, overview and read-only sub-lists ------------------

export const ADMIN_USERS_PAGE_SIZE = 10;

/**
 * Landing filter -> UserStatus mapping (documented; no new statuses):
 *   کاربران فعال ✅  -> ACTIVE
 *   کاربران مسدود 🚫 -> BLOCKED
 *   کاربران غیرفعال ⏸ -> DISABLED (DELETED stays out of every list)
 */
export const USER_LIST_FILTER_STATUS: Record<"a" | "b" | "d", UserStatus> = {
  a: UserStatus.ACTIVE,
  b: UserStatus.BLOCKED,
  d: UserStatus.DISABLED,
};

export interface AdminUserListPage {
  users: User[];
  page: number;
  pages: number;
  total: number;
}

/** Paged user list for the landing filters ("r" = recent, any status but DELETED). */
export async function listUsersForAdmin(
  filter: "r" | "a" | "b" | "d",
  page: number,
): Promise<AdminUserListPage> {
  const where: Prisma.UserWhereInput =
    filter === "r"
      ? { status: { not: UserStatus.DELETED } }
      : { status: USER_LIST_FILTER_STATUS[filter] };
  const total = await prisma.user.count({ where });
  const pages = Math.max(1, Math.ceil(total / ADMIN_USERS_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  const users = await prisma.user.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: (safePage - 1) * ADMIN_USERS_PAGE_SIZE,
    take: ADMIN_USERS_PAGE_SIZE,
  });
  return { users, page: safePage, pages, total };
}

export interface AdminUserOverview {
  services: number;
  activeServices: number;
  orders: number;
  pendingOrders: number;
  paidOrders: number;
  payments: number;
  tickets: number;
  referralCount: number;
  referrer: Pick<User, "telegramId" | "username"> | null;
}

/** Read-only counters for the Fix C user detail page. */
export async function getAdminUserOverview(user: User): Promise<AdminUserOverview> {
  const [services, activeServices, orders, pendingOrders, paidOrders, payments, tickets, referralCount, referrer] =
    await Promise.all([
      prisma.service.count({
        where: { userId: user.id, deletedAt: null, status: { not: ServiceStatus.DELETED } },
      }),
      prisma.service.count({
        where: { userId: user.id, deletedAt: null, status: ServiceStatus.ACTIVE },
      }),
      prisma.order.count({ where: { userId: user.id } }),
      prisma.order.count({
        where: {
          userId: user.id,
          status: {
            in: [OrderStatus.PENDING_PAYMENT, OrderStatus.WAITING_RECEIPT, OrderStatus.PENDING_REVIEW],
          },
        },
      }),
      prisma.order.count({
        where: {
          userId: user.id,
          status: { in: [OrderStatus.PAID, OrderStatus.PROVISIONING, OrderStatus.COMPLETED] },
        },
      }),
      prisma.payment.count({ where: { userId: user.id } }),
      prisma.supportTicket.count({ where: { userId: user.id } }),
      prisma.user.count({ where: { referrerId: user.id } }),
      user.referrerId === null
        ? Promise.resolve(null)
        : prisma.user.findUnique({
            where: { id: user.referrerId },
            select: { telegramId: true, username: true },
          }),
    ]);
  return {
    services,
    activeServices,
    orders,
    pendingOrders,
    paidOrders,
    payments,
    tickets,
    referralCount,
    referrer,
  };
}

export interface AdminSubListPage<T> {
  rows: T[];
  page: number;
  pages: number;
  total: number;
}

async function pagedFor<T>(
  count: () => Promise<number>,
  rows: (skip: number, take: number) => Promise<T[]>,
  page: number,
): Promise<AdminSubListPage<T>> {
  const total = await count();
  const pages = Math.max(1, Math.ceil(total / ADMIN_USERS_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), pages);
  return {
    rows: await rows((safePage - 1) * ADMIN_USERS_PAGE_SIZE, ADMIN_USERS_PAGE_SIZE),
    page: safePage,
    pages,
    total,
  };
}

/** Read-only: one user's services, newest first (never secrets/links). */
export async function listUserServicesForAdmin(
  userId: string,
  page: number,
): Promise<AdminSubListPage<Service>> {
  const where = { userId, deletedAt: null, status: { not: ServiceStatus.DELETED } } as const;
  return pagedFor(
    () => prisma.service.count({ where }),
    (skip, take) =>
      prisma.service.findMany({ where, orderBy: { createdAt: "desc" }, skip, take }),
    page,
  );
}

/** Read-only: one user's orders, newest first. */
export async function listUserOrdersForAdmin(
  userId: string,
  page: number,
): Promise<AdminSubListPage<Order>> {
  return pagedFor(
    () => prisma.order.count({ where: { userId } }),
    (skip, take) =>
      prisma.order.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, skip, take }),
    page,
  );
}

/** Read-only: one user's payments, newest first. */
export async function listUserPaymentsForAdmin(
  userId: string,
  page: number,
): Promise<AdminSubListPage<Payment>> {
  return pagedFor(
    () => prisma.payment.count({ where: { userId } }),
    (skip, take) =>
      prisma.payment.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, skip, take }),
    page,
  );
}

// --- Fix C: block / unblock ----------------------------------------------------------

export type SetUserBlockedOutcome =
  | { ok: true; user: User }
  | { ok: false; safeMessage: string };

/**
 * Guarded status flip: block only ACTIVE -> BLOCKED, unblock only
 * BLOCKED -> ACTIVE (updateMany status guard - a stale confirmation cannot
 * overwrite DISABLED/DELETED). No other user field, no wallet, no orders.
 */
export async function setUserBlocked(
  userId: string,
  blocked: boolean,
): Promise<SetUserBlockedOutcome> {
  const applied = await prisma.user.updateMany({
    where: {
      id: userId,
      status: blocked ? UserStatus.ACTIVE : UserStatus.BLOCKED,
    },
    data: { status: blocked ? UserStatus.BLOCKED : UserStatus.ACTIVE },
  });
  if (applied.count !== 1) {
    return { ok: false, safeMessage: "وضعیت کاربر تغییر کرده است؛ صفحه را دوباره باز کنید." };
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  logger.info("admin user block state changed", { userId, blocked });
  return { ok: true, user };
}

// --- the adjustment itself ---------------------------------------------------------

export interface AdjustUserWalletArgs {
  targetUserId: string;
  /** Acting Admin.id (goes to WalletTransaction.adminId). */
  adminId: string;
  action: WalletAdjustAction;
  amountToman: number;
  reason: string;
}

export type AdjustUserWalletOutcome =
  | { ok: true; user: User; walletTransaction: WalletTransaction }
  | { ok: false; error: string; safeMessage: string };

/** Thrown inside the transaction to abort with a safe admin-facing error. */
class AdjustAbort extends Error {
  constructor(
    readonly safeMessage: string,
    readonly internalReason: string,
  ) {
    super("wallet adjust aborted");
  }
}

/**
 * Applies one manual adjustment atomically. INCREASE is a plain increment
 * (throws if the user vanished). DECREASE is a CONDITIONAL updateMany
 * filtered on balanceToman >= amount - PostgreSQL re-evaluates the condition
 * on the committed row under the row lock, so concurrent decreases can never
 * drive the balance negative; the loser matches 0 rows, writes NO
 * WalletTransaction and the whole transaction rolls back. Ledger values are
 * read back from the still-locked row, never from a stale pre-read.
 */
export async function adjustUserWallet(
  args: AdjustUserWalletArgs,
): Promise<AdjustUserWalletOutcome> {
  if (!isValidAdjustAmount(args.amountToman)) {
    return { ok: false, error: "invalid amount", safeMessage: INVALID_AMOUNT_TEXT };
  }
  const reason = normalizeAdjustReason(args.reason);
  if (reason === null) {
    return { ok: false, error: "invalid reason", safeMessage: INVALID_REASON_TEXT };
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      let updated: User;
      if (args.action === "INCREASE") {
        const applied = await tx.user.updateMany({
          where: { id: args.targetUserId },
          data: {
            balanceToman: { increment: args.amountToman },
            totalManualAddedToman: { increment: args.amountToman },
          },
        });
        if (applied.count !== 1) {
          throw new AdjustAbort(TARGET_NOT_FOUND_TEXT, "target user not found");
        }
        updated = await tx.user.findUniqueOrThrow({ where: { id: args.targetUserId } });
      } else {
        // SECURITY-CRITICAL: atomic check-and-deduct (same pattern as the
        // wallet-payment race fix). 0 rows = insufficient funds or missing
        // user - nothing is written either way.
        const applied = await tx.user.updateMany({
          where: { id: args.targetUserId, balanceToman: { gte: args.amountToman } },
          data: {
            balanceToman: { decrement: args.amountToman },
            totalManualDeductedToman: { increment: args.amountToman },
          },
        });
        if (applied.count !== 1) {
          const exists = await tx.user.findUnique({
            where: { id: args.targetUserId },
            select: { id: true },
          });
          throw exists === null
            ? new AdjustAbort(TARGET_NOT_FOUND_TEXT, "target user not found")
            : new AdjustAbort(INSUFFICIENT_USER_BALANCE_TEXT, "insufficient balance");
        }
        updated = await tx.user.findUniqueOrThrow({ where: { id: args.targetUserId } });
      }

      const balanceAfter = updated.balanceToman;
      const balanceBefore =
        args.action === "INCREASE"
          ? balanceAfter - args.amountToman
          : balanceAfter + args.amountToman;
      const walletTransaction = await tx.walletTransaction.create({
        data: {
          userId: args.targetUserId,
          amountToman: args.amountToman,
          type:
            args.action === "INCREASE"
              ? WalletTransactionType.MANUAL_ADD
              : WalletTransactionType.MANUAL_DEDUCT,
          source: WalletTransactionSource.ADMIN,
          reason,
          adminId: args.adminId,
          balanceBeforeToman: balanceBefore,
        balanceAfterToman: balanceAfter,
        },
      });

      // Low-balance state machine: same transaction, committed balance, no I/O.
      await onWalletBalanceChanged(tx, {
        userId: args.targetUserId,
        balanceBeforeToman: balanceBefore,
        balanceAfterToman: balanceAfter,
        source: "ADMIN_ADJUSTMENT",
      });
      return { user: updated, walletTransaction };
    });
    logger.info("admin wallet adjustment applied", {
      targetUserId: args.targetUserId,
      adminId: args.adminId,
      action: args.action,
      amountToman: args.amountToman,
    });
    // Ops log (AUDIT topic) - action/amount only, never the free-text reason.
    void writeSystemLog({
      level: "WARN",
      eventType: OPS_EVENTS.WALLET_MANUAL_ADJUSTED,
      message: "user wallet manually adjusted by admin",
      metadata: { action: args.action, amountToman: args.amountToman },
      topicKey: "AUDIT",
      userId: args.targetUserId,
      adminId: args.adminId,
    });
    return { ok: true, ...result };
  } catch (err) {
    if (err instanceof AdjustAbort) {
      return { ok: false, error: err.internalReason, safeMessage: err.safeMessage };
    }
    logger.error("admin wallet adjustment failed", {
      targetUserId: args.targetUserId,
      adminId: args.adminId,
      action: args.action,
      error: errorMessage(err),
    });
    return { ok: false, error: errorMessage(err), safeMessage: ADJUST_FAILED_TEXT };
  }
}
