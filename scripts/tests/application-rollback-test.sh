#!/usr/bin/env bash
# Isolated application-only recreation proof. Creates no ports or volumes and
# cleans only resources carrying its randomized Compose project label.
set -Eeuo pipefail

has() { command -v "$1" >/dev/null 2>&1; }
has docker && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 || {
  echo "SKIP: isolated Docker preflight unavailable"
  exit 77
}

WORK="$(mktemp -d)"
PROJECT="zrbtest$(date +%s)${RANDOM}$$"
LABEL="com.zedbot.disposable-rollback=${PROJECT}"
IMAGE_V1="${PROJECT}-app:v1"
IMAGE_V2="${PROJECT}-app:v2"

case "$WORK" in /tmp/*|/var/tmp/*) : ;; *) echo "unsafe temp path" >&2; exit 1 ;; esac
if docker ps -a --filter "label=com.docker.compose.project=${PROJECT}" --format '{{.ID}}' | grep -q .; then
  echo "generated project name already exists" >&2
  exit 1
fi
if docker image inspect "$IMAGE_V1" >/dev/null 2>&1 || docker image inspect "$IMAGE_V2" >/dev/null 2>&1; then
  echo "generated image name already exists" >&2
  exit 1
fi

cleanup() {
  APP_IMAGE="$IMAGE_V2" docker compose --project-name "$PROJECT" --project-directory "$WORK" -f "$WORK/compose.yml" down --remove-orphans >/dev/null 2>&1 || true
  docker image rm "$IMAGE_V1" "$IMAGE_V2" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

cat > "$WORK/Dockerfile" <<'EOF'
FROM busybox:1.36
ARG VERSION
ENV TEST_APP_VERSION=$VERSION
HEALTHCHECK --interval=1s --timeout=1s --retries=10 CMD test -n "$TEST_APP_VERSION"
CMD ["sh", "-c", "while :; do sleep 60; done"]
EOF
cat > "$WORK/compose.yml" <<EOF
services:
  api: { image: "\${APP_IMAGE}", labels: ["${LABEL}"] }
  bot: { image: "\${APP_IMAGE}", labels: ["${LABEL}"] }
  worker: { image: "\${APP_IMAGE}", labels: ["${LABEL}"] }
  database-fixture: { image: "${IMAGE_V2}", labels: ["${LABEL}"] }
  cache-fixture: { image: "${IMAGE_V2}", labels: ["${LABEL}"] }
EOF

docker build --label "$LABEL" --build-arg VERSION=v1 -t "$IMAGE_V1" "$WORK" >/dev/null
docker build --label "$LABEL" --build-arg VERSION=v2 -t "$IMAGE_V2" "$WORK" >/dev/null
APP_IMAGE="$IMAGE_V2" docker compose --project-name "$PROJECT" --project-directory "$WORK" -f "$WORK/compose.yml" up -d --wait >/dev/null

db_before="$(APP_IMAGE="$IMAGE_V2" docker compose --project-name "$PROJECT" --project-directory "$WORK" -f "$WORK/compose.yml" ps -q database-fixture)"
cache_before="$(APP_IMAGE="$IMAGE_V2" docker compose --project-name "$PROJECT" --project-directory "$WORK" -f "$WORK/compose.yml" ps -q cache-fixture)"

APP_IMAGE="$IMAGE_V1" docker compose --project-name "$PROJECT" --project-directory "$WORK" -f "$WORK/compose.yml" \
  up -d --no-deps --no-build --force-recreate api bot worker >/dev/null

test "$db_before" = "$(APP_IMAGE="$IMAGE_V2" docker compose --project-name "$PROJECT" --project-directory "$WORK" -f "$WORK/compose.yml" ps -q database-fixture)"
test "$cache_before" = "$(APP_IMAGE="$IMAGE_V2" docker compose --project-name "$PROJECT" --project-directory "$WORK" -f "$WORK/compose.yml" ps -q cache-fixture)"
for service in api bot worker; do
  cid="$(APP_IMAGE="$IMAGE_V1" docker compose --project-name "$PROJECT" --project-directory "$WORK" -f "$WORK/compose.yml" ps -q "$service")"
  test "$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$cid" | sed -n 's/^TEST_APP_VERSION=//p')" = v1
done

echo "PASS: disposable application-only rollback left dependency fixtures untouched"
