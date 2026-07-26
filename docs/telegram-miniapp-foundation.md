# Telegram Mini App: foundation and read-only dashboard

A Persian, right-to-left web panel that opens inside Telegram and shows a user
their wallet balance, their services and their transaction history. It is
**read-only**. Nothing in it buys, renews, pays, opens a ticket or changes a
service; those flows stay in the bot, where the existing business logic,
notifications and audit trail already live.

---

## 1. Why the pieces are where they are

**The bot owns behaviour; the Mini App shows state.** Duplicating a pricing
rule, an eligibility check or a wallet debit in the frontend would create a
second source of truth that drifts from the first one the day someone edits only
one of them. So the Mini App reads rows the bot already wrote and renders them.

**The API must not import the bot.** `apps/api` has no grammY dependency, no
`BotContext` and no message rendering. What the API and the bot share is the
*authority* — the same `Setting` rows and the same tables — not the transport.

**One origin.** The bundle and the JSON API are served by the same process on
the same host. That single decision removes CORS, lets the session cookie stay
`SameSite=Lax`, and means the HTML and the endpoints it calls are always the
same build.

```
Telegram client
   │  opens https://<domain>/miniapp
   ▼
Nginx ──/miniapp──►  API process ──► apps/miniapp/dist   (static bundle)
      └─/api/…────►  API process ──► Prisma ──► PostgreSQL
```

---

## 2. Authentication

### 2.1 What proves who you are

Exactly one thing: the raw, signed `initData` string Telegram puts in the
WebView. `Telegram.WebApp.initDataUnsafe` is never read — it is ordinary page
state that anyone can edit from a console, which is what its name says.

`packages/shared/src/miniapp-initdata.ts` implements Telegram's published
algorithm:

```
secret_key        = HMAC_SHA256(key="WebAppData", data=<bot token>)
data_check_string = "<k>=<v>" for every field except `hash` and `signature`,
                    sorted by key, joined with "\n"
expected          = HMAC_SHA256(key=secret_key, data=data_check_string)
```

Details that are load-bearing:

| Property | Why |
| --- | --- |
| Values are used **exactly as decoded** | Re-encoding or trimming changes the bytes Telegram signed. |
| `signature` is excluded from the HMAC | It is Telegram's newer third-party Ed25519 field; including it breaks every real payload. |
| Duplicate keys are **rejected**, not deduplicated | `URLSearchParams` keeps one of them, which lets an attacker append a second `user=` and have the verifier and the consumer disagree. |
| The hash is length- and alphabet-checked first | `timingSafeEqual` throws on a length mismatch, and an uppercase hash would fail for the wrong reason. |
| Comparison is `timingSafeEqual` | Not `===`. |
| Malformed percent-encoding is refused, never repaired | A parser that "fixes" input is a parser two implementations can disagree about. |
| 8 KiB cap measured in **bytes** | A multi-byte payload must not slip past a check that counted UTF-16 units. |
| Freshness is checked **after** the signature | An unsigned payload must not learn whether its guessed timestamp was plausible. |
| `auth_date` is `\d{1,15}` then `Number.isSafeInteger` | No overflow, no exponent notation, no `Infinity`. |
| The Telegram id is read with a regex + `BigInt` | `JSON.parse` turns it into a double and silently rounds ids above 2^53. |
| The raw `initData` is **never logged** | Not at debug, not on failure. It carries a profile and a valid signature over it. |

Every failure returns a code; the route maps all of them onto one `401
INVALID_INIT_DATA` so the reasons never become an oracle.

### 2.2 The session

`packages/shared/src/miniapp-session.ts`. A signed, stateless token carrying one
fact — which database user this request belongs to — in a cookie:

```
v1.<userId base64url>.<expiry unix seconds>.<HMAC-SHA256 base64url>
```

| Attribute | Value | Reason |
| --- | --- | --- |
| Name | `zb_miniapp` | |
| `Path` | `/api/miniapp` | Never attached to payment webhooks, `/health` or `/version`. |
| `HttpOnly` | always | JavaScript cannot read it, so an XSS cannot steal it. |
| `SameSite` | `Lax` | Same-origin app; `None` would weaken CSRF posture for nothing. |
| `Secure` | when the request arrived over https | Follows `X-Forwarded-Proto`. In **production a session is not minted at all** over plain HTTP (`403 INSECURE_TRANSPORT`) — a cookie issued there could not carry `Secure` and would ride every later plaintext request. Outside production the flag simply follows the scheme, so local http still works. |
| Lifetime | 15 minutes (clamped to 60 s – 60 min) | |

