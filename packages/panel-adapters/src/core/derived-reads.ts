import type {
  GetServiceAccountResult,
  NormalizedAccountStatus,
  ServiceSubscriptionInfo,
  ServiceTrafficUsage,
} from "./panel.types.js";

// =============================================================================
// Derived read views (service-live-sync phase): the targeted sync accessors
// (getServiceStatus / getTrafficUsage / getExpiry / getSubscriptionInfo) are
// all projections of ONE normalized getServiceAccount snapshot. Deriving
// them here keeps a single panel read path per adapter - no duplicated HTTP
// logic, no drift between the full sync and the targeted views. `null`
// always means "the panel did not report this" - values are never invented.
// =============================================================================

/** Status projection; null = read failed or the panel reported nothing. */
export function deriveServiceStatus(
  result: GetServiceAccountResult,
): NormalizedAccountStatus | null {
  if (!result.ok) {
    return null;
  }
  return result.status ?? null;
}

/** Traffic projection; null = read failed. Unreported fields stay null. */
export function deriveTrafficUsage(result: GetServiceAccountResult): ServiceTrafficUsage | null {
  if (!result.ok) {
    return null;
  }
  return {
    usedBytes: result.usedBytes ?? null,
    totalBytes: result.totalBytes ?? null,
    remainingBytes: result.remainingBytes ?? null,
  };
}

/**
 * Expiry projection; null = read failed, the panel reported nothing, or the
 * account never expires (the full snapshot preserves that distinction).
 */
export function deriveExpiry(result: GetServiceAccountResult): Date | null {
  if (!result.ok) {
    return null;
  }
  return result.expiresAt ?? null;
}

/** Subscription projection; null = read failed. Unreported fields stay null/empty. */
export function deriveSubscriptionInfo(
  result: GetServiceAccountResult,
): ServiceSubscriptionInfo | null {
  if (!result.ok) {
    return null;
  }
  return {
    subscriptionUrl:
      result.subscriptionUrl !== undefined && result.subscriptionUrl !== ""
        ? result.subscriptionUrl
        : null,
    subscriptionToken:
      result.subscriptionToken !== undefined && result.subscriptionToken !== ""
        ? result.subscriptionToken
        : null,
    configLinks: result.configLinks ?? [],
  };
}
