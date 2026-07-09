import type { PanelAdapter } from "../core/panel-adapter.interface.js";
import type { PanelHealthResult } from "../core/panel.types.js";
import { XuiClient } from "./xui.client.js";

/**
 * XUI / Sanaei panel adapter. Phase 4 surface: reachability probe only -
 * the result is never ok=true until the real authenticated check lands in a
 * later phase (no fake successes).
 */
export class XuiAdapter implements PanelAdapter {
  readonly name = "xui" as const;

  constructor(readonly client: XuiClient) {}

  async testConnection(): Promise<PanelHealthResult> {
    return this.client.probeReachability();
  }
}
