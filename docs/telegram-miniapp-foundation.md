# Telegram Mini App: foundation, read-only dashboard and Support Centre

A Persian, right-to-left web panel that opens inside Telegram and shows a user
their wallet balance, their services and their transaction history. Those
surfaces are **read-only**: nothing in them buys, renews, pays or changes a
service, and those flows stay in the bot, where the existing business logic,
notifications and audit trail already live.

There is exactly **one** write surface, added deliberately and bounded on
purpose: the **Support Centre** (§4.8), where a user opens a ticket and posts a
reply. Text only — no upload, no attachment download — and every write carries a
client-minted idempotency key so a retry cannot open a second ticket. Everything
else about a ticket (assignment, closing, files, admin notifications) still
happens in the bot.

Read-only is not a dead end either. Every screen that raises an action — buying,
charging the wallet, renewing or managing a service, contacting support — offers
it as a button that **opens the configured bot and does nothing else** (§4.7).

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
bot-token algorithm:

```
secret_key        = HMAC_SHA256(key="WebAppData", data=<bot token>)
data_check_string = "<k>=<v>" for every received field EXCEPT `hash`,
                    sorted by key, joined with "\n"
expected          = HMAC_SHA256(key=secret_key, data=data_check_string)
```

#### Which fields each validation mode covers

Telegram publishes **two** schemes over the same payload, and they exclude
different fields. Confusing them yields code that looks correct and rejects
every real user:

| Mode | Excluded fields | Prefix | Key | Used here |
| --- | --- | --- | --- | --- |
| **Bot-token HMAC-SHA256** | `hash` only — `signature` **is signed** | none | `HMAC_SHA256("WebAppData", <bot token>)` | Yes — this is the server's authentication |
| **Third-party Ed25519** | `hash` **and** `signature` | `"<bot_id>:WebAppData\n"` | Telegram's public key | No — the server holds the bot token, so it has no reason to. `buildThirdPartyCheckString` exists only so the difference is executable and a test can hold the two apart. |

Every modern Telegram client sends `signature`. Excluding it from the bot-token
HMAC therefore fails **all** production traffic, not an edge case — which is why
the suite pins the rule with four fixed `initData` vectors published by two
unrelated projects (aiogram and telegram-apps), together with the bot tokens
that signed them. Those hashes are literals from other codebases, so no mistake
here can agree with them. `M22` additionally verifies a genuine Telegram
`signature` against Telegram's published production Ed25519 public key over the
*third-party* check string, and shows the bot-token construction fails that same
verification — proof the two rules are distinct rather than merely asserted.

Details that are load-bearing:

| Property | Why |
| --- | --- |
| Values are used **exactly as decoded** | Re-encoding or trimming changes the bytes Telegram signed. |
| `+` becomes a space **before** percent-decoding | Telegram signs the decoded value; the published aiogram vector pins this. |
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
| `Secure` | when the request arrived over https | Decided by `request.protocol` through the configured trusted-proxy chain — see §4.4. In **production a session is not minted at all** over plain HTTP (`403 INSECURE_TRANSPORT`) — a cookie issued there could not carry `Secure` and would ride every later plaintext request. Outside production the flag simply follows the scheme, so local http still works. |
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
| 4 | `force_join_enabled` + ≥1 active channel, no bypass, **and a live check says the user is not a member** | `FORCE_JOIN_REQUIRED` | 403 | **yes** |
| – | any gate that could not be read | `ACCESS_CHECK_UNAVAILABLE` | 503 | – |

**Fail closed.** A read that throws returns a retryable code rather than a
verdict. A helper that swallowed the error and returned its fallback would make
a database blip indistinguishable from "maintenance is off", and would wave
through exactly the request the gate exists to stop.

**Force join is checked for real, and is satisfiable.** An earlier design
answered `FORCE_JOIN_REQUIRED` whenever the gate was *armed*, without ever
establishing membership. That is not a stricter gate — it is a broken one: a
user who joined every channel and verified it in the bot was refused by the Mini
App forever, with no action available anywhere that could clear it.

The API now performs a **live `getChatMember` for every currently active
required channel**, through the same decision procedure the bot uses. What is
shared is everything that decides the answer; what differs is only how the call
leaves the process:

| Part | Where it lives |
| --- | --- |
| decision procedure, Redis verdict cache, Telegram error classification, bounded channel-health policy | `@zedbot/force-join`, shared by both processes |
| Telegram transport | **injected per process** — grammY's `ctx.api` in the bot, a plain fetch client in the API, because grammY must not enter `apps/api` |

