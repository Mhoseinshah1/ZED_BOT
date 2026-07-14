import {
  OrderType,
  OtherProductNamingPolicy,
  prisma,
  type Order,
  type Product,
  type User,
} from "@zedbot/database";

import { logger } from "../core/logger.js";

// =============================================================================
// OTHER_PRODUCT naming (naming phase): deterministic, safe DELIVERY
// REFERENCES for manual/stock other-product orders. Order-facing identifiers
// ONLY - no VPN Service rows, no panel calls, and the reference is NEVER
// derived from stock content, delivery text, passwords or any secret. It is
// also never an authorization mechanism: ownership stays database-scoped.
//
// Determinism: every policy embeds the order short id, the reference is
// resolved once per order and persisted with a compare-and-set - retries and
// admin actions can never regenerate a different identity.
// =============================================================================

export const OTHER_NAMING_VERSION = 1;

/** Rendered on user order pages and delivery messages. */
export const DELIVERY_REFERENCE_LABEL = "شناسه تحویل:";
export const ORDER_REFERENCE_LABEL = "شناسه سفارش:";
export const OTHER_TEMPLATE_INVALID_TEXT =
  "قالب نام‌گذاری نامعتبر است. فقط متغیرهای مجاز را استفاده کنید.";

export const OTHER_NAMING_POLICIES: readonly OtherProductNamingPolicy[] = [
  OtherProductNamingPolicy.ORDER_SHORT_ID,
  OtherProductNamingPolicy.TELEGRAM_ID,
  OtherProductNamingPolicy.TELEGRAM_USERNAME_WITH_FALLBACK,
  OtherProductNamingPolicy.PRODUCT_CODE_AND_ORDER,
  OtherProductNamingPolicy.CUSTOM_TEMPLATE,
];

export const OTHER_POLICY_INFO: Record<
  OtherProductNamingPolicy,
  { fa: string; descriptionFa: string }
> = {
  ORDER_SHORT_ID: {
    fa: "شناسه کوتاه سفارش",
    descriptionFa: "فقط شناسه کوتاه سفارش (پیش‌فرض).",
  },
  TELEGRAM_ID: {
    fa: "آیدی عددی تلگرام",
    descriptionFa: "آیدی عددی تلگرام خریدار + شناسه کوتاه سفارش.",
  },
  TELEGRAM_USERNAME_WITH_FALLBACK: {
    fa: "نام کاربری تلگرام با جایگزین",
    descriptionFa: "نام کاربری تلگرام (بدون آن: u + آیدی عددی) + شناسه کوتاه سفارش.",
  },
  PRODUCT_CODE_AND_ORDER: {
    fa: "کد محصول و شناسه سفارش",
    descriptionFa: "کد محصول (برگرفته از نام محصول) + شناسه کوتاه سفارش.",
  },
  CUSTOM_TEMPLATE: {
    fa: "قالب سفارشی",
    descriptionFa: "قالب دلخواه با متغیرهای مجاز + شناسه کوتاه سفارش.",
  },
};

/**
 * The STRICT variable registry for CUSTOM_TEMPLATE. Anything else - stock
 * content, passwords, tokens, delivery text, phone numbers - is not
 * representable here by construction, and unknown variables are rejected.
 */
export const OTHER_TEMPLATE_ALLOWED_VARS = [
  "order_short_id",
  "telegram_id",
  "telegram_username",
  "user_short_id",
  "product_name",
  "date",
] as const;

const MAX_REFERENCE_LENGTH = 40;
const PRODUCT_CODE_LENGTH = 12;

/**
 * OTHER_PRODUCT_PUBLIC_REFERENCE profile: lowercase [a-z0-9-], collapsed
 * separators, no leading/trailing separator, 40-char cap with the order
 * short id preserved at the tail. Never empty.
 */
export function normalizeDeliveryReference(raw: string, orderShort: string): string {
  let normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (normalized === "") {
    normalized = `ord-${orderShort}`;
  }
  if (!normalized.includes(orderShort)) {
    // Every reference carries the order-derived part - uniqueness by
    // construction, regardless of policy or template content.
    normalized = `${normalized}-${orderShort}`;
  }
  if (normalized.length > MAX_REFERENCE_LENGTH) {
    const keep = MAX_REFERENCE_LENGTH - orderShort.length - 1;
    normalized = `${normalized.slice(0, keep).replace(/-+$/g, "")}-${orderShort}`;
  }
  return normalized;
}

function orderShortOf(orderId: string): string {
  return orderId.replace(/-/g, "").slice(0, 8).toLowerCase();
}

/** Product "code": the normalized product-name slug (no code field exists). */
function productCode(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PRODUCT_CODE_LENGTH)
    .replace(/-+$/g, "");
  return slug === "" ? "prd" : slug;
}

