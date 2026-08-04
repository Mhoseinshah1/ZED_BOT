import {
  PanelStatus,
  prisma,
  ServiceStatus,
  type Prisma,
  type PrismaClient,
  type Service,
  type UserGroup,
} from "@zedbot/database";
import type { PanelCapability } from "@zedbot/panel-adapters";

import {
  MINIAPP_WALLET_ADDONS_ENABLED_KEY,
  MINIAPP_WALLET_RENEWAL_ENABLED_KEY,
  type CommerceResultCode,
  type MiniAppCommerceRolloutKey,
  type ServiceOperation,
} from "./contract.js";
import { groupMatches, type ProductWithRelations } from "./catalog.js";
import { panelOperationAvailable, serviceSupportsGlobalLifecycle } from "./panel-capability.js";
import { resolveOwnedService, type OwnedService } from "./resolve-service.js";

// =============================================================================
// What a person may buy for a Service they already own — renewal plans, extra
// volume packages, extra time packages.
//
// THREE OPERATIONS, ONE AUTHORITY. The bot implemented these as three modules
// that are 90% the same text: the same owner lookup, the same panel-compatibility
// rule, the same group filter, the same "re-check it on click" predicate. Three
// copies of a rule is three places to fix it and two places to forget. What
// genuinely differs between them — which panel capability is required, which
// Service states qualify, which Products count as an option, what the option
// grants — is stated ONCE, in `OPERATION_RULES` below, and everything else is
// shared.
//
// THE BOT'S BEHAVIOUR IS THE SPECIFICATION. Every predicate here was lifted from
// `renewal-checkout.service.ts`, `extra-volume.service.ts` and
// `extra-time.service.ts` and the originals now re-export these, so there is one
// implementation and the bot's flows are unchanged. Where a rule looked odd it
// was preserved anyway and the reason recorded — see `panel.isVisible` below.
//
// A PRODUCT UUID NEVER REACHES THE BROWSER. An option is addressed by the 8-hex
// prefix of its Product id, the same convention services already use. Resolution
// is a lookup INSIDE the currently-eligible set, which is what makes "this
// option was deleted", "this option is now incompatible", "this option belongs
// to a different panel" and "this option never existed" produce one answer.
//
// AMBIGUITY REFUSES. Two products sharing an 8-hex prefix is astronomically
// unlikely and would, under a `find`, silently sell the wrong one. It returns
// OPTION_UNAVAILABLE instead.
// =============================================================================

/** A Prisma client or an interactive transaction client. */
type Db = PrismaClient | Prisma.TransactionClient;

/**
 * Everything that differs between the three operations, in one table.
 *
 * Reading this table IS reading the eligibility rules; there is no second place
 * where an operation's requirements are decided.
 */
interface OperationRule {
  /** The panel capability the operation needs. Checked before any money moves. */
  capability: PanelCapability;
  /**
   * Service statuses this operation accepts.
   *
   * Renewal and extra time accept EXPIRED and DISABLED on purpose: the person
   * most likely to want either is precisely the one whose service ran out.
   * Extra volume does not, because topping up a service that has already expired
   * buys quota the user cannot spend.
   */
  statuses: readonly ServiceStatus[];
  /** The rollout switch that must be on to settle this operation. */
  rolloutKey: MiniAppCommerceRolloutKey;
}

const OPERATION_RULES: Record<ServiceOperation, OperationRule> = {
  RENEWAL: {
    capability: "renewService",
    statuses: [
      ServiceStatus.ACTIVE,
      ServiceStatus.EXPIRED,
      ServiceStatus.LIMITED,
      ServiceStatus.DISABLED,
    ],
    rolloutKey: MINIAPP_WALLET_RENEWAL_ENABLED_KEY,
  },
  EXTRA_VOLUME: {
    capability: "addVolume",
    statuses: [ServiceStatus.ACTIVE, ServiceStatus.LIMITED],
    rolloutKey: MINIAPP_WALLET_ADDONS_ENABLED_KEY,
  },
  EXTRA_TIME: {
    capability: "addTime",
    statuses: [
      ServiceStatus.ACTIVE,
      ServiceStatus.EXPIRED,
      ServiceStatus.LIMITED,
      ServiceStatus.DISABLED,
    ],
    rolloutKey: MINIAPP_WALLET_ADDONS_ENABLED_KEY,
  },
};

