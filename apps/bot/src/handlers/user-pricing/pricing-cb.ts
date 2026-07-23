// =============================================================================
// Shared callback-data builder + parser for the public retail Pricing Catalog
// (feat/public-pricing-catalog). One place owns every pricing callback shape so
// nothing is scattered as a literal and every emitted callback has a handler.
//
// Contract (all <= 64 bytes; 8-char UUID short ids; base36 page numbers):
//
//   user:pricing                                           (root — CB.USER_PRICING, unchanged)
//
//   user:price:s                                           service panel list (page 1)
//   user:price:s:<page36>                                  service panel list (page N)
//   user:price:sp:<panelSid>:<page36>                      a panel's category list
//   user:price:sc:<panelSid>:<catSid>:<page36>             a category's product list
//   user:price:sv:<prodSid>:<panelSid>:<catSid>:<page36>   service product detail
//   user:price:bs:<prodSid>:<panelSid>:<catSid>:<page36>   BUY a service product
//
//   user:price:o                                           other-product category list (page 1)
//   user:price:o:<page36>                                  other-product category list (page N)
//   user:price:oc:<catSid>:<page36>                        an other category's product list
//   user:price:ov:<prodSid>:<catSid>:<page36>              other product detail
//   user:price:bo:<prodSid>:<catSid>:<page36>              BUY an other product
//
// The list-page number travels inside detail/buy callbacks ONLY as navigation
// metadata so the pre-invoice «بازگشت» returns to the exact page. Prices, ids
// and section are ALWAYS re-resolved from the live Product at click time — a
// callback never carries a price and short ids are re-verified ambiguity-safely.
// =============================================================================

import { CB } from "../../core/callbacks.js";

/** Encodes a 1-based page as a compact lowercase base36 token. */
function p36(page: number): string {
  const n = Number.isFinite(page) ? Math.trunc(page) : 1;
  return Math.max(1, n).toString(36);
}

/**
 * Decodes a base36 page token back to a 1-based page. Missing/garbage/negative
 * input normalizes SAFELY to page 1; the handler additionally clamps against the
 * real page count, so a huge or stale value can never overflow.
 */
export function parsePricingPage(raw: string | undefined): number {
  if (raw === undefined || raw === "") {
    return 1;
  }
  const n = Number.parseInt(raw, 36);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

export const PRICE_CB = {
  /** Pricing root — the existing stable callback, never renamed. */
  root: CB.USER_PRICING,

  // --- Service branch ---------------------------------------------------------
  serviceRoot: "user:price:s",
  serviceRootPage: (page: number): string => `user:price:s:${p36(page)}`,
  servicePanel: (panelSid: string, page: number): string =>
    `user:price:sp:${panelSid}:${p36(page)}`,
  serviceCategory: (panelSid: string, catSid: string, page: number): string =>
    `user:price:sc:${panelSid}:${catSid}:${p36(page)}`,
  serviceDetail: (prodSid: string, panelSid: string, catSid: string, page: number): string =>
    `user:price:sv:${prodSid}:${panelSid}:${catSid}:${p36(page)}`,
  serviceBuy: (prodSid: string, panelSid: string, catSid: string, page: number): string =>
    `user:price:bs:${prodSid}:${panelSid}:${catSid}:${p36(page)}`,

  // --- Other-product branch ---------------------------------------------------
  otherRoot: "user:price:o",
  otherRootPage: (page: number): string => `user:price:o:${p36(page)}`,
  otherCategory: (catSid: string, page: number): string => `user:price:oc:${catSid}:${p36(page)}`,
  otherDetail: (prodSid: string, catSid: string, page: number): string =>
    `user:price:ov:${prodSid}:${catSid}:${p36(page)}`,
  otherBuy: (prodSid: string, catSid: string, page: number): string =>
    `user:price:bo:${prodSid}:${catSid}:${p36(page)}`,

  /** «تعرفه نمایندگی من» routes into the EXISTING representative surface. */
  representative: CB.USER_REPRESENTATIVE,
} as const;
