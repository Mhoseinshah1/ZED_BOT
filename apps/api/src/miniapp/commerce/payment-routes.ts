// =============================================================================
// Mini App commerce routes — Phase 1, part B (miniapp-commerce-parity):
// payment methods, wallet payment, wallet top-up, card-to-card with browser
// receipt upload, online-gateway initiation and owner-scoped payment status.
//
// ONE AUTHORITY (§4, §10–§14): the money functions are the bot's —
// payPurchaseDraftWithWallet (atomic CAS deduction + ledger + order),
// createWalletTopupCheckout (limits + purpose WALLET_CHARGE),
// getAvailablePaymentMethods (provider gating), pickCardAccountForGateway,
// submitReceipt (same Payment/ManualReceipt review pipeline the bot admins
// work), getOrCreateGatewayPayment and settleGatewayPayment (the CAS money
// gate). This module adds transport concerns only: HTTP validation, sealed
// draft tokens, fresh fail-closed switches, payload-bound idempotency, DTO
// allowlists — and hands Telegram-facing follow-up (fulfilment, notices) to
// the bot through the durable follow-up queue, with the bot's sweeps as the
// recovery path.
//
// The browser NEVER settles anything by claiming success: gateway payments
// are marked paid only by verified provider evidence (server-side verify /
// signed IPN / bot updates), and the status endpoint's settle-on-poll is the
// same idempotent settleGatewayPayment the bot's «بررسی وضعیت» button runs.
// =============================================================================
import { createHash } from "node:crypto";

import { CheckoutStatus, prisma, type CheckoutSession, type User } from "@zedbot/database";
import {
  canonicalCommercePublicId,
  commerceShortId,
  createLogger,
  getTelegramBotToken,
  MINIAPP_COMMERCE_JOB_NAMES,
} from "@zedbot/shared";
import { decryptSecret } from "@zedbot/shared";
import {
  getOrCreateGatewayPayment,
  isOnlineProvider,
  settleGatewayPayment,
} from "@zedbot/bot/services/gateway-payment.service";
import {
  getAvailablePaymentMethods,
  pickCardAccountForGateway,
  submitReceipt,
} from "@zedbot/bot/services/payment-method.service";
import {
  payPurchaseDraftWithWallet,
  walletPaymentErrorCode,
} from "@zedbot/bot/services/wallet-payment.service";
import {
  createWalletTopupCheckout,
  walletTopupLimits,
} from "@zedbot/bot/services/wallet-topup.service";
import { isWalletPaymentEnabled } from "@zedbot/bot/services/payment-settings.service";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { supportFailureLog } from "../support-errors.js";
import { checkSupportMutation, sendMutationRejection } from "../support-guards.js";
import { readMiniAppSwitchFresh } from "../feature-switches.js";
import { openDraft } from "./draft-token.js";
import { buildValidatedDraft } from "./draft-build.js";
import {
  commerceFingerprint,
  isValidClientRequestId,
  runIdempotentCommerce,
} from "./idempotency.js";
import { enqueueCommerceFollowUp } from "./queue.js";
import { verifyReceiptFile } from "./receipt-file.js";
import { toMiniAppCheckout } from "./serializers.js";
import type { CommerceRouteOptions } from "./routes.js";

const logger = createLogger("api");

const PAY_BODY_LIMIT_BYTES = 16 * 1024;
/** Receipt uploads carry base64 file bytes; bounded separately. */
const RECEIPT_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const RECEIPT_TEXT_MAX_CHARS = 1000;
/** Unconsumed browser uploads are swept after this horizon. */
const RECEIPT_UPLOAD_TTL_MS = 24 * 60 * 60_000;

