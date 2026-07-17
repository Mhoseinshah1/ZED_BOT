import {
  OrderStatus,
  Prisma,
  prisma,
  type Order,
  type OtherProductOrderStatus,
} from "@zedbot/database";
import { decryptSecret, errorMessage } from "@zedbot/shared";
import { InlineKeyboard } from "grammy";

import { logger } from "../core/logger.js";
import { escapeHtml } from "../utils/html.js";
import {
  consumeCheckoutInputForOrder,
  type ConsumedCheckoutInputPayload,
} from "./checkout-customer-input.service.js";
import {
  fulfillmentConfirmationLine,
  INFO_REQUIRED_FOLLOWUP_TEXT,
  WAITING_FOR_DELIVERY_TEXT,
  type DispatchResult,
  type FulfillmentSource,
} from "./order-fulfillment.service.js";
import {
  notifyAdminsAboutManualOrder,
  userInfoButtonKeyboard,
  userInfoPromptText,
  type DeliverySendApi,
  type ManualOrderWithRelations,
} from "./other-product-delivery.service.js";
import { ensureOrderDeliveryReference } from "./other-product-naming.service.js";
import type { OtherProductFulfillmentSnapshot } from "./other-product-profile.service.js";
import {
  buildStockDeliveryMessage,
  notifyAdminsAboutStockAlert,
  releaseStockClaim,
  reserveStockItemForOrder,
} from "./other-product-stock.service.js";

// =============================================================================
// Specialized-workflows phase: the post-settlement fulfillment engine for
// NON-GENERIC OTHER_PRODUCT kinds (APPLE_ID / AI_ACCOUNT / TELEGRAM_PREMIUM /
// GIFT_CARD). Called ONLY from fulfillOtherProduct in
// order-fulfillment.service.ts - the unified dispatcher stays the single
// post-settlement entry, and this module never runs inside a payment
// transaction.
//
// Routing by the checkout's frozen fulfillment snapshot:
//   STOCK_CREDENTIAL / STOCK_CODE  -> reserve -> send -> finalize; an empty
//     inventory parks the order as AWAITING_STOCK (NEVER a silent downgrade
//     to generic manual delivery) until stock replenishment retries it.
//   PERSONALIZED_SERVICE / MANUAL_DELIVERY -> OtherProductOrder with frozen
//     kind/profile/schema/completion snapshots; a pre-settlement customer
//     input submission is consumed exactly once (checkout-scoped CAS) and
//     copied onto the record; otherwise the buyer is asked for the info.
//   GENERIC -> null sentinel; the caller falls through to the untouched
//     legacy path (autoDeliverStockOrder -> initManualDelivery).
//
// Exactly-once guarantees (DB-backed, never in-memory):
//   - one stock item per order (deliveredOrderId UNIQUE);
//   - one customer-input copy (CAS on customerInputEncrypted IS NULL);
//   - one fulfillment-admin notification (CAS on fulfillmentAdminsNotifiedAt
//     IS NULL) - shared by the ready-for-delivery and awaiting-stock notices.
//
// No secrets anywhere: stock content and decrypted customer input go to the
// buying user / the on-demand admin viewer only - never to logs, SystemLog,
// callbacks or admin list pages.
// =============================================================================

/** The circular import above is call-time only (safe under NodeNext ESM). */

export const AWAITING_STOCK_USER_TEXT =
  "سفارش شما ثبت شد؛ موجودی در حال تکمیل است و به‌محض شارژ ارسال می‌شود ⏳";
export const AWAITING_STOCK_ADMIN_TITLE = "🚨 سفارش در انتظار شارژ موجودی";

const INCLUDE = { order: true, user: true, product: true } as const;

/** Optional dispatcher context (chat + payment source for the first lines). */
export interface SpecializedFulfillmentContext {
  chatId?: string;
  source?: FulfillmentSource;
}