/** The panel capability an operation requires. */
export function operationCapability(operation: ServiceOperation): PanelCapability {
  return OPERATION_RULES[operation].capability;
}

/** The rollout switch that gates settling an operation. */
export function operationRolloutKey(operation: ServiceOperation): MiniAppCommerceRolloutKey {
  return OPERATION_RULES[operation].rolloutKey;
}

/**
 * Whether the Service itself qualifies for the operation, beyond the checks
 * `resolveOwnedService` already made (owner, panel capability, remote model).
 *
 * The two shape rules are not arbitrary:
 *  - EXTRA_VOLUME needs `volumeBytes > 0`. An unlimited service has no quota to
 *    add to, so the purchase would take money and change nothing.
 *  - EXTRA_TIME needs an expiry. Adding days to a service that never expires
 *    would DOWNGRADE it to a finite one — the user would pay to lose something.
 */
export function serviceEligibleForOperation(
  service: Pick<Service, "status" | "volumeBytes" | "expiresAt">,
  operation: ServiceOperation,
): boolean {
  const rule = OPERATION_RULES[operation];
  if (!rule.statuses.includes(service.status)) {
    return false;
  }
  if (operation === "EXTRA_VOLUME") {
    return service.volumeBytes > 0n;
  }
  if (operation === "EXTRA_TIME") {
    return service.expiresAt !== null;
  }
  return true;
}

// --- the product queries, one per operation ---------------------------------

/**
 * Renewal plans for a service: active SERVICE_PRODUCTs of the SAME panel, active
 * category, visible to the user's group.
 *
 * `panel.isVisible` is deliberately NOT required, unlike the purchase catalog.
 * A panel can be hidden from new buyers while its existing customers keep
 * renewing; requiring visibility here would strand everyone already on it. The
 * panel must still be ACTIVE.
 */
export async function renewalPlansForPanel(
  group: UserGroup,
  panelId: string,
  db: Db = prisma,
): Promise<ProductWithRelations[]> {
  const products = await db.product.findMany({
    where: {
      type: "SERVICE_PRODUCT",
      isActive: true,
      panelId,
      category: { isActive: true },
      panel: { status: PanelStatus.ACTIVE },
    },
    include: { category: true, panel: true },
    orderBy: [
      { category: { displayOrder: "asc" } },
      { displayOrder: "asc" },
      { priceToman: "asc" },
      { createdAt: "asc" },
    ],
  });
  return products.filter((p) => groupMatches(p.displayGroups, group));
}

/**
 * Extra-volume packages: active same-panel SERVICE_PRODUCTs with volumeGb > 0
 * and priceToman > 0 in an active category, visible to the user's group.
 * Ordered by volume, then price/displayOrder.
 */
export async function extraVolumePackages(
  group: UserGroup,
  panelId: string,
  db: Db = prisma,
): Promise<ProductWithRelations[]> {
  const products = await db.product.findMany({
    where: {
      type: "SERVICE_PRODUCT",
      isActive: true,
      panelId,
      volumeGb: { gt: 0 },
      priceToman: { gt: 0 },
      category: { isActive: true },
      panel: { status: PanelStatus.ACTIVE },
    },
    include: { category: true, panel: true },
    orderBy: [{ volumeGb: "asc" }, { priceToman: "asc" }, { displayOrder: "asc" }],
  });
  return products.filter((p) => groupMatches(p.displayGroups, group));
}

/**
 * Extra-time packages: active same-panel SERVICE_PRODUCTs with durationDays > 0
 * and priceToman > 0 in an active category, visible to the user's group. A
 * package's volumeGb, if set, is IGNORED by the time calculation.
 * Ordered by duration, then price/displayOrder.
 */
export async function extraTimePackages(
  group: UserGroup,
  panelId: string,
  db: Db = prisma,
): Promise<ProductWithRelations[]> {
  const products = await db.product.findMany({
    where: {
      type: "SERVICE_PRODUCT",
      isActive: true,
      panelId,
      durationDays: { gt: 0 },
      priceToman: { gt: 0 },
      category: { isActive: true },
      panel: { status: PanelStatus.ACTIVE },
    },
    include: { category: true, panel: true },
    orderBy: [{ durationDays: "asc" }, { priceToman: "asc" }, { displayOrder: "asc" }],
  });
  return products.filter((p) => groupMatches(p.displayGroups, group));
}

