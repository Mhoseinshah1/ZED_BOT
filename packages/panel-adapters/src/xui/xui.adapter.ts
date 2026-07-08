import type { PanelAdapter } from "../core/panel-adapter.interface.js";
import { XuiClient } from "./xui.client.js";

/**
 * XUI / Sanaei panel adapter. Phase 1 placeholder - real behaviour (create
 * user, usage, revoke, ...) is implemented in a later phase.
 */
export class XuiAdapter implements PanelAdapter {
  readonly name = "xui" as const;

  constructor(readonly client: XuiClient) {}
}
