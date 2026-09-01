#!/usr/bin/env bash
#
# Velnox installer for Debian and Ubuntu.
#
#   sudo ./install.sh                     interactive
#   sudo ./install.sh --non-interactive   use defaults and flags only
#
# Installs Docker if it is missing, generates configuration and secrets, builds
# the images, starts the stack, waits for every service to become healthy and
# verifies the result. Safe to re-run: an existing .env and all data are kept.

set -euo pipefail

# Captured before parsing, because the privilege check below re-executes this
# script under sudo and by then the parser has shifted the arguments away.
ORIGINAL_ARGS=("$@")

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${ROOT}/deploy/compose/docker-compose.yml"
ENV_FILE="${ROOT}/.env"
LOG_FILE="/var/log/velnox-install-$(date +%Y%m%d-%H%M%S).log"

SITE_ADDRESS=""
TLS_MODE="internal"
HTTP_PORT="80"
HTTPS_PORT="443"
INTERACTIVE=1
SKIP_DOCKER=0
SKIP_VERIFY=0

MIN_DISK_GB=20
MIN_MEM_MB=3500

# ---------------------------------------------------------------------------
# Terminal capabilities
# ---------------------------------------------------------------------------

if [[ -t 1 ]] && [[ -z "${NO_COLOR:-}" ]] && [[ "${TERM:-dumb}" != "dumb" ]]; then
  TTY=1
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
  C_GREEN=$'\033[32m'; C_RED=$'\033[31m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
else
  TTY=0
  C_RESET=""; C_DIM=""; C_BOLD=""
  C_GREEN=""; C_RED=""; C_YELLOW=""; C_CYAN=""
fi

# Braille spinner and box drawing need a UTF-8 locale; fall back to ASCII rather
# than printing replacement characters over a serial console.
if [[ "${LANG:-}${LC_ALL:-}" == *UTF-8* || "${LANG:-}${LC_ALL:-}" == *utf8* ]]; then
  SPIN_FRAMES=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏')
  MARK_OK='✔'; MARK_FAIL='✘'; MARK_SKIP='—'
  BAR_FULL='█'; BAR_EMPTY='░'
  RULE='─'; SEP='·'
