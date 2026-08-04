import { PanelStatus, type Panel, type Service } from "@zedbot/database";
import {
  MARZBAN_CAPABILITIES,
  XUI_CAPABILITIES,
  type PanelCapability,
} from "@zedbot/panel-adapters";

// =============================================================================
// Which operations a panel can perform, and which services may receive them.
//
// WHY THESE MOVED. Every commerce decision that touches an existing service —
// can it be renewed, may it receive extra volume, is this plan sellable on this
// panel — resolves through these predicates. They lived in the bot's
// panel-readiness.service.ts, which cannot be imported by `apps/api` because it
// pulls in the bot logger and the adapter factory. Leaving them there would
// have forced the API to answer "is this renewable" its own way, which is the
// second implementation this program exists to prevent.
//
// WHY NOT IN @zedbot/panel-adapters. That package has no dependencies at all
// and never imports Prisma; it describes what an adapter can do, not what a
// database row is. These predicates read `Panel` and `Service` rows, so hosting
// them there would have made the adapter layer depend on the schema in order to
// answer a question the domain asks. The capability TABLES stay there and are
// imported from here — the direction that keeps the adapter layer ignorant of
// storage.
//
// The bot re-exports every symbol below from panel-readiness.service.ts, so its
// call sites are unchanged and there is still exactly one implementation.
// =============================================================================

/**
 * XUI variants this codebase implements and has tested against.
 *
 * A panel row may name anything; only the values here have an adapter behind
 * them. An unrecognised variant resolves to no capabilities at all rather than
 * to the default — guessing would mean calling endpoints that may not exist on
 * a panel someone is paying for.
 */
export const SUPPORTED_XUI_VARIANTS = new Set(["SANAEI"]);

/** Resolved XUI variant for a panel row (null/empty = SANAEI default). */
export function resolveXuiVariant(panel: Pick<Panel, "apiVariant">): string {
  const raw = panel.apiVariant?.trim().toUpperCase() ?? "";
  return raw === "" ? "SANAEI" : raw;
}

/** XUI authentication modes this codebase implements and tests. */
export const SUPPORTED_XUI_AUTH_MODES = new Set(["SESSION_COOKIE", "API_TOKEN"]);

/** Resolved XUI auth mode for a panel row (null/empty = SESSION_COOKIE). */
export function resolveXuiAuthMode(panel: Pick<Panel, "authMode">): string {
  const raw = panel.authMode?.trim().toUpperCase() ?? "";
  return raw === "" ? "SESSION_COOKIE" : raw;
}

/** The capabilities this panel's adapter implements. */
export function panelCapabilities(panel: Pick<Panel, "type" | "apiVariant">): readonly PanelCapability[] {
  if (panel.type === "MARZBAN") {
    return MARZBAN_CAPABILITIES;
  }
  return SUPPORTED_XUI_VARIANTS.has(resolveXuiVariant(panel)) ? XUI_CAPABILITIES : [];
}

/** Prisma PanelType values whose adapters implement the capability. */
export function panelTypesSupporting(capability: PanelCapability): Panel["type"][] {
  const types: Panel["type"][] = [];
  if (MARZBAN_CAPABILITIES.includes(capability)) {
    types.push("MARZBAN");
  }
  if (XUI_CAPABILITIES.includes(capability)) {
    types.push("XUI");
  }
  return types;
}

/** true when the panel's adapter implements (and this repo tested) the operation. */
export function panelSupportsOperation(
  panel: Pick<Panel, "type" | "apiVariant">,
  capability: PanelCapability,
): boolean {
  return panelCapabilities(panel).includes(capability);
}

/** true when the panel row carries the credentials its auth mode needs. */
export function panelHasCredentials(
  panel: Pick<Panel, "type" | "authMode" | "tokenEncrypted" | "username" | "passwordEncrypted">,
): boolean {
  if (panel.type === "XUI" && resolveXuiAuthMode(panel) === "API_TOKEN") {
    return panel.tokenEncrypted !== null && panel.tokenEncrypted !== "";
  }
  return panel.username !== null && panel.passwordEncrypted !== null;
}

/**
 * Pre-payment gate for operations on EXISTING services (renewal, extras,
 * toggle, regenerate, sync): the panel type/variant must implement the
 * operation and the login credentials must be present.
 *
 * Unlike sellability this does NOT require provisioning config (template or
 * inbounds) — mutating an existing account never provisions a new one. The
 * distinction matters commercially: a panel that can no longer sell new
 * services must still be able to renew the ones people already bought.
 */
export function panelOperationAvailable(
  panel: Pick<
    Panel,
    "status" | "type" | "apiVariant" | "authMode" | "tokenEncrypted" | "username" | "passwordEncrypted"
  >,
  capability: PanelCapability,
): boolean {
  return (
    panel.status === PanelStatus.ACTIVE &&
    panelSupportsOperation(panel, capability) &&
    panelHasCredentials(panel)
  );
}

/**
 * Remote model of an XUI service. Lifecycle mutations run ONLY against
 * GLOBAL_CLIENT services; legacy per-inbound services (created before the
 * global-client migration) stay readable but are never mutated through the
 * global-client endpoints and are never silently migrated.
 */
export type XuiRemoteModel = "GLOBAL_CLIENT" | "LEGACY_PER_INBOUND" | "UNKNOWN";

type ServiceRemoteShape = Pick<Service, "panelType" | "username" | "remoteMetadata">;

/**
 * Classifies an XUI service's remote model from its stored identifiers.
 *
 * GLOBAL_CLIENT: the remote metadata names ONE client whose email is the
 * service username exactly. LEGACY_PER_INBOUND: per-inbound client labels
 * (`username-<inboundId>`). Anything unprovable is UNKNOWN and treated like
 * legacy — mutations blocked, never guessed. Guessing here would mean issuing
 * a global-client write against an account that is not one, which on a shared
 * panel can affect a different customer's client.
 */
export function classifyXuiRemoteModel(service: ServiceRemoteShape): XuiRemoteModel {
  if (service.panelType !== "XUI") {
    return "GLOBAL_CLIENT";
  }
  const metadata = service.remoteMetadata;
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return "UNKNOWN";
  }
  const record = metadata as { email?: unknown; clients?: unknown };
  if (typeof record.email === "string") {
    return record.email === service.username ? "GLOBAL_CLIENT" : "UNKNOWN";
  }
  if (Array.isArray(record.clients) && record.clients.length > 0) {
    const emails = record.clients
      .map((c) =>
        typeof c === "object" && c !== null ? (c as { email?: unknown }).email : undefined,
      )
      .filter((e): e is string => typeof e === "string");
    if (emails.length === 0) {
      return "UNKNOWN";
    }
    if (emails.every((e) => e === service.username)) {
      return "GLOBAL_CLIENT";
    }
    if (emails.some((e) => e.startsWith(`${service.username}-`))) {
      return "LEGACY_PER_INBOUND";
    }
    return "UNKNOWN";
  }
  return "UNKNOWN";
}

/** true when lifecycle mutations may target this service's remote model. */
export function serviceSupportsGlobalLifecycle(service: ServiceRemoteShape): boolean {
  return service.panelType !== "XUI" || classifyXuiRemoteModel(service) === "GLOBAL_CLIENT";
}