/** The candidate products for an operation on one panel. */
export async function operationProductsForPanel(
  operation: ServiceOperation,
  group: UserGroup,
  panelId: string,
  db: Db = prisma,
): Promise<ProductWithRelations[]> {
  if (operation === "RENEWAL") {
    return renewalPlansForPanel(group, panelId, db);
  }
  if (operation === "EXTRA_VOLUME") {
    return extraVolumePackages(group, panelId, db);
  }
  return extraTimePackages(group, panelId, db);
}

// --- the re-check predicates, one per operation -----------------------------

/** Re-check that one plan is still valid for renewing this service. */
export function isRenewalPlanValid(
  product: ProductWithRelations,
  service: Service,
  group: UserGroup,
): boolean {
  return (
    product.type === "SERVICE_PRODUCT" &&
    product.isActive &&
    product.category.isActive &&
    product.panelId === service.panelId &&
    product.panel !== null &&
    // Capability gate: a panel whose adapter cannot renew must be blocked HERE,
    // before payment — never discovered post-payment.
    panelOperationAvailable(product.panel, "renewService") &&
    // Remote-model gate: only GLOBAL_CLIENT XUI services may be renewed.
    serviceSupportsGlobalLifecycle(service) &&
    groupMatches(product.displayGroups, group)
  );
}

/** Re-check one extra-volume package against the target service and group. */
export function isExtraVolumePackageValid(
  product: ProductWithRelations,
  service: Service,
  group: UserGroup,
): boolean {
  return (
    product.type === "SERVICE_PRODUCT" &&
    product.isActive &&
    product.category.isActive &&
    product.panelId === service.panelId &&
    product.panel !== null &&
    panelOperationAvailable(product.panel, "addVolume") &&
    serviceSupportsGlobalLifecycle(service) &&
    (product.volumeGb ?? 0) > 0 &&
    product.priceToman > 0 &&
    groupMatches(product.displayGroups, group)
  );
}

/** Re-check one extra-time package against the target service and group. */
export function isExtraTimePackageValid(
  product: ProductWithRelations,
  service: Service,
  group: UserGroup,
): boolean {
  return (
    product.type === "SERVICE_PRODUCT" &&
    product.isActive &&
    product.category.isActive &&
    product.panelId === service.panelId &&
    product.panel !== null &&
    panelOperationAvailable(product.panel, "addTime") &&
    serviceSupportsGlobalLifecycle(service) &&
    (product.durationDays ?? 0) > 0 &&
    product.priceToman > 0 &&
    groupMatches(product.displayGroups, group)
  );
}

/** The re-check predicate for an operation. */
export function isOperationOptionValid(
  operation: ServiceOperation,
  product: ProductWithRelations,
  service: Service,
  group: UserGroup,
): boolean {
  if (operation === "RENEWAL") {
    return isRenewalPlanValid(product, service, group);
  }
  if (operation === "EXTRA_VOLUME") {
    return isExtraVolumePackageValid(product, service, group);
  }
  return isExtraTimePackageValid(product, service, group);
}

// --- the public option contract ---------------------------------------------

/**
 * The public identifier of an option.
 *
 * An option IS a Product row and the Product uuid must never reach the browser,
 * so the option is addressed by the same 8-hex-character prefix convention
 * services already use. Stable for the row's life, recognisable to an operator
 * holding the uuid, and nothing extra to store.
 */
export const OPTION_PUBLIC_ID_LENGTH = 8;

export const OPTION_PUBLIC_ID_PATTERN = /^[0-9a-f]{8}$/i;

/** The public id for an option (a Product). */
export function optionPublicId(product: { id: string }): string {
  return product.id.slice(0, OPTION_PUBLIC_ID_LENGTH);
}

/** True when `value` could be a public option id (format only). */
export function isOptionPublicId(value: unknown): value is string {
  return typeof value === "string" && OPTION_PUBLIC_ID_PATTERN.test(value);
}

/**
 * One option, as the browser is allowed to see it.
 *
 * An ALLOWLIST, built field by field — never a spread of the Product row. A
 * serializer that starts from the row and deletes what must not leak leaks
 * whatever is added to the schema next; this one can only emit what is written
 * here. No Product uuid, no category uuid, no panel uuid, no panel address, no
 * inbound ids, no operator notes.
 */
