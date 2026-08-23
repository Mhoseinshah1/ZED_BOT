#!/usr/bin/env bash
# =============================================================================
# ZED_BOT database-only backup (CLI path of the shared ops convention).
#
# Primary format (matches packages/shared/src/ops.ts and the worker):
#   $ZEDBOT_BACKUP_DIR/zedbot-db-YYYYMMDD-HHMMSS.dump[.enc]
#   + sidecar zedbot-db-YYYYMMDD-HHMMSS.dump[.enc].manifest.json
#
# Pipeline: pg_dump --format=custom (inside the postgres container, over the
# local socket - no password on any command line) -> .partial file ->
# verification via `pg_restore --list` -> optional at-rest encryption through
# the worker's encrypt CLI (the "ZBK1" AES-256-GCM envelope from
# packages/shared/src/backup-crypto.ts - never reimplemented in shell) ->
# sha256 -> atomic rename -> manifest. A failed step removes the partial
# file; a half-written backup can never be mistaken for a valid one.
#
# Legacy mode: ZEDBOT_BACKUP_FORMAT=legacy produces the old plain-SQL
# zedbot-db-${ts}.sql.gz (pg_dump --clean --if-exists | gzip, verified with
# gzip -t). Existing legacy .sql.gz files are never modified or deleted.
#
# Retention (new-format files only): BACKUP_RETENTION_DAYS prunes old
# zedbot-db-*.dump[.enc] files, but never below BACKUP_MIN_RETAINED newest
# and never the most recent backup. Manifests are deleted with their file.
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

# In-container mount target of $ZEDBOT_BACKUP_DIR (ops contract:
# DEFAULT_CONTAINER_BACKUP_DIR in packages/shared/src/ops.ts).
CONTAINER_BACKUP_DIR="/var/lib/zedbot/backups"

PARTIAL_FILES=()

cleanup() {
  # Never leave a half-written dump behind - it would look like a valid backup.
  local f
  for f in ${PARTIAL_FILES[@]+"${PARTIAL_FILES[@]}"}; do
    if [ -f "$f" ]; then
      rm -f "$f"
    fi
  done
  return 0
}
trap cleanup EXIT

# --- Helpers -----------------------------------------------------------------

json_escape() {
  # Backups never legitimately produce quotes/backslashes in these fields;
  # strip them (plus CR/LF) instead of shipping a JSON encoder in shell.
  printf '%s' "$1" | tr -d '"\\\r\n'
}

# True when the worker image ships the given CLI entrypoint (built by the
# worker package). --no-deps: postgres/redis state is irrelevant here.
worker_cli_available() {
  local cli="$1"
  run_compose run --rm --no-deps worker sh -c "test -f '${cli}'" >/dev/null 2>&1
}

file_sha256() {
  sha256sum "$1" | awk '{print $1}'
}

check_free_disk() {
  local dir="$1" min_mb="${BACKUP_MIN_FREE_DISK_MB:-500}" avail_mb
  if ! printf '%s' "$min_mb" | grep -Eq '^[0-9]+$'; then
    min_mb=500
  fi
  avail_mb="$(df -Pm "$dir" 2>/dev/null | awk 'NR==2 {print $4}')"
  if [ -n "$avail_mb" ] && [ "$avail_mb" -lt "$min_mb" ]; then
    log_error "Not enough free disk space for a backup: ${avail_mb} MB available, ${min_mb} MB required (BACKUP_MIN_FREE_DISK_MB)."
    return 1
  fi
  return 0
}

