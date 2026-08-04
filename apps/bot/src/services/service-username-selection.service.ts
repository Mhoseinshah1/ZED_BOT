import type { Panel, ServiceUsernameMode } from "@zedbot/database";
import {
  checkServiceUsernameAvailability as checkAvailabilityShared,
  reserveRandomServiceUsername as reserveRandomShared,
  reserveServiceUsername as reserveShared,
  type ReserveServiceUsernameResult,
} from "@zedbot/service-renewal";

import { buildAdapterForPanel } from "./panel-adapter-factory.js";

// =============================================================================
// The reservation engine now lives in @zedbot/service-renewal so a Mini App
// purchase reserves usernames through the SAME database-enforced uniqueness the
// bot uses. If each transport reserved its own way, "unique" would mean "unique
// per transport" and two buyers on two doors could be handed one panel account.
//
// The three functions that reach a panel are wrapped rather than re-exported,
// so they run against THIS module's adapter factory. That is the genuine
// external boundary the bot's suites mock, and a mock must keep intercepting
// after a refactor or the tests quietly stop testing the thing they name.
// Everything else is a straight re-export.
// =============================================================================

export async function checkServiceUsernameAvailability(
  args: Omit<Parameters<typeof checkAvailabilityShared>[0], "buildAdapter"> & {
    panel: Panel;
  },
): ReturnType<typeof checkAvailabilityShared> {
  return checkAvailabilityShared({ ...args, buildAdapter: buildAdapterForPanel });
}

export async function reserveServiceUsername(args: {
  userId: string;
  panelId: string;
  mode: ServiceUsernameMode;
  normalizedUsername: string;
  draftNonce: string | null;
}): Promise<ReserveServiceUsernameResult> {
  return reserveShared({ ...args, buildAdapter: buildAdapterForPanel });
}

export async function reserveRandomServiceUsername(args: {
  userId: string;
  panelId: string;
  draftNonce: string | null;
}): Promise<ReserveServiceUsernameResult> {
  return reserveRandomShared({ ...args, buildAdapter: buildAdapterForPanel });
}

export {
  attachReservationToOrder,
  bindSettledReservationFromSnapshot,
  claimReservationForCheckout,
  consumeReservationForOrder,
  getActiveReservationForDraft,
  hasForeignActiveReservationForUsername,
  isReservationClaimable,
  lockReservationForSettlement,
  RANDOM_USERNAME_MAX_ATTEMPTS,
  releaseHeldReservationForDraft,
  releaseHeldReservationsForDraft,
  releaseReservation,
  releaseReservationForFailedOrder,
  RESERVATION_HELD_TTL_MS,
  ReservationInvariantError,
  type ClaimReservationResult,
  type ReservationClaimArgs,
  type ReservationOrderBindArgs,
  type ReserveServiceUsernameResult,
  type SettledReservationBindResult,
} from "@zedbot/service-renewal";