export interface ServiceOperationOptionDto {
  /** The 8-hex Product prefix. The only handle the browser ever gets. */
  optionId: string;
  operation: ServiceOperation;
  /** The product's display name. Operator-authored, shown as-is. */
  label: string;
  /** Days this option adds, or null when the option does not grant time. */
  durationDays: number | null;
  /** Gigabytes this option adds, or null when it does not grant traffic. */
  trafficGb: number | null;
  /** The authoritative price right now, in whole Toman. */
  priceToman: number;
  /** The unit `priceToman` is denominated in. Fixed; stated so the UI need not assume. */
  currency: "IRT";
  /**
   * Whether the option can be acted on right now.
   *
   * Always true in a listing, because a listing contains only options that
   * passed the eligibility predicate a moment ago. It exists so a client renders
   * one shape for both the list and a re-read, and so the field's presence
   * cannot be mistaken for a client-side eligibility decision.
   */
  available: boolean;
}

/**
 * The display fields of the Service an operation would act on.
 *
 * Present so a review screen can state what is about to change without the
 * client having to hold, or re-derive, anything authoritative.
 */
export interface OperationTargetDto {
  serviceId: string;
  label: string;
  status: ServiceStatus;
  expiresAt: string | null;
  volumeBytes: string;
  remainingBytes: string;
}

function toTargetDto(service: Service): OperationTargetDto {
  return {
    serviceId: service.id.slice(0, OPTION_PUBLIC_ID_LENGTH),
    // The remote username. Operator- or user-chosen, already shown to this
    // person in every service list — not a secret, and the only label that
    // lets them tell two of their own services apart.
    label: service.username,
    status: service.status,
    expiresAt: service.expiresAt?.toISOString() ?? null,
    // bigint cannot be JSON-encoded; a string keeps the exact value, where a
    // Number would silently round past 2^53 bytes (9 PB — reachable on a
    // misconfigured unlimited plan).
    volumeBytes: service.volumeBytes.toString(),
    remainingBytes: service.remainingBytes.toString(),
  };
}

/** Builds the public DTO for one eligible option. */
export function toOptionDto(
  product: ProductWithRelations,
  operation: ServiceOperation,
): ServiceOperationOptionDto {
  return {
    optionId: optionPublicId(product),
    operation,
    label: product.name,
    // Reported per operation, not per product: an extra-volume package may also
    // carry a durationDays the operation deliberately ignores, and showing it
    // would promise time the purchase does not grant.
    durationDays: operation === "EXTRA_VOLUME" ? null : (product.durationDays ?? null),
    trafficGb: operation === "EXTRA_TIME" ? null : (product.volumeGb ?? null),
    priceToman: product.priceToman,
    currency: "IRT",
    available: true,
  };
}

// --- listing and resolution --------------------------------------------------

export type OptionListResult =
  | { ok: true; target: OperationTargetDto; options: ServiceOperationOptionDto[] }
  | { ok: false; code: Extract<CommerceResultCode, "SERVICE_NOT_FOUND" | "SERVICE_NOT_ELIGIBLE"> };

export interface OptionListArgs {
  userId: string;
  publicServiceId: string;
  operation: ServiceOperation;
  group: UserGroup;
}

/**
 * Every option the owner of this Service may currently choose.
 *
 * The owner gate runs FIRST and its refusal is passed through unchanged, so a
 * caller cannot learn anything about a service they do not own by asking what
 * can be bought for it.
 *
 * Eligibility is applied TWICE by construction: the query filters on it, and
 * `isOperationOptionValid` re-checks each row against the resolved Service. The
 * second pass is not redundant — the query cannot express "same panel as this
 * service", "the panel's adapter implements this operation" or "this XUI service
 * uses the global-client model", and those are exactly the rules whose absence
 * would be discovered after payment.
 */
export async function listServiceOperationOptions(
  db: Db,
  args: OptionListArgs,
): Promise<OptionListResult> {
  const owned = await resolveOwnedService(
    db,
    args.userId,
    args.publicServiceId,
    operationCapability(args.operation),
  );
  if (owned === null) {
    return { ok: false, code: "SERVICE_NOT_FOUND" };
  }
  if (!serviceEligibleForOperation(owned.service, args.operation)) {
    return { ok: false, code: "SERVICE_NOT_ELIGIBLE" };
  }

  const products = await operationProductsForPanel(
    args.operation,
    args.group,
    owned.service.panelId,
    db,
  );
  const eligible = products.filter((p) =>
    isOperationOptionValid(args.operation, p, owned.service, args.group),
  );
  return {
    ok: true,
    target: toTargetDto(owned.service),
    options: withoutCollidingIds(eligible).map((p) => toOptionDto(p, args.operation)),
  };
}

