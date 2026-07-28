// =============================================================================
// Mini App commerce routes — Phase 1, part C (miniapp-commerce-parity):
// the delivery surface (subscription link / configs / QR) and the service
// add-ons (renewal, extra volume, extra time) — §7, §15.
//
// Delivery exposes ONLY owner-safe fields, gated by its own rollout switch;
// QR codes are rendered server-side by the bot's own generator and returned
// as image bytes with the global no-store policy. Add-ons re-run the bot's
// exact eligibility (renewableWhere / lifecycle / plan validity) at the
// options read, at the quote AND at the money boundary (draft-build), so a
// service that stopped being eligible between screens fails closed.
// =============================================================================
import { prisma } from "@zedbot/database";
import {
  canonicalCommercePublicId,
  commerceShortId,
  createLogger,
} from "@zedbot/shared";
import {
  getRenewableServiceByShortId,
  renewalPlansForPanel,
} from "@zedbot/bot/services/renewal-checkout.service";
import {
  extraVolumePackages,
  getExtraVolumeServiceByShortId,
} from "@zedbot/bot/services/extra-volume.service";
import {
  extraTimePackages,
  getExtraTimeServiceByShortId,
} from "@zedbot/bot/services/extra-time.service";
import { isWalletPaymentEnabled } from "@zedbot/bot/services/payment-settings.service";
import { getOwnedServiceByShortId } from "@zedbot/bot/services/user-services.service";
import { generateQrPng } from "@zedbot/bot/services/qr-code.service";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { supportFailureLog } from "../support-errors.js";
import { checkSupportMutation, sendMutationRejection } from "../support-guards.js";
import { readMiniAppSwitchFresh } from "../feature-switches.js";
import type { MiniAppCommerceSwitchKey } from "@zedbot/shared";
import { buildAddonDraft, type AddonKind } from "./draft-build.js";
import { sealDraft, type CheckoutDraftCapsule } from "./draft-token.js";
import { randomUUID } from "node:crypto";
import { toCatalogProduct } from "./serializers.js";
import type { CommerceRouteOptions } from "./routes.js";

const logger = createLogger("api");

const ADDON_BODY_LIMIT_BYTES = 16 * 1024;
/** Same ceiling the bot's config screen renders. */
const MAX_CONFIG_LINKS = 10;

type ServiceErrorCode =
  | "FEATURE_DISABLED"
  | "FEATURE_UNAVAILABLE"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "SERVICE_NOT_ELIGIBLE"
  | "PRODUCT_UNAVAILABLE"
  | "DISCOUNT_INVALID"
  | "QR_UNAVAILABLE"
  | "INTERNAL";

function fail(reply: FastifyReply, status: number, code: ServiceErrorCode): FastifyReply {
  return reply.code(status).send({ ok: false, code });
}

function requestUserId(request: FastifyRequest): string {
  const user = request.miniAppUser;
  if (user === undefined) {
    throw new Error("commerce service route reached without an authenticated user");
  }
  return user.id;
}

async function switchDenied(
  reply: FastifyReply,
  keys: readonly MiniAppCommerceSwitchKey[],
): Promise<FastifyReply | null> {
  for (const key of keys) {
    const state = await readMiniAppSwitchFresh(key);
    if (!state.ok) {
      return fail(reply, 503, "FEATURE_UNAVAILABLE");
    }
    if (!state.enabled) {
      return fail(reply, 403, "FEATURE_DISABLED");
    }
  }
  return null;
}

function configLinks(service: { configLinks: unknown }): string[] {
  if (!Array.isArray(service.configLinks)) {
    return [];
  }
  return service.configLinks
    .filter((link): link is string => typeof link === "string" && link !== "")
    .slice(0, MAX_CONFIG_LINKS);
}

const ADDON_KINDS: readonly AddonKind[] = ["RENEWAL", "EXTRA_VOLUME", "EXTRA_TIME"];
const ADDON_SWITCH: Record<AddonKind, MiniAppCommerceSwitchKey> = {
  RENEWAL: "miniapp_service_renewal_enabled",
  EXTRA_VOLUME: "miniapp_extra_volume_enabled",
  EXTRA_TIME: "miniapp_extra_time_enabled",
};

