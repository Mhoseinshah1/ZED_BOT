// =============================================================================
// Pure, DB-free rendering helpers for the public retail Pricing Catalog
// (feat/public-pricing-catalog). Everything here is synchronous and side-effect
// free so it is trivially unit-testable: formatting, bounded "cards", and detail
// bodies. ALL operator-controlled values (product / panel / category names,
// invoice descriptions, prompt text) are HTML-escaped here, and NO secret-shaped
// field (panel URL, credentials, inbound ids, stock, subscription domain, config)
// is ever read. Prices come only from `product.priceToman`.
// =============================================================================

import type { ProductWithRelations } from "../../services/product.service.js";
import { escapeHtml } from "../../utils/html.js";

/** Missing-optional-value placeholder (task §8/§10). */
export const DASH = "—";

/** Bound for a rendered invoice description (well under Telegram's 4096). */
export const INVOICE_DESCRIPTION_MAX = 600;

export function formatToman(value: number): string {
  return `${value.toLocaleString("en-US")} تومان`;
}

/** volumeGb: 0 → unlimited, null → dash, else "<n> گیگ". */
export function volumeLabel(volumeGb: number | null): string {
  if (volumeGb === null) {
    return DASH;
  }
  return volumeGb === 0 ? "نامحدود" : `${volumeGb} گیگ`;
}

/** durationDays: 0 → unlimited, null → dash, else "<n> روز". */
export function durationLabel(durationDays: number | null): string {
  if (durationDays === null) {
    return DASH;
  }
  return durationDays === 0 ? "نامحدود" : `${durationDays} روز`;
}

/** Safe location label; never exposes panel/inbound internals. */
export function locationLabel(product: Pick<ProductWithRelations, "allLocations" | "serviceLocation">): string {
  if (product.allLocations) {
    return "همه لوکیشن‌ها";
  }
  switch (product.serviceLocation) {
    case "MULTI_LOCATION":
      return "مولتی لوکیشن";
    case "DEDICATED_LOCATION":
      return "تک لوکیشن اختصاصی";
    default:
      return DASH;
  }
}

/**
 * Safe delivery label for OTHER_PRODUCT (task §9). Never discloses stock counts
 * or fulfillment internals — only the buyer-facing delivery mode.
 */
export function deliveryLabel(deliveryType: string | null): string {
  switch (deliveryType) {
    case "MANUAL_ADMIN":
      return "تحویل توسط پشتیبانی";
    case "STOCK_ITEM":
      return "تحویل خودکار پس از پرداخت";
    default:
      return "طبق توضیحات محصول";
  }
}

/** Escapes and bounds an operator description so a message can never overflow. */
export function boundedDescription(raw: string): string {
  const trimmed = raw.trim();
  const clipped =
    trimmed.length > INVOICE_DESCRIPTION_MAX ? `${trimmed.slice(0, INVOICE_DESCRIPTION_MAX)}…` : trimmed;
  return escapeHtml(clipped);
}

