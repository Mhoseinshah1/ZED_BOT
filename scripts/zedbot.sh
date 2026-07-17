#!/usr/bin/env bash
# =============================================================================
# ZED_BOT server management CLI (canonical script).
# Installed to /usr/local/bin/zedbot by scripts/install.sh.
#
# Restore is INSTRUCTIONS ONLY: `zedbot restore` / `zedbot restore-help`
# print the manual steps and exit without touching anything.
# =============================================================================

set -Eeuo pipefail

ZEDBOT_APP_DIR="${ZEDBOT_APP_DIR:-/opt/zedbot/app}"
SCRIPTS_DIR="${ZEDBOT_APP_DIR}/scripts"
COMMON_LIB="${SCRIPTS_DIR}/lib/common.sh"

usage() {
  cat <<'EOF'
ZED_BOT management CLI

Usage: zedbot <command> [arguments]

Commands:
  status                  Show the status of all services
  ps                      Alias of status (docker compose ps)
  logs [service]          Tail logs (all services, or one of: api, bot, worker, postgres, redis)
  restart                 Restart all services (re-reads .env)
  start                   Start all services
  stop                    Stop all services
  update                  Update ZED_BOT to the latest version (creates + verifies a backup first)
  deploy-status           Show repository/image/container version alignment and migration status
  backup [create]         Create a verified database backup (zedbot-db-<stamp>.dump[.enc] + manifest)
  backup list             List all backups (name, size, date, type, verified)
  backup verify <file>    Verify a backup by file name, path or timestamp id
  repair backups          Fix backup directory ownership/permissions and test container access
  health                  Quick health summary (services, database, disk)
  doctor                  Run the full system health checks (doctor --fix repairs the backup dir)
  shell [service]         Open a shell inside a container (default: bot)
  env-check               Validate the .env configuration (never prints values)
  nginx                   Set up / refresh the Nginx reverse proxy for APP_DOMAIN
  ssl                     Request the Let's Encrypt certificate and enable HTTPS
  renew-cert              Force a certificate renewal check and reload Nginx
  https-status            Show Nginx/certificate status and probe https://APP_DOMAIN/health
  firewall                Safe ufw setup (SSH is allowed BEFORE the firewall is enabled)
  security                Run the read-only security audit (alias: security-check)
  restore-help            Print MANUAL database restore instructions (nothing is executed)
  help                    Show this help

Examples:
  zedbot status
  zedbot logs api
  zedbot backup
  zedbot backup list
  zedbot env-check
EOF
}

restore_help() {
  cat <<'EOF'
ZED_BOT manual database restore - INSTRUCTIONS ONLY
====================================================
This command executes NOTHING and changes NOTHING. Restore from Telegram or
from this CLI is intentionally not implemented; run the steps below manually
on the server.

  0. Take a FRESH backup first:
       zedbot backup

  1. Pick the backup file to restore (newest first):
       zedbot backup list
       ls -1t /opt/zedbot/backups/zedbot-db-*

  2. Stop the application services (keep postgres running):
       cd /opt/zedbot/app
       docker compose stop api bot worker

  3. Restore the dump (values for <POSTGRES_USER> / <POSTGRES_DB> are in
     /opt/zedbot/app/.env - do not paste them into chats or logs):

     a) Custom-format dump (zedbot-db-YYYYMMDD-HHMMSS.dump):
          docker compose exec -T postgres pg_restore --clean --if-exists \
            -U <POSTGRES_USER> -d <POSTGRES_DB> < /opt/zedbot/backups/zedbot-db-YYYYMMDD-HHMMSS.dump

     b) Encrypted dump (.dump.enc): decrypt it first with the worker tooling
        (requires BACKUP_ENCRYPTION_PASSWORD from .env), then restore the
        resulting .dump as in (a). Check the file first:
          zedbot backup verify zedbot-db-YYYYMMDD-HHMMSS.dump.enc

     c) Legacy plain SQL (zedbot-db-YYYYMMDD-HHMMSS.sql.gz):
          gunzip -c /opt/zedbot/backups/zedbot-db-YYYYMMDD-HHMMSS.sql.gz \
            | docker compose exec -T postgres psql -U <POSTGRES_USER> -d <POSTGRES_DB>

  4. Start everything again and verify:
       docker compose up -d
       zedbot doctor
