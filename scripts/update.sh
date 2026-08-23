#!/usr/bin/env bash
# =============================================================================
# ZED_BOT updater (self-healing):
#   safety archive -> database backup + verification gate -> validate running app
#   -> fail-closed fetch + exact local-main verification (no checkout mutation)
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

DEPLOYMENT_METADATA_ACTIVE=0
APPLICATION_RECREATION_ATTEMPTED=0
SOURCE_SNAPSHOT=""
SOURCE_SHA=""
SOURCE_TREE=""
CANDIDATE_METADATA=""

set_rollback_state() {
  local state="$1"
  [ "$DEPLOYMENT_METADATA_ACTIVE" -eq 1 ] || return 0
  rewrite_generation_state "$CANDIDATE_METADATA" "$state"
}

on_update_error() {
  local rc=$?
  trap - ERR
  if [ "$APPLICATION_RECREATION_ATTEMPTED" -eq 1 ]; then
    set_rollback_state "failed-after-recreation" || true
    publish_failed_generation "$CANDIDATE_METADATA" "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" || true
  fi
  log_error "ZED_BOT update FAILED. Your data and .env were NOT deleted."
  log_error "Recovery steps:"
  log_error "  1. Inspect what went wrong:   zedbot logs        (or: zedbot doctor)"
  log_error "  2. Retry the update:          zedbot update"
  log_error "  3. If the app is broken, restore the pre-update backup MANUALLY:"
  log_error "       zedbot restore-help      (prints the manual restore steps)"
  exit "$rc"
}
trap on_update_error ERR

