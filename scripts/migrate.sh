#!/usr/bin/env bash
# =============================================================================
# ZED_BOT database migrations + seed.
#
# Invoked automatically by install.sh and update.sh (they run this file when
# it exists and is executable). Applies pending Prisma migrations and then
# seeds baseline data (OWNER admins from ADMIN_TELEGRAM_IDS, default
# settings). Both steps are idempotent.
#
# Runs inside a one-off app container so the host needs no Node/pnpm.
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

main() {
  require_root
  app_cd
  detect_compose_command

  log_info "Applying database migrations (prisma migrate deploy) ..."
  # `compose run` starts the postgres/redis dependencies and waits for their
  # healthchecks before executing.
  run_compose run --rm api \
    sh -c 'cd packages/database && node_modules/.bin/prisma migrate deploy'
  log_success "Database migrations applied."

  log_info "Seeding baseline data (admins from ADMIN_TELEGRAM_IDS, default settings) ..."
  run_compose run --rm api node packages/database/dist/seed.js
  log_success "Seed completed."
}

main "$@"
