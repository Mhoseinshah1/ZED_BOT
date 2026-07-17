#!/usr/bin/env bash
# =============================================================================
# ZED_BOT Let's Encrypt setup (used by `zedbot ssl`).
#
# Requests a certificate for APP_DOMAIN via certbot in WEBROOT mode (the
# Nginx config stays fully under our control), then rewrites the site to the
# HTTPS configuration (80 -> 301 redirect except the ACME path, 443 with the
# hardening headers incl. HSTS) and reloads Nginx.
#
# Prerequisites: the domain's A record points at this server and port 80 is
# reachable. No secrets are printed; certbot receives only the (public)
# domain and contact email.
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

main() {
  require_root
  load_env_if_exists

  local domain port email
  domain="$(printf '%s' "${APP_DOMAIN:-}" | tr '[:upper:]' '[:lower:]')"
  port="${API_PORT:-3000}"
  email="${SSL_EMAIL:-}"

  if ! is_valid_domain "$domain"; then
    log_error "APP_DOMAIN is missing or not a valid domain name (set it in .env, e.g. bot.example.com)."
    exit 1
  fi
  if ! is_valid_port "$port"; then
    log_error "API_PORT is not a valid port number."
    exit 1
  fi
  if [ -z "$email" ]; then
    email="admin@${domain}"
    log_info "SSL_EMAIL is not set - using ${email}."
  fi
  if ! printf '%s' "$email" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'; then
    log_error "SSL_EMAIL is not a valid email address."
    exit 1
  fi

  # The HTTP site (with the ACME webroot) must exist before certbot runs.
  if [ ! -f "$ZEDBOT_NGINX_SITE_AVAILABLE" ] || ! has_command nginx; then
    log_info "Nginx site not found - running nginx-setup first ..."
    bash "${SCRIPT_DIR}/nginx-setup.sh"
  fi
  ensure_directory "$ZEDBOT_ACME_WEBROOT" 755

  if ! has_command certbot; then
    log_info "Installing certbot ..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y certbot
    log_success "certbot installed."
  fi

  # Best-effort firewall check: open 80/443 when ufw is active. Never
  # touches SSH rules, never fails the run.
  if has_command ufw && ufw status 2>/dev/null | grep -q '^Status: active'; then
    if ! ufw status 2>/dev/null | grep -Eq '(Nginx Full|80[,/])'; then
      log_warn "ufw is active - allowing 'Nginx Full' (ports 80/443)."
      ufw allow 'Nginx Full' >/dev/null 2>&1 \
        || log_warn "Could not add the ufw rule automatically. Allow ports 80/443 manually: ufw allow 'Nginx Full'"
    fi
  fi

  log_info "Requesting a Let's Encrypt certificate for ${domain} (webroot mode) ..."
  if ! certbot certonly --webroot \
    -w "$ZEDBOT_ACME_WEBROOT" \
    -d "$domain" \
    --email "$email" \
    --agree-tos \
    --non-interactive \
    --keep-until-expiring; then
    log_error "certbot failed. Common causes:"
    log_error "  - The DNS A record of ${domain} does not point to this server yet."
    log_error "  - Port 80 is blocked by a firewall or another program."
    log_error "  - Let's Encrypt rate limits (wait an hour and retry)."
    log_error "Fix the cause and run again: zedbot ssl"
    exit 1
  fi

  if [ ! -f "/etc/letsencrypt/live/${domain}/fullchain.pem" ]; then
    log_error "certbot reported success but the certificate files are missing - aborting without changing Nginx."
    exit 1
  fi

  log_info "Switching Nginx to the HTTPS configuration ..."
  render_nginx_https_config "$domain" "$port" > "$ZEDBOT_NGINX_SITE_AVAILABLE"
  ln -sf "$ZEDBOT_NGINX_SITE_AVAILABLE" "$ZEDBOT_NGINX_SITE_ENABLED"
  test_and_reload_nginx

  log_success "HTTPS is active: https://${domain}/health"
  log_info "Renewal: certbot installs a systemd timer automatically; 'zedbot renew-cert' forces a run."
}

main "$@"
