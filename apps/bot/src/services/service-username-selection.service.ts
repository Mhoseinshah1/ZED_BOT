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
// Reservation lifecycle (each transition is a CAS updateMany with a full status
// guard, so concurrent settlement / cleanup paths converge deterministically):
//   HELD  → reserveServiceUsername (short TTL while the buyer decides)
//   BOUND → claimReservationForCheckout (the ONE authoritative claim: an atomic
//           conditional UPDATE that verifies id + owner + draft nonce + username
//           + mode + panel + activeUsernameKey + HELD + unexpired + no existing
//           checkout/order/service link BEFORE binding to a durable CheckoutSession.
//           Zero rows matched → a typed NOT_CLAIMABLE result the caller MUST act on;
//           a boolean/update-count is never silently ignored.)
//   BOUND → attachReservationToOrder (records the settled Order id under an exact
//           id + owner + checkout + panel + username + BOUND + no-foreign-order
//           guard; returns on success, throws ReservationInvariantError otherwise.)
//   CONSUMED → consumeReservationForOrder (a Service row was created)
//   RELEASED → releaseReservation / releaseReservationsForDraft (given up)
//
// hotfix (fix/service-username-reservation-safety): the global activeUsernameKey
// @unique index (matching Service.username) means an active hold blocks a username
// on EVERY panel, and the claim/attach guards verify the CURRENT product panel so a
// panel drift between selection and settlement fails closed instead of provisioning
// against a stale panel.
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

/** Reservation states that still OWN the GLOBAL username uniqueness slot. */
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

/**
 * A hard reservation invariant was violated at a settlement boundary (e.g. the
 * order-binding claim matched zero rows because the reservation was released,
 * re-bound to a foreign checkout/order, expired, or drifted to another panel).
 * Carries only a machine-readable reason — never a username, note, or owner id —
 * so it is safe to log. The financial caller (wallet) converts it into a safe
 * abort that rolls the whole transaction back; the external-success callers
 * (receipt / gateway) convert it into a reconciliation record instead of losing
 * a real payment.
 */
export class ReservationInvariantError extends Error {
  constructor(readonly reason: string) {
    super(`service username reservation invariant violated: ${reason}`);
    this.name = "ReservationInvariantError";
  }
}

/** The identity a claim/attach must match EXACTLY against the live reservation. */
export interface ReservationClaimArgs {
  reservationId: string;
  userId: string;
  /** The draft nonce that created the hold (null-safe exact match). */
  draftNonce: string | null;
  /** The buyer-selected, normalized username the reservation must still hold. */
  normalizedUsername: string;
  mode: ServiceUsernameMode;
  /** The CURRENT product panel — a drift from the reserved panel fails closed. */
  panelId: string;
}

/** Typed result of the authoritative checkout claim (never a bare boolean). */
export type ClaimReservationResult = { ok: true } | { ok: false; reason: "NOT_CLAIMABLE" };

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
 * THE authoritative reservation claim (§3). One atomic conditional UPDATE binds a
 * still-HELD reservation to a durable CheckoutSession, but ONLY if every identity
 * field still matches: the exact reservation id + owner + draft nonce + selected
 * username + activeUsernameKey slot + mode + CURRENT product panel, in HELD state,
 * unexpired, and not already linked to any checkout / order / service. Because all
 * of that lives in the single UPDATE's WHERE clause there is no read-then-write
 * window: two racing checkout creations can never both bind the same hold, and a
 * hold that expired / was released / drifted to another panel matches zero rows.
 *
 * A zero-row result is returned as a typed NOT_CLAIMABLE outcome the caller MUST
 * act on (roll the checkout back, invalidate the customization, return the buyer
 * to username selection) — the count is never silently ignored. Runs INSIDE the
 * checkout-creation transaction so the claim and the CheckoutSession commit (or
 * roll back) together.
 */
