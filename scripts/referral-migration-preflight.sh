#!/usr/bin/env bash
# =============================================================================
# Referral migration PREFLIGHT (standalone). Detects duplicate non-null
# ReferralCommission.orderId rows and FAILS LOUDLY before any migration runs.
#
# This is a SEPARATE deployment step — NOT a migration — so the already-applied
# migration history stays immutable. scripts/migrate.sh runs it automatically
# BEFORE `prisma migrate deploy`; run it by hand to check a database without
# deploying: `sudo bash scripts/referral-migration-preflight.sh`.
#
# It uses the configured DATABASE_URL, moves no money, deletes no rows and prints
# no full order ids. Exit 0 = clean (or fresh db), non-zero = duplicates / error.
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

main() {
  require_root
  app_cd
  detect_compose_command

  log_info "Referral migration preflight (duplicate orderId check) ..."
  # Runs inside a one-off app container (starts postgres, waits for health) so the
  # host needs no Node/pnpm. The container inherits the configured DATABASE_URL.
  run_compose run --rm api node packages/database/dist/referral-migration-preflight.js
  log_success "Referral migration preflight passed."
}

main "$@"
