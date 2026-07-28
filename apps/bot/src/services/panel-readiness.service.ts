import { PanelStatus, Prisma, prisma, type Panel, type Service } from "@zedbot/database";
import {
  MARZBAN_CAPABILITIES,
  XUI_CAPABILITIES,
  type PanelCapability,
  type PanelDiagnosticCode,
  type ProvisioningReadinessResult,
  type ReadinessCheck,
} from "@zedbot/panel-adapters";
import { errorMessage } from "@zedbot/shared";

import {
  classifyXuiRemoteModel,
  panelCapabilities,
  panelHasCredentials,
  panelOperationAvailable,
  panelSupportsOperation,
  panelTypesSupporting,
  serviceSupportsGlobalLifecycle,
  type XuiRemoteModel,
} from "@zedbot/service-renewal";

import { logger } from "../core/logger.js";
import {
  buildAdapterForPanel,
  normalizeSubscriptionBase,
  resolveXuiAuthMode,
  resolveXuiVariant,
  SUPPORTED_XUI_AUTH_MODES,
  SUPPORTED_XUI_VARIANTS,
} from "./panel-adapter-factory.js";

// =============================================================================
// Panel capability + provisioning-readiness model.
//
// Two layers:
//   1. LOCAL assessment (no network): does the panel row carry everything
//      provisioning needs? Used on every catalog/checkout/payment hot path.
//   2. AUTHENTICATED readiness (network): the adapter's real check, run from
//      the admin "test" button, persisted on the panel row
//      (provisioningReady / lastCapabilityCheckAt / capabilitySnapshot).
//
// A panel is SELLABLE only when it is ACTIVE, its type supports
// createService, the local assessment passes and the last persisted
// readiness result is not an explicit failure. Reachability alone NEVER
// makes a panel ready.
// =============================================================================

/** Generic Persian text for a provisioning failure shown to admins. */
export const PANEL_CREATE_FAILED_TEXT = "ساخت سرویس روی پنل ناموفق بود.";
/** Persian admin text: the panel configuration is incomplete. */
export const PANEL_CONFIG_INCOMPLETE_TEXT = "تنظیمات پنل ناقص است.";
/** Persian admin text: panel authentication failed. */
export const PANEL_AUTH_FAILED_TEXT = "احراز هویت پنل ناموفق بود.";
/** Persian admin text: the configured Marzban template user was not found. */
export const PANEL_TEMPLATE_NOT_FOUND_TEXT = "کاربر الگوی مرزبان پیدا نشد.";
/** Persian admin text: no valid inbound id configured for the XUI panel. */
export const PANEL_XUI_INBOUND_TEXT = "شناسه اینباند معتبر برای پنل XUI تنظیم نشده است.";
/** Persian admin text: the product's inbound selection leaves the panel allowlist. */
export const PRODUCT_INBOUND_SUBSET_TEXT =
  "شناسه‌های اینباند محصول خارج از لیست مجاز پنل است.";
/** Persian user-facing text when an operation is not supported on the panel. */
export const PANEL_OPERATION_UNSUPPORTED_TEXT =
  "این عملیات برای این سرویس پشتیبانی نمی‌شود.";
/** Persian status for services created under the legacy per-inbound model. */
export const XUI_LEGACY_SERVICE_TEXT = "این سرویس با ساختار قدیمی پنل ساخته شده است.";
/** Persian block for lifecycle operations on legacy per-inbound services. */
export const XUI_LEGACY_OPERATION_TEXT =
  "این عملیات برای سرویس‌های قدیمی XUI پشتیبانی نمی‌شود.";

/** Admin-facing readiness status labels (specified texts). */
export const READINESS_STATUS_TEXT = {
  ready: "آماده ساخت سرویس",
  configIncomplete: "تنظیمات ناقص",
  authFailed: "احراز هویت ناموفق",
  inboundMissing: "اینباند تنظیم نشده",
  templateNotFound: "کاربر الگو یافت نشد",
  unsupportedVariant: "نسخه API پشتیبانی نمی‌شود",
  unverifiable: "اتصال برقرار است اما ساخت سرویس قابل تایید نیست",
  unreachable: "پنل در دسترس نیست",
} as const;

/** Persian labels for the read-only capability list in the admin UI. */
const CAPABILITY_LABELS: Record<PanelCapability, string> = {
  authenticatedHealth: "تست اتصال با احراز هویت",
  createService: "ساخت سرویس",
  readService: "خواندن وضعیت سرویس",
  renewService: "تمدید سرویس",
  addVolume: "حجم اضافه",
  addTime: "زمان اضافه",
  toggleService: "فعال/غیرفعال‌سازی",
  regenerateSubscription: "تعویض لینک اشتراک",
  deleteService: "حذف سرویس",
  reconciliation: "بازتطبیق خودکار",
};