export async function claimReservationForCheckout(
  tx: Db,
  args: ReservationClaimArgs,
  checkoutSessionId: string,
  now: Date = new Date(),
): Promise<ClaimReservationResult> {
  const res = await tx.serviceUsernameReservation.updateMany({
    where: {
      id: args.reservationId,
      userId: args.userId,
      draftNonce: args.draftNonce,
      normalizedUsername: args.normalizedUsername,
      activeUsernameKey: args.normalizedUsername,
      mode: args.mode,
      panelId: args.panelId,
      status: ServiceUsernameReservationStatus.HELD,
      expiresAt: { gt: now },
      checkoutSessionId: null,
      orderId: null,
      serviceId: null,
    },
    data: {
      status: ServiceUsernameReservationStatus.BOUND,
      checkoutSessionId,
      boundAt: now,
      expiresAt: null,
    },
  });
  return res.count === 1 ? { ok: true } : { ok: false, reason: "NOT_CLAIMABLE" };
}

/**
 * Read-only mirror of the {@link claimReservationForCheckout} accepted state (§4):
 * true iff the exact HELD reservation is still claimable RIGHT NOW (same id +
 * owner + draft nonce + selected username + activeUsernameKey + mode + CURRENT
 * panel, HELD, unexpired, and unlinked). Used by the wallet callback layers to
 * fail closed BEFORE showing a confirmation screen or moving money for a stale /
 * drifted / incomplete SERVICE draft. It does not mutate anything.
 */
export async function isReservationClaimable(
  args: ReservationClaimArgs,
  now: Date = new Date(),
): Promise<boolean> {
  const row = await prisma.serviceUsernameReservation.findFirst({
    where: {
      id: args.reservationId,
      userId: args.userId,
      draftNonce: args.draftNonce,
      normalizedUsername: args.normalizedUsername,
      activeUsernameKey: args.normalizedUsername,
      mode: args.mode,
      panelId: args.panelId,
      status: ServiceUsernameReservationStatus.HELD,
      expiresAt: { gt: now },
      checkoutSessionId: null,
      orderId: null,
      serviceId: null,
    },
    select: { id: true },
  });
  return row !== null;
}

/** The identity an order-binding must match EXACTLY against the BOUND reservation. */
export interface ReservationOrderBindArgs {
  reservationId: string;
  userId: string;
  /** The checkout the reservation was claimed to (the settling checkout). */
  checkoutSessionId: string;
  /** The CURRENT product panel — must equal the reserved panel. */
  panelId: string;
  /** The buyer-selected username the reservation must still hold. */
  normalizedUsername: string;
  /** The settled order to record. */
  orderId: string;
}

/**
 * Record the settled Order id on the reservation that was already claimed to this
 * checkout (§6). NOT a permissive no-op: a single conditional UPDATE requires the
 * exact reservation id + owner + checkout id + panel + username in BOUND state with
 * no foreign order and no Service yet. On success it returns; on a genuine mismatch
 * it throws {@link ReservationInvariantError} (after an idempotent re-check that the
 * reservation is already bound to THIS same order, which returns cleanly). Runs
 * inside the settlement transaction alongside the Order create.
 */
export async function attachReservationToOrder(
  tx: Db,
  args: ReservationOrderBindArgs,
  now: Date = new Date(),
): Promise<void> {
  const res = await tx.serviceUsernameReservation.updateMany({
    where: {
      id: args.reservationId,
      userId: args.userId,
      checkoutSessionId: args.checkoutSessionId,
      panelId: args.panelId,
      normalizedUsername: args.normalizedUsername,
      status: ServiceUsernameReservationStatus.BOUND,
      serviceId: null,
      // Not yet bound to any order, or idempotently re-bound to THIS same order.
      OR: [{ orderId: null }, { orderId: args.orderId }],
    },
    data: {
      status: ServiceUsernameReservationStatus.BOUND,
      orderId: args.orderId,
      boundAt: now,
      expiresAt: null,
    },
  });
  if (res.count === 1) {
    return;
  }
  // Idempotent success: the reservation already advanced to this exact order
  // (possibly all the way to CONSUMED, whose serviceId fails the guard above).
  const already = await tx.serviceUsernameReservation.findFirst({
    where: {
      id: args.reservationId,
      userId: args.userId,
      orderId: args.orderId,
      normalizedUsername: args.normalizedUsername,
      status: {
        in: [
          ServiceUsernameReservationStatus.BOUND,
          ServiceUsernameReservationStatus.CONSUMED,
        ],
      },
    },
    select: { id: true },
  });
  if (already !== null) {
    return;
  }
  throw new ReservationInvariantError("ORDER_BIND_NO_MATCH");
}

