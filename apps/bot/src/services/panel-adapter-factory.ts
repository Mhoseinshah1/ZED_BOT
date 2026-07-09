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
  if (panel.tokenEncrypted === null) {
    throw new Error("XUI token is missing.");
  }
  const token = decryptSecret(panel.tokenEncrypted);
  return new XuiAdapter(new XuiClient({ baseUrl: panel.baseUrl, token }));
}

/** Panel subscriptionDomain normalized to an absolute base URL (or null). */
export function normalizeSubscriptionBase(panel: Panel): string | null {
  const domain = panel.subscriptionDomain?.trim() ?? "";
  if (domain === "") {
    return null;
  }
  return /^https?:\/\//i.test(domain) ? domain : `https://${domain}`;
}
