#!/usr/bin/env bash
# =============================================================================
# Referral migration LINEAGE STATUS (OWNER/operator diagnostic).
#
# Reports the selected migration attempt and its status, the checksum classification
# (ORIGINAL_LF / ORIGINAL_CRLF / PR110_LF / PR110_CRLF / UNKNOWN / NOT_APPLIED), every
# schema postcondition, the exact unique-index ownership/column result, current
# unresolved migration failures, historical rolled-back attempts (separately), and the
# final activation verdict for the 20260719180000 migration. READ-ONLY: it moves no
# money, changes no rows, and never rewrites migration metadata. It prints no
# credentials / DATABASE_URL and no order/user/commission ids.
#
#   sudo bash scripts/referral-migration-lineage-status.sh
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

main() {
  require_root
  app_cd
  detect_compose_command

  log_info "Referral migration lineage status ..."
  # Runs inside a one-off app container (starts postgres, waits for health) so the
  # host needs no Node/pnpm. The container inherits the configured DATABASE_URL.
  run_compose run --rm api node packages/database/dist/referral-migration-lineage-status.js
}

main "$@"
