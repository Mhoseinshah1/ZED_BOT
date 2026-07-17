#!/usr/bin/env bash
# =============================================================================
# ZED_BOT updater (self-healing):
#   safety archive -> database backup + verification gate -> pull
#   -> migrate legacy .env -> refresh installed CLI -> build (with identity)
#   -> migrate DB -> force-recreate -> record deploy -> post-deploy smoke
#   -> doctor
#
# The update ABORTS before touching any code when the pre-update database
# backup cannot be created AND verified - the running installation is left
# untouched. CLI-only escape hatch (use at your own risk):
#   ZEDBOT_SKIP_PREUPDATE_BACKUP=1 zedbot update
#
# Safe to run multiple times. Never prints secrets.
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

on_update_error() {
  log_error "ZED_BOT update FAILED. Your data and .env were NOT deleted."
  log_error "Recovery steps:"
  log_error "  1. Inspect what went wrong:   zedbot logs        (or: zedbot doctor)"
  log_error "  2. Retry the update:          zedbot update"
  log_error "  3. If the app is broken, restore the pre-update backup MANUALLY:"
  log_error "       zedbot restore-help      (prints the manual restore steps)"
}
trap on_update_error ERR

# Finds the newest database backup file (any supported format) in the host
# backup directory. Prints its path; prints nothing when none exists.
newest_db_backup() {
  find "$ZEDBOT_BACKUP_DIR" -maxdepth 1 -type f \
    \( -name 'zedbot-db-*.dump' -o -name 'zedbot-db-*.dump.enc' -o -name 'zedbot-db-*.sql.gz' \) \
    -printf '%T@ %p\n' 2>/dev/null | sort -rn | head -n 1 | cut -d' ' -f2-
}

# Verifies one backup file; returns non-zero on any doubt.
verify_backup_file() {
  local file="$1"
  case "$file" in
    *.dump)
      # The postgres container's pg_restore must be able to read the
      # archive's table of contents (file travels over stdin).
      run_compose exec -T postgres pg_restore --list /dev/stdin < "$file" > /dev/null
      ;;
    *.dump.enc)
      # Full decryption checks need the worker's verify CLI; fall back to a
      # ZBK1 envelope header check when the CLI is not shipped yet.
      if run_compose run --rm --no-deps worker sh -c \
        'test -f apps/worker/dist/cli/verify-backup.js' >/dev/null 2>&1; then
        run_compose run --rm --no-deps worker node apps/worker/dist/cli/verify-backup.js \
          "/var/lib/zedbot/backups/${file##*/}"
      else
        log_warn "Worker verify CLI not available - checking the ZBK1 envelope header only."
        [ "$(head -c 4 "$file" 2>/dev/null)" = "ZBK1" ]
      fi
      ;;
    *.sql.gz)
      gzip -t "$file"
      ;;
    *)
      return 1
      ;;
  esac
}

pre_update_database_backup() {
  if [ "${ZEDBOT_SKIP_PREUPDATE_BACKUP:-0}" = "1" ]; then
    log_warn "ZEDBOT_SKIP_PREUPDATE_BACKUP=1 - SKIPPING the pre-update database backup gate."
    log_warn "If this update breaks the database there is no fresh backup to fall back to."
    return 0
  fi

  # Auto-repair for installations that predate the shared backup mount: the
  # directory must be owned by the container runtime user with mode 750.
  ensure_backup_dir_permissions

  if ! bash "${SCRIPT_DIR}/backup-db.sh"; then
    log_error "Pre-update database backup FAILED - ABORTING the update."
    log_error "The running installation was not modified."
    log_error "Fix the backup problem ('zedbot doctor', 'zedbot logs postgres') and retry,"
    log_error "or (NOT recommended) force past this gate with:"
    log_error "  ZEDBOT_SKIP_PREUPDATE_BACKUP=1 zedbot update"
    exit 1
  fi

  local newest
  newest="$(newest_db_backup)"
  if [ -z "$newest" ]; then
    log_error "No database backup found after a successful backup run - ABORTING the update."
    exit 1
  fi
  log_info "Verifying the pre-update backup ${newest##*/} ..."
  if ! verify_backup_file "$newest"; then
    log_error "Pre-update backup verification FAILED (${newest##*/}) - ABORTING the update."
    log_error "The running installation was not modified."
    exit 1
  fi
  log_success "Pre-update database backup verified: ${newest##*/}"
}

