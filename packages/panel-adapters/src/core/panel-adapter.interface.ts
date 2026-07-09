import type { PanelHealthResult, PanelType } from "./panel.types.js";

/**
 * Contract every VPN panel integration (Marzban, XUI/Sanaei, ...) implements.
 * Phase 4 surface: connectivity testing only. Provisioning methods (create
 * user, usage, revoke, renew, ...) are added in later phases.
 */
export interface PanelAdapter {
  /** Unique adapter identifier. */
  readonly name: PanelType;

  /**
   * Verifies the panel is reachable and (when implemented) that the stored
   * credentials authenticate. Never throws - failures come back as
   * { ok: false }. Never include credentials in the result.
   */
  testConnection(): Promise<PanelHealthResult>;
}