The key is derived from `APP_SECRET` through scrypt with its own context string
(`zedbot.miniapp.session.v1`), so it cannot collide with the key space
`crypto.ts` uses for stored secrets, and it is **not** derived from the bot
token — rotating one must not force rotating the other.

There is no session table. At a 15-minute lifetime it would need migrating,
sweeping and reconciling to store something the signature already carries.

The cookie is deliberately **not** a permission cache and **not** a profile: no
status, no group, no name, no Telegram id. Access is re-evaluated from the
authoritative row on every request, so a cookie minted a second before someone
was blocked stops working on their next call.

### 2.3 CSRF

`SameSite=Lax` already stops a cross-site POST from carrying the cookie, so
logout CSRF is dead on arrival. What Lax does **not** stop is *login* CSRF: an
attacker POSTing their own valid `initData` to sign a victim into the attacker's
account. Both POST routes therefore check `Origin` against the allowlist derived
from `MINIAPP_PUBLIC_URL`, and reject a `Sec-Fetch-Site` of `cross-site` or
`same-site` outright.

A request with **no** `Origin` is allowed. That is not a gap: browsers always
send `Origin` on a cross-origin POST, so a request without one is by
construction not a cross-origin browser request, and rejecting it would only
break curl and health probes.

---

## 3. Access policy

`apps/api/src/miniapp/access-policy.ts`. Evaluated on **every** authenticated
request, in the same order the bot uses.

| # | Gate | Denied code | HTTP | Cleared in the bot? |
| --- | --- | --- | --- | --- |
| 1 | `maintenance_mode` | `MAINTENANCE` | 503 | – |
| 2 | user row missing or `DELETED` | `USER_UNAVAILABLE` | 403 | yes |
| 2 | status `BLOCKED` | `USER_BLOCKED` | 403 | yes |
| 2 | any status other than `ACTIVE` | `USER_DISABLED` | 403 | yes |
| 3 | `terms_required` + unaccepted published `TermsDocument` | `TERMS_REQUIRED` | 428 | **yes** |
| 4 | `force_join_enabled` + ≥1 active channel, no bypass | `FORCE_JOIN_REQUIRED` | 403 | **yes** |
| – | any gate that could not be read | `ACCESS_CHECK_UNAVAILABLE` | 503 | – |

**Fail closed.** A read that throws returns a retryable code rather than a
verdict. A helper that swallowed the error and returned its fallback would make
a database blip indistinguishable from "maintenance is off", and would wave
through exactly the request the gate exists to stop.

**Force-join is the one gate the API cannot clear.** The bot verifies membership
by calling Telegram's `getChatMember`; the API must not talk to the Bot API, a
frontend claim of "I joined" is worth nothing, and there is no durable per-user
membership row to consult (the bot caches its verdict in Redis, which is a cache
and not an authority). So an armed gate returns `FORCE_JOIN_REQUIRED` with
`requiresBot: true` and the frontend offers an "open the bot" action. The worst
case is telling an already-joined user to tap through the bot once.

**Unknown users are never created.** Registration happens in the bot, where
terms, referral attribution and force-join are established. A Mini App visitor
with no row gets `403 NOT_REGISTERED` and a link to `/start`.

---

## 4. The read-only API

All routes are under `/api/miniapp`. Every response carries `Cache-Control:
no-store`, `X-Content-Type-Options: nosniff` and `Vary: Cookie`, and **no**
`Access-Control-Allow-Origin` — its absence is the CORS policy.

| Method | Path | Returns |
| --- | --- | --- |
| POST | `/auth` | Sets the session cookie; returns the profile. |
| POST | `/logout` | Clears the cookie. Always succeeds. |
| GET | `/me` | The signed-in user's profile. |
| GET | `/dashboard` | Balance, service counts by status, expiring-soon count, 3 recent services, 5 recent transactions. |
| GET | `/services` | Keyset page of the caller's services. |
| GET | `/services/:serviceId` | One service the caller owns. |
| GET | `/wallet/transactions` | Keyset page of the caller's ledger. |

