// =============================================================================
// Mini App commerce routes — Phase 1, part A (miniapp-commerce-parity):
// rollout flags, catalog, service-username reservation, authoritative quote
// (pre-invoice) and checkout confirmation.
//
// ONE AUTHORITY (§4): every financial decision here is made by the SAME
// domain functions the bot calls — catalog visibility, representative
// pricing, discount validation, checkout creation with its in-transaction
// reservation claim. This module translates HTTP to those calls and DTOs
// back; it computes nothing itself. Its import graph is grammY-free by
// construction and enforced by tests/miniapp-import-graph.test.ts.
//
// Every mutation: authenticated session (registered inside the secured
// plugin), TLS-in-production, same-origin, JSON content-type, dual rate
// limit, FRESH fail-closed rollout switches, payload-bound idempotency where
// a write results, opaque public ids, explicit DTO allowlists.
// =============================================================================
import { randomUUID } from "node:crypto";

import { createLogger } from "@zedbot/shared";

import { prisma, ServiceUsernameMode } from "@zedbot/database";
import type { MiniAppCommerceSwitchKey } from "@zedbot/shared";
import {
  canonicalCommercePublicId,
  MINIAPP_COMMERCE_SWITCH_KEYS,
  normalizeServiceNote,
  validateServiceUsername,
} from "@zedbot/shared";
import type { CheckoutDraft } from "@zedbot/bot/core/session";
import {
  getPurchasablePanelByShortId,
  isProductVisible,
  loadUserRetailCatalog,
} from "@zedbot/bot/services/catalog.service";
import {
  CheckoutReservationError,
  createCheckoutSession,
} from "@zedbot/bot/services/checkout.service";
import { validateDiscountCode } from "@zedbot/bot/services/discount.service";
import { resolveEffectiveProfile } from "@zedbot/bot/services/other-product-profile.service";
import { getProductByShortId } from "@zedbot/bot/services/product.service";
import { resolveEffectiveProductPrice } from "@zedbot/bot/services/representative-pricing.service";
import {
  namingConfigFromPanel,
  validateNamingConfig,
} from "@zedbot/bot/services/service-naming.service";
import {
  reserveRandomServiceUsername,
  reserveServiceUsername,
} from "@zedbot/bot/services/service-username-selection.service";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { supportFailureLog } from "../support-errors.js";
import {
  checkSupportMutation,
  sendMutationRejection,
  type SupportMutationLimiters,
} from "../support-guards.js";
import { allMiniAppSwitchesEnabled, readMiniAppSwitchFresh } from "../feature-switches.js";
import {
  openDraft,
  sealDraft,
  type CheckoutDraftCapsule,
} from "./draft-token.js";
import {
  commerceFingerprint,
  isValidClientRequestId,
  runIdempotentCommerce,
} from "./idempotency.js";
import {
  toCatalogCategory,
  toCatalogPanel,
  toMiniAppCheckout,
  type MiniAppQuote,
} from "./serializers.js";

const logger = createLogger("api");

const COMMERCE_BODY_LIMIT_BYTES = 16 * 1024;

type CommerceErrorCode =
  | "FEATURE_DISABLED"
  | "FEATURE_UNAVAILABLE"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "PRODUCT_UNAVAILABLE"
  | "USERNAME_INVALID"
  | "USERNAME_UNAVAILABLE"
  | "USERNAME_UNVERIFIABLE"
  | "NOTE_INVALID"
  | "DISCOUNT_INVALID"
  | "RESERVATION_NOT_FOUND"
  | "RESERVATION_NOT_CLAIMABLE"
  | "DRAFT_EXPIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "INTERNAL";

function fail(reply: FastifyReply, status: number, code: CommerceErrorCode): FastifyReply {
  return reply.code(status).send({ ok: false, code });
}

/** FRESH fail-closed switch check for a read/mutation surface. Returns null
 * when allowed, otherwise the reply (already sent). */
async function requireSwitches(
  reply: FastifyReply,
  keys: readonly MiniAppCommerceSwitchKey[],
): Promise<FastifyReply | null> {
  const state = await allMiniAppSwitchesEnabled(keys);
  if (state.ok) {
    return null;
  }
  return state.unavailable
    ? fail(reply, 503, "FEATURE_UNAVAILABLE")
    : fail(reply, 403, "FEATURE_DISABLED");
}