EOF
}

CMD="${1:-help}"
shift || true

# Print-only commands work everywhere, even before installation.
case "$CMD" in
  help | --help | -h)
    usage
    exit 0
    ;;
  restore | restore-help)
    restore_help
    exit 0
    ;;
esac

if [ ! -f "$COMMON_LIB" ]; then
  echo "[FAIL] ZED_BOT does not look installed (missing ${COMMON_LIB})." >&2
  echo "       Install it with:" >&2
  echo "       bash <(curl -fsSL https://raw.githubusercontent.com/Mhoseinshah1/ZED_BOT/main/scripts/install.sh)" >&2
  exit 1
fi
# shellcheck source=lib/common.sh
. "$COMMON_LIB"

health_summary() {
  local backup_dir="$ZEDBOT_BACKUP_DIR"
  log_info "Services:"
  run_compose ps || true
  if compose_service_running postgres; then
    if run_compose exec -T postgres pg_isready >/dev/null 2>&1; then
      log_success "Database: accepting connections."
    else
      log_error "Database: container is up but pg_isready failed."
    fi
  else
    log_error "Database: postgres container is not running."
  fi
  if [ -d "$backup_dir" ]; then
    log_info "Backup disk usage (${backup_dir}):"
    df -h "$backup_dir" | tail -n 1 || true
  else
    log_warn "Backup directory does not exist yet: ${backup_dir}"
  fi
}

# Reads the "verified" flag from a backup's sidecar manifest ("yes", "no" or
# "-" when there is no manifest). Plain grep - never sources anything.
manifest_verified_flag() {
  local manifest="$1"
  if [ ! -f "$manifest" ]; then
    printf -- '-'
    return 0
  fi
  if grep -Eq '"verified"[[:space:]]*:[[:space:]]*true' "$manifest"; then
    printf 'yes'
  else
    printf 'no'
  fi
}

backup_list() {
  local dir="$ZEDBOT_BACKUP_DIR"
  if [ ! -d "$dir" ]; then
    log_warn "Backup directory does not exist yet: ${dir}"
    exit 0
  fi
  local files
  files="$(find "$dir" -maxdepth 1 -type f \
    \( -name 'zedbot-db-*.dump' -o -name 'zedbot-db-*.dump.enc' -o -name 'zedbot-db-*.sql.gz' \) \
    2>/dev/null | sort -r)"
  if [ -z "$files" ]; then
    log_info "No database backups found in ${dir}."
    exit 0
  fi
  log_info "Database backups in ${dir} (newest first):"
  printf '  %-44s %10s  %-19s %-9s %s\n' "NAME" "SIZE" "DATE" "TYPE" "VERIFIED"
  local f name size mdate type verified
  while IFS= read -r f; do
    name="${f##*/}"
    size="$(du -h "$f" 2>/dev/null | cut -f1)"
    mdate="$(date -d "@$(stat -c %Y "$f" 2>/dev/null || echo 0)" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo unknown)"
    case "$name" in
      *.dump.enc) type="dump.enc" ;;
      *.dump)     type="dump" ;;
      *.sql.gz)   type="sql.gz" ;;
      *)          type="other" ;;
    esac
    verified="$(manifest_verified_flag "${f}.manifest.json")"
    printf '  %-44s %10s  %-19s %-9s %s\n' "$name" "$size" "$mdate" "$type" "$verified"
  done <<< "$files"
}

# Resolves a user-supplied backup reference (absolute path, file name inside
# the backup dir, or a timestamp short id) to one existing file.
resolve_backup_file() {
  local ref="$1" dir="$ZEDBOT_BACKUP_DIR"
  if [ -f "$ref" ]; then
    printf '%s' "$ref"
    return 0
  fi
  if [ -f "${dir}/${ref}" ]; then
    printf '%s' "${dir}/${ref}"
    return 0
  fi
  local matches count
  matches="$(find "$dir" -maxdepth 1 -type f \
    \( -name "zedbot-db-*${ref}*.dump" -o -name "zedbot-db-*${ref}*.dump.enc" -o -name "zedbot-db-*${ref}*.sql.gz" \) \
    2>/dev/null | sort -r)"
  count="$(printf '%s' "$matches" | grep -c . || true)"
  if [ "$count" -eq 1 ]; then
    printf '%s' "$matches"
    return 0
  fi
  if [ "$count" -gt 1 ]; then
    log_error "Backup reference '${ref}' is ambiguous - matching files:"
    printf '%s\n' "$matches" >&2
    return 1
  fi
  log_error "No backup found for '${ref}' in ${dir}. See: zedbot backup list"
  return 1
}

