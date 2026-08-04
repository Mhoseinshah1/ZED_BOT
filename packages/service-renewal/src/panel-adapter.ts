import type { Panel } from "@zedbot/database";
import {
  MarzbanAdapter,
  MarzbanClient,
  XuiAdapter,
  XuiClient,
  type PanelAdapter,
} from "@zedbot/panel-adapters";
import { decryptSecret } from "@zedbot/shared";

import {
  resolveXuiAuthMode,
  resolveXuiVariant,
  SUPPORTED_XUI_AUTH_MODES,
  SUPPORTED_XUI_VARIANTS,
} from "./panel-capability.js";

// =============================================================================
// Panel-adapter construction — the ONE place credentials are decrypted.
//
// WHY IT MOVED. Both the bot and the Mini App API need to reach a panel: the bot
// to provision and sync, the API because a new subscription's username has to be
// checked against the panel before it can be reserved. The bot's copy imports
// nothing an app owns, so an API-side copy would have been a second place where
// stored secrets are decrypted — and two of those is one more than should exist.
//
// CREDENTIALS LIVE ONLY INSIDE THE ADAPTER INSTANCE. They are decrypted here,
// handed to the client, and never logged, never returned and never attached to
// an error. Nothing above this layer is given a way to read them, which is why
// route code is handed an operation result rather than an adapter.
//
// `apps/bot/src/services/panel-adapter-factory.ts` re-exports every symbol, so
// every existing bot call site is unchanged.
// =============================================================================

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