/** Typed outcome of an external-settlement reservation bind (§2/§6). */
export type SettledReservationBindResult =
  | { bound: true }
  | { bound: false; reason: string };

/**
 * External-success settlement binding (§2/§6): read the reservation identity from
 * the immutable checkout snapshot and strictly bind it to the settled order. Used
 * by the receipt-approval and gateway (Zarinpal / NOWPayments / one-shot Stars)
 * settlements, where the money has ALREADY moved externally. It returns a TYPED
 * result — it never logs-and-swallows and never rolls a real payment back. The
 * CALLER makes the durable settlement/reconciliation decision:
 *   • `{ bound: true }`  → the exact reservation is now recorded on the order (or
 *     there was nothing to bind: OTHER_PRODUCT / legacy panel-less service);
 *   • `{ bound: false, reason }` → the exact reservation could NOT be bound (a
 *     privacy-safe machine reason — never a username / note / owner id). The
 *     caller MUST open a durable reconciliation case, must NOT dispatch the order
 *     to provisioning, and must preserve provider-success truth.
 */
export async function bindSettledReservationFromSnapshot(
  tx: Db,
  snapshot: Record<string, unknown>,
  args: { userId: string; checkoutSessionId: string; orderId: string },
): Promise<SettledReservationBindResult> {
  const reservationId = snapshotStr(snapshot, "serviceUsernameReservationId");
  const normalizedUsername = snapshotStr(snapshot, "serviceUsername");
  const panelId = snapshotStr(snapshot, "panelId");
  if (reservationId === null || normalizedUsername === null || panelId === null) {
    return { bound: true };
  }
  try {
    await attachReservationToOrder(tx, {
      reservationId,
      userId: args.userId,
      checkoutSessionId: args.checkoutSessionId,
      panelId,
      normalizedUsername,
      orderId: args.orderId,
    });
    return { bound: true };
  } catch (err) {
    if (err instanceof ReservationInvariantError) {
      return { bound: false, reason: err.reason };
    }
    throw err;
  }
}

/** Safe string reader for an untyped snapshot field ("" → null). */
function snapshotStr(snapshot: Record<string, unknown>, key: string): string | null {
  const value = snapshot[key];
  return typeof value === "string" && value !== "" ? value : null;
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

/**
 * Take a row-level lock on a reservation for the whole settlement transaction (§7).
 * Called at the START of an external settlement (receipt approval / gateway
 * success) — BEFORE the checkout is flipped — so the concurrent cleanup sweep,
 * which selects candidates with `FOR UPDATE ... SKIP LOCKED`, skips any reservation
 * a settlement is actively holding. This is the shared lock that makes "a
 * successfully settling reservation can never become EXPIRED" hold even in the
 * narrow window before the checkout flip commits. No-op-safe for a row that does
 * not exist (the settlement then simply has nothing to protect).
 */
export async function lockReservationForSettlement(
  tx: Db,
  reservationId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "ServiceUsernameReservation" WHERE id = ${reservationId} FOR UPDATE`;
}

/**
 * Release ONE exact HELD reservation for a draft (§8 abandonment). Matches on the
 * full identity (owner + draft nonce + reservation id) and the HELD status, so it
 * frees only the hold this draft is giving up and NEVER a BOUND / CONSUMED
 * reservation (those are protected by their durable checkout / order / service).
 * Idempotent: a already-released / never-existent hold is a no-op.
 */
export async function releaseHeldReservationForDraft(args: {
  userId: string;
  draftNonce: string | null;
  reservationId: string;
}): Promise<void> {
  await prisma.serviceUsernameReservation.updateMany({
    where: {
      id: args.reservationId,
      userId: args.userId,
      draftNonce: args.draftNonce,
      status: ServiceUsernameReservationStatus.HELD,
    },
    data: {
      status: ServiceUsernameReservationStatus.RELEASED,
      activeUsernameKey: null,
      releasedAt: new Date(),
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