else
  # shellcheck disable=SC1003  # a single-quoted backslash is exactly what is meant
  SPIN_FRAMES=('-' '\' '|' '/')
  MARK_OK='+'; MARK_FAIL='x'; MARK_SKIP='-'
  BAR_FULL='#'; BAR_EMPTY='.'
  RULE='-'; SEP='-'
fi

BOX_WIDTH=68
LABEL_WIDTH=44

# ---------------------------------------------------------------------------
# Output primitives
# ---------------------------------------------------------------------------

SPIN_PID=""
STEP_INDEX=0
TOTAL_STEPS=0
STARTED_AT=$(date +%s)
BAR_ON_SCREEN=0

repeat_char() {
  local char="$1" count="$2" out=""
  for ((i = 0; i < count; i++)); do out+="$char"; done
  printf '%s' "$out"
}

# A rule rather than a closed box: padding a line containing multi-byte
# characters to an exact width is unreliable, and a box with a missing right edge
# looks broken. A rule always lines up.
box_line() { printf '  %s%s%s\n' "$C_DIM" "$(repeat_char "$RULE" "$BOX_WIDTH")" "$C_RESET"; }

banner() {
  printf '\n'
  box_line
  printf '  %sVelnox%s  %s  self-hosted MSP management for Proxmox VE\n' \
    "$C_BOLD" "$C_RESET" "$SEP"
  box_line
  printf '\n'
}

# Progress bar, always the last line on screen so steps accumulate above it.
draw_bar() {
  [[ $TTY -eq 1 ]] || return 0
  local completed=$STEP_INDEX total=$TOTAL_STEPS width=34
  ((total > 0)) || return 0
  local filled=$((completed * width / total))
  local pct=$((completed * 100 / total))
  printf '\r\033[K  %s%s%s%s  %3d%%' \
    "$C_CYAN" "$(repeat_char "$BAR_FULL" "$filled")" \
    "$C_DIM$(repeat_char "$BAR_EMPTY" $((width - filled)))" "$C_RESET" "$pct"
  BAR_ON_SCREEN=1
}

clear_bar() {
  [[ $TTY -eq 1 && $BAR_ON_SCREEN -eq 1 ]] || return 0
  printf '\r\033[K'
  BAR_ON_SCREEN=0
}

spinner_start() {
  [[ $TTY -eq 1 ]] || return 0
  (
    trap 'exit 0' TERM
    while :; do
      for frame in "${SPIN_FRAMES[@]}"; do
        printf '\b%s' "$frame"
        sleep 0.08
      done
    done
  ) &
  SPIN_PID=$!
}

spinner_stop() {
  [[ -n "$SPIN_PID" ]] || return 0
  kill "$SPIN_PID" 2>/dev/null || true
  wait "$SPIN_PID" 2>/dev/null || true
  SPIN_PID=""
}

human_time() {
  local s="$1"
  if ((s < 60)); then printf '%ds' "$s"; else printf '%dm%02ds' $((s / 60)) $((s % 60)); fi
}

# Runs one installation step, showing a spinner and the elapsed time.
# All command output goes to the log; only the outcome reaches the screen.
step() {
  local title="$1"
  shift
  STEP_INDEX=$((STEP_INDEX + 1))
  local start
  start=$(date +%s)

  clear_bar
  if [[ $TTY -eq 1 ]]; then
    printf '  %s[%d/%d]%s %-*s  ' "$C_DIM" "$STEP_INDEX" "$TOTAL_STEPS" "$C_RESET" \
      "$LABEL_WIDTH" "$title"
    spinner_start
  else
    printf '  [%d/%d] %s\n' "$STEP_INDEX" "$TOTAL_STEPS" "$title"
  fi

  echo "=== [$STEP_INDEX/$TOTAL_STEPS] $title" >>"$LOG_FILE"

  if "$@" >>"$LOG_FILE" 2>&1; then
    spinner_stop
    local elapsed=$(($(date +%s) - start))
    if [[ $TTY -eq 1 ]]; then
      printf '\r\033[K  %s[%d/%d]%s %-*s  %s%s%s %s%s%s\n' \
        "$C_DIM" "$STEP_INDEX" "$TOTAL_STEPS" "$C_RESET" "$LABEL_WIDTH" "$title" \
        "$C_GREEN" "$MARK_OK" "$C_RESET" "$C_DIM" "$(human_time "$elapsed")" "$C_RESET"
    else
      printf '        done in %s\n' "$(human_time "$elapsed")"
    fi
    draw_bar
    return 0
  fi

  spinner_stop
  if [[ $TTY -eq 1 ]]; then
    printf '\r\033[K  %s[%d/%d]%s %-*s  %s%s%s\n' \
      "$C_DIM" "$STEP_INDEX" "$TOTAL_STEPS" "$C_RESET" "$LABEL_WIDTH" "$title" \
      "$C_RED" "$MARK_FAIL" "$C_RESET"
  else
    printf '        FAILED\n'
  fi
  fail_with_log "$title"
}

# Marks a step as deliberately skipped without running anything.
step_skip() {
  local title="$1" reason="$2"
  STEP_INDEX=$((STEP_INDEX + 1))
  clear_bar
  printf '  %s[%d/%d]%s %-*s  %s%s %s%s\n' \
    "$C_DIM" "$STEP_INDEX" "$TOTAL_STEPS" "$C_RESET" "$LABEL_WIDTH" "$title" \
    "$C_DIM" "$MARK_SKIP" "$reason" "$C_RESET"
  echo "=== [$STEP_INDEX/$TOTAL_STEPS] $title (skipped: $reason)" >>"$LOG_FILE"
  draw_bar
}

note() {
  clear_bar
  printf '  %s%s%s\n' "$C_DIM" "$*" "$C_RESET"
  draw_bar
}

fail_with_log() {
  clear_bar
  printf '\n  %s%sInstallation failed%s while: %s\n\n' "$C_BOLD" "$C_RED" "$C_RESET" "$1"
  printf '  %sLast lines of %s:%s\n\n' "$C_DIM" "$LOG_FILE" "$C_RESET"
  tail -n 25 "$LOG_FILE" 2>/dev/null | sed 's/^/    /'
  printf '\n  %sThe full log is at %s%s\n\n' "$C_DIM" "$LOG_FILE" "$C_RESET"
  exit 1
}

die() {
  clear_bar
  printf '\n  %s%serror%s %s\n\n' "$C_BOLD" "$C_RED" "$C_RESET" "$*"
  exit 1
}

cleanup() {
  spinner_stop
  [[ $TTY -eq 1 ]] && printf '\033[?25h'
  return 0
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Arguments
# ---------------------------------------------------------------------------

usage() {
  cat <<EOF
Velnox installer

  sudo ./install.sh [options]

Options
  --non-interactive        Never prompt; use defaults and the flags below
  --site-address=HOST      Hostname or IP operators will use (default: this host's IP)
  --tls=internal|EMAIL     'internal' for a self-signed certificate (default),
                           or an email address to obtain one via Let's Encrypt
  --http-port=PORT         Host port for HTTP (default 80)
  --https-port=PORT        Host port for HTTPS (default 443)
  --skip-docker            Assume Docker is already installed and configured
  --skip-verify            Do not run the post-install verification
  -h, --help               Show this help

Re-running is safe: an existing .env and all data are preserved.
EOF
}

parse_arguments() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --non-interactive | -y) INTERACTIVE=0 ;;
      --site-address=*) SITE_ADDRESS="${1#*=}" ;;
      --tls=*) TLS_MODE="${1#*=}" ;;
      --http-port=*) HTTP_PORT="${1#*=}" ;;
      --https-port=*) HTTPS_PORT="${1#*=}" ;;
      --skip-docker) SKIP_DOCKER=1 ;;
      --skip-verify) SKIP_VERIFY=1 ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        usage >&2
        die "Unknown option: $1"
        ;;
    esac
    shift
  done
}