type PaymentErrorCode =
  | "FEATURE_DISABLED"
  | "FEATURE_UNAVAILABLE"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "CHECKOUT_NOT_PAYABLE"
  | "CHECKOUT_EXPIRED"
  | "METHOD_UNAVAILABLE"
  | "INSUFFICIENT_BALANCE"
  | "WALLET_PAYMENT_DISABLED"
  | "PRODUCT_UNAVAILABLE"
  | "DISCOUNT_INVALID"
  | "RESERVATION_NOT_CLAIMABLE"
  | "NEEDS_CUSTOMER_INPUT"
  | "AMOUNT_OUT_OF_RANGE"
  | "RECEIPT_ALREADY_SUBMITTED"
  | "RECEIPT_FILE_INVALID"
  | "DRAFT_EXPIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "GATEWAY_UNAVAILABLE"
  | "INTERNAL";

function fail(reply: FastifyReply, status: number, code: PaymentErrorCode): FastifyReply {
  return reply.code(status).send({ ok: false, code });
}

function requestUserId(request: FastifyRequest): string {
  const user = request.miniAppUser;
  if (user === undefined) {
    throw new Error("commerce payment route reached without an authenticated user");
  }
  return user.id;
}

async function loadUser(userId: string): Promise<User | null> {
  return prisma.user.findUnique({ where: { id: userId } });
}

async function resolveOwnedCheckout(
  userId: string,
  rawPublicId: string,
): Promise<CheckoutSession | null> {
  const publicId = canonicalCommercePublicId(rawPublicId);
  if (publicId === null) {
    return null;
  }
  const matches = await prisma.checkoutSession.findMany({
    where: { id: { startsWith: publicId }, userId },
    take: 2,
  });
  return matches.length === 1 ? matches[0] : null;
}

/** The same read-time expiry rule the bot applies before offering payment. */
function checkoutIsPayable(checkout: CheckoutSession, now: Date): "ok" | "expired" | "not-pending" {
  if (checkout.status !== CheckoutStatus.PENDING || checkout.settledByPaymentId !== null) {
    return "not-pending";
  }
  return checkout.expiresAt > now ? "ok" : "expired";
}

type MiniAppMethodType = "CARD_TO_CARD" | "ZARINPAL" | "NOWPAYMENTS" | "TELEGRAM_STARS";

/** Provider gating (the bot's) AND the Mini App rollout switches (§5/§10). */
async function miniAppMethodAllowed(type: string): Promise<boolean> {
  if (type === "CARD_TO_CARD") {
    const s = await readMiniAppSwitchFresh("miniapp_card_to_card_enabled");
    return s.ok && s.enabled;
  }
  if (type === "ZARINPAL" || type === "NOWPAYMENTS" || type === "TELEGRAM_STARS") {
    const s = await readMiniAppSwitchFresh("miniapp_online_payments_enabled");
    return s.ok && s.enabled;
  }
  return false; // PLISIO/AGHAYEPARDAKHT/CUSTOM have no adapter — never faked
}

async function masterSwitchDenied(reply: FastifyReply): Promise<FastifyReply | null> {
  const state = await readMiniAppSwitchFresh("miniapp_commerce_enabled");
  if (!state.ok) {
    return fail(reply, 503, "FEATURE_UNAVAILABLE");
  }
  return state.enabled ? null : fail(reply, 403, "FEATURE_DISABLED");
}

