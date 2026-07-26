import type { ServiceStatus, UserGroup, UserStatus } from "@zedbot/database";

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
  volumeBytes: bigint;
  usedBytes: bigint;
  remainingBytes: bigint;
  durationDays: number;
  startsAt: Date;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface MiniAppServiceSummaryDto {
  id: string;
  username: string;
  status: ServiceStatus;
  productName: string | null;
  panelName: string | null;
  volumeBytes: string;
  usedBytes: string;
  remainingBytes: string;
  durationDays: number;
  startsAt: string;
  expiresAt: string | null;
  createdAt: string;
}

export function toMiniAppServiceSummary(
  service: MiniAppServiceSummarySource,
): MiniAppServiceSummaryDto {
  return {
    id: service.id,
    username: service.username,
    status: service.status,
    productName: service.productNameSnapshot,
    panelName: service.panelNameSnapshot,
    volumeBytes: service.volumeBytes.toString(),
    usedBytes: service.usedBytes.toString(),
    remainingBytes: service.remainingBytes.toString(),
    durationDays: service.durationDays,
    startsAt: service.startsAt.toISOString(),
    expiresAt: service.expiresAt === null ? null : service.expiresAt.toISOString(),
    createdAt: service.createdAt.toISOString(),
  };
}

export interface MiniAppServiceDetailSource extends MiniAppServiceSummarySource {
  userNote: string | null;
  source: string;
  serviceLocation: string;
  firstConnectedAt: Date | null;
  lastConnectedAt: Date | null;
  lastSubscriptionUpdateAt: Date | null;
}

export interface MiniAppServiceDetailDto extends MiniAppServiceSummaryDto {
  /** The BUYER's own note, not the internal `zedbot order:...` panel marker. */
  userNote: string | null;
  source: string;
  location: string;
  firstConnectedAt: string | null;
  lastConnectedAt: string | null;
  lastSubscriptionUpdateAt: string | null;
}

export function toMiniAppServiceDetail(
  service: MiniAppServiceDetailSource,
): MiniAppServiceDetailDto {
  return {
    ...toMiniAppServiceSummary(service),
    userNote: service.userNote,
    source: service.source,
    location: service.serviceLocation,
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
  id: string;
  amountToman: number;
  type: string;
  source: string;
  balanceAfterToman: number;
  createdAt: Date;
}

export interface MiniAppTransactionDto {
  id: string;
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
 */
export function toMiniAppTransaction(row: MiniAppTransactionSource): MiniAppTransactionDto {
  return {
    id: row.id,
    amountToman: row.amountToman,
    type: row.type,
    source: row.source,
    balanceAfterToman: row.balanceAfterToman,
    createdAt: row.createdAt.toISOString(),
  };
}