const ALL_CAPABILITIES: readonly PanelCapability[] = [
  "authenticatedHealth",
  "createService",
  "readService",
  "renewService",
  "addVolume",
  "addTime",
  "toggleService",
  "regenerateSubscription",
  "deleteService",
  "reconciliation",
];

/** Static capability set for a panel row (per type/variant, no network). */
/** Persian capability statuses for the admin panel detail (specified texts). */
export const CAPABILITY_STATUS_TEXT = {
  supported: "پشتیبانی می‌شود ✅",
  unsupported: "پشتیبانی نمی‌شود ❌",
  retestNeeded: "نیازمند تست مجدد",
  incompatibleApi: "نسخه API ناسازگار است",
} as const;

/** Panel-detail operation list (specified labels, in specified order). */
const DETAIL_CAPABILITY_LABELS: readonly [PanelCapability, string][] = [
  ["createService", "ساخت سرویس"],
  ["readService", "بروزرسانی سرویس"],
  ["renewService", "تمدید"],
  ["addVolume", "حجم اضافه"],
  ["addTime", "زمان اضافه"],
  ["toggleService", "فعال/غیرفعال"],
  ["regenerateSubscription", "تغییر لینک"],
  ["reconciliation", "تطبیق پنل"],
];

/**
 * Read-only per-operation status list for the admin panel detail view. A
 * capability reads «پشتیبانی می‌شود» ONLY when the adapter implements it AND
 * the last persisted authenticated readiness check passed - implemented but
 * unverified (never tested, failed test, or config edited since) reads
 * «نیازمند تست مجدد», so documentation presence alone never enables
 * anything. An unsupported XUI apiVariant marks every operation
 * «نسخه API ناسازگار است».
 */
export function panelCapabilityStatusLines(panel: Panel): string[] {
  const incompatibleApi =
    panel.type === "XUI" && !SUPPORTED_XUI_VARIANTS.has(resolveXuiVariant(panel));
  const supported = new Set(panelCapabilities(panel));
  return DETAIL_CAPABILITY_LABELS.map(([cap, label]) => {
    const status = incompatibleApi
      ? CAPABILITY_STATUS_TEXT.incompatibleApi
      : !supported.has(cap)
        ? CAPABILITY_STATUS_TEXT.unsupported
        : panel.provisioningReady === true
          ? CAPABILITY_STATUS_TEXT.supported
          : CAPABILITY_STATUS_TEXT.retestNeeded;
    return `${label}: ${status}`;
  });
}

export interface PanelConfigAssessment {
  ok: boolean;
  /** Machine-readable reason for logs; never contains secrets. */
  reason?: string;
  /** Sanitized Persian admin text. */
  adminText?: string;
}

/** Parses the panel's inboundIds JSON into a validated int array. */
export function parsePanelInboundIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((v): v is number => typeof v === "number" && Number.isInteger(v));
}

/**
 * Remote model of an XUI service. Lifecycle mutations run ONLY against
 * GLOBAL_CLIENT services; legacy per-inbound services (created before the
 * global-client migration) stay readable but are never mutated through the
 * global-client endpoints and are never silently migrated.
 */
/** Result of resolving a product's effective XUI inbound selection. */
export type ProductInboundResolution =
  | { ok: true; inboundIds: number[]; inherited: boolean }
  | { ok: false; reason: "panel-allowlist-empty" | "subset-violation"; invalidIds?: number[] };

/**
 * Resolves the inbound ids a SERVICE_PRODUCT provisions into on an XUI
 * panel. Configuration hierarchy:
 *   - Panel.inboundIds is the ALLOWLIST of inbound ids ZED_BOT may use;
 *   - Product.inboundIds selects a SUBSET of that allowlist;
 *   - null/empty product selection inherits the panel's full allowlist
 *     (backward compatible - existing products keep working unchanged);
 *   - any selected id outside the allowlist is a configuration error: the
 *     product is unsellable and provisioning fails BEFORE any panel call.
 * Pure and local - panel readiness already validates the allowlist against
 * the live panel, so a valid subset needs no extra network round-trip.
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
 * LOCAL (no network) provisioning-config assessment. Catches configuration
 * dead-ends - missing credentials, no template/protocol config, no inbound
 * ids, unsupported variant - BEFORE the user pays.
 */