export function registerCommerceServiceRoutes(
  app: FastifyInstance,
  options: CommerceRouteOptions,
): void {
  const gate = (request: FastifyRequest, reply: FastifyReply, userId: string): boolean => {
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

  // --- delivery: subscription link + configs (owner-safe fields only) ---------
  app.get<{ Params: { serviceId: string } }>(
    "/commerce/services/:serviceId/delivery",
    async (request, reply) => {
      const userId = requestUserId(request);
      const denied = await switchDenied(reply, [
        "miniapp_commerce_enabled",
        "miniapp_service_delivery_enabled",
      ]);
      if (denied !== null) {
        return denied;
      }
      const publicId = canonicalCommercePublicId(request.params.serviceId);
      if (publicId === null) {
        return fail(reply, 404, "NOT_FOUND");
      }
      try {
        const service = await getOwnedServiceByShortId(publicId, userId);
        if (service === null) {
          return fail(reply, 404, "NOT_FOUND");
        }
        return reply.send({
          ok: true,
          delivery: {
            servicePublicId: commerceShortId(service),
            username: service.username,
            status: service.status,
            subscriptionUrl: service.subscriptionUrl,
            configLinks: configLinks(service),
          },
        });
      } catch (err) {
        logger.error(
          "miniapp service delivery failed",
          supportFailureLog("commerce-delivery", err),
        );
        return fail(reply, 503, "INTERNAL");
      }
    },
  );

  // --- delivery: QR (server-rendered PNG, the bot's own generator) ------------
  app.get<{ Params: { serviceId: string }; Querystring: Record<string, string> }>(
    "/commerce/services/:serviceId/qr",
    async (request, reply) => {
      const userId = requestUserId(request);
      const denied = await switchDenied(reply, [
        "miniapp_commerce_enabled",
        "miniapp_service_delivery_enabled",
      ]);
      if (denied !== null) {
        return denied;
      }
      const publicId = canonicalCommercePublicId(request.params.serviceId);
      if (publicId === null) {
        return fail(reply, 404, "NOT_FOUND");
      }
      try {
        const service = await getOwnedServiceByShortId(publicId, userId);
        if (service === null) {
          return fail(reply, 404, "NOT_FOUND");
        }
        const target = request.query.target === "config" ? "config" : "sub";
        let payload: string | null = null;
        if (target === "sub") {
          payload = service.subscriptionUrl;
        } else {
          const index = Number.parseInt(request.query.index ?? "0", 10);
          const links = configLinks(service);
          payload =
            Number.isInteger(index) && index >= 0 && index < links.length
              ? links[index]
              : null;
        }
        if (payload === null || payload === "") {
          return fail(reply, 404, "QR_UNAVAILABLE");
        }
        const qr = await generateQrPng(payload);
        if (!qr.ok) {
          return fail(reply, 503, "QR_UNAVAILABLE");
        }
        return reply
          .header("Content-Type", "image/png")
          .header("Content-Disposition", "inline")
          .send(qr.png);
      } catch (err) {
        logger.error("miniapp service qr failed", supportFailureLog("commerce-qr", err));
        return fail(reply, 503, "INTERNAL");
      }
    },
  );

  // --- add-on options: renewal plans + extra volume/time packages -------------
  app.get<{ Params: { serviceId: string } }>(
    "/commerce/services/:serviceId/addons",
    async (request, reply) => {
      const userId = requestUserId(request);
      const denied = await switchDenied(reply, ["miniapp_commerce_enabled"]);
      if (denied !== null) {
        return denied;
      }
      const publicId = canonicalCommercePublicId(request.params.serviceId);
      if (publicId === null) {
        return fail(reply, 404, "NOT_FOUND");
      }
      try {
        const user = await prisma.user.findUnique({ where: { id: userId } });
        if (user === null) {
          return fail(reply, 404, "NOT_FOUND");
        }
        // Owned at all? (404 for foreign/unknown before eligibility detail.)
        const owned = await getOwnedServiceByShortId(publicId, userId);
        if (owned === null) {
          return fail(reply, 404, "NOT_FOUND");
        }
        const walletPayEnabled = await isWalletPaymentEnabled();
        const sections: Record<string, unknown> = {};
        for (const kind of ADDON_KINDS) {
          const switchState = await readMiniAppSwitchFresh(ADDON_SWITCH[kind]);
          const enabled = switchState.ok && switchState.enabled;
          let eligible = false;
          let plans: unknown[] = [];
          if (enabled) {
            const service =
              kind === "RENEWAL"
                ? await getRenewableServiceByShortId(publicId, userId)
                : kind === "EXTRA_VOLUME"
                  ? await getExtraVolumeServiceByShortId(publicId, userId)
                  : await getExtraTimeServiceByShortId(publicId, userId);
            if (service !== null && service.panelId !== null) {
              eligible = true;
              const products =
                kind === "RENEWAL"
                  ? await renewalPlansForPanel(user.group, service.panelId)
                  : kind === "EXTRA_VOLUME"
                    ? await extraVolumePackages(user.group, service.panelId)
                    : await extraTimePackages(user.group, service.panelId);
              plans = products.map(toCatalogProduct);
            }
          }
          sections[kind] = { enabled, eligible, plans };
        }
        return reply.send({ ok: true, walletPayEnabled, addons: sections });
      } catch (err) {
        logger.error(
          "miniapp service addons failed",
          supportFailureLog("commerce-addons", err),
        );
        return fail(reply, 503, "INTERNAL");
      }
    },
  );

  // --- add-on quote (authoritative amounts + sealed draft token) --------------
  app.post<{ Body: unknown; Params: { serviceId: string } }>(
    "/commerce/services/:serviceId/addon-quote",
    { bodyLimit: ADDON_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const userId = requestUserId(request);
      if (!gate(request, reply, userId)) {
        return reply;
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      const kind = ADDON_KINDS.find((k) => k === body.kind);
      const productPublicId = canonicalCommercePublicId(body.productPublicId);
      const servicePublicId = canonicalCommercePublicId(request.params.serviceId);
      if (kind === undefined || productPublicId === null || servicePublicId === null) {
        return fail(reply, 400, "BAD_REQUEST");
      }
      const denied = await switchDenied(reply, [
        "miniapp_commerce_enabled",
        ADDON_SWITCH[kind],
      ]);
      if (denied !== null) {
        return denied;
      }
      try {
        // Resolve the owner-scoped uuids the sealed capsule will carry.
        const service = await getOwnedServiceByShortId(servicePublicId, userId);
        const productMatches = await prisma.product.findMany({
          where: { id: { startsWith: productPublicId } },
          take: 2,
        });
        if (service === null || productMatches.length !== 1) {
          return fail(reply, 404, "NOT_FOUND");
        }
        const capsule: CheckoutDraftCapsule = {
          userId,
          kind,
          serviceId: service.id,
          productId: productMatches[0].id,
          draftNonce: randomUUID(),
          ...(typeof body.discountCode === "string" && body.discountCode.trim() !== ""
            ? { discountCode: body.discountCode.trim() }
            : {}),
          mintedAtMs: Date.now(),
        };
        const built = await buildAddonDraft(userId, kind, capsule);
        if (built.rejected !== undefined) {
          return fail(reply, built.status, built.rejected);
        }
        const walletPayEnabled = await isWalletPaymentEnabled();
        return reply.send({
          ok: true,
          quote: {
            kind,
            servicePublicId,
            productPublicId,
            productName: built.product.name,
            username: built.service.username,
            originalPriceToman: built.draft.originalPriceToman,
            discountAmountToman: built.draft.discountAmountToman,
            finalPriceToman: built.draft.finalPriceToman,
            discountCode: built.draft.discountCode ?? null,
            walletPayEnabled,
            draftToken: sealDraft(capsule),
          },
        });
      } catch (err) {
        logger.error(
          "miniapp addon quote failed",
          supportFailureLog("commerce-addon-quote", err),
        );
        return fail(reply, 503, "INTERNAL");
      }
    },
  );
}
