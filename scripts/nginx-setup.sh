#!/usr/bin/env bash
# =============================================================================
# ZED_BOT Nginx reverse-proxy setup (used by `zedbot nginx`).
#
# Writes /etc/nginx/sites-available/zedbot.conf proxying APP_DOMAIN to
# http://127.0.0.1:${API_PORT}, enables it, prepares the ACME webroot and
# reloads Nginx. Before a certificate exists the site is HTTP-only; when
# /etc/letsencrypt/live/<domain>/fullchain.pem is already present (re-run
# after `zedbot ssl`) the HTTPS config is rendered instead, so re-running
# never downgrades a working HTTPS setup.
#
# Test/CI mode (no root, nothing written):
#   nginx-setup.sh --print [http|https]   renders the config to stdout.
#
# Never prints secrets - only APP_DOMAIN and the local port appear.
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

PRINT_MODE=""
if [ "${1:-}" = "--print" ]; then
  PRINT_MODE="${2:-http}"
  case "$PRINT_MODE" in
    http | https) ;;
    *)
      log_error "Usage: nginx-setup.sh [--print http|https]"
      exit 1
      ;;
  esac
fi

# Environment values win (test mode); otherwise read the installed .env.
if [ -z "${APP_DOMAIN:-}" ]; then
  load_env_if_exists
fi

APP_DOMAIN="$(printf '%s' "${APP_DOMAIN:-}" | tr '[:upper:]' '[:lower:]')"
API_PORT="${API_PORT:-3000}"

if ! is_valid_domain "$APP_DOMAIN"; then
  log_error "APP_DOMAIN is missing or not a valid domain name (set it in .env, e.g. bot.example.com)."
  exit 1
fi
if ! is_valid_port "$API_PORT"; then
  log_error "API_PORT is not a valid port number."
  exit 1
fi

render_site_config() {
  local kind="$1"
  if [ "$kind" = "https" ]; then
    render_nginx_https_config "$APP_DOMAIN" "$API_PORT"
  else
    render_nginx_http_config "$APP_DOMAIN" "$API_PORT"
  fi
}

if [ -n "$PRINT_MODE" ]; then
  render_site_config "$PRINT_MODE"
  exit 0
fi

main() {
  require_root

  if ! has_command nginx; then
    log_info "Installing Nginx ..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y nginx
    log_success "Nginx installed."
  fi

  ensure_directory "$ZEDBOT_ACME_WEBROOT" 755

  local kind="http"
  if [ -f "/etc/letsencrypt/live/${APP_DOMAIN}/fullchain.pem" ]; then
    kind="https"
    log_info "Existing certificate found - keeping the HTTPS configuration."
  fi

  log_info "Writing ${ZEDBOT_NGINX_SITE_AVAILABLE} (${kind}, ${APP_DOMAIN} -> 127.0.0.1:${API_PORT}) ..."
  render_site_config "$kind" > "$ZEDBOT_NGINX_SITE_AVAILABLE"
  ln -sf "$ZEDBOT_NGINX_SITE_AVAILABLE" "$ZEDBOT_NGINX_SITE_ENABLED"

  # Disable the distro default site (unlink only - the file itself stays).
  if [ -L /etc/nginx/sites-enabled/default ] || [ -e /etc/nginx/sites-enabled/default ]; then
    unlink /etc/nginx/sites-enabled/default
    log_info "Disabled the default Nginx site (sites-available/default is kept)."
  fi

  test_and_reload_nginx

  if [ "$kind" = "http" ]; then
    log_success "Nginx is proxying http://${APP_DOMAIN} -> 127.0.0.1:${API_PORT}."
    log_info "Next: request the certificate with: zedbot ssl"
  else
    log_success "Nginx is serving https://${APP_DOMAIN} -> 127.0.0.1:${API_PORT}."
  fi
}

main "$@"
