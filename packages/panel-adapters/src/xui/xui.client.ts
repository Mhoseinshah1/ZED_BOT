import {
  extractSafeDetail,
  isTimeoutError,
  normalizeBaseUrl,
  panelHttpTimeoutMs,
  readJsonSafely,
  safeErrorText,
} from "../core/http.js";
import type { XuiCredentials } from "../core/panel.types.js";
import type { XuiApiEnvelope, XuiLoginResult, XuiRequestResult } from "./xui.types.js";

/**
 * Low-level HTTP client for the Sanaei 3X-UI API family (SANAEI variant).
 *
 * Endpoints (relative to the configured base URL, which may carry a secret
 * web base path such as https://host:port/secretpath):
 *   - POST {base}/login                                      (form-encoded)
 *   - GET  {base}/panel/api/inbounds/list
 *   - POST {base}/panel/api/inbounds/addClient               (JSON)
 *   - POST {base}/panel/api/inbounds/{id}/delClient/{clientId}
 *
 * Authentication is a session cookie set by /login - there is no permanent
 * bearer token. The cookie lives only in memory for the duration of one
 * adapter operation and is NEVER logged, returned in messages or persisted.
 * 3x-ui reports login failures as HTTP 200 with {"success": false}, so the
 * envelope - not the status code - decides success.
 */
export class XuiClient {
  /** Normalized base URL: trailing slashes removed, path prefix preserved. */
  readonly baseUrl: string;

  constructor(readonly credentials: XuiCredentials) {
    // The web base path is part of the deployment contract - only trailing
    // slashes are stripped, no path segments are added or removed.
    this.baseUrl = normalizeBaseUrl(credentials.baseUrl);
  }

  /**
   * POST {base}/login with form-encoded credentials. Success = HTTP 2xx AND
   * envelope.success === true AND at least one session cookie was set.
   */
  async login(): Promise<XuiLoginResult> {
    const url = `${this.baseUrl}/login`;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          username: this.credentials.username,
          password: this.credentials.password,
        }),
        redirect: "manual",
        signal: AbortSignal.timeout(panelHttpTimeoutMs()),
      });
      if (response.status === 404) {
        return {
          ok: false,
          status: 404,
          message: "Login endpoint not found - wrong base path or unsupported panel variant.",
        };
      }
      if (!response.ok) {
        return { ok: false, status: response.status, message: `Panel responded with HTTP ${response.status}.` };
      }
      const parsed = await readJsonSafely(response);
      if (!parsed.ok) {
        return {
          ok: false,
          status: response.status,
          malformedBody: true,
          message: "Login endpoint returned a non-JSON response - unsupported panel variant.",
        };
      }
      const envelope = parsed.data as XuiApiEnvelope;
      if (envelope.success !== true) {
        const detail = extractSafeDetail(parsed.data);
        return {
          ok: false,
          status: response.status,
          message: `Authentication failed${detail === undefined ? "" : `: ${detail}`}.`,
        };
      }
      const cookie = extractCookieHeader(response);
      if (cookie === undefined) {
        return {
          ok: false,
          status: response.status,
          message: "Login succeeded but no session cookie was set - unsupported panel variant.",
        };
      }
      return { ok: true, cookie, status: response.status, message: "Authentication succeeded." };
    } catch (err) {
      return {
        ok: false,
        timedOut: isTimeoutError(err),
        transportError: true,
        message: `Panel is not reachable: ${safeErrorText(err)}`,
      };
    }
  }

  /**
   * Authenticated request runner. 3x-ui answers unauthenticated API calls
   * with a redirect to the login page (or an HTML body), both of which are
   * reported structurally - never thrown, never logged with the cookie.
   */
  private async request(
    cookie: string,
    method: "GET" | "POST",
    path: string,
    jsonBody?: unknown,
  ): Promise<XuiRequestResult> {
    const url = `${this.baseUrl}${path}`;
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Cookie: cookie,
          Accept: "application/json",
          ...(jsonBody !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(jsonBody !== undefined ? { body: JSON.stringify(jsonBody) } : {}),
        redirect: "manual",
        signal: AbortSignal.timeout(panelHttpTimeoutMs()),
      });
      if (response.status >= 300 && response.status < 400) {
        return {
          ok: false,
          status: response.status,
          message: "Panel redirected the API request - session expired or wrong base path.",
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
        return {
          ok: false,
          status: response.status,
          malformedBody: true,
          message: "Panel returned a non-JSON response - unsupported panel variant.",
        };
      }
      const envelope = parsed.data as XuiApiEnvelope;
      if (envelope.success !== true) {
        const detail = extractSafeDetail(parsed.data);
        return {
          ok: false,
          status: response.status,
          envelope,
          message: `Panel rejected the request${detail === undefined ? "" : `: ${detail}`}.`,
        };
      }
      return { ok: true, status: response.status, envelope, message: "OK" };
    } catch (err) {
      return {
        ok: false,
        timedOut: isTimeoutError(err),
        transportError: true,
        message: `Panel is not reachable: ${safeErrorText(err)}`,
      };
    }
  }

  /** GET {base}/panel/api/inbounds/list - all inbounds with clients + stats. */
  async listInbounds(cookie: string): Promise<XuiRequestResult> {
    return this.request(cookie, "GET", "/panel/api/inbounds/list");
  }

  /**
   * POST {base}/panel/api/inbounds/addClient. The 3x-ui contract wraps the
   * client list in a JSON STRING inside the JSON body:
   *   { "id": <inboundId>, "settings": "{\"clients\": [ {...} ]}" }
   */
  async addClient(
    cookie: string,
    inboundId: number,
    client: Record<string, unknown>,
  ): Promise<XuiRequestResult> {
    return this.request(cookie, "POST", "/panel/api/inbounds/addClient", {
      id: inboundId,
      settings: JSON.stringify({ clients: [client] }),
    });
  }

  /**
   * POST {base}/panel/api/inbounds/{id}/delClient/{clientId}. The clientId
   * is the client's UUID for VLESS/VMess and the password for Trojan
   * (3x-ui addresses clients by their credential identifier).
   */
  async deleteClient(
    cookie: string,
    inboundId: number,
    clientId: string,
  ): Promise<XuiRequestResult> {
    return this.request(
      cookie,
      "POST",
      `/panel/api/inbounds/${encodeURIComponent(String(inboundId))}/delClient/${encodeURIComponent(clientId)}`,
    );
  }
}

/**
 * Builds a Cookie header value from the response's Set-Cookie headers.
 * Only the name=value pairs are kept; attributes are dropped. Returns
 * undefined when no cookie with a non-empty value was set.
 */
function extractCookieHeader(response: Response): string | undefined {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies: string[] =
    typeof headers.getSetCookie === "function"
      ? headers.getSetCookie()
      : response.headers.get("set-cookie") !== null
        ? [response.headers.get("set-cookie") as string]
        : [];
  const pairs: string[] = [];
  for (const raw of setCookies) {
    const pair = raw.split(";", 1)[0]?.trim() ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.length > eq + 1) {
      pairs.push(pair);
    }
  }
  return pairs.length > 0 ? pairs.join("; ") : undefined;
}