# ---------------------------------------------------------------------------
# Privileges
# ---------------------------------------------------------------------------

require_root() {
  [[ "${EUID}" -eq 0 ]] && return 0
  if command -v sudo >/dev/null 2>&1; then
    exec sudo -E bash "$0" "${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"}"
  fi
  die "This installer needs root. Run it with sudo."
}

open_log() {
  touch "$LOG_FILE" 2>/dev/null || LOG_FILE="${ROOT}/install.log"
  : >"$LOG_FILE"
  chmod 600 "$LOG_FILE" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------

OS_ID=""
OS_VERSION=""
OS_CODENAME=""

preflight() {
  [[ -r /etc/os-release ]] || die "Cannot read /etc/os-release. This installer supports Debian and Ubuntu."
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-unknown}"
  OS_VERSION="${VERSION_ID:-unknown}"
  OS_CODENAME="${VERSION_CODENAME:-${UBUNTU_CODENAME:-}}"

  case "$OS_ID" in
    debian | ubuntu) ;;
    *) die "Unsupported distribution '${OS_ID}'. Velnox supports Debian and Ubuntu." ;;
  esac

  local arch
  arch="$(dpkg --print-architecture 2>/dev/null || uname -m)"
  [[ "$arch" == "amd64" || "$arch" == "x86_64" ]] ||
    die "Unsupported architecture '${arch}'. Velnox requires 64-bit x86."

  [[ -f "$COMPOSE_FILE" ]] ||
    die "Cannot find ${COMPOSE_FILE}. Run this script from inside the Velnox directory."

  local disk_gb mem_mb
  disk_gb=$(($(df -Pk "$ROOT" | awk 'NR==2 {print $4}') / 1024 / 1024))
  mem_mb=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)

  ((disk_gb >= MIN_DISK_GB)) ||
    die "Only ${disk_gb} GB free on $(df -P "$ROOT" | awk 'NR==2 {print $6}'). Velnox needs at least ${MIN_DISK_GB} GB."

  if ((mem_mb < MIN_MEM_MB)); then
    printf '  %swarning%s This host has %d MB of RAM; %d MB is the recommended minimum.\n' \
      "$C_YELLOW" "$C_RESET" "$mem_mb" "$MIN_MEM_MB"
  fi

  # iproute2 is installed by the first step, so this check is best-effort on a
  # truly minimal image. A port conflict then surfaces when Caddy fails to bind,
  # which is still a clear failure rather than a silent one.
  command -v ss >/dev/null 2>&1 || return 0

  for port in "$HTTP_PORT" "$HTTPS_PORT"; do
    if ss -lnt 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}\$"; then
      # Our own Caddy holding the port on a re-run is expected, not a conflict.
      if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^velnox-caddy'; then
        die "Port ${port} is already in use. Free it, or pass --http-port/--https-port."
      fi
    fi
  done
}

