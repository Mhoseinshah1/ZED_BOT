// =============================================================================
// Service-checkout username selection + reservation
// (feat/service-checkout-username-note). The DB-authoritative engine that turns
// a buyer's chosen (or crypto-random) service username into a durable
// ServiceUsernameReservation. It NEVER mutates a panel: the only remote call is
// the read-only `getServiceAccount` availability probe (no account is created,
// updated or deleted here). All uniqueness is enforced by the database — the
// `(panelId, activeUsernameKey)` filtered-unique index plus Service.username
// @unique — never by an in-memory Set, a Redis-only lock, or session state.
//
// Reservation lifecycle (each transition is a CAS updateMany with a status
// guard, so concurrent settlement / cleanup paths converge deterministically):
//   HELD  → reserveServiceUsername (short TTL while the buyer decides)
//   BOUND → bindReservationToCheckout (attached to a durable CheckoutSession;
//           TTL cleared — expiry then derives from the linked checkout/order)
//   BOUND → attachReservationToOrder (records the settled Order id)
//   CONSUMED → consumeReservationForOrder (a Service row was created)
//   RELEASED → releaseReservation / releaseReservationsForDraft (given up)
// =============================================================================

import {
  Prisma,
  ServiceUsernameMode,
  ServiceUsernameReservationStatus,
  prisma,
  type Panel,
} from "@zedbot/database";
import {
  errorMessage,
  validateServiceUsername,
  generateRandomServiceUsername,
  type ServiceUsernameAvailabilityOutcome,
} from "@zedbot/shared";

import { logger } from "../core/logger.js";
import { buildAdapterForPanel, normalizeSubscriptionBase } from "./panel-adapter-factory.js";

/** How long a HELD (pre-checkout) reservation survives before cleanup may reclaim it. */
export const RESERVATION_HELD_TTL_MS = 30 * 60_000;
/** Bounded number of random candidates tried before giving up (no unbounded loop). */
export const RANDOM_USERNAME_MAX_ATTEMPTS = 10;

/** Reservation states that still OWN the (panelId, username) uniqueness slot. */
const ACTIVE_STATUSES: ServiceUsernameReservationStatus[] = [
  ServiceUsernameReservationStatus.HELD,
  ServiceUsernameReservationStatus.BOUND,
  ServiceUsernameReservationStatus.CONSUMED,
];
/** States still holding a slot that a change/rebind may transition away from. */
const REBINDABLE_STATUSES: ServiceUsernameReservationStatus[] = [
  ServiceUsernameReservationStatus.HELD,
  ServiceUsernameReservationStatus.BOUND,
];

/** A transaction-capable Prisma client (base client or an interactive tx). */
type Db = Prisma.TransactionClient | typeof prisma;

export type ReserveServiceUsernameResult =
  | {
      outcome: "AVAILABLE";
      reservationId: string;
      normalizedUsername: string;
      mode: ServiceUsernameMode;
    }
  | { outcome: Exclude<ServiceUsernameAvailabilityOutcome, "AVAILABLE"> };

// -----------------------------------------------------------------------------
// Availability (read-only)
// -----------------------------------------------------------------------------

/**
 * Read-only availability of a specific normalized username on a panel. Returns a
 * typed outcome and NEVER creates/updates/deletes a remote account. A remote or
 * panel failure returns PANEL_UNAVAILABLE / UNVERIFIABLE — it is never reported
 * as AVAILABLE (no unavailable-as-available on failure).
 */
export async function checkServiceUsernameAvailability(args: {
  panel: Panel;
  normalizedUsername: string;
  /** The caller's own active reservation to ignore (its own prior hold). */
  ignoreReservation?: { userId: string; draftNonce: string | null };
}): Promise<ServiceUsernameAvailabilityOutcome> {
  const { panel, normalizedUsername } = args;

  const validation = validateServiceUsername(normalizedUsername);
  if (!validation.ok || validation.normalized !== normalizedUsername) {
    return "INVALID";
  }
  if (panel.status !== "ACTIVE") {
    return "PANEL_UNAVAILABLE";
  }

  // 1) Local uniqueness — Service.username is GLOBAL, so a name taken on any
  //    panel (even a soft-deleted service still holds the unique row) is taken.
  const existingService = await prisma.service.findUnique({
    where: { username: normalizedUsername },
    select: { id: true },
  });
  if (existingService !== null) {
    return "TAKEN_LOCAL";
  }

  // 2) Active reservation held by anyone else (across all panels, since the
  //    provisioned Service username is global) — but ignore the caller's own.
  const reservationWhere: Prisma.ServiceUsernameReservationWhereInput = {
    normalizedUsername,
    status: { in: ACTIVE_STATUSES },
  };
  if (args.ignoreReservation !== undefined) {
    reservationWhere.NOT = {
      userId: args.ignoreReservation.userId,
      draftNonce: args.ignoreReservation.draftNonce,
    };
  }
  const heldByOther = await prisma.serviceUsernameReservation.findFirst({
    where: reservationWhere,
    select: { id: true },
  });
  if (heldByOther !== null) {
    return "RESERVED";
  }

  // 3) Read-only remote probe. ok = exists (taken); notFound = positively absent
  //    (free); anything else = could-not-check (never treated as free).
  try {
    const adapter = buildAdapterForPanel(panel);
    const remote = await adapter.getServiceAccount({
      username: normalizedUsername,
      subscriptionBaseUrl: normalizeSubscriptionBase(panel),
    });
    if (remote.ok) {
      return "TAKEN_REMOTE";
    }
    if (remote.notFound === true) {
      return "AVAILABLE";
    }
    return "UNVERIFIABLE";
  } catch (err) {
    // Never surface raw panel errors; log only a safe category.
    logger.warn("service username availability probe failed", {
      panelId: panel.id,
      panelType: panel.type,
      error: errorMessage(err),
    });
    return "UNVERIFIABLE";
  }
}

