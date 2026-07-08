import type { PanelAdapter } from "../core/panel-adapter.interface.js";
import { MarzbanClient } from "./marzban.client.js";

/**
 * Marzban panel adapter. Phase 1 placeholder - real behaviour (create user,
 * usage, revoke, ...) is implemented in a later phase.
 */
export class MarzbanAdapter implements PanelAdapter {
  readonly name = "marzban" as const;

  constructor(readonly client: MarzbanClient) {}
}