/** Send helper that never throws (blocked users, closed chats, ...). */
async function sendSafe(
  api: DeliverySendApi,
  chatId: string,
  text: string,
  other?: Record<string, unknown>,
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, other);
  } catch (err) {
    logger.warn("specialized fulfillment notice failed", { error: errorMessage(err) });
  }
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function errorResult(): DispatchResult {
  return {
    kind: "OTHER_PRODUCT",
    auto: "ERROR",
    manual: { ok: false, created: false, requiresInfo: false, recordShortId: null },
  };
}

// --- record bootstrap -----------------------------------------------------------------------

/**
 * Idempotently creates THE OtherProductOrder for a specialized paid order
 * (orderId is unique - mirrors initManualDelivery), with the immutable
 * kind/profile/schema/completion snapshots frozen on. A concurrent create
 * loses the unique race and resumes the winner.
 */
async function ensureSpecializedRecord(
  order: Order,
  snapshot: OtherProductFulfillmentSnapshot,
  initialStatus: OtherProductOrderStatus,
): Promise<{ record: ManualOrderWithRelations; created: boolean } | null> {
  if (order.productId === null) {
    logger.error("specialized fulfillment order has no product", { orderId: order.id });
    return null;
  }
  const existing = await prisma.otherProductOrder.findUnique({
    where: { orderId: order.id },
    include: INCLUDE,
  });
  if (existing !== null) {
    return { record: existing, created: false };
  }
  // Naming phase: the delivery reference exists BEFORE the record enters any
  // queue (CAS-persisted, never derived from content, never throws).
  await ensureOrderDeliveryReference(order.id);
  try {
    const record = await prisma.otherProductOrder.create({
      data: {
        orderId: order.id,
        userId: order.userId,
        productId: order.productId,
        status: initialStatus,
        kindSnapshot: snapshot.kind,
        fulfillmentProfileSnapshot: snapshot.profile,
        ...(snapshot.customerInputSchema !== null
          ? {
              customerInputSchemaSnapshot:
                snapshot.customerInputSchema as unknown as Prisma.InputJsonObject,
            }
          : {}),
        completionMessageSnapshot: snapshot.completionMessageTemplate,
      },
      include: INCLUDE,
    });
    logger.info("specialized fulfillment record created", {
      orderId: order.id,
      recordId: record.id,
      status: record.status,
    });
    return { record, created: true };
  } catch (err) {
    // Unique orderId collision from a concurrent dispatch: load the winner.
    const raced = await prisma.otherProductOrder.findUnique({
      where: { orderId: order.id },
      include: INCLUDE,
    });
    if (raced !== null) {
      return { record: raced, created: false };
    }
    logger.error("specialized fulfillment record create failed", {
      orderId: order.id,
      error: errorMessage(err),
    });
    return null;
  }
}

// --- exactly-once admin notifications --------------------------------------------------------

/**
 * CAS-claims the record's ONE fulfillment-admin notification (NULL ->
 * now, scoped to WAITING_ADMIN_DELIVERY) and only the claim winner sends -
 * repeated dispatches, the input-completion bridge and the legacy submit
 * path (which stamps the field itself) can never notify twice.
 */
async function notifyFulfillmentAdminsOnce(api: DeliverySendApi, recordId: string): Promise<void> {
  const claimed = await prisma.otherProductOrder.updateMany({
    where: { id: recordId, status: "WAITING_ADMIN_DELIVERY", fulfillmentAdminsNotifiedAt: null },
    data: { fulfillmentAdminsNotifiedAt: new Date() },
  });
  if (claimed.count !== 1) {
    return;
  }
  const record = await prisma.otherProductOrder.findUnique({
    where: { id: recordId },
    include: INCLUDE,
  });
  if (record !== null) {
    await notifyAdminsAboutManualOrder(api, record);
  }
}

/**
 * CAS-claims the record's ONE awaiting-stock admin notice (same
 * fulfillmentAdminsNotifiedAt field, scoped to AWAITING_STOCK). The message
 * carries the product name and the order reference ONLY - never stock
 * content, never customer data.
 */
