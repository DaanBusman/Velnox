#!/usr/bin/env bash
#
# Exercises the installer's progress display without installing anything.
#
# install.sh only runs its main() when executed, so this can source it and drive
# the step machinery with harmless commands. Run it in a terminal to see what an
# operator sees:
#
#   ./scripts/test-install-ui.sh
#
# Or with a pseudo-terminal in a clean environment:
#
#   docker run --rm -t -v "$PWD:/w" -w /w -e LANG=C.UTF-8 debian:12 \
#     bash scripts/test-install-ui.sh

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# shellcheck source=../install.sh
source "${ROOT_DIR}/install.sh"

LOG_FILE="$(mktemp)"
trap 'rm -f "$LOG_FILE"' EXIT

fake_work() {
  echo "pretending to work"
  sleep 1.2
}

# Stands in for the image build: several lines, over time, naming the image each
# one belongs to. That is the shape step_streamed exists to render.
fake_build() {
  local line
  for line in     '#3 [api internal] load metadata for docker.io/library/node:22-bookworm-slim'     '#7 [api builder 4/9] RUN pnpm install --frozen-lockfile'     '#7 8.4 Progress: resolved 394, reused 0, downloaded 120'     '#12 [web builder 3/7] RUN pnpm --filter @velnox/web build'     '#12 6.1 Route (app)                                 Size  First Load JS'     '#14 [api] exporting layers'; do
    echo "$line"
    sleep 0.4
  done
}

fake_failure() {
  echo "apt-get: could not resolve 'download.docker.com'"
  echo "E: Unable to locate package docker-ce"
  return 1
}

banner

printf '  %sThis is a rendering test. Nothing is installed.%s\n' "$C_DIM" "$C_RESET"
printf '  %sTerminal: TTY=%s, marks=%s%s%s\n\n' "$C_DIM" "$TTY" "$MARK_OK" "$MARK_SKIP" "$C_RESET"

TOTAL_STEPS=6
[[ $TTY -eq 1 ]] && printf '\033[?25l'

step "Installing prerequisites" fake_work
step_skip "Installing Docker Engine" "already present"
step "Enabling time synchronisation" fake_work
step "Generating configuration and secrets" fake_work
step_streamed "Building images (this takes a few minutes)" fake_build
step "Starting services and waiting for health" fake_work

clear_bar
[[ $TTY -eq 1 ]] && printf '\033[?25h'

printf '\n  %sNow the failure path:%s\n\n' "$C_DIM" "$C_RESET"

# Read by the step machinery in the sourced install.sh, not by this file.
# shellcheck disable=SC2034
STEP_INDEX=0
# shellcheck disable=SC2034
TOTAL_STEPS=2
[[ $TTY -eq 1 ]] && printf '\033[?25l'

step "Installing prerequisites" fake_work
# fail_with_log exits, so this is the last thing the test does.
step "Installing Docker Engine" fake_failure
