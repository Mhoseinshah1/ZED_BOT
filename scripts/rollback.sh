#!/usr/bin/env bash
# Application-only rollback. Never migrates/restores data and never addresses
# postgres or redis as Compose services.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

metadata_field() { jq -er "$1" "$ZEDBOT_ROLLBACK_METADATA"; }

validate_metadata() {
  secure_deployment_dir || return 1
  validate_generation_metadata_core "$ZEDBOT_ROLLBACK_METADATA" previous || return 1
  jq -e --arg deploymentDir "$ZEDBOT_DEPLOYMENT_DIR" '
    .formatVersion == 2 and
    (.lifecycleRole == "previous") and
    (.generation|type=="string" and test("^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{12}$")) and
    (.sourceTree|type=="string" and test("^[a-f0-9]{40}$")) and
    (.preDeploySha|type=="string" and test("^[a-f0-9]{40}$")) and
    (.targetDeploySha|type=="string" and test("^[a-f0-9]{40}$")) and
    (.preDeployImageId|type=="string" and test("^sha256:[a-f0-9]{64}$")) and
    (.retainedImageTag == ("zedbot-app:rollback-" + .generation)) and
    (.targetImageId|type=="string" and test("^sha256:[a-f0-9]{64}$")) and
    (.failedTargetTag == ("zedbot-app:failed-" + .generation)) and
    (.declarationFormatVersion == 2) and
    (.declarationSourceCategory == "generation-evidence") and
    (.migrationEvidencePath == ($deploymentDir + "/evidence-" + .generation)) and
    (.composeEvidencePath == (.migrationEvidencePath + "/docker-compose.yml")) and
    (.composeEvidenceSha256|type=="string" and test("^[a-f0-9]{64}$")) and
    (.composeProjectName == "zedbot") and
    (.composeApplicationImage == "zedbot-app:latest") and
    (.compatibilityManifestSha256|type=="string" and test("^[a-f0-9]{64}$")) and
    (.compatibilityDeclarations|type=="array" and
      all(.compatibilityDeclarations[];
        type=="object" and keys==["name","sqlSha256"] and
        (.name|type=="string" and test("^[0-9]{14}_[a-z0-9_]+$")) and
        (.sqlSha256|type=="string" and test("^[a-f0-9]{64}$"))) and
      ((.compatibilityDeclarations|map(.name)|length) ==
       (.compatibilityDeclarations|map(.name)|unique|length))) and
    (.preDeployMigrations|type=="array" and length>0 and all(test("^[0-9]{14}_[a-z0-9_]+$"))) and
    (.recreationAttempted == true) and .healthConfirmed == true and
    (.state == "known-good") and
    (.immutableImageTag|type=="string" and startswith("zedbot-app:generation-"))
  ' "$ZEDBOT_ROLLBACK_METADATA" >/dev/null || { log_error "Rollback metadata is malformed or incomplete."; return 1; }
}

configure_rollback_compose_contract() {
  set_rollback_compose_contract "$(metadata_field '.migrationEvidencePath')" "$(metadata_field '.composeEvidenceSha256')" || return 1
  validate_compose_application_images
}

validate_retained_image() {
  local expected_id expected_sha image_sha
  # validate_retained_generation_image() above already re-derives the
  # immutable tag from metadata and cross-checks it against the retained
  # image ID; this function only adds the GIT_SHA baked-identity check.
  validate_retained_generation_image "$ZEDBOT_ROLLBACK_METADATA" || return 1
  expected_id="$(metadata_field '.targetImageId')"
  expected_sha="$(metadata_field '.targetDeploySha')"
  image_sha="$(run_clean_docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$expected_id" | sed -n 's/^GIT_SHA=//p' | tail -n 1)"
  [ "$image_sha" = "$expected_sha" ] || { log_error "Retained image GIT_SHA does not match metadata."; return 1; }
}

validate_compatibility() {
  local expected baseline result evidence recorded
  expected="$(metadata_field '.compatibilityManifestSha256')"
  evidence="$(metadata_field '.migrationEvidencePath')"
  validate_migration_declaration_pair "$evidence" || { log_error "Recorded generation migration evidence is unavailable or invalid."; return 1; }
  [ "$MIGRATION_MANIFEST_SHA256" = "$expected" ] || { log_error "Recorded manifest-byte checksum differs from generation evidence."; return 1; }
  recorded="$(jq -cS '.compatibilityDeclarations|sort_by(.name)' "$ZEDBOT_ROLLBACK_METADATA")" || return 1
  [ "$MIGRATION_DECLARATIONS_JSON" = "$recorded" ] || { log_error "Recorded declaration set differs from generation evidence."; return 1; }
  baseline="$(jq -r '.preDeployMigrations|join(",")' "$ZEDBOT_ROLLBACK_METADATA")"
  result="$(run_compose run --rm --no-deps worker node apps/worker/dist/cli/rollback-compatibility.js rollback "$baseline")" || {
    log_error "Rollback migration compatibility check failed: $(printf '%s' "$result" | jq -r '.blocker // "unavailable"' 2>/dev/null || echo unavailable)"
    return 1
  }
  [ "$(printf '%s' "$result" | jq -r '.manifestSha256')" = "$expected" ] || return 1
}