update_owned_cleanup() {
  cleanup_source_snapshot "$SOURCE_SNAPSHOT" "$SOURCE_SHA" "$SOURCE_TREE"
}

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
      # archive's table of contents. Bare stdin, never the /dev/stdin path:
      # under docker exec that path resolves to a non-reopenable socket and
      # the archive reads as empty ("did not find magic string").
      run_compose exec -T postgres pg_restore --list < "$file" > /dev/null
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

  if ! run_operation_child bash "${SCRIPT_DIR}/backup-db.sh"; then
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
  return 1
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
  acquire_deployment_lock
  local installation_class
  installation_class="$(classify_installation observe)" || {
    log_error "Installation identity is ambiguous or unsupported; preserve the evidence and follow docs/legacy-upgrade.md."
    exit 1
  }
  [ "$installation_class" = existing-canonical ] || {
    log_error "Update requires an existing canonical installation; found ${installation_class}."
    exit 1
  }
  recover_metadata_transition
  validate_generation_metadata_core "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" current || {
    log_error "Current generation metadata is absent, legacy, or incomplete; bootstrap/reconciliation is required."
    exit 1
  }
  validate_generation_owned_evidence "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" || exit 1
  assert_no_unresolved_failed_generation
  validate_compose_application_images
  validate_dependencies_healthy

  log_info "Starting ZED_BOT update ..."

  log_info "[1/14] Creating a safety archive (.env + database) before updating ..."
  run_operation_child bash "${SCRIPT_DIR}/backup.sh"

  log_info "[2/14] Creating and verifying a database backup (update gate) ..."
  pre_update_database_backup

  log_info "[3/14] Capturing the healthy running application rollback candidate ..."
  local identity pre_deploy_sha pre_deploy_image_id baseline_csv migration_json
  identity="$(validate_running_application)" || {
    log_error "The current application is not healthy and cannot be retained as known-good."
    exit 1
  }
  read -r pre_deploy_sha pre_deploy_image_id <<< "$identity"
  migration_json="$(run_compose run --rm --no-deps worker node apps/worker/dist/cli/migration-status.js | tail -n 1)"
  if [ "$(printf '%s' "$migration_json" | jq -r '.ok == true and .upToDate == true and .failedCount == 0')" != "true" ]; then
    log_error "Current migration state is not healthy; refusing to retain this application as known-good."
    exit 1
  fi
  baseline_csv="$(run_compose exec -T worker sh -c 'find packages/database/prisma/migrations -mindepth 2 -maxdepth 2 -name migration.sql -printf "%h\n" | sed "s#.*/##" | sort | paste -sd, -')"
  [ -n "$baseline_csv" ] || { log_error "No complete baseline migrations found."; exit 1; }

  log_info "[4/14] Fetching canonical origin/main and verifying unchanged local main ..."
  local target_deploy_sha target_tree snapshot_result
  snapshot_result="$(prepare_exact_origin_main)" || {
    log_error "Fetching and verifying the unchanged local main against canonical origin/main failed. The updater does not fast-forward the checkout."
    exit 1
  }
  read -r target_deploy_sha target_tree SOURCE_SNAPSHOT <<< "$snapshot_result"
  verify_source_snapshot "$SOURCE_SNAPSHOT" "$target_deploy_sha" "$target_tree" || { log_error "Immutable source snapshot verification failed."; exit 1; }
  register_source_snapshot "$SOURCE_SNAPSHOT" "$target_deploy_sha" "$target_tree" || { log_error "Could not register ownership of the source snapshot."; exit 1; }
  SOURCE_SHA="$target_deploy_sha"
  SOURCE_TREE="$target_tree"
  set_update_compose_contract "$SOURCE_SNAPSHOT" "$target_deploy_sha" "$target_tree" || { log_error "Immutable source Compose contract is invalid."; exit 1; }
  validate_compose_application_images || { log_error "Immutable source Compose application images are invalid."; exit 1; }

  log_info "[5/14] Migrating the .env to the current layout (append-only) ..."
  require_source_integrity "$target_deploy_sha" "$target_tree" "$SOURCE_SNAPSHOT" || { log_error "Source identity changed before post-fetch mutation."; exit 1; }
  migrate_legacy_env
  # Re-load so freshly appended keys (ZEDBOT_BACKUP_DIR & co) take effect.
  load_env_if_exists
  reset_deployment_state_fixed_identity
  reset_compose_fixed_identity
  set_update_compose_contract "$SOURCE_SNAPSHOT" "$target_deploy_sha" "$target_tree" || { log_error "Compose identity changed while reloading runtime environment."; exit 1; }
  validate_compose_application_images || { log_error "Compose identity changed while reloading runtime environment."; exit 1; }
  ensure_backup_dir_permissions

  log_info "[6/14] Refreshing the installed zedbot CLI ..."
  # Failure to refresh the CLI must fail the update: a stale installed CLI
  # driving new code is exactly the class of bug this updater prevents.
  if ! install -m 0755 "$SOURCE_SNAPSHOT/scripts/zedbot.sh" "$ZEDBOT_CLI_PATH"; then
    log_error "Could not refresh ${ZEDBOT_CLI_PATH} from the updated repository - ABORTING the update."
    log_error "Fix the problem (disk full? read-only /usr/local/bin?) and retry: zedbot update"
    exit 1
  fi

  log_info "[7/14] Retaining the verified previous application image and metadata ..."
  local rollback_tag compatibility_sha compatibility_declarations metadata_tmp generation failed_tag target_image_id migration_evidence_dir compose_evidence_sha
  generation="$(date -u +%Y%m%dT%H%M%SZ)-${target_deploy_sha:0:12}"
  CANDIDATE_METADATA="$ZEDBOT_DEPLOYMENT_DIR/candidate-${generation}.json"
  initialize_operation_state update "$generation"
  rollback_tag="zedbot-app:rollback-${generation}"
  validate_migration_declaration_pair "$SOURCE_SNAPSHOT" || { log_error "Immutable source migration declaration validation failed."; exit 1; }
  compatibility_sha="$MIGRATION_MANIFEST_SHA256"
  compatibility_declarations="$MIGRATION_DECLARATIONS_JSON"
  migration_evidence_dir="$ZEDBOT_DEPLOYMENT_DIR/evidence-${generation}"
  persist_migration_declaration_evidence "$SOURCE_SNAPSHOT" "$migration_evidence_dir" || {
    log_error "Could not persist exact generation migration evidence."; exit 1;
  }
  compose_evidence_sha="$(sha256sum "$migration_evidence_dir/docker-compose.yml" | awk '{print $1}')"
  require_source_integrity "$target_deploy_sha" "$target_tree" "$SOURCE_SNAPSHOT" || { log_error "Source identity changed before image retention."; exit 1; }
  validate_compose_application_images || { log_error "Compose identity changed before image retention."; exit 1; }
  retain_known_good_image "$pre_deploy_image_id" "$rollback_tag"
  advance_operation_state current-validated current-image-retained
  metadata_tmp="$(operation_mktemp "${ZEDBOT_DEPLOYMENT_DIR}/metadata.XXXXXX")"
  jq -n \
    --arg preDeploySha "$pre_deploy_sha" --arg preDeployImageId "$pre_deploy_image_id" \
    --arg targetDeploySha "$target_deploy_sha" --arg retainedImageTag "$rollback_tag" \
    --arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg baseline "$baseline_csv" \
    --arg compatibilityManifestSha256 "$compatibility_sha" \
    --argjson compatibilityDeclarations "$compatibility_declarations" \
    --arg generation "$generation" --arg targetTree "$target_tree" --arg migrationEvidencePath "$migration_evidence_dir" \
    --arg composeEvidenceSha256 "$compose_evidence_sha" \
    '{formatVersion:2,lifecycleRole:"candidate",generation:$generation,sourceTree:$targetTree,preDeploySha:$preDeploySha,preDeployImageId:$preDeployImageId,targetDeploySha:$targetDeploySha,retainedImageTag:$retainedImageTag,capturedAt:$capturedAt,preDeployMigrations:($baseline|split(",")),declarationFormatVersion:2,declarationSourceCategory:"generation-evidence",migrationEvidencePath:$migrationEvidencePath,composeEvidencePath:($migrationEvidencePath+"/docker-compose.yml"),composeEvidenceSha256:$composeEvidenceSha256,composeProjectName:"zedbot",composeApplicationImage:"zedbot-app:latest",compatibilityManifestSha256:$compatibilityManifestSha256,compatibilityDeclarations:$compatibilityDeclarations,recreationAttempted:false,healthConfirmed:false,state:"prepared"}' > "$metadata_tmp"
  atomic_write_metadata "$metadata_tmp" "$CANDIDATE_METADATA"
  rm -f "$metadata_tmp"
  validate_generation_metadata_core "$CANDIDATE_METADATA" candidate
  advance_operation_state current-image-retained candidate-metadata-prepared
  DEPLOYMENT_METADATA_ACTIVE=1

  log_info "[8/14] Revalidating source and building updated images ..."
  # GIT_SHA travels into the image as its LAST layers (see Dockerfile), so
  # identity-only rebuilds stay cheap.
  verify_source_snapshot "$SOURCE_SNAPSHOT" "$target_deploy_sha" "$target_tree" || { log_error "Source snapshot changed before build."; exit 1; }
  validate_compose_application_images || { log_error "Compose identity changed before build."; exit 1; }
  GIT_SHA="$target_deploy_sha"
  export GIT_SHA
  # Docker consumes the already verified snapshot directory itself. No archive
  # is regenerated from the mutable deployment checkout after verification.
  build_verified_source_snapshot "$target_deploy_sha" "$target_tree" "$SOURCE_SNAPSHOT" || { log_error "Source verification or image build failed."; exit 1; }
  target_image_id="$(run_clean_docker image inspect -f '{{.Id}}' zedbot-app:latest)"; valid_image_id "$target_image_id" || exit 1
  advance_operation_state candidate-metadata-prepared candidate-image-built
  failed_tag="zedbot-app:failed-${generation}"
  retain_known_good_image "$target_image_id" "zedbot-app:generation-${generation}"
  metadata_tmp="$(operation_mktemp "${ZEDBOT_DEPLOYMENT_DIR}/.candidate-image.XXXXXXXX")"
  jq --arg targetImageId "$target_image_id" --arg failedTargetTag "$failed_tag" --arg immutableImageTag "zedbot-app:generation-${generation}" '.targetImageId=$targetImageId|.failedTargetTag=$failedTargetTag|.immutableImageTag=$immutableImageTag' "$CANDIDATE_METADATA" > "$metadata_tmp"
  atomic_write_metadata "$metadata_tmp" "$CANDIDATE_METADATA"
  rm -f "$metadata_tmp"
  validate_generation_metadata_core "$CANDIDATE_METADATA" candidate
  advance_operation_state candidate-image-built deployment-reference-tagged

  log_info "[9/14] Validating rollback compatibility of pending migrations ..."
  local compatibility_json
  require_source_integrity "$target_deploy_sha" "$target_tree" "$SOURCE_SNAPSHOT" || { log_error "Source identity changed before compatibility validation."; exit 1; }
  validate_compose_application_images || { log_error "Compose identity changed before compatibility validation."; exit 1; }
  compatibility_json="$(run_compose run --rm --no-deps worker node apps/worker/dist/cli/rollback-compatibility.js update "$baseline_csv")" || {
    log_error "Migration compatibility check failed: $(printf '%s' "$compatibility_json" | jq -r '.blocker // "unavailable"' 2>/dev/null || echo unavailable)"
    exit 1
  }
  [ "$(printf '%s' "$compatibility_json" | jq -r '.manifestSha256')" = "$compatibility_sha" ] \
    || { log_error "Compatibility manifest checksum changed during deployment."; exit 1; }
  advance_operation_state deployment-reference-tagged compatibility-confirmed

  log_info "[10/14] Applying database migrations (before the new app containers run) ..."
  # `compose run` inside migrate.sh starts postgres/redis itself. The app
  # services still run the OLD code at this point - the safe direction (old
  # code on a newer schema beats new code on an older schema). migrate.sh's
  # legacy self-heal no-ops here: steps 4-5 already converged env + CLI.
  require_source_integrity "$target_deploy_sha" "$target_tree" "$SOURCE_SNAPSHOT" || { log_error "Source identity changed before migration."; exit 1; }
  validate_compose_application_images || { log_error "Compose identity changed before migration."; exit 1; }
  run_compose run --rm --no-deps api node packages/database/dist/referral-migration-preflight.js
  run_compose run --rm --no-deps api sh -c 'cd packages/database && node_modules/.bin/prisma migrate deploy'
  advance_operation_state compatibility-confirmed migrations-confirmed

  log_info "[11/14] Revalidating source and recreating services ..."
  # --force-recreate is THE fix for the stale-container symptom observed in
  # production: a plain `up -d` can leave the previous containers (previous
  # image, previous mounts, previous env) running after a rebuild.
  require_source_integrity "$target_deploy_sha" "$target_tree" "$SOURCE_SNAPSHOT" || { log_error "Source or deployment checkout identity changed before service recreation."; exit 1; }
  validate_dependencies_healthy
  validate_compose_application_images
  APPLICATION_RECREATION_ATTEMPTED=1
  recreate_application_services
  verify_application_recreation_set "$target_image_id"
  record_bot_recreation_boundary "$target_image_id" "$target_deploy_sha"
  set_rollback_state "application-recreated"
  advance_operation_state migrations-confirmed application-recreated

  log_info "[12/14] Recording the deployed version ..."
  record_deployed_sha

  log_info "[13/14] Running the post-deploy smoke test ..."
  post_deploy_smoke

  log_info "[14/14] Running health checks ..."
  if run_operation_child bash "${SCRIPT_DIR}/doctor.sh"; then
    validate_running_application "$target_deploy_sha" >/dev/null
    set_rollback_state "healthy-candidate"
    advance_operation_state application-recreated health-confirmed
    begin_metadata_transition update "$CANDIDATE_METADATA"
    advance_operation_state health-confirmed promotion-prepared
    recover_metadata_transition
    advance_operation_state promotion-prepared promoted
    log_success "ZED_BOT update completed successfully."
  else
    log_error "Update health checks failed; deployment was not marked successful."
    return 1
  fi
}

install_operation_traps update_owned_cleanup
main "$@"
