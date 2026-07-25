import { prisma } from "@zedbot/database";
import { createLogger, errorMessage } from "@zedbot/shared";

// =============================================================================
// Service-checkout username reservation cleanup (feat/service-checkout-username-note,
// hardened by fix/service-username-reservation-safety §7). A bounded, idempotent,
// RACE-SAFE DB sweep that reclaims username slots the buyer never used. The
// database is the sole authority. Two passes, each a SINGLE conditional UPDATE
// (no read-then-update TOCTOU): the candidate selection, the row lock and the
// state transition all happen in one statement, so a concurrent settlement can
// never lose a race to the sweep.
//
//   1. HELD past its short TTL          → EXPIRED  (abandoned pre-checkout pick)
//   2. BOUND with no live durable owner → EXPIRED  where its checkout is
//        terminally dead OR (still PENDING but past its expiry — the gap that a
//        never-flipped expired checkout previously left the slot leaking), AND
//        there is NO settleable Payment, NO PAID/PROVISIONING/COMPLETED Order
//        (by checkout OR by the reservation's own orderId), and NO Service.
//
// Each candidate SELECT uses `FOR UPDATE ... SKIP LOCKED`, and every settlement
// path locks the reservation row for the whole settlement transaction (see
// lockReservationForSettlement in the reservation service). So a reservation that
// is actively settling is SKIPPED here and is never expired out from under a
// payment — "a successfully settling reservation can never become EXPIRED".
//
// CONSUMED reservations (a Service exists) are terminal-success and never touched.
// Work is bounded per run (SCAN_BATCH × MAX_BATCHES). It logs only COUNTS — never
// a username, note, reservation id, or any owner identifier.
// =============================================================================

const log = createLogger("worker:reservation-cleanup");

/** Max rows expired per batch (bounded work — mirrors the scan-batch pattern). */
const SCAN_BATCH = 500;
/** Max batches per pass per run, so one sweep can never run unbounded. */
const MAX_BATCHES = 20;
/** How often the sweep runs. Idempotent, so any cadence is safe. */
export const RESERVATION_CLEANUP_INTERVAL_MS = 5 * 60_000;

export interface ReservationCleanupResult {
  expiredHeld: number;
  expiredBound: number;
}

// =============================================================================
// THE shared "settleable payment" definition (hotfix §1). A reservation must be
// treated as live while ANY linked payment can still legitimately settle, not
// only an already-APPROVED one. A payment is settleable when it is in a
// non-terminal local status, OR its provider already confirmed SUCCESS but local
// settlement has not completed (awaiting settlement recovery / reconciliation),
// OR it is under duplicate-success review. Terminal-dead statuses (REJECTED,
// FAILED, EXPIRED, CANCELLED, DELETED) with no provider success are NOT settleable.
//
// This is the SINGLE source of truth used by both the cleanup SQL below and the
// cleanup tests (which import these to build/assert states). Keep the SQL fragment
// and the status list in lock-step.
// =============================================================================

/** Non-terminal local PaymentStatus values that can still settle. */
export const SETTLEABLE_PAYMENT_STATUSES = [
  "PENDING",
  "PENDING_REVIEW",
  "PROCESSING",
  "APPROVED",
] as const;

/**
 * SQL predicate (Postgres) for a settleable payment `p` linked to checkout `c`.
 * Kept identical in meaning to {@link SETTLEABLE_PAYMENT_STATUSES} plus the
 * provider-success-awaiting-settlement and duplicate-success-review cases. Uses
 * only static literals (no user input), so it is embedded verbatim.
 */
export const SETTLEABLE_PAYMENT_SQL = `
  p."checkoutSessionId" = c.id
  AND (
    p.status IN ('PENDING', 'PENDING_REVIEW', 'PROCESSING', 'APPROVED')
    OR (p."providerStatus" = 'SUCCESS' AND p."settlementStatus" <> 'SETTLED')
    OR p."settlementStatus" = 'DUPLICATE_SUCCESS_REVIEW'
  )
`;

/**
 * Reclaim HELD reservations whose short TTL has passed. Single conditional UPDATE
 * per batch: the guard `status='HELD' AND expiresAt < now` is re-evaluated under
 * the row lock, and `SKIP LOCKED` skips any hold a checkout claim / wallet payment
 * is actively binding (that claim CAS-guards on `status='HELD'`, so exactly one of
 * the two wins and the other no-ops — the slot is never double-transitioned).
 */
