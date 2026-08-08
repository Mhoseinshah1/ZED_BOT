#!/usr/bin/env bash
# Application-only rollback. Never migrates/restores data and never addresses
# postgres or redis as Compose services.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

metadata_field() { jq -er "$1" "$ZEDBOT_ROLLBACK_METADATA"; }

validate_metadata() {
  [ -f "$ZEDBOT_ROLLBACK_METADATA" ] || { log_error "Rollback metadata is unavailable."; return 1; }
  [ "$(stat -c %u "$ZEDBOT_ROLLBACK_METADATA")" = "0" ] || { log_error "Rollback metadata is not root-owned."; return 1; }
  [ "$(stat -c %a "$ZEDBOT_ROLLBACK_METADATA")" = "600" ] || { log_error "Rollback metadata mode must be 600."; return 1; }
  jq -e '
    .formatVersion == 1 and
    (.preDeploySha|type=="string" and test("^[a-f0-9]{40}$")) and
    (.targetDeploySha|type=="string" and test("^[a-f0-9]{40}$")) and
    (.preDeployImageId|type=="string" and test("^sha256:[a-f0-9]{64}$")) and
    (.retainedImageTag == ("zedbot-app:rollback-" + .preDeploySha)) and
    (.compatibilityManifestSha256|type=="string" and test("^[a-f0-9]{64}$")) and
    (.compatibilityDeclarations|type=="array" and all(test("^[0-9]{14}_[a-z0-9_]+$"))) and
    (.preDeployMigrations|type=="array" and length>0 and all(test("^[0-9]{14}_[a-z0-9_]+$"))) and
    (.state|IN("prepared","application-recreated","available","available-after-failed-deploy","rolled-back"))
  ' "$ZEDBOT_ROLLBACK_METADATA" >/dev/null || { log_error "Rollback metadata is malformed or incomplete."; return 1; }
}

validate_retained_image() {
  local expected_id expected_sha tag actual_id image_sha
  expected_id="$(metadata_field '.preDeployImageId')"
  expected_sha="$(metadata_field '.preDeploySha')"
  tag="$(metadata_field '.retainedImageTag')"
  actual_id="$(docker image inspect -f '{{.Id}}' "$tag" 2>/dev/null)" || { log_error "Retained rollback image is missing."; return 1; }
  [ "$actual_id" = "$expected_id" ] || { log_error "Retained image tag does not match recorded image ID."; return 1; }
  image_sha="$(docker image inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$expected_id" | sed -n 's/^GIT_SHA=//p' | tail -n 1)"
  [ "$image_sha" = "$expected_sha" ] || { log_error "Retained image GIT_SHA does not match metadata."; return 1; }
}

validate_compatibility() {
  local expected checksum baseline result
  expected="$(metadata_field '.compatibilityManifestSha256')"
  checksum="$(sha256sum packages/database/prisma/rollback-compatibility.json | awk '{print $1}')"
  [ "$checksum" = "$expected" ] || { log_error "Compatibility declaration differs from the recorded deployment declaration."; return 1; }
  baseline="$(jq -r '.preDeployMigrations|join(",")' "$ZEDBOT_ROLLBACK_METADATA")"
  result="$(run_compose run --rm --no-deps worker node apps/worker/dist/cli/rollback-compatibility.js rollback "$baseline")" || {
    log_error "Rollback migration compatibility check failed: $(printf '%s' "$result" | jq -r '.blocker // "unavailable"' 2>/dev/null || echo unavailable)"
    return 1
  }
  [ "$(printf '%s' "$result" | jq -r '.manifestSha256')" = "$expected" ] || return 1
}

show_status() {
  validate_metadata || return 1
  local pre target state tag
  pre="$(metadata_field '.preDeploySha')"; target="$(metadata_field '.targetDeploySha')"
  state="$(metadata_field '.state')"; tag="$(metadata_field '.retainedImageTag')"
  log_info "Rollback state       : ${state}"
  log_info "Previous application : ${pre}"
  log_info "Target deployment    : ${target}"
  log_info "Retained image tag   : ${tag}"
  validate_retained_image
  log_success "Rollback metadata and retained image are internally consistent."
}

perform_rollback() {
  local assume_yes="$1" pre target target_id state state_tmp service cid image_id image_sha target_running_id=""
  acquire_deployment_lock
  validate_metadata
  validate_retained_image
  validate_compatibility
  pre="$(metadata_field '.preDeploySha')"; target="$(metadata_field '.targetDeploySha')"
  state="$(metadata_field '.state')"
  [ "$state" != "prepared" ] || { log_error "Deployment never recreated the application; rollback is unnecessary and refused."; return 1; }
  [ "$state" != "rolled-back" ] || { log_error "This rollback was already completed; refusing to run it again."; return 1; }
  # A failed Compose recreation may leave a mix of old and target application
  # containers. Both identities must be known; no third image is accepted.
  for service in api bot worker; do
    cid="$(run_compose ps -q "$service" 2>/dev/null | head -n 1)"
    [ -n "$cid" ] || { log_error "${service} container identity is unavailable."; return 1; }
    image_id="$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null)"
    image_sha="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$cid" | sed -n 's/^GIT_SHA=//p' | tail -n 1)"
    case "$image_sha" in
      "$target")
        [ -z "$target_running_id" ] && target_running_id="$image_id"
        [ "$image_id" = "$target_running_id" ] || { log_error "Target containers use inconsistent images."; return 1; }
        ;;
      "$pre")
        [ "$image_id" = "$(metadata_field '.preDeployImageId')" ] || { log_error "Previous-version container image is inconsistent with metadata."; return 1; }
        ;;
      *) log_error "${service} carries an unknown application SHA."; return 1 ;;
    esac
  done
  log_warn "Rollback interrupts API, Bot and Worker. PostgreSQL and Redis will not be recreated or restarted."
  if [ "$assume_yes" -ne 1 ] && ! confirm "Restore application version ${pre:0:10}?" n; then
    log_warn "Rollback cancelled; nothing was changed."
    return 1
  fi

  # Preserve the current target identity before moving the mutable Compose tag.
  target_id="$(docker image inspect -f '{{.Id}}' zedbot-app:latest 2>/dev/null)" || { log_error "Current application image is unavailable."; return 1; }
  [ -z "$target_running_id" ] || [ "$target_id" = "$target_running_id" ] || { log_error "Mutable application tag does not match the running target image."; return 1; }
  docker image tag "$target_id" "zedbot-app:failed-${target}"
  docker image tag "$(metadata_field '.preDeployImageId')" zedbot-app:latest
  run_compose up -d --no-deps --no-build --force-recreate api bot worker

  if ! validate_running_application "$pre" >/dev/null; then
    log_error "Post-rollback application health validation failed. Both image identities and diagnostics were preserved."
    return 1
  fi
  record_deployed_sha "$pre"
  state_tmp="$(mktemp "${ZEDBOT_DEPLOYMENT_DIR}/state.XXXXXX")"
  jq '.state="rolled-back"' "$ZEDBOT_ROLLBACK_METADATA" > "$state_tmp"
  atomic_write_metadata "$state_tmp"
  rm -f "$state_tmp"
  bash "${SCRIPT_DIR}/doctor.sh" || true
  log_success "Application rollback completed. PostgreSQL and Redis were untouched."
}

main() {
  require_root
  app_cd
  load_env_if_exists
  detect_compose_command
  case "${1:-rollback}" in
    status) show_status ;;
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

main "$@"
