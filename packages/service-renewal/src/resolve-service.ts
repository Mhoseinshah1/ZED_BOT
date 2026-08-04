import { prisma, ServiceStatus, type Panel, type Prisma, type PrismaClient, type Service } from "@zedbot/database";
import type { PanelCapability } from "@zedbot/panel-adapters";
import { isServicePublicId, SERVICE_SHORT_ID_LENGTH } from "@zedbot/shared";

import { panelOperationAvailable, serviceSupportsGlobalLifecycle } from "./panel-capability.js";

// =============================================================================
// Resolving "the service this person is asking about" — the single gate every
// owner-scoped Mini App operation passes through.
//
// ONE ANSWER FOR EVERY REFUSAL. A malformed id, an id nobody owns, an ambiguous
// prefix, a soft-deleted row, a DELETED row and another person's service all
// return exactly `null`. Not because the distinctions are uninteresting, but
// because a caller who can tell them apart has an oracle: feed it prefixes and
// the different answers map out which services exist and which belong to
// someone else. The person who genuinely mistyped loses nothing by being told
// "not found" instead of "malformed" — they retype either way.
//
// THE OWNER IS IN THE QUERY, NOT IN A CHECK AFTER IT. `userId` is part of the
// WHERE clause, so a foreign row is never loaded, never logged, and never
// available to a later branch that forgets to compare. A post-hoc
// `if (service.userId !== userId)` is one early return away from a leak, and
// the row has already been read by then.
//
// AMBIGUITY IS A REFUSAL, NOT A CHOICE. The public id is an 8-hex-character
// uuid prefix. Collisions are astronomically unlikely but not impossible, and
// "pick the first" would hand someone another person's service on the one day
// it happens. `take: 2` and a length check make the improbable case explicit.
// =============================================================================

/** A Prisma client or an interactive transaction client. */
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * A resolved service together with the panel that serves it.
 *
 * The panel is loaded in the same query rather than fetched afterwards: every
 * caller needs it to decide whether the operation is even possible, and a
 * second round-trip is a second chance for the two to disagree.
 */
export interface OwnedService {
  service: Service;
  panel: Panel;
}

/**
 * Statuses from which a service may still be operated on.
 *
 * EXPIRED, LIMITED and DISABLED are all present on purpose: the person most
 * likely to want a renewal is precisely the one whose service has run out.
 * CREATING and FAILED are absent because there is nothing settled to act on,
 * and DELETED is absent because it is gone.
 */
export const OPERABLE_SERVICE_STATUSES: readonly ServiceStatus[] = [
  ServiceStatus.ACTIVE,
  ServiceStatus.EXPIRED,
  ServiceStatus.LIMITED,
  ServiceStatus.DISABLED,
];

/**
 * Resolves a service the authenticated user owns, or `null`.
 *
 * `capability` is the panel operation the caller intends. Passing it here
 * rather than checking later means an unsupported operation is indistinguishable
 * from a missing service, which is the right answer: whether someone else's
 * panel can renew is not this caller's business either.
 */
export async function resolveOwnedService(
  db: Db,
  userId: string,
  publicId: string,
  capability: PanelCapability,
): Promise<OwnedService | null> {
  // Format first, and strictly. An 8-hex-character prefix is the only shape the
  // Mini App ever hands out; accepting a shorter one would turn this into a
  // prefix-enumeration oracle over the caller's own account, and accepting a
  // longer one would let a caller keep a full uuid in circulation.
  if (!isServicePublicId(publicId)) {
    return null;
  }

  const matches = await db.service.findMany({
    where: {
      // The owner is a query condition. A foreign row is never loaded.
      userId,
      id: { startsWith: publicId.toLowerCase() },
      deletedAt: null,
      status: { in: [...OPERABLE_SERVICE_STATUSES] },
    },
    include: { panel: true },
    // Two, so a collision can be detected. Not one, which would silently
    // resolve an ambiguous prefix to whichever row the planner returned first.
    take: 2,
  });

  if (matches.length !== 1) {
    return null;
  }
  const row = matches[0];
  if (row.panel === null) {
    return null;
  }

  // The panel must be able to perform the operation right now — active, with
  // an adapter that implements it, and with credentials present. Checked before
  // any money moves, never discovered after.
  if (!panelOperationAvailable(row.panel, capability)) {
    return null;
  }

  // Legacy per-inbound XUI accounts are readable but never mutated through the
  // global-client endpoints, because a global-client write against an account
  // that is not one can affect a different customer's client on a shared panel.
  if (!serviceSupportsGlobalLifecycle(row)) {
    return null;
  }

  const { panel, ...service } = row;
  return { service: service as Service, panel };
}

/**
 * The public id for a service, for symmetry with the resolver above.
 *
 * Re-exported from the domain package so a caller never has to remember that
 * the convention is "first 8 characters" — the one place that knows is the one
 * place that resolves.
 */
export function servicePublicId(service: { id: string }): string {
  return service.id.slice(0, SERVICE_SHORT_ID_LENGTH);
}

/** Convenience wrapper for callers outside a transaction. */
export async function resolveOwnedServiceForUser(
  userId: string,
  publicId: string,
  capability: PanelCapability,
): Promise<OwnedService | null> {
  return resolveOwnedService(prisma, userId, publicId, capability);
}
