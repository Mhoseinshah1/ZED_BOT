#!/usr/bin/env bash
# =============================================================================
# ZED_BOT database migrations + seed (+ legacy self-heal).
#
# Invoked automatically by install.sh and update.sh (they run this file when
# it exists and is executable). Applies pending Prisma migrations and then
# seeds baseline data (OWNER admins from ADMIN_TELEGRAM_IDS, default
# settings). Both steps are idempotent. Also runnable standalone.
#
# Runs inside a one-off app container so the host needs no Node/pnpm.
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

SOURCE_SNAPSHOT=""
SOURCE_SHA=""
SOURCE_TREE=""
migrate_owned_cleanup() {
  cleanup_source_snapshot "$SOURCE_SNAPSHOT" "$SOURCE_SHA" "$SOURCE_TREE"
}

# =============================================================================
# LEGACY SELF-HEAL - THE hook the PRE-PR92 updater executes on new code.
#
# The old updater (git show 4d0f3ba:scripts/update.sh) runs:
#   backup.sh -> git pull (fetches THIS code) -> compose build -> up -d
#   -> run_migrations_if_available -> doctor.sh
# run_migrations_if_available executes THIS file (it now exists and is
# executable), making it the ONLY new-code hook the legacy updater calls.
# Without the block below such an update leaves the OLD containers running
# (no --force-recreate), the OLD CLI installed (never refreshed) and the
# .env without the persistent-backup keys - the stale-production symptom
# this self-heal exists to fix. It is guarded by legacy_install_detected,
# so normal runs (new updater / installer, which converge env + CLI before
# calling this script) never do the work twice.
# =============================================================================
legacy_self_heal() {
  if ! legacy_install_detected; then
    return 0
  fi

  local cli_refresh_failed=0 snapshot_result

  log_warn "=================================================================="
  log_warn "Legacy installation detected - finishing the upgrade"
  log_warn "(env migration, CLI refresh, container recreation)"
  log_warn "=================================================================="

  # The pre-PR92 installer chmod +x'ed 644-committed scripts, leaving every
  # legacy tree mode-dirty; ignore mode bits so no later git operation on
  # this appliance repo can be blocked by installer-managed modes.
  git -C "$ZEDBOT_APP_DIR" config core.fileMode false 2>/dev/null || true

  load_env_if_exists
  migrate_legacy_env
  # Re-load so the freshly appended keys (ZEDBOT_BACKUP_DIR & co) apply.
  load_env_if_exists
  ensure_backup_dir_permissions

  if ! refresh_cli; then
    # Remember the failure but keep going: a stale CLI is bad, stale
    # containers are worse. The non-zero exit at the end still surfaces
    # the problem to the legacy updater.
    log_error "Installed CLI refresh FAILED - continuing with the remaining self-heal steps."
    cli_refresh_failed=1
  fi

  # Rebuild with the deployment identity baked in. The GIT_SHA layers are
  # the LAST ones in the Dockerfile, so everything else is cached and this
  # rebuild is nearly free.
  GIT_SHA="$(repo_head_sha)"
  export GIT_SHA="${GIT_SHA:-unknown}"
  log_info "Rebuilding images with deployment identity (GIT_SHA=${GIT_SHA}) ..."
  run_compose_with_deployment_sha "$GIT_SHA" build

  # --force-recreate is the actual fix for the observed production symptom:
  # the legacy updater's plain `up -d` left the OLD containers (old image,
  # old mounts, old env) running after the rebuild.
  log_info "Recreating all containers with the new images and .env ..."
  run_compose up -d --force-recreate --remove-orphans

  # main() already acquired the deployment lock for the whole script;
  # acquiring it again here would fail closed ("this process already owns
  # the deployment lock"). Still re-derive deployment-state paths, since
  # migrate_legacy_env above may have appended keys the resolution depends on.
  reset_deployment_state_fixed_identity
  snapshot_result="$(prepare_exact_origin_main)" || return 1
  read -r SOURCE_SHA SOURCE_TREE SOURCE_SNAPSHOT <<< "$snapshot_result"
  register_source_snapshot "$SOURCE_SNAPSHOT" "$SOURCE_SHA" "$SOURCE_TREE" || return 1
  publish_validated_legacy_self_heal "$SOURCE_SHA" "$SOURCE_TREE" "$SOURCE_SNAPSHOT" || return 1
  record_deployed_sha "$SOURCE_SHA"
  cleanup_source_snapshot "$SOURCE_SNAPSHOT" "$SOURCE_SHA" "$SOURCE_TREE" || return 1
  release_deployment_lock || return 1

  if [ "$cli_refresh_failed" -ne 0 ]; then
    log_error "Legacy self-heal finished WITH ERRORS (CLI refresh failed). Re-run: zedbot update"
    return 1
  fi
  log_success "Legacy self-heal completed - the installation now matches the current layout."
}

main() {
  require_root
  reset_deployment_state_fixed_identity
  app_cd
  load_env_if_exists
  reset_deployment_state_fixed_identity
  reset_compose_fixed_identity
  # shellcheck disable=SC2034  # re-pinned after load_env_if_exists could have
  # sourced a hostile .env; read by run_compose() etc. in the sourced common.sh.
  ZEDBOT_CANONICAL_COMPOSE_FILE="$ZEDBOT_CANONICAL_PROJECT_DIR/docker-compose.yml"
  detect_compose_command
  # This file is also runnable standalone (see the header comment), not just
  # as install.sh/update.sh's own internal migration step - a schema
  # mutation that races an in-progress update/rollback (which holds this
  # SAME lock throughout) could apply new migrations after that operation
  # already captured its pre-deploy migration baseline or compatibility
  # snapshot, invalidating a decision it already made. Held for the whole
  # script; legacy_self_heal below no longer acquires it a second time.
  acquire_deployment_lock

  # PREFLIGHT (runs BEFORE migrate deploy): on a legacy database that predates the
  # one-commission-per-order unique index and accumulated duplicate orderId rows,
  # fail loudly with an actionable message here rather than let the index-creating
  # migration abort with PostgreSQL's opaque error. Moves no money, deletes no rows.
  log_info "Referral migration preflight (duplicate orderId check) ..."
  if ! run_compose run --rm api node packages/database/dist/referral-migration-preflight.js; then
    log_error "Referral migration preflight FAILED — resolve duplicate ReferralCommission.orderId rows"
    log_error "before deploying (see docs/referral-migration-preflight.md). No migrations were applied."
    exit 1
  fi
  log_success "Referral migration preflight passed."

  log_info "Applying database migrations (prisma migrate deploy) ..."
  # `compose run` starts the postgres/redis dependencies and waits for their
  # healthchecks before executing.
  run_compose run --rm api \
    sh -c 'cd packages/database && node_modules/.bin/prisma migrate deploy'
  log_success "Database migrations applied."

  log_info "Seeding baseline data (admins from ADMIN_TELEGRAM_IDS, default settings) ..."
  run_compose run --rm api node packages/database/dist/seed.js
  log_success "Seed completed."

  legacy_self_heal
}

install_operation_traps migrate_owned_cleanup
main "$@"