### 4.1 What never crosses the boundary

Responses are built from **allowlists**, never from a spread of a Prisma row —
so a column added tomorrow cannot leak by default.

| Withheld | Because |
| --- | --- |
| `subscriptionUrl`, `subscriptionToken`, `configLinks`, `remoteClientId`, `remoteInboundIds` | These *are* the service. Anyone holding them has the connection, no account required. |
| `panelId`, panel `baseUrl`, panel credentials | Infrastructure. A user needs a display name, never an address. |
| `failureReason`, `adminNote`, `note` | Operator free-text, written for staff. `userNote` — the buyer's own note — does come back. |
| `namingStrategySnapshot`, `remoteMetadata`, `capabilitySnapshot` | Internal structures whose shape is not a public contract. |
| `WalletTransaction.reason`, `adminId`, related ids | `reason` is operator text on manual adjustments; type + source already say what happened. |
| `telegramId` | The client already knows who it is; returning it puts a stable cross-service identifier in a response body for no gain. |

BigInt columns are emitted as decimal **strings**: `JSON.stringify` throws on a
BigInt, and `Number` would round a large plan's byte count.

### 4.2 Pagination

Keyset, never offset. Both paginated tables grow without bound; `OFFSET n` makes
the database walk and discard `n` rows, so the last page of a long ledger costs
the most — exactly backwards — and an insert between two requests shifts every
subsequent offset, so a scrolling user sees a row twice or misses one.

The predicate is a written-out row-value comparison, `(createdAt, id) <
(:createdAt, :id)`. The `id` tie-break matters: two rows created in the same
millisecond are common under load, and without it one of them is skipped or
repeated at a page boundary.

Cursors are **signed** (`apps/api/src/miniapp/cursor.ts`). They go straight into
a query, so an unsigned one is an invitation to hand-craft values and probe; the
signature also lets a tampered cursor be refused with a clean `400` instead of
surfacing as a confusing empty page. A cursor is a **position, not an
authority** — every query is scoped by the session's user id regardless of what
the cursor says.

Page size defaults to 20 and is clamped to 50. One extra row is fetched to
answer "is there another page?" without a second `COUNT`.

### 4.3 Rate limiting

`POST /auth` performs an HMAC and a database lookup for anyone who asks, so it
is bounded: a fixed-window counter, five per minute per client by default
(`MINIAPP_AUTH_RATE_LIMIT`), checked **before** any cryptographic or database
work. The key is a salted SHA-256 of the client address, never the address
itself — a rate-limit map is durable state for as long as the window lasts.

It is in-process, not Redis: this bounds abuse of one replica's CPU, and routing
the check through a network round-trip would add a dependency whose failure mode
is "the login endpoint stops working".

---

## 5. The frontend

`apps/miniapp` — React 19 + Vite 7 + TypeScript, Persian, RTL.

Eight screens: splash, outside-Telegram, dashboard, service list, service
detail, wallet history, profile, and the failure screen every error path lands
on.

- **No token anywhere, and nowhere to put one.** The session is an HttpOnly
  cookie the script cannot read; requests carry it with `credentials:
  "same-origin"`. Nothing is written to `localStorage` or `sessionStorage`, so
  an XSS that would otherwise exfiltrate a stored token has nothing to take.
- **Errors are codes.** The server sends no prose, so nothing server-authored is
  ever rendered; the Persian text is chosen locally from a closed set, and an
  unknown code collapses to a generic internal failure.
- **RTL is a document property** (`dir="rtl"` plus logical CSS properties), not a
  pile of `left`/`right` overrides.
- **Telegram's theme** is copied into CSS custom properties after each value is
  validated as a colour literal.
- **No web font, one external script.** `https://telegram.org/js/telegram-web-app.js`
  is required: the native mobile clients inject `window.Telegram` themselves,
  but Telegram Desktop and Telegram Web run a Mini App in an *iframe* where
  nothing is injected.

### 5.1 Static assets

| Rule | How |
| --- | --- |
| Content-hashed filenames | Vite `rollupOptions.output.*FileNames` |
| Works under `/miniapp/`, no root-relative paths | Vite `base: "/miniapp/"` |
| `index.html` → `Cache-Control: no-store` | it names the current hashed bundles |
| hashed assets → `public, max-age=31536000, immutable` | a changed file gets a new name, so a stale copy is impossible |
| no user data, no secrets at build time | the bundle is one artifact served to everyone |
| only explicitly public `VITE_*` values | `VITE_BOT_USERNAME` (a public handle) is the only one read |

