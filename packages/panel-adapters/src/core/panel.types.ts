// Shared types for VPN panel integrations.

export type PanelType = "marzban" | "xui";

/** Connection settings every panel needs. */
export interface PanelCredentials {
  /** Panel base URL, e.g. https://panel.example.com:8443 */
  baseUrl: string;
  username: string;
  password: string;
}

/** Marzban connects with username + password (token flow). */
export interface MarzbanCredentials {
  baseUrl: string;
  username: string;
  password: string;
}

/** XUI / Sanaei / 3X-UI connects with an API token. */
export interface XuiCredentials {
  baseUrl: string;
  token: string;
}

/** Result of a panel connectivity/authentication test. */
export interface PanelHealthResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}