/** Telegram createInvoiceLink over plain HTTPS — the API never imports grammY. */
async function createStarsInvoiceLink(invoice: {
  title: string;
  description: string;
  payload: string;
  stars: number;
}): Promise<string | null> {
  const token = getTelegramBotToken();
  if (token === null || token === "") {
    return null;
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/createInvoiceLink`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: invoice.title,
        description: invoice.description,
        payload: invoice.payload,
        currency: "XTR",
        prices: [{ label: "پرداخت", amount: invoice.stars }],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const parsed = (await response.json()) as { ok?: boolean; result?: unknown };
    return parsed.ok === true && typeof parsed.result === "string" ? parsed.result : null;
  } catch {
    return null;
  }
}

export function registerCommercePaymentRoutes(
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

  // --- payment methods for a checkout ----------------------------------------
  app.get<{ Params: { checkoutId: string } }>(
    "/commerce/checkouts/:checkoutId/methods",
    async (request, reply) => {
      const userId = requestUserId(request);
      const denied = await masterSwitchDenied(reply);
      if (denied !== null) {
        return denied;
      }
      try {
        const user = await loadUser(userId);
        const checkout = await resolveOwnedCheckout(userId, request.params.checkoutId);
        if (user === null || checkout === null) {
          return fail(reply, 404, "NOT_FOUND");
        }
        const payable = checkoutIsPayable(checkout, new Date());
        if (payable === "expired") {
          return fail(reply, 410, "CHECKOUT_EXPIRED");
        }
        if (payable === "not-pending") {
          return fail(reply, 409, "CHECKOUT_NOT_PAYABLE");
        }
        const gateways = await getAvailablePaymentMethods(user, checkout);
        const methods = [];
        for (const gateway of gateways) {
          if (await miniAppMethodAllowed(gateway.type)) {
            methods.push({
              publicId: commerceShortId(gateway),
              type: gateway.type as MiniAppMethodType,
              name: gateway.name,
            });
          }
        }
        return reply.send({ ok: true, methods });
      } catch (err) {
        logger.error(
          "miniapp commerce methods failed",
          supportFailureLog("commerce-methods", err),
        );
        return fail(reply, 503, "INTERNAL");
      }
    },
  );

  // --- wallet payment (from the QUOTE, exactly like the bot's pre-invoice) ----
  app.post<{ Body: unknown }>(
    "/commerce/pay/wallet",
    { bodyLimit: PAY_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const userId = requestUserId(request);
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
      const denied = await masterSwitchDenied(reply);
      if (denied !== null) {
        return denied;
      }
      if (capsule.kind === "OTHER") {
        const other = await readMiniAppSwitchFresh("miniapp_other_products_enabled");
        if (!other.ok) {
          return fail(reply, 503, "FEATURE_UNAVAILABLE");
        }
        if (!other.enabled) {
          return fail(reply, 403, "FEATURE_DISABLED");
        }
      }

      try {
        const outcome = await runIdempotentCommerce(
          {
            userId,
            clientRequestId: body.clientRequestId,
            operation: "commerce-wallet-pay",
            fingerprint: commerceFingerprint([String(body.draftToken)]),
          },
          async () => {
            const built = await buildValidatedDraft(userId, capsule, "SETTLE");
            if (built.rejected !== undefined) {
              throw new PayRejected(built.rejected, built.status);
            }
            const result = await payPurchaseDraftWithWallet(built.user, built.draft);
            if (!result.ok) {
              if ("needsCustomerInfo" in result) {
                // The materialized PENDING checkout the form must be filled
                // against. Recorded as this request's result so a retry of the
                // same clientRequestId converges on the same checkout.
                await prisma.checkoutSession.updateMany({
                  where: { id: result.checkoutId, origin: null },
                  data: { origin: "MINIAPP" },
                });
                return {
                  resultCheckoutSessionId: result.checkoutId,
                  resultPaymentId: null,
                  needsCustomerInput: true,
                };
              }
              const code = walletPaymentErrorCode(result.error);
              throw new PayRejected(
                code === "INTERNAL" ? "INTERNAL" : code,
                code === "INSUFFICIENT_BALANCE" ? 402 : code === "INTERNAL" ? 503 : 409,
              );
            }
            await prisma.checkoutSession.updateMany({
              where: { id: result.checkout.id, origin: null },
              data: { origin: "MINIAPP" },
            });
            // Telegram-facing fulfilment runs in the bot (queue + sweep fallback).
            await enqueueCommerceFollowUp({
              name: MINIAPP_COMMERCE_JOB_NAMES.FULFILL_ORDER,
              orderId: result.order.id,
            });
            return {
              resultCheckoutSessionId: result.checkout.id,
              resultPaymentId: result.payment.id,
              needsCustomerInput: false,
            };
          },
        );

        if (outcome.kind === "conflict") {
          return fail(reply, 409, "IDEMPOTENCY_CONFLICT");
        }
        const stored = outcome.kind === "executed" ? outcome.value : outcome.stored;
        if (stored.resultCheckoutSessionId === null) {
          return fail(reply, 503, "INTERNAL");
        }
        const checkout = await prisma.checkoutSession.findFirst({
          where: { id: stored.resultCheckoutSessionId, userId },
        });
        if (checkout === null) {
          return fail(reply, 404, "NOT_FOUND");
        }
        if (stored.resultPaymentId === null) {
          // needs-customer-input outcome (or its replay): no money moved.
          return reply.code(409).send({
            ok: false,
            code: "NEEDS_CUSTOMER_INPUT",
            checkout: toMiniAppCheckout(checkout, { needsCustomerInput: true }),
          });
        }
        const payment = await prisma.payment.findFirst({
          where: { id: stored.resultPaymentId, userId },
        });
        const order = await prisma.order.findFirst({
          where: { checkoutSessionId: checkout.id, userId },
        });
        return reply.code(outcome.kind === "executed" ? 201 : 200).send({
          ok: true,
          checkout: toMiniAppCheckout(checkout),
          paymentPublicId: payment !== null ? commerceShortId(payment) : null,
          orderPublicId: order !== null ? commerceShortId(order) : null,
        });
      } catch (err) {
        if (err instanceof PayRejected) {
          return fail(reply, err.status, err.code);
        }
        logger.error("miniapp wallet pay failed", supportFailureLog("commerce-wallet-pay", err));
        return fail(reply, 503, "INTERNAL");
      }
    },
  );

  // --- wallet top-up checkout --------------------------------------------------
  app.post<{ Body: unknown }>(
    "/commerce/topup",
    { bodyLimit: PAY_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const userId = requestUserId(request);
      if (!gate(request, reply, userId)) {
        return reply;
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (!isValidClientRequestId(body.clientRequestId)) {
        return fail(reply, 400, "BAD_REQUEST");
      }
      const denied = await masterSwitchDenied(reply);
      if (denied !== null) {
        return denied;
      }
      const topupSwitch = await readMiniAppSwitchFresh("miniapp_wallet_topup_enabled");
      if (!topupSwitch.ok) {
        return fail(reply, 503, "FEATURE_UNAVAILABLE");
      }
      if (!topupSwitch.enabled) {
        return fail(reply, 403, "FEATURE_DISABLED");
      }
      const amount = body.amountToman;
      if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount <= 0) {
        return fail(reply, 400, "BAD_REQUEST");
      }
      try {
        const user = await loadUser(userId);
        if (user === null) {
          return fail(reply, 404, "NOT_FOUND");
        }
        // Exact whole-Toman arithmetic against the SAME limits the bot enforces.
        const limits = await walletTopupLimits();
        if (amount < limits.minToman || amount > limits.maxToman) {
          return fail(reply, 400, "AMOUNT_OUT_OF_RANGE");
        }
        const outcome = await runIdempotentCommerce(
          {
            userId,
            clientRequestId: body.clientRequestId,
            operation: "commerce-topup-create",
            fingerprint: commerceFingerprint([String(amount)]),
          },
          async () => {
            const checkout = await createWalletTopupCheckout(user, amount);
            await prisma.checkoutSession.update({
              where: { id: checkout.id },
              data: { origin: "MINIAPP" },
            });
            return { resultCheckoutSessionId: checkout.id, resultPaymentId: null };
          },
        );
        if (outcome.kind === "conflict") {
          return fail(reply, 409, "IDEMPOTENCY_CONFLICT");
        }
        const checkoutId =
          outcome.kind === "executed"
            ? outcome.value.resultCheckoutSessionId
            : outcome.stored.resultCheckoutSessionId;
        const checkout = await prisma.checkoutSession.findFirst({
          where: { id: checkoutId ?? "", userId },
        });
        if (checkout === null) {
          return fail(reply, 404, "NOT_FOUND");
        }
        return reply
          .code(outcome.kind === "executed" ? 201 : 200)
          .send({ ok: true, checkout: toMiniAppCheckout(checkout) });
      } catch (err) {
        logger.error("miniapp topup failed", supportFailureLog("commerce-topup", err));
        return fail(reply, 503, "INTERNAL");
      }
    },
  );

  // --- card-to-card: card details (read; the transfer target) ------------------
  app.post<{ Body: unknown; Params: { checkoutId: string } }>(
    "/commerce/checkouts/:checkoutId/pay/card",
    { bodyLimit: PAY_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const userId = requestUserId(request);
      if (!gate(request, reply, userId)) {
        return reply;
      }
      const denied = await masterSwitchDenied(reply);
      if (denied !== null) {
        return denied;
      }
      const cardSwitch = await readMiniAppSwitchFresh("miniapp_card_to_card_enabled");
      if (!cardSwitch.ok) {
        return fail(reply, 503, "FEATURE_UNAVAILABLE");
      }
      if (!cardSwitch.enabled) {
        return fail(reply, 403, "FEATURE_DISABLED");
      }
      try {
        const user = await loadUser(userId);
        const checkout = await resolveOwnedCheckout(userId, request.params.checkoutId);
        if (user === null || checkout === null) {
          return fail(reply, 404, "NOT_FOUND");
        }
        const payable = checkoutIsPayable(checkout, new Date());
        if (payable === "expired") {
          return fail(reply, 410, "CHECKOUT_EXPIRED");
        }
        if (payable === "not-pending") {
          return fail(reply, 409, "CHECKOUT_NOT_PAYABLE");
        }
        const gateways = await getAvailablePaymentMethods(user, checkout);
        const cardGateway = gateways.find((g) => g.type === "CARD_TO_CARD");
        if (cardGateway === undefined) {
          return fail(reply, 409, "METHOD_UNAVAILABLE");
        }
        const account = await pickCardAccountForGateway(cardGateway.id);
        if (account === null) {
          return fail(reply, 409, "METHOD_UNAVAILABLE");
        }
        return reply.send({
          ok: true,
          gatewayPublicId: commerceShortId(cardGateway),
          cardRef: commerceShortId(account),
          cardNumber: decryptSecret(account.cardNumberEncrypted),
          ownerName: account.ownerName,
          amountToman: checkout.finalPriceToman,
          checkoutExpiresAt: checkout.expiresAt.toISOString(),
        });
      } catch (err) {
        logger.error("miniapp card info failed", supportFailureLog("commerce-card", err));
        return fail(reply, 503, "INTERNAL");
      }
    },
  );

  // --- card-to-card: receipt submission (browser upload) -----------------------
  app.post<{ Body: unknown; Params: { checkoutId: string } }>(
    "/commerce/checkouts/:checkoutId/receipt",
    { bodyLimit: RECEIPT_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const userId = requestUserId(request);
      if (!gate(request, reply, userId)) {
        return reply;
      }
      const denied = await masterSwitchDenied(reply);
      if (denied !== null) {
        return denied;
      }
      const cardSwitch = await readMiniAppSwitchFresh("miniapp_card_to_card_enabled");
      if (!cardSwitch.ok) {
        return fail(reply, 503, "FEATURE_UNAVAILABLE");
      }
      if (!cardSwitch.enabled) {
        return fail(reply, 403, "FEATURE_DISABLED");
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (!isValidClientRequestId(body.clientRequestId)) {
        return fail(reply, 400, "BAD_REQUEST");
      }
      const gatewayPublicId = canonicalCommercePublicId(body.gatewayPublicId);
      if (gatewayPublicId === null) {
        return fail(reply, 400, "BAD_REQUEST");
      }
      const text =
        typeof body.text === "string" && body.text.trim() !== ""
          ? body.text.trim().slice(0, RECEIPT_TEXT_MAX_CHARS)
          : null;
      const hasFile = typeof body.fileBase64 === "string" && body.fileBase64 !== "";
      if (!hasFile && text === null) {
        return fail(reply, 400, "BAD_REQUEST");
      }

      // File verification FIRST — before any row is read: malformed bytes are
      // a client error regardless of checkout state, and the idempotency
      // fingerprint must describe the VERIFIED evidence, never raw input.
      let verifiedFile: { mimeType: string; bytes: Buffer } | null = null;
      if (hasFile) {
        const verdict = verifyReceiptFile(body.fileBase64);
        if (!verdict.ok) {
          return fail(reply, 400, "RECEIPT_FILE_INVALID");
        }
        verifiedFile = verdict;
      }

      try {
        const user = await loadUser(userId);
        const checkout = await resolveOwnedCheckout(userId, request.params.checkoutId);
        if (user === null || checkout === null) {
          return fail(reply, 404, "NOT_FOUND");
        }
        const payable = checkoutIsPayable(checkout, new Date());
        if (payable === "expired") {
          return fail(reply, 410, "CHECKOUT_EXPIRED");
        }
        if (payable === "not-pending") {
          return fail(reply, 409, "CHECKOUT_NOT_PAYABLE");
        }
        const gateways = await getAvailablePaymentMethods(user, checkout);
        const cardGateway = gateways.find(
          (g) => g.type === "CARD_TO_CARD" && commerceShortId(g) === gatewayPublicId,
        );
        if (cardGateway === undefined) {
          return fail(reply, 409, "METHOD_UNAVAILABLE");
        }
        const cardRef = canonicalCommercePublicId(body.cardRef);
        const cardAccount =
          cardRef === null
            ? null
            : await prisma.cardToCardAccount.findFirst({
                where: { gatewayId: cardGateway.id, isActive: true, id: { startsWith: cardRef } },
              });
        const evidenceHash =
          verifiedFile !== null
            ? createHash("sha256").update(verifiedFile.bytes).digest("hex")
            : createHash("sha256").update(text ?? "").digest("hex");

        const outcome = await runIdempotentCommerce(
          {
            userId,
            clientRequestId: body.clientRequestId,
            operation: "commerce-receipt-submit",
            fingerprint: commerceFingerprint([checkout.id, gatewayPublicId, evidenceHash]),
          },
          async () => {
            let uploadId: string | undefined;
            if (verifiedFile !== null) {
              const upload = await prisma.miniAppReceiptUpload.create({
                data: {
                  userId,
                  bytes: new Uint8Array(verifiedFile.bytes),
                  mimeType: verifiedFile.mimeType,
                  sizeBytes: verifiedFile.bytes.length,
                  sha256: evidenceHash,
                  expiresAt: new Date(Date.now() + RECEIPT_UPLOAD_TTL_MS),
                },
              });
              uploadId = upload.id;
            }
            const submission = await submitReceipt(
              user,
              checkout,
              cardGateway.id,
              cardAccount?.id,
              { ...(text !== null ? { text } : {}), ...(uploadId !== undefined ? { uploadId } : {}) },
            );
            if (!submission.ok) {
              // The one duplicate-path error the service returns.
              throw new PayRejected("RECEIPT_ALREADY_SUBMITTED", 409);
            }
            if (uploadId !== undefined) {
              await prisma.miniAppReceiptUpload.update({
                where: { id: uploadId },
                data: { consumedAt: new Date() },
              });
            }
            await enqueueCommerceFollowUp({
              name: MINIAPP_COMMERCE_JOB_NAMES.NOTIFY_RECEIPT,
              paymentId: submission.payment.id,
            });
            return {
              resultCheckoutSessionId: checkout.id,
              resultPaymentId: submission.payment.id,
            };
          },
        );

        if (outcome.kind === "conflict") {
          return fail(reply, 409, "IDEMPOTENCY_CONFLICT");
        }
        const stored = outcome.kind === "executed" ? outcome.value : outcome.stored;
        if (stored.resultPaymentId === null) {
          return fail(reply, 503, "INTERNAL");
        }
        const payment = await prisma.payment.findFirst({
          where: { id: stored.resultPaymentId, userId },
        });
        if (payment === null) {
          return fail(reply, 404, "NOT_FOUND");
        }
        return reply.code(outcome.kind === "executed" ? 201 : 200).send({
          ok: true,
          paymentPublicId: commerceShortId(payment),
          status: payment.status,
        });
      } catch (err) {
        if (err instanceof PayRejected) {
          return fail(reply, err.status, err.code);
        }
        logger.error(
          "miniapp receipt submit failed",
          supportFailureLog("commerce-receipt", err),
        );
        return fail(reply, 503, "INTERNAL");
      }
    },
  );

  // --- online gateway initiation ------------------------------------------------
  app.post<{ Body: unknown; Params: { checkoutId: string } }>(
    "/commerce/checkouts/:checkoutId/pay/gateway",
    { bodyLimit: PAY_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const userId = requestUserId(request);
      if (!gate(request, reply, userId)) {
        return reply;
      }
      const denied = await masterSwitchDenied(reply);
      if (denied !== null) {
        return denied;
      }
      const onlineSwitch = await readMiniAppSwitchFresh("miniapp_online_payments_enabled");
      if (!onlineSwitch.ok) {
        return fail(reply, 503, "FEATURE_UNAVAILABLE");
      }
      if (!onlineSwitch.enabled) {
        return fail(reply, 403, "FEATURE_DISABLED");
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (!isValidClientRequestId(body.clientRequestId)) {
        return fail(reply, 400, "BAD_REQUEST");
      }
      const gatewayPublicId = canonicalCommercePublicId(body.gatewayPublicId);
      if (gatewayPublicId === null) {
        return fail(reply, 400, "BAD_REQUEST");
      }
      try {
        const user = await loadUser(userId);
        const checkout = await resolveOwnedCheckout(userId, request.params.checkoutId);
        if (user === null || checkout === null) {
          return fail(reply, 404, "NOT_FOUND");
        }
        const payable = checkoutIsPayable(checkout, new Date());
        if (payable === "expired") {
          return fail(reply, 410, "CHECKOUT_EXPIRED");
        }
        if (payable === "not-pending") {
          return fail(reply, 409, "CHECKOUT_NOT_PAYABLE");
        }
        const gateways = await getAvailablePaymentMethods(user, checkout);
        const gateway = gateways.find(
          (g) => commerceShortId(g) === gatewayPublicId && isOnlineProvider(g.type),
        );
        if (gateway === undefined) {
          return fail(reply, 409, "METHOD_UNAVAILABLE");
        }

        const outcome = await runIdempotentCommerce(
          {
            userId,
            clientRequestId: body.clientRequestId,
            operation: "commerce-gateway-init",
            fingerprint: commerceFingerprint([checkout.id, gateway.id]),
          },
          async () => {
            const result = await getOrCreateGatewayPayment(user, checkout, gateway);
            if (!result.ok) {
              throw new PayRejected("GATEWAY_UNAVAILABLE", 409);
            }
            return {
              resultCheckoutSessionId: checkout.id,
              resultPaymentId: result.payment.id,
            };
          },
        );
        if (outcome.kind === "conflict") {
          return fail(reply, 409, "IDEMPOTENCY_CONFLICT");
        }
        const stored = outcome.kind === "executed" ? outcome.value : outcome.stored;
        if (stored.resultPaymentId === null) {
          return fail(reply, 503, "INTERNAL");
        }
        // Re-run the idempotent creator to resynthesize the redirect/invoice —
        // it reuses the live payment row rather than creating a second one.
        const result = await getOrCreateGatewayPayment(user, checkout, gateway);
        if (!result.ok) {
          return fail(reply, 409, "GATEWAY_UNAVAILABLE");
        }
        let invoiceLink: string | null = null;
        if (result.create.telegramInvoice !== undefined) {
          invoiceLink = await createStarsInvoiceLink({
            title: result.create.telegramInvoice.title,
            description: result.create.telegramInvoice.description,
            payload: result.create.telegramInvoice.payload,
            stars: result.create.telegramInvoice.stars,
          });
          if (invoiceLink === null) {
            return fail(reply, 409, "GATEWAY_UNAVAILABLE");
          }
        }
        return reply.send({
          ok: true,
          paymentPublicId: commerceShortId(result.payment),
          redirectUrl: result.create.redirectUrl ?? null,
          starsInvoiceLink: invoiceLink,
        });
      } catch (err) {
        if (err instanceof PayRejected) {
          return fail(reply, err.status, err.code);
        }
        logger.error(
          "miniapp gateway init failed",
          supportFailureLog("commerce-gateway", err),
        );
        return fail(reply, 503, "INTERNAL");
      }
    },
  );

  // --- payment status (poll target; settle-on-poll like the bot's check button) -
  app.get<{ Params: { paymentId: string } }>(
    "/commerce/payments/:paymentId",
    async (request, reply) => {
      const userId = requestUserId(request);
      const publicId = canonicalCommercePublicId(request.params.paymentId);
      if (publicId === null) {
        return fail(reply, 404, "NOT_FOUND");
      }
      try {
        const matches = await prisma.payment.findMany({
          where: { id: { startsWith: publicId }, userId },
          take: 2,
        });
        if (matches.length !== 1) {
          return fail(reply, 404, "NOT_FOUND");
        }
        let payment = matches[0];

        // Same semantics as the bot's «بررسی وضعیت پرداخت»: an idempotent,
        // CAS-guarded settle attempt. Verified provider evidence is the only
        // thing that can mark it paid — polling never invents success.
        if (
          payment.provider !== null &&
          payment.settlementStatus === "UNSETTLED" &&
          (payment.status === "PENDING" || payment.status === "PROCESSING")
        ) {
          const outcome = await settleGatewayPayment(payment.id);
          if (outcome.kind === "settled" || outcome.kind === "already") {
            await enqueueCommerceFollowUp({
              name: MINIAPP_COMMERCE_JOB_NAMES.GATEWAY_FULFILL,
              paymentId: payment.id,
            });
          }
          const refreshed = await prisma.payment.findUnique({ where: { id: payment.id } });
          if (refreshed !== null) {
            payment = refreshed;
          }
        }

        const order =
          payment.orderId !== null
            ? await prisma.order.findFirst({ where: { id: payment.orderId, userId } })
            : await prisma.order.findFirst({
                where: {
                  userId,
                  checkoutSessionId: payment.checkoutSessionId ?? "never",
                },
              });
        const service =
          order?.serviceId != null
            ? await prisma.service.findFirst({
                where: { id: order.serviceId, userId },
                select: { id: true },
              })
            : null;
        const checkout =
          payment.checkoutSessionId !== null
            ? await prisma.checkoutSession.findFirst({
                where: { id: payment.checkoutSessionId, userId },
              })
            : null;

        return reply.send({
          ok: true,
          payment: {
            publicId: commerceShortId(payment),
            status: payment.status,
            settlementStatus: payment.settlementStatus,
            purpose: payment.purpose,
            amountToman: payment.amountToman,
            createdAt: payment.createdAt.toISOString(),
            expiresAt: payment.expiresAt?.toISOString() ?? null,
          },
          checkout: checkout !== null ? toMiniAppCheckout(checkout) : null,
          orderPublicId: order !== null ? commerceShortId(order) : null,
          orderStatus: order?.status ?? null,
          servicePublicId: service !== null ? commerceShortId(service) : null,
        });
      } catch (err) {
        logger.error(
          "miniapp payment status failed",
          supportFailureLog("commerce-payment-status", err),
        );
        return fail(reply, 503, "INTERNAL");
      }
    },
  );
}

class PayRejected extends Error {
  constructor(
    readonly code: PaymentErrorCode,
    readonly status: number,
  ) {
    super(code);
  }
}
