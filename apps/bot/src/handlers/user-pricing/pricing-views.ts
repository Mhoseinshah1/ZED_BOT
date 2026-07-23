// =============================================================================
// Pure, DB-free rendering helpers for the public retail Pricing Catalog
// (feat/public-pricing-catalog). Everything here is synchronous and side-effect
// free so it is trivially unit-testable: formatting, bounded "cards", and detail
// bodies. Every operator-controlled value (product / panel / category names,
// invoice descriptions, prompt text, the disclaimer) is bounded to a per-field
// ESCAPED budget via `boundHtmlText` (fix/pricing-catalog-post-merge-safety), so
// the composed HTML message can never exceed Telegram's limit and no HTML entity
// or surrogate pair is ever cut. NO secret-shaped field (panel URL, credentials,
// inbound ids, stock, subscription domain, config) is ever read. Prices come only
// from `product.priceToman`.
// =============================================================================

import type { ProductWithRelations } from "../../services/product.service.js";
import { boundHtmlText } from "./pricing-bounds.js";

/** Missing-optional-value placeholder (task §8/§10). */
export const DASH = "—";

/**
 * Bound (ESCAPED code units) for a rendered invoice description. Kept small so a
 * description + disclaimer + labels always fit inside PRICING_DETAIL_SAFE_LIMIT.
 */
export const INVOICE_DESCRIPTION_MAX = 600;

// Per-field ESCAPED budgets. The per-page sums stay well under 3900:
//   service detail  ≈ 250 + 256 + 160 + 160 + 600 + 700 = 2126
//   other detail    ≈ 250 + 256 + 160 + 600 + 600 + 700 = 2566
//   product list    ≤ 5 × (200 + 120 + 120) + header    = ~2400
//   panel/category list ≤ 8 × 200 + summaries           = ~2400
const DETAIL_NAME_BUDGET = 256;
const DETAIL_PANEL_BUDGET = 160;
const DETAIL_CATEGORY_BUDGET = 160;
const DETAIL_PROMPT_BUDGET = 600;
const DETAIL_DISCLAIMER_BUDGET = 700;
const CARD_NAME_BUDGET = 200;
const CARD_PANEL_BUDGET = 120;
const CARD_CATEGORY_BUDGET = 120;
const SUMMARY_NAME_BUDGET = 200;

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

/**
 * Escapes AND bounds an operator description to its existing contract
 * (INVOICE_DESCRIPTION_MAX escaped units). Escape-aware + surrogate-safe.
 */
export function boundedDescription(raw: string): string {
  return boundHtmlText(raw, INVOICE_DESCRIPTION_MAX);
}

/** Escapes + truncates a name for a compact inline button label (plain sink). */
export function buttonName(name: string, max = 28): string {
  const clean = name.trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

// --- Panel / category summary rows -------------------------------------------

/** «<name> — <count> پلن · از <minPrice>». Name is bounded + escaped. */
export function panelSummaryLine(name: string, count: number, minPriceToman: number): string {
  return `🌐 <b>${boundHtmlText(name, SUMMARY_NAME_BUDGET)}</b>\n   ${count} پلن قابل خرید · شروع از ${formatToman(minPriceToman)}`;
}

export function categorySummaryLine(name: string, count: number, minPriceToman: number): string {
  return `📂 <b>${boundHtmlText(name, SUMMARY_NAME_BUDGET)}</b>\n   ${count} مورد · شروع از ${formatToman(minPriceToman)}`;
}

// --- Product cards (list pages) ----------------------------------------------

/**
 * A bounded SERVICE_PRODUCT card for the product-list page (task §8): name,
 * panel, category, location, volume, duration, price. No secret is ever shown.
 */
export function serviceProductCard(product: ProductWithRelations): string {
  const panelName = product.panel !== null ? boundHtmlText(product.panel.name, CARD_PANEL_BUDGET) : DASH;
  return [
    `<b>${boundHtmlText(product.name, CARD_NAME_BUDGET)}</b>`,
    `🌐 پنل: ${panelName} · 📂 دسته: ${boundHtmlText(product.category.name, CARD_CATEGORY_BUDGET)}`,
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
    `<b>${boundHtmlText(product.name, CARD_NAME_BUDGET)}</b>`,
    `📂 دسته: ${boundHtmlText(product.category.name, CARD_CATEGORY_BUDGET)}`,
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

/**
 * The richest SERVICE_PRODUCT view (task §10). `rawDisclaimer` is the operator
 * template verbatim — it is bounded + escaped here (never pre-escaped), so the
 * completed HTML message stays valid and within PRICING_DETAIL_SAFE_LIMIT.
 */
export function serviceDetailBody(product: ProductWithRelations, rawDisclaimer: string): string {
  const panelName = product.panel !== null ? boundHtmlText(product.panel.name, DETAIL_PANEL_BUDGET) : DASH;
  const lines = [
    `💰 <b>${boundHtmlText(product.name, DETAIL_NAME_BUDGET)}</b>`,
    "",
    `🌐 پنل: ${panelName}`,
    `📂 دسته‌بندی: ${boundHtmlText(product.category.name, DETAIL_CATEGORY_BUDGET)}`,
    `📍 لوکیشن: ${locationLabel(product)}`,
    `🧯 حجم: ${volumeLabel(product.volumeGb)}`,
    `⏳ مدت اعتبار: ${durationLabel(product.durationDays)}`,
    `💵 قیمت فعلی: ${formatToman(product.priceToman)}`,
  ];
  if (product.invoiceDescription !== null && product.invoiceDescription.trim() !== "") {
    lines.push("", `📝 ${boundedDescription(product.invoiceDescription)}`);
  }
  lines.push("", boundHtmlText(rawDisclaimer, DETAIL_DISCLAIMER_BUDGET));
  return lines.join("\n");
}

/** The richest OTHER_PRODUCT view (task §10). `rawDisclaimer` bounded here. */
export function otherDetailBody(product: ProductWithRelations, rawDisclaimer: string): string {
  const lines = [
    `💰 <b>${boundHtmlText(product.name, DETAIL_NAME_BUDGET)}</b>`,
    "",
    `📂 دسته‌بندی: ${boundHtmlText(product.category.name, DETAIL_CATEGORY_BUDGET)}`,
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
      lines.push(boundHtmlText(product.requiredUserInfoPromptText, DETAIL_PROMPT_BUDGET));
    }
  }
  if (product.invoiceDescription !== null && product.invoiceDescription.trim() !== "") {
    lines.push("", `📝 ${boundedDescription(product.invoiceDescription)}`);
  }
  lines.push("", boundHtmlText(rawDisclaimer, DETAIL_DISCLAIMER_BUDGET));
  return lines.join("\n");
}
