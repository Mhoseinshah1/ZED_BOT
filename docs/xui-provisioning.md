# XUI / 3X-UI (Sanaei) Provisioning

Real authenticated client provisioning for the Sanaei 3X-UI API family.
This page covers the exact supported surface - nothing beyond it is
claimed.

## Supported variant

- **SANAEI**: MHSanaei 3X-UI with API routes under
  `{basePath}/panel/api/inbounds/...`. This is the only implemented and
  tested variant; `Panel.apiVariant` empty/null defaults to it.
- **Not supported**: legacy vaxilu x-ui (no addClient API), other forks
  with different routes. Their panels fail the readiness test with
  «نسخه API پشتیبانی نمی‌شود» and are never sellable - readiness is
  authenticated, so a merely reachable login page changes nothing.

## Endpoints used

| Operation | Endpoint |
|---|---|
| Login (session cookie) | `POST {base}/login` (form-encoded) |
| Inbound list (+clients +traffic) | `GET {base}/panel/api/inbounds/list` |
| Add client | `POST {base}/panel/api/inbounds/addClient` |
| Delete client (compensating cleanup / staging only) | `POST {base}/panel/api/inbounds/{id}/delClient/{clientId}` |

3x-ui reports login failures as **HTTP 200 with `{"success": false}`** -
the envelope, not the status code, decides success. The session cookie
lives only in memory for one adapter operation and is never logged,
returned or persisted. Unauthenticated API calls answered with a redirect
are reported as session/base-path errors.

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
| `username` / password | 3x-ui login credentials (password encrypted with `APP_SECRET`) |
| `inboundIds` | JSON int array of inbound ids to provision into, e.g. `[1]` or `[1,4]` |
| `apiVariant` (optional) | `SANAEI` (default) |
| `subscriptionDomain` (optional) | Full base URL of the 3x-ui subscription service, e.g. `https://sub.example.com:2096/sub` |
| `protocolSettings` (optional) | `{"flow": "xtls-rprx-vision"}` applied to VLESS clients only |

Panels configured before this phase stored only an API token; the SANAEI
variant needs username/password, so an admin must enter them
(«ویرایش اطلاعات ورود») before the panel becomes sellable again. The old
`tokenEncrypted` column is retained but unused.

## Inbound validation

Before ANY mutation, every configured inbound id is validated against the
authenticated inbound list:

- it must exist (`inbound-missing` otherwise),
- it must be enabled (`inbound-disabled`),
- its protocol must be `vless`, `vmess` or `trojan`
  (`unsupported-protocol`),
- its `settings` JSON string must parse (`inbound-malformed` - XUI stores
  client lists as JSON text inside JSON, and corrupted rows do occur).

## Client creation

One client identity per configured inbound:

- **VLESS/VMess**: fresh `crypto.randomUUID()` per service. VLESS gets
  `flow` ONLY when explicitly configured (it must match the inbound's
  security settings and is never guessed).
- **Trojan**: fresh 32-hex-char password from `crypto.randomBytes`.
- **email** (client label): `<serviceUsername>-<inboundId>` - 3x-ui
  enforces panel-wide unique labels, so multi-inbound needs one label per
  inbound; the shared prefix keeps them discoverable.
- **subId**: the service username, shared across the service's clients so
  the panel's subscription service groups them into one subscription.
- `totalGB` is set in **bytes** (the field name is misleading; the API
  takes bytes), `expiryTime` in unix milliseconds, `enable: true`,
  `limitIp: 0`, `reset: 0`. Volumes beyond the JS safe-integer range fail
  validation before any HTTP call.

Nothing is ever copied from another client.

## Idempotency

Retrying the same order never duplicates clients: before adding, each
configured inbound is searched for the deterministic label. An existing
client is recovered (same identifier returned); a client with the same
label but a foreign `subId` is a conflict error - never adopted, never
recreated over.

## Partial multi-inbound failure

If some inbounds succeeded and one fails, a bounded compensating cleanup
deletes the clients created during THIS call and re-reads the inbound list
to verify:

- re-read confirms clean AND the failed call got a real response ->
  **definite failure** (refund-safe);
- the failed call was a timeout/transport error -> **UNKNOWN**, even when
  the re-read looks clean - the hung request may land after the
  verification read;
- cleanup unverifiable (delete failed / list unreadable) -> **UNKNOWN**.

UNKNOWN outcomes leave the order `PROVISIONING`; startup reconciliation
re-probes minutes later (any in-flight request has long settled) and
completes or refunds on positive proof. **Residual orphan risk**: an
UNKNOWN outcome that reconciliation later refunds (absence proven) cannot
leave clients behind, but an unverifiable cleanup can - such clients keep
the `zed_*` label and are documented for manual removal in the logs.

## Reads / reconciliation

`getServiceAccount` searches ALL panel inbounds for the service's labels,
aggregates traffic from `clientStats` (up+down summed across inbounds),
takes quota/expiry from the client entries (equal by construction) and
normalizes status (any disabled client -> `disabled`; past expiry ->
`expired`; quota exhausted -> `limited`). `notFound` is set **only** when
the complete inbound inventory was readable and parseable and no client
matched - an unreadable/malformed inbound removes the proof of absence.

## Subscription URL

The 3x-ui API does not report subscription URLs. One is returned ONLY when
the operator configured `subscriptionDomain` (the panel's subscription
service base): `{subscriptionDomain}/{subId}`. Without it, provisioning
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
