# Marzban Provisioning

Real service provisioning against the documented Marzban API. This page
covers what the adapter actually does, what it requires and how failures
surface.

## Supported variants

- **Marzban** (current stable deployments exposing the documented REST API).
- **RickPanelAPI-compatible panels**: supported exactly insofar as they
  expose the same documented Marzban contract (`/api/admin/token`,
  `/api/user`, `/api/user/{username}`, same field names/semantics). Extra
  response fields are tolerated and ignored; panels that deviate from the
  documented endpoints/fields are NOT supported.

## Endpoints used (documented Marzban API only)

| Operation | Endpoint |
|---|---|
| Authentication | `POST /api/admin/token` (form-encoded OAuth2 password grant) |
| Read user | `GET /api/user/{username}` |
| Create user | `POST /api/user` |
| Modify user | `PUT /api/user/{username}` |
| Reset usage (renewal) | `POST /api/user/{username}/reset` |
| Revoke subscription | `POST /api/user/{username}/revoke_sub` |
| Delete user | `DELETE /api/user/{username}` (opt-in staging cleanup ONLY) |

Authentication is form-encoded by contract - stock Marzban rejects JSON
token requests. A bearer token is fetched per operation and never persisted
or logged. There is no unauthenticated fallback: any auth failure fails the
whole operation.

## Base URL handling

The stored base URL is normalized once per client:

- trailing slashes are stripped (`https://p.example.com/` works);
- one trailing `/api` is stripped (`https://p.example.com/api` works -
  admins frequently paste the API root, which would otherwise produce
  `/api/api/...` 404s);
- scheme, host, port and any other path prefix are preserved, so
  reverse-proxied deployments like `https://host/marzban` work.

## Required panel configuration

| Field | Meaning |
|---|---|
| `baseUrl` | Panel root, e.g. `https://panel.example.com:8443` |
| `username` / password | Marzban admin (sudo) credentials, password encrypted with `APP_SECRET` |
| `templateUsername` **or** `protocolSettings` | Proxy/inbound source (see below) |
| `subscriptionDomain` (optional) | Base for absolutizing relative subscription URLs |
| `resetStrategy` (optional) | `no_reset` / `day` / `week` / `month` / `year` |

## Template strategy vs explicit configuration

**Template mode** (`templateUsername` set): the template user is fetched
through the authenticated API and must exist and carry at least one proxy.
Its protocol/inbound selection is copied with **all per-user secrets
stripped** - proxy `id` (VLESS/VMess UUIDs) and `password` (Trojan/
Shadowsocks) are removed so Marzban generates fresh ones; subscription
tokens are never copied. Only reusable settings (e.g. `flow`, `method`)
pass through.

**Explicit mode** (no template; `protocolSettings` set): the operator
configures proxies directly, either as

```json
{ "proxies": { "vless": { "flow": "" } }, "inbounds": { "vless": ["VLESS TCP REALITY"] } }
```

or as a direct protocol map (`{ "vless": {} }`). With `inbounds` omitted,
Marzban assigns the protocol's default inbounds. Any `id`/`password` keys
pasted into explicit settings are stripped too.

With neither configured, provisioning fails BEFORE payment
(«تنظیمات پنل ناقص است.») - products on such a panel are not sellable.

## Create payload semantics

Only documented fields are sent: `username`, `proxies`, `inbounds`,
`data_limit` (bytes; **0 = unlimited**), `data_limit_reset_strategy`,
`expire` (unix seconds; **0 = never**), `status: "active"`, `note`.

- Unlimited volume/expiry map to `0`/`0`.
- Volumes beyond `Number.MAX_SAFE_INTEGER` bytes fail validation safely
  (no lossy conversion, no HTTP call, definite failure -> refund).
- `note` carries `zedbot order:<short-id> tg:<telegramId>` and is the
  ownership marker for duplicate recovery.

## Duplicate username recovery (409)

Panel usernames are deterministic per order, so a `409` normally means a
previous attempt created the account and the process died before recording
it. The existing account is fetched and adopted **only** when its note
matches this order's note (or is empty); an account carrying a different
order's note returns a conflict error and is never adopted.

## Outcome certainty (never refund on UNKNOWN)

| Create failure | Outcome |
|---|---|
| Auth/config/template/validation failure (before the create call) | definite -> refund |
| Panel responded 4xx | definite -> refund |
| Panel responded 5xx, read-back probe 404 | definite -> refund |
| Timeout/transport error, probe finds the account | success (recovered) |
| Timeout/transport error, probe 404 or unreadable | **UNKNOWN** -> order stays `PROVISIONING`, reconciliation settles it |

A 404 probe after a *timeout* is deliberately NOT proof of absence: the
hung request may still be in flight and could land after the probe. Only a
received response makes the probe authoritative.

## Subscription URLs

`subscription_url` from the panel is joined against `subscriptionDomain`
(falling back to the panel base URL) without duplicating path segments:

- absolute URLs pass through untouched;
- `https://sub.host` + `/sub/TOKEN` → `https://sub.host/sub/TOKEN`;
- `https://sub.host/sub` + `/sub/TOKEN` → `https://sub.host/sub/TOKEN` (no
  duplication);
- `https://host/prefix` + `/sub/TOKEN` → `https://host/prefix/sub/TOKEN`
  (reverse-proxy prefixes preserved).

## Authenticated connection test

The admin «تست اتصال» runs the full readiness check and reports each step
separately: URL reachable, authentication, user-endpoint readability
(probed with a random nonexistent username - a documented 404 proves read
access), template readability/validity, and overall provisioning
configuration. **Login success alone never marks the panel ready.** The
result is persisted (`provisioningReady`) and gates sellability; editing
any provisioning-relevant field resets it to "untested".

## Common sanitized errors

| Admin text | Cause |
|---|---|
| «احراز هویت پنل ناموفق بود.» | 401/403 on the token endpoint |
| «کاربر الگوی مرزبان پیدا نشد.» | template 404 |
| «تنظیمات پنل ناقص است.» | no template and no explicit settings, or missing credentials |
| «ساخت سرویس روی پنل ناموفق بود.» | panel rejected the create |

Diagnostics carry only: operation, panel type, endpoint path template,
HTTP status, sanitized short detail, retryable flag and outcome certainty.
Never credentials, tokens, subscription URLs or raw bodies.

## Staging verification

Opt-in tests (`apps/bot/tests/staging-panels.test.ts`) run only when
`MARZBAN_STAGING_URL` / `MARZBAN_STAGING_USERNAME` /
`MARZBAN_STAGING_PASSWORD` (and optionally `MARZBAN_STAGING_TEMPLATE`) are
set. They create `zedstaging_*`-prefixed accounts and delete them via the
documented DELETE endpoint; a failed cleanup prints the safe username for
manual removal. Never point them at production panels.
