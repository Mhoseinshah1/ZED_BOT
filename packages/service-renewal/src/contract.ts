// =============================================================================
// The renewal contract shared by the Telegram Bot and the Mini App API.
//
// WHY A PACKAGE AND NOT A COPY. There is exactly one renewal authority in this
// system, and it already exists: the Bot's pricing, wallet settlement, order
// and provisioning path. `apps/api` cannot import `apps/bot`, so the choice was
// between reimplementing that logic behind an HTTP route — a second renewal
// engine, drifting from the first the day either is touched — and lifting the
// transport-independent part into a package both call. This is the package.
//
// WHAT MAY LIVE HERE. Anything that decides an outcome from the database and
// the clock: eligibility, option resolution, price, the frozen snapshot, the
// wallet transaction, the result classification. Nothing that renders. No
// grammY, no BotContext, no keyboards, no Persian display strings — those are
// per-transport and belong to the transport. The codes below are the seam: the
// domain returns a code, each transport turns it into the words its users read.
// =============================================================================

/**
 * The OWNER-controlled rollout switch for Mini App wallet renewal.
 *
 * Follows the repository's existing `<area>_<thing>_enabled` Setting naming
 * (`wallet_payment_enabled`, `wallet_topup_enabled`), so it appears where an
 * operator already looks rather than in a new namespace they have to learn.
 */
export const MINIAPP_WALLET_RENEWAL_ENABLED_KEY = "miniapp_wallet_renewal_enabled";

/**
 * Default OFF. Merging this branch must enable nothing.
 *
 * A payment surface that switches itself on at deploy time gives the operator
 * no moment to decide; the first they would learn of it is a user's charge.
 */
export const MINIAPP_WALLET_RENEWAL_ENABLED_DEFAULT = false;

/**
 * The rest of the layer-1 rollout switches.
 *
 * THE NAMES ARE NOT NEW. `docs/miniapp-user-parity-matrix.md` assigned a
 * rollout setting to every capability before any of them was built, and these
 * are those names — picking different ones now would leave the matrix pointing
 * at switches that do not exist. All follow the repository's existing
 * `<area>_<thing>_enabled` Setting convention (`wallet_payment_enabled`,
 * `wallet_topup_enabled`, `representative_program_enabled`).
 *
 * THEY DO NOT OVERLAP. Each one guards a different thing a user can do, so an
 * operator can open the reading surface without opening any spending surface,
 * and can close one payment surface without closing the others:
 *
 *   browse    — reading the catalog. No writes, no money.
 *   checkout  — creating a draft, applying a discount, asking for a quote.
 *               Writes a draft row; still no money.
 *   purchase  — settling a NEW subscription from the wallet.
 *   renewal   — settling a renewal from the wallet.
 *   addons    — settling extra volume or extra time from the wallet.
 *
 * Every one of them defaults false and none is `isPublic`.
 */
export const MINIAPP_COMMERCE_BROWSE_ENABLED_KEY = "miniapp_commerce_browse_enabled";
export const MINIAPP_COMMERCE_CHECKOUT_ENABLED_KEY = "miniapp_commerce_checkout_enabled";
export const MINIAPP_WALLET_PURCHASE_ENABLED_KEY = "miniapp_wallet_purchase_enabled";
export const MINIAPP_WALLET_ADDONS_ENABLED_KEY = "miniapp_wallet_addons_enabled";

/**
 * Every layer-1 rollout key, so a test can assert the whole set is off and an
 * operator has one list to read.
 */
export const MINIAPP_COMMERCE_ROLLOUT_KEYS = [
  MINIAPP_COMMERCE_BROWSE_ENABLED_KEY,
  MINIAPP_COMMERCE_CHECKOUT_ENABLED_KEY,
  MINIAPP_WALLET_PURCHASE_ENABLED_KEY,
  MINIAPP_WALLET_RENEWAL_ENABLED_KEY,
  MINIAPP_WALLET_ADDONS_ENABLED_KEY,
] as const;

export type MiniAppCommerceRolloutKey = (typeof MINIAPP_COMMERCE_ROLLOUT_KEYS)[number];

/**
 * The operations a person can perform against a Service they already own.
 *
 * One vocabulary for all three because they are the same shape of transaction:
 * pick an option, freeze a price, pay from the wallet, mutate an existing panel
 * account. Where they genuinely differ — which panel capability is needed, which
 * service states qualify, what the option grants — the difference is stated once,
 * in a table, rather than spread across three near-identical modules.
 */
export const SERVICE_OPERATIONS = ["RENEWAL", "EXTRA_VOLUME", "EXTRA_TIME"] as const;

