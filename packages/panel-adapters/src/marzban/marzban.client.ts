import { PANEL_HTTP_TIMEOUT_MS, safeErrorText } from "../core/http.js";
import type { MarzbanCredentials, PanelHealthResult } from "../core/panel.types.js";

/**
 * Low-level HTTP client for the Marzban API.
 *
 * Phase 4 surface: authentication test only (POST /api/admin/token).
 * User provisioning endpoints are implemented in later phases based on the
 * Marzban API reference.
 */
export class MarzbanClient {
  constructor(readonly credentials: MarzbanCredentials) {}

  /**
   * Attempts admin authentication. Credentials travel only in the request
   * body over the configured baseUrl - they never appear in errors, logs or
   * the returned result.
   */
  async authenticate(): Promise<PanelHealthResult> {
    const url = `${this.credentials.baseUrl}/api/admin/token`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          username: this.credentials.username,
          password: this.credentials.password,
        }),
        signal: AbortSignal.timeout(PANEL_HTTP_TIMEOUT_MS),
      });

      if (response.status === 401) {
        return { ok: false, message: "Authentication failed (401): wrong username or password." };
      }
      if (!response.ok) {
        return {
          ok: false,
          message: `Panel responded with HTTP ${response.status}.`,
          details: { status: response.status },
        };
      }
      const data = (await response.json()) as { access_token?: unknown };
      if (typeof data.access_token === "string" && data.access_token.length > 0) {
        return { ok: true, message: "Authentication succeeded.", details: { status: 200 } };
      }
      return { ok: false, message: "Unexpected response: no access token returned." };
    } catch (err) {
      return { ok: false, message: `Panel is not reachable: ${safeErrorText(err)}` };
    }
  }
}
