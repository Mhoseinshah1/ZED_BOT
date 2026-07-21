# ZED_BOT production security hardening (Phase 38)

Phase 38 adds **safe, non-destructive** server hardening: a ufw firewall
helper that cannot lock out SSH, a read-only security audit, minimal Docker
Compose hardening and one Nginx addition. Nothing in the application
changed — no payment/order/service/support/broadcast logic, no financial
rows, no Service rows, no destructive actions anywhere.

## Commands

```bash
zedbot firewall        # safe ufw setup (asks before enabling; SSH stays allowed)
zedbot security        # read-only PASS/WARN/FAIL audit (alias: zedbot security-check)
```

## Firewall behavior (`scripts/firewall-setup.sh`)

- Ubuntu/ufw only — on any other OS it warns with manual guidance and
  exits cleanly. ufw is installed if missing.
- **SSH lockout prevention:** the real SSH port is detected from the
  running daemon (`sshd -T`, then `sshd_config`, fallback 22) and its
  ALLOW rule is added **before** ufw can ever be enabled; as a second
  belt-and-braces check the script refuses to enable ufw if the SSH rule
  is not visible in `ufw show added`.
- Rules added (idempotent `ufw allow` — existing custom rules are never
  deleted and `ufw reset` is never used): SSH port/tcp, 80/tcp, 443/tcp;
  defaults `deny incoming` / `allow outgoing`.
- **Enabling is opt-in:** interactive runs ask (default No);
  non-interactive runs never enable unless `ZEDBOT_ENABLE_FIREWALL=1`.
  If ufw is already active, rules are just updated.
- Ends with `ufw status verbose`. Docker manages its own iptables chains,
  so container networking (and the loopback-only API binding) is
  unaffected.

## Security audit (`scripts/security-check.sh`)

Read-only, runs with or without root (root-only checks degrade to WARN),
never prints a secret value (the `.env` is parsed for key presence, never
sourced or echoed). Checks: `.env` exists with owner-only permissions;
compose file present; postgres/redis publish **no** host ports; the API is
loopback-bound; all services use `restart: unless-stopped`;
`no-new-privileges` present; the Nginx site exists when `APP_DOMAIN` is
set, and once a certificate exists it must carry the four security headers
plus `server_tokens off`; backup directory not world-accessible; all
management scripts present; a light scan of docs/README/.env.example for
credential-bearing database URLs (documentation placeholders are ignored);
ufw state; and the running containers' restart policy (root+docker only).

**Exit code:** non-zero only for the serious failures — `.env`
group/world-readable, postgres/redis published on a host port, or the API
published on a non-loopback interface. Everything else is a WARN.

Test overrides: `ZEDBOT_ENV_FILE` and `ZEDBOT_COMPOSE_FILE` point the
checks at arbitrary files (used by the automated tests).

## Docker Compose hardening

`api`, `bot` and `worker` gained:

```yaml
security_opt:
  - no-new-privileges:true
tmpfs:
  - /tmp
```

Already in place and verified: `restart: unless-stopped` on all five
services, no host ports for postgres/redis, loopback-only API.
**Deliberately skipped** (documented, not forgotten): `read_only: true`
and `cap_drop: ["ALL"]` for the Node services (untested against the app's
runtime file/capability needs — candidates for a later phase), any
hardening of postgres/redis themselves (they need writable data
directories), and container user changes (the Dockerfile is not prepared
for it).

## Nginx hardening

`server_tokens off;` was added to every generated server block (HTTP
bootstrap, HTTPS redirect and HTTPS 443). The four security headers from
Phase 37 (nosniff / DENY / no-referrer / HSTS) were already present and are
not duplicated. **No CSP yet** — a future web panel/mini app needs a
carefully scoped policy, so none is set now.

## Installer integration

After the HTTPS step, `install.sh` asks "Configure safe firewall rules
now?" (default **No**); non-interactive installs only run it when
`ZEDBOT_ENABLE_FIREWALL=1`. A firewall failure never fails the install.
The summary now lists `zedbot firewall` and `zedbot security`.

## Troubleshooting

- **ufw not installed** — `zedbot firewall` installs it (Ubuntu).
- **Non-standard SSH port** — detected from `sshd -T`; verify with
  `ufw status` that your port is allowed before disconnecting.
- **Docker vs ufw** — Docker inserts its own iptables rules ahead of ufw;
  published container ports can bypass ufw. That is exactly why postgres
  and redis publish no ports and the API binds to 127.0.0.1 — verify with
  `zedbot security`.
- **API still publicly reachable** — check `docker-compose.yml` has
  `127.0.0.1:${API_PORT}` and `zedbot restart`; `zedbot security` flags it
  as a serious FAIL otherwise.
- **Missing Nginx headers** — re-run `zedbot ssl` (headers live in the
  generated HTTPS config); `server_tokens` → re-run `zedbot nginx`.

## Intentionally NOT implemented

fail2ban, IDS/IPS, WAF/CDN/Cloudflare automation, kernel/sysctl tuning,
automatic OS unattended-upgrades, Docker image signing, secrets-manager
integration, CSP headers, `read_only`/`cap_drop` for the app containers
(see above), web panel, mini app, Phase 39+.

## Service self-diagnostics privacy (feat/service-self-diagnostics)

The user-facing diagnostics capability persists **no** per-run history. Aggregate
SystemLog events carry only overall/evidence codes, check status counts, panel
type, sanitized diagnostic codes, duration and a non-reversible correlation hash
(`sha256(userId:serviceId)` truncated) — never a User/Telegram/full-Service ID,
username, subscription URL, config, token, panel base URL/credentials, raw
response, remote client id or ticket text. A diagnostic snapshot is persisted only
after explicit support handoff and is strictly validated to be secret-free. See
`docs/service-self-diagnostics.md`.