default_site_address() {
  local ip
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}')"
  [[ -n "$ip" ]] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [[ -n "$ip" ]] || ip="localhost"
  printf '%s' "$ip"
}

# ---------------------------------------------------------------------------
# Interactive configuration
# ---------------------------------------------------------------------------

ask() {
  local prompt="$1" default="$2" answer
  read -r -p "  ${prompt} [${default}]: " answer </dev/tty || answer=""
  printf '%s' "${answer:-$default}"
}

configure() {
  local detected
  detected="$(default_site_address)"

  if [[ -z "$SITE_ADDRESS" ]]; then
    if [[ $INTERACTIVE -eq 1 ]]; then
      printf '  %sHow will operators reach this installation?%s\n' "$C_BOLD" "$C_RESET"
      printf '  %sA hostname if you have DNS for it, otherwise this host'"'"'s IP address.%s\n\n' \
        "$C_DIM" "$C_RESET"
      SITE_ADDRESS="$(ask "Address" "$detected")"
      printf '\n'
    else
      SITE_ADDRESS="$detected"
    fi
  fi

  if [[ $INTERACTIVE -eq 1 && "$TLS_MODE" == "internal" ]]; then
    printf '  %sCertificate%s\n' "$C_BOLD" "$C_RESET"
    printf '  %sLeave as "internal" for a self-signed certificate, which is right for a\n' "$C_DIM"
    printf '  management network — browsers warn once. Enter an email address instead to\n'
    printf '  obtain a publicly trusted certificate, which needs %s to resolve\n' "$SITE_ADDRESS"
    printf '  publicly and be reachable on ports 80 and 443.%s\n\n' "$C_RESET"
    TLS_MODE="$(ask "TLS" "internal")"
    printf '\n'
  fi
}

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------

apt_quiet() {
  DEBIAN_FRONTEND=noninteractive apt-get -o Dpkg::Use-Pty=0 -qq "$@"
}

install_base_packages() {
  apt_quiet update
  apt_quiet install -y --no-install-recommends \
    ca-certificates curl gnupg iproute2 chrony jq
}

docker_is_usable() {
  command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1
}

install_docker() {
  install -m 0755 -d /etc/apt/keyrings

  curl -fsSL "https://download.docker.com/linux/${OS_ID}/gpg" |
    gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg

  printf 'deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/%s %s stable\n' \
    "$OS_ID" "$OS_CODENAME" >/etc/apt/sources.list.d/docker.list

  apt_quiet update
  apt_quiet install -y \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

  systemctl enable --now docker
  docker compose version
}

enable_time_sync() {
  systemctl enable --now chrony 2>/dev/null || systemctl enable --now chronyd 2>/dev/null || true
  timedatectl set-ntp true 2>/dev/null || true
  timedatectl status 2>/dev/null || true
  return 0
}

generate_configuration() {
  bash "${ROOT}/scripts/gen-env.sh" --quiet

  # shellcheck source=scripts/lib/env-file.sh
  source "${ROOT}/scripts/lib/env-file.sh"

  set_env_var "$ENV_FILE" VELNOX_SITE_ADDRESS "$SITE_ADDRESS"
  set_env_var "$ENV_FILE" APP_URL "https://${SITE_ADDRESS}"
  set_env_var "$ENV_FILE" VELNOX_TLS "$TLS_MODE"
  set_env_var "$ENV_FILE" CADDY_HTTP_PORT "$HTTP_PORT"
  set_env_var "$ENV_FILE" CADDY_HTTPS_PORT "$HTTPS_PORT"
  chmod 600 "$ENV_FILE"
}