// -----------------------------------------------------------------------------
// Reserve (HELD)
// -----------------------------------------------------------------------------

/**
 * Atomically reserve one specific validated username for a buyer. Idempotent for
 * the same (userId, draftNonce, normalizedUsername): re-confirming refreshes the
 * existing HELD hold. Changing the username for the same nonce obtains the NEW
 * hold first (inside a tx) and only then releases the prior one, so the buyer
 * never loses their hold on a lost race (P2002 → RESERVED).
 */
export async function reserveServiceUsername(args: {
  userId: string;
  panelId: string;
  mode: ServiceUsernameMode;
  normalizedUsername: string;
  draftNonce: string | null;
}): Promise<ReserveServiceUsernameResult> {
  const { userId, panelId, mode, normalizedUsername, draftNonce } = args;

  const validation = validateServiceUsername(normalizedUsername);
  if (!validation.ok || validation.normalized !== normalizedUsername) {
    return { outcome: "INVALID" };
  }

  const panel = await prisma.panel.findUnique({ where: { id: panelId } });
  if (panel === null || panel.status !== "ACTIVE") {
    return { outcome: "PANEL_UNAVAILABLE" };
  }

  // Reuse an existing active hold for this (userId, draftNonce): same username →
  // refresh; different username → to be released after the new hold is obtained.
  const priorActive = await prisma.serviceUsernameReservation.findMany({
    where: {
      userId,
      draftNonce,
      panelId,
      status: { in: REBINDABLE_STATUSES },
    },
    select: { id: true, normalizedUsername: true },
  });
  const sameUsernameHold = priorActive.find((r) => r.normalizedUsername === normalizedUsername);
  if (sameUsernameHold !== undefined) {
    await prisma.serviceUsernameReservation.updateMany({
      where: { id: sameUsernameHold.id, status: ServiceUsernameReservationStatus.HELD },
      data: { expiresAt: new Date(Date.now() + RESERVATION_HELD_TTL_MS) },
    });
    return { outcome: "AVAILABLE", reservationId: sameUsernameHold.id, normalizedUsername, mode };
  }
  const priorToRelease = priorActive.map((r) => r.id);

  const availability = await checkServiceUsernameAvailability({
    panel,
    normalizedUsername,
    ignoreReservation: { userId, draftNonce },
  });
  if (availability !== "AVAILABLE") {
    return { outcome: availability };
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.serviceUsernameReservation.create({
        data: {
          panelId,
          userId,
          normalizedUsername,
          activeUsernameKey: normalizedUsername,
          mode,
          status: ServiceUsernameReservationStatus.HELD,
          draftNonce,
          expiresAt: new Date(Date.now() + RESERVATION_HELD_TTL_MS),
        },
        select: { id: true },
      });
      if (priorToRelease.length > 0) {
        await tx.serviceUsernameReservation.updateMany({
          where: { id: { in: priorToRelease }, status: { in: REBINDABLE_STATUSES } },
          data: {
            status: ServiceUsernameReservationStatus.RELEASED,
            activeUsernameKey: null,
            releasedAt: new Date(),
          },
        });
      }
      return row;
    });
    return { outcome: "AVAILABLE", reservationId: created.id, normalizedUsername, mode };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      // Someone claimed the slot between the check and the insert.
      return { outcome: "RESERVED" };
    }
    logger.error("service username reservation insert failed", {
      panelId,
      error: errorMessage(err),
    });
    return { outcome: "UNVERIFIABLE" };
  }
}

/**
 * Reserve an opaque, crypto-random `u_`-prefixed username. Tries a bounded number
 * of candidates, skipping any that are already taken/reserved, and stops early on
 * a terminal condition (panel down / unverifiable). No unbounded DB rows or panel
 * calls are created.
 */