write_manifest() {
  # write_manifest <final-file> <verified true|false> <encrypted true|false> <stamp>
  local file="$1" verified="$2" encrypted="$3" stamp="$4"
  local manifest="${file}.manifest.json" size sha git_sha pgdump_version
  size="$(stat -c %s "$file" 2>/dev/null || echo 0)"
  sha="$(file_sha256 "$file")"
  git_sha="$(git -C "$ZEDBOT_APP_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
  pgdump_version="$(run_compose exec -T postgres pg_dump --version 2>/dev/null | head -n 1 || echo unknown)"
  # NO secrets: names, sizes, hashes and versions only.
  cat > "$manifest" <<EOF
{
  "format": "v1",
  "operation_id": "cli-${stamp}",
  "filename": "$(json_escape "${file##*/}")",
  "created_at": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')",
  "git_sha": "$(json_escape "$git_sha")",
  "pg_dump_version": "$(json_escape "$pgdump_version")",
  "size_bytes": ${size},
  "sha256": "${sha}",
  "encrypted": ${encrypted},
  "verified": ${verified}
}
EOF
  chown "${ZEDBOT_RUNTIME_UID:-1000}:${ZEDBOT_RUNTIME_GID:-1000}" "$manifest" 2>/dev/null || true
  chmod 640 "$manifest"
}

apply_retention() {
  local backup_dir="$1"
  local retention="${BACKUP_RETENTION_DAYS:-}" min_retained="${BACKUP_MIN_RETAINED:-3}"
  if ! printf '%s' "$retention" | grep -Eq '^[0-9]+$' || [ "$retention" -le 0 ]; then
    return 0
  fi
  if ! printf '%s' "$min_retained" | grep -Eq '^[0-9]+$'; then
    min_retained=3
  fi
  # Never drop below one kept backup even if BACKUP_MIN_RETAINED=0.
  if [ "$min_retained" -lt 1 ]; then
    min_retained=1
  fi

  local now cutoff deleted=0 index=0 f mtime
  now="$(date +%s)"
  cutoff=$((now - retention * 86400))

  # New-format files only; the timestamp in the name sorts chronologically,
  # so `sort -r` yields newest first. The newest backup is never deleted
  # (index 0), nor are the BACKUP_MIN_RETAINED newest.
  while IFS= read -r f; do
    index=$((index + 1))
    if [ "$index" -le "$min_retained" ]; then
      continue
    fi
    mtime="$(stat -c %Y "$f" 2>/dev/null || echo "$now")"
    if [ "$mtime" -lt "$cutoff" ]; then
      rm -f "$f" "${f}.manifest.json"
      deleted=$((deleted + 1))
    fi
  done < <(find "$backup_dir" -maxdepth 1 -type f \
    \( -name 'zedbot-db-*.dump' -o -name 'zedbot-db-*.dump.enc' \) 2>/dev/null | sort -r)

  if [ "$deleted" -gt 0 ]; then
    log_info "Retention removed ${deleted} backup(s) older than ${retention} day(s) (kept at least ${min_retained})."
  fi

  # Legacy plain-SQL backups are only reported, never touched.
  local legacy_count
  legacy_count="$(find "$backup_dir" -maxdepth 1 -type f -name 'zedbot-db-*.sql.gz' 2>/dev/null | wc -l)"
  if [ "$legacy_count" -gt 0 ]; then
    log_info "${legacy_count} legacy .sql.gz backup(s) present (kept untouched)."
  fi
}

# --- Legacy format (plain SQL, gzip) ------------------------------------------

create_legacy_backup() {
  local backup_dir="$1" pg_user="$2" pg_db="$3"
  local ts file
  ts="$(date +%Y%m%d-%H%M%S)"
  file="${backup_dir}/zedbot-db-${ts}.sql.gz"
  # Never overwrite an existing backup (same-second re-run).
  while [ -e "$file" ]; do
    sleep 1
    ts="$(date +%Y%m%d-%H%M%S)"
    file="${backup_dir}/zedbot-db-${ts}.sql.gz"
  done

  log_info "Creating legacy database backup ${file##*/} ..."
  PARTIAL_FILES+=("${file}.partial")
  run_compose exec -T postgres pg_dump --clean --if-exists -U "$pg_user" -d "$pg_db" \
    | gzip > "${file}.partial"
  if [ ! -s "${file}.partial" ]; then
    log_error "The database dump is empty - removing the partial file."
    exit 1
  fi
  if ! gzip -t "${file}.partial"; then
    log_error "gzip verification failed - removing the partial file."
    exit 1
  fi
  chown "${ZEDBOT_RUNTIME_UID:-1000}:${ZEDBOT_RUNTIME_GID:-1000}" "${file}.partial" 2>/dev/null || true
  chmod 640 "${file}.partial"
  mv "${file}.partial" "$file"
  PARTIAL_FILES=()
  log_success "Legacy backup created: ${file} ($(du -h "$file" | cut -f1))"
}

# --- Primary format (pg_dump custom, verified, optionally encrypted) ----------

create_dump_backup() {
  local backup_dir="$1" pg_user="$2" pg_db="$3"
  local ts base plain_final enc_final partial
  ts="$(date +%Y%m%d-%H%M%S)"
  base="zedbot-db-${ts}"
  # Never overwrite an existing backup (same-second re-run).
  while [ -e "${backup_dir}/${base}.dump" ] || [ -e "${backup_dir}/${base}.dump.enc" ]; do
    sleep 1
    ts="$(date +%Y%m%d-%H%M%S)"
    base="zedbot-db-${ts}"
  done
  plain_final="${backup_dir}/${base}.dump"
  enc_final="${backup_dir}/${base}.dump.enc"
  partial="${plain_final}.partial"

  log_info "Creating database backup ${base}.dump (pg_dump custom format) ..."
  PARTIAL_FILES+=("$partial")
  run_compose exec -T postgres pg_dump --format=custom -U "$pg_user" -d "$pg_db" > "$partial"

  if [ ! -s "$partial" ]; then
    log_error "The database dump is empty - removing the partial file."
    exit 1
  fi

  # Verification: pg_restore must be able to read the archive's table of
  # contents. Runs in the postgres container (same major version), the file
  # travels over stdin so nothing is copied into the container. pg_restore
  # reads bare stdin when no file argument is given - passing /dev/stdin as
  # a PATH breaks under docker exec (the fd is a socket that cannot be
  # re-opened by path; the archive reads as empty: "did not find magic
  # string").
  log_info "Verifying the dump (pg_restore --list) ..."
  local restore_output="" restore_rc=0
  restore_output="$(run_compose exec -T postgres pg_restore --list < "$partial" 2>&1 >/dev/null)" || restore_rc=$?
  if [ "$restore_rc" -ne 0 ]; then
    log_error "Backup verification FAILED (pg_restore cannot read the archive, exit ${restore_rc}) - removing the partial file."
    [ -z "$restore_output" ] || printf '%s\n' "$restore_output" >&2
    exit 1
  fi
  local verified="true"
  log_success "Dump verified."

  chown "${ZEDBOT_RUNTIME_UID:-1000}:${ZEDBOT_RUNTIME_GID:-1000}" "$partial" 2>/dev/null || true
  chmod 640 "$partial"

  local final_file encrypted="false"
  if [ -n "${BACKUP_ENCRYPTION_PASSWORD:-}" ]; then
    # Encryption must produce the exact "ZBK1" AES-256-GCM envelope the app
    # reads (packages/shared/src/backup-crypto.ts). Shell must not duplicate
    # that crypto, so the worker image's encrypt CLI does it; the partial
    # file is visible in the container through the shared bind mount.
    if worker_cli_available "apps/worker/dist/cli/encrypt-backup.js"; then
      log_info "Encrypting the backup (AES-256-GCM, ZBK1 envelope, via the worker CLI) ..."
      PARTIAL_FILES+=("${enc_final}.partial")
      if run_compose run --rm --no-deps worker node apps/worker/dist/cli/encrypt-backup.js \
        "${CONTAINER_BACKUP_DIR}/${base}.dump.partial" \
        "${CONTAINER_BACKUP_DIR}/${base}.dump.enc.partial"; then
        if [ ! -s "${enc_final}.partial" ]; then
          log_error "Encryption produced an empty file - aborting."
          exit 1
        fi
        rm -f "$partial"
        chown "${ZEDBOT_RUNTIME_UID:-1000}:${ZEDBOT_RUNTIME_GID:-1000}" "${enc_final}.partial" 2>/dev/null || true
        chmod 640 "${enc_final}.partial"
        mv "${enc_final}.partial" "$enc_final"
        final_file="$enc_final"
        encrypted="true"
      else
        log_error "Backup encryption FAILED - no backup was written."
        exit 1
      fi
    else
      log_warn "BACKUP_ENCRYPTION_PASSWORD is set but the worker encrypt CLI is not available yet"
      log_warn "(apps/worker/dist/cli/encrypt-backup.js missing - rebuild the images: zedbot update)."
      log_warn "Storing this backup UNENCRYPTED."
      mv "$partial" "$plain_final"
      final_file="$plain_final"
    fi
  else
    mv "$partial" "$plain_final"
    final_file="$plain_final"
  fi
  PARTIAL_FILES=()

  write_manifest "$final_file" "$verified" "$encrypted" "$ts"
  log_success "Backup created: ${final_file} ($(du -h "$final_file" | cut -f1))"
  log_info "Manifest written: ${final_file##*/}.manifest.json"
}

main() {
  require_root
  app_cd
  load_env_if_exists
  detect_compose_command

  # Host directory; the containers see it as ${CONTAINER_BACKUP_DIR}.
  local backup_dir="$ZEDBOT_BACKUP_DIR"
  ensure_backup_dir_permissions "$backup_dir"
  check_free_disk "$backup_dir"

  if ! compose_service_running postgres; then
    log_error "The postgres container is not running - start it first: zedbot start"
    exit 1
  fi

  local pg_user pg_db
  pg_user="${POSTGRES_USER:-zedbot}"
  pg_db="${POSTGRES_DB:-zedbot}"

  if [ "${ZEDBOT_BACKUP_FORMAT:-dump}" = "legacy" ]; then
    create_legacy_backup "$backup_dir" "$pg_user" "$pg_db"
  else
    create_dump_backup "$backup_dir" "$pg_user" "$pg_db"
  fi

  apply_retention "$backup_dir"
}

main "$@"