build_images() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" build --pull
}

start_services() {
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up \
    --detach --wait --wait-timeout 600
}

verify_installation() {
  bash "${ROOT}/scripts/verify-stack.sh" "https://${SITE_ADDRESS}"
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

summary() {
  clear_bar
  # shellcheck source=scripts/lib/env-file.sh
  source "${ROOT}/scripts/lib/env-file.sh"
  local key
  key="$(get_env_var "$ENV_FILE" MASTER_ENCRYPTION_KEY)"

  local total
  total=$(($(date +%s) - STARTED_AT))

  printf '\n'
  box_line
  printf '  %s%sVelnox is running.%s   %s(%s)%s\n' \
    "$C_BOLD" "$C_GREEN" "$C_RESET" "$C_DIM" "$(human_time "$total")" "$C_RESET"
  box_line
  printf '\n'
  printf '    Open   %s%shttps://%s%s\n' "$C_BOLD" "$C_CYAN" "$SITE_ADDRESS" "$C_RESET"

  if [[ "$TLS_MODE" == "internal" ]]; then
    printf '    %sThe certificate is self-signed, so your browser warns once. Expected.%s\n' \
      "$C_DIM" "$C_RESET"
  fi

  printf '\n'
  printf '  %s%s%s\n' "$C_BOLD" "Back up this key now, somewhere other than this machine:" "$C_RESET"
  printf '\n    MASTER_ENCRYPTION_KEY=%s%s%s\n' "$C_YELLOW" "$key" "$C_RESET"
  printf '\n'
  printf '  %sEvery credential Velnox stores is encrypted under a key derived from it.\n' "$C_DIM"
  printf '  Lose it and those credentials cannot be recovered — by design.%s\n' "$C_RESET"
  printf '\n'
  box_line
  printf '  %sConfiguration%s  %s/.env\n' "$C_DIM" "$C_RESET" "$ROOT"
  printf '  %sInstall log%s    %s\n' "$C_DIM" "$C_RESET" "$LOG_FILE"
  printf '  %sManage%s         cd %s && docker compose -f deploy/compose/docker-compose.yml --env-file .env ps\n' \
    "$C_DIM" "$C_RESET" "$ROOT"
  box_line
  printf '\n'
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  parse_arguments "$@"
  require_root
  open_log

  banner
  preflight
  configure

  # Count the steps that will actually run, so [n/total] is honest.
  # Five always run: prerequisites, time sync, configuration, build, start.
  TOTAL_STEPS=5
  [[ $SKIP_DOCKER -eq 0 ]] && TOTAL_STEPS=$((TOTAL_STEPS + 1))
  [[ $SKIP_VERIFY -eq 0 ]] && TOTAL_STEPS=$((TOTAL_STEPS + 1))

  printf '  %sInstalling to %s on %s %s%s
' "$C_DIM" "$ROOT" "${OS_ID^}" "$OS_VERSION" "$C_RESET"
  printf '  %sFollow along with: tail -f %s%s

' "$C_DIM" "$LOG_FILE" "$C_RESET"

  [[ $TTY -eq 1 ]] && printf '[?25l'

  step "Installing prerequisites" install_base_packages

  if [[ $SKIP_DOCKER -eq 1 ]]; then
    :
  elif docker_is_usable; then
    step_skip "Installing Docker Engine" "already present"
  else
    step "Installing Docker Engine" install_docker
  fi

  step "Enabling time synchronisation" enable_time_sync
  step "Generating configuration and secrets" generate_configuration
  step "Building images (this takes a few minutes)" build_images
  step "Starting services and waiting for health" start_services

  [[ $SKIP_VERIFY -eq 1 ]] || step "Verifying the installation" verify_installation

  clear_bar
  [[ $TTY -eq 1 ]] && printf '[?25h'

  summary
}

# Only run when executed, so the progress UI can be sourced and exercised by
# scripts/test-install-ui.sh without performing an installation.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "${ORIGINAL_ARGS[@]+"${ORIGINAL_ARGS[@]}"}"
fi