backup_verify() {
  local ref="${1:-}"
  if [ -z "$ref" ]; then
    log_error "Usage: zedbot backup verify <file-or-timestamp>"
    exit 1
  fi
  local file
  file="$(resolve_backup_file "$ref")" || exit 1
  local name="${file##*/}"
  log_info "Verifying ${name} ..."

  # Integrity against the manifest first, when one exists.
  local manifest="${file}.manifest.json"
  if [ -f "$manifest" ]; then
    local expected actual
    expected="$(grep -Eo '"sha256"[[:space:]]*:[[:space:]]*"[a-f0-9]{64}"' "$manifest" | grep -Eo '[a-f0-9]{64}' || true)"
    if [ -n "$expected" ]; then
      actual="$(sha256sum "$file" | awk '{print $1}')"
      if [ "$expected" = "$actual" ]; then
        log_success "sha256 matches the manifest."
      else
        log_error "sha256 MISMATCH against the manifest - the file is corrupt or was modified."
        exit 1
      fi
    fi
  else
    log_warn "No manifest found for ${name} (legacy or externally created file)."
  fi

  case "$name" in
    *.dump)
      if ! compose_service_running postgres; then
        log_error "The postgres container is not running - start it first: zedbot start"
        exit 1
      fi
      # Bare stdin, never the /dev/stdin path: under docker exec that path
      # resolves to a non-reopenable socket and the archive reads as empty.
      if run_compose exec -T postgres pg_restore --list < "$file" > /dev/null; then
        log_success "pg_restore can read the archive - backup is valid."
      else
        log_error "pg_restore could NOT read the archive - backup is corrupt."
        exit 1
      fi
      ;;
    *.dump.enc)
      if run_compose run --rm --no-deps worker sh -c \
        'test -f apps/worker/dist/cli/verify-backup.js' >/dev/null 2>&1; then
        if run_compose run --rm --no-deps worker node apps/worker/dist/cli/verify-backup.js \
          "/var/lib/zedbot/backups/${name}"; then
          log_success "Worker verification passed - backup is valid."
        else
          log_error "Worker verification FAILED - wrong password or corrupt file."
          exit 1
        fi
      elif [ "$(head -c 4 "$file" 2>/dev/null)" = "ZBK1" ]; then
        log_warn "Worker verify CLI not available - only the ZBK1 envelope header was checked."
        log_warn "Rebuild the images (zedbot update) for full encrypted-backup verification."
      else
        log_error "The file does not start with the ZBK1 envelope header - it is not a valid encrypted backup."
        exit 1
      fi
      ;;
    *.sql.gz)
      if gzip -t "$file"; then
        log_success "gzip integrity check passed - legacy backup is readable."
      else
        log_error "gzip integrity check FAILED - the legacy backup is corrupt."
        exit 1
      fi
      ;;
    *)
      log_error "Unsupported backup type: ${name}"
      exit 1
      ;;
  esac
}

