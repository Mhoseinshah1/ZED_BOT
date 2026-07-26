import { optionalEnv } from "@zedbot/shared";

// =============================================================================
// Which forwarding headers this API is allowed to believe.
//
// Fastify computes `request.ip` from the socket peer unless `trustProxy` says
// otherwise. In this deployment the socket peer is ALWAYS the local Nginx hop,
// so without `trustProxy` every real user in the world shares one address —
// and therefore one rate-limit bucket. The first person to sign in five times
// in a minute locks out everybody else.
//
// The fix is not `trustProxy: true`. That would believe whatever any caller
// wrote in `X-Forwarded-For`, turning the rate limiter into decoration: an
// attacker rotates the header and gets an unlimited number of buckets. What is
// needed is a trusted-hop LIST, which makes Fastify (via `proxy-addr`) walk the
// forwarded chain from the server end and stop at the first address that is not
// a trusted hop:
//
//   socket = <nginx>, XFF = "<forged>, <real client>"
//     → <nginx> trusted, skip
//     → <real client> not trusted, STOP. request.ip = the real client.
//
// The forged prefix sits to the LEFT of the real address and is never reached,
// because Nginx appends the peer it actually saw
// (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`). A caller
// that reaches the API directly, without passing through a trusted hop, has an
// untrusted socket address, so its forwarding headers are ignored outright.
//
// WHY THE DEFAULT IS NOT LOOPBACK ALONE. In production this API runs in a
// container whose port is published on `127.0.0.1` and proxied to by Nginx on
// the host. Inside the container the peer address is the Docker bridge gateway
// — a private address, not `127.0.0.1`. Trusting only loopback would therefore
// leave the exact bug this fixes in place on every real deployment while
// looking correct in local development. The default is loopback plus the
// private/link-local ranges a container-local hop can legitimately have.
//
// That is safe here because those ranges are not routable from the Internet: a
// packet arriving from outside cannot carry a private source address, so no
// remote attacker can present themselves as a trusted hop. Combined with the
// compose file binding the port to `127.0.0.1` only, the API is never directly
// reachable from off-host.
//
// `API_TRUSTED_PROXIES` overrides it for anything unusual (a proxy on a
// dedicated public address, or `none` to trust nothing at all).
// =============================================================================

/**
 * Loopback, link-local, and the RFC1918 / RFC4193 unique-local ranges.
 *
 * These are `proxy-addr`'s built-in presets, which Fastify passes through
 * unchanged. Naming the presets rather than writing CIDRs keeps IPv4 and IPv6
 * in step (`::1`, `fe80::/10`, `fc00::/7` are all covered).
 */
export const API_DEFAULT_TRUSTED_PROXIES = "loopback, linklocal, uniquelocal";

/**
 * The value handed to Fastify's `trustProxy`.
 *
 * `false` means "trust nothing": `request.ip` is the socket peer and every
 * forwarding header is ignored. Any other value is a proxy-addr trust list.
 */
export type TrustProxyConfig = false | string;

/**
 * Resolves the trusted-hop list from the environment.
 *
 * Returns `false` for an explicit opt-out (`none`, `off`, `false`) so a
 * deployment that terminates TLS directly on this process is not silently
 * trusting headers it should not. An empty/unset value takes the documented
 * default above.
 *
 * Deliberately NOT accepted: `true`, `yes`, `all`, `*`, or a bare hop count.
 * Every one of them means "believe an arbitrary sender", which is the failure
 * this module exists to prevent — so they are refused and the safe default is
 * used instead. A hop count is refused for the same reason: it trusts the Nth
 * entry of an attacker-extensible list.
 */
export function apiTrustedProxies(
  raw = optionalEnv("API_TRUSTED_PROXIES", ""),
): TrustProxyConfig {
  const value = raw.trim();
  if (value === "") {
    return API_DEFAULT_TRUSTED_PROXIES;
  }
  const lowered = value.toLowerCase();
  if (lowered === "none" || lowered === "off" || lowered === "false") {
    return false;
  }
  if (
    lowered === "true" ||
    lowered === "yes" ||
    lowered === "all" ||
    lowered === "*" ||
    /^\d+$/.test(lowered)
  ) {
    // Trusting "everything" or "N hops" is never a correct answer here.
    return API_DEFAULT_TRUSTED_PROXIES;
  }
  return value;
}
