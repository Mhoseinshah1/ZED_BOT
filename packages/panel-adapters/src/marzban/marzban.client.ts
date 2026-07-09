import { PANEL_HTTP_TIMEOUT_MS, safeErrorText } from "../core/http.js";
import type { MarzbanCredentials, PanelHealthResult } from "../core/panel.types.js";
import type {
  MarzbanCreateUserPayload,
  MarzbanTokenResult,
  MarzbanUser,
  MarzbanUserResult,
} from "./marzban.types.js";

/**
 * Low-level HTTP client for the Marzban API.
 *
 * Phase 9 surface (documented endpoints only):
 *   - POST /api/admin/token          (authentication)
 *   - GET  /api/user/{username}      (read one user - used for templates)
 *   - POST /api/user                 (create user)
 *
 * Credentials/tokens travel only in requests to the configured baseUrl and
 * never appear in errors, logs or results.
 */
export class MarzbanClient {
  constructor(readonly credentials: MarzbanCredentials) {}

  /** Admin authentication returning the bearer token. */
  async getToken(): Promise<MarzbanTokenResult> {
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
        return { ok: false, message: `Panel responded with HTTP ${response.status}.` };
      }
      const data = (await response.json()) as { access_token?: unknown };
      if (typeof data.access_token === "string" && data.access_token.length > 0) {
        return { ok: true, token: data.access_token, message: "Authentication succeeded." };
      }
      return { ok: false, message: "Unexpected response: no access token returned." };
    } catch (err) {
      return { ok: false, message: `Panel is not reachable: ${safeErrorText(err)}` };
    }
  }

  /**
   * Attempts admin authentication (Phase 4 testConnection surface).
   * Never returns the token.
   */
  async authenticate(): Promise<PanelHealthResult> {
    const result = await this.getToken();
    return { ok: result.ok, message: result.message };
  }

  /** GET /api/user/{username}. 404 comes back as ok=false with status 404. */
  async getUser(token: string, username: string): Promise<MarzbanUserResult> {
    const url = `${this.credentials.baseUrl}/api/user/${encodeURIComponent(username)}`;
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(PANEL_HTTP_TIMEOUT_MS),
      });
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          message: `Panel responded with HTTP ${response.status}.`,
        };
      }
      const user = (await response.json()) as MarzbanUser;
      return { ok: true, user, status: response.status, message: "OK" };
    } catch (err) {
      return { ok: false, message: `Panel is not reachable: ${safeErrorText(err)}` };
    }
  }

  /** POST /api/user. A 409 (username exists) is reported with status 409, never thrown. */
  async createUser(token: string, payload: MarzbanCreateUserPayload): Promise<MarzbanUserResult> {
    const url = `${this.credentials.baseUrl}/api/user`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(PANEL_HTTP_TIMEOUT_MS),
      });
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          message: `Panel responded with HTTP ${response.status}.`,
        };
      }
      const user = (await response.json()) as MarzbanUser;
      return { ok: true, user, status: response.status, message: "OK" };
    } catch (err) {
      return { ok: false, message: `Panel is not reachable: ${safeErrorText(err)}` };
    }
  }
}