# Read-only report of repository/image/container version alignment and the
# database migration status. Degrades gracefully when containers are down
# ("unavailable" instead of an error) and NEVER prints env values. A report,
# not a gate: exits 0 whether or not everything matches.
deploy_status() {
  local mismatch=0

  # Repository HEAD.
  local head_sha=""
  head_sha="$(repo_head_sha)"
  if [ -n "$head_sha" ]; then
    log_info "Repository HEAD  : ${head_sha:0:10} (${head_sha})"
  else
    log_warn "Repository HEAD  : unavailable"
  fi

  # Installed CLI freshness.
  if cli_is_stale; then
    log_error "Installed CLI    : STALE (${ZEDBOT_CLI_PATH} differs from the repository copy)"
    mismatch=1
  else
    log_success "Installed CLI    : fresh (matches the repository copy)"
  fi

  # Per-container identity (bot + worker share the app image).
  local svc image_id created container_sha bot_sha="" worker_sha=""
  for svc in bot worker; do
    image_id="$(docker inspect -f '{{.Image}}' "zedbot-${svc}" 2>/dev/null | cut -c1-19 || true)"
    created="$(docker inspect -f '{{.Created}}' "zedbot-${svc}" 2>/dev/null || true)"
    container_sha="$(run_compose exec -T "$svc" sh -c 'printf "%s" "${GIT_SHA:-}"' 2>/dev/null | tr -d '[:space:]' || true)"
    log_info "${svc}:"
    log_info "  image ID       : ${image_id:-unavailable}"
    log_info "  created        : ${created:-unavailable}"
    log_info "  GIT_SHA        : ${container_sha:-unavailable}"
    case "$svc" in
      bot)    bot_sha="$container_sha" ;;
      worker) worker_sha="$container_sha" ;;
    esac
  done

  # Migration status via the worker CLI (one-line JSON on stdout).
  local migration_json="" pending_count="" up_to_date=""
  migration_json="$(run_compose run --rm --no-deps worker node apps/worker/dist/cli/migration-status.js 2>/dev/null | tail -n 1 || true)"
  pending_count="$(printf '%s' "$migration_json" | grep -o '"pendingCount":[0-9]*' | head -n 1 | grep -o '[0-9]*$' || true)"
  up_to_date="$(printf '%s' "$migration_json" | grep -o '"upToDate":\(true\|false\)' | head -n 1 | cut -d: -f2 || true)"
  if [ -n "$pending_count" ]; then
    log_info "Migrations       : pending=${pending_count} upToDate=${up_to_date:-unknown}"
  else
    log_warn "Migrations       : unavailable"
  fi

  # Verdict.
  if [ -z "$head_sha" ] || [ "$bot_sha" != "$head_sha" ]; then
    log_error "bot container does not run the repository HEAD."
    mismatch=1
  fi
  if [ -z "$head_sha" ] || [ "$worker_sha" != "$head_sha" ]; then
    log_error "worker container does not run the repository HEAD."
    mismatch=1
  fi
  if [ "$pending_count" != "0" ]; then
    log_error "Database migrations are pending or their status is unavailable."
    mismatch=1
  fi

  if [ "$mismatch" -eq 0 ]; then
    log_success "Repository, images and containers MATCH."
  else
    log_error "Deployment is NOT aligned. Run: zedbot update"
  fi
  exit 0
}

repair_backups() {
  local dir="$ZEDBOT_BACKUP_DIR"
  log_info "Repairing backup directory permissions (${dir}) ..."
  ensure_backup_dir_permissions "$dir"
  log_success "Owner $(stat -c '%u:%g' "$dir"), mode $(stat -c '%a' "$dir")."

  if compose_service_running worker; then
    if run_compose exec -T worker sh -c 'touch "${BACKUP_DIR:-/var/lib/zedbot/backups}/.zedbot-write-test" && rm -f "${BACKUP_DIR:-/var/lib/zedbot/backups}/.zedbot-write-test"' >/dev/null 2>&1; then
      log_success "worker: read-write access to the backup mount confirmed."
    else
      log_error "worker: could NOT write to the backup mount - check the volume and ownership (zedbot doctor)."
    fi
  else
    log_warn "worker container is not running - write test skipped (zedbot start)."
  fi

  if compose_service_running bot; then
    if run_compose exec -T bot sh -c 'ls "${BACKUP_DIR:-/var/lib/zedbot/backups}" >/dev/null' >/dev/null 2>&1; then
      log_success "bot: read access to the backup mount confirmed."
    else
      log_error "bot: could NOT read the backup mount - check the volume (zedbot doctor)."
    fi
    if run_compose exec -T bot sh -c 'touch "${BACKUP_DIR:-/var/lib/zedbot/backups}/.zedbot-write-test"' >/dev/null 2>&1; then
      run_compose exec -T bot sh -c 'rm -f "${BACKUP_DIR:-/var/lib/zedbot/backups}/.zedbot-write-test"' >/dev/null 2>&1 || true
      log_warn "bot: the backup mount is WRITABLE but should be read-only - recreate the services: zedbot restart"
    else
      log_success "bot: backup mount is read-only as intended."
    fi
  else
    log_warn "bot container is not running - read test skipped (zedbot start)."
  fi
}

