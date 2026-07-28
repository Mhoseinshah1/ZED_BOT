// =============================================================================
// Mini App commerce routes — Phase 1, part D (miniapp-commerce-parity):
// orders + payments history, other-product order detail (incl. the ONE place
// delivered content is revealed) and the structured customer-input form —
// §8, §16, §17.
//
// Lists reuse the bot's own paging services (10/page, bounded); every row is
// serialized through an explicit allowlist keyed by public 8-hex ids.
// Delivered stock content and manual-delivery text appear ONLY on the
// authenticated owner detail route — never in a list — and the global
// no-store hook covers every response. Statuses cross the wire as the
// repository's REAL enum values; Persian rendering is the client's i18n job.
// =============================================================================
import { prisma } from "@zedbot/database";
import {
  canonicalCommercePublicId,
  commerceShortId,
  createLogger,
} from "@zedbot/shared";
import {
  getUserHistoryOrderDetail,
  listUserHistory,
  listUserPayments,
} from "@zedbot/bot/services/user-history.service";
import {
  deriveUserOrderStatus,
  getDeliveredStockContentForUser,
  getUserOtherProductOrderDetail,
  visibleManualDeliveryText,
} from "@zedbot/bot/services/user-other-product-orders.service";
import {
  getOrCreateCheckoutInput,
  submitCheckoutInput,
} from "@zedbot/bot/services/checkout-customer-input.service";
import { readFulfillmentSnapshot } from "@zedbot/bot/services/other-product-profile.service";
import { validateCustomerInputSchema } from "@zedbot/bot/services/customer-input-schema.service";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { supportFailureLog } from "../support-errors.js";
import { checkSupportMutation, sendMutationRejection } from "../support-guards.js";
import { readMiniAppSwitchFresh } from "../feature-switches.js";
import { isValidClientRequestId } from "./idempotency.js";
import type { CommerceRouteOptions } from "./routes.js";

const logger = createLogger("api");

const INPUT_BODY_LIMIT_BYTES = 32 * 1024;
const MAX_PAGE = 500;

type HistoryErrorCode =
  | "FEATURE_DISABLED"
  | "FEATURE_UNAVAILABLE"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "INPUT_CLOSED"
  | "INPUT_INVALID"
  | "INTERNAL";

function fail(reply: FastifyReply, status: number, code: HistoryErrorCode): FastifyReply {
  return reply.code(status).send({ ok: false, code });
}

function requestUserId(request: FastifyRequest): string {
  const user = request.miniAppUser;
  if (user === undefined) {
    throw new Error("commerce history route reached without an authenticated user");
  }
  return user.id;
}

async function masterDenied(reply: FastifyReply): Promise<FastifyReply | null> {
  const state = await readMiniAppSwitchFresh("miniapp_commerce_enabled");
  if (!state.ok) {
    return fail(reply, 503, "FEATURE_UNAVAILABLE");
  }
  return state.enabled ? null : fail(reply, 403, "FEATURE_DISABLED");
}

function pageParam(raw: unknown): number {
  const page = Number.parseInt(typeof raw === "string" ? raw : "1", 10);
  return Number.isInteger(page) && page >= 1 && page <= MAX_PAGE ? page : 1;
}