/** Validates a CUSTOM_TEMPLATE against the strict variable registry. */
export function validateOtherNamingTemplate(template: string): {
  ok: boolean;
  unknownVars: string[];
} {
  const unknownVars: string[] = [];
  for (const match of template.matchAll(/\{([^{}]*)\}/g)) {
    const name = match[1];
    if (!(OTHER_TEMPLATE_ALLOWED_VARS as readonly string[]).includes(name)) {
      unknownVars.push(name);
    }
  }
  return { ok: unknownVars.length === 0 && template.trim() !== "", unknownVars };
}

interface OtherNamingContext {
  orderId: string;
  orderCreatedAt: Date;
  user: Pick<User, "id" | "telegramId" | "username">;
  productName: string;
  policy: OtherProductNamingPolicy | null;
  template: string | null;
}

/**
 * Pure, deterministic resolution: same order + same policy = same reference.
 * No timestamps-of-now, no randomness, no counters - everything derives from
 * immutable order/user identifiers captured at order creation.
 */
export function resolveOtherProductDeliveryIdentity(ctx: OtherNamingContext): string {
  const orderShort = orderShortOf(ctx.orderId);
  const policy = ctx.policy ?? OtherProductNamingPolicy.ORDER_SHORT_ID;
  const telegramUsername =
    (ctx.user.username ?? "").trim() !== ""
      ? (ctx.user.username as string).trim()
      : `u${ctx.user.telegramId.toString()}`;

  let raw: string;
  switch (policy) {
    case OtherProductNamingPolicy.ORDER_SHORT_ID:
      raw = `ord-${orderShort}`;
      break;
    case OtherProductNamingPolicy.TELEGRAM_ID:
      raw = `tg${ctx.user.telegramId.toString()}-${orderShort}`;
      break;
    case OtherProductNamingPolicy.TELEGRAM_USERNAME_WITH_FALLBACK:
      raw = `${telegramUsername}-${orderShort}`;
      break;
    case OtherProductNamingPolicy.PRODUCT_CODE_AND_ORDER:
      raw = `${productCode(ctx.productName)}-${orderShort}`;
      break;
    case OtherProductNamingPolicy.CUSTOM_TEMPLATE: {
      const template = ctx.template ?? "";
      if (!validateOtherNamingTemplate(template).ok) {
        // Defensive: an invalid stored template never blocks a delivery -
        // fall back to the deterministic default and let admins fix it.
        raw = `ord-${orderShort}`;
        break;
      }
      const date = ctx.orderCreatedAt.toISOString().slice(0, 10).replace(/-/g, "");
      raw = template
        .replaceAll("{order_short_id}", orderShort)
        .replaceAll("{telegram_id}", ctx.user.telegramId.toString())
        .replaceAll("{telegram_username}", telegramUsername)
        .replaceAll("{user_short_id}", ctx.user.id.replace(/-/g, "").slice(0, 8))
        .replaceAll("{product_name}", productCode(ctx.productName))
        .replaceAll("{date}", date);
      break;
    }
  }
  return normalizeDeliveryReference(raw, orderShort);
}

export type OrderWithNamingRelations = Order & {
  user: User;
  product: Product | null;
};

/**
 * Exactly-once delivery-reference gate for OTHER_PRODUCT orders: returns the
 * stored reference or resolves+persists it with a compare-and-set. Retries,
 * concurrent deliveries and admin re-entries always converge on ONE value.
 * Returns null for non-OTHER_PRODUCT orders (VPN naming lives elsewhere) -
 * and never throws: a naming problem must not break a delivery pipeline.
 */
export async function ensureOrderDeliveryReference(orderId: string): Promise<string | null> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true, product: true },
    });
    if (order === null || order.type !== OrderType.OTHER_PRODUCT) {
      return null;
    }
    if (order.deliveryReference !== null && order.deliveryReference !== "") {
      return order.deliveryReference;
    }
    const reference = resolveOtherProductDeliveryIdentity({
      orderId: order.id,
      orderCreatedAt: order.createdAt,
      user: order.user,
      productName: order.productNameSnapshot ?? order.product?.name ?? "",
      policy: order.product?.otherNamingPolicy ?? null,
      template: order.product?.otherNamingTemplate ?? null,
    });
    const written = await prisma.order.updateMany({
      where: { id: order.id, deliveryReference: null },
      data: { deliveryReference: reference },
    });
    if (written.count === 1) {
      logger.info("other-product delivery reference created", {
        orderId: order.id,
        policy: order.product?.otherNamingPolicy ?? "ORDER_SHORT_ID",
      });
      return reference;
    }
    const fresh = await prisma.order.findUnique({
      where: { id: order.id },
      select: { deliveryReference: true },
    });
    return fresh?.deliveryReference ?? reference;
  } catch (err) {
    logger.warn("delivery reference resolution failed", {
      orderId,
      error: err instanceof Error ? err.message : "unknown",
    });
    return null;
  }
}
