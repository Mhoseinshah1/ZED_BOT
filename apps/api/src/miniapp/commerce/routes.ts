import { CheckoutStatus, OrderStatus, prisma, type CheckoutSession, type Prisma, type UserGroup } from "@zedbot/database";
import {
  bindSettledReservationFromSnapshot,
  checkoutPublicId,
  createOperationCheckout,
  createPurchaseCheckout,
  isCommerceOperation,
  isMiniAppRolloutEnabled,
  isRenewalIdempotencyKey,
  isServiceOperation,
  issueQuoteForCheckout,
  listServiceOperationOptions,
  loadMiniAppCatalogForUser,
  MINIAPP_COMMERCE_ROLLOUT_KEYS,
  openQuote,
  OPERATION_SETTLE_ROLLOUT_KEY,
  resolveOwnedServiceForUser,
  resolvePurchasableProduct,
  settleWalletOrder,
  type MiniAppCommerceRolloutKey,
  type QuoteDto,
} from "@zedbot/service-renewal";
import { commerceShortId, createLogger } from "@zedbot/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import QRCode from "qrcode";

import { checkSupportMutation, sendMutationRejection, type SupportMutationLimiters } from "../support-guards.js";
import { supportFailureLog } from "../support-errors.js";
import { enqueueCommerceFollowUp } from "./queue.js";
import { commerceFingerprint, isValidClientRequestId, runIdempotentCommerce } from "./idempotency.js";
import { toMiniAppCheckout } from "./serializers.js";

const logger = createLogger("api");
const BODY_LIMIT = 4096;
const MAX_CONFIG_LINKS = 10;

type Code =
  | "FEATURE_DISABLED"
  | "FEATURE_UNAVAILABLE"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "PRODUCT_UNAVAILABLE"
  | "SERVICE_NOT_ELIGIBLE"
  | "OPTION_UNAVAILABLE"
  | "CHECKOUT_UNAVAILABLE"
  | "DISCOUNT_INVALID"
  | "QUOTE_EXPIRED"
  | "QUOTE_STALE"
  | "INSUFFICIENT_BALANCE"
  | "IDEMPOTENCY_CONFLICT"
  | "WALLET_DISABLED"
  | "INTERNAL";

export interface CommerceRouteOptions {
  allowedOrigins: ReadonlySet<string>;
  production: boolean;
  limiters: SupportMutationLimiters;
}

function fail(reply: FastifyReply, status: number, code: Code): FastifyReply {
  return reply.code(status).send({ ok: false, code });
}

function user(request: FastifyRequest) {
  if (request.miniAppUser === undefined) throw new Error("authenticated Mini App user missing");
  return request.miniAppUser;
}

async function requireRollout(reply: FastifyReply, keys: readonly MiniAppCommerceRolloutKey[]) {
  try {
    for (const key of keys) {
      if (!(await isMiniAppRolloutEnabled(key))) return fail(reply, 403, "FEATURE_DISABLED");
    }
    return null;
  } catch {
    return fail(reply, 503, "FEATURE_UNAVAILABLE");
  }
}

async function walletEnabled(): Promise<boolean> {
  try {
    const row = await prisma.setting.findUnique({ where: { key: "wallet_payment_enabled" }, select: { value: true } });
    return row !== null && ["true", "1", "yes"].includes(row.value.trim().toLowerCase());
  } catch {
    return false;
  }
}

function snapshot(checkout: CheckoutSession): Record<string, unknown> {
  return typeof checkout.productSnapshot === "object" && checkout.productSnapshot !== null && !Array.isArray(checkout.productSnapshot)
    ? checkout.productSnapshot as Record<string, unknown>
    : {};
}

