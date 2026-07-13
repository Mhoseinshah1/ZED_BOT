# XUI / 3X-UI (Sanaei) Provisioning

Real authenticated client provisioning for the Sanaei 3X-UI API family.
This page covers the exact supported surface - nothing beyond it is
claimed.

## Supported variant and upstream contract

- **SANAEI**: MHSanaei 3X-UI versions exposing the **global client API**
  under `{basePath}/panel/api/clients/...` - clients are first-class
  entities attached to one or more inbounds. This is the only implemented
  and tested variant; `Panel.apiVariant` empty/null defaults to it.
- **Pinned upstream source of truth**: the implementation follows
  https://github.com/MHSanaei/3x-ui at commit
  **`4e928a1ce0945a6e956aa63365034ec24d2b1387`**
  (`docs/public/openapi.json`, `internal/web/controller/client.go`,
  `internal/web/service/client_crud.go`,
  `internal/database/model/model.go`). Field names, payload shapes and
  duplicate-handling semantics were taken from that commit, not from
  memory or legacy examples.
- **Not supported**: 3X-UI versions WITHOUT the global client API (the
  legacy per-inbound `POST /panel/api/inbounds/addClient` /
  `.../delClient/...` endpoints were REMOVED upstream and are never
  called), legacy vaxilu x-ui, and other forks with different routes.
  Such panels fail the readiness test with «نسخه API پشتیبانی نمی‌شود»
  and are never sellable - readiness is authenticated, so a merely
  reachable login page changes nothing.

## Authentication modes

Two explicit modes (`Panel.authMode`; null defaults to `SESSION_COOKIE`,
so panels configured before this phase keep working unchanged):

- **`SESSION_COOKIE`** (default) - the stock Sanaei 3X-UI mechanism: form
  login on `{base}/login`, session cookie on subsequent requests. 3x-ui
  reports login failures as **HTTP 200 with `{"success": false}`** - the
  envelope, not the status code, decides success.
- **`API_TOKEN`** - for deployments that require a pre-issued API token
  and cannot authenticate through the login flow. The token (stored
  encrypted in `tokenEncrypted`) is sent as `Authorization: Bearer` on
  every request against the same SANAEI-shaped routes; **`/login` is never
  called**. There is no interactive round-trip that proves the token, so
  the connection test and readiness check verify it with a real
  authenticated read of the inbound list - 401/403 or a login-page
  redirect is an authentication failure. Token formats and endpoints
  differ between forks: only this documented bearer convention is
  implemented, and deployments using other schemes surface as
  authentication/variant failures - never as guesses.

Cookies and tokens live only in memory for one adapter operation and are
never logged, returned in messages or persisted (the token is persisted
only encrypted, like every other panel credential).

## Endpoints used

| Operation | Endpoint |
|---|---|
| Login (SESSION_COOKIE mode only) | `POST {base}/login` (form-encoded) |
| Inbound inventory (validation) | `GET {base}/panel/api/inbounds/list` |
| Global client inventory (+attachments +traffic) | `GET {base}/panel/api/clients/list` |
| One client (+attachments +usage) | `GET {base}/panel/api/clients/get/{email}` |
| Create client + attach inbounds (one call) | `POST {base}/panel/api/clients/add` |
| Delete client (compensating cleanup / staging only) | `POST {base}/panel/api/clients/del/{email}` |
| Panel-built config links | `GET {base}/panel/api/clients/links/{email}` |

Unauthenticated API calls answered with a redirect are reported as
session/token/base-path errors.

## Base path handling

The base URL is used verbatim after stripping trailing slashes, so all of
these work:

- `https://panel.example.com`
- `https://panel.example.com:2053/secretpath` (3x-ui random web base path)
- reverse-proxied paths - the API is always `{configured base}/panel/api/...`

No path segments are guessed, added or removed; a wrong base path surfaces
as «نسخه API پشتیبانی نمی‌شود» / login-endpoint-not-found.

## Required panel configuration

| Field | Meaning |
|---|---|
| `baseUrl` | Panel root incl. any web base path |
| `authMode` (optional) | `SESSION_COOKIE` (default) or `API_TOKEN` |
| `username` / password | SESSION_COOKIE mode login credentials (password encrypted with `APP_SECRET`) |
| `tokenEncrypted` | API_TOKEN mode bearer token (encrypted with `APP_SECRET`) |
| `inboundIds` | JSON int array of inbound ids to provision into, e.g. `[1]` or `[1,4]` |
| `apiVariant` (optional) | `SANAEI` (default) |
| `subscriptionDomain` (optional) | Full base URL of the 3x-ui subscription service, e.g. `https://sub.example.com:2096/sub` |
| `protocolSettings` (optional) | `{"flow": "xtls-rprx-vision"}` applied to VLESS clients only |

