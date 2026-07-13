import {
  extractSafeDetail,
  isTimeoutError,
  normalizeBaseUrl,
  panelHttpTimeoutMs,
  readJsonSafely,
  safeErrorText,
} from "../core/http.js";
import type { XuiAuthMode, XuiCredentials } from "../core/panel.types.js";
import type {
  XuiApiEnvelope,
  XuiAuthContext,
  XuiAuthResult,
  XuiLoginResult,
  XuiRequestResult,
} from "./xui.types.js";

/**
 * Low-level HTTP client for the Sanaei 3X-UI API family (SANAEI variant).
 *
 * Endpoints (relative to the configured base URL, which may carry a secret
 * web base path such as https://host:port/secretpath), following the
 * GLOBAL client model pinned at MHSanaei/3x-ui commit
 * 4e928a1ce0945a6e956aa63365034ec24d2b1387:
 *   - POST {base}/login                                      (form-encoded)
 *   - GET  {base}/panel/api/inbounds/list                    (inbound validation)
 *   - GET  {base}/panel/api/clients/list
 *   - GET  {base}/panel/api/clients/get/{email}
 *   - POST {base}/panel/api/clients/add                      ({client, inboundIds})
 *   - POST {base}/panel/api/clients/del/{email}
 *   - GET  {base}/panel/api/clients/links/{email}
 * The legacy per-inbound client endpoints
 * (POST /panel/api/inbounds/addClient, .../delClient/...) were REMOVED
 * upstream and are no longer called.
 *
 * Two authentication modes (XuiAuthMode):
 *   - SESSION_COOKIE (default): form login on {base}/login; the session
 *     cookie authenticates subsequent requests. 3x-ui reports login
 *     failures as HTTP 200 with {"success": false}, so the envelope - not
 *     the status code - decides success.
 *   - API_TOKEN: no /login call at all; the pre-issued token is sent as
 *     `Authorization: Bearer` on every API request against the same
 *     SANAEI-shaped routes. Only this bearer convention is implemented -
 *     fork-specific token schemes are not guessed.
 *
 * Cookies and tokens live only in memory for the duration of one adapter
 * operation and are NEVER logged, returned in messages or persisted.
 */
export class XuiClient {
  /** Normalized base URL: trailing slashes removed, path prefix preserved. */
  readonly baseUrl: string;

  constructor(readonly credentials: XuiCredentials) {
    // The web base path is part of the deployment contract - only trailing
    // slashes are stripped, no path segments are added or removed.
    this.baseUrl = normalizeBaseUrl(credentials.baseUrl);
  }

  /** Effective authentication mode (default SESSION_COOKIE). */
  get authMode(): XuiAuthMode {
    return this.credentials.authMode ?? "SESSION_COOKIE";
  }

  /**
   * Establishes the authentication context for the configured mode.
   * SESSION_COOKIE performs the real login round-trip; API_TOKEN builds the
   * bearer context without any network call - the token is validated by the
   * first authenticated request (401/403/redirect = rejected token).
   * Missing credentials are a structural config error, never an exception.
   */
  async authenticate(): Promise<XuiAuthResult> {
    if (this.authMode === "API_TOKEN") {
      const token = this.credentials.token ?? "";
      if (token === "") {
        return {
          ok: false,
          configIncomplete: true,
          message: "XUI API token is not configured.",
        };
      }
      return { ok: true, auth: { kind: "token", token }, message: "Token context ready." };
    }
    if ((this.credentials.username ?? "") === "" || (this.credentials.password ?? "") === "") {
      return {
        ok: false,
        configIncomplete: true,
        message: "XUI username/password are not configured.",
      };
    }
    const login = await this.login();
    if (!login.ok || login.cookie === undefined) {
      return {
        ok: false,
        status: login.status,
        timedOut: login.timedOut,
        transportError: login.transportError,
        malformedBody: login.malformedBody,
        message: login.message,
      };
    }
    return {
      ok: true,
      auth: { kind: "cookie", cookie: login.cookie },
      status: login.status,
      message: login.message,
    };
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
          username: this.credentials.username ?? "",
          password: this.credentials.password ?? "",
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
    auth: XuiAuthContext,
    method: "GET" | "POST",
    path: string,
    jsonBody?: unknown,
  ): Promise<XuiRequestResult> {
    const url = `${this.baseUrl}${path}`;
    try {
      const response = await fetch(url, {
        method,
        headers: {
          ...(auth.kind === "cookie"
            ? { Cookie: auth.cookie }
            : { Authorization: `Bearer ${auth.token}` }),
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
          message: "Panel redirected the API request - session/token rejected or wrong base path.",
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

  /** GET {base}/panel/api/inbounds/list - inbound inventory (validation). */
  async listInbounds(auth: XuiAuthContext): Promise<XuiRequestResult> {
    return this.request(auth, "GET", "/panel/api/inbounds/list");
  }

  /**
   * GET {base}/panel/api/clients/list - every global client with its
   * attached inbound ids and traffic record. The complete inventory: the
   * read used for reconciliation and proof of absence.
   */
  async listClients(auth: XuiAuthContext): Promise<XuiRequestResult> {
    return this.request(auth, "GET", "/panel/api/clients/list");
  }

  /**
   * GET {base}/panel/api/clients/get/{email} - one client with inbound ids
   * and used traffic. Missing clients come back as success=false.
   */
  async getClient(auth: XuiAuthContext, email: string): Promise<XuiRequestResult> {
    return this.request(auth, "GET", `/panel/api/clients/get/${encodeURIComponent(email)}`);
  }

  /**
   * POST {base}/panel/api/clients/add - create ONE global client and attach
   * it to one or more inbounds in a single call:
   *   { "client": { ...universal fields... }, "inboundIds": [1, 4] }
   * Per-protocol secrets are generated server-side when omitted. Re-adding
   * an existing email with the SAME subId is idempotent (credentials are
   * reused, attachments deduplicated); a different subId is rejected.
   */
  async addClient(
    auth: XuiAuthContext,
    client: Record<string, unknown>,
    inboundIds: number[],
  ): Promise<XuiRequestResult> {
    return this.request(auth, "POST", "/panel/api/clients/add", {
      client,
      inboundIds,
    });
  }

  /**
   * POST {base}/panel/api/clients/del/{email} - delete the global client:
   * removes it from EVERY attached inbound and drops its traffic record.
   */
  async deleteClient(auth: XuiAuthContext, email: string): Promise<XuiRequestResult> {
    return this.request(auth, "POST", `/panel/api/clients/del/${encodeURIComponent(email)}`);
  }

  /**
   * GET {base}/panel/api/clients/links/{email} - every config URL for the
   * client across all attached inbounds (the panel's own link builder).
   */
  async getClientLinks(auth: XuiAuthContext, email: string): Promise<XuiRequestResult> {
    return this.request(auth, "GET", `/panel/api/clients/links/${encodeURIComponent(email)}`);
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
