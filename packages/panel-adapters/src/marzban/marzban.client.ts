import type { PanelCredentials } from "../core/panel.types.js";

/**
 * Low-level HTTP client for the Marzban API. Phase 1 placeholder - it only
 * stores the connection settings; no requests are made yet.
 */
export class MarzbanClient {
  constructor(readonly credentials: PanelCredentials) {}
}
