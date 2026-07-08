// Shared types for VPN panel integrations. Phase 1 placeholder - the real
// shapes (users, inbounds, usage, subscription links, ...) are defined when
// the adapters are implemented.

export type PanelType = "marzban" | "xui";

/** Connection settings every panel needs. */
export interface PanelCredentials {
  /** Panel base URL, e.g. https://panel.example.com:8443 */
  baseUrl: string;
  username: string;
  password: string;
}
