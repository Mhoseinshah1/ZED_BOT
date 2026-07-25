import { randomUUID } from "node:crypto";

import { prisma, ServiceUsernameMode } from "@zedbot/database";

import type { CheckoutDraft, ServiceCustomizationDraft } from "../../src/core/session.js";

// =============================================================================
// Shared service-checkout fixture (production guard §4/§5).
//
// A panel-backed SERVICE_PRODUCT wallet purchase MUST carry a COMPLETED username
// customization whose EXACT HELD ServiceUsernameReservation row exists — the
// wallet transaction claims + binds that hold before any money moves. Any
// DB-backed test that drives payPurchaseDraftWithWallet with a panel-backed
// SERVICE draft therefore has to create that reservation first.
//
// These helpers are the single, correct way to do that so future tests cannot
// accidentally build an invalid draft. They mirror the real state at the
// wallet-pay boundary (a HELD reservation + a completed customization) WITHOUT
// probing any panel.
// =============================================================================

// Module-level, monotonically-increasing counter. `activeUsernameKey` is a
// GLOBALLY unique column, so every generated username must be unique across the
// whole database (and across every test in the process), never just per-user.
let usernameCounter = 0;

/**
 * Create the durable HELD reservation the wallet-payment guard requires and
 * return the matching completed {@link ServiceCustomizationDraft}. The reservation
 * row is keyed to `draftNonce` + `panelId` + `userId` + the generated username,
 * exactly the identity {@link CheckoutDraft.serviceCustomization} carries, so the
 * settlement boundary claims it cleanly.
 *
 * A valid unique username (`^[a-z][a-z0-9_]{7,15}$`) is generated unless one is
 * passed explicitly.
 */
export async function armServiceCustomization(args: {
  userId: string;
  panelId: string;
  draftNonce: string;
  username?: string;
}): Promise<ServiceCustomizationDraft> {
  usernameCounter += 1;
  const username =
    args.username ??
    `u_${usernameCounter}${Math.random().toString(36).slice(2, 8)}`.slice(0, 16);
  const res = await prisma.serviceUsernameReservation.create({
    data: {
      panelId: args.panelId,
      userId: args.userId,
      normalizedUsername: username,
      activeUsernameKey: username,
      mode: ServiceUsernameMode.CUSTOM,
      status: "HELD",
      draftNonce: args.draftNonce,
      expiresAt: new Date(Date.now() + 3_600_000),
    },
  });
  return {
    usernameMode: ServiceUsernameMode.CUSTOM,
    normalizedUsername: username,
    reservationId: res.id,
    note: null,
    usernameConfirmedAt: new Date().toISOString(),
    completed: true,
  };
}

/**
 * Arm an existing {@link CheckoutDraft} in place: set its `panelId`, ensure it has
 * a `draftNonce`, and attach a completed {@link ServiceCustomizationDraft} backed
 * by a freshly-created HELD reservation. Returns the SAME draft object so callers
 * that must reuse ONE armed draft (idempotency / race tests) can await it once and
 * pass the result to every call.
 */
export async function armServiceDraft(
  draft: CheckoutDraft,
  args: { userId: string; panelId: string },
): Promise<CheckoutDraft> {
  draft.panelId = args.panelId;
  const draftNonce = draft.draftNonce ?? randomUUID();
  draft.draftNonce = draftNonce;
  draft.serviceCustomization = await armServiceCustomization({
    userId: args.userId,
    panelId: args.panelId,
    draftNonce,
  });
  return draft;
}