/**
 * Drops every product whose public id is shared with another eligible product.
 *
 * WHAT MAY BE LISTED AND WHAT MAY BE CHOSEN MUST BE THE SAME SET. Resolution
 * refuses an ambiguous prefix rather than guessing (see
 * `resolveServiceOperationOption`), so listing one would offer the user two rows
 * carrying an identical `optionId`, neither of which can be selected — a dead
 * option that looks exactly like a live one, and a support ticket that reads
 * "the button does nothing".
 *
 * BOTH SIDES OF A COLLISION GO, not just the later one. Keeping either would
 * mean the survivor is chosen by list order, which is the arbitrary pick the
 * refusal exists to prevent.
 *
 * This is unreachable in practice — 8 hex characters over the products of one
 * panel — and it is handled anyway because the alternative failure is silent.
 */
function withoutCollidingIds(products: ProductWithRelations[]): ProductWithRelations[] {
  const seen = new Map<string, number>();
  for (const product of products) {
    const key = optionPublicId(product).toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return products.filter((p) => seen.get(optionPublicId(p).toLowerCase()) === 1);
}

export type OptionResolution =
  | {
      ok: true;
      owned: OwnedService;
      product: ProductWithRelations;
      option: ServiceOperationOptionDto;
      target: OperationTargetDto;
    }
  | {
      ok: false;
      code: Extract<
        CommerceResultCode,
        "SERVICE_NOT_FOUND" | "SERVICE_NOT_ELIGIBLE" | "OPTION_UNAVAILABLE"
      >;
    };

export interface OptionResolveArgs extends OptionListArgs {
  publicOptionId: string;
}

/**
 * Resolves one chosen option, re-checking everything.
 *
 * ONE ANSWER FOR EVERY WAY AN OPTION CAN BE UNUSABLE. Never existed, was
 * deleted, was deactivated, its category was deactivated, its panel changed, it
 * belongs to another panel, its price dropped to zero, the prefix is ambiguous,
 * the prefix is malformed — all `OPTION_UNAVAILABLE`. The alternative is a
 * caller who can distinguish "no such product" from "that product exists but is
 * hidden from you", which is a catalog-enumeration oracle.
 *
 * Resolution searches INSIDE the currently-eligible set rather than fetching the
 * product by prefix and validating it afterwards. That ordering is what makes
 * the guarantee structural: an ineligible product is never loaded by id here, so
 * no later branch can accidentally act on one.
 */
export async function resolveServiceOperationOption(
  db: Db,
  args: OptionResolveArgs,
): Promise<OptionResolution> {
  const owned = await resolveOwnedService(
    db,
    args.userId,
    args.publicServiceId,
    operationCapability(args.operation),
  );
  if (owned === null) {
    return { ok: false, code: "SERVICE_NOT_FOUND" };
  }
  if (!serviceEligibleForOperation(owned.service, args.operation)) {
    return { ok: false, code: "SERVICE_NOT_ELIGIBLE" };
  }
  // Format is checked before the query but reported as OPTION_UNAVAILABLE, not
  // as a validation error: whether an id is well-formed is not information a
  // prober should get for free.
  if (!isOptionPublicId(args.publicOptionId)) {
    return { ok: false, code: "OPTION_UNAVAILABLE" };
  }

  const products = await operationProductsForPanel(
    args.operation,
    args.group,
    owned.service.panelId,
    db,
  );
  const wanted = args.publicOptionId.toLowerCase();
  const matches = products.filter(
    (p) =>
      optionPublicId(p).toLowerCase() === wanted &&
      isOperationOptionValid(args.operation, p, owned.service, args.group),
  );
  // Exactly one, or nothing. Two products sharing an 8-hex prefix is a collision,
  // and picking either would sell something the person did not choose.
  if (matches.length !== 1) {
    return { ok: false, code: "OPTION_UNAVAILABLE" };
  }
  const product = matches[0];
  return {
    ok: true,
    owned,
    product,
    option: toOptionDto(product, args.operation),
    target: toTargetDto(owned.service),
  };
}
