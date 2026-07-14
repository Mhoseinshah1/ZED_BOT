/** Default timeout for payment provider HTTP calls. */
export const PAYMENT_HTTP_TIMEOUT_MS = 10_000;

/**
 * Effective payment HTTP timeout: PAYMENT_HTTP_TIMEOUT_MS env override
 * (positive integer, primarily for tests) or the 10s default. Read at call
 * time so tests can change it without rebuilding gateway instances.
 */
export function paymentHttpTimeoutMs(): number {
  const raw = Number(process.env.PAYMENT_HTTP_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : PAYMENT_HTTP_TIMEOUT_MS;
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
 * Reads a response body as JSON without throwing. Providers behind proxies
 * routinely answer errors with HTML/plain text - a parse failure must surface
 * as "malformed response", never as a crash or a bogus success.
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
