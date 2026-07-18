import type { Panel } from "@zedbot/database";
import {
  MarzbanAdapter,
  MarzbanClient,
  XuiAdapter,
  XuiClient,
  type PanelAdapter,
} from "@zedbot/panel-adapters";
import { decryptSecret } from "@zedbot/shared";

// =============================================================================
// Worker-side panel-adapter construction (notification/retention engine).
//
// A deliberate, minimal re-implementation of the bot's panel-adapter-factory:
// the worker never imports bot code, but it must build the SAME adapter from
// the SAME encrypted Panel fields. Credentials are decrypted ONLY here, live
// only inside the adapter instance, and are never logged or returned.
//
// decryptSecret reads APP_SECRET from process.env internally (see
// @zedbot/shared crypto.ts), so no extra worker config getter is required.
// =============================================================================

/** Raised when a Panel row cannot produce a usable adapter (incomplete/unsupported config). */
export class WorkerAdapterConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerAdapterConfigError";
  }
}

/** XUI API variants this codebase implements and tests (null/empty = SANAEI). */
const SUPPORTED_XUI_VARIANTS = new Set(["SANAEI"]);

/** XUI authentication modes this codebase implements and tests. */
const SUPPORTED_XUI_AUTH_MODES = new Set(["SESSION_COOKIE", "API_TOKEN"]);

/** Resolved XUI variant for a panel row (null/empty = SANAEI default). */
function resolveXuiVariant(panel: Panel): string {
  const raw = panel.apiVariant?.trim().toUpperCase() ?? "";
  return raw === "" ? "SANAEI" : raw;
}

/** Resolved XUI auth mode for a panel row (null/empty = SESSION_COOKIE). */
function resolveXuiAuthMode(panel: Panel): string {
  const raw = panel.authMode?.trim().toUpperCase() ?? "";
  return raw === "" ? "SESSION_COOKIE" : raw;
}

/** Panel subscriptionDomain normalized to an absolute base URL (or null). */
export function normalizeWorkerSubscriptionBase(panel: Panel): string | null {
  const domain = panel.subscriptionDomain?.trim() ?? "";
  if (domain === "") {
    return null;
  }
  return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
}

/**
 * Decrypts credentials and builds the panel adapter for a Panel row.
 * Throws WorkerAdapterConfigError on missing/unsupported configuration - the
 * caller treats that as a panel-level failure and never disables the panel.
 */
export function buildWorkerAdapterForPanel(panel: Panel): PanelAdapter {
  if (panel.type === "MARZBAN") {
    if (panel.username === null || panel.passwordEncrypted === null) {
      throw new WorkerAdapterConfigError("Marzban credentials are incomplete.");
    }
    const password = decryptSecret(panel.passwordEncrypted);
    return new MarzbanAdapter(
      new MarzbanClient({ baseUrl: panel.baseUrl, username: panel.username, password }),
    );
  }

  // XUI (Sanaei 3X-UI family): SESSION_COOKIE (default) or API_TOKEN.
  const variant = resolveXuiVariant(panel);
  if (!SUPPORTED_XUI_VARIANTS.has(variant)) {
    throw new WorkerAdapterConfigError(`XUI API variant "${variant}" is not supported.`);
  }
  const authMode = resolveXuiAuthMode(panel);
  if (!SUPPORTED_XUI_AUTH_MODES.has(authMode)) {
    throw new WorkerAdapterConfigError(`XUI auth mode "${authMode}" is not supported.`);
  }
  if (authMode === "API_TOKEN") {
    if (panel.tokenEncrypted === null) {
      throw new WorkerAdapterConfigError("XUI API token is missing.");
    }
    const token = decryptSecret(panel.tokenEncrypted);
    return new XuiAdapter(
      new XuiClient({
        baseUrl: panel.baseUrl,
        authMode: "API_TOKEN",
        token,
        apiVariant: "SANAEI",
      }),
    );
  }
  if (panel.username === null || panel.passwordEncrypted === null) {
    throw new WorkerAdapterConfigError(
      "XUI credentials are incomplete (username/password required).",
    );
  }
  const password = decryptSecret(panel.passwordEncrypted);
  return new XuiAdapter(
    new XuiClient({
      baseUrl: panel.baseUrl,
      authMode: "SESSION_COOKIE",
      username: panel.username,
      password,
      apiVariant: "SANAEI",
    }),
  );
}
