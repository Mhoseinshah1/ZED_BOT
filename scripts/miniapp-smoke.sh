#!/usr/bin/env bash
# =============================================================================
# Production smoke test for the Telegram Mini App.
#
# Verifies the one thing a config test cannot: that a real, running Nginx in
# front of a real API actually emits the headers the generated configuration
# asks for. Nginx add_header inheritance is easy to get right on paper and easy
# to break with an unrelated edit to the server block, and the failure is
# silent - the app keeps working while its framing protection disappears.
#
# Needs no Telegram client and no credentials: it never authenticates, and the
# unauthenticated 401 from the API is exactly as useful as a 200 here, because
# the headers are the subject.
#
# Read-only. Five GETs, no state touched, safe against production.
#
#   ./scripts/miniapp-smoke.sh https://bot.example.com
#
# Asserted matrix:
#
#   /                     -> x-frame-options: DENY
#   /health               -> x-frame-options: DENY
#   /api/miniapp/me       -> x-frame-options: DENY
#   /miniapp              -> NO x-frame-options, valid Mini App CSP,
#                            nosniff + referrer-policy + HSTS, no-store
#   /miniapp/assets/...   -> immutable caching, correct MIME type
# =============================================================================
set -euo pipefail

BASE_URL="${1:-${APP_BASE_URL:-}}"
if [ -z "$BASE_URL" ]; then
  echo "usage: $0 https://your-domain" >&2
  exit 2
fi
BASE_URL="${BASE_URL%/}"

failures=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1" >&2; failures=$((failures + 1)); }

# Response headers, lower-cased so matching never depends on server casing.
fetch_headers() {
  curl -sS -o /dev/null -D - --max-time 20 "$1" 2>/dev/null | tr 'A-Z' 'a-z'
}

header_value() {
  printf '%s' "$2" | grep -i "^$1:" | head -n 1 | cut -d: -f2- | sed 's/^ *//;s/\r$//'
}

# Asserts x-frame-options: DENY on a path that must never be framable.
assert_denied() {
  local label="$1" headers
  headers="$(fetch_headers "${BASE_URL}${1}")"
  if [ -z "$headers" ]; then
    fail "no response from ${label}"
    return
  fi
  case "$(header_value 'x-frame-options' "$headers")" in
    *deny*) pass "${label} -> x-frame-options: DENY" ;;
    *) fail "${label} lost x-frame-options: DENY - the exception must cover /miniapp only" ;;
  esac
}

echo "Mini App smoke test against ${BASE_URL}"

# --- 1-3. everything that must stay un-framable ---------------------------------
echo "[1/5] the site root"
assert_denied "/"
echo "[2/5] the health probe"
assert_denied "/health"
echo "[3/5] the Mini App JSON API (a 401 is expected; the headers are the point)"
assert_denied "/api/miniapp/me"

# --- 4. the Mini App document ---------------------------------------------------
echo "[4/5] GET ${BASE_URL}/miniapp/"
app_headers="$(fetch_headers "${BASE_URL}/miniapp/")"
if [ -z "$app_headers" ]; then
  fail "no response from ${BASE_URL}/miniapp/"
else
  if printf '%s' "$app_headers" | grep -q '^x-frame-options:'; then
    fail "x-frame-options is present on /miniapp/ - Telegram Desktop and Web will show a blank box"
  else
    pass "/miniapp/ -> no x-frame-options"
  fi

  csp="$(header_value 'content-security-policy' "$app_headers")"
  if [ -z "$csp" ]; then
    fail "no content-security-policy on /miniapp/ - nothing governs framing"
  else
    pass "content-security-policy present"
    case "$csp" in
      *frame-ancestors*) pass "frame-ancestors present" ;;
      *) fail "content-security-policy has no frame-ancestors" ;;
    esac
    case "$csp" in
      *"frame-ancestors *"*) fail "frame-ancestors is a wildcard - any site could frame the panel" ;;
      *) pass "frame-ancestors is not a wildcard" ;;
    esac
    case "$csp" in
      *unsafe-eval*) fail "content-security-policy allows unsafe-eval" ;;
      *) pass "no unsafe-eval" ;;
    esac
    missing=""
    for directive in default-src script-src style-src img-src font-src connect-src base-uri form-action object-src; do
      case "$csp" in
        *"$directive"*) : ;;
        *) missing="${missing} ${directive}" ;;
      esac
    done
    if [ -n "$missing" ]; then
      fail "content-security-policy is missing:${missing}"
    else
      pass "all required csp directives present"
    fi
  fi

  case "$(header_value 'x-content-type-options' "$app_headers")" in
    *nosniff*) pass "x-content-type-options: nosniff" ;;
    *) fail "x-content-type-options: nosniff missing on /miniapp/ (inherited headers were dropped)" ;;
  esac

  if [ -n "$(header_value 'referrer-policy' "$app_headers")" ]; then
    pass "referrer-policy present"
  else
    fail "referrer-policy missing on /miniapp/ (inherited headers were dropped)"
  fi

  case "$BASE_URL" in
    https://*)
      if [ -n "$(header_value 'strict-transport-security' "$app_headers")" ]; then
        pass "strict-transport-security present"
      else
        fail "strict-transport-security missing on /miniapp/ (inherited headers were dropped)"
      fi
      ;;
    *) pass "strict-transport-security not applicable over http" ;;
  esac

  # index.html names the current hashed bundles. A cached copy would keep
  # pointing at files the next deploy deletes.
  case "$(header_value 'cache-control' "$app_headers")" in
    *no-store*) pass "index.html is no-store" ;;
    *) fail "index.html is cacheable - a stale copy would reference deleted bundles" ;;
  esac
fi

# --- 5. a hashed asset ----------------------------------------------------------
echo "[5/5] a content-hashed asset"
asset_path="$(curl -sS --max-time 20 "${BASE_URL}/miniapp/" 2>/dev/null \
  | grep -o '/miniapp/assets/[A-Za-z0-9._-]*\.js' | head -n 1)"
if [ -z "$asset_path" ]; then
  fail "could not find a hashed asset in the Mini App document"
else
  asset_headers="$(fetch_headers "${BASE_URL}${asset_path}")"
  case "$(header_value 'cache-control' "$asset_headers")" in
    *immutable*) pass "${asset_path} is immutable" ;;
    *) fail "${asset_path} is not immutable - hashed assets should never be revalidated" ;;
  esac
  case "$(header_value 'content-type' "$asset_headers")" in
    *javascript*) pass "${asset_path} has a javascript content-type" ;;
    *) fail "${asset_path} has the wrong content-type - the browser will refuse to execute it" ;;
  esac
  case "$(header_value 'x-content-type-options' "$asset_headers")" in
    *nosniff*) pass "assets are served with nosniff" ;;
    *) fail "assets are missing x-content-type-options: nosniff" ;;
  esac
fi

echo
if [ "$failures" -eq 0 ]; then
  echo "Mini App smoke test passed."
  exit 0
fi
echo "Mini App smoke test FAILED (${failures} problem(s))." >&2
exit 1