export function assessPanelConfig(panel: Panel): PanelConfigAssessment {
  if (panel.type === "MARZBAN") {
    if (panel.username === null || panel.passwordEncrypted === null) {
      return { ok: false, reason: "missing-credentials", adminText: PANEL_CONFIG_INCOMPLETE_TEXT };
    }
    const hasTemplate = (panel.templateUsername?.trim() ?? "") !== "";
    const hasExplicit =
      panel.protocolSettings !== null &&
      typeof panel.protocolSettings === "object" &&
      !Array.isArray(panel.protocolSettings) &&
      Object.keys(panel.protocolSettings as Record<string, unknown>).length > 0;
    if (!hasTemplate && !hasExplicit) {
      return {
        ok: false,
        reason: "no-template-or-protocol-config",
        adminText: PANEL_CONFIG_INCOMPLETE_TEXT,
      };
    }
    return { ok: true };
  }
  if (!SUPPORTED_XUI_VARIANTS.has(resolveXuiVariant(panel))) {
    return {
      ok: false,
      reason: "unsupported-xui-variant",
      adminText: READINESS_STATUS_TEXT.unsupportedVariant,
    };
  }
  const authMode = resolveXuiAuthMode(panel);
  if (!SUPPORTED_XUI_AUTH_MODES.has(authMode)) {
    return {
      ok: false,
      reason: "unsupported-xui-auth-mode",
      adminText: PANEL_CONFIG_INCOMPLETE_TEXT,
    };
  }
  if (authMode === "API_TOKEN") {
    if (panel.tokenEncrypted === null || panel.tokenEncrypted === "") {
      return { ok: false, reason: "missing-api-token", adminText: PANEL_CONFIG_INCOMPLETE_TEXT };
    }
  } else if (panel.username === null || panel.passwordEncrypted === null) {
    return { ok: false, reason: "missing-credentials", adminText: PANEL_CONFIG_INCOMPLETE_TEXT };
  }
  if (parsePanelInboundIds(panel.inboundIds).length === 0) {
    return { ok: false, reason: "no-inbound-ids", adminText: PANEL_XUI_INBOUND_TEXT };
  }
  return { ok: true };
}

/**
 * true when service products on this panel may be sold RIGHT NOW:
 * ACTIVE + createService capability + complete local config + the last
 * persisted authenticated readiness check did not fail. A never-checked
 * panel (provisioningReady null) with complete config stays sellable so
 * existing deployments keep working; an explicit failed check blocks sales
 * until an admin re-tests successfully.
 */
export function isPanelSellable(panel: Panel): boolean {
  return (
    panel.status === PanelStatus.ACTIVE &&
    panelSupportsOperation(panel, "createService") &&
    assessPanelConfig(panel).ok &&
    panel.provisioningReady !== false
  );
}

// =============================================================================
// Authenticated readiness check (admin test button)
// =============================================================================

const CHECK_LABELS: Record<ReadinessCheck["key"], string> = {
  reachable: "دسترسی به آدرس پنل",
  auth: "احراز هویت",
  "read-endpoint": "خواندن اطلاعات از پنل",
  template: "کاربر الگو",
  inbounds: "اینباندهای تنظیم‌شده",
  config: "تنظیمات ساخت سرویس",
};

/** Sanitized Persian sentence for the admin, per diagnostic code. */
function diagnosticTextForCode(code: PanelDiagnosticCode | undefined): string {
  switch (code) {
    case "auth-failed":
      return PANEL_AUTH_FAILED_TEXT;
    case "template-not-found":
      return PANEL_TEMPLATE_NOT_FOUND_TEXT;
    case "config-incomplete":
    case "config-invalid":
    case "template-invalid":
      return PANEL_CONFIG_INCOMPLETE_TEXT;
    case "inbound-missing":
    case "inbound-disabled":
    case "inbound-malformed":
    case "unsupported-protocol":
      return PANEL_XUI_INBOUND_TEXT;
    default:
      return PANEL_CREATE_FAILED_TEXT;
  }
}

function statusTextForCode(code: PanelDiagnosticCode | undefined): string {
  switch (code) {
    case "auth-failed":
      return READINESS_STATUS_TEXT.authFailed;
    case "template-not-found":
      return READINESS_STATUS_TEXT.templateNotFound;
    case "template-invalid":
    case "config-invalid":
    case "config-incomplete":
      return READINESS_STATUS_TEXT.configIncomplete;
    case "inbound-missing":
    case "inbound-disabled":
    case "inbound-malformed":
    case "unsupported-protocol":
      return READINESS_STATUS_TEXT.inboundMissing;
    case "unsupported-variant":
      return READINESS_STATUS_TEXT.unsupportedVariant;
    case "unreachable":
    case "timeout":
      return READINESS_STATUS_TEXT.unreachable;
    default:
      return READINESS_STATUS_TEXT.unverifiable;
  }
}

export interface PanelReadinessReport {
  ready: boolean;
  /** One-line Persian status for the admin. */
  statusText: string;
  /** Sanitized Persian sentence describing the failure (null when ready). */
  diagnosticText: string | null;
  /** Persian per-step lines (check name + pass/fail/skip). */
  checkLines: string[];
  /** Persian read-only capability lines (supported + unsupported). */
  capabilityLines: string[];
}