The admin add-wizard asks for the auth mode when creating an XUI panel;
existing panels can switch modes via «روش احراز هویت 🔐» on the panel
detail page (switching stales the readiness result and prompts for the new
mode's credential). Whatever the mode, the credential for the CONFIGURED
mode must be present - a token alone never satisfies SESSION_COOKIE and
vice versa. Legacy panels that only carry a token can either get login
credentials or be switched explicitly to API_TOKEN.

## Inbound validation

Before ANY mutation, every configured inbound id is validated against the
authenticated inbound list:

- it must exist (`inbound-missing` otherwise),
- it must be enabled (`inbound-disabled`),
- its protocol must be `vless`, `vmess` or `trojan`
  (`unsupported-protocol` - the tested set).

## Client creation (global client model)

**ONE global client per service** - never one client per inbound:

- **email**: the deterministic service username exactly (unique
  panel-wide, no inbound suffix).
- **subId**: the same username (subIds are unique per client panel-wide;
  the panel's subscription groups every attached inbound's config under
  this one id).
- **inboundIds**: every configured inbound, attached in the SAME
  `POST /panel/api/clients/add` call (`{client, inboundIds}` body).
- **Per-protocol secrets are generated SERVER-side** per the documented
  contract (UUID for VLESS/VMess, password for Trojan) - the bot sends
  only universal fields and reads the identifiers back via
  `get/{email}`. Nothing is ever copied from another client. `flow` is
  sent ONLY when explicitly configured.
- `totalGB` is set in **bytes** (the upstream field name is misleading;
  the UI converts, the API does not), `expiryTime` in unix milliseconds,
  `enable: true`, `limitIp: 0`, `reset: 0`, `comment` = the order note.
  `tgId` is an **int64** upstream and is deliberately omitted. Volumes
  beyond the JS safe-integer range fail validation before any HTTP call.

The result is one shared quota, one shared expiry and ONE shared traffic
record across all attached inbounds, and one subscription containing every
attached inbound's configuration.

## Idempotency

Duplicate handling is part of the upstream contract: re-adding an existing
email with the SAME subId reuses the stored credentials and deduplicates
attachments (idempotent retry); an email held by a client with a FOREIGN
subId is rejected. The adapter additionally pre-checks the inventory and
reports the foreign-subId case as a clean `conflict` diagnostic without
attempting a mutation.

## Partial attach failure

The server attaches inbounds in a loop, so a mid-call failure can leave
the client attached to a subset. The compensating cleanup is ONE bounded
call - `POST /panel/api/clients/del/{email}` removes the client from
every attached inbound and drops its traffic record - verified by a
re-read of the inventory:

- re-read confirms the email is gone AND the failed call got a real
  response -> **definite failure** (refund-safe);
- the failed call was a timeout/transport error -> **UNKNOWN**, even when
  the re-read looks clean - the hung request may land after the
  verification read;
- cleanup unverifiable (delete failed / inventory unreadable) ->
  **UNKNOWN**.

UNKNOWN outcomes leave the order `PROVISIONING`; startup reconciliation
re-probes minutes later and completes or refunds on positive proof.
**Residual orphan risk**: an unverifiable cleanup can leave one client
with the `zed_*` email behind; the log documents it for manual removal.

## Reads / reconciliation

`getServiceAccount` reads the complete global client inventory
(`GET /panel/api/clients/list`) and matches the service's client by exact
email. Services provisioned BEFORE this migration (legacy per-inbound
labels `username-<inboundId>`) are still recognized and aggregated, so old
rows keep syncing and reconciling. Quota/expiry come from the client row,
usage from its traffic record (summed across legacy labels), and status
normalizes as before (`disabled`/`expired`/`limited`/`active`). `notFound`
is set **only** when the full inventory was readable and no client
matched - an unreadable inventory removes the proof of absence.

## Subscription URL

The 3x-ui API does not report subscription URLs. One is returned ONLY when
the operator configured `subscriptionDomain` (the panel's subscription
service base): `{subscriptionDomain}/{subId}`. **Config links** are now
real panel data: `GET /panel/api/clients/links/{email}` returns the same
URLs the panel's Copy-URL button builds, one per attached inbound; the
call is best-effort - a failure never fails an already-created service.
Without a configured subscription base, provisioning
succeeds with the connection data available and no URL is fabricated.
Config links are not derived in this phase.

## Capabilities (honest surface)

Implemented and tested: `authenticatedHealth`, `createService`,
`readService`, `reconciliation`. **Not implemented**: renewal, extra
volume, extra time, enable/disable, subscription regeneration, delete (as
a service operation). The capability model blocks all of these BEFORE
payment: XUI services never appear in renewal/extra listings and their
plan validation fails pre-invoice; toggle/regenerate return
«این عملیات برای این سرویس پشتیبانی نمی‌شود.».

## Staging verification

Opt-in tests run only when `XUI_STAGING_URL` / `XUI_STAGING_USERNAME` /
`XUI_STAGING_PASSWORD` (and `XUI_STAGING_INBOUND_IDS`) are set. They
create `zedstaging_*`-labeled clients and delete them via `delClient`,
printing the safe label for manual cleanup if deletion fails. Never point
them at production panels.