There is **no service worker** in this change.

### 5.2 SPA fallback

Confined to `/miniapp`, and decided by the API rather than by Nginx, so the two
cannot disagree:

- `/miniapp`, `/miniapp/`, `/miniapp/<frontend route>` → `index.html`, `no-store`
- `/miniapp/assets/<missing>.js`, anything whose last segment has a dot → **404**
- `/miniapp/api/...` → **404**, never HTML
- traversal / encoded-traversal → **404**

A blanket "serve index.html for everything under /miniapp" would answer 200 with
HTML for a missing bundle file, and the browser would try to execute a document
as JavaScript — turning a half-deployed bundle into a mystifying syntax error.

---

## 6. Nginx: one framing exception

Telegram Desktop and Telegram Web render a Mini App inside an **iframe**. The
site-wide `X-Frame-Options: DENY` makes it a blank box on both, so `/miniapp`
gets an exception — and only `/miniapp`.

The mechanism is Nginx's own inheritance rule: **a location that declares any
`add_header` inherits none from its server block.** That is what removes `DENY`
here, and it is also what would silently remove `nosniff`, `Referrer-Policy` and
HSTS if they were not written out again. They are.

```nginx
location ~ ^/miniapp(/|$) {
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    # X-Frame-Options intentionally absent; frame-ancestors below is the authority.
    add_header Content-Security-Policy "…" always;
    proxy_pass http://127.0.0.1:3000;   # no URI part: the path is never rewritten
    …
}
```

### 6.1 Header matrix

| Route | X-Frame-Options | CSP | nosniff | Referrer-Policy | HSTS |
| --- | --- | --- | --- | --- | --- |
| `/` | `DENY` | – | ✓ | ✓ | ✓ |
| `/api/…` | `DENY` | – | ✓ | ✓ | ✓ |
| `/api/miniapp/…` | `DENY` | – | ✓ | ✓ | ✓ |
| payment callbacks | `DENY` | – | ✓ | ✓ | ✓ |
| `/health`, `/version` | `DENY` | – | ✓ | ✓ | ✓ |
| `/miniapp`, `/miniapp/*` | **absent** | ✓ | ✓ | ✓ | ✓ |

Verified against a live Nginx, not only against the rendered text: every
path-confusion variant (`/miniapp/../api/miniapp/me`, `/miniapp/..%2fapi/…`,
`//miniapp/../api/…`, `/miniappfoo`) resolves into `location /` and keeps
`DENY`.

`X-Content-Type-Options` appears **twice** on Mini App responses — once from the
API, once from Nginx — both exactly `nosniff`. The browser reads the first value
and applies it, so the duplicate is inert, and it is deliberate: Nginx is the
backstop if the API ever stops sending it, and the API's own copy protects local
development where there is no edge.

### 6.2 The policy

```
default-src 'self';
script-src 'self' https://telegram.org;
style-src 'self';
img-src 'self' data:;
font-src 'self';
connect-src 'self';
frame-ancestors https://web.telegram.org https://webk.telegram.org https://webz.telegram.org;
base-uri 'none';
form-action 'none';
object-src 'none'
```

- `frame-ancestors` names Telegram's web clients explicitly. `web.telegram.org`
  serves both the K and A clients; `webk.` and `webz.` are the standalone hosts
  Telegram also serves them from. No wildcard, no `*`, no OWNER-supplied raw
  string.
- The **native** Android, iOS and desktop clients open a Mini App as a
  *top-level document*, where `frame-ancestors` does not apply at all — so this
  list cannot affect them.
- `script-src` names `telegram.org` because the WebApp bridge is loaded from
  there (§5). There is no other third-party origin.
- **No `unsafe-eval` and no `unsafe-inline`.** The bundle ships its CSS as a
  file, and dynamic styles are set through the CSSOM (`element.style`), which
  CSP does not restrict. A test asserts the built `index.html` carries no inline
  `<style>` and no `style=` attribute.
- `base-uri 'none'` and `form-action 'none'`: the app has no `<base>` and no
  form, so both are locked rather than merely narrowed.

