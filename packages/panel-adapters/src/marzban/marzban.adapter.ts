import type { PanelAdapter } from "../core/panel-adapter.interface.js";
import type { PanelHealthResult } from "../core/panel.types.js";
import { MarzbanClient } from "./marzban.client.js";

/**
 * Marzban panel adapter. Phase 4 surface: connection testing via the token
 * endpoint. Provisioning (create user, usage, revoke, ...) comes later.
 */
export class MarzbanAdapter implements PanelAdapter {
  readonly name = "marzban" as const;

  constructor(readonly client: MarzbanClient) {}

  async testConnection(): Promise<PanelHealthResult> {
    return this.client.authenticate();
  }
}
