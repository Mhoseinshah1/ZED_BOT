export interface UrlNormalizationResult {
  ok: boolean;
  value?: string;
  error?: string;
}

/**
 * Validates and normalizes a panel base URL:
 *   - must start with http:// or https://
 *   - trailing slashes removed, query/hash stripped
 *   - /dashboard paths rejected (panel UI path, not the API base)
 *   - explicit :443 removed (https default); other ports kept
 */
export function normalizePanelBaseUrl(raw: string): UrlNormalizationResult {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return { ok: false, error: "آدرس باید با http:// یا https:// شروع شود." };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "آدرس وارد شده معتبر نیست." };
  }
  if (url.hostname === "") {
    return { ok: false, error: "آدرس وارد شده معتبر نیست." };
  }
  const path = url.pathname.replace(/\/+$/, "");
  if (/(^|\/)dashboard(\/|$)/i.test(path)) {
    return { ok: false, error: "آدرس نباید شامل /dashboard باشد. آدرس پایه پنل را وارد کنید." };
  }
  const protocol = url.protocol.toLowerCase();
  let port = url.port;
  if (port === "443") {
    port = "";
  }
  const host = port === "" ? url.hostname : `${url.hostname}:${port}`;
  const normalized = `${protocol}//${host}${path}`;
  return { ok: true, value: normalized };
}