export type ServiceOperation = (typeof SERVICE_OPERATIONS)[number];

/** True when `value` names a service operation. */
export function isServiceOperation(value: unknown): value is ServiceOperation {
  return typeof value === "string" && (SERVICE_OPERATIONS as readonly string[]).includes(value);
}

/**
 * Everything a person can pay for in layer 1.
 *
 * A new purchase joins the three service operations here rather than living in
 * its own vocabulary, because from the checkout's point of view they are the
 * same transaction with a different target: pick something, freeze a price, pay
 * from the wallet, make a panel change. The one real difference — a new purchase
 * has no existing Service — is expressed by `serviceId` being null, which the
 * type system then forces every caller to handle.
 */
export const COMMERCE_OPERATIONS = [
  "NEW_PURCHASE",
  "RENEWAL",
  "EXTRA_VOLUME",
  "EXTRA_TIME",
] as const;

export type CommerceOperation = (typeof COMMERCE_OPERATIONS)[number];

/** True when `value` names a commerce operation. */
export function isCommerceOperation(value: unknown): value is CommerceOperation {
  return typeof value === "string" && (COMMERCE_OPERATIONS as readonly string[]).includes(value);
}

/**
 * The Prisma `OrderType` each operation settles as.
 *
 * Stated once. The bot picks these values in four different services; a Mini App
 * purchase that recorded a different OrderType would be a different row in every
 * financial report, for the same thing.
 */
export const OPERATION_ORDER_TYPE = {
  NEW_PURCHASE: "SERVICE_PURCHASE",
  RENEWAL: "SERVICE_RENEWAL",
  EXTRA_VOLUME: "EXTRA_VOLUME",
  EXTRA_TIME: "EXTRA_TIME",
} as const satisfies Record<CommerceOperation, string>;

/**
 * Which rollout switch must be on to SETTLE each operation.
 *
 * Browsing and drafting are gated separately (see the keys above); this table is
 * only about money moving.
 */
export const OPERATION_SETTLE_ROLLOUT_KEY = {
  NEW_PURCHASE: MINIAPP_WALLET_PURCHASE_ENABLED_KEY,
  RENEWAL: MINIAPP_WALLET_RENEWAL_ENABLED_KEY,
  EXTRA_VOLUME: MINIAPP_WALLET_ADDONS_ENABLED_KEY,
  EXTRA_TIME: MINIAPP_WALLET_ADDONS_ENABLED_KEY,
} as const satisfies Record<CommerceOperation, MiniAppCommerceRolloutKey>;

/**
 * The discount purpose each operation validates codes under.
 *
 * Taken from the bot, which treats extra volume and extra time as PURCHASE for
 * discount semantics and only renewal as RENEWAL. A code restricted to renewals
 * must therefore not apply to an add-on, exactly as today.
 */
export const OPERATION_DISCOUNT_PURPOSE = {
  NEW_PURCHASE: "PURCHASE",
  RENEWAL: "RENEWAL",
  EXTRA_VOLUME: "PURCHASE",
  EXTRA_TIME: "PURCHASE",
} as const satisfies Record<CommerceOperation, "PURCHASE" | "RENEWAL">;

/**
 * Every outcome a renewal operation can report, for both transports.
 *
 * A CLOSED SET, because these values cross a trust boundary: the browser
 * branches on them and the Persian text is chosen client-side from them. An
 * open-ended string would let a server-side message reach the screen unread,
 * which is how internal detail leaks into a UI.
 *
 * Deliberately COARSE on the failure side. `SERVICE_NOT_FOUND` is returned for
 * a malformed id, an unknown id, an ambiguous prefix, a soft-deleted service,
 * a DELETED service and another user's service alike — a caller who can tell
 * those apart can enumerate other people's services one probe at a time.
 */
export const COMMERCE_RESULT_CODES = [
  /** The rollout switch for this surface is off right now. */
  "FEATURE_DISABLED",
  /** No service the caller owns matches, for any reason. Deliberately vague. */
  "SERVICE_NOT_FOUND",
  /** Found and owned, but not in a state or on a panel that can do this. */
  "SERVICE_NOT_ELIGIBLE",
  /** The chosen option is gone, changed, or never applied here. */
  "OPTION_UNAVAILABLE",
  /** The chosen product is hidden, inactive, or not sellable right now. */
  "PRODUCT_UNAVAILABLE",
  /** The referenced checkout draft is missing, foreign, settled or expired. */
  "CHECKOUT_UNAVAILABLE",
  /** The discount code does not apply. One code for every reason it might not. */
  "DISCOUNT_INVALID",
  /** The quote outlived its short window. */
  "QUOTE_EXPIRED",
  /** The quote is still young but the world moved: price, discount or state. */
  "QUOTE_STALE",
  /** The authoritative balance at settlement time is below the final price. */
  "INSUFFICIENT_BALANCE",
  /** The idempotency key was reused with different content. */
  "IDEMPOTENCY_CONFLICT",
  /** Money settled; the panel result is not yet known. Not a failure. */
  "PAYMENT_PENDING",
  /** Money settled; the panel result was uncertain and an operator/worker owns it. */
  "RECONCILIATION_REQUIRED",
  /** Anything unanticipated. Carries nothing about what happened. */
  "INTERNAL",
] as const;

