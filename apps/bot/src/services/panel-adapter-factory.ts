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
// Shared panel-adapter construction (used by provisioning + service sync).
// Credentials are decrypted ONLY here, live only inside the adapter instance
// and are never logged or returned.
// =============================================================================

/** XUI API variants this codebase implements and tests. null = SANAEI. */
export const SUPPORTED_XUI_VARIANTS = new Set(["SANAEI"]);

/** Resolved XUI variant for a panel row (null/empty = SANAEI default). */
export function resolveXuiVariant(panel: Panel): string {
  const raw = panel.apiVariant?.trim().toUpperCase() ?? "";
  return raw === "" ? "SANAEI" : raw;
}

/** XUI authentication modes this codebase implements and tests. */
export const SUPPORTED_XUI_AUTH_MODES = new Set(["SESSION_COOKIE", "API_TOKEN"]);

/** Resolved XUI auth mode for a panel row (null/empty = SESSION_COOKIE). */
export function resolveXuiAuthMode(panel: Panel): string {
  const raw = panel.authMode?.trim().toUpperCase() ?? "";
  return raw === "" ? "SESSION_COOKIE" : raw;
}

/** Decrypts credentials and builds the panel adapter. Throws on missing config. */
export function buildAdapterForPanel(panel: Panel): PanelAdapter {
  if (panel.type === "MARZBAN") {
    if (panel.username === null || panel.passwordEncrypted === null) {
      throw new Error("Marzban credentials are incomplete.");
    }
    const password = decryptSecret(panel.passwordEncrypted);
    return new MarzbanAdapter(
      new MarzbanClient({ baseUrl: panel.baseUrl, username: panel.username, password }),
    );
  }
  // XUI (Sanaei 3X-UI family), two explicit auth modes:
  //   SESSION_COOKIE (default) - username/password login, session cookie;
  //   API_TOKEN - pre-issued bearer token (tokenEncrypted), no /login call.
  const variant = resolveXuiVariant(panel);
  if (!SUPPORTED_XUI_VARIANTS.has(variant)) {
    throw new Error(`XUI API variant "${variant}" is not supported.`);
  }
  const authMode = resolveXuiAuthMode(panel);
  if (!SUPPORTED_XUI_AUTH_MODES.has(authMode)) {
    throw new Error(`XUI auth mode "${authMode}" is not supported.`);
  }
  if (authMode === "API_TOKEN") {
    if (panel.tokenEncrypted === null) {
      throw new Error("XUI API token is missing.");
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
    throw new Error("XUI credentials are incomplete (username/password required).");
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

/** Panel subscriptionDomain normalized to an absolute base URL (or null). */
export function normalizeSubscriptionBase(panel: Panel): string | null {
  const domain = panel.subscriptionDomain?.trim() ?? "";
  if (domain === "") {
    return null;
  }
  return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
}
