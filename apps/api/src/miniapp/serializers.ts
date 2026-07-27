import type { ServiceStatus, UserGroup, UserStatus } from "@zedbot/database";
import { serviceShortId } from "@zedbot/shared";

// =============================================================================
// Response shaping — an ALLOWLIST, never a redaction pass.
//
// Every function here names the fields it emits. Nothing spreads a Prisma row,
// so a column added to the schema tomorrow cannot leak by default: it simply
// does not appear until someone writes it down here on purpose.
//
// What must never cross this boundary, and why:
//
//   subscriptionUrl, subscriptionToken, configLinks, remoteClientId,
//   remoteInboundIds        - these ARE the service. Anyone holding them has
//                             the connection, no account required. The Mini App
//                             is read-only and has no reason to carry them.
//   panel credentials, baseUrl, panelId
//                           - infrastructure. A user needs the panel's display
//                             name, never its address or identity.
//   failureReason, adminNote, note
//                           - operator free-text. Written for staff, in staff
//                             language, and occasionally containing internal
//                             detail. `userNote` is the buyer's own text and is
//                             the only note that comes back.
//   raw Json columns        - namingStrategySnapshot, remoteMetadata,
//                             capabilitySnapshot: internal structures whose
//                             shape is not a public contract.
//   database uuids          - the Service primary key and the WalletTransaction
//                             primary key. A uuid is an INTERNAL handle that
//                             also appears in operator logs, support
//                             transcripts and admin screens, so putting it in a
//                             page or a URL correlates those contexts for
//                             anyone who sees both. Services carry the same
//                             short public id the bot shows; ledger rows carry
//                             none at all, because nothing addresses one.
//
// BigInt columns are emitted as decimal STRINGS. `JSON.stringify` throws on a
// BigInt, and coercing through `Number` would round a byte count above 2^53 —
// a plausible volume on a large plan. A string is exact and the frontend
// formats it.
// =============================================================================

export interface MiniAppUserDto {
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  status: UserStatus;
  group: UserGroup;
  balanceToman: number;
  joinedAt: string;
}

export interface MiniAppUserSource {
  firstName: string | null;
  lastName: string | null;
  username: string | null;
  status: UserStatus;
  group: string;
  balanceToman: number;
  joinedAt: Date;
}

/**
 * The signed-in user's own profile.
 *
 * `telegramId` is deliberately absent. The client already knows who it is —
 * Telegram told it — so returning the id adds nothing and puts a stable
 * cross-service identifier into a cacheable response body for no gain.
 */
export function toMiniAppUser(user: MiniAppUserSource): MiniAppUserDto {
  return {
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    status: user.status,
    group: user.group as UserGroup,
    balanceToman: user.balanceToman,
    joinedAt: user.joinedAt.toISOString(),
  };
}

