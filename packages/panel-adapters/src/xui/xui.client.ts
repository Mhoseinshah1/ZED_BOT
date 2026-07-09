import { PANEL_HTTP_TIMEOUT_MS, safeErrorText } from "../core/http.js";
import type { PanelHealthResult, XuiCredentials } from "../core/panel.types.js";

/**
 * Low-level HTTP client for the XUI / Sanaei / 3X-UI API.
 *
 * Phase 4 surface: plain reachability probe only. The authenticated API
 * check and all provisioning endpoints are implemented in a later phase
 * based on the Sanaei API reference - this client never fakes a successful
 * authentication.
 */
export class XuiClient {
  constructor(readonly credentials: XuiCredentials) {}

  /** Probes the panel URL without sending the token anywhere yet. */
  async probeReachability(): Promise<PanelHealthResult> {
    try {
      const response = await fetch(this.credentials.baseUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(PANEL_HTTP_TIMEOUT_MS),
      });
      return {
        ok: false,
        message:
          `Panel URL is reachable (HTTP ${response.status}), but the authenticated ` +
          "XUI test is not implemented in this phase.",
        details: { status: response.status },
      };
    } catch (err) {
      return { ok: false, message: `Panel is not reachable: ${safeErrorText(err)}` };
    }
  }
}
