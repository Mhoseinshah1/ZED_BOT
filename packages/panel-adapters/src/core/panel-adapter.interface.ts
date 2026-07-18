import type {
  AddServiceTimeInput,
  AddServiceTimeResult,
  SetServiceStatusInput,
  SetServiceStatusResult,
  AddServiceVolumeInput,
  AddServiceVolumeResult,
  CreateServiceAccountInput,
  CreateServiceAccountResult,
  GetServiceAccountInput,
  GetServiceAccountResult,
  NormalizedAccountStatus,
  PanelCapability,
  PanelHealthResult,
  PanelType,
  ProvisioningReadinessInput,
  ProvisioningReadinessResult,
  RegenerateSubscriptionInput,
  RegenerateSubscriptionResult,
  RenewServiceAccountInput,
  RenewServiceAccountResult,
  ServiceSubscriptionInfo,
  ServiceTrafficUsage,
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
   * Operations this adapter actually implements and has tested. Anything
   * absent must be blocked by callers BEFORE payment - the adapter methods
   * for unsupported operations still fail safely, but discovering that
   * after money moved is a bug.
   */
  readonly capabilities: readonly PanelCapability[];

  /**
   * Verifies the panel is reachable and that the stored credentials
   * authenticate. Never throws - failures come back as { ok: false }.
   * Never include credentials in the result. Authentication success alone
   * is NOT provisioning readiness - see checkProvisioningReadiness.
   */
  testConnection(): Promise<PanelHealthResult>;

  /**
   * Full authenticated readiness check for createService: authentication,
   * read-endpoint access and the panel-specific provisioning configuration
   * (Marzban template/explicit proxies; XUI inbound ids/protocols). Read-only
   * - never mutates panel state, never throws, never returns credentials.
   */
  checkProvisioningReadiness(
    input: ProvisioningReadinessInput,
  ): Promise<ProvisioningReadinessResult>;

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
   * OPTIONAL bulk read: every service account the panel exposes in ONE call,
   * each normalized exactly like getServiceAccount (keyed by the panel-side
   * username in `username`). For worker-side batch synchronization of panels
   * whose API has a whole-inventory endpoint (XUI clients/list). Returns null
   * on an auth/read failure so the caller falls back to bounded per-user
   * reads. Adapters whose panel has NO bulk endpoint (Marzban, which is
   * per-user only) leave this undefined; callers must feature-detect it and
   * degrade to getServiceAccount per service. Read-only, never throws, never
   * includes credentials.
   */
  listServiceAccounts?(input?: {
    subscriptionBaseUrl?: string | null;
  }): Promise<GetServiceAccountResult[] | null>;

  // --- unified sync surface (service-live-sync phase) -----------------------
  // syncService returns the FULL normalized snapshot; the targeted accessors
  // below are projections of the same single read (implemented via the
  // shared derive* helpers - one HTTP path, no drift). Each returns null
  // when the read failed or the panel did not report the value - a panel
  // field is NEVER invented.

  /** Full normalized live snapshot of one service account (read-only). */
  syncService(input: GetServiceAccountInput): Promise<GetServiceAccountResult>;

  /** Live account status; null = unavailable (read failed / not reported). */
  getServiceStatus(input: GetServiceAccountInput): Promise<NormalizedAccountStatus | null>;

  /** Live traffic usage (used/limit/remaining); null = read failed. */
  getTrafficUsage(input: GetServiceAccountInput): Promise<ServiceTrafficUsage | null>;

  /** Live expiry; null = unavailable or the account never expires. */
  getExpiry(input: GetServiceAccountInput): Promise<Date | null>;

  /** Live subscription URL/token/config links; null = read failed. */
  getSubscriptionInfo(input: GetServiceAccountInput): Promise<ServiceSubscriptionInfo | null>;

  /**
   * Renews one EXISTING service account: new traffic limit + expiry on the
   * same username. Never deletes/recreates the account, never changes the
   * username, never fakes success - unclear endpoints return { ok: false }.
   */
  renewServiceAccount(input: RenewServiceAccountInput): Promise<RenewServiceAccountResult>;

  /**
   * Adds purchased volume to one EXISTING account: new (larger) total quota
   * on the same username with the expiry passed through unchanged. Same
   * contract: never delete/recreate, never rename, never fake success.
   */
  addServiceVolume(input: AddServiceVolumeInput): Promise<AddServiceVolumeResult>;

  /**
   * Extends one EXISTING account's expiry while leaving quota and usage
   * untouched (usage is NEVER reset for extra time). Same contract: never
   * delete/recreate, never rename, never fake success.
   */
  addServiceTime(input: AddServiceTimeInput): Promise<AddServiceTimeResult>;

  /**
   * Enables/disables one EXISTING account, changing ONLY its status: quota,
   * expiry, usage and username stay untouched. Same contract: never
   * delete/recreate, never fake success.
   */
  setServiceStatus(input: SetServiceStatusInput): Promise<SetServiceStatusResult>;

  /**
   * Regenerates/revokes one EXISTING account's subscription link (and token
   * where the panel has one) so the OLD link stops working. The account is
   * otherwise untouched: no rename, no quota/expiry change, no usage reset.
   * Same contract: never delete/recreate, never fake success - returning
   * the old link as if it were new is forbidden.
   */
  regenerateSubscription(input: RegenerateSubscriptionInput): Promise<RegenerateSubscriptionResult>;
}
