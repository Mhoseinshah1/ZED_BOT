import type { PanelAdapter } from "../core/panel-adapter.interface.js";
import type {
  CreateServiceAccountInput,
  CreateServiceAccountResult,
  GetServiceAccountInput,
  GetServiceAccountResult,
  PanelHealthResult,
} from "../core/panel.types.js";
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

  /**
   * Phase 9: NOT implemented yet. The token-authenticated XUI/Sanaei client
   * endpoints were never established in Phase 4 and the exact addClient
   * surface must come from the Sanaei API reference - guessing endpoints
   * could create broken/orphaned accounts, so this fails safely instead of
   * faking success. Provisioning then FAILs the order and refunds the user.
   *
   * TODO(xui-provisioning): implement inbound addClient per sanaei-api.txt
   * (token auth, add client under each configured inbound id).
   */
  async createServiceAccount(
    input: CreateServiceAccountInput,
  ): Promise<CreateServiceAccountResult> {
    const inboundIds = (input.inboundIds ?? []).filter((id) => Number.isInteger(id));
    if (inboundIds.length === 0) {
      return { ok: false, errorMessage: "XUI inbound settings are not configured." };
    }
    return {
      ok: false,
      errorMessage:
        "XUI create-client is not implemented in this phase (safe TODO); no account was created.",
    };
  }

  /**
   * Phase 11: NOT implemented - the token-authenticated read-client endpoint
   * surface must come from the Sanaei API reference (same reason as
   * createServiceAccount). Never fakes success, never mutates the panel;
   * callers keep showing the stored DB values.
   *
   * TODO(xui-sync): implement per sanaei-api.txt once available.
   */
  async getServiceAccount(_input: GetServiceAccountInput): Promise<GetServiceAccountResult> {
    return { ok: false, errorMessage: "XUI service sync is not implemented yet." };
  }
}
