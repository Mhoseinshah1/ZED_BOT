import {
  CheckoutStatus,
  OrderStatus,
  ServiceUsernameReservationStatus,
  prisma,
} from "@zedbot/database";
import { createLogger, errorMessage } from "@zedbot/shared";

// =============================================================================
// Service-checkout username reservation cleanup (feat/service-checkout-username-note).
// A bounded, idempotent, race-safe DB sweep that reclaims username slots the
// buyer never used. The database is the sole authority: every transition is a
// CAS updateMany with a status guard, so a concurrent settlement / provisioning
// path can never lose a race to the sweep. Two passes:
//
//   1. HELD past its short TTL  → EXPIRED  (abandoned pre-checkout selection)
//   2. BOUND to a dead checkout → EXPIRED  (checkout EXPIRED/CANCELLED/refunded,
//        no surviving PAID/PROVISIONING/COMPLETED order, no Service) — a BOUND
//        row is NEVER reclaimed on the HELD TTL and NEVER while its durable
//        checkout/payment/order/service is still alive.
//
// CONSUMED reservations (a Service exists) are terminal-success and are never
// touched. Work is bounded per run (SCAN_BATCH × MAX_BATCHES) and the loop is
// safe to run on any cadence and across worker restarts. It logs only COUNTS —
// never a username, note, reservation id, or any owner identifier.
// =============================================================================

const log = createLogger("worker:reservation-cleanup");

/** Max rows examined per batch (bounded work — mirrors the scan-batch pattern). */
const SCAN_BATCH = 500;
/** Max batches per pass per run, so one sweep can never run unbounded. */
const MAX_BATCHES = 20;
/** How often the sweep runs. Idempotent, so any cadence is safe. */
export const RESERVATION_CLEANUP_INTERVAL_MS = 5 * 60_000;

/** Checkout states that mean the checkout will never settle. */
const DEAD_CHECKOUT_STATUSES: CheckoutStatus[] = [
  CheckoutStatus.EXPIRED,
  CheckoutStatus.CANCELLED,
  CheckoutStatus.FAILED_REFUNDED,
];
/** Order states that free a reservation (the purchase did not / no longer holds it). */
const DEAD_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.CANCELLED,
  OrderStatus.FAILED,
  OrderStatus.REFUNDED,
];

export interface ReservationCleanupResult {
  expiredHeld: number;
  expiredBound: number;
}

/** Reclaim HELD reservations whose short TTL has passed. */
async function expireStaleHeld(now: Date): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const rows = await prisma.serviceUsernameReservation.findMany({
      where: {
        status: ServiceUsernameReservationStatus.HELD,
        expiresAt: { not: null, lt: now },
      },
      select: { id: true },
      take: SCAN_BATCH,
    });
    if (rows.length === 0) {
      break;
    }
    // CAS on status=HELD: a row that BOUND since the read is skipped.
    const updated = await prisma.serviceUsernameReservation.updateMany({
      where: {
        id: { in: rows.map((r) => r.id) },
        status: ServiceUsernameReservationStatus.HELD,
      },
      data: {
        status: ServiceUsernameReservationStatus.EXPIRED,
        activeUsernameKey: null,
        releasedAt: now,
      },
    });
    total += updated.count;
    if (rows.length < SCAN_BATCH) {
      break;
    }
  }
  return total;
}

/** Reclaim BOUND reservations whose linked checkout/order is dead and Service-less. */
async function expireDeadBound(now: Date): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const rows = await prisma.serviceUsernameReservation.findMany({
      where: {
        status: ServiceUsernameReservationStatus.BOUND,
        // Never reclaim a reservation that already produced a Service.
        serviceId: null,
        // Its checkout has terminally failed / expired…
        checkoutSession: { status: { in: DEAD_CHECKOUT_STATUSES } },
        // …and there is no surviving order that still owns the username.
        OR: [{ orderId: null }, { order: { status: { in: DEAD_ORDER_STATUSES } } }],
      },
      select: { id: true },
      take: SCAN_BATCH,
    });
    if (rows.length === 0) {
      break;
    }
    // CAS on status=BOUND + serviceId still null: a row consumed since the read
    // (a Service was created) is skipped.
    const updated = await prisma.serviceUsernameReservation.updateMany({
      where: {
        id: { in: rows.map((r) => r.id) },
        status: ServiceUsernameReservationStatus.BOUND,
        serviceId: null,
      },
      data: {
        status: ServiceUsernameReservationStatus.EXPIRED,
        activeUsernameKey: null,
        releasedAt: now,
      },
    });
    total += updated.count;
    if (rows.length < SCAN_BATCH) {
      break;
    }
  }
  return total;
}

/** One bounded, idempotent cleanup pass. Never throws to the caller's loop. */
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
