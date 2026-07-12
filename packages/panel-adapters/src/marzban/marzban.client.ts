import {
  extractSafeDetail,
  isTimeoutError,
  normalizeBaseUrl,
  panelHttpTimeoutMs,
  readJsonSafely,
  safeErrorText,
} from "../core/http.js";
import type { MarzbanCredentials, PanelHealthResult } from "../core/panel.types.js";
import type {
  MarzbanCreateUserPayload,
  MarzbanTokenResult,
  MarzbanUser,
  MarzbanUserResult,
} from "./marzban.types.js";

/**
 * Low-level HTTP client for the Marzban API (current Marzban deployments and
 * RickPanelAPI-compatible variants exposing the same documented contract).
 *
 * Documented endpoints only:
 *   - POST /api/admin/token                  (authentication, form-encoded)
 *   - GET  /api/user/{username}              (read one user - templates/sync)
 *   - POST /api/user                         (create user)
 *   - PUT  /api/user/{username}              (modify user)
 *   - POST /api/user/{username}/reset        (reset data usage)
 *   - POST /api/user/{username}/revoke_sub   (revoke subscription)
 *
 * The base URL is normalized once (trailing slashes removed, a trailing
 * "/api" stripped so pasted API roots don't become "/api/api/...").
 * Credentials/tokens travel only in requests to the configured baseUrl and
 * never appear in errors, logs or results. Error bodies are parsed safely -
 * non-JSON answers surface as a sanitized message, never as an exception.
 */
export class MarzbanClient {
  /** Normalized base URL (no trailing slash, no trailing /api). */
  readonly baseUrl: string;

  constructor(readonly credentials: MarzbanCredentials) {
    this.baseUrl = normalizeBaseUrl(credentials.baseUrl, { stripApiSuffix: true });
  }

  /**
   * Admin authentication returning the bearer token. Marzban's documented
   * token endpoint takes an OAuth2 password grant as
   * application/x-www-form-urlencoded - JSON bodies are rejected by stock
   * deployments, so the form encoding here is contract, not preference.
   */
  async getToken(): Promise<MarzbanTokenResult> {
    const url = `${this.baseUrl}/api/admin/token`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "password",
          username: this.credentials.username,
          password: this.credentials.password,
        }),
        signal: AbortSignal.timeout(panelHttpTimeoutMs()),
      });
      if (response.status === 401 || response.status === 403) {
        return {
          ok: false,
          status: response.status,
          message: `Authentication failed (${response.status}): wrong username or password.`,
        };
      }
      const parsed = await readJsonSafely(response);
      if (!response.ok) {
        const detail = parsed.ok ? extractSafeDetail(parsed.data) : undefined;
        return {
          ok: false,
          status: response.status,
          message: `Panel responded with HTTP ${response.status}${detail === undefined ? "" : `: ${detail}`}.`,
        };
      }
      if (!parsed.ok) {
        return { ok: false, status: response.status, message: "Panel returned a non-JSON response." };
      }
      const data = parsed.data as { access_token?: unknown };
      if (typeof data.access_token === "string" && data.access_token.length > 0) {
        return { ok: true, token: data.access_token, message: "Authentication succeeded." };
      }
      return { ok: false, status: response.status, message: "Unexpected response: no access token returned." };
    } catch (err) {
      return {
        ok: false,
        timedOut: isTimeoutError(err),
        message: `Panel is not reachable: ${safeErrorText(err)}`,
      };
    }
  }

  /**
   * Attempts admin authentication (testConnection surface).
   * Never returns the token.
   */
  async authenticate(): Promise<PanelHealthResult> {
    const result = await this.getToken();
    return { ok: result.ok, message: result.message };
  }

  /**
   * Shared request runner for the authenticated JSON endpoints. Transport
   * errors and timeouts are reported structurally (timedOut/transportError)
   * so the adapter can distinguish "the panel rejected it" from "the request
   * may or may not have landed".
   */
  private async requestUser(
    method: "GET" | "POST" | "PUT",
    path: string,
    token: string,
    payload?: unknown,
  ): Promise<MarzbanUserResult> {
    const url = `${this.baseUrl}${path}`;
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
        signal: AbortSignal.timeout(panelHttpTimeoutMs()),
      });
      const parsed = await readJsonSafely(response);
      if (!response.ok) {
        const detail = parsed.ok ? extractSafeDetail(parsed.data) : undefined;
        return {
          ok: false,
          status: response.status,
          message: `Panel responded with HTTP ${response.status}${detail === undefined ? "" : `: ${detail}`}.`,
        };
      }
      if (!parsed.ok) {
        return {
          ok: false,
          status: response.status,
          malformedBody: true,
          message: "Panel returned a non-JSON response.",
        };
      }
      return { ok: true, user: parsed.data as MarzbanUser, status: response.status, message: "OK" };
    } catch (err) {
      return {
        ok: false,
        timedOut: isTimeoutError(err),
        transportError: true,
        message: `Panel is not reachable: ${safeErrorText(err)}`,
      };
    }
  }

  /** GET /api/user/{username}. 404 comes back as ok=false with status 404. */
  async getUser(token: string, username: string): Promise<MarzbanUserResult> {
    return this.requestUser("GET", `/api/user/${encodeURIComponent(username)}`, token);
  }

  /** POST /api/user. A 409 (username exists) is reported with status 409, never thrown. */
  async createUser(token: string, payload: MarzbanCreateUserPayload): Promise<MarzbanUserResult> {
    return this.requestUser("POST", "/api/user", token, payload);
  }

  /** PUT /api/user/{username} - modify an existing user (never the username). */
  async modifyUser(
    token: string,
    username: string,
    payload: Partial<MarzbanCreateUserPayload>,
  ): Promise<MarzbanUserResult> {
    return this.requestUser("PUT", `/api/user/${encodeURIComponent(username)}`, token, payload);
  }

  /**
   * POST /api/user/{username}/revoke_sub - revokes the user's subscription
   * (subscription link and proxies get fresh tokens; the old link stops
   * working). Returns the updated user with the NEW subscription_url/links.
   * Never changes username, quota, expiry or usage.
   */
  async revokeUserSubscription(token: string, username: string): Promise<MarzbanUserResult> {
    return this.requestUser(
      "POST",
      `/api/user/${encodeURIComponent(username)}/revoke_sub`,
      token,
    );
  }

  /** POST /api/user/{username}/reset - reset the user's data usage to zero. */
  async resetUserUsage(token: string, username: string): Promise<MarzbanUserResult> {
    return this.requestUser("POST", `/api/user/${encodeURIComponent(username)}/reset`, token);
  }

  /**
   * DELETE /api/user/{username}. Used ONLY by opt-in staging-test cleanup -
   * no production pipeline deletes panel accounts.
   */
  async deleteUser(
    token: string,
    username: string,
  ): Promise<{ ok: boolean; status?: number; message: string }> {
    const url = `${this.baseUrl}/api/user/${encodeURIComponent(username)}`;
    try {
      const response = await fetch(url, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(panelHttpTimeoutMs()),
      });
      if (!response.ok) {
        return { ok: false, status: response.status, message: `Panel responded with HTTP ${response.status}.` };
      }
      return { ok: true, status: response.status, message: "OK" };
    } catch (err) {
      return { ok: false, message: `Panel is not reachable: ${safeErrorText(err)}` };
    }
  }
}
