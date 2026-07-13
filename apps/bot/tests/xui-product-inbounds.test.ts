import type { Panel } from "@zedbot/database";
import { describe, expect, it } from "vitest";

import { isProductVisible } from "../src/services/catalog.service.js";
import { resolveProductInboundIds } from "../src/services/panel-readiness.service.js";
import type { ProductWithRelations } from "../src/services/product.service.js";

// =============================================================================
// Product-level XUI inbound selection (pure config/validation layer):
//   Panel.inboundIds  = the ALLOWLIST of inbound ids ZED_BOT may use
//   Product.inboundIds = the product's selected SUBSET of that allowlist
//   null/empty selection = inherit the full allowlist (backward compatible)
//   selection outside the allowlist = configuration error -> unsellable
// =============================================================================

function xuiPanel(overrides: Partial<Panel> = {}): Panel {
  return {
    type: "XUI",
    status: "ACTIVE",
    isVisible: true,
    username: "admin",
    passwordEncrypted: "enc",
    tokenEncrypted: null,
    authMode: null,
    apiVariant: null,
    inboundIds: [3, 5, 8, 12],
    provisioningReady: null,
    ...overrides,
  } as Panel;
}

function serviceProduct(
  panel: Panel,
  inboundIds: unknown,
  overrides: Record<string, unknown> = {},
): ProductWithRelations {
  return {
    type: "SERVICE_PRODUCT",
    isActive: true,
    displayGroups: ["ALL"],
    inboundIds,
    panel,
    category: { isActive: true },
    ...overrides,
  } as unknown as ProductWithRelations;
}

describe("resolveProductInboundIds (configuration hierarchy)", () => {
  const panel = xuiPanel();

  it("inherits the panel's full allowlist when the product selects nothing", () => {
    for (const empty of [null, undefined, [], "not-an-array", {}]) {
      const resolution = resolveProductInboundIds(panel, empty);
      expect(resolution.ok).toBe(true);
      if (resolution.ok) {
        expect(resolution.inboundIds).toEqual([3, 5, 8, 12]);
        expect(resolution.inherited).toBe(true);
      }
    }
  });

  it("accepts a valid subset and preserves the selection", () => {
    const resolution = resolveProductInboundIds(panel, [5, 12]);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.inboundIds).toEqual([5, 12]);
      expect(resolution.inherited).toBe(false);
    }
  });

  it("deduplicates a repeated selection and ignores non-integer entries", () => {
    const resolution = resolveProductInboundIds(panel, [5, 5, "8", 3.5, 12]);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      // "8" and 3.5 are not valid integer entries; 5 is deduplicated.
      expect(resolution.inboundIds).toEqual([5, 12]);
    }
  });

  it("rejects any selected id outside the panel allowlist", () => {
    const resolution = resolveProductInboundIds(panel, [5, 7, 99]);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.reason).toBe("subset-violation");
      expect(resolution.invalidIds).toEqual([7, 99]);
    }
  });

  it("rejects everything when the panel allowlist itself is empty", () => {
    const bare = xuiPanel({ inboundIds: [] as never });
    const resolution = resolveProductInboundIds(bare, [3]);
    expect(resolution.ok).toBe(false);
    if (!resolution.ok) {
      expect(resolution.reason).toBe("panel-allowlist-empty");
    }
  });
});

describe("isProductVisible gate (pre-payment sellability)", () => {
  it("keeps products with a valid or inherited selection sellable", () => {
    const panel = xuiPanel();
    expect(isProductVisible(serviceProduct(panel, null), "F")).toBe(true);
    expect(isProductVisible(serviceProduct(panel, [3, 8]), "F")).toBe(true);
  });

  it("hides a product whose selection leaves the allowlist", () => {
    const panel = xuiPanel();
    expect(isProductVisible(serviceProduct(panel, [3, 99]), "F")).toBe(false);
  });

  it("hides every product of an XUI panel without an allowlist", () => {
    // No allowlist = panel-level config incomplete: the existing panel
    // sellability gate already blocks it, with or without a selection.
    const panel = xuiPanel({ inboundIds: [] as never });
    expect(isProductVisible(serviceProduct(panel, null), "F")).toBe(false);
    expect(isProductVisible(serviceProduct(panel, [3]), "F")).toBe(false);
  });

  it("does not apply the inbound gate to Marzban products", () => {
    const marzban = {
      type: "MARZBAN",
      status: "ACTIVE",
      isVisible: true,
      username: "admin",
      passwordEncrypted: "enc",
      templateUsername: "tpl",
      inboundIds: null,
      provisioningReady: null,
    } as unknown as Panel;
    // A stray product-level selection on a Marzban product changes nothing.
    expect(isProductVisible(serviceProduct(marzban, [1, 2]), "F")).toBe(true);
  });
});