export async function reserveRandomServiceUsername(args: {
  userId: string;
  panelId: string;
  draftNonce: string | null;
}): Promise<ReserveServiceUsernameResult> {
  let lastBlocking: Exclude<ServiceUsernameAvailabilityOutcome, "AVAILABLE"> = "UNVERIFIABLE";
  for (let attempt = 0; attempt < RANDOM_USERNAME_MAX_ATTEMPTS; attempt += 1) {
    const candidate = generateRandomServiceUsername();
    const result = await reserveServiceUsername({
      userId: args.userId,
      panelId: args.panelId,
      mode: ServiceUsernameMode.RANDOM,
      normalizedUsername: candidate,
      draftNonce: args.draftNonce,
    });
    if (result.outcome === "AVAILABLE") {
      return result;
    }
    // Terminal conditions: retrying will not help.
    if (result.outcome === "PANEL_UNAVAILABLE" || result.outcome === "INVALID") {
      return result;
    }
    // TAKEN_LOCAL / TAKEN_REMOTE / RESERVED / UNVERIFIABLE → try another candidate.
    lastBlocking = result.outcome;
  }
  return { outcome: lastBlocking };
}

// -----------------------------------------------------------------------------
// Lifecycle transitions (CAS)
// -----------------------------------------------------------------------------

/**
 * BIND a HELD/BOUND reservation to a durable CheckoutSession. Clears the HELD TTL
 * (BOUND expiry is derived from the linked checkout/order, not this timestamp).
 * Runs inside the checkout-creation transaction. Returns whether it bound a row.
 */
export async function bindReservationToCheckout(
  tx: Db,
  reservationId: string,
  checkoutSessionId: string,
  userId: string,
): Promise<boolean> {
  const res = await tx.serviceUsernameReservation.updateMany({
    where: { id: reservationId, userId, status: { in: REBINDABLE_STATUSES } },
    data: {
      status: ServiceUsernameReservationStatus.BOUND,
      checkoutSessionId,
      boundAt: new Date(),
      expiresAt: null,
    },
  });
  return res.count > 0;
}

/**
 * Record the settled Order id (and checkout id) on a still-active reservation,
 * transitioning it to BOUND and clearing the HELD TTL. Runs inside the settlement
 * transaction alongside the Order create. Accepts a HELD reservation too (the
 * wallet path creates its checkout + order together and never pre-bound), so this
 * one call covers every payment method. Idempotent CAS; no-op once CONSUMED.
 */
export async function attachReservationToOrder(
  tx: Db,
  reservationId: string,
  orderId: string,
  checkoutSessionId: string,
): Promise<void> {
  await tx.serviceUsernameReservation.updateMany({
    where: { id: reservationId, status: { in: REBINDABLE_STATUSES } },
    data: {
      status: ServiceUsernameReservationStatus.BOUND,
      orderId,
      checkoutSessionId,
      boundAt: new Date(),
      expiresAt: null,
    },
  });
}

/**
 * CONSUME the reservation linked to an order once its Service row exists. Matches
 * on orderId + the exact username, so a mismatched/foreign reservation is never
 * consumed. Idempotent (re-consuming keeps CONSUMED). Runs inside the
 * provisioning persist transaction.
 */
export async function consumeReservationForOrder(
  tx: Db,
  orderId: string,
  serviceId: string,
  normalizedUsername: string,
): Promise<void> {
  await tx.serviceUsernameReservation.updateMany({
    where: {
      orderId,
      normalizedUsername,
      status: { in: [...REBINDABLE_STATUSES, ServiceUsernameReservationStatus.CONSUMED] },
    },
    data: {
      status: ServiceUsernameReservationStatus.CONSUMED,
      serviceId,
      consumedAt: new Date(),
    },
  });
}

/** Release a single reservation by id (frees its uniqueness slot). Idempotent. */
export async function releaseReservation(reservationId: string): Promise<void> {
  await prisma.serviceUsernameReservation.updateMany({
    where: { id: reservationId, status: { in: REBINDABLE_STATUSES } },
    data: {
      status: ServiceUsernameReservationStatus.RELEASED,
      activeUsernameKey: null,
      releasedAt: new Date(),
    },
  });
}

/**
 * Release every still-HELD reservation for a checkout draft (abandonment / the
 * buyer navigated away before creating a CheckoutSession). BOUND reservations are
 * intentionally left alone — they are protected by their durable checkout/order.
 */
export async function releaseHeldReservationsForDraft(
  userId: string,
  draftNonce: string,
): Promise<void> {
  await prisma.serviceUsernameReservation.updateMany({
    where: { userId, draftNonce, status: ServiceUsernameReservationStatus.HELD },
    data: {
      status: ServiceUsernameReservationStatus.RELEASED,
      activeUsernameKey: null,
      releasedAt: new Date(),
    },
  });
}

/** Load the active reservation for a draft (for UI re-render / state checks). */
export async function getActiveReservationForDraft(
  userId: string,
  draftNonce: string,
  panelId: string,
): Promise<{ id: string; normalizedUsername: string; mode: ServiceUsernameMode } | null> {
  const row = await prisma.serviceUsernameReservation.findFirst({
    where: { userId, draftNonce, panelId, status: { in: REBINDABLE_STATUSES } },
    orderBy: { createdAt: "desc" },
    select: { id: true, normalizedUsername: true, mode: true },
  });
  return row;
}
