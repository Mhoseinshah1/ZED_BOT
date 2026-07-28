// =============================================================================
// Commerce response DTOs (miniapp-commerce-parity §4/§6/§17).
//
// Same discipline as ../serializers.ts: every function names every field it
// emits, nothing spreads a Prisma row, and internal uuids never cross the
// boundary — commerce entities are addressed by the shared 8-hex public id.
// Amounts are integers in whole Toman, computed server-side; the frontend
// renders them and never derives them.
// =============================================================================
import type {
  CheckoutSession,
  Panel,
  Product,
  ProductCategory,
} from "@zedbot/database";
import { commerceShortId } from "@zedbot/shared";

export interface MiniAppCatalogProduct {
  publicId: string;
  name: string;
  priceToman: number;
  volumeGb: number | null;
  durationDays: number | null;
  serviceLocation: string | null;
}

export interface MiniAppCatalogCategory {
  publicId: string;
  name: string;
  products: MiniAppCatalogProduct[];
}

export interface MiniAppCatalogPanel {
  publicId: string;
  name: string;
  categories: MiniAppCatalogCategory[];
}

export function toCatalogProduct(product: Product): MiniAppCatalogProduct {
  return {
    publicId: commerceShortId(product),
    name: product.name,
    priceToman: product.priceToman,
    volumeGb: product.volumeGb,
    durationDays: product.durationDays,
    serviceLocation: product.serviceLocation,
  };
}

export function toCatalogCategory(
  category: ProductCategory,
  products: Product[],
): MiniAppCatalogCategory {
  return {
    publicId: commerceShortId(category),
    name: category.name,
    products: products.map(toCatalogProduct),
  };
}

export function toCatalogPanel(
  panel: Panel,
  categories: MiniAppCatalogCategory[],
): MiniAppCatalogPanel {
  return {
    publicId: commerceShortId(panel),
    name: panel.name,
    categories,
  };
}

/** The quote — authoritative amounts for a draft that has NOT been persisted. */
export interface MiniAppQuote {
  kind: "SERVICE" | "OTHER";
  productPublicId: string;
  productName: string;
  panelName: string | null;
  username: string | null;
  note: string | null;
  originalPriceToman: number;
  discountAmountToman: number;
  finalPriceToman: number;
  /** Present iff a code was accepted; the raw text the user typed. */
  discountCode: string | null;
  /** True when a code was supplied but cannot stack on reseller pricing. */
  discountStackingRejected: boolean;
  /** OTHER products: a structured customer-input form must be completed
   * before this checkout can settle. */
  needsCustomerInputBeforePayment: boolean;
  draftToken: string;
}

/** Safe subset of CheckoutSession.productSnapshot the Mini App may render. */
function snapshotField(snapshot: unknown, key: string): unknown {
  if (typeof snapshot !== "object" || snapshot === null) {
    return null;
  }
  return (snapshot as Record<string, unknown>)[key] ?? null;
}

function snapshotString(snapshot: unknown, key: string): string | null {
  const value = snapshotField(snapshot, key);
  return typeof value === "string" && value !== "" ? value : null;
}

export interface MiniAppCheckout {
  publicId: string;
  /** CheckoutStatus verbatim — a real machine code, rendered via i18n. */
  status: string;
  purpose: string;
  orderType: string | null;
  productName: string | null;
  panelName: string | null;
  username: string | null;
  originalPriceToman: number;
  discountAmountToman: number;
  finalPriceToman: number;
  discountCode: string | null;
  needsCustomerInputBeforePayment: boolean;
  expiresAt: string;
  createdAt: string;
}

export function toMiniAppCheckout(
  checkout: CheckoutSession,
  options?: { needsCustomerInput?: boolean },
): MiniAppCheckout {
  return {
    publicId: commerceShortId(checkout),
    status: checkout.status,
    purpose: checkout.purpose,
    orderType: checkout.orderType,
    productName: snapshotString(checkout.productSnapshot, "productName"),
    panelName: snapshotString(checkout.productSnapshot, "panelName"),
    username: snapshotString(checkout.productSnapshot, "serviceUsername"),
    originalPriceToman: checkout.originalPriceToman,
    discountAmountToman: checkout.discountAmountToman,
    finalPriceToman: checkout.finalPriceToman,
    discountCode: snapshotString(checkout.productSnapshot, "discountCode"),
    needsCustomerInputBeforePayment: options?.needsCustomerInput ?? false,
    expiresAt: checkout.expiresAt.toISOString(),
    createdAt: checkout.createdAt.toISOString(),
  };
}