export interface MiniAppServiceSummarySource {
  id: string;
  username: string;
  status: ServiceStatus;
  productNameSnapshot: string | null;
  panelNameSnapshot: string | null;
  serviceLocation: string;
  volumeBytes: bigint;
  usedBytes: bigint;
  remainingBytes: bigint;
  durationDays: number;
  startsAt: Date;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Whole days left before a service expires.
 *
 * Three cases, defined once so the list, the detail and the dashboard cannot
 * disagree about what "0" means:
 *
 *   - NEVER EXPIRES (`expiresAt === null`, i.e. unlimited duration) → `null`.
 *     Not `0` and not a huge number: the field genuinely does not apply, and a
 *     numeric answer would be rendered as a countdown that never moves.
 *   - ALREADY EXPIRED → `0`. Never negative — "how much is left" is not a
 *     debt, and a negative number invites a UI to render "-3 days remaining".
 *   - IN THE FUTURE → rounded UP. A service expiring in three hours has one
 *     day left, not zero; rounding down would make it indistinguishable from
 *     one that already expired.
 */
export function remainingDaysUntil(expiresAt: Date | null, nowMs: number): number | null {
  if (expiresAt === null) {
    return null;
  }
  const remainingMs = expiresAt.getTime() - nowMs;
  if (remainingMs <= 0) {
    return 0;
  }
  return Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
}

export interface MiniAppServiceSummaryDto {
  /**
   * The PUBLIC service id — the same 8-character value the bot shows, derived
   * from the uuid by `serviceShortId`. Never the uuid itself; the detail route
   * resolves this back, owner-scoped.
   */
  id: string;
  username: string;
  status: ServiceStatus;
  productName: string | null;
  panelName: string | null;
  /** Which location set the plan covers. An enum label, not an address. */
  location: string;
  volumeBytes: string;
  usedBytes: string;
  remainingBytes: string;
  durationDays: number;
  /** Whole days left; `null` when the service never expires. */
  remainingDays: number | null;
  startsAt: string;
  expiresAt: string | null;
  createdAt: string;
  /**
   * When THIS DATABASE ROW was last written.
   *
   * Deliberately not called "last panel sync": it is the freshness of what we
   * hold, which is the only thing this read-only surface can honestly report.
   * Nothing here calls a panel, so nothing here knows when the panel last
   * changed.
   */
  lastSyncedAt: string;
}

export function toMiniAppServiceSummary(
  service: MiniAppServiceSummarySource,
  nowMs: number = Date.now(),
): MiniAppServiceSummaryDto {
  return {
    id: serviceShortId(service),
    username: service.username,
    status: service.status,
    productName: service.productNameSnapshot,
    panelName: service.panelNameSnapshot,
    location: service.serviceLocation,
    volumeBytes: service.volumeBytes.toString(),
    usedBytes: service.usedBytes.toString(),
    remainingBytes: service.remainingBytes.toString(),
    durationDays: service.durationDays,
    remainingDays: remainingDaysUntil(service.expiresAt, nowMs),
    startsAt: service.startsAt.toISOString(),
    expiresAt: service.expiresAt === null ? null : service.expiresAt.toISOString(),
    createdAt: service.createdAt.toISOString(),
    lastSyncedAt: service.updatedAt.toISOString(),
  };
}

export interface MiniAppServiceDetailSource extends MiniAppServiceSummarySource {
  userNote: string | null;
  source: string;
  firstConnectedAt: Date | null;
  lastConnectedAt: Date | null;
  lastSubscriptionUpdateAt: Date | null;
}

export interface MiniAppServiceDetailDto extends MiniAppServiceSummaryDto {
  /** The BUYER's own note, not the internal `zedbot order:...` panel marker. */
  userNote: string | null;
  source: string;
  firstConnectedAt: string | null;
  lastConnectedAt: string | null;
  lastSubscriptionUpdateAt: string | null;
}

export function toMiniAppServiceDetail(
  service: MiniAppServiceDetailSource,
  nowMs: number = Date.now(),
): MiniAppServiceDetailDto {
  return {
    // `location`, `remainingDays` and `lastSyncedAt` come from the summary —
    // the detail is a superset, so the two views can never disagree.
    ...toMiniAppServiceSummary(service, nowMs),
    userNote: service.userNote,
    source: service.source,
    firstConnectedAt:
      service.firstConnectedAt === null ? null : service.firstConnectedAt.toISOString(),
    lastConnectedAt:
      service.lastConnectedAt === null ? null : service.lastConnectedAt.toISOString(),
    lastSubscriptionUpdateAt:
      service.lastSubscriptionUpdateAt === null
        ? null
        : service.lastSubscriptionUpdateAt.toISOString(),
  };
}

export interface MiniAppTransactionSource {
  amountToman: number;
  type: string;
  source: string;
  balanceAfterToman: number;
  createdAt: Date;
}

export interface MiniAppTransactionDto {
  amountToman: number;
  type: string;
  source: string;
  balanceAfterToman: number;
  createdAt: string;
}

/**
 * One wallet ledger row.
 *
 * `reason`, `adminId` and the related order/payment ids stay behind. `reason`
 * is operator free-text on manual adjustments; the type and source pair already
 * says what happened in terms the frontend can render in Persian, and it says
 * it without echoing whatever an admin typed into a support workflow.
 *
 * There is NO id. A ledger row is not addressable — nothing in this read-only
 * surface takes one as input — so emitting its database uuid would hand out an
 * internal identifier that buys the client nothing. The row's own fields are
 * what the frontend renders and sorts by.
 */
export function toMiniAppTransaction(row: MiniAppTransactionSource): MiniAppTransactionDto {
  return {
    amountToman: row.amountToman,
    type: row.type,
    source: row.source,
    balanceAfterToman: row.balanceAfterToman,
    createdAt: row.createdAt.toISOString(),
  };
}
