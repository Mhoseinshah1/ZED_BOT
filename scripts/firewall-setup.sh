#!/usr/bin/env bash
# =============================================================================
# ZED_BOT safe firewall setup (used by `zedbot firewall`).
#
# ufw with SSH-lockout prevention: the SSH port is detected from the running
# sshd configuration and its ALLOW rule is added BEFORE ufw is ever enabled.
# ufw is only enabled after an explicit confirmation (or ZEDBOT_ENABLE_FIREWALL=1
# for non-interactive runs). Existing custom rules are never deleted and the
# firewall is never wiped/re-initialized. Docker publishes its own iptables
# rules, so container networking (and the loopback-only API binding) is
# unaffected.
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=lib/common.sh
. "${SCRIPT_DIR}/lib/common.sh"

# The running sshd's real port (non-standard ports must stay reachable);
# falls back to 22 when sshd is not available.
detect_ssh_port() {
  local port=""
  if has_command sshd; then
    port="$(sshd -T 2>/dev/null | awk '/^port / {print $2; exit}')" || port=""
  fi
  if [ -z "$port" ] && [ -r /etc/ssh/sshd_config ]; then
    port="$(awk '/^[Pp]ort[[:space:]]+[0-9]+/ {print $2; exit}' /etc/ssh/sshd_config)" || port=""
  fi
  if is_valid_port "${port:-}"; then
    printf '%s' "$port"
  else
    printf '22'
  fi
}

main() {
  require_root

  if [ -r /etc/os-release ]; then
    local os_id
    os_id="$(. /etc/os-release && printf '%s' "${ID:-}")"
    if [ "$os_id" != "ubuntu" ]; then
      log_warn "This firewall helper targets Ubuntu/ufw. Detected a different OS - configure your firewall manually (allow SSH, 80, 443; deny other incoming)."
      exit 0
    fi
  fi

  if ! has_command ufw; then
    log_info "Installing ufw ..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -y
    apt-get install -y ufw
    log_success "ufw installed."
  fi

  local ssh_port
  ssh_port="$(detect_ssh_port)"
  log_info "Detected SSH port: ${ssh_port}"

  # SSH FIRST - the allow rule must exist before ufw can ever be enabled.
  # `ufw allow` is idempotent and never removes existing custom rules.
  log_info "Allowing SSH (${ssh_port}/tcp), HTTP (80/tcp) and HTTPS (443/tcp) ..."
  ufw allow "${ssh_port}/tcp" >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null

  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  log_success "Rules prepared: deny incoming by default, allow SSH/80/443, allow outgoing."

  if ufw status | grep -q '^Status: active'; then
    log_info "ufw is already active - rules updated, nothing to enable."
  else
    # Belt and braces: never enable without a visible SSH allow rule.
    if ! ufw show added 2>/dev/null | grep -q "allow ${ssh_port}/tcp"; then
      log_error "SSH allow rule not found - refusing to enable the firewall (lockout protection)."
      exit 1
    fi
    local enable=""
    if [ "${ZEDBOT_ENABLE_FIREWALL:-0}" = "1" ]; then
      enable=1
    elif [ "${ZEDBOT_NONINTERACTIVE:-0}" = "1" ]; then
      log_warn "Non-interactive mode: NOT enabling ufw (set ZEDBOT_ENABLE_FIREWALL=1 to enable)."
    elif confirm "Enable ufw now? SSH (${ssh_port}/tcp) stays allowed." "n"; then
      enable=1
    fi
    if [ -n "$enable" ]; then
      # --force skips ufw's own prompt; the SSH rule is already in place.
      ufw --force enable
      log_success "ufw enabled."
    else
      log_info "ufw NOT enabled. Enable later with: zedbot firewall (or: ufw enable)"
    fi
  fi

  echo
  ufw status verbose
}

main "$@"
