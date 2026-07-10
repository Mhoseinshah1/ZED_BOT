#!/usr/bin/env bash
# =============================================================================
# ZED_BOT certificate renewal (used by `zedbot renew-cert`).
#
# certbot normally installs a systemd timer that renews automatically; this
# script forces a renewal pass and reloads Nginx so a renewed certificate is
# picked up immediately. Safe to run any time - certbot only renews
# certificates that are close to expiry.
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

main() {
  require_root

  if ! has_command certbot; then
    log_error "certbot is not installed. Set up HTTPS first: zedbot ssl"
    exit 1
  fi

  log_info "Running certbot renew ..."
  certbot renew --quiet
  log_success "Certificate renewal check completed."

  if has_command nginx; then
    test_and_reload_nginx
  else
    log_warn "Nginx is not installed - nothing to reload."
  fi
}

main "$@"