async function expireStaleHeld(now: Date): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const affected = await prisma.$executeRaw`
      UPDATE "ServiceUsernameReservation" AS r
      SET status = 'EXPIRED', "activeUsernameKey" = NULL, "releasedAt" = ${now}
      WHERE r.id IN (
        SELECT r2.id
        FROM "ServiceUsernameReservation" AS r2
        WHERE r2.status = 'HELD'
          AND r2."expiresAt" IS NOT NULL
          AND r2."expiresAt" < ${now}
        FOR UPDATE OF r2 SKIP LOCKED
        LIMIT ${SCAN_BATCH}
      )
    `;
    total += affected;
    if (affected < SCAN_BATCH) {
      break;
    }
  }
  return total;
}

/**
 * Reclaim BOUND reservations whose linked checkout is dead (or a PENDING checkout
 * that has passed its expiry) and that have no live durable owner. Single
 * conditional UPDATE per batch with the COMPLETE liveness predicate inlined as
 * correlated `NOT EXISTS` subqueries, so a settlement that commits before this
 * statement acquires the lock is seen (its Order / APPROVED Payment / flipped
 * checkout status makes the predicate false), and a settlement that is in-flight
 * holds the reservation's `FOR UPDATE` lock — which `SKIP LOCKED` skips.
 */
async function expireDeadBound(now: Date): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    // The `NOT EXISTS (settleable payment)` clause below is SETTLEABLE_PAYMENT_SQL
    // inlined (Prisma tagged templates cannot interpolate a raw SQL fragment
    // without parameterizing it; the fragment is static). It MUST stay identical
    // to SETTLEABLE_PAYMENT_SQL — a payment that can still settle keeps its slot.
    const affected = await prisma.$executeRaw`
      UPDATE "ServiceUsernameReservation" AS r
      SET status = 'EXPIRED', "activeUsernameKey" = NULL, "releasedAt" = ${now}
      WHERE r.id IN (
        SELECT r2.id
        FROM "ServiceUsernameReservation" AS r2
        JOIN "CheckoutSession" AS c ON c.id = r2."checkoutSessionId"
        WHERE r2.status = 'BOUND'
          AND r2."serviceId" IS NULL
          AND (
            c.status IN ('EXPIRED', 'CANCELLED', 'FAILED_REFUNDED')
            OR (c.status = 'PENDING' AND c."expiresAt" <= ${now})
          )
          AND NOT EXISTS (
            SELECT 1 FROM "Payment" p
            WHERE p."checkoutSessionId" = c.id
              AND (
                p.status IN ('PENDING', 'PENDING_REVIEW', 'PROCESSING', 'APPROVED')
                OR (p."providerStatus" = 'SUCCESS' AND p."settlementStatus" <> 'SETTLED')
                OR p."settlementStatus" = 'DUPLICATE_SUCCESS_REVIEW'
              )
          )
          AND NOT EXISTS (
            SELECT 1 FROM "Order" o
            WHERE o."checkoutSessionId" = c.id
              AND o.status IN ('PAID', 'PROVISIONING', 'COMPLETED')
          )
          AND NOT EXISTS (
            SELECT 1 FROM "Order" o2
            WHERE o2.id = r2."orderId"
              AND o2.status IN ('PAID', 'PROVISIONING', 'COMPLETED')
          )
        FOR UPDATE OF r2 SKIP LOCKED
        LIMIT ${SCAN_BATCH}
      )
    `;
    total += affected;
    if (affected < SCAN_BATCH) {
      break;
    }
  }
  return total;
}

/** One bounded, idempotent, race-safe cleanup pass. */
export async function runReservationCleanup(now: Date): Promise<ReservationCleanupResult> {
  const expiredHeld = await expireStaleHeld(now);
  const expiredBound = await expireDeadBound(now);
  if (expiredHeld > 0 || expiredBound > 0) {
    // COUNTS ONLY — never a username / note / reservation id / owner id.
    log.info("service username reservations reclaimed", { expiredHeld, expiredBound });
  }
  return { expiredHeld, expiredBound };
}

/**
 * Immediate run + fixed cadence; returns a stop function. Mirrors the worker's
 * other unconditional maintenance loops (heartbeat, schedule reconciler). A
 * failed pass is logged and swallowed so the loop always survives.
 */
export function startReservationCleanupLoop(nowFn: () => Date = () => new Date()): () => void {
  const tick = async (): Promise<void> => {
    try {
      await runReservationCleanup(nowFn());
    } catch (err) {
      log.warn("reservation cleanup pass failed", { error: errorMessage(err) });
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), RESERVATION_CLEANUP_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