function validMoney(checkout: CheckoutSession): boolean {
  return Number.isSafeInteger(checkout.originalPriceToman) && checkout.originalPriceToman > 0 &&
    Number.isSafeInteger(checkout.discountAmountToman) && checkout.discountAmountToman >= 0 &&
    Number.isSafeInteger(checkout.finalPriceToman) && checkout.finalPriceToman > 0 &&
    checkout.originalPriceToman - checkout.discountAmountToman === checkout.finalPriceToman;
}

function quoteResponse(dto: QuoteDto, checkout: CheckoutSession, walletPayEnabled: boolean) {
  const captured = snapshot(checkout);
  return {
    kind: dto.operation === "NEW_PURCHASE" ? "SERVICE" : dto.operation,
    productPublicId: typeof captured.productId === "string" ? captured.productId.slice(0, 8) : "",
    productName: dto.optionLabel,
    panelName: typeof captured.panelName === "string" ? captured.panelName : null,
    username: dto.serviceLabel || null,
    note: typeof captured.serviceUserNote === "string" ? captured.serviceUserNote : null,
    originalPriceToman: dto.originalPriceToman,
    discountAmountToman: dto.discountAmountToman,
    finalPriceToman: dto.finalPriceToman,
    discountCode: dto.discountCode,
    discountStackingRejected: false,
    needsCustomerInputBeforePayment: false,
    walletPayEnabled,
    affordable: dto.affordable,
    walletBalanceToman: dto.walletBalanceToman,
    expectedBalanceAfterToman: dto.expectedBalanceAfterToman,
    quoteExpiresAt: dto.quoteExpiresAt,
    draftToken: dto.quote,
  };
}

async function checkoutByInternalId(userId: string, id: string): Promise<CheckoutSession | null> {
  return prisma.checkoutSession.findFirst({ where: { id, userId } });
}

function publicCheckoutWhere(userId: string, publicId: string) {
  return /^[0-9a-f]{8}$/i.test(publicId)
    ? { userId, id: { startsWith: publicId.toLowerCase() } }
    : null;
}