/** Formats an adapter readiness result for the admin UI (sanitized). */
export function formatReadinessReport(result: ProvisioningReadinessResult): PanelReadinessReport {
  const checkLines = result.checks.map((check) => {
    const mark = check.ok === true ? "✅" : check.ok === false ? "❌" : "➖";
    return `${mark} ${CHECK_LABELS[check.key]}`;
  });
  const supported = new Set(result.capabilities);
  const capabilityLines = ALL_CAPABILITIES.map(
    (cap) => `${supported.has(cap) ? "✅" : "🚫"} ${CAPABILITY_LABELS[cap]}`,
  );
  return {
    ready: result.ready,
    statusText: result.ready
      ? READINESS_STATUS_TEXT.ready
      : statusTextForCode(result.diagnostic?.code),
    diagnosticText: result.ready ? null : diagnosticTextForCode(result.diagnostic?.code),
    checkLines,
    capabilityLines,
  };
}

/**
 * Runs the adapter's authenticated readiness check and persists the outcome
 * on the panel row. The snapshot stores ONLY sanitized structured data -
 * never credentials, cookies or tokens. Failures of the check itself (e.g.
 * decryption errors) persist provisioningReady=false so the panel cannot be
 * sold on a broken configuration.
 */
export async function runPanelReadinessCheck(panel: Panel): Promise<PanelReadinessReport> {
  let result: ProvisioningReadinessResult;
  try {
    const adapter = buildAdapterForPanel(panel);
    result = await adapter.checkProvisioningReadiness({
      templateUsername: panel.templateUsername,
      inboundIds: parsePanelInboundIds(panel.inboundIds),
      protocolSettings:
        panel.protocolSettings !== null && typeof panel.protocolSettings === "object"
          ? (panel.protocolSettings as Record<string, unknown>)
          : null,
      subscriptionBaseUrl: normalizeSubscriptionBase(panel),
    });
  } catch (err) {
    // Covers missing credentials / APP_SECRET decryption failures - the
    // reason goes to logs, never to Telegram.
    logger.warn("panel readiness check could not run", {
      panelId: panel.id,
      error: errorMessage(err),
    });
    result = {
      ready: false,
      checks: [{ key: "config", ok: false, detail: "configuration incomplete" }],
      capabilities: panelCapabilities(panel),
      diagnostic: {
        operation: "readiness",
        panelType: panel.type === "MARZBAN" ? "marzban" : "xui",
        code: "config-incomplete",
        retryable: false,
        certainty: "definite",
      },
    };
  }

  try {
    await prisma.panel.update({
      where: { id: panel.id },
      data: {
        provisioningReady: result.ready,
        lastCapabilityCheckAt: new Date(),
        capabilitySnapshot: {
          ready: result.ready,
          checks: result.checks.map((c) => ({
            key: c.key,
            ok: c.ok,
            ...(c.detail !== undefined ? { detail: c.detail } : {}),
          })),
          capabilities: [...result.capabilities],
          ...(result.diagnostic !== undefined ? { code: result.diagnostic.code } : {}),
        },
      },
    });
  } catch (err) {
    logger.error("failed to persist panel readiness result", {
      panelId: panel.id,
      error: errorMessage(err),
    });
  }
  logger.info("panel readiness check completed", {
    panelId: panel.id,
    panelType: panel.type,
    ready: result.ready,
    code: result.diagnostic?.code ?? null,
  });
  return formatReadinessReport(result);
}

/**
 * Panel columns whose edit invalidates the persisted readiness result. The
 * update payload for such edits must merge in readinessResetData().
 */
export const READINESS_RELEVANT_COLUMNS: ReadonlySet<string> = new Set([
  "baseUrl",
  "username",
  "passwordEncrypted",
  "tokenEncrypted",
  "templateUsername",
  "subscriptionDomain",
  "inboundIds",
  "protocolSettings",
  "resetStrategy",
  "apiVariant",
  "authMode",
]);

/** Update-payload fragment that marks the readiness result stale (null). */
export function readinessResetData(): Prisma.PanelUpdateInput {
  return { provisioningReady: null, capabilitySnapshot: Prisma.DbNull };
}

// The capability predicates now live in @zedbot/service-renewal so the Mini App
// API can ask the same questions the bot asks. Re-exported here so every
// existing import of this module keeps working and there is still exactly one
// implementation.
export {
  classifyXuiRemoteModel,
  panelCapabilities,
  panelHasCredentials,
  panelOperationAvailable,
  panelSupportsOperation,
  panelTypesSupporting,
  serviceSupportsGlobalLifecycle,
  type XuiRemoteModel,
};
