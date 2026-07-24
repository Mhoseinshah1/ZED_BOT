#!/usr/bin/env bash
# =============================================================================
# ZED_BOT .env validation (used by `zedbot env-check`).
#
# Usage: validate-env.sh [env-file]     (default: /opt/zedbot/app/.env)
#
# SAFE OUTPUT ONLY: prints key names and OK / MISSING / INVALID - it NEVER
# prints a value or a secret. The file is parsed line by line, never sourced,
# so nothing in it can execute. Exits non-zero when anything is missing or
# invalid. Dependency-free on purpose (runs before install completes too).
# =============================================================================

set -uo pipefail

ENV_FILE="${1:-${ZEDBOT_ENV_FILE:-/opt/zedbot/app/.env}}"

if [ ! -f "$ENV_FILE" ]; then
  echo "[FAIL] env file not found: ${ENV_FILE}" >&2
  exit 1
fi

FAILURES=0

ok()      { printf '  [ OK    ] %s\n' "$1"; }
warn()    { printf '  [ WARN  ] %s\n' "$1"; }
missing() { printf '  [MISSING] %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
invalid() { printf '  [INVALID] %s - %s\n' "$1" "$2"; FAILURES=$((FAILURES + 1)); }

# Last assignment wins; surrounding single/double quotes are stripped.
# Parsed with grep - the file is never sourced/executed.
env_get() {
  local key="$1" line value
  line="$(grep -E "^[[:space:]]*${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1)"
  if [ -z "$line" ]; then
    return 1
  fi
  value="${line#*=}"
  value="${value%$'\r'}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  printf '%s' "$value"
}

has_value() {
  local value
  value="$(env_get "$1")" || return 1
  [ -n "$value" ]
}

# Strip leading/trailing shell whitespace (space, tab, CR, newline) WITHOUT eval,
# without printing/logging it, and without exposing its length or touching
# interior characters. Behaviourally identical to scripts/lib/common.sh's
# trim_env_token_value; kept inline here because validate-env.sh is deliberately
# dependency-free (it runs before install clones the repo). Mirrors the runtime
# resolver's value.trim() so a whitespace-only token reads as unset.
trim_env_token_value() {
  local v="$1"
  v="${v#"${v%%[![:space:]]*}"}" # strip leading whitespace
  v="${v%"${v##*[![:space:]]}"}" # strip trailing whitespace
  printf '%s' "$v"
}

echo "ZED_BOT env check: ${ENV_FILE}"

# --- Telegram bot token ------------------------------------------------------
# Matches the runtime resolver (packages/shared/src/telegram-token.ts) EXACTLY so
# env-check can never say OK when the bot and worker would resolve different
# tokens: TELEGRAM_BOT_TOKEN is canonical, BOT_TOKEN is a legacy fallback, an
# equal pair is a duplicate-key warning, and a differing pair is a hard conflict.
# Each key is read ONCE and edge-trimmed (like the resolver's value.trim()), so a
# whitespace-only value (e.g. "   ") reads as unset - never resolved, never a
# false conflict. Only key names + a compare-equal result are ever used; NO value
# is printed. (The generic has_value is NOT used here: it does not trim, so it
# would treat a whitespace-only token as configured.)
TELEGRAM_TOKEN_TRIMMED="$(trim_env_token_value "$(env_get TELEGRAM_BOT_TOKEN)")"
BOT_TOKEN_TRIMMED="$(trim_env_token_value "$(env_get BOT_TOKEN)")"
if [ -n "$TELEGRAM_TOKEN_TRIMMED" ] && [ -n "$BOT_TOKEN_TRIMMED" ]; then
  if [ "$TELEGRAM_TOKEN_TRIMMED" = "$BOT_TOKEN_TRIMMED" ]; then
    ok "TELEGRAM_BOT_TOKEN"
    warn "BOT_TOKEN is also set to the same value (duplicate key; TELEGRAM_BOT_TOKEN is used)"
  else
    invalid "TELEGRAM_BOT_TOKEN" "TELEGRAM_BOT_TOKEN and BOT_TOKEN conflict"
  fi
elif [ -n "$TELEGRAM_TOKEN_TRIMMED" ]; then
  ok "TELEGRAM_BOT_TOKEN"
elif [ -n "$BOT_TOKEN_TRIMMED" ]; then
  ok "BOT_TOKEN"
  warn "using the legacy BOT_TOKEN name; rename it to TELEGRAM_BOT_TOKEN when convenient"
else
  missing "TELEGRAM_BOT_TOKEN (or BOT_TOKEN)"
fi

# --- Admin telegram ids (numeric, comma-separated) ---------------------------
ADMIN_IDS_KEY=""
ADMIN_IDS_VALUE=""
if has_value ADMIN_TELEGRAM_IDS; then
  ADMIN_IDS_KEY="ADMIN_TELEGRAM_IDS"
  ADMIN_IDS_VALUE="$(env_get ADMIN_TELEGRAM_IDS)"
elif has_value OWNER_TELEGRAM_ID; then
  ADMIN_IDS_KEY="OWNER_TELEGRAM_ID"
  ADMIN_IDS_VALUE="$(env_get OWNER_TELEGRAM_ID)"
fi
if [ -z "$ADMIN_IDS_KEY" ]; then
  missing "ADMIN_TELEGRAM_IDS (or OWNER_TELEGRAM_ID)"
else
  # Allow spaces around the commas.
  if printf '%s' "$ADMIN_IDS_VALUE" | grep -Eq '^[[:space:]]*[0-9]+([[:space:]]*,[[:space:]]*[0-9]+)*[[:space:]]*$'; then
    ok "$ADMIN_IDS_KEY"
  else
    invalid "$ADMIN_IDS_KEY" "must be a numeric id or comma-separated numeric ids"
  fi
fi

# --- APP_SECRET (>= 32 chars) --------------------------------------------------
if ! has_value APP_SECRET; then
  missing "APP_SECRET"
else
  APP_SECRET_VALUE="$(env_get APP_SECRET)"
  if [ "${#APP_SECRET_VALUE}" -ge 32 ]; then
    ok "APP_SECRET"
  else
    invalid "APP_SECRET" "must be at least 32 characters long"
  fi
fi

# --- DATABASE_URL --------------------------------------------------------------
if has_value DATABASE_URL; then
  ok "DATABASE_URL"
else
  missing "DATABASE_URL"
fi

# --- Redis ----------------------------------------------------------------------
if has_value REDIS_URL; then
  ok "REDIS_URL"
elif has_value REDIS_HOST; then
  ok "REDIS_HOST"
else
  missing "REDIS_URL (or REDIS_HOST)"
fi

# --- NODE_ENV = production ------------------------------------------------------
if ! has_value NODE_ENV; then
  missing "NODE_ENV"
else
  NODE_ENV_VALUE="$(env_get NODE_ENV)"
  if [ "$NODE_ENV_VALUE" = "production" ]; then
    ok "NODE_ENV"
  else
    invalid "NODE_ENV" "must be 'production'"
  fi
fi

# --- BACKUP_DIR (defaultable) ---------------------------------------------------
if has_value BACKUP_DIR; then
  ok "BACKUP_DIR"
else
  ok "BACKUP_DIR (default: /opt/zedbot/backups)"
fi

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "[FAIL] env check failed: ${FAILURES} problem(s). Values are never printed - edit ${ENV_FILE} and re-run." >&2
  exit 1
fi
echo "[ OK ] env check passed."
exit 0
