/**
 * Contract every VPN panel integration (3x-ui, Marzban, Hiddify, ...) will
 * implement. Placeholder for now - the method surface (create user, get
 * usage, revoke, ...) lands with the first concrete adapter.
 */
export interface PanelAdapter {
  /** Unique adapter identifier, e.g. "marzban". */
  readonly name: string;
}
