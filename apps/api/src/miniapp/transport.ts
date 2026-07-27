import type { FastifyRequest } from "fastify";

// =============================================================================
// THE secure-transport decision.
//
// Two things depend on whether the BROWSER reached us over TLS: production
// refuses to mint a session over plaintext, and the session cookie's `Secure`
// flag follows the real scheme (a `Secure` cookie issued over http is silently
// dropped by the browser, which looks like an unexplained login loop). Behind
// Nginx the socket is plaintext either way, so the answer necessarily comes
// from a forwarding header — which makes it a SECURITY decision about whom to
// believe, not a string comparison.
//
// Reading `X-Forwarded-Proto` off the request is the wrong way to make it:
//
//   * the header is present on ANY request, including one that reached the
//     container directly without passing a trusted hop, so a caller can simply
//     assert `https` and be treated as secure;
//   * the FIRST comma-separated entry is the CLIENT-supplied end of the chain.
//     A caller sending `https, http` has the value the client wrote win over
//     the value the nearest proxy appended — backwards.
//
// `request.protocol` answers the same question through the configured
// trusted-proxy policy (`API_TRUSTED_PROXIES`, see `trusted-proxy.ts`). Fastify
// consults the header ONLY when the socket peer is itself a trusted hop, and
// takes the LAST entry — the one appended by that hop. Untrusted peer, or no
// trust list at all, and it falls back to `socket.encrypted`, which cannot be
// spoofed at all. One rule, one place, no second opinion.
// =============================================================================

/**
 * True when the browser's connection to the edge was TLS, as decided by the
 * configured trusted-proxy chain.
 *
 * The scheme is matched case-insensitively: `protocol` is returned verbatim
 * from the header, and URI schemes are case-insensitive (RFC 3986 §3.1), so a
 * proxy that writes `HTTPS` must not be read as plaintext.
 */
export function isSecureRequest(request: Pick<FastifyRequest, "protocol">): boolean {
  const protocol: unknown = request.protocol;
  return typeof protocol === "string" && protocol.toLowerCase() === "https";
}