export function registerCommerceRoutes(app: FastifyInstance, options: CommerceRouteOptions): void {
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

  app.get("/commerce/flags", async (request, reply) => {
    void user(request);
    const entries = await Promise.all(MINIAPP_COMMERCE_ROLLOUT_KEYS.map(async key => [key, await isMiniAppRolloutEnabled(key)] as const));
    return reply.send({ ok: true, flags: Object.fromEntries(entries) });
  });

  app.get("/commerce/catalog", async (request, reply) => {
    const denied = await requireRollout(reply, ["miniapp_commerce_browse_enabled"]);
    if (denied !== null) return denied;
    const owner = user(request);
    try {
      const dto = await loadMiniAppCatalogForUser(owner.group as UserGroup);
      return reply.send({
        ok: true,
        servicePanels: dto.locations.map(location => ({
          publicId: location.locationId,
          name: location.label,
          fromPriceToman: location.fromPriceToman,
          productCount: location.productCount,
          categories: location.categories.map(category => ({
            publicId: category.categoryId,
            name: category.label,
            products: category.products.map(product => ({
              publicId: product.productId,
              name: product.label,
              description: product.description,
              priceToman: product.priceToman,
              volumeGb: product.trafficGb,
              durationDays: product.durationDays,
              serviceLocation: product.location,
            })),
          })),
        })),
        otherProductCategories: [],
      });
    } catch (err) {
      logger.error("miniapp commerce catalog failed", supportFailureLog("commerce-catalog", err));
      return fail(reply, 503, "INTERNAL");
    }
  });

  app.get<{ Params: { productId: string } }>("/commerce/products/:productId", async (request, reply) => {
    const denied = await requireRollout(reply, ["miniapp_commerce_browse_enabled"]);
    if (denied !== null) return denied;
    const owner = user(request);
    const resolved = await resolvePurchasableProduct(prisma, owner.group as UserGroup, request.params.productId);
    if (!resolved.ok) return fail(reply, 404, "PRODUCT_UNAVAILABLE");
    const p = resolved.product;
    return reply.send({ ok: true, product: {
      publicId: p.id.slice(0, 8), name: p.name, description: p.invoiceDescription ?? "",
      panelPublicId: p.panelId?.slice(0, 8) ?? null, panelName: p.panel?.name ?? null,
      categoryPublicId: p.categoryId.slice(0, 8), categoryName: p.category.name,
      priceToman: p.priceToman, durationDays: p.durationDays, volumeGb: p.volumeGb,
      serviceLocation: p.serviceLocation,
    }});
  });

  app.post<{ Body: unknown }>("/commerce/quote", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const owner = user(request);
    if (!gate(request, reply, owner.id)) return reply;
    const denied = await requireRollout(reply, ["miniapp_commerce_checkout_enabled"]);
    if (denied !== null) return denied;
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (body.kind !== "SERVICE" || typeof body.productPublicId !== "string" ||
        (body.usernameMode !== "RANDOM" && body.usernameMode !== "CUSTOM") ||
        !isValidClientRequestId(body.clientRequestId)) return fail(reply, 400, "BAD_REQUEST");
    const note = typeof body.note === "string" ? body.note.trim() : "";
    const discountCode = typeof body.discountCode === "string" ? body.discountCode.trim() : "";
    if (note.length > 200 || discountCode.length > 64) return fail(reply, 400, "BAD_REQUEST");
    const username = typeof body.username === "string" ? body.username : "";
    const fingerprint = commerceFingerprint(["purchase", body.productPublicId, body.usernameMode, username, note, discountCode]);
    try {
      const outcome = await runIdempotentCommerce({
        userId: owner.id, clientRequestId: body.clientRequestId,
        operation: "commerce-checkout-confirm", fingerprint,
      }, async () => {
        const created = await createPurchaseCheckout(prisma, {
          userId: owner.id, group: owner.group as UserGroup, publicProductId: body.productPublicId as string,
          usernameMode: body.usernameMode as "RANDOM" | "CUSTOM", requestedUsername: username,
          draftNonce: body.clientRequestId as string,
          ...(note !== "" ? { note } : {}), ...(discountCode !== "" ? { discountCode } : {}),
        });
        if (!created.ok) throw new DomainRefusal(created.code);
        return { resultCheckoutSessionId: created.checkout.id, resultPaymentId: null };
      });
      if (outcome.kind === "conflict") return fail(reply, 409, "IDEMPOTENCY_CONFLICT");
      const checkoutId = outcome.kind === "executed" ? outcome.value.resultCheckoutSessionId : outcome.stored.resultCheckoutSessionId;
      if (checkoutId === null) return fail(reply, 503, "INTERNAL");
      const checkout = await checkoutByInternalId(owner.id, checkoutId);
      if (checkout === null) return fail(reply, 404, "CHECKOUT_UNAVAILABLE");
      const issued = await issueQuoteForCheckout(prisma, { userId: owner.id, group: owner.group as UserGroup, publicCheckoutId: checkoutPublicId(checkout), walletBalanceToman: owner.balanceToman });
      if (!issued.ok) return fail(reply, 409, mapDomainCode(issued.code));
      return reply.send({ ok: true, quote: quoteResponse(issued.dto, checkout, await walletEnabled()) });
    } catch (err) {
      if (err instanceof DomainRefusal) return fail(reply, 409, mapDomainCode(err.code));
      logger.error("miniapp purchase quote failed", supportFailureLog("commerce-purchase-quote", err));
      return fail(reply, 503, "INTERNAL");
    }
  });

  app.post<{ Params: { serviceId: string }; Body: unknown }>("/commerce/services/:serviceId/addon-quote", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const owner = user(request);
    if (!gate(request, reply, owner.id)) return reply;
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!isServiceOperation(body.kind) || typeof body.productPublicId !== "string" || !isValidClientRequestId(body.clientRequestId)) return fail(reply, 400, "BAD_REQUEST");
    const operation = body.kind;
    const denied = await requireRollout(reply, ["miniapp_commerce_checkout_enabled", OPERATION_SETTLE_ROLLOUT_KEY[operation]]);
    if (denied !== null) return denied;
    const discountCode = typeof body.discountCode === "string" ? body.discountCode.trim() : "";
    const fingerprint = commerceFingerprint([operation, request.params.serviceId, body.productPublicId, discountCode]);
    try {
      const outcome = await runIdempotentCommerce({ userId: owner.id, clientRequestId: body.clientRequestId, operation: "commerce-checkout-confirm", fingerprint }, async () => {
        const created = await createOperationCheckout(prisma, { userId: owner.id, group: owner.group as UserGroup, operation, publicServiceId: request.params.serviceId, publicOptionId: body.productPublicId as string, ...(discountCode !== "" ? { discountCode } : {}) });
        if (!created.ok) throw new DomainRefusal(created.code);
        return { resultCheckoutSessionId: created.checkout.id, resultPaymentId: null };
      });
      if (outcome.kind === "conflict") return fail(reply, 409, "IDEMPOTENCY_CONFLICT");
      const checkoutId = outcome.kind === "executed" ? outcome.value.resultCheckoutSessionId : outcome.stored.resultCheckoutSessionId;
      const checkout = checkoutId === null ? null : await checkoutByInternalId(owner.id, checkoutId);
      if (checkout === null) return fail(reply, 404, "CHECKOUT_UNAVAILABLE");
      const issued = await issueQuoteForCheckout(prisma, { userId: owner.id, group: owner.group as UserGroup, publicCheckoutId: checkoutPublicId(checkout), walletBalanceToman: owner.balanceToman });
      if (!issued.ok) return fail(reply, 409, mapDomainCode(issued.code));
      return reply.send({ ok: true, quote: {
        kind: operation, servicePublicId: request.params.serviceId, productPublicId: body.productPublicId,
        productName: issued.dto.optionLabel, username: issued.dto.serviceLabel,
        originalPriceToman: issued.dto.originalPriceToman, discountAmountToman: issued.dto.discountAmountToman,
        finalPriceToman: issued.dto.finalPriceToman, discountCode: issued.dto.discountCode,
        walletPayEnabled: await walletEnabled(), affordable: issued.dto.affordable,
        walletBalanceToman: issued.dto.walletBalanceToman, expectedBalanceAfterToman: issued.dto.expectedBalanceAfterToman,
        quoteExpiresAt: issued.dto.quoteExpiresAt, draftToken: issued.dto.quote,
      }});
    } catch (err) {
      if (err instanceof DomainRefusal) return fail(reply, 409, mapDomainCode(err.code));
      logger.error("miniapp addon quote failed", supportFailureLog("commerce-addon-quote", err));
      return fail(reply, 503, "INTERNAL");
    }
  });

  app.post<{ Body: unknown }>("/commerce/checkout", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const owner = user(request);
    if (!gate(request, reply, owner.id)) return reply;
    const token = (request.body as Record<string, unknown> | null)?.draftToken;
    const opened = openQuote(token);
    if (!opened.ok) return fail(reply, 400, opened.reason === "EXPIRED" ? "QUOTE_EXPIRED" : "BAD_REQUEST");
    if (opened.payload.userId !== owner.id) return fail(reply, 400, "BAD_REQUEST");
    const checkout = await checkoutByInternalId(owner.id, opened.payload.checkoutId);
    if (checkout === null) return fail(reply, 404, "CHECKOUT_UNAVAILABLE");
    return reply.send({ ok: true, checkout: toMiniAppCheckout(checkout) });
  });

  app.post<{ Body: unknown }>("/commerce/pay/wallet", { bodyLimit: BODY_LIMIT }, async (request, reply) => {
    const owner = user(request);
    if (!gate(request, reply, owner.id)) return reply;
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (!isRenewalIdempotencyKey(body.clientRequestId)) return fail(reply, 400, "BAD_REQUEST");
    const opened = openQuote(body.draftToken);
    if (!opened.ok) return fail(reply, 400, opened.reason === "EXPIRED" ? "QUOTE_EXPIRED" : "BAD_REQUEST");
    if (opened.payload.userId !== owner.id || !isCommerceOperation(opened.payload.operation)) return fail(reply, 400, "BAD_REQUEST");
    const operation = opened.payload.operation;
    const denied = await requireRollout(reply, [OPERATION_SETTLE_ROLLOUT_KEY[operation]]);
    if (denied !== null) return denied;
    const checkout = await checkoutByInternalId(owner.id, opened.payload.checkoutId);
    if (checkout === null || checkout.status !== CheckoutStatus.PENDING || !validMoney(checkout)) return fail(reply, 409, "CHECKOUT_UNAVAILABLE");
    const freshUser = await prisma.user.findUnique({ where: { id: owner.id }, select: { balanceToman: true, group: true } });
    if (freshUser === null) return fail(reply, 404, "NOT_FOUND");
    const fresh = await issueQuoteForCheckout(prisma, { userId: owner.id, group: freshUser.group, publicCheckoutId: checkoutPublicId(checkout), walletBalanceToman: freshUser.balanceToman });
    if (!fresh.ok) return fail(reply, 409, mapDomainCode(fresh.code));
    if (fresh.dto.quote === "") return fail(reply, 409, "QUOTE_STALE");
    const freshOpened = openQuote(fresh.dto.quote);
    if (!freshOpened.ok || freshOpened.payload.fingerprint !== opened.payload.fingerprint || opened.payload.finalPriceToman !== checkout.finalPriceToman || opened.payload.operation !== freshOpened.payload.operation) return fail(reply, 409, "QUOTE_STALE");
    const captured = snapshot(checkout);
    const result = await settleWalletOrder({
      userId: owner.id, orderType: checkout.orderType!, productId: checkout.productId!, serviceId: checkout.serviceId,
      snapshot: captured as Prisma.InputJsonObject, originalPriceToman: checkout.originalPriceToman,
      discountAmountToman: checkout.discountAmountToman, finalPriceToman: checkout.finalPriceToman,
      discountCodeId: checkout.discountCodeId, idempotencyKey: body.clientRequestId,
      existingCheckoutId: checkout.id, isWalletEnabled: walletEnabled,
      ...(operation === "NEW_PURCHASE" ? { claimReservation: async (tx: Prisma.TransactionClient, checkoutSessionId: string, orderId: string) => (await bindSettledReservationFromSnapshot(tx, captured, { userId: owner.id, checkoutSessionId, orderId })).bound } : {}),
    });
    if (!result.ok) return fail(reply, result.code === "INSUFFICIENT_BALANCE" ? 409 : 400, mapDomainCode(result.code));
    await enqueueCommerceFollowUp({ name: "fulfill-paid-order", orderId: result.order.id });
    return reply.code(result.alreadyPaid ? 200 : 201).send({ ok: true, checkout: toMiniAppCheckout(result.checkout), paymentPublicId: commerceShortId(result.payment), orderPublicId: commerceShortId(result.order), balanceToman: result.newBalanceToman, fulfillmentStatus: result.order.status });
  });

  app.get<{ Params: { checkoutId: string } }>("/commerce/checkouts/:checkoutId", async (request, reply) => {
    const owner = user(request); const where = publicCheckoutWhere(owner.id, request.params.checkoutId);
    if (where === null) return fail(reply, 404, "NOT_FOUND");
    const rows = await prisma.checkoutSession.findMany({ where, take: 2 });
    if (rows.length !== 1) return fail(reply, 404, "NOT_FOUND");
    return reply.send({ ok: true, checkout: toMiniAppCheckout(rows[0]) });
  });

  registerReadRoutes(app);
}