show_status() {
  local mode="${1:---json}" result rc status reason eligible current previous
  if result="$(inspect_rollback_status)"; then rc=0; else rc=$?; fi
  case "$mode" in
    --json) printf '%s\n' "$result" ;;
    --human)
      status="$(printf '%s' "$result" | /usr/bin/jq -r .rollbackStatus)"
      reason="$(printf '%s' "$result" | /usr/bin/jq -r .reason)"
      eligible="$(printf '%s' "$result" | /usr/bin/jq -r .eligible)"
      current="$(printf '%s' "$result" | /usr/bin/jq -r '.currentGeneration // "not-validated"')"
      previous="$(printf '%s' "$result" | /usr/bin/jq -r '.previousGeneration // "not-validated"')"
      printf 'Rollback status: %s\nEligible: %s\nCurrent generation: %s\nPrevious generation: %s\nReason: %s\n' "$status" "$eligible" "$current" "$previous" "$reason"
      ;;
    *) rollback_status_emit indeterminate null INVALID_ARGUMENT "Use --json or --human." indeterminate false false false false false false false false; return 4;;
  esac
  return "$rc"
}

perform_rollback() {
  local assume_yes="$1" pre target state service cid image_id image_sha target_running_id="" installation_class
  acquire_deployment_lock
  installation_class="$(classify_installation observe)" || { log_error "Rollback requires unambiguous canonical installation metadata."; return 1; }
  [ "$installation_class" = existing-canonical ] || { log_error "Rollback is unavailable for installation class ${installation_class}."; return 1; }
  ZEDBOT_ROLLBACK_METADATA="$(select_rollback_generation)"
  validate_rollback_eligibility_evidence "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA" "$ZEDBOT_ROLLBACK_METADATA" || { log_error "Rollback eligibility evidence is invalid or inconsistent."; return 1; }
  initialize_operation_state rollback "$(metadata_field '.generation')"
  validate_metadata
  validate_generation_owned_evidence "$ZEDBOT_ROLLBACK_METADATA"
  confirm_operation_state previous-selected rollback-evidence-validated
  configure_rollback_compose_contract
  validate_retained_image
  confirm_operation_state rollback-evidence-validated retained-image-validated
  retag_validated_previous_reference "$ZEDBOT_ROLLBACK_METADATA"
  metadata_transition_hook rollback-retagged
  confirm_operation_state retained-image-validated deployment-reference-retagged
  validate_compatibility
  confirm_operation_state deployment-reference-retagged compatibility-confirmed
  validate_compose_application_images
  validate_dependencies_healthy
  pre="$(metadata_field '.targetDeploySha')"
  target="$(/usr/bin/jq -r '.targetDeploySha' "$ZEDBOT_CURRENT_DEPLOYMENT_METADATA")"
  state="$(metadata_field '.state')"
  [ "$state" != "rolled-back" ] || { log_error "This rollback was already completed; refusing to run it again."; return 1; }
  # A failed Compose recreation may leave a mix of old and target application
  # containers. Both identities must be known; no third image is accepted.
  for service in api bot worker; do
    cid="$(run_compose ps -q "$service" 2>/dev/null | head -n 1)"
    [ -n "$cid" ] || { log_error "${service} container identity is unavailable."; return 1; }
    image_id="$(run_clean_docker inspect -f '{{.Image}}' "$cid" 2>/dev/null)"
    image_sha="$(run_clean_docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$cid" | sed -n 's/^GIT_SHA=//p' | tail -n 1)"
    case "$image_sha" in
      "$target")
        [ -z "$target_running_id" ] && target_running_id="$image_id"
        [ "$image_id" = "$target_running_id" ] || { log_error "Target containers use inconsistent images."; return 1; }
        ;;
      "$pre")
        [ "$image_id" = "$(metadata_field '.targetImageId')" ] || { log_error "Previous-version container image is inconsistent with metadata."; return 1; }
        ;;
      *) log_error "${service} carries an unknown application SHA."; return 1 ;;
    esac
  done
  log_warn "Rollback interrupts API, Bot and Worker. PostgreSQL and Redis will not be recreated or restarted."
  if [ "$assume_yes" -ne 1 ] && ! confirm "Restore application version ${pre:0:10}?" n; then
    log_warn "Rollback cancelled; nothing was changed."
    return 1
  fi

  # Only previous.json supplies rollback material. failed.json is diagnostic.
  if ! execute_validated_rollback_transition "$ZEDBOT_ROLLBACK_METADATA"; then
    log_error "Post-rollback application health validation failed. Both image identities and diagnostics were preserved."
    return 1
  fi
  record_deployed_sha "$pre"
  run_operation_child bash "${SCRIPT_DIR}/doctor.sh" || true
  log_success "Application rollback completed. PostgreSQL and Redis were untouched."
}

main() {
  require_root
  reset_deployment_state_fixed_identity
  if [ "${1:-}" = status ]; then
    show_status "${2:---json}"
    return
  fi
  app_cd
  load_env_if_exists
  reset_deployment_state_fixed_identity
  reset_compose_fixed_identity
  # shellcheck disable=SC2034  # re-pinned after load_env_if_exists could have
  # sourced a hostile .env; read by run_compose() etc. in the sourced common.sh.
  ZEDBOT_CANONICAL_COMPOSE_FILE="$ZEDBOT_CANONICAL_PROJECT_DIR/docker-compose.yml"
  detect_compose_command
  case "${1:-rollback}" in
    rollback)
      case "${2:-}" in
        "") perform_rollback 0 ;;
        --yes) perform_rollback 1 ;;
        *) log_error "Usage: zedbot rollback [--yes]"; exit 1 ;;
      esac
      ;;
    *) log_error "Unknown rollback operation."; exit 1 ;;
  esac
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  [ "${1:-}" = status ] || install_operation_traps
  main "$@"
fi