| Situation | Result |
| --- | --- |
| member of every active required channel | allowed |
| not a member of some active required channel | `FORCE_JOIN_REQUIRED` (403, `requiresBot: true`) |
| operator `forceJoinBypass` | allowed, with no Telegram traffic at all |
| transient Telegram failure, unreadable setting or channel list, no bot token in this process | `ACCESS_CHECK_UNAVAILABLE` (503) — uncertainty, never an accusation |
| every active channel permanently unverifiable | allowed — the bot's D4 rule, so a broken configuration cannot brick users; the retirement is recorded durably and alerted |
| switch off, or on with zero active channels | allowed, no Telegram traffic |

Two properties are worth stating because they are what make the gate meaningful:

- **Nothing the frontend says is consulted.** There is no "I joined" claim to
  trust, and no membership fact is cached in the session — every request
  re-derives the verdict from the authority.
- **Redis is a bounded cache, not the authority.** It holds short-lived verdicts
  so a page reload does not hammer the Bot API; it never *supplies* an answer
  the Bot API has not given. The Mini App has no "بررسی عضویت" button, so a user
  who just joined clears the short negative TTL on their next request, exactly as
  the bot's middleware does.

The gate still fails **closed** on uncertainty: `ACCESS_CHECK_UNAVAILABLE` is
retryable and is never rendered as "you are not a member".

**Unknown users are never created.** Registration happens in the bot, where
terms, referral attribution and force-join are established. A Mini App visitor
with no row gets `403 NOT_REGISTERED` and a link to `/start`.

---

## 4. The API

All routes are under `/api/miniapp`. Every response carries `Cache-Control:
no-store`, `X-Content-Type-Options: nosniff` and `Vary: Cookie`, and **no**
`Access-Control-Allow-Origin` — its absence is the CORS policy.

| Method | Path | Returns |
| --- | --- | --- |
| POST | `/auth` | Sets the session cookie; returns the profile. |
| POST | `/logout` | Clears the cookie. Always succeeds. |
| GET | `/me` | The signed-in user's profile, **plus active and total visible-service counts** (§4.6). |
| GET | `/dashboard` | `serverTimestamp` and `dataFreshnessTimestamp` (§4.6), balance, service counts by status, expiring-soon count (strictly future expiries only), up to **5** recent services, up to **5** recent transactions. |
| GET | `/services` | Keyset page of the caller's services. |
| GET | `/services/:publicId` | One service the caller owns, addressed by its 8-character public id (§4.5). |
| GET | `/wallet/transactions` | Keyset page of the caller's ledger. |
| GET | `/support/summary` | `{ total, open, waitingUser, closed }` for the caller's tickets (§4.8). |
| GET | `/support/tickets` | Keyset page of the caller's tickets, newest-updated first. |
| GET | `/support/tickets/:publicId` | One ticket the caller owns, plus `canReply`, `hasAttachments`, `closedAt`, `serviceId`. |
| GET | `/support/tickets/:publicId/messages` | Keyset page of a thread. Oldest-first **within** a page; the cursor walks **backwards** to older messages. |
| POST | `/support/tickets` | **Write.** Opens a ticket; `201` with the ticket. |
| POST | `/support/tickets/:publicId/replies` | **Write.** Appends a user reply; `201` with the updated ticket. |
| GET | `/commerce/flags` | The five wallet-commerce rollout switches as booleans, read fresh; missing rows are disabled (§4.9). |
| GET | `/commerce/catalog` | The caller's service catalog (panels → categories → products), visibility-filtered by the shared domain predicate (§4.9). |
| POST | `/commerce/quote` | **Write.** Atomically reserves the chosen username, creates the one durable pending checkout, and returns its authoritative sealed wallet quote (§4.9). |
| POST | `/commerce/checkout` | Re-opens a sealed quote and returns its owner-scoped checkout. |
| GET | `/commerce/checkouts/:publicId` | One checkout the caller owns, by 8-character public id. |
| POST | `/commerce/pay/wallet` | **Write.** Pays a quoted draft from the wallet — the bot's atomic CAS deduction, ledger row, payment and order in ONE transaction; `201` with the paid checkout (§4.9). |
| GET | `/commerce/payments/:publicId` | Owner-scoped status for the wallet payment and linked order/service. |
| GET | `/commerce/services/:publicId/delivery` | Owner-safe delivery: username, status, subscription URL, config links (≤10). Gated by `miniapp_service_delivery_enabled`. |
| GET | `/commerce/services/:publicId/qr` | Server-rendered PNG QR (`target=sub` or `target=config&index=n`) via the bot's own generator. |
| GET | `/commerce/services/:publicId/addons` | Renewal plans + extra-volume/time packages: per-add-on switches AND the bot's real eligibility (renewableWhere / lifecycle / group). |
| POST | `/commerce/services/:publicId/addon-quote` | Authoritative add-on pre-invoice (+ sealed draft token); discount purpose RENEWAL for renewals, PURCHASE for extras — the bot's rule. |
| GET | `/commerce/history` | Unified orders + order-less payments, the bot's own 10/page merge. |
| GET | `/commerce/payments?page=n` | Payment history list. |
| GET | `/commerce/orders/:publicId` | Order detail linking payment / service / checkout public ids + reconciliation flag. |

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
| `Service.id`, `WalletTransaction.id` (the database uuids) | Internal handles that also appear in operator logs, support transcripts and admin screens, so putting one in a page or a URL correlates those contexts for anyone who sees both. Services carry the short **public id** instead (§4.5); ledger rows carry no id at all, because nothing addresses one. |

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

