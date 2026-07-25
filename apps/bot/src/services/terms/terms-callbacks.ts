// =============================================================================
// Versioned mandatory terms: the CALLBACK IDENTITY contract (§4).
//
// The old design used one static `terms:accept` for "whatever the terms
// currently are". That is unsafe once terms are versioned: a button rendered
// beside version 3's body would still be honoured after version 4 was
// published, marking the user as having accepted a body they never saw.
//
// Every accept button therefore carries the DOCUMENT it was rendered with:
//
//     user:terms:accept:<8-char document id prefix>
//
// Routing binds to this stable ASCII contract and NEVER to the visible Persian
// label — every label in this feature is operator-editable, so deriving
// behaviour from text would let a text edit silently re-route or disable the
// gate. The short id is resolved with an ambiguity check, so a truncated or
// forged prefix resolves to "stale", never to a different document.
// =============================================================================

/** Kept deliberately short: the whole payload must fit Telegram's 64 BYTES. */
const TERMS_ACCEPT_PREFIX = "user:terms:accept:";

/** Characters of the document uuid carried in callback data. */
const SHORT_ID_LENGTH = 8;

/**
 * `user:terms:accept:` (18 bytes) + 8 hex characters = 26 bytes, less than half
 * of Telegram's 64-byte callback_data budget. Asserted by the test suite so a
 * future prefix change cannot silently overflow it.
 */
export const TERMS_ACCEPT_CALLBACK_MAX_BYTES = 64;

export const TERMS_ACCEPT_PATTERN = /^user:terms:accept:([0-9a-f]{4,36})$/i;

/** Builds the accept callback for ONE specific document. */
export function termsAcceptCallback(documentId: string): string {
  return `${TERMS_ACCEPT_PREFIX}${documentId.slice(0, SHORT_ID_LENGTH)}`;
}

/**
 * True for any accept callback, valid or not. The access gate uses this to skip
 * itself for the accept action (which re-enters the gate after recording), so a
 * MALFORMED accept payload must match here too — otherwise it would be gated
 * into an infinite terms screen instead of reaching the handler that tells the
 * user their button is stale.
 */
export function isTermsAcceptCallback(data: string | undefined): boolean {
  return data !== undefined && data.startsWith(TERMS_ACCEPT_PREFIX);
}

/** The short document id inside a WELL-FORMED accept callback, else null. */
export function parseTermsAcceptCallback(data: string | undefined): string | null {
  if (data === undefined) {
    return null;
  }
  const match = TERMS_ACCEPT_PATTERN.exec(data);
  return match === null ? null : match[1].toLowerCase();
}
