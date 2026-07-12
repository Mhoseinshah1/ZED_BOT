/** Default timeout for panel HTTP calls. */
export const PANEL_HTTP_TIMEOUT_MS = 10_000;

/**
 * Effective panel HTTP timeout: PANEL_HTTP_TIMEOUT_MS env override (positive
 * integer, primarily for tests) or the 10s default.
 */
export function panelHttpTimeoutMs(): number {
  const raw = Number(process.env.PANEL_HTTP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : PANEL_HTTP_TIMEOUT_MS;
}

/** Formats an unknown error without ever including request bodies/headers. */
export function safeErrorText(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return "connection timed out";
    }
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause !== undefined && typeof cause.code === "string") {
      return cause.code;
    }
    return `${err.name}: ${err.message}`;
  }
  return String(err);
}

/** true when the error is a timeout/abort (distinct from connection refusal). */
export function isTimeoutError(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/**
 * Normalizes an operator-entered panel base URL:
 *   - trims whitespace
 *   - removes ALL trailing slashes (avoids "//api/..." paths behind strict
 *     reverse proxies)
 *   - with stripApiSuffix, removes one trailing "/api" segment - admins
 *     frequently paste the API root, which would otherwise produce
 *     "/api/api/..." and a misleading 404 on every request.
 * Never touches the scheme, host, port or any other path segment.
 */
export function normalizeBaseUrl(raw: string, opts?: { stripApiSuffix?: boolean }): string {
  let base = raw.trim().replace(/\/+$/, "");
  if (opts?.stripApiSuffix === true) {
    base = base.replace(/\/api$/i, "");
  }
  return base;
}

/**
 * Reads a response body as JSON without throwing. Panels behind reverse
 * proxies routinely answer errors with HTML/plain text - a parse failure must
 * surface as "malformed response", never as a bogus "not reachable".
 */
export async function readJsonSafely(
  response: Response,
): Promise<{ ok: true; data: unknown } | { ok: false }> {
  try {
    const text = await response.text();
    return { ok: true, data: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

const MAX_DETAIL_LENGTH = 200;

/**
 * Extracts a short, safe human-readable detail from a panel error body.
 * Handles the FastAPI shapes Marzban uses ({detail: string} and
 * {detail: [{msg, loc}]}) plus the {msg} field of XUI responses. The result
 * is length-capped; callers must never feed it credentials.
 */
export function extractSafeDetail(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) {
    return undefined;
  }
  const body = data as { detail?: unknown; msg?: unknown; message?: unknown };
  let detail: string | undefined;
  if (typeof body.detail === "string") {
    detail = body.detail;
  } else if (Array.isArray(body.detail)) {
    const parts: string[] = [];
    for (const item of body.detail) {
      if (typeof item === "object" && item !== null) {
        const entry = item as { msg?: unknown; loc?: unknown };
        const loc = Array.isArray(entry.loc) ? entry.loc.join(".") : "";
        if (typeof entry.msg === "string") {
          parts.push(loc === "" ? entry.msg : `${loc}: ${entry.msg}`);
        }
      }
    }
    detail = parts.length > 0 ? parts.join("; ") : undefined;
  } else if (typeof body.msg === "string") {
    detail = body.msg;
  } else if (typeof body.message === "string") {
    detail = body.message;
  }
  if (detail === undefined || detail.trim() === "") {
    return undefined;
  }
  return detail.trim().slice(0, MAX_DETAIL_LENGTH);
}

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * bigint -> number ONLY within JavaScript's safe integer range. Volumes
 * beyond 2^53-1 bytes (~8 EiB) would silently lose precision in a JSON
 * payload, so callers must fail validation instead of converting.
 */
export function bigintToSafeNumber(value: bigint): number | null {
  if (value < 0n || value > MAX_SAFE_BIGINT) {
    return null;
  }
  return Number(value);
}

/**
 * Absolutizes a panel-reported subscription URL against a base without ever
 * duplicating path segments:
 *   - absolute URLs pass through untouched
 *   - base "https://sub.host"            + "/sub/tok" -> https://sub.host/sub/tok
 *   - base "https://sub.host/sub"        + "/sub/tok" -> https://sub.host/sub/tok
 *   - base "https://host/prefix" (proxy) + "/sub/tok" -> https://host/prefix/sub/tok
 */
export function joinSubscriptionUrl(
  base: string,
  url: string | undefined | null,
): string | undefined {
  if (url === undefined || url === null || url === "") {
    return undefined;
  }
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  const relative = url.startsWith("/") ? url : `/${url}`;
  let origin = normalizeBaseUrl(base);
  let basePath = "";
  try {
    const parsed = new URL(origin);
    origin = parsed.origin;
    basePath = parsed.pathname.replace(/\/+$/, "");
    if (basePath === "/") {
      basePath = "";
    }
  } catch {
    // Unparseable base: fall back to plain concatenation on the cleaned base.
    return `${normalizeBaseUrl(base)}${relative}`;
  }
  if (basePath !== "" && (relative === basePath || relative.startsWith(`${basePath}/`))) {
    // The relative URL already carries the base's path prefix - don't repeat it.
    return `${origin}${relative}`;
  }
  return `${origin}${basePath}${relative}`;
}