Cursors are **sealed**, not merely signed (`apps/api/src/miniapp/cursor.ts`).
The payload is encrypted with AES-256-GCM under a key derived from `APP_SECRET`,
and the client receives ciphertext.

Signing alone would have been the wrong bar. The tie-breaker in that sort key
**is** the row's database uuid — there is no other unique, stable column to
break a millisecond tie with — so a signed-but-readable cursor hands out a
base64 uuid on the second page of any list: exactly the identifier §4.5 goes out
of its way not to expose, arriving through the back door. Signing stops forgery;
it does nothing about disclosure.

Each cursor is also **bound to its collection**: the collection name is the
AEAD's additional data, so a services cursor replayed against the wallet ledger
fails to decrypt and is refused with a clean `400` rather than silently moving
the wrong window. Tampering fails the same way — the GCM tag does not verify —
so a mangled cursor is a `400` instead of a confusing empty page.

A cursor is a **position, not an authority** — every query is scoped by the
session's user id regardless of what the cursor says.

Page size defaults to 20 and is clamped to 50. One extra row is fetched to
answer "is there another page?" without a second `COUNT`.

### 4.3 Rate limiting

`POST /auth` performs an HMAC and a database lookup for anyone who asks, so it
is bounded: a fixed-window counter, five per minute per client by default
(`MINIAPP_AUTH_RATE_LIMIT`), checked **before** any cryptographic or database
work. The key is a salted SHA-256 of the client address, never the address
itself — a rate-limit map is durable state for as long as the window lasts.

#### Which address is "the client"

"Per client" is only true if `request.ip` is the client. Behind Nginx the socket
peer is the proxy, identical for everyone, so without `trustProxy` the limit is
**global**: one person signing in five times locks out the entire user base.

Fastify is therefore configured with a trusted-hop **list**
(`apps/api/src/miniapp/trusted-proxy.ts`), never `trustProxy: true`. The list
makes `proxy-addr` walk `X-Forwarded-For` from the server end and stop at the
first entry that is not a trusted hop:

| Socket peer | `X-Forwarded-For` | `request.ip` | Why |
| --- | --- | --- | --- |
| local hop | `203.0.113.10` | `203.0.113.10` | the hop is trusted, so its appended value is believed |
| local hop | `<forged>, 203.0.113.10` | `203.0.113.10` | Nginx appends the peer it saw; the forgery sits to the left and is never reached |
| `198.51.100.7` (direct) | `203.0.113.10` | `198.51.100.7` | nothing trusted in the path, so the header is ignored entirely |

The default (`API_TRUSTED_PROXIES`) is `loopback, linklocal, uniquelocal` rather
than loopback alone. In production this API runs in a container whose port is
published on `127.0.0.1` and proxied to by Nginx **on the host**, so inside the
container the peer is the Docker bridge gateway — a private address. Trusting
only loopback would leave the global-bucket bug in place on every real
deployment while passing local tests. Those ranges are not routable from the
Internet, so no remote caller can present itself as a trusted hop.

Values meaning "trust everyone" (`true`, `all`, `*`, a hop count) are refused
and fall back to the default; `none` trusts nothing. The resolved list is logged
at startup, because a misconfiguration here is otherwise invisible until a rate
limit misbehaves.

It is in-process, not Redis: this bounds abuse of one replica's CPU, and routing
the check through a network round-trip would add a dependency whose failure mode
is "the login endpoint stops working".

### 4.4 Which transport is "secure"

Behind Nginx the socket is plaintext either way, so "did the browser use TLS?"
can only be answered from a forwarding header — which makes it a question about
**whom to believe**, not a string comparison. Reading `X-Forwarded-Proto` off
the request answers it wrong twice over: the header is present on any request,
including one that never passed a trusted hop, so a caller can simply assert
`https`; and the first comma-separated entry is the *client-supplied* end of the
chain, so `https, http` lets the caller's claim beat what the nearest proxy
appended.