export type CommerceResultCode = (typeof COMMERCE_RESULT_CODES)[number];

/**
 * The codes that mean "the money moved". Used to decide whether a response is
 * a failure the user may retry, or a success whose fulfillment is still
 * settling — the two must never be rendered the same way, because one invites
 * a second click and the other must forbid it.
 */
export const COMMERCE_SETTLED_CODES: readonly CommerceResultCode[] = [
  "PAYMENT_PENDING",
  "RECONCILIATION_REQUIRED",
];

/** True when the code means a charge has already happened. */
export function commerceCodeIsSettled(code: CommerceResultCode): boolean {
  return COMMERCE_SETTLED_CODES.includes(code);
}

/** True when `value` is one of the closed set of result codes. */
export function isCommerceResultCode(value: unknown): value is CommerceResultCode {
  return typeof value === "string" && (COMMERCE_RESULT_CODES as readonly string[]).includes(value);
}

/**
 * How long an authoritative quote may be presented before it must be rebuilt.
 *
 * Short on purpose. A quote freezes a price, a discount and a balance; the
 * longer it lives the more likely it describes a world that no longer exists,
 * and every one of those differences has to be caught again at settlement
 * anyway. Two minutes is long enough to read a confirmation screen and short
 * enough that a tab left open overnight cannot be used to buy at yesterday's
 * price.
 */
export const RENEWAL_QUOTE_TTL_SECONDS = 120;

/**
 * Bytes accepted on a renewal confirmation body.
 *
 * Derived rather than guessed, like the Support Center's limit: the body holds
 * a public service id, a public option id, an opaque quote reference, an
 * idempotency key and the JSON envelope. Nothing here is user prose, so the
 * worst case is bounded by the field lengths themselves. 4 KiB is far above
 * that and far below anything that could be mistaken for an upload.
 */
export const RENEWAL_CONFIRM_BODY_LIMIT_BYTES = 4096;

/**
 * The maximum length of a client-minted idempotency key.
 *
 * Long enough for a uuid or a random 32-byte hex string, short enough that the
 * key cannot become a smuggling channel for content.
 */
export const RENEWAL_IDEMPOTENCY_KEY_MAX_LENGTH = 128;

/** A client idempotency key must be printable ASCII of a sane length. */
export const RENEWAL_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/** True when `value` has the shape of a client-minted idempotency key. */
export function isRenewalIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && RENEWAL_IDEMPOTENCY_KEY_PATTERN.test(value);
}

/**
 * The public identifier of a renewal option.
 *
 * A renewal option IS a Product row, and the Product uuid must never reach the
 * browser, so the option is addressed by the same 8-hex-character prefix
 * convention the Mini App already uses for services. Same reasoning as
 * `serviceShortId`: stable for the row's life, recognisable to an operator
 * holding the uuid, and nothing extra to store.
 */
export const RENEWAL_OPTION_PUBLIC_ID_LENGTH = 8;

export const RENEWAL_OPTION_PUBLIC_ID_PATTERN = /^[0-9a-f]{8}$/i;

/** The public id for a renewal option (a Product). */
export function renewalOptionPublicId(product: { id: string }): string {
  return product.id.slice(0, RENEWAL_OPTION_PUBLIC_ID_LENGTH);
}

/** True when `value` could be a public renewal-option id (format only). */
export function isRenewalOptionPublicId(value: unknown): value is string {
  return typeof value === "string" && RENEWAL_OPTION_PUBLIC_ID_PATTERN.test(value);
}

/**
 * Where a renewal was initiated. Recorded for audit only.
 *
 * The origin says which door the request came through; it must never change
 * what the operation MEANS. A Mini App renewal and a Bot renewal produce the
 * same money movement, the same ledger entry and the same order — if the two
 * ever diverge financially, this field would be the excuse, so it is
 * deliberately confined to the audit trail.
 */
export const RENEWAL_ORIGINS = ["BOT", "MINIAPP"] as const;

export type RenewalOrigin = (typeof RENEWAL_ORIGINS)[number];