function requestUser(request: FastifyRequest): { id: string } {
  const user = request.miniAppUser;
  if (user === undefined) {
    throw new Error("commerce route reached without an authenticated user");
  }
  return { id: user.id };
}

export interface CommerceRouteOptions {
  allowedOrigins: ReadonlySet<string>;
  production: boolean;
  limiters: SupportMutationLimiters;
}

export function registerCommerceRoutes(
  app: FastifyInstance,
  options: CommerceRouteOptions,
): void {
  const gate = (request: FastifyRequest, reply: FastifyReply, userId: string) => {
    const rejection = checkSupportMutation(request, {
      allowedOrigins: options.allowedOrigins,
      limiters: options.limiters,
      userId,
      production: options.production,
    });
    if (rejection !== null) {
      sendMutationRejection(reply, rejection);
      return false;
    }
    return true;
  };

  // --- rollout flags (read-only; drives which UI the client shows) ----------
  app.get("/commerce/flags", async (request, reply) => {
    void requestUser(request);
    const flags: Record<string, boolean> = {};
    for (const key of MINIAPP_COMMERCE_SWITCH_KEYS) {
      const state = await readMiniAppSwitchFresh(key);
      // Fail closed for DISPLAY too: an unreadable switch is an off switch.
      flags[key] = state.ok ? state.enabled : false;
    }
    return reply.send({ ok: true, flags });
  });

  // --- catalog ----------------------------------------------------------------
  app.get("/commerce/catalog", async (request, reply) => {
    const denied = await requireSwitches(reply, ["miniapp_commerce_enabled"]);
    if (denied !== null) {
      return denied;
    }
    try {
      const userId = requestUser(request).id;
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (user === null) {
        return fail(reply, 404, "NOT_FOUND");
      }
      const catalog = await loadUserRetailCatalog(user);
      const includeOther = await readMiniAppSwitchFresh("miniapp_other_products_enabled");
      return reply.send({
        ok: true,
        servicePanels: catalog.servicePanels.map((entry) =>
          toCatalogPanel(
            entry.panel,
            entry.categories.map((c) => toCatalogCategory(c.category, c.products)),
          ),
        ),
        otherProductCategories:
          includeOther.ok && includeOther.enabled
            ? catalog.otherProductCategories.map((c) =>
                toCatalogCategory(c.category, c.products),
              )
            : [],
      });
    } catch (err) {
      logger.error("miniapp commerce catalog failed", supportFailureLog("commerce-catalog", err));
      return fail(reply, 503, "INTERNAL");
    }
  });

  // --- service username reservation -------------------------------------------
  app.post<{ Body: unknown }>(
    "/commerce/username",
    { bodyLimit: COMMERCE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const userId = requestUser(request).id;
      if (!gate(request, reply, userId)) {
        return reply;
      }
      const denied = await requireSwitches(reply, ["miniapp_commerce_enabled"]);
      if (denied !== null) {
        return denied;
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const panelPublicId = canonicalCommercePublicId(body.panelPublicId);
      const mode = body.mode === "CUSTOM" || body.mode === "RANDOM" ? body.mode : null;
      if (panelPublicId === null || mode === null) {
        return fail(reply, 400, "BAD_REQUEST");
      }
      try {
        // Owner-scoped resolution is not needed for a PANEL (catalog data),
        // but purchasability is: the same predicate the bot's buy flow uses.
        const panel = await getPurchasablePanelByShortId(panelPublicId);
        if (panel === null) {
          return fail(reply, 404, "NOT_FOUND");
        }
        const naming = validateNamingConfig(namingConfigFromPanel(panel));
        if (!naming.ok) {
          return fail(reply, 409, "PRODUCT_UNAVAILABLE");
        }
        const draftNonce = randomUUID();
        let result;
        if (mode === "CUSTOM") {
          const rawUsername = typeof body.username === "string" ? body.username : "";
          const validation = validateServiceUsername(rawUsername);
          if (!validation.ok) {
            return fail(reply, 400, "USERNAME_INVALID");
          }
          result = await reserveServiceUsername({
            userId,
            panelId: panel.id,
            mode: ServiceUsernameMode.CUSTOM,
            normalizedUsername: validation.normalized,
            draftNonce,
          });
        } else {
          result = await reserveRandomServiceUsername({
            userId,
            panelId: panel.id,
            draftNonce,
          });
        }
        if (result.outcome !== "AVAILABLE") {
          if (result.outcome === "INVALID") {
            return fail(reply, 400, "USERNAME_INVALID");
          }
          if (result.outcome === "UNVERIFIABLE") {
            return fail(reply, 503, "USERNAME_UNVERIFIABLE");
          }
          return fail(reply, 409, "USERNAME_UNAVAILABLE");
        }
        return reply.send({
          ok: true,
          draftNonce,
          username: result.normalizedUsername,
          mode,
        });
      } catch (err) {
        logger.error(
          "miniapp commerce username failed",
          supportFailureLog("commerce-username", err),
        );
        return fail(reply, 503, "INTERNAL");
      }
    },
  );

  // --- authoritative quote (pre-invoice, no writes) ----------------------------
  app.post<{ Body: unknown }>(
    "/commerce/quote",
    { bodyLimit: COMMERCE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const userId = requestUser(request).id;
      if (!gate(request, reply, userId)) {
        return reply;
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const kind = body.kind === "SERVICE" || body.kind === "OTHER" ? body.kind : null;
      const productPublicId = canonicalCommercePublicId(body.productPublicId);
      if (kind === null || productPublicId === null) {
        return fail(reply, 400, "BAD_REQUEST");
      }
      const denied = await requireSwitches(
        reply,
        kind === "OTHER"
          ? ["miniapp_commerce_enabled", "miniapp_other_products_enabled"]
          : ["miniapp_commerce_enabled"],
      );
      if (denied !== null) {
        return denied;
      }
      try {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (user === null) {
          return fail(reply, 404, "NOT_FOUND");
        }
        const product = await getProductByShortId(productPublicId);
        if (
          product === null ||
          !isProductVisible(product, user.group) ||
          (kind === "SERVICE") !== (product.type === "SERVICE_PRODUCT")
        ) {
          return fail(reply, 404, "PRODUCT_UNAVAILABLE");
        }

        // SERVICE: the reservation made via /commerce/username, found by the
        // server-minted nonce — no internal id ever crossed the wire.
        const draftNonce =
          typeof body.draftNonce === "string" && body.draftNonce.length <= 64
            ? body.draftNonce
            : null;
        let reservation: {
          id: string;
          normalizedUsername: string;
          mode: ServiceUsernameMode;
        } | null = null;
        if (product.type === "SERVICE_PRODUCT" && product.panelId !== null) {
          if (draftNonce === null) {
            return fail(reply, 400, "RESERVATION_NOT_FOUND");
          }
          const held = await prisma.serviceUsernameReservation.findFirst({
            where: {
              userId,
              draftNonce,
              panelId: product.panelId,
              status: "HELD",
              expiresAt: { gt: new Date() },
            },
            orderBy: { createdAt: "desc" },
          });
          if (held === null) {
            return fail(reply, 409, "RESERVATION_NOT_FOUND");
          }
          reservation = {
            id: held.id,
            normalizedUsername: held.normalizedUsername,
            mode: held.mode,
          };
        }

        // Optional note (SERVICE only).
        let note: string | null = null;
        if (typeof body.note === "string" && body.note.trim() !== "") {
          const normalized = normalizeServiceNote(body.note);
          if (!normalized.ok) {
            return fail(reply, 400, "NOTE_INVALID");
          }
          note = normalized.normalized;
        }

        // Discount code: window/limit/eligibility via the bot's validator,
        // amounts via the ONE pricing resolver (stacking policy included).
        let discountRow = null;
        const discountCodeText =
          typeof body.discountCode === "string" && body.discountCode.trim() !== ""
            ? body.discountCode.trim()
            : null;
        if (discountCodeText !== null) {
          const validation = await validateDiscountCode(
            discountCodeText,
            user,
            product.priceToman,
            "PURCHASE",
          );
          if (!validation.ok) {
            return fail(reply, 409, "DISCOUNT_INVALID");
          }
          discountRow = validation.discountCode;
        }

        const pricing = await resolveEffectiveProductPrice({
          user,
          product,
          checkoutPurpose: "PURCHASE",
          discountCode: discountRow,
          mode: "PREVIEW",
        });

        const capsule: CheckoutDraftCapsule = {
          userId,
          kind,
          productId: product.id,
          draftNonce: draftNonce ?? randomUUID(),
          ...(reservation !== null
            ? {
                reservationId: reservation.id,
                usernameMode: reservation.mode,
                normalizedUsername: reservation.normalizedUsername,
                usernameConfirmedAt: new Date().toISOString(),
              }
            : {}),
          note,
          ...(discountRow !== null && pricing.discountCodeId !== null
            ? { discountCode: discountCodeText ?? undefined }
            : {}),
          mintedAtMs: Date.now(),
        };

        const needsCustomerInput =
          product.type === "OTHER_PRODUCT"
            ? resolveEffectiveProfile(product).requireInfoBeforeSettlement
            : false;

        const quote: MiniAppQuote = {
          kind,
          productPublicId,
          productName: product.name,
          panelName: product.panel?.name ?? null,
          username: reservation?.normalizedUsername ?? null,
          note,
          originalPriceToman: pricing.basePriceToman,
          discountAmountToman: pricing.discountAmountToman,
          finalPriceToman: pricing.finalPriceToman,
          discountCode: pricing.discountCodeId !== null ? discountCodeText : null,
          discountStackingRejected:
            pricing.pricingMode === "REPRESENTATIVE" && pricing.discountStackingRejected,
          needsCustomerInputBeforePayment: needsCustomerInput,
          draftToken: sealDraft(capsule),
        };
        return reply.send({ ok: true, quote });
      } catch (err) {
        logger.error("miniapp commerce quote failed", supportFailureLog("commerce-quote", err));
        return fail(reply, 503, "INTERNAL");
      }
    },
  );

  // --- confirm: the durable checkout (frozen snapshot, reservation claim) ------
  app.post<{ Body: unknown }>(
    "/commerce/checkout",
    { bodyLimit: COMMERCE_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const userId = requestUser(request).id;
      if (!gate(request, reply, userId)) {
        return reply;
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (!isValidClientRequestId(body.clientRequestId)) {
        return fail(reply, 400, "BAD_REQUEST");
      }
      const capsule = openDraft(body.draftToken, Date.now());
      if (capsule === null) {
        return fail(reply, 410, "DRAFT_EXPIRED");
      }
      if (capsule.userId !== userId) {
        return fail(reply, 404, "NOT_FOUND");
      }
      const denied = await requireSwitches(
        reply,
        capsule.kind === "OTHER"
          ? ["miniapp_commerce_enabled", "miniapp_other_products_enabled"]
          : ["miniapp_commerce_enabled"],
      );
      if (denied !== null) {
        return denied;
      }

      try {
        const outcome = await runIdempotentCommerce(
          {
            userId,
            clientRequestId: body.clientRequestId,
            operation: "commerce-checkout-confirm",
            fingerprint: commerceFingerprint([String(body.draftToken)]),
          },
          async () => {
            const user = await prisma.user.findUnique({ where: { id: userId } });
            if (user === null) {
              throw new ConfirmRejected("NOT_FOUND", 404);
            }
            const product = await prisma.product.findUnique({
              where: { id: capsule.productId },
              include: { category: true, panel: true },
            });
            if (product === null || !isProductVisible(product, user.group)) {
              throw new ConfirmRejected("PRODUCT_UNAVAILABLE", 409);
            }

            // Re-validate + RE-PRICE everything fresh; the capsule carried
            // identity only. SETTLE mode reads the rep switch uncached.
            let discountRow = null;
            if (capsule.discountCode !== undefined) {
              const validation = await validateDiscountCode(
                capsule.discountCode,
                user,
                product.priceToman,
                "PURCHASE",
              );
              if (!validation.ok) {
                throw new ConfirmRejected("DISCOUNT_INVALID", 409);
              }
              discountRow = validation.discountCode;
            }
            const pricing = await resolveEffectiveProductPrice({
              user,
              product,
              checkoutPurpose: "PURCHASE",
              discountCode: discountRow,
              mode: "SETTLE",
            });

            const draft: CheckoutDraft = {
              productId: product.id,
              categoryId: product.categoryId,
              ...(product.panelId !== null ? { panelId: product.panelId } : {}),
              flowType: product.type,
              ...(pricing.discountCodeId !== null && capsule.discountCode !== undefined
                ? { discountCode: capsule.discountCode, discountCodeId: pricing.discountCodeId }
                : {}),
              originalPriceToman: pricing.basePriceToman,
              discountAmountToman: pricing.discountAmountToman,
              finalPriceToman: pricing.finalPriceToman,
              draftNonce: capsule.draftNonce,
              ...(pricing.pricingMode === "REPRESENTATIVE"
                ? {
                    representative: {
                      representativeId: pricing.representativeId,
                      tierId: pricing.tierId,
                      tierSlug: pricing.tierSlug,
                      priceMode: pricing.priceMode,
                      retailPriceToman: pricing.retailPriceToman,
                      basePriceToman: pricing.basePriceToman,
                      tierFingerprint: pricing.tierFingerprint,
                      priceFingerprint: pricing.priceFingerprint,
                    },
                  }
                : {}),
              ...(capsule.reservationId !== undefined &&
              capsule.normalizedUsername !== undefined &&
              capsule.usernameMode !== undefined
                ? {
                    serviceCustomization: {
                      usernameMode: capsule.usernameMode as ServiceUsernameMode,
                      normalizedUsername: capsule.normalizedUsername,
                      reservationId: capsule.reservationId,
                      note: capsule.note ?? null,
                      usernameConfirmedAt:
                        capsule.usernameConfirmedAt ?? new Date().toISOString(),
                      completed: true,
                    },
                  }
                : {}),
            };

            let checkout;
            try {
              checkout = await createCheckoutSession(user, product, draft);
            } catch (err) {
              if (err instanceof CheckoutReservationError) {
                throw new ConfirmRejected("RESERVATION_NOT_CLAIMABLE", 409);
              }
              throw err;
            }
            // §18 origin bookkeeping — never consulted for money.
            await prisma.checkoutSession.update({
              where: { id: checkout.id },
              data: { origin: "MINIAPP" },
            });
            return {
              resultCheckoutSessionId: checkout.id,
              resultPaymentId: null,
            };
          },
        );

        if (outcome.kind === "conflict") {
          return fail(reply, 409, "IDEMPOTENCY_CONFLICT");
        }
        const checkoutId =
          outcome.kind === "executed"
            ? outcome.value.resultCheckoutSessionId
            : outcome.stored.resultCheckoutSessionId;
        if (checkoutId === null) {
          return fail(reply, 503, "INTERNAL");
        }
        const checkout = await prisma.checkoutSession.findFirst({
          where: { id: checkoutId, userId },
        });
        if (checkout === null) {
          return fail(reply, 404, "NOT_FOUND");
        }
        const needsInput = await checkoutNeedsCustomerInput(checkout);
        return reply
          .code(outcome.kind === "executed" ? 201 : 200)
          .send({ ok: true, checkout: toMiniAppCheckout(checkout, { needsCustomerInput: needsInput }) });
      } catch (err) {
        if (err instanceof ConfirmRejected) {
          return fail(reply, err.status, err.code);
        }
        logger.error(
          "miniapp commerce checkout failed",
          supportFailureLog("commerce-checkout", err),
        );
        return fail(reply, 503, "INTERNAL");
      }
    },
  );

  // --- checkout status (owner-scoped, public id) --------------------------------
  app.get<{ Params: { checkoutId: string } }>(
    "/commerce/checkouts/:checkoutId",
    async (request, reply) => {
      const userId = requestUser(request).id;
      const publicId = canonicalCommercePublicId(request.params.checkoutId);
      if (publicId === null) {
        return fail(reply, 404, "NOT_FOUND");
      }
      try {
        const matches = await prisma.checkoutSession.findMany({
          where: { id: { startsWith: publicId }, userId },
          take: 2,
        });
        if (matches.length !== 1) {
          return fail(reply, 404, "NOT_FOUND");
        }
        const needsInput = await checkoutNeedsCustomerInput(matches[0]);
        return reply.send({
          ok: true,
          checkout: toMiniAppCheckout(matches[0], { needsCustomerInput: needsInput }),
        });
      } catch (err) {
        logger.error(
          "miniapp commerce checkout read failed",
          supportFailureLog("commerce-checkout-read", err),
        );
        return fail(reply, 503, "INTERNAL");
      }
    },
  );
}

import { isMandatoryCustomerInfoMissing } from "@zedbot/bot/services/checkout-customer-input.service";

class ConfirmRejected extends Error {
  constructor(
    readonly code: CommerceErrorCode,
    readonly status: number,
  ) {
    super(code);
  }
}

/** True when the checkout's frozen fulfillment snapshot demands a completed
 * customer-input form before settlement (the same gate the money paths run). */
async function checkoutNeedsCustomerInput(checkout: {
  id: string;
  purpose: string;
  orderType: string | null;
  otherProductFulfillmentSnapshot: unknown;
  productSnapshot: unknown;
}): Promise<boolean> {
  return isMandatoryCustomerInfoMissing(checkout);
}
