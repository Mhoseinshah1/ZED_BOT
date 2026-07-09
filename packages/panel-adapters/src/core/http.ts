/** Default timeout for panel HTTP calls. */
export const PANEL_HTTP_TIMEOUT_MS = 10_000;

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
