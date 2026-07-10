# ZED_BOT production HTTPS (Phase 37)

Phase 37 wires the public production endpoint through **Nginx + Let's
Encrypt**: `https://<APP_DOMAIN>/health` (and any API routes) terminate TLS
at Nginx and proxy to the API container on `127.0.0.1:<API_PORT>`. Nothing
in the application changed — no payment/order/service/support/broadcast
logic, no financial rows, no Service rows.

## Prerequisites

1. The install (Phase 36) completed and `zedbot doctor` is green.
2. The domain's **A record points at this server's IP** (and has
   propagated).
3. Ports **80 and 443** are reachable from the internet (the SSL script
   opens 'Nginx Full' in ufw when ufw is active — it never touches SSH
   rules).
4. `.env` contains `APP_DOMAIN` (and optionally `SSL_EMAIL`, default
   `admin@<APP_DOMAIN>`; `API_PORT` defaults to 3000).

## Commands

```bash
zedbot nginx          # install Nginx if missing, write + enable the site, reload
zedbot ssl            # certbot webroot certificate, then switch the site to HTTPS
zedbot https-status   # nginx state, certbot certificates, HTTPS health probe
zedbot renew-cert     # force `certbot renew` + nginx reload
```

The installer offers the same setup interactively at the end
("Setup Nginx and HTTPS now?"); non-interactive installs only run it when
`ZEDBOT_SETUP_SSL=1` is set. A failed certificate request never fails the
installation — the app keeps running and `zedbot ssl` can be re-run once
DNS is ready.

## What gets installed

| path | purpose |
| --- | --- |
| `/etc/nginx/sites-available/zedbot.conf` | the generated site (symlinked into `sites-enabled`) |
| `/var/www/letsencrypt` | ACME webroot for HTTP-01 challenges |
| `/etc/letsencrypt/live/<domain>/` | certificate + key (certbot-managed) |

`zedbot nginx` writes the **HTTP-only** bootstrap config (ACME location +
proxy) and disables the distro default site (unlink only — the file stays).
`zedbot ssl` requests the certificate in **webroot mode** (the Nginx config
stays fully under our control), then rewrites the site to the **HTTPS**
config: port 80 → 301 redirect (except `/.well-known/acme-challenge/`),
port 443 with `http2`, the certificate paths, and the hardening headers —
`X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy: no-referrer`, and `Strict-Transport-Security` (HSTS is
only ever present in the HTTPS config). Re-running `zedbot nginx` after a
certificate exists keeps the HTTPS config — it never downgrades. Every
change runs `nginx -t` before reloading; a failed test leaves the running
config untouched.

Renewal: certbot installs a systemd timer automatically on Ubuntu;
`zedbot renew-cert` forces a pass and reloads Nginx.

## Network exposure

- The API container binds to **`127.0.0.1:<API_PORT>` only**
  (`docker-compose.yml`); the public entrypoint is Nginx on 80/443.
- PostgreSQL and Redis are not published on any host port (unchanged).

## Troubleshooting

- **DNS not propagated** — certbot fails HTTP-01: check
  `dig +short <domain>` matches the server IP, then `zedbot ssl` again.
- **Port 80 blocked** — hosting firewall/security group or ufw: allow
  80/443, retry.
- **`nginx -t` failed** — the scripts abort before reloading; inspect the
  printed error, fix `/etc/nginx/sites-available/zedbot.conf` (or re-run
  `zedbot nginx` to regenerate), reload.
- **Let's Encrypt rate limit** — repeated failed issuance can hit limits;
  wait (typically an hour, up to a week for duplicates) and retry.

## Security notes

- `APP_DOMAIN` is validated with a conservative hostname regex before it is
  ever written into the Nginx config (URLs, IPs like `127.0.0.1`, shell
  metacharacters and empty values are rejected) — no unsafe `server_name`.
- The scripts print only the domain and local port — never tokens,
  passwords or other `.env` values; certbot receives only the public domain
  and contact email.
- No destructive commands were added; ufw changes are additive
  ('Nginx Full') and never touch SSH.

## Testing

`apps/bot/tests/https-scripts.test.ts`: `bash -n` over the three new
scripts (the Phase 36 four stay covered); `zedbot help` listing
`nginx`/`ssl`/`renew-cert`/`https-status` while still exposing no
uninstall/destructive-restore; config generation via
`nginx-setup.sh --print http|https` (server_name, loopback proxy_pass, ACME
location, redirect/HSTS/cert paths only in the HTTPS variant, no secrets);
the domain validator rejecting `example.com; rm -rf /`,
`http://example.com`, `127.0.0.1` and empty input; and this doc mentioning
the DNS/port prerequisites. certbot is never executed by tests.

## Intentionally NOT implemented

Cloudflare/CDN/WAF automation, wildcard certificates, multi-domain
management, Telegram webhook migration (the bot uses long polling), web
panel, mini app, Phase 38+.