# Retries a bot-container exec a few times: with a broken bot token the bot
# process crash-loops by design (it sleeps before exiting, so the container
# is Running most of the time) - a single exec could hit the restart gap.
bot_exec_with_retry() {
  local attempts="${1:-6}" delay="${2:-5}"
  shift 2
  local i
  for ((i = 1; i <= attempts; i++)); do
    if run_compose exec -T bot "$@" >/dev/null 2>&1; then
      return 0
    fi
    [ "$i" -lt "$attempts" ] && sleep "$delay"
  done
  return 1
}

# Post-deploy smoke: the worker CLI performs a bounded end-to-end check
# (redis ping, running-worker heartbeat, backup-dir write, pg_dump/
# pg_restore, ONE real backup enqueued to the RUNNING worker and verified),
# then the bot's read-only view of the backup mount is confirmed from the
# host. On ANY failure the application is deliberately KEPT RUNNING - a
# failed smoke is a signal to investigate, never a reason to yank a live
# deployment - but the update exits non-zero.
post_deploy_smoke() {
  local smoke_json="" smoke_rc=0
  # The worker smoke CLI guarantees secret-free one-line JSON, so echoing
  # its output is safe. Never echo .env values here.
  smoke_json="$(run_compose run --rm --no-deps worker node apps/worker/dist/cli/deploy-smoke.js)" || smoke_rc=$?
  if [ -n "$smoke_json" ]; then
    printf '%s\n' "$smoke_json"
  fi

  # Bot-side read check through the read-only mount.
  local bot_read_ok=1
  if ! bot_exec_with_retry 6 5 sh -c 'ls "${BACKUP_DIR:-/var/lib/zedbot/backups}" >/dev/null'; then
    bot_read_ok=0
  fi

  # When the smoke produced a backup file, the bot must see that exact file
  # through its mount (proves both containers share the host directory).
  local bot_file_ok=1 smoke_file=""
  smoke_file="$(printf '%s' "$smoke_json" | grep -o '"filename":"[^"]*"' | head -n 1 | cut -d'"' -f4 || true)"
  if [ -n "$smoke_file" ]; then
    # Validate the name shape before it goes anywhere near a shell command.
    if printf '%s' "$smoke_file" | grep -Eq '^zedbot-db-[0-9-]*\.dump(\.enc)?$'; then
      if ! bot_exec_with_retry 6 5 sh -c 'test -f "${BACKUP_DIR:-/var/lib/zedbot/backups}/$1"' _ "$smoke_file"; then
        bot_file_ok=0
      fi
    else
      log_warn "Smoke reported an unexpected backup file name shape - skipping the bot-side file check."
    fi
  fi

  if [ "$smoke_rc" -eq 0 ] && [ "$bot_read_ok" -eq 1 ] && [ "$bot_file_ok" -eq 1 ]; then
    log_success "Post-deploy smoke passed."
    return 0
  fi

  local category=""
  category="$(printf '%s' "$smoke_json" | grep -o '"failureCategory":"[^"]*"' | head -n 1 | cut -d'"' -f4 || true)"
  if [ -n "$category" ]; then
    log_error "Post-deploy smoke FAILED - failure category: ${category}"
  else
    log_error "Post-deploy smoke FAILED."
  fi
  if [ "$bot_read_ok" -eq 0 ]; then
    log_error "bot: cannot read the backup mount (/var/lib/zedbot/backups in-container)."
  fi
  if [ "$bot_file_ok" -eq 0 ]; then
    log_error "bot: the smoke backup file is not visible through the read-only mount."
  fi
  log_error "The application was left RUNNING (no rollback). Recovery commands:"
  log_error "  zedbot doctor --fix       (diagnose; repairs backup dir + stale CLI)"
  log_error "  zedbot repair backups     (fix backup mount ownership/permissions)"
  log_error "  zedbot logs worker        (inspect the worker)"
  log_error "  zedbot update             (retry once fixed)"
  exit 1
}

main() {
  require_root
  app_cd
  load_env_if_exists
  detect_compose_command

  log_info "Starting ZED_BOT update ..."

  log_info "[1/11] Creating a safety archive (.env + database) before updating ..."
  bash "${SCRIPT_DIR}/backup.sh"

  log_info "[2/11] Creating and verifying a database backup (update gate) ..."
  pre_update_database_backup

  log_info "[3/11] Pulling the latest code ..."
  # --add appends duplicates on every run; only add when missing.
  if ! git config --global --get-all safe.directory 2>/dev/null | grep -qxF "$ZEDBOT_APP_DIR"; then
    git config --global --add safe.directory "$ZEDBOT_APP_DIR" >/dev/null 2>&1 || true
  fi
  # Script modes on this appliance are the installer's job, not git's: the
  # pre-PR92 installer chmod +x'ed scripts that were committed 644, which
  # made every legacy tree permanently "dirty" and silently blocked ff-only
  # pulls (the update then "succeeded" without ever fetching new code).
  # Ignoring mode bits removes that whole failure class.
  git config core.fileMode false
  git fetch --all --prune
  if ! git pull --ff-only; then
    log_warn "Could not fast-forward the repository (local modifications?). Continuing with the current code."
  fi

  log_info "[4/11] Migrating the .env to the current layout (append-only) ..."
  migrate_legacy_env
  # Re-load so freshly appended keys (ZEDBOT_BACKUP_DIR & co) take effect.
  load_env_if_exists
  ensure_backup_dir_permissions

  log_info "[5/11] Refreshing the installed zedbot CLI ..."
  # Failure to refresh the CLI must fail the update: a stale installed CLI
  # driving new code is exactly the class of bug this updater prevents.
  if ! refresh_cli; then
    log_error "Could not refresh ${ZEDBOT_CLI_PATH} from the updated repository - ABORTING the update."
    log_error "Fix the problem (disk full? read-only /usr/local/bin?) and retry: zedbot update"
    exit 1
  fi

  log_info "[6/11] Building updated images (with deployment identity) ..."
  # GIT_SHA travels into the image as its LAST layers (see Dockerfile), so
  # identity-only rebuilds stay cheap.
  GIT_SHA="$(repo_head_sha)"
  export GIT_SHA="${GIT_SHA:-unknown}"
  run_compose build

  log_info "[7/11] Applying database migrations (before the new app containers run) ..."
  # `compose run` inside migrate.sh starts postgres/redis itself. The app
  # services still run the OLD code at this point - the safe direction (old
  # code on a newer schema beats new code on an older schema). migrate.sh's
  # legacy self-heal no-ops here: steps 4-5 already converged env + CLI.
  bash "${SCRIPT_DIR}/migrate.sh"

  log_info "[8/11] Recreating all services with the new images ..."
  # --force-recreate is THE fix for the stale-container symptom observed in
  # production: a plain `up -d` can leave the previous containers (previous
  # image, previous mounts, previous env) running after a rebuild.
  run_compose up -d --force-recreate --remove-orphans

  log_info "[9/11] Recording the deployed version ..."
  record_deployed_sha

  log_info "[10/11] Running the post-deploy smoke test ..."
  post_deploy_smoke

  log_info "[11/11] Running health checks ..."
  if bash "${SCRIPT_DIR}/doctor.sh"; then
    log_success "ZED_BOT update completed successfully."
  else
    log_warn "Update finished, but the doctor reported problems. Run 'zedbot doctor' for details."
  fi
}

main "$@"
