import {
  PanelStatus,
  type Panel,
  type Product,
  type ProductCategory,
  type UserGroup,
} from "@zedbot/database";

import {
  panelSupportsOperation,
  resolveXuiAuthMode,
  resolveXuiVariant,
  SUPPORTED_XUI_AUTH_MODES,
  SUPPORTED_XUI_VARIANTS,
} from "./panel-capability.js";

// =============================================================================
// Which products a person may see and buy — the catalog predicates, moved out
// of the bot so the Mini App asks the same questions rather than similar ones.
//
// WHY THIS IS NOT A COPY. Product visibility decides what a customer is offered
// and, one click later, what they are charged for. Two implementations of it
// agree until the day someone adds a rule to one of them, and the failure mode
// is a product that is unbuyable in the bot and buyable in the browser. So the
// predicates live here once and `apps/bot/src/services/catalog.service.ts`
// re-exports them; every existing bot call site keeps working unchanged.
//
// NO PERSIAN HERE. `assessPanelConfig` in the bot used to return both a machine
// reason and the admin's Persian sentence. Only the machine reason moved — the
// sentence is presentation and stays with the transport that renders it. The
// bot maps `PanelConfigProblem` back to exactly the text it printed before.
// =============================================================================

/**
 * A product together with the two rows every visibility rule consults.
 *
 * Declared here rather than in the bot because the predicates below need it and
 * a domain package cannot import an app. `apps/bot/src/services/product.service.ts`
 * re-exports this name, so the bot's ~200 references are untouched.
 */
export type ProductWithRelations = Product & {
  category: ProductCategory;
  panel: Panel | null;
};

/**
 * Group visibility: a product is visible when its displayGroups array contains
 * the user's group (or "ALL"). Missing/empty/invalid displayGroups fall back to
 * the SAFE default: visible to group F only.
 */
export function groupMatches(displayGroups: unknown, group: UserGroup): boolean {
  if (Array.isArray(displayGroups)) {
    const valid = displayGroups.filter(
      (g): g is string => g === "F" || g === "N" || g === "N2" || g === "ALL",
    );
    if (valid.length > 0) {
      return valid.includes("ALL") || valid.includes(group);
    }
  }
  return group === "F";
}

/** Parses a panel's inboundIds JSON into a validated int array. */
export function parsePanelInboundIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((v): v is number => typeof v === "number" && Number.isInteger(v));
}

/** Result of resolving a product's effective XUI inbound selection. */
export type ProductInboundResolution =
  | { ok: true; inboundIds: number[]; inherited: boolean }
  | { ok: false; reason: "panel-allowlist-empty" | "subset-violation"; invalidIds?: number[] };

/**
 * Resolves the inbound ids a SERVICE_PRODUCT provisions into on an XUI panel.
 * Configuration hierarchy:
 *   - Panel.inboundIds is the ALLOWLIST of inbound ids ZED_BOT may use;
 *   - Product.inboundIds selects a SUBSET of that allowlist;
 *   - null/empty product selection inherits the panel's full allowlist;
 *   - any selected id outside the allowlist is a configuration error: the
 *     product is unsellable and provisioning fails BEFORE any panel call.
 */
export function resolveProductInboundIds(
  panel: Panel,
  productInboundIds: unknown,
): ProductInboundResolution {
  const allowed = parsePanelInboundIds(panel.inboundIds);
  if (allowed.length === 0) {
    return { ok: false, reason: "panel-allowlist-empty" };
  }
  const selected = parsePanelInboundIds(productInboundIds);
  if (selected.length === 0) {
    return { ok: true, inboundIds: allowed, inherited: true };
  }
  const allowedSet = new Set(allowed);
  const invalidIds = [...new Set(selected.filter((id) => !allowedSet.has(id)))];
  if (invalidIds.length > 0) {
    return { ok: false, reason: "subset-violation", invalidIds };
  }
  return { ok: true, inboundIds: [...new Set(selected)], inherited: false };
}

