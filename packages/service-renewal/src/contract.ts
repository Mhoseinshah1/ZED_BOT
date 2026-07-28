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
export const RENEWAL_RESULT_CODES = [
  /** The rollout switch is off right now. */
  "RENEWAL_DISABLED",
  /** No service the caller owns matches, for any reason. Deliberately vague. */
  "SERVICE_NOT_FOUND",
  /** Found and owned, but not in a state or on a panel that can be renewed. */
  "SERVICE_NOT_RENEWABLE",
  /** The chosen renewal option is gone, changed, or never applied here. */
  "RENEWAL_OPTION_UNAVAILABLE",
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

export type RenewalResultCode = (typeof RENEWAL_RESULT_CODES)[number];

/**
 * The codes that mean "the money moved". Used to decide whether a response is
 * a failure the user may retry, or a success whose fulfillment is still
 * settling — the two must never be rendered the same way, because one invites
 * a second click and the other must forbid it.
 */
export const RENEWAL_SETTLED_CODES: readonly RenewalResultCode[] = [
  "PAYMENT_PENDING",
  "RECONCILIATION_REQUIRED",
];

/** True when the code means a charge has already happened. */
export function renewalCodeIsSettled(code: RenewalResultCode): boolean {
  return RENEWAL_SETTLED_CODES.includes(code);
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