/** Escapes + truncates a name for a compact inline button label. */
export function buttonName(name: string, max = 28): string {
  const clean = name.trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

// --- Panel / category summary rows -------------------------------------------

/** «<name> — <count> پلن · از <minPrice>». Name is escaped. */
export function panelSummaryLine(name: string, count: number, minPriceToman: number): string {
  return `🌐 <b>${escapeHtml(name)}</b>\n   ${count} پلن قابل خرید · شروع از ${formatToman(minPriceToman)}`;
}

export function categorySummaryLine(name: string, count: number, minPriceToman: number): string {
  return `📂 <b>${escapeHtml(name)}</b>\n   ${count} مورد · شروع از ${formatToman(minPriceToman)}`;
}

// --- Product cards (list pages) ----------------------------------------------

/**
 * A bounded SERVICE_PRODUCT card for the product-list page (task §8): name,
 * panel, category, location, volume, duration, price. No secret is ever shown.
 */
export function serviceProductCard(product: ProductWithRelations): string {
  const panelName = product.panel !== null ? escapeHtml(product.panel.name) : DASH;
  return [
    `<b>${escapeHtml(product.name)}</b>`,
    `🌐 پنل: ${panelName} · 📂 دسته: ${escapeHtml(product.category.name)}`,
    `📍 ${locationLabel(product)} · 🧯 ${volumeLabel(product.volumeGb)} · ⏳ ${durationLabel(product.durationDays)}`,
    `💵 ${formatToman(product.priceToman)}`,
  ].join("\n");
}

/**
 * A bounded OTHER_PRODUCT card for the product-list page (task §9): name,
 * category, price, duration (when applicable), delivery label, and whether extra
 * info will be requested. Never shows stock counts / schema internals.
 */
export function otherProductCard(product: ProductWithRelations): string {
  const lines = [
    `<b>${escapeHtml(product.name)}</b>`,
    `📂 دسته: ${escapeHtml(product.category.name)}`,
  ];
  if (product.durationDays !== null && product.durationDays > 0) {
    lines.push(`⏳ مدت اعتبار: ${durationLabel(product.durationDays)}`);
  }
  lines.push(`🚚 ${deliveryLabel(product.deliveryType)}`);
  if (product.requiredUserInfoEnabled) {
    lines.push("📝 پس از پرداخت اطلاعات تکمیلی از شما پرسیده می‌شود.");
  }
  lines.push(`💵 ${formatToman(product.priceToman)}`);
  return lines.join("\n");
}

// --- Detail bodies -----------------------------------------------------------

/** The richest SERVICE_PRODUCT view (task §10). `repNote` is pre-escaped/safe. */
export function serviceDetailBody(
  product: ProductWithRelations,
  disclaimer: string,
): string {
  const panelName = product.panel !== null ? escapeHtml(product.panel.name) : DASH;
  const lines = [
    `💰 <b>${escapeHtml(product.name)}</b>`,
    "",
    `🌐 پنل: ${panelName}`,
    `📂 دسته‌بندی: ${escapeHtml(product.category.name)}`,
    `📍 لوکیشن: ${locationLabel(product)}`,
    `🧯 حجم: ${volumeLabel(product.volumeGb)}`,
    `⏳ مدت اعتبار: ${durationLabel(product.durationDays)}`,
    `💵 قیمت فعلی: ${formatToman(product.priceToman)}`,
  ];
  if (product.invoiceDescription !== null && product.invoiceDescription.trim() !== "") {
    lines.push("", `📝 ${boundedDescription(product.invoiceDescription)}`);
  }
  lines.push("", disclaimer);
  return lines.join("\n");
}

/** The richest OTHER_PRODUCT view (task §10). */
export function otherDetailBody(
  product: ProductWithRelations,
  disclaimer: string,
): string {
  const lines = [
    `💰 <b>${escapeHtml(product.name)}</b>`,
    "",
    `📂 دسته‌بندی: ${escapeHtml(product.category.name)}`,
    `💵 قیمت فعلی: ${formatToman(product.priceToman)}`,
  ];
  if (product.durationDays !== null && product.durationDays > 0) {
    lines.push(`⏳ مدت اعتبار: ${durationLabel(product.durationDays)}`);
  }
  lines.push(`🚚 نوع تحویل: ${deliveryLabel(product.deliveryType)}`);
  if (product.requiredUserInfoEnabled) {
    lines.push("📝 پس از پرداخت، اطلاعات تکمیلی از شما دریافت خواهد شد.");
    if (
      product.requiredUserInfoPromptText !== null &&
      product.requiredUserInfoPromptText.trim() !== ""
    ) {
      lines.push(boundedDescription(product.requiredUserInfoPromptText));
    }
  }
  if (product.invoiceDescription !== null && product.invoiceDescription.trim() !== "") {
    lines.push("", `📝 ${boundedDescription(product.invoiceDescription)}`);
  }
  lines.push("", disclaimer);
  return lines.join("\n");
}
