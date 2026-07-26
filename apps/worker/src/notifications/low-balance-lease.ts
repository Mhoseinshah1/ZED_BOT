import { prisma } from "@zedbot/database";
import { randomUUID } from "node:crypto";

// =============================================================================
// The low-balance reconciliation LEASE.
//
// Replaces `pg_try_advisory_lock`. A session-level advisory lock taken through
// Prisma's connection pool is not safe: the lock and its unlock can be issued
// on different pooled connections, so the unlock may target a session that does
// not hold it (leaving the real holder locked until its connection is recycled)
// or fail silently. Nothing in the pool guarantees affinity.
//
// A durable lease has neither failure mode, and it degrades better: a worker
// that crashes mid-sweep does not strand the lock, because the lease simply
// expires and the next tick takes it over.
//
// It follows the claim convention the notification maintenance worker already
// uses — a conditional `updateMany` as the atomic claim plus a bounded-age
// takeover — rather than inventing a second coordination framework.
// =============================================================================

/** How long a claim is held. Comfortably longer than one bounded sweep. */
export const LEASE_DURATION_MS = 5 * 60_000;

export interface ReconciliationLease {
  ownerToken: string;
  initCursorUserId: string | null;
  repairCursorId: string | null;
}

/** Ensures the singleton control row exists, without ever raising on a race. */
async function ensureRow(): Promise<void> {
  await prisma.lowBalanceReconciliationState.createMany({
    data: [{ singletonKey: "default" }],
    skipDuplicates: true,
  });
}

/**
 * Tries to take the lease.
 *
 * Atomic: the WHERE clause admits only an unheld or expired lease, so of N
 * concurrent replicas exactly one gets `count === 1`. Returns null when another
 * replica holds it — the caller returns immediately rather than blocking.
 */
export async function acquireLease(now: Date): Promise<ReconciliationLease | null> {
  await ensureRow();
  const ownerToken = randomUUID();
  const claimed = await prisma.lowBalanceReconciliationState.updateMany({
    where: {
      singletonKey: "default",
      OR: [{ ownerToken: null }, { leaseExpiresAt: null }, { leaseExpiresAt: { lt: now } }],
    },
    data: {
      ownerToken,
      leaseExpiresAt: new Date(now.getTime() + LEASE_DURATION_MS),
      lastSweepStartedAt: now,
    },
  });
  if (claimed.count !== 1) {
    return null;
  }
  const row = await prisma.lowBalanceReconciliationState.findUnique({
    where: { singletonKey: "default" },
    select: { ownerToken: true, initCursorUserId: true, repairCursorId: true },
  });
  // Between the claim and this read another replica could only have taken over
  // if our lease had already expired, which a bounded sweep cannot outlive.
  if (row === null || row.ownerToken !== ownerToken) {
    return null;
  }
  return {
    ownerToken,
    initCursorUserId: row.initCursorUserId,
    repairCursorId: row.repairCursorId,
  };
}

/**
 * Persists cursor progress, guarded on still holding the lease.
 *
 * Called after every committed batch, so an interrupted sweep resumes where it
 * stopped instead of rescanning the first page forever. Returns false when the
 * lease was lost, which tells the caller to stop touching shared state.
 */
export async function saveProgress(
  ownerToken: string,
  cursors: { initCursorUserId?: string | null; repairCursorId?: string | null },
): Promise<boolean> {
  const updated = await prisma.lowBalanceReconciliationState.updateMany({
    where: { singletonKey: "default", ownerToken },
    data: cursors,
  });
  return updated.count === 1;
}

/** Extends the lease mid-sweep. False means it was lost; stop working. */
export async function renewLease(ownerToken: string, now: Date): Promise<boolean> {
  const updated = await prisma.lowBalanceReconciliationState.updateMany({
    // The lease must be STILL VALID to be renewed. Matching on the token alone
    // would let a worker whose lease already expired silently reclaim the sweep
    // after another worker had taken it over.
    where: { singletonKey: "default", ownerToken, leaseExpiresAt: { gt: now } },
    data: { leaseExpiresAt: new Date(now.getTime() + LEASE_DURATION_MS) },
  });
  return updated.count === 1;
}

/**
 * Releases the lease.
 *
 * `completed` means the sweep reached the end of both phases, so the cursors
 * wrap to the beginning — otherwise a table whose tail is clean would pin the
 * cursor there and never re-examine the head.
 */
export async function releaseLease(
  ownerToken: string,
  now: Date,
  completed: boolean,
): Promise<void> {
  await prisma.lowBalanceReconciliationState.updateMany({
    where: { singletonKey: "default", ownerToken },
    data: completed
      ? {
          ownerToken: null,
          leaseExpiresAt: null,
          initCursorUserId: null,
          repairCursorId: null,
          lastSweepCompletedAt: now,
          completedSweepCount: { increment: 1 },
        }
      : { ownerToken: null, leaseExpiresAt: null },
  });
}