/**
 * Why a panel cannot provision, as a code. `null` means the local configuration
 * is complete.
 *
 * The values are exactly the `reason` strings the bot's `assessPanelConfig`
 * already produced, so its Persian mapping is a lookup rather than a rewrite.
 */
export type PanelConfigProblem =
  | "missing-credentials"
  | "no-template-or-protocol-config"
  | "unsupported-xui-variant"
  | "unsupported-xui-auth-mode"
  | "missing-api-token"
  | "no-inbound-ids";

/**
 * LOCAL (no network) provisioning-config assessment. Catches configuration
 * dead-ends — missing credentials, no template/protocol config, no inbound ids,
 * unsupported variant — BEFORE the user pays.
 */
export function panelConfigProblem(panel: Panel): PanelConfigProblem | null {
  if (panel.type === "MARZBAN") {
    if (panel.username === null || panel.passwordEncrypted === null) {
      return "missing-credentials";
    }
    const hasTemplate = (panel.templateUsername?.trim() ?? "") !== "";
    const hasExplicit =
      panel.protocolSettings !== null &&
      typeof panel.protocolSettings === "object" &&
      !Array.isArray(panel.protocolSettings) &&
      Object.keys(panel.protocolSettings as Record<string, unknown>).length > 0;
    if (!hasTemplate && !hasExplicit) {
      return "no-template-or-protocol-config";
    }
    return null;
  }
  if (!SUPPORTED_XUI_VARIANTS.has(resolveXuiVariant(panel))) {
    return "unsupported-xui-variant";
  }
  const authMode = resolveXuiAuthMode(panel);
  if (!SUPPORTED_XUI_AUTH_MODES.has(authMode)) {
    return "unsupported-xui-auth-mode";
  }
  if (authMode === "API_TOKEN") {
    if (panel.tokenEncrypted === null || panel.tokenEncrypted === "") {
      return "missing-api-token";
    }
  } else if (panel.username === null || panel.passwordEncrypted === null) {
    return "missing-credentials";
  }
  if (parsePanelInboundIds(panel.inboundIds).length === 0) {
    return "no-inbound-ids";
  }
  return null;
}

/**
 * True when service products on this panel may be sold RIGHT NOW: ACTIVE +
 * createService capability + complete local config + the last persisted
 * authenticated readiness check did not fail. A never-checked panel
 * (provisioningReady null) with complete config stays sellable so existing
 * deployments keep working; an explicit failed check blocks sales until an
 * admin re-tests successfully.
 */
export function isPanelSellable(panel: Panel): boolean {
  return (
    panel.status === PanelStatus.ACTIVE &&
    panelSupportsOperation(panel, "createService") &&
    panelConfigProblem(panel) === null &&
    panel.provisioningReady !== false
  );
}

/**
 * Structural sellability of a product, INDEPENDENT of any user group: the
 * product is active, its category is active, and (for a SERVICE_PRODUCT) its
 * panel exists, is visible, is sellable (provisioning-ready), and its XUI
 * inbound selection is valid.
 */
export function isProductStructurallySellable(product: ProductWithRelations): boolean {
  if (!product.isActive || !product.category.isActive) {
    return false;
  }
  if (product.type === "SERVICE_PRODUCT") {
    if (product.panel === null || !product.panel.isVisible || !isPanelSellable(product.panel)) {
      return false;
    }
    if (
      product.panel.type === "XUI" &&
      !resolveProductInboundIds(product.panel, product.inboundIds).ok
    ) {
      return false;
    }
  }
  return true;
}

/**
 * The SINGLE authoritative catalog predicate: group visibility on top of the
 * structural sellability core above.
 */
export function isProductVisible(product: ProductWithRelations, group: UserGroup): boolean {
  if (!groupMatches(product.displayGroups, group)) {
    return false;
  }
  return isProductStructurallySellable(product);
}