case "$CMD" in
  status | ps)
    require_root
    app_cd
    detect_compose_command
    run_compose ps
    ;;
  logs)
    require_root
    app_cd
    detect_compose_command
    run_compose logs --tail=200 -f "$@"
    ;;
  restart)
    require_root
    app_cd
    detect_compose_command
    # `compose restart` never re-reads .env; recreating the containers does.
    run_compose up -d --force-recreate --remove-orphans
    log_success "All services restarted."
    ;;
  start)
    require_root
    app_cd
    detect_compose_command
    run_compose up -d
    log_success "All services started."
    ;;
  stop)
    require_root
    app_cd
    detect_compose_command
    run_compose stop
    log_success "All services stopped."
    ;;
  update)
    exec bash "${SCRIPTS_DIR}/update.sh" "$@"
    ;;
  deploy-status)
    require_root
    app_cd
    detect_compose_command
    load_env_if_exists
    deploy_status
    ;;
  backup)
    SUB="${1:-create}"
    shift || true
    case "$SUB" in
      create)
        exec bash "${SCRIPTS_DIR}/backup-db.sh" "$@"
        ;;
      list)
        require_root
        load_env_if_exists
        backup_list
        ;;
      verify)
        require_root
        app_cd
        detect_compose_command
        load_env_if_exists
        backup_verify "${1:-}"
        ;;
      *)
        log_error "Unknown backup subcommand: ${SUB} (use: create, list, verify)"
        exit 1
        ;;
    esac
    ;;
  repair)
    SUB="${1:-}"
    case "$SUB" in
      backups)
        require_root
        app_cd
        detect_compose_command
        load_env_if_exists
        repair_backups
        ;;
      *)
        log_error "Unknown repair target: '${SUB}' (use: repair backups)"
        exit 1
        ;;
    esac
    ;;
  health)
    require_root
    app_cd
    detect_compose_command
    load_env_if_exists
    health_summary
    ;;
  doctor)
    exec bash "${SCRIPTS_DIR}/doctor.sh" "$@"
    ;;
  shell)
    require_root
    app_cd
    detect_compose_command
    SERVICE="${1:-bot}"
    run_compose exec "$SERVICE" bash 2>/dev/null || run_compose exec "$SERVICE" sh
    ;;
  env-check)
    exec bash "${SCRIPTS_DIR}/validate-env.sh" "$@"
    ;;
  nginx)
    exec bash "${SCRIPTS_DIR}/nginx-setup.sh" "$@"
    ;;
  ssl)
    exec bash "${SCRIPTS_DIR}/ssl-setup.sh" "$@"
    ;;
  renew-cert)
    exec bash "${SCRIPTS_DIR}/ssl-renew.sh" "$@"
    ;;
  firewall)
    exec bash "${SCRIPTS_DIR}/firewall-setup.sh" "$@"
    ;;
  security | security-check)
    exec bash "${SCRIPTS_DIR}/security-check.sh" "$@"
    ;;
  https-status)
    require_root
    load_env_if_exists
    if has_command nginx; then
      if has_command systemctl; then
        systemctl is-active nginx >/dev/null 2>&1 \
          && log_success "Nginx: active." \
          || log_error "Nginx: not active."
      fi
      nginx -t 2>&1 | tail -n 1 || true
    else
      log_warn "Nginx is not installed. Run: zedbot nginx"
    fi
    if has_command certbot; then
      certbot certificates 2>/dev/null || log_warn "No certificates found."
    else
      log_warn "certbot is not installed. Run: zedbot ssl"
    fi
    HTTPS_DOMAIN="$(printf '%s' "${APP_DOMAIN:-}" | tr '[:upper:]' '[:lower:]')"
    if is_valid_domain "$HTTPS_DOMAIN"; then
      log_info "Probing https://${HTTPS_DOMAIN}/health ..."
      curl -sSI --max-time 10 "https://${HTTPS_DOMAIN}/health" 2>&1 | head -n 1 \
        || log_warn "HTTPS probe failed (certificate missing or DNS not pointing here yet)."
    else
      log_warn "APP_DOMAIN is not set - skipping the HTTPS probe."
    fi
    ;;
  *)
    echo "[FAIL] Unknown command: ${CMD}" >&2
    echo
    usage
    exit 1
    ;;
esac
