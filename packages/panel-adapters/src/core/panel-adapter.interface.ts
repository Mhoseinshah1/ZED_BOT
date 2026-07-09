import type {
  CreateServiceAccountInput,
  CreateServiceAccountResult,
  GetServiceAccountInput,
  GetServiceAccountResult,
  PanelHealthResult,
  PanelType,
  RenewServiceAccountInput,
  RenewServiceAccountResult,
} from "./panel.types.js";

/**
 * Contract every VPN panel integration (Marzban, XUI/Sanaei, ...) implements.
 * Phase 4 surface: connectivity testing. Phase 9 adds minimal account
 * creation for SERVICE_PURCHASE provisioning. Delete/update/renew/revoke
 * are later phases.
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

  /**
   * Creates one service account on the panel. Never throws and NEVER fakes
   * success - unimplemented or misconfigured paths return { ok: false }
   * with a safe internal errorMessage (no credentials).
   */
  createServiceAccount(input: CreateServiceAccountInput): Promise<CreateServiceAccountResult>;

  /**
   * Reads one service account from the panel (read-only - never mutates
   * panel state). Same contract: never throws for expected panel/API
   * failures, never fakes success, never includes credentials.
   */
  getServiceAccount(input: GetServiceAccountInput): Promise<GetServiceAccountResult>;

  /**
   * Renews one EXISTING service account: new traffic limit + expiry on the
   * same username. Never deletes/recreates the account, never changes the
   * username, never fakes success - unclear endpoints return { ok: false }.
   */
  renewServiceAccount(input: RenewServiceAccountInput): Promise<RenewServiceAccountResult>;
}