There is therefore exactly one secure-transport decision
(`apps/api/src/miniapp/transport.ts`), and it reads Fastify's
`request.protocol`, which consults the header **only** when the socket peer is
itself a trusted hop (§4.3's list) and takes the **last** entry — the one that
hop appended. Untrusted peer, or no trust list at all, and it falls back to
`socket.encrypted`, which cannot be spoofed.

| Socket peer | `X-Forwarded-Proto` | Secure? |
| --- | --- | --- |
| trusted hop | `https` | yes |
| trusted hop | `https, http` | **no** — the last entry is what the hop wrote |
| trusted hop | *(absent)* | no |
| `198.51.100.7` (direct) | `https` | **no** — nothing trusted in the path |

All four decisions use it: the production plaintext refusal, the `Secure` flag
on the minted cookie, the logout clear-cookie, and the clear-cookie issued when
an invalid or expired cookie is seen.

### 4.5 Public service identifiers

A `Service` is addressed by its **public id**: the first 8 hex characters of the
uuid, which is exactly what the bot has always displayed
(`serviceShortId`, `packages/shared/src/public-ids.ts`). The format lives in the
shared package because both must agree — a user reading «شناسه» in the bot and
in the browser is reading one identifier, and a private copy in either app would
be free to drift.

Resolution is `startsWith` on the uuid, scoped by the session's user id **in the
`WHERE`**, with `take: 2`. Malformed, unknown, ambiguous, deleted and someone
else's all return one identical generic `404` — the shape of the failure teaches
nothing. The route accepts exactly 8 hex characters: shorter prefixes would make
it a prefix-enumeration oracle, and longer ones would let a caller keep a full
uuid in circulation.

Visibility excludes **both** deletion markers — `deletedAt != null` *and* the
terminal `status = DELETED` — because an admin-terminated service carries the
status without necessarily carrying the timestamp, and the bot has never shown
those rows either.

### 4.6 What each response actually says

| Route | Carries |
| --- | --- |
| `GET /me` | the profile, plus `services: { active, total }` |
| `GET /dashboard` | `serverTimestamp`, `dataFreshnessTimestamp`, balance, status counts, expiring-soon count, **5** recent services, 5 recent transactions |
| `GET /services`, `/services/:publicId` | service summaries, the detail a superset of the summary |

**The two timestamps are different questions** and are answered separately on
purpose:

- `serverTimestamp` — when the response was **generated**. It exists so a client
  can tell a stale cached screen from a live one, and so a bug report carries
  the moment its numbers were taken.
- `dataFreshnessTimestamp` — the **oldest** `updatedAt` among the services in
  the response. Stated conservatively so "everything here is at least this
  fresh" is true of every row; reporting the newest instead would let one
  just-touched row vouch for four stale ones. With no services in the slice
  there is nothing whose age could be understated, so the response's own
  generation time is the honest answer.

Both are **database** freshness. Nothing in this surface calls a panel, so
nothing here can speak for a panel's state, and `lastSyncedAt` on a service is
named for what it is: when that row was last written here.

`services.active` and `services.total` are `COUNT` queries under the same
visibility filter as every other service read — never derived from a fetched
list, because an account with hundreds of services must not load hundreds of
rows so two numbers can be counted in JavaScript.

**`remainingDays`** has three cases, defined once in the serializer so the list,
the detail and the dashboard cannot disagree:

| Case | Value | Why |
| --- | --- | --- |
| never expires (`expiresAt` null) | `null` | The field does not apply. A number would render as a countdown that never moves. |
| already expired | `0` | Never negative — "how much is left" is not a debt. |
| in the future | rounded **up** | Three hours left is one day, not zero; rounding down would make it indistinguishable from expired. |

### 4.7 Getting back to the bot

Read-only without a way out is a dead end: a user looks at an expiring service
and has nowhere to go. So the frontend offers explicit actions for **buying**,
**charging the wallet**, **renewing or managing a service** and **contacting
support** — and each does exactly one thing: opens the bot.

Nothing is reimplemented here. Those flows have pricing, stock, gates,
notifications and an audit trail behind them, all of it in the bot, and a second
copy in the Mini App would be a second source of truth that drifts.

The link is built from `VITE_BOT_USERNAME`, validated as a public handle, with
**no `?start=` payload** — that parameter is consumed by referral attribution,
so a made-up value would be recorded as a referral code. When the handle is
missing or malformed the actions render an explanatory line instead of a button:
a dead button reads as a broken app.

**Which actions appear where.** Having the component is not the same as having
it on screen, and for a while it was not: all four actions existed but only the
dashboard and the service list mounted them, so a user reading "expires in 2
days" on a service detail was told the flow lives in the bot and given nothing
to tap. Each screen now carries the actions its own content leads to, mounted
next to the read-only notice that explains why the operation is not here:

| Screen | Actions | Why these |
| --- | --- | --- |
| dashboard | buy, charge, renew, support | the overview; every flow is one tap away |
| services list | buy, renew | a list of what you own leads to more of it, or to keeping it |
| service detail | renew, support | the screen where an expiry is read is the screen where it should be actionable |
| wallet | charge, support | a short balance leads to a top-up; wallet questions lead to support |
| profile | support | an account page leads to help, not to shopping |

Padding a screen with unrelated buttons would make the ones that matter harder
to find, so the placement is deliberately narrow rather than uniform. Loading
and failure states carry none of these: the shared failure screen owns its own
bot handoff for gates that can only be cleared in the bot, and stapling a second
set of actions onto it would offer two different ways out of one problem.

### 4.8 The Support Centre — the one write surface

Contacting support is the one flow where "go back to the bot" was the worst
answer available. Everything else the bot owns has real business logic behind it
— pricing, stock, settlement — and duplicating any of it would create a second
source of truth. A ticket does not: it is a subject, a category and some text.
So this is the one place the Mini App writes, and the bounds are drawn tightly.

**Where the rules live.** Not here. `packages/support-tickets` owns validation,
ownership, status transitions and idempotency, and the bot imports the same
package — so a subject the bot accepts is a subject the Mini App accepts. The
route file (`apps/api/src/miniapp/support-routes.ts`) does three things only:
read the request, choose a status code, shape the response.

| Bound | Value | Where it is decided |
| --- | --- | --- |
| subject | 3–100 characters, trimmed first | `packages/support-tickets/src/contract.ts` |
| message | 1–3000 characters, trimmed first | same |
| category | one of `CONNECTION`, `PAYMENT`, `SERVICE_MANAGEMENT`, `ACCOUNT`, `OTHER` | `packages/shared/src/support-tickets-v2.ts` |
| `clientRequestId` | `/^[A-Za-z0-9_-]{16,64}$/` | `packages/support-tickets/src/contract.ts` |
| request body | 20 KiB, **derived** from the bounds above | `SUPPORT_MUTATION_BODY_LIMIT_BYTES` |
| `origin` | forced to `MINIAPP`, never read from the body | the route |

`origin` is forced rather than accepted because it is the only column that says
where support requests actually come from; letting a client claim otherwise
would corrupt the one field the answer depends on.

The body limit is **derived, not chosen**. The domain bounds a message in UTF-16
code units and HTTP bounds a body in bytes, and the old 8 KiB confused the two:
3000 valid Persian characters are 6000 bytes, 3000 CJK characters are 9000, and
a client that escapes non-ASCII as `\uXXXX` spends six bytes per code unit — so
the transport was refusing text the domain would have accepted. The limit is now
computed in `packages/support-tickets` from `TICKET_MESSAGE_MAX` and
`TICKET_SUBJECT_MAX` and imported by the route, which restates nothing.

**The frontend mirrors those bounds, it does not own them.** A 4000-character
message is refused before the round trip so the user is not made to wait for a
verdict already knowable — but the server's answer always wins, and every
rejection is a CODE the frontend renders in its own Persian.

#### Idempotency: one key per submission, replayed on every retry

A failed write has three outcomes a client cannot tell apart: it never arrived,
it arrived and was refused, or **it arrived, was applied, and the response was
lost**. Only the third is dangerous, and only replaying the same key protects
against it.

So the `clientRequestId` for a given wizard submission — or a given reply draft
— is minted **once**, from `crypto.getRandomValues`, and reused **verbatim** on
every retry of that submission. A retry that minted a fresh key would describe a
different mutation, the server's record would not recognise it, and the user
would get a second ticket: the exact failure the key exists to prevent. A fresh
key is minted only for a genuinely new ticket or a new reply draft.

The key lives in React state for the life of the draft and **nowhere else** —
not `localStorage`, not a cookie, not IndexedDB.

Server-side, the key is stored with the operation, the target ticket and a
**fingerprint of the normalised mutation**. All three must match for a replay to
be answered with the original outcome; a key reused for different content is
`409 IDEMPOTENCY_CONFLICT` rather than a wrong answer to the right question.

#### Text only, and it stays that way

There is no upload route, no attachment download and no file metadata in any
response. Tickets raised from Telegram can carry files; the Mini App is told
only that one **exists** (`hasAttachments`, a boolean) and hands off to the bot
to look at it.

That is a security decision, not a scope cut. A download here would mean
re-deciding, in a second place, who may read a given file — and the second
answer eventually differs from the first. Since no file id, name, size or type
ever crosses the boundary, there is nothing in the browser that a download could
even be built from.

#### What each failure means to a person

The server sends codes; the frontend chooses the Persian. Two of them carry
meaning a generic error would destroy:

| Code | HTTP | What the screen does |
| --- | --- | --- |
| `TICKET_CLOSED` | 409 | Says this conversation is over and **removes the reply box**, then refetches the ticket. Never a retry button: the same request will fail identically. |
| `IDEMPOTENCY_CONFLICT` | 409 | Says the key was already used for different content and starts a fresh draft. |
| `INVALID_SUBJECT` / `INVALID_MESSAGE` / `INVALID_CATEGORY` / `INVALID_SERVICE` / `INVALID_REQUEST_ID` | 400 | Names the field that was refused. |
| `TICKET_NOT_FOUND` / `INVALID_TICKET_ID` | 404 | One identical answer. Unknown, malformed, ambiguous and somebody else's collapse on purpose — distinguishing them would confirm which ticket ids exist. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | The mutation gate refused the content type. |
| `RATE_LIMITED` | 429 | Wait and retry. |

**The mutation gate.** Both writes pass `checkSupportMutation` before any domain
work: secure transport, `Origin` against the allowlist, `Content-Type`, and a
per-user rate limit. It is the same shape as the auth limiter (§4.3) and for the
same reason — a write anyone with a cookie can reach is a write worth bounding.

**The API still holds no bot token.** Creating a ticket writes a *notification
intent* in the same transaction as the message; the bot's sweep turns that into
a message to the administrators. That is why the intent exists at all, and it is
why `apps/api` needs no grammY to make support work.

**Ticket ids are public short ids**, resolved owner-scoped exactly as services
are (§4.5). No uuid crosses this boundary, and no *part* of one: messages carry
**no identifier at all**. An earlier version sent a "display key" cut from the
message's uuid; it was only a React key, but a uuid prefix on the wire leaks the
id space and is stable enough to correlate responses. Nothing addresses a single
message, so nothing needs an id — the frontend mints render keys in memory as a
page is ingested.

**Linking a service.** The wizard asks which service a ticket is about:
`CONNECTION` and `SERVICE_MANAGEMENT` show the picker on arrival, the other
three categories offer it and fetch nothing until asked. Linking is optional on
every path — the person most likely to need support is the one whose service is
broken, missing or expired, so refusing a ticket until they name one would lock
out exactly the wrong people. The picker is fed by the existing authenticated
`/services` route, so only public service ids ever reach the browser, and the
server resolves whatever is sent inside the transaction that writes the ticket.

### 4.9 Commerce, part A — one authority, two transports

The commerce surface exists under a rule the Support Centre never needed:
**every financial decision is made by the bot's own domain services**, imported
by the API as `@zedbot/bot/services/*`. Catalog visibility is
`isProductVisible`, pricing is `resolveEffectiveProductPrice` (representative
pricing included), discount validity is `validateDiscountCode` +
`claimDiscountUsage`, and the durable checkout is `createCheckoutSession` —
the same function the bot's «تایید خرید» runs, with the same in-transaction
username-reservation claim. The API computes no amount itself, and the
frontend renders amounts without ever deriving one.

What keeps this from dragging Telegram into the API: the one module where
settlement was fused to fulfilment (`gateway-payment.service`) was split — the
grammY-facing settlement runner stayed bot-only — and
`apps/api/tests/miniapp-import-graph.test.ts` walks the API's **runtime**
import graph (through the bot's sources) and fails on any grammy value import,
handler, keyboard or `*-views` module. The old manifest-closure assertion in
FJ13 now pins the narrower fact that only the sanctioned `@zedbot/bot` edge
may carry grammy in its manifest.

**Rollout.** Nine OWNER switches (`miniapp_commerce_enabled` first among
them), all seeded `false`, toggled from the bot's admin settings, and re-read
**fresh and fail-closed** at every commerce boundary — a database error blocks
exactly like a disabled switch, and a switch flipped off between quote and
confirm rejects the stale confirm with `FEATURE_DISABLED`. Provider-level
gating stays authoritative and composes with these by AND.

**The draft.** The bot keeps its pre-invoice draft in the grammY session; a
browser gets no such trust. `/commerce/quote` computes the authoritative
pre-invoice and returns a sealed capsule (AES-256-GCM, same key discipline as
cursors) carrying the draft's IDENTITY — product, reservation, note, discount
code, server-minted nonce — and deliberately **not its amounts**.
`/commerce/checkout` reopens the capsule, re-validates visibility and the
discount, re-prices from live rows (`SETTLE` mode, so an OWNER
emergency-disable of representative checkout bites at the money boundary) and
only then creates the `CheckoutSession`, recording `origin: "MINIAPP"` for
bookkeeping. A price changed after the quote settles on the fresh price, never
the browser's remembered one.

**Idempotency.** Commerce mutations reuse `MiniAppRequestIdempotency` with the
support rules verbatim: same key + same payload replays the original result;
same key + different payload is a `409` conflict; a concurrent duplicate
converges on the unique-row winner. Underneath, the money keeps its own
guarantees (`Payment.idempotencyKey`, the settlement CAS, one order per
checkout), so the request-level layer is a convenience, never the safety.

**Identifiers.** Commerce rows are addressed by the same 8-hex uuid-prefix
public ids as services and tickets (`commerceShortId`), resolved owner-scoped
with `take: 2` ambiguity → 404. Internal uuids travel only inside sealed
capsules, exactly as they do inside cursors.

**Payments.** The wallet endpoint re-validates the sealed quote against live
domain state and then runs the shared settlement transaction — conditional
`balanceToman ≥ amount` deduction, ledger row with exact before/after,
`Payment(APPROVED)`, `Order(PAID)`, in-transaction reservation claim and
discount consumption. Only wallet payment is exposed by this Mini App scope;
card, receipt, gateway, top-up, and OTHER_PRODUCT flows are intentionally not
routes. Durable fulfillment is queued to the Bot process and executed by the
transport-independent service executor, with reconciliation after uncertain
panel outcomes.

---

## 5. The frontend

`apps/miniapp` — React 19 + Vite 7 + TypeScript, Persian, RTL.

Thirteen screens: splash, outside-Telegram, signed-out, dashboard, service list,
service detail, wallet history, profile, the failure screen every error path
lands on, and the Support Centre's four — landing, ticket list, ticket thread
and the new-ticket wizard.

Five tabs: خانه, سرویس‌ها, کیف پول, پشتیبانی, حساب من. Navigation is component
state in `App.tsx`, not a router: a URL-driven router inside a Telegram WebView
adds history semantics nobody asked for, and there is less code in the state
machine than there would be in the routing library.

**The read/write split is a file boundary.** `src/screens.tsx` reads and only
reads; `src/support.tsx` is the single module that posts. Keeping them apart is
not tidiness — a reader who opens `screens.tsx` should be able to trust that the
read-only guarantees still hold on every screen in it.

- **No token anywhere, and nowhere to put one.** The session is an HttpOnly
  cookie the script cannot read; requests carry it with `credentials:
  "same-origin"`. Nothing is written to `localStorage` or `sessionStorage`, so
  an XSS that would otherwise exfiltrate a stored token has nothing to take.
- **No browser persistence at all**, and that now includes ticket drafts and
  idempotency keys. A draft in `localStorage` is a copy of a user's support text
  sitting where any script on the page can read it, and a stored idempotency key
  would outlive the submission it belongs to. Both are React state and die with
  the component.
- **The new-ticket wizard reviews before it sends.** Category → subject →
  message → a review step showing exactly what will be transmitted → one
  explicit confirmation. Advancing through the wizard issues no request at all;
  the confirmation is the only thing that writes.
- **Errors are codes.** The server sends no prose, so nothing server-authored is
  ever rendered; the Persian text is chosen locally from a closed set, and an
  unknown code collapses to a generic internal failure.
- **RTL is a document property** (`dir="rtl"` plus logical CSS properties), not a
  pile of `left`/`right` overrides.
- **Telegram's theme** is copied into CSS custom properties after each value is
  validated as a colour literal — at startup *and* on every `themeChanged`
  event, because a user can switch their client between light and dark while
  the app is open and Telegram does not reload the WebView. The subscription is
  detached on unmount, and the detached handler stops writing even where the
  host bridge offers no `offEvent`.
- **Signing out stays signed out.** The signed `initData` never leaves the
  WebView, so a shell that re-authenticated after a logout would silently undo
  it. A successful logout closes the Mini App through the host bridge; where the
  host has no `close`, it lands on a signed-out screen whose «ورود مجدد» button
  is the only thing that authenticates again. One logout produces one logout
  request and zero automatic sign-ins.
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
  `<form>` element, so both stay locked. The Support Centre's inputs are
  controlled React fields submitted with `fetch`, never a form navigation, so
  `form-action 'none'` costs nothing and still forbids the one thing it names.

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
| `MINIAPP_INITDATA_MAX_AGE_SECONDS` | How old a signed Telegram payload may be at sign-in. Default 300, **clamped to 30..3600** — it is the replay window on a bearer credential. |
| `MINIAPP_SESSION_TTL_SECONDS` | Session cookie lifetime. Default 900, **clamped to 60..3600**. One value drives the token expiry, the cookie `Max-Age` and what the client is told, so the three cannot disagree. |
| `API_TRUSTED_PROXIES` | Which forwarding hops may be believed (§4.3). Default `loopback, linklocal, uniquelocal`; `none` trusts nothing. |
| `MINIAPP_DIST_DIR` | Overrides where the API looks for the built bundle. |
| `VITE_BOT_USERNAME` | Public bot handle compiled into the bundle for its "open the bot" link. Build-time. |

`APP_SECRET` must be set: without it the session cannot be signed, and the code
throws rather than falling back to an unkeyed token.

### 7.2 Bot entry

Three ways in, all reaching the same screen: the **main-menu button**, `/app`,
and the `user:miniapp` callback — all dispatched through the same gated user
area as `/menu`.

The main-menu entry is a `MINIAPP` action in the ONE shared menu definition, so
it renders identically in INLINE and REPLY mode. It carries an ordinary
callback, never a `web_app` button: a reply keyboard's buttons are text only, so
a `web_app` entry in the shared definition could not exist in REPLY mode and the
two modes would silently offer different features. The real `web_app` button
lives on the intro page that callback opens.

Gated on configuration rather than a database flag — Telegram rejects a
`web_app` button whose URL is not https and rejects the whole keyboard with it,
so a misconfiguration must yield a missing button, not an unrenderable menu.
When `MINIAPP_PUBLIC_URL` is missing or not https the menu row is **hidden**,
but the label stays **resolvable**: a persistent reply keyboard already sitting
in someone's chat outlives the setting, and a tap on it should get the explicit
"not enabled yet" answer rather than being silently ignored.

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

**Support writes log no ticket text.** A failed write logs the operation and an
error message; it never logs the request body, which is the subject and message
a user just typed. The idempotency record stores a **hash** of the normalised
mutation rather than the mutation, because the point is comparison, not recall —
the text already exists once in the database, and a second copy would double the
blast radius of a leak in exchange for nothing.

---

## 9. Tests

| Suite | File | Cases |
| --- | --- | --- |
| initData validation + external vectors | `apps/api/tests/miniapp-initdata.test.ts` | M01–M24 |
| Session token & cookie | `apps/api/tests/miniapp-session.test.ts` | M17–M26 |
| API isolation, gates, pagination | `apps/api/tests/miniapp-api.test.ts` | M27–M54 |
| Force Join gate + grammY isolation | `apps/api/tests/miniapp-force-join.test.ts` | FJ01–FJ13b |
| Trusted proxy, rate limiting, lifetimes | `apps/api/tests/miniapp-proxy.test.ts` | P01–P12, C01–C05 |
| Static serving & SPA fallback | `apps/api/tests/miniapp-static.test.ts` | N05b, N07–N09 |
| Secure-transport decision | `apps/api/tests/miniapp-transport.test.ts` | D2-1–D2-7 |
| Public ids & sealed cursors | `apps/api/tests/miniapp-public-ids.test.ts` | D3-1–D3-11 |
| Numeric configuration safety | `apps/api/tests/miniapp-config-safety.test.ts` | D4-1–D4-7 |
| Response contract (§4.6) | `apps/api/tests/miniapp-contract.test.ts` | E3-1–E3-10 |
| Durable Force Join alerts | `apps/bot/tests/force-join-durable-alerts.test.ts` | D1-1–D1-7 |
| Health success vs. retirement race | `apps/bot/tests/force-join-health-race.test.ts` | E2-1–E2-6 |
| Delivery sweep & stale recovery | `apps/bot/tests/log-delivery-sweep.test.ts` | D1-8–D1-12, E1-1–E1-8 |
| Nginx config & smoke script | `apps/bot/tests/miniapp-nginx.test.ts` | N01–N15 |
| Bot entry point + menu integration | `apps/bot/tests/miniapp-entry.test.ts` | B01–B10 |
| Frontend formatting & client | `apps/miniapp/tests/` | F01–F20 |
| Theme & logout lifecycle (jsdom) | `apps/miniapp/tests/lifecycle.test.tsx` | L01–L12 |
| Bot-return actions & profile counts (jsdom) | `apps/miniapp/tests/bot-actions.test.tsx` | E4-1–E4-12 |
| Support Centre screens, idempotency, closed tickets (jsdom) | `apps/miniapp/tests/support.test.tsx` | S01–S20 |
| Support client, key generation, failure vocabulary | `apps/miniapp/tests/support-client.test.ts` | S21–S31 |
| Documentation contract (this file) | `apps/api/tests/miniapp-doc-contract.test.ts` | F1-1–F1-10 |

The API suite needs a migrated PostgreSQL (`DATABASE_URL`); without it it skips
itself. The Nginx suite runs a real `nginx -t` when the binary is present and
says so in the output when it is not — a skipped syntax check must not read as a
passing one.
