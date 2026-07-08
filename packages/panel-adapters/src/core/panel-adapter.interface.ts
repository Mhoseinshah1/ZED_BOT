import type { PanelType } from "./panel.types.js";

/**
 * Contract every VPN panel integration (Marzban, XUI/Sanaei, ...) will
 * implement. Phase 1 placeholder - the method surface (create user, get
 * usage, revoke, renew, ...) is added when the first adapter is implemented.
 */
export interface PanelAdapter {
  /** Unique adapter identifier. */
  readonly name: PanelType;
}