**One authoritative CSP.** Nginx sends it; Fastify does not, and the document
ships no `<meta http-equiv>` policy — a second policy would *intersect* with the
header into a combined policy nobody wrote.

### 6.3 Path confusion

- The location regex `^/miniapp(/|$)` matches `/miniapp` and `/miniapp/…` and
  nothing adjacent — not `/miniappfoo`, not `/api/miniapp/…`.
- `proxy_pass` carries **no URI part**, so the request path reaches the API
  verbatim. A trailing path would replace the matched prefix and could let
  `/miniapp/api/miniapp/me` land on the JSON API carrying the relaxed headers.
- Nginx normalises `.` and `..` **before** matching, so
  `/miniapp/../api/miniapp/me` resolves to `/api/miniapp/me` and lands in
  `location /` with the strict headers.
- Nothing in the location maps a URL onto a filesystem path (no `root`, no
  `alias`), so there is no path to traverse.

---

## 7. Deployment

### 7.1 Configuration

| Variable | Purpose |
| --- | --- |
| `MINIAPP_PUBLIC_URL` | Public https URL, normally `https://<APP_DOMAIN>/miniapp`. **Empty disables the Mini App** — the bot hides its entry button. |
| `MINIAPP_ALLOWED_ORIGINS` | Extra origins allowed to POST to auth/logout. Only for multi-hostname deployments. |
| `MINIAPP_AUTH_RATE_LIMIT` | Auth attempts per minute per client (default 5). |
| `MINIAPP_DIST_DIR` | Overrides where the API looks for the built bundle. |
| `VITE_BOT_USERNAME` | Public bot handle compiled into the bundle for its "open the bot" link. Build-time. |

`APP_SECRET` must be set: without it the session cannot be signed, and the code
throws rather than falling back to an unkeyed token.

### 7.2 Bot entry

`/app` and the `user:miniapp` callback, both dispatched through the same gated
user area as `/menu`. Deliberately separate from the main menu: that menu
renders from one definition feeding both an inline and a reply keyboard, and a
reply keyboard cannot carry a `web_app` button.

Gated on configuration rather than a database flag — Telegram rejects a
`web_app` button whose URL is not https and rejects the whole keyboard with it,
so a misconfiguration must yield a missing button, not an unrenderable menu.

### 7.3 Docker

The build stage builds the bundle; the runtime stage copies
`apps/miniapp/dist` into the image alongside the API. `--prod` install skips
React and Vite, so the runtime image carries no frontend toolchain.

`VITE_BOT_USERNAME` is a build **arg** because Vite inlines `VITE_*` at build
time. It is public: build args are recorded in image history, which is why no
secret may ever become one.

### 7.4 Smoke test

```
./scripts/miniapp-smoke.sh https://your-domain
```

Five read-only GETs. Verifies the header matrix on a live deployment — the one
thing a config test cannot, since `add_header` inheritance is easy to break with
an unrelated edit and the failure is silent. Needs no Telegram client and no
credentials.

---

## 8. Privacy

Never logged: raw `initData`, the Telegram user object, the session cookie, the
bot token, service secrets, wallet history payloads, or a full client IP. The
rate limiter stores a salted hash of the address rather than the address.

Auth failures log a reason **code** and nothing else. Read failures log the
error message with no request payload and no user identity.

---

## 9. Tests

| Suite | File | Cases |
| --- | --- | --- |
| initData validation | `apps/api/tests/miniapp-initdata.test.ts` | M01–M16 |
| Session token & cookie | `apps/api/tests/miniapp-session.test.ts` | M17–M26 |
| API isolation, gates, pagination | `apps/api/tests/miniapp-api.test.ts` | M27–M54 |
| Static serving & SPA fallback | `apps/api/tests/miniapp-static.test.ts` | N05b, N07–N09 |
| Nginx config & smoke script | `apps/bot/tests/miniapp-nginx.test.ts` | N01–N15 |
| Bot entry point | `apps/bot/tests/miniapp-entry.test.ts` | B01–B06 |
| Frontend formatting & client | `apps/miniapp/tests/` | F01–F20 |

The API suite needs a migrated PostgreSQL (`DATABASE_URL`); without it it skips
itself. The Nginx suite runs a real `nginx -t` when the binary is present and
says so in the output when it is not — a skipped syntax check must not read as a
passing one.
