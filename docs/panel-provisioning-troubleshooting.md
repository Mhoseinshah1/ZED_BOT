# Panel Provisioning Troubleshooting

How to diagnose "service creation fails" using the built-in sanitized
diagnostics - without ever exposing credentials, cookies, tokens or raw
panel responses.

## Start with the authenticated panel test

Admin panel -> the panel's detail -> «تست اتصال 🩺». It runs the full
readiness check and prints each step (✅/❌/➖) plus the capability list.
The one-line status maps to the root cause:

| Status | Root cause | Fix |
|---|---|---|
| «آماده ساخت سرویس» | everything passed | - |
| «پنل در دسترس نیست» | DNS/TLS/connection/timeout on the panel URL | check base URL, port, firewall |
| «احراز هویت ناموفق» | wrong username/password (Marzban 401/403; XUI `success:false`) | re-enter credentials («ویرایش اطلاعات ورود») |
| «تنظیمات ناقص» | Marzban: no template AND no explicit protocol settings; missing credentials | set «اکانت نمونه» or «تنظیمات پروتکل» |
| «کاربر الگو یافت نشد» | configured Marzban template user does not exist | fix `templateUsername` |
| «اینباند تنظیم نشده» | XUI: no/invalid inbound ids; inbound missing/disabled/unsupported protocol/malformed settings | fix «شناسه‌های inbound»; check the inbound on the panel |
| «نسخه API پشتیبانی نمی‌شود» | login/API endpoints not found or non-JSON - wrong base path or unsupported fork | verify the URL incl. the 3x-ui web base path; only Sanaei 3X-UI is supported |
| «اتصال برقرار است اما ساخت سرویس قابل تایید نیست» | auth passed but a later step could not be verified | re-run; check the structured log |

The result is persisted: a failed test blocks selling the panel's products
until a test passes again. Editing panel config resets the state to
«تست نشده».

## Structured logs

Every provisioning failure logs one sanitized record
(`panel create-service failed`) with: `orderId`, `panelId`, `panelType`,
`code`, `httpStatus`, `endpointPath` (path template only), `uncertain`,
and the adapter's safe English error message. Codes:

`unreachable` · `timeout` · `auth-failed` · `not-found` ·
`template-not-found` · `template-invalid` · `config-incomplete` ·
`config-invalid` · `unsafe-volume` · `unsupported-variant` ·
`unsupported-protocol` · `unsupported-operation` · `inbound-missing` ·
`inbound-disabled` · `inbound-malformed` · `malformed-response` ·
`conflict` · `panel-rejected` · `partial-state`

Logs never contain: passwords, tokens, cookies, session ids,
authorization headers, subscription URLs, client UUIDs/passwords,
DATABASE_URL or raw response bodies.

## Common cases

**"Panel responded with HTTP 404" on every Marzban call** - the base URL
usually carried a path typo. Note `/api` suffixes and trailing slashes are
normalized automatically; other prefixes must match the deployment.

**Marzban 422 on create** - the sanitized detail (e.g.
`username: string does not match regex`) is included in the log message.

**XUI panel test fails although the login page opens in a browser** - a
reachable login page is NOT the API. Wrong web base path (the secret path
segment) or a non-Sanaei fork both surface as
«نسخه API پشتیبانی نمی‌شود».

**Existing XUI panels stopped selling after the upgrade** - XUI
authenticates with username/password (session cookie) by default; panels
that only carry the legacy token need either login credentials
(«ویرایش اطلاعات ورود») or an explicit switch to the API_TOKEN mode
(«روش احراز هویت 🔐») with a valid bearer token. Run the test afterwards.

**Token-mode panel fails with «احراز هویت ناموفق»** - the deployment
rejected the bearer token (401/403 or a redirect to the login page).
Verify the token is current and that the deployment actually accepts
`Authorization: Bearer` on `/panel/api/...` routes; fork-specific token
schemes are not supported and surface exactly like a wrong token.

**Order stuck in PROVISIONING with `uncertain: true` in the log** - the
panel outcome was UNKNOWN (timeout mid-create / unverifiable partial
multi-inbound state). This is deliberate: uncertainty is never refunded.
Startup reconciliation (at boot + every 15 minutes) probes the panel under
the per-service lock and completes or refunds on positive proof. If it
keeps deferring, the panel is unreadable - fix connectivity/credentials
and the next sweep settles it.

**User paid and got a refund, but an account exists on the panel** - can
only happen when the panel POSITIVELY reported a state that later changed
(e.g. manual panel edits). Check ServiceEventLog/wallet history for the
order id and the panel account's `note`/label (`zedbot order:<id>` /
`zed_..._...-<inbound>`).

**Orphaned XUI clients** - after an unverifiable compensating cleanup, a
client labeled `zed_*` may remain on an inbound with no local Service. The
log line documents the label; remove it in the panel UI.

## Verifying against a real staging panel

See the "Staging verification" sections of docs/marzban-provisioning.md
and docs/xui-provisioning.md (`MARZBAN_STAGING_*` / `XUI_STAGING_*`
environment variables). The tests are disabled by default, prefix
everything with `zedstaging_`, clean up after themselves where delete
support exists and print any leftover safe identifier for manual cleanup.
