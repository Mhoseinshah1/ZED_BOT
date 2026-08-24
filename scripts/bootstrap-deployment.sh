#!/usr/bin/env bash
# Canonical first-install application bootstrap. Dependencies must already have
# been started by the installer; this script never recreates them.
set -Eeuo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

SOURCE_SNAPSHOT=""; SOURCE_SHA=""; SOURCE_TREE=""
bootstrap_cleanup() { cleanup_source_snapshot "$SOURCE_SNAPSHOT" "$SOURCE_SHA" "$SOURCE_TREE"; }

main() {
  local target tree snapshot_result generation operation evidence compose_sha candidate tmp image_id
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
  # An ordinary transient failure during a previous first-install attempt
  # (dependency readiness, the image build, migrations, or application
  # readiness) leaves bootstrap.json and its generation-owned artifacts
  # behind. That generation can never be completed by a rerun (a fresh
  # timestamp-based generation is minted below), so clear it before
  # classifying - see reset_abandoned_first_install_bootstrap's own comment
  # for why this is safe.
  reset_abandoned_first_install_bootstrap || return 1
  [ "$(classify_installation first-install)" = genuine-first-install ] || { log_error "First-install bootstrap requires an empty canonical state identity."; return 1; }

  snapshot_result="$(prepare_exact_origin_main)" || return 1
  read -r target tree SOURCE_SNAPSHOT <<< "$snapshot_result"
  SOURCE_SHA="$target"; SOURCE_TREE="$tree"
  verify_source_snapshot "$SOURCE_SNAPSHOT" "$target" "$tree" || return 1
  register_source_snapshot "$SOURCE_SNAPSHOT" "$target" "$tree" || return 1
  set_update_compose_contract "$SOURCE_SNAPSHOT" "$target" "$tree" || return 1
  validate_compose_application_images || return 1
  validate_migration_declaration_pair "$SOURCE_SNAPSHOT" || return 1

  generation="$(date -u +%Y%m%dT%H%M%SZ)-${target:0:12}"
  operation="$(< /proc/sys/kernel/random/uuid)"
  begin_installation_bootstrap first-install "$generation" "$target" "$tree" "$operation" || return 1
  initialize_operation_state install "$generation" || return 1

  validate_dependencies_healthy || return 1
  advance_operation_state bootstrap-initialized dependency-ready || return 1
  require_source_integrity "$target" "$tree" "$SOURCE_SNAPSHOT" || return 1
  build_verified_source_snapshot "$target" "$tree" "$SOURCE_SNAPSHOT" || return 1
  image_id="$(run_clean_docker image inspect -f '{{.Id}}' zedbot-app:latest)"
  valid_image_id "$image_id" || return 1
  # The candidate metadata below records immutableImageTag as
  # "zedbot-app:generation-<generation>" - the first update's rollback later
  # depends on that exact tag resolving to this image (see
  # validate_retained_generation_image), just as update.sh retains its own
  # target generation. Create it now so that dependency actually holds.
  retain_known_good_image "$image_id" "zedbot-app:generation-${generation}" || return 1

  evidence="$ZEDBOT_DEPLOYMENT_DIR/evidence-${generation}"
  persist_migration_declaration_evidence "$SOURCE_SNAPSHOT" "$evidence" || return 1
  compose_sha="$(sha256sum "$evidence/docker-compose.yml" | awk '{print $1}')"
  candidate="$ZEDBOT_DEPLOYMENT_DIR/candidate-${generation}.json"
  tmp="$(operation_mktemp "$ZEDBOT_DEPLOYMENT_DIR/.first-candidate.XXXXXXXX")" || return 1
  /usr/bin/jq -n --arg generation "$generation" --arg tree "$tree" --arg target "$target" --arg image "$image_id" \
    --arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg evidence "$evidence" --arg composeSha "$compose_sha" \
    --arg manifestSha "$MIGRATION_MANIFEST_SHA256" --argjson declarations "$MIGRATION_DECLARATIONS_JSON" \
    '{formatVersion:2,installationKind:"first-install",lifecycleRole:"candidate",generation:$generation,sourceTree:$tree,
      preDeploySha:null,preDeployImageId:null,targetDeploySha:$target,targetImageId:$image,retainedImageTag:null,
      immutableImageTag:("zedbot-app:generation-"+$generation),failedTargetTag:("zedbot-app:failed-"+$generation),capturedAt:$capturedAt,
      preDeployMigrations:[],declarationFormatVersion:2,declarationSourceCategory:"generation-evidence",migrationEvidencePath:$evidence,
      composeEvidencePath:($evidence+"/docker-compose.yml"),composeEvidenceSha256:$composeSha,composeProjectName:"zedbot",
      composeApplicationImage:"zedbot-app:latest",compatibilityManifestSha256:$manifestSha,compatibilityDeclarations:$declarations,
      recreationAttempted:false,healthConfirmed:false,state:"prepared"}' > "$tmp" || return 1
  atomic_write_metadata "$tmp" "$candidate" || return 1
  rm -f "$tmp"
  validate_generation_metadata_core "$candidate" candidate || return 1
  validate_generation_owned_evidence "$candidate" || return 1
  advance_installation_bootstrap initialized canonical-published || return 1
  advance_operation_state dependency-ready candidate-image-built || return 1

  require_source_integrity "$target" "$tree" "$SOURCE_SNAPSHOT" || return 1
  run_compose run --rm --no-deps api node packages/database/dist/referral-migration-preflight.js || return 1
  run_compose run --rm --no-deps api sh -c 'cd packages/database && node_modules/.bin/prisma migrate deploy' || return 1
  # Idempotent baseline data (OWNER admins from ADMIN_TELEGRAM_IDS, default
  # settings, log topics, message templates, button texts) - the legacy
  # installer path this replaces always ran this via migrate.sh. Without it
  # a fresh install finishes with no configured admin records even when
  # ADMIN_TELEGRAM_IDS is supplied, leaving every admin bot flow unusable.
  run_compose run --rm --no-deps api node packages/database/dist/seed.js || return 1
  advance_operation_state candidate-image-built migrations-confirmed || return 1

  recreate_application_services || return 1
  verify_application_recreation_set "$image_id" || return 1
  record_bot_recreation_boundary "$image_id" "$target" || return 1
  rewrite_generation_state "$candidate" application-recreated || return 1
  advance_operation_state migrations-confirmed application-recreated || return 1
  if [ -n "${TELEGRAM_BOT_TOKEN:-}" ]; then
    validate_running_application "$target" >/dev/null || return 1
  else
    # The installer explicitly allows leaving TELEGRAM_BOT_TOKEN empty
    # ("can be added later"). apps/bot/src/index.ts never calls run()
    # without a token, so it never publishes the real-bot readiness marker
    # this gate would otherwise wait for - only generic application
    # readiness (containers running, healthy, on the right image) is
    # required here. The operator adds the token and runs `zedbot restart`
    # to activate the bot afterward.
    log_warn "TELEGRAM_BOT_TOKEN is not configured; completing installation with the bot pending configuration."
    validate_running_application "$target" 0 >/dev/null || return 1
  fi
  rewrite_generation_state "$candidate" healthy-candidate || return 1
  advance_operation_state application-recreated health-confirmed || return 1
  advance_installation_bootstrap canonical-published health-confirmed || return 1
  advance_operation_state health-confirmed promotion-prepared || return 1
  publish_first_install_current "$candidate" || return 1
  advance_operation_state promotion-prepared promoted || return 1
  finalize_promoted_operation_state
  record_deployed_sha "$target"
  log_success "Canonical first installation completed. Rollback is unavailable until a later update creates previous.json."
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  install_operation_traps bootstrap_cleanup
  main "$@"
fi