class DomainRefusal extends Error { constructor(readonly code: string) { super(code); } }

function mapDomainCode(code: string): Code {
  if (["PRODUCT_UNAVAILABLE", "SERVICE_NOT_ELIGIBLE", "OPTION_UNAVAILABLE", "CHECKOUT_UNAVAILABLE", "INSUFFICIENT_BALANCE", "IDEMPOTENCY_CONFLICT", "QUOTE_EXPIRED", "QUOTE_STALE", "WALLET_DISABLED"].includes(code)) return code as Code;
  if (code === "SERVICE_NOT_FOUND") return "NOT_FOUND";
  if (code === "DISCOUNT_CHANGED" || code === "DISCOUNT_INVALID") return "DISCOUNT_INVALID";
  return "INTERNAL";
}

function links(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v !== "").slice(0, MAX_CONFIG_LINKS) : [];
}

function registerReadRoutes(app: FastifyInstance): void {
  app.get<{ Params: { serviceId: string } }>("/commerce/services/:serviceId/delivery", async (request, reply) => {
    const owner = user(request);
    const denied = await requireRollout(reply, ["miniapp_commerce_browse_enabled"]);
    if (denied !== null) return denied;
    const owned = await resolveOwnedServiceForUser(owner.id, request.params.serviceId, "readService");
    if (owned === null) return fail(reply, 404, "NOT_FOUND");
    return reply.send({ ok: true, delivery: { servicePublicId: owned.service.id.slice(0, 8), username: owned.service.username, status: owned.service.status, subscriptionUrl: owned.service.subscriptionUrl, configLinks: links(owned.service.configLinks) } });
  });

  app.get<{ Params: { serviceId: string }; Querystring: { target?: string; index?: string } }>("/commerce/services/:serviceId/qr", async (request, reply) => {
    const owner = user(request); const denied = await requireRollout(reply, ["miniapp_commerce_browse_enabled"]);
    if (denied !== null) return denied;
    const owned = await resolveOwnedServiceForUser(owner.id, request.params.serviceId, "readService");
    if (owned === null) return fail(reply, 404, "NOT_FOUND");
    const configs = links(owned.service.configLinks);
    const index = Number.parseInt(request.query.index ?? "0", 10);
    const value = request.query.target === "config" && Number.isSafeInteger(index) ? configs[index] : owned.service.subscriptionUrl;
    if (typeof value !== "string" || value === "") return fail(reply, 404, "NOT_FOUND");
    const png = await QRCode.toBuffer(value, { type: "png", errorCorrectionLevel: "M", margin: 2, width: 512 });
    return reply.header("Content-Type", "image/png").send(png);
  });

  app.get<{ Params: { serviceId: string } }>("/commerce/services/:serviceId/addons", async (request, reply) => {
    const owner = user(request); const denied = await requireRollout(reply, ["miniapp_commerce_browse_enabled"]);
    if (denied !== null) return denied;
    const owned = await resolveOwnedServiceForUser(owner.id, request.params.serviceId, "readService");
    if (owned === null) return fail(reply, 404, "NOT_FOUND");
    const addons: Record<string, unknown> = {};
    for (const operation of ["RENEWAL", "EXTRA_VOLUME", "EXTRA_TIME"] as const) {
      const enabled = await isMiniAppRolloutEnabled(OPERATION_SETTLE_ROLLOUT_KEY[operation]);
      const listed = enabled ? await listServiceOperationOptions(prisma, { userId: owner.id, group: owner.group as UserGroup, operation, publicServiceId: request.params.serviceId }) : null;
      addons[operation] = { enabled, eligible: listed?.ok === true, plans: listed?.ok === true ? listed.options.map(o => ({ publicId: o.optionId, name: o.label, priceToman: o.priceToman, volumeGb: o.trafficGb, durationDays: o.durationDays, serviceLocation: null })) : [] };
    }
    return reply.send({ ok: true, walletPayEnabled: await walletEnabled(), addons });
  });

  app.get<{ Querystring: { page?: string } }>("/commerce/history", async (request, reply) => {
    const owner = user(request); const page = Math.max(1, Number.parseInt(request.query.page ?? "1", 10) || 1); const take = 20;
    const [orders, total] = await Promise.all([
      prisma.order.findMany({ where: { userId: owner.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * take, take }),
      prisma.order.count({ where: { userId: owner.id } }),
    ]);
    return reply.send({ ok: true, page, pages: Math.max(1, Math.ceil(total / take)), total, items: orders.map(o => ({ itemType: "ORDER", publicId: commerceShortId(o), orderType: o.type, status: o.status, amountToman: o.finalPriceToman, createdAt: o.createdAt.toISOString() })) });
  });

  app.get<{ Params: { paymentId: string } }>("/commerce/payments/:paymentId", async (request, reply) => {
    const owner = user(request);
    if (!/^[0-9a-f]{8}$/i.test(request.params.paymentId)) return fail(reply, 404, "NOT_FOUND");
    const matches = await prisma.payment.findMany({
      where: { userId: owner.id, id: { startsWith: request.params.paymentId.toLowerCase() } },
      take: 2,
    });
    if (matches.length !== 1) return fail(reply, 404, "NOT_FOUND");
    const payment = matches[0];
    const [order, checkout] = await Promise.all([
      payment.orderId === null ? null : prisma.order.findFirst({ where: { id: payment.orderId, userId: owner.id } }),
      payment.checkoutSessionId === null ? null : prisma.checkoutSession.findFirst({ where: { id: payment.checkoutSessionId, userId: owner.id } }),
    ]);
    const service = order?.serviceId === null || order?.serviceId === undefined
      ? null
      : await prisma.service.findFirst({ where: { id: order.serviceId, userId: owner.id }, select: { id: true } });
    return reply.send({ ok: true, payment: {
      publicId: commerceShortId(payment), status: payment.status,
      settlementStatus: payment.settlementStatus, purpose: payment.purpose,
      amountToman: payment.amountToman, createdAt: payment.createdAt.toISOString(),
      expiresAt: payment.expiresAt?.toISOString() ?? null,
    }, checkout: checkout === null ? null : toMiniAppCheckout(checkout),
    orderPublicId: order === null ? null : commerceShortId(order), orderStatus: order?.status ?? null,
    servicePublicId: service === null ? null : commerceShortId(service) });
  });

  app.get<{ Params: { orderId: string } }>("/commerce/orders/:orderId", async (request, reply) => {
    const owner = user(request); if (!/^[0-9a-f]{8}$/i.test(request.params.orderId)) return fail(reply, 404, "NOT_FOUND");
    const rows = await prisma.order.findMany({ where: { userId: owner.id, id: { startsWith: request.params.orderId.toLowerCase() } }, include: { payment: true, service: true, checkoutSession: true }, take: 2 });
    if (rows.length !== 1) return fail(reply, 404, "NOT_FOUND"); const o = rows[0];
    return reply.send({ ok: true, order: { publicId: commerceShortId(o), orderType: o.type, status: o.status, productName: o.productNameSnapshot, amountToman: o.finalPriceToman, createdAt: o.createdAt.toISOString(), paidAt: o.paidAt?.toISOString() ?? null, completedAt: o.completedAt?.toISOString() ?? null, failureVisible: o.status === OrderStatus.FAILED, reconciliationPending: o.status === OrderStatus.PROVISIONING, paymentPublicId: o.payment ? commerceShortId(o.payment) : null, servicePublicId: o.service ? commerceShortId(o.service) : null, checkoutPublicId: o.checkoutSession ? commerceShortId(o.checkoutSession) : null, isOtherProduct: false } });
  });
}