export function registerCommerceHistoryRoutes(
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

  // --- unified history (orders + order-less payments), 10/page ----------------
  app.get<{ Querystring: Record<string, string> }>(
    "/commerce/history",
    async (request, reply) => {
      const userId = requestUserId(request);
      const denied = await masterDenied(reply);
      if (denied !== null) {
        return denied;
      }
      try {
        const result = await listUserHistory(userId, pageParam(request.query.page));
        return reply.send({
          ok: true,
          page: result.page,
          pages: result.pages,
          total: result.total,
          items: result.items.map((item) =>
            item.kind === "order"
              ? {
                  itemType: "ORDER" as const,
                  publicId: item.id.slice(0, 8),
                  orderType: item.orderType,
                  status: item.status,
                  amountToman: item.amountToman,
                  createdAt: item.createdAt.toISOString(),
                }
              : {
                  itemType: "PAYMENT" as const,
                  publicId: item.id.slice(0, 8),
                  purpose: item.purpose,
                  status: item.status,
                  amountToman: item.amountToman,
                  createdAt: item.createdAt.toISOString(),
                },
          ),
        });
      } catch (err) {
        logger.error("miniapp history failed", supportFailureLog("commerce-history", err));
        return fail(reply, 503, "INTERNAL");
      }
    },
  );

  // --- payments list ------------------------------------------------------------
  app.get<{ Querystring: Record<string, string> }>(
    "/commerce/payments",
    async (request, reply) => {
      const userId = requestUserId(request);
      const denied = await masterDenied(reply);
      if (denied !== null) {
        return denied;
      }
      try {
        const result = await listUserPayments(userId, pageParam(request.query.page));
        return reply.send({
          ok: true,
          page: result.page,
          pages: result.pages,
          total: result.total,
          payments: result.payments.map((payment) => ({
            publicId: commerceShortId(payment),
            purpose: payment.purpose,
            status: payment.status,
            settlementStatus: payment.settlementStatus,
            amountToman: payment.amountToman,
            createdAt: payment.createdAt.toISOString(),
          })),
        });
      } catch (err) {
        logger.error(
          "miniapp payments list failed",
          supportFailureLog("commerce-payments-list", err),
        );
        return fail(reply, 503, "INTERNAL");
      }
    },
  );

  // --- order detail (links out to payment / service / other-product) ----------
  app.get<{ Params: { orderId: string } }>(
    "/commerce/orders/:orderId",
    async (request, reply) => {
      const userId = requestUserId(request);
      const denied = await masterDenied(reply);
      if (denied !== null) {
        return denied;
      }
      const publicId = canonicalCommercePublicId(request.params.orderId);
      if (publicId === null) {
        return fail(reply, 404, "NOT_FOUND");
      }
      try {
        const order = await getUserHistoryOrderDetail(userId, publicId);
        if (order === null) {
          return fail(reply, 404, "NOT_FOUND");
        }
        const checkoutBlocked =
          order.checkoutSessionId !== null
            ? (await prisma.financialReconciliationCase.count({
                where: {
                  checkoutSessionId: order.checkoutSessionId,
                  status: { in: ["OPEN", "IN_REVIEW"] },
                },
              })) > 0
            : false;
        return reply.send({
          ok: true,
          order: {
            publicId: commerceShortId(order),
            orderType: order.type,
            status: order.status,
            productName: order.productNameSnapshot,
            amountToman: order.finalPriceToman,
            createdAt: order.createdAt.toISOString(),
            paidAt: order.paidAt?.toISOString() ?? null,
            completedAt: order.completedAt?.toISOString() ?? null,
            failureVisible: order.status === "FAILED",
            reconciliationPending: checkoutBlocked,
            paymentPublicId: order.paymentId !== null ? order.paymentId.slice(0, 8) : null,
            servicePublicId: order.serviceId !== null ? order.serviceId.slice(0, 8) : null,
            checkoutPublicId:
              order.checkoutSessionId !== null ? order.checkoutSessionId.slice(0, 8) : null,
            isOtherProduct: order.type === "OTHER_PRODUCT",
          },
        });
      } catch (err) {
        logger.error(
          "miniapp order detail failed",
          supportFailureLog("commerce-order-detail", err),
        );
        return fail(reply, 503, "INTERNAL");
      }
    },
  );

  // --- other-product order detail: the ONE delivered-content surface ----------
  app.get<{ Params: { orderId: string } }>(
    "/commerce/other-orders/:orderId",
    async (request, reply) => {
      const userId = requestUserId(request);
      // Delivered content stays readable for a settled order even if the
      // other-products switch is later disabled (§5: disabling never corrupts
      // a settled operation) — only the MASTER switch gates the surface.
      const denied = await masterDenied(reply);
      if (denied !== null) {
        return denied;
      }
      const publicId = canonicalCommercePublicId(request.params.orderId);
      if (publicId === null) {
        return fail(reply, 404, "NOT_FOUND");
      }
      try {
        const row = await getUserOtherProductOrderDetail(userId, publicId);
        if (row === null) {
          return fail(reply, 404, "NOT_FOUND");
        }
        const displayStatus = deriveUserOrderStatus(row);
        const manualText = visibleManualDeliveryText(row, userId);
        const stock = getDeliveredStockContentForUser(row, userId);
        const deliveredStock = stock !== null && stock.ok ? stock.content : null;
        return reply.send({
          ok: true,
          order: {
            publicId: commerceShortId(row),
            status: row.status,
            displayStatus,
            productName: row.product?.name ?? row.productNameSnapshot,
            createdAt: row.createdAt.toISOString(),
            checkoutPublicId:
              row.checkoutSessionId !== null ? row.checkoutSessionId.slice(0, 8) : null,
            deliveredText: manualText,
            deliveredStock,
            awaitingStock: row.status === "PENDING_PAYMENT" ? false : row.otherProductOrder?.status === "AWAITING_STOCK",
          },
        });
      } catch (err) {
        logger.error(
          "miniapp other-order detail failed",
          supportFailureLog("commerce-other-order", err),
        );
        return fail(reply, 503, "INTERNAL");
      }
    },
  );

  // --- customer-input form: read (schema + progress) ---------------------------
  app.get<{ Params: { checkoutId: string } }>(
    "/commerce/checkouts/:checkoutId/input",
    async (request, reply) => {
      const userId = requestUserId(request);
      const denied = await masterDenied(reply);
      if (denied !== null) {
        return denied;
      }
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
        const checkout = matches[0];
        const snapshot = await readFulfillmentSnapshot(checkout);
        if (snapshot.customerInputSchema === null) {
          return fail(reply, 404, "NOT_FOUND");
        }
        const record = await getOrCreateCheckoutInput(
          checkout.id,
          userId,
          snapshot.customerInputSchema,
        );
        if (record === null) {
          return fail(reply, 404, "NOT_FOUND");
        }
        const schema = validateCustomerInputSchema(record.schemaSnapshot);
        return reply.send({
          ok: true,
          input: {
            checkoutPublicId: commerceShortId(checkout),
            status: record.status,
            // Field definitions are operator content (labels already Persian).
            fields: schema.ok
              ? schema.schema.fields.map((field) => ({
                  key: field.key,
                  label: field.label,
                  required: field.required,
                  type: field.type,
                  minLength: field.minLength ?? null,
                  maxLength: field.maxLength ?? null,
                  options: field.options ?? null,
                }))
              : [],
            // Masked review only — raw values never round-trip to the client.
            maskedSummary: record.renderedSafeSummary,
          },
        });
      } catch (err) {
        logger.error(
          "miniapp customer input read failed",
          supportFailureLog("commerce-input-read", err),
        );
        return fail(reply, 503, "INTERNAL");
      }
    },
  );

  // --- customer-input form: submit (full form, validated by the authority) -----
  app.post<{ Body: unknown; Params: { checkoutId: string } }>(
    "/commerce/checkouts/:checkoutId/input",
    { bodyLimit: INPUT_BODY_LIMIT_BYTES },
    async (request, reply) => {
      const userId = requestUserId(request);
      if (!gate(request, reply, userId)) {
        return reply;
      }
      const denied = await masterDenied(reply);
      if (denied !== null) {
        return denied;
      }
      const body = (request.body ?? {}) as Record<string, unknown>;
      if (!isValidClientRequestId(body.clientRequestId)) {
        return fail(reply, 400, "BAD_REQUEST");
      }
      const publicId = canonicalCommercePublicId(request.params.checkoutId);
      if (publicId === null) {
        return fail(reply, 404, "NOT_FOUND");
      }
      const rawValues = body.values;
      if (typeof rawValues !== "object" || rawValues === null || Array.isArray(rawValues)) {
        return fail(reply, 400, "BAD_REQUEST");
      }
      const values: Record<string, string> = {};
      for (const [key, value] of Object.entries(rawValues as Record<string, unknown>)) {
        if (typeof value === "string") {
          values[key] = value;
        }
      }
      try {
        const matches = await prisma.checkoutSession.findMany({
          where: { id: { startsWith: publicId }, userId },
          take: 2,
        });
        if (matches.length !== 1) {
          return fail(reply, 404, "NOT_FOUND");
        }
        const checkout = matches[0];
        const snapshot = await readFulfillmentSnapshot(checkout);
        if (snapshot.customerInputSchema !== null) {
          // Ensure the record exists so a direct submit (no prior GET) works.
          await getOrCreateCheckoutInput(checkout.id, userId, snapshot.customerInputSchema);
        }
        const outcome = await submitCheckoutInput(checkout.id, userId, values);
        if (!outcome.ok) {
          // The authority's refusals are field-validation or closed-form
          // states; both are client-correctable, neither is internal.
          return fail(reply, 409, "INPUT_INVALID");
        }
        const record = await prisma.checkoutCustomerInput.findUnique({
          where: { checkoutSessionId: checkout.id },
        });
        return reply.send({
          ok: true,
          status: record?.status ?? "SUBMITTED",
          maskedSummary: record?.renderedSafeSummary ?? null,
        });
      } catch (err) {
        logger.error(
          "miniapp customer input submit failed",
          supportFailureLog("commerce-input-submit", err),
        );
        return fail(reply, 503, "INTERNAL");
      }
    },
  );
}