async function notifyAwaitingStockAdminsOnce(
  api: DeliverySendApi,
  record: ManualOrderWithRelations,
): Promise<void> {
  const claimed = await prisma.otherProductOrder.updateMany({
    where: { id: record.id, status: "AWAITING_STOCK", fulfillmentAdminsNotifiedAt: null },
    data: { fulfillmentAdminsNotifiedAt: new Date() },
  });
  if (claimed.count !== 1) {
    return;
  }
  try {
    const reference = record.order.deliveryReference ?? shortId(record.orderId);
    const text = [
      AWAITING_STOCK_ADMIN_TITLE,
      "",
      `محصول: ${escapeHtml(record.product.name)}`,
      `سفارش: <code>${escapeHtml(reference)}</code>`,
      "",
      "موجودی این محصول تمام شده است؛ پس از شارژ موجودی، سفارش به‌صورت خودکار تکمیل می‌شود.",
    ].join("\n");
    const sid = shortId(record.productId);
    const keyboard = new InlineKeyboard()
      .text("مدیریت موجودی محصول 🎟", `admin:stock:p:${sid}`)
      .row()
      .text("افزودن گروهی آیتم‌ها ➕➕", `admin:stock:bulk_add:${sid}`);
    const admins = await prisma.admin.findMany({
      where: { isActive: true },
      select: { telegramId: true },
    });
    for (const admin of admins) {
      await sendSafe(api, admin.telegramId.toString(), text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    }
  } catch (err) {
    logger.warn("awaiting-stock admin notification failed", {
      recordId: record.id,
      error: errorMessage(err),
    });
  }
}

// --- customer-input consume/copy -------------------------------------------------------------

/**
 * Copies one consumed pre-settlement submission onto the order record.
 * Exactly-once: the copy CAS fires only while customerInputEncrypted IS
 * NULL; the WAITING_USER_INFO -> WAITING_ADMIN_DELIVERY flip is a separate
 * status CAS so a crash between the two still converges on retry.
 */
async function copyConsumedInput(
  recordId: string,
  payload: ConsumedCheckoutInputPayload,
): Promise<void> {
  if (payload.valuesEncrypted === null) {
    return;
  }
  await prisma.otherProductOrder.updateMany({
    where: { id: recordId, customerInputEncrypted: null },
    data: {
      customerInputEncrypted: payload.valuesEncrypted,
      customerInputSummary: payload.renderedSafeSummary,
      ...(payload.schemaSnapshot !== null && payload.schemaSnapshot !== undefined
        ? { customerInputSchemaSnapshot: payload.schemaSnapshot as Prisma.InputJsonValue }
        : {}),
      customerInputSubmittedAt: new Date(),
    },
  });
  await prisma.otherProductOrder.updateMany({
    where: { id: recordId, status: "WAITING_USER_INFO" },
    data: { status: "WAITING_ADMIN_DELIVERY" },
  });
}

// --- stock branch ----------------------------------------------------------------------------

type StockRunOutcome =
  | "DELIVERED"
  | "ALREADY_DELIVERED"
  | "AWAITING_STOCK"
  | "SEND_FAILED"
  | "ERROR";

/**
 * Parks one paid stock order as AWAITING_STOCK (CAS from PAID /
 * STOCK_RESERVED, stamping awaitingStockSince once). Only the transition
 * winner messages the buyer - a retry pass over an already-parked order
 * stays silent. The admin notice has its own CAS.
 */
async function parkOrderAwaitingStock(
  api: DeliverySendApi,
  record: ManualOrderWithRelations,
  context: SpecializedFulfillmentContext,
): Promise<void> {
  const flipped = await prisma.otherProductOrder.updateMany({
    where: { id: record.id, status: { in: ["PAID", "STOCK_RESERVED"] } },
    data: {
      status: "AWAITING_STOCK",
      awaitingStockSince: record.awaitingStockSince ?? new Date(),
    },
  });
  if (flipped.count === 1) {
    const chatId = context.chatId ?? record.user.telegramId.toString();
    const line =
      context.source === undefined ? null : fulfillmentConfirmationLine(context.source);
    await sendSafe(
      api,
      chatId,
      line === null ? AWAITING_STOCK_USER_TEXT : `${line}\n\n${AWAITING_STOCK_USER_TEXT}`,
    );
  }
  await notifyAwaitingStockAdminsOnce(api, record);
}

/** Marks the record's DELIVERED state + completes the parent order (CAS). */
async function finalizeStockRecord(recordId: string, orderId: string, now: Date): Promise<void> {
  await prisma.$transaction([
    prisma.otherProductOrder.updateMany({
      where: { id: recordId, status: { in: ["PAID", "STOCK_RESERVED", "AWAITING_STOCK"] } },
      data: { status: "DELIVERED", deliveredAt: now },
    }),
    prisma.order.updateMany({
      where: { id: orderId, status: OrderStatus.PAID },
      data: { status: OrderStatus.COMPLETED, completedAt: now },
    }),
  ]);
}

/**
 * The specialized stock delivery core (dispatch + replenishment retry):
 *
 *   reserve (idempotent per order; deliveredOrderId UNIQUE) -> decrypt ->
 *   send to the buying user ONLY -> finalize (item RESERVED->DELIVERED,
 *   record ->DELIVERED, Order ->COMPLETED in one transaction, one retry) ->
 *   fire the existing low-stock alert check.
 *
 * NO_STOCK parks the order as AWAITING_STOCK (never generic manual
 * delivery). A failed send releases OUR claim only and drops the record
 * back to PAID so a later retry re-runs (mirrors the legacy rollback). An
 * unreadable item is disabled and the next one is tried.
 */
async function runSpecializedStockDelivery(
  api: DeliverySendApi,
  record: ManualOrderWithRelations,
  context: SpecializedFulfillmentContext,
): Promise<StockRunOutcome> {
  if (record.status === "DELIVERED" || record.order.status === OrderStatus.COMPLETED) {
    // Converge a partially-finalized order (crash between the item finalize
    // and the record/order writes) without ever re-sending content.
    await finalizeStockRecord(record.id, record.orderId, new Date());
    return "ALREADY_DELIVERED";
  }
  if (record.order.status !== OrderStatus.PAID) {
    logger.error("specialized stock delivery on a non-PAID order", {
      orderId: record.orderId,
      orderStatus: record.order.status,
    });
    return "ERROR";
  }

  const deliveryReference = await ensureOrderDeliveryReference(record.orderId);

  for (let attempt = 0; attempt < 3; attempt++) {
    const reserved = await reserveStockItemForOrder(record.orderId, record.productId, record.userId);
    if (!reserved.ok) {
      if (reserved.reason === "NO_STOCK") {
        await parkOrderAwaitingStock(api, record, context);
        return "AWAITING_STOCK";
      }
      return "ERROR";
    }
    const item = reserved.item;
    if (item.status === "DELIVERED") {
      // Crash after the item finalize: content already reached the buyer.
      await finalizeStockRecord(record.id, record.orderId, new Date());
      return "ALREADY_DELIVERED";
    }
    // Claim window marker (transient; PAID again on a send failure).
    await prisma.otherProductOrder.updateMany({
      where: { id: record.id, status: { in: ["PAID", "AWAITING_STOCK"] } },
      data: { status: "STOCK_RESERVED" },
    });

    let content: string;
    try {
      content = decryptSecret(item.contentEncrypted);
    } catch (err) {
      logger.error("specialized stock item decryption failed", {
        itemId: item.id,
        error: errorMessage(err),
      });
      // Unreadable item: disable it (scoped to OUR claim) and try the next.
      await prisma.otherProductStockItem.updateMany({
        where: { id: item.id, status: "RESERVED", deliveredOrderId: record.orderId },
        data: {
          status: "DISABLED",
          disabledAt: new Date(),
          deliveredOrderId: null,
          deliveredToUserId: null,
        },
      });
      continue;
    }

    // The full (multi-line) content, HTML-escaped inside a <code> block -
    // sent to the BUYING user only; the completion message rides along.
    let text = buildStockDeliveryMessage(record.product.name, content, deliveryReference);
    if (record.completionMessageSnapshot !== null && record.completionMessageSnapshot !== "") {
      text += `\n\n${escapeHtml(record.completionMessageSnapshot)}`;
    }
    try {
      await api.sendMessage(record.user.telegramId.toString(), text, { parse_mode: "HTML" });
    } catch (err) {
      logger.warn("specialized stock delivery send failed", {
        orderId: record.orderId,
        itemId: item.id,
        error: errorMessage(err),
      });
      // Roll back OUR claim only; the record returns to the PAID-equivalent
      // state so the replenishment retry / a repeated dispatch re-runs it.
      await releaseStockClaim(item.id, record.orderId);
      await prisma.otherProductOrder.updateMany({
        where: { id: record.id, status: "STOCK_RESERVED" },
        data: { status: "PAID" },
      });
      return "SEND_FAILED";
    }

    const now = new Date();
    const finalize = (): Promise<unknown> =>
      prisma.$transaction([
        prisma.otherProductStockItem.updateMany({
          where: { id: item.id, status: "RESERVED", deliveredOrderId: record.orderId },
          data: { status: "DELIVERED", deliveredAt: now },
        }),
        prisma.otherProductOrder.updateMany({
          where: { id: record.id, status: { in: ["PAID", "STOCK_RESERVED", "AWAITING_STOCK"] } },
          data: { status: "DELIVERED", deliveredAt: now },
        }),
        prisma.order.updateMany({
          where: { id: record.orderId, status: OrderStatus.PAID },
          data: { status: OrderStatus.COMPLETED, completedAt: now },
        }),
      ]);
    try {
      await finalize();
    } catch (err) {
      // Content already reached the user - retry once, then log loudly (the
      // RESERVED item + unique claim still block any re-delivery).
      logger.error("specialized stock finalize failed after send", {
        orderId: record.orderId,
        itemId: item.id,
        error: errorMessage(err),
      });
      try {
        await finalize();
      } catch (retryErr) {
        logger.error("specialized stock finalize retry failed - manual review needed", {
          orderId: record.orderId,
          itemId: item.id,
          error: errorMessage(retryErr),
        });
      }
    }
    logger.info("specialized stock delivery succeeded", {
      orderId: record.orderId,
      itemId: item.id,
    });
    // Existing low/out-of-stock alert check (fresh deliveries only).
    await notifyAdminsAboutStockAlert(api, {
      productId: record.productId,
      orderId: record.orderId,
    });
    return "DELIVERED";
  }
  // Every candidate was unreadable - the inventory is effectively empty.
  await parkOrderAwaitingStock(api, record, context);
  return "AWAITING_STOCK";
}

// --- profile branches ------------------------------------------------------------------------

async function fulfillStockProfile(
  api: DeliverySendApi,
  order: Order,
  snapshot: OtherProductFulfillmentSnapshot,
  context: SpecializedFulfillmentContext,
): Promise<DispatchResult> {
  const ensured = await ensureSpecializedRecord(order, snapshot, "PAID");
  if (ensured === null) {
    return errorResult();
  }
  const { record, created } = ensured;
  const outcome = await runSpecializedStockDelivery(api, record, context);
  const manual = {
    ok: true,
    created,
    requiresInfo: false,
    recordShortId: shortId(record.id),
  };
  switch (outcome) {
    case "DELIVERED":
      return { kind: "OTHER_PRODUCT", auto: "DELIVERED", manual: null };
    case "ALREADY_DELIVERED":
      return { kind: "OTHER_PRODUCT", auto: "ALREADY_DELIVERED", manual: null };
    case "AWAITING_STOCK":
      return { kind: "OTHER_PRODUCT", auto: "NO_STOCK", manual };
    case "SEND_FAILED":
      return { kind: "OTHER_PRODUCT", auto: "SEND_FAILED", manual };
    case "ERROR":
      return errorResult();
  }
}

async function fulfillManualProfile(
  api: DeliverySendApi,
  order: Order,
  snapshot: OtherProductFulfillmentSnapshot,
  context: SpecializedFulfillmentContext,
): Promise<DispatchResult> {
  const initialStatus: OtherProductOrderStatus = snapshot.requiresCustomerInfo
    ? "WAITING_USER_INFO"
    : "WAITING_ADMIN_DELIVERY";
  const ensured = await ensureSpecializedRecord(order, snapshot, initialStatus);
  if (ensured === null) {
    return errorResult();
  }
  const { created } = ensured;
  let record = ensured.record;

  // Pre-settlement submission: consume it exactly once (checkout-scoped
  // CAS) and copy it onto the record. A repeated dispatch converges - the
  // consume returns alreadyConsumedByThisOrder and the copy CAS is a no-op.
  if (order.checkoutSessionId !== null) {
    try {
      const payload = await consumeCheckoutInputForOrder(order.checkoutSessionId, record.id);
      if (payload !== null && payload.valuesEncrypted !== null) {
        await copyConsumedInput(record.id, payload);
      }
    } catch (err) {
      logger.error("checkout customer-input consumption failed", {
        orderId: order.id,
        error: errorMessage(err),
      });
    }
  }
  const fresh = await prisma.otherProductOrder.findUnique({
    where: { id: record.id },
    include: INCLUDE,
  });
  record = fresh ?? record;
  const requiresInfoNow = record.status === "WAITING_USER_INFO";

  if (created) {
    const chatId = context.chatId ?? record.user.telegramId.toString();
    const line =
      context.source === undefined ? null : fulfillmentConfirmationLine(context.source);
    const prefix = line === null ? "" : `${line}\n\n`;
    if (requiresInfoNow) {
      // Admins are NOT notified yet - that happens when the info arrives
      // (structured form -> onCustomerInputCompleted; legacy prompt -> the
      // Phase 23 submit handler).
      if (snapshot.customerInputSchema !== null && order.checkoutSessionId !== null) {
        // Structured post-settlement form (agent-B route on the checkout).
        await sendSafe(api, chatId, `${prefix}${INFO_REQUIRED_FOLLOWUP_TEXT}`, {
          reply_markup: new InlineKeyboard().text(
            "تکمیل اطلاعات سفارش 📝",
            `cinput:start:${order.checkoutSessionId.slice(0, 12)}`,
          ),
        });
      } else {
        // Legacy free-text prompt path.
        await sendSafe(
          api,
          chatId,
          `${prefix}${INFO_REQUIRED_FOLLOWUP_TEXT}\n\n${userInfoPromptText(snapshot.promptText)}`,
          { reply_markup: userInfoButtonKeyboard(order.id) },
        );
      }
    } else {
      await sendSafe(api, chatId, `${prefix}${WAITING_FOR_DELIVERY_TEXT}`);
    }
  }
  if (record.status === "WAITING_ADMIN_DELIVERY") {
    await notifyFulfillmentAdminsOnce(api, record.id);
  }
  return {
    kind: "OTHER_PRODUCT",
    auto: "NOT_ELIGIBLE",
    manual: {
      ok: true,
      created,
      requiresInfo: requiresInfoNow,
      recordShortId: shortId(record.id),
    },
  };
}

// --- public API ------------------------------------------------------------------------------

/**
 * Fulfills one PAID specialized OTHER_PRODUCT order according to its frozen
 * snapshot. Returns null ONLY for GENERIC (the caller falls through to the
 * untouched legacy path); every specialized outcome - including internal
 * failures - returns a DispatchResult and NEVER falls back to the generic
 * manual queue. Safe to call repeatedly; never throws.
 */
export async function fulfillSpecializedOtherProduct(
  api: DeliverySendApi,
  order: Order,
  snapshot: OtherProductFulfillmentSnapshot,
  context: SpecializedFulfillmentContext = {},
): Promise<DispatchResult | null> {
  if (snapshot.kind === "GENERIC") {
    return null;
  }
  try {
    if (snapshot.profile === "STOCK_CREDENTIAL" || snapshot.profile === "STOCK_CODE") {
      return await fulfillStockProfile(api, order, snapshot, context);
    }
    return await fulfillManualProfile(api, order, snapshot, context);
  } catch (err) {
    logger.error("specialized fulfillment crashed", {
      orderId: order.id,
      error: errorMessage(err),
    });
    return errorResult();
  }
}

/**
 * Idempotent bridge called by the post-settlement customer-input form after
 * a submit: consumes + copies the submission (same CAS as the dispatch
 * path), flips WAITING_USER_INFO -> WAITING_ADMIN_DELIVERY and CAS-notifies
 * the admins once. Never throws.
 */
export async function onCustomerInputCompleted(
  api: DeliverySendApi,
  orderId: string,
): Promise<void> {
  try {
    const record = await prisma.otherProductOrder.findUnique({
      where: { orderId },
      include: INCLUDE,
    });
    if (record === null) {
      return;
    }
    const checkoutSessionId = record.order.checkoutSessionId;
    if (checkoutSessionId !== null) {
      const payload = await consumeCheckoutInputForOrder(checkoutSessionId, record.id);
      if (payload !== null && payload.valuesEncrypted !== null) {
        await copyConsumedInput(record.id, payload);
      }
    }
    await notifyFulfillmentAdminsOnce(api, record.id);
  } catch (err) {
    logger.error("customer-input completion bridge failed", {
      orderId,
      error: errorMessage(err),
    });
  }
}

/**
 * Replenishment retry: re-runs the stock branch for this product's parked
 * paid orders, oldest first (AWAITING_STOCK plus any PAID / STOCK_RESERVED
 * stock-profile record a crashed/failed pass left behind). Stops early when
 * the inventory runs dry again. Idempotent - a delivered order converges
 * without re-sending. Returns how many orders completed and how many are
 * still waiting.
 */
export async function retryAwaitingStockOrders(
  api: DeliverySendApi,
  productId: string,
): Promise<{ completed: number; remaining: number }> {
  let completed = 0;
  try {
    const records = await prisma.otherProductOrder.findMany({
      where: {
        productId,
        status: { in: ["AWAITING_STOCK", "PAID", "STOCK_RESERVED"] },
        fulfillmentProfileSnapshot: { in: ["STOCK_CREDENTIAL", "STOCK_CODE"] },
        order: { is: { status: OrderStatus.PAID } },
      },
      include: INCLUDE,
      orderBy: [{ awaitingStockSince: "asc" }, { createdAt: "asc" }],
    });
    for (const record of records) {
      const outcome = await runSpecializedStockDelivery(api, record, {});
      if (outcome === "DELIVERED" || outcome === "ALREADY_DELIVERED") {
        completed += 1;
      } else if (outcome === "AWAITING_STOCK") {
        // Inventory dry again - the rest stay parked (already AWAITING).
        break;
      }
      // SEND_FAILED / ERROR: skip this order, keep trying the others.
    }
  } catch (err) {
    logger.error("awaiting-stock retry failed", { productId, error: errorMessage(err) });
  }
  let remaining = 0;
  try {
    remaining = await prisma.otherProductOrder.count({
      where: { productId, status: "AWAITING_STOCK", order: { is: { status: OrderStatus.PAID } } },
    });
  } catch {
    // Count is best-effort reporting only.
  }
  return { completed, remaining };
}
