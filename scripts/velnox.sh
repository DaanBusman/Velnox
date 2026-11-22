#!/usr/bin/env bash
#
# velnox — run and look after a Velnox installation.
#
#   sudo velnox status                  what is running
#   sudo velnox logs [SERVICE]          follow the logs, of one service or all
#   sudo velnox check                   verify the running installation
#   sudo velnox start | stop            start or stop; stopping keeps all data
#   sudo velnox restart [SERVICE]       restart one service or all
#
#   sudo velnox update                  back up, then upgrade to the newest version
#   sudo velnox update --check          only show what an upgrade would bring
#   sudo velnox rollback COMMIT [--restore=FILE]
#                                       go back to an earlier version
#
#   sudo velnox backup                  back up the database to /var/backups
#   sudo velnox backup list             show the backups
#   sudo velnox backup prune [--delete] remove old backups; shows them first
#   sudo velnox backup restore FILE     put a backup back
#   sudo velnox backup library          also back up the ISO library
#
#   sudo velnox cert status             the certificate being served
#   sudo velnox cert self-signed        use Caddy's own certificate
#   sudo velnox cert letsencrypt EMAIL  use Let's Encrypt
#   sudo velnox cert install CERT KEY [CHAIN]
#                                       use a certificate you already have
#
#   sudo velnox disk                    where the disk space went
#   sudo velnox clean                   remove caches; never touches your data
#   velnox version                      the version on this machine
#
# Add --yes to `backup restore`, `rollback` or `clean` to skip the question.
#
# This script only combines commands docs/deployment.md describes. It never
# removes a Docker volume, and it never overwrites a backup.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT}/deploy/compose/docker-compose.yml"
ENV_FILE="${ROOT}/.env"
BACKUP_DIR="${VELNOX_BACKUP_DIR:-/var/backups}"
LIBRARY_VOLUME=velnox_library
MIGRATIONS=packages/db/prisma/migrations
# The services that use the database. Stopped while it is being replaced.
APP_SERVICES=(api worker web)

# shellcheck source=lib/env-file.sh
source "${ROOT}/scripts/lib/env-file.sh"

C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'
C_RED=$'\033[0;31m'; C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[0;33m'

info() { printf '  %s\n' "$*"; }
ok()   { printf '  %s✔%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
die()  { printf '\n  %s%sRefused.%s %s\n\n' "$C_BOLD" "$C_RED" "$C_RESET" "$*" >&2; exit 1; }
head_line() { printf '\n  %s%s%s\n\n' "$C_BOLD" "$*" "$C_RESET"; }

usage() {
  sed -n '3,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

compose() { docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"; }

pg_user() { local v; v="$(get_env_var "$ENV_FILE" POSTGRES_USER)"; printf '%s' "${v:-velnox}"; }
pg_db()   { local v; v="$(get_env_var "$ENV_FILE" POSTGRES_DB)"; printf '%s' "${v:-velnox}"; }

require_installation() {
  [[ -f "$ENV_FILE" ]] || die "${ENV_FILE} does not exist. Install Velnox first: sudo bash ${ROOT}/install.sh"
}

# A service name from the compose file, so a typo gets a list and not a stack trace.
require_service() {
  local name="$1"
  compose config --services | grep -qxF -- "$name" ||
    die "There is no service '${name}'. Services: $(compose config --services | sort | tr '\n' ' ')"
}

# Asks before something that replaces data. Refuses when nobody can answer.
confirm() { # question word yes-flag
  local question="$1" word="$2" assume="$3" answer=""
  ((assume)) && return 0
  [[ -t 0 ]] || die "${question} Nobody can answer here: run it again with --yes."
  printf '\n  %s\n  Type %s%s%s to continue: ' "$question" "$C_BOLD" "$word" "$C_RESET"
  read -r answer || true
  [[ "$answer" == "$word" ]] || die "Nothing was changed."
}

# ---------------------------------------------------------------------------
# Running it
# ---------------------------------------------------------------------------

cmd_status() { compose ps; }

cmd_logs() {
  (($# <= 1)) || die "logs takes one service at most."
  if (($# == 1)); then
    require_service "$1"
    compose logs --follow --tail=100 "$1"
  else
    compose logs --follow --tail=100
  fi
}

cmd_check() {
  local address port
  address="$(get_env_var "$ENV_FILE" VELNOX_SITE_ADDRESS)"
  port="$(get_env_var "$ENV_FILE" CADDY_HTTPS_PORT)"
  [[ -n "$address" ]] || die "VELNOX_SITE_ADDRESS is not set in ${ENV_FILE}."
  if [[ -n "$port" && "$port" != 443 ]]; then address="${address}:${port}"; fi
  bash "${ROOT}/scripts/verify-stack.sh" "https://${address}"
}

cmd_start() { compose up --detach --no-build --wait --wait-timeout 600; ok "Velnox is running."; }

# `down` without --volumes: the database and the library are named volumes and stay.
cmd_stop() { compose down; ok "Velnox is stopped. All data is kept. Start it with: sudo velnox start"; }

cmd_restart() {
  (($# <= 1)) || die "restart takes one service at most."
  if (($# == 1)); then
    require_service "$1"
    compose restart "$1"
  else
    compose restart
  fi
  ok "Restarted."
}

# ---------------------------------------------------------------------------
# Backups
# ---------------------------------------------------------------------------

# Sets BACKUP_FILE. A second backup on one day gets the time in its name: the
# one from this morning may be the only copy from before a failed upgrade.
backup_database() {
  local day partial
  day="$(date +%F)"
  BACKUP_FILE="${BACKUP_DIR}/velnox-${day}.dump"
  [[ -e "$BACKUP_FILE" ]] && BACKUP_FILE="${BACKUP_DIR}/velnox-${day}-$(date +%H%M%S).dump"
  [[ -e "$BACKUP_FILE" ]] && die "${BACKUP_FILE} already exists. Try again in a second."
  mkdir -p "$BACKUP_DIR"
  partial="${BACKUP_FILE}.partial"

  # A dump holds password hashes and encrypted credentials: root only.
  if ! (umask 077 && compose exec -T postgres \
    pg_dump -U "$(pg_user)" -d "$(pg_db)" --format=custom >"$partial"); then
    rm -f -- "$partial"
    die "The database could not be dumped. Is it running? Check with: sudo velnox status"
  fi
  if [[ ! -s "$partial" ]] || ! compose exec -T postgres pg_restore --list <"$partial" >/dev/null 2>&1; then
    rm -f -- "$partial"
    die "The dump could not be read back, so it was not kept."
  fi
  # A hard link fails if the name was taken meanwhile, where mv would replace it.
  if ! ln -- "$partial" "$BACKUP_FILE" 2>/dev/null; then
    rm -f -- "$partial"
    die "${BACKUP_FILE} appeared while backing up. Nothing was overwritten."
  fi
  rm -f -- "$partial"
  ok "Database backed up to ${BACKUP_FILE} ($(du -h -- "$BACKUP_FILE" | cut -f1))"
}

cmd_backup_create() {
  backup_database
  warn "A backup can only be read with MASTER_ENCRYPTION_KEY from ${ENV_FILE}."
  info "Keep a copy of both somewhere other than this machine."
}

cmd_backup_list() {
  head_line "Database backups in ${BACKUP_DIR}"
  local files=() file
  mapfile -t files < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'velnox-*.dump' 2>/dev/null | LC_ALL=C sort)
  if ((${#files[@]} == 0)); then
    info "None yet. Make one with: sudo velnox backup"
  fi
  for file in "${files[@]}"; do
    printf '  %7s  %s  %s\n' "$(du -h -- "$file" | cut -f1)" "$(date -r "$file" '+%F %H:%M')" "$file"
  done
  printf '\n'
}

cmd_backup_library() {
  mkdir -p "$BACKUP_DIR"
  docker run --rm -v "${LIBRARY_VOLUME}:/library:ro" -v "${BACKUP_DIR}:/backup" alpine \
    tar -C /library -cf /backup/velnox-library.tar .
  ok "ISO library backed up to ${BACKUP_DIR}/velnox-library.tar"
}

# The running ones only: a service someone stopped on purpose stays stopped.
running_app_services() {
  local running service
  running="$(compose ps --status running --services)"
  for service in "${APP_SERVICES[@]}"; do
    if grep -qxF -- "$service" <<<"$running"; then printf '%s\n' "$service"; fi
  done
}

require_readable_backup() {
  local file="$1"
  [[ -f "$file" ]] || die "${file} is not a file. See what there is with: sudo velnox backup list"
  compose exec -T postgres pg_restore --list <"$file" >/dev/null 2>&1 ||
    die "${file} is not a database backup that can be read."
}

# One transaction: a restore that fails leaves the database as it was.
restore_database() {
  compose exec -T postgres pg_restore -U "$(pg_user)" -d "$(pg_db)" \
    --clean --if-exists --single-transaction --exit-on-error <"$1"
}

cmd_backup_restore() {
  local file="" assume=0 arg
  for arg in "$@"; do
    case "$arg" in
      --yes | -y) assume=1 ;;
      -*) die "Unknown option: ${arg}" ;;
      *) [[ -z "$file" ]] || die "restore takes one file."; file="$arg" ;;
    esac
  done
  [[ -n "$file" ]] || die "Which backup? See them with: sudo velnox backup list"
  require_readable_backup "$file"
  confirm "This replaces the whole database with ${file}." restore "$assume"

  backup_database
  info "The database as it was is saved there, in case this was the wrong file."

  local services=()
  mapfile -t services < <(running_app_services)
  if ((${#services[@]})); then compose stop "${services[@]}"; fi

  local failed=0
  restore_database "$file" || failed=1
  # An older backup needs the migrations of the version now installed.
  if ((failed == 0)); then compose run --rm --no-deps migrate || failed=2; fi
  if ((${#services[@]})); then compose start "${services[@]}"; fi

  case "$failed" in
    1) die "The restore failed and was undone. The database is as it was." ;;
    2) die "The backup was restored, but its migrations failed. The previous database is in ${BACKUP_FILE}." ;;
  esac
  ok "Restored ${file}."
  warn "Its credentials can only be read with the MASTER_ENCRYPTION_KEY it was made with."
}

cmd_backup() {
  local sub="${1:-create}"
  (($# == 0)) || shift
  case "$sub" in
    create) cmd_backup_create "$@" ;;
    list) cmd_backup_list "$@" ;;
    prune) bash "${ROOT}/scripts/prune-backups.sh" "--dir=${BACKUP_DIR}" "$@" ;;
    restore) cmd_backup_restore "$@" ;;
    library) cmd_backup_library "$@" ;;
    *) die "Unknown: backup ${sub}. Use create, list, prune, restore or library." ;;
  esac
}

# ---------------------------------------------------------------------------
# Upgrading
# ---------------------------------------------------------------------------

require_clean_checkout() {
  git -C "$ROOT" diff --quiet && git -C "$ROOT" diff --cached --quiet && return 0
  git -C "$ROOT" status --short --untracked-files=no >&2
  die "Files in ${ROOT} were edited, listed above. Keep them with 'git stash' or discard them with 'git checkout -- FILE'. Configuration belongs in .env."
}

cmd_update() {
  local only_check=0 arg
  for arg in "$@"; do
    case "$arg" in
      --check) only_check=1 ;;
      *) die "Unknown option: ${arg}" ;;
    esac
  done

  git -C "$ROOT" fetch --quiet origin
  head_line "New since the installed version"
  local incoming
  incoming="$(git -C "$ROOT" log --oneline HEAD..origin/main)"
  if [[ -n "$incoming" ]]; then
    printf '%s\n' "$incoming" | sed 's/^/  /'
  else
    info "Nothing new in Velnox. An update still refreshes PostgreSQL, Redis, Caddy and Node.js."
  fi
  printf '\n'
  ((only_check)) && return 0

  require_clean_checkout
  backup_database

  # After a rollback the checkout is on a commit and not on a branch.
  if ! git -C "$ROOT" symbolic-ref --quiet HEAD >/dev/null; then
    git -C "$ROOT" checkout --quiet main
  fi
  git -C "$ROOT" pull --ff-only --quiet
  # exec, because the pull may just have replaced this very file.
  exec bash "${ROOT}/install.sh" --non-interactive
}

cmd_rollback() {
  local commit="" restore="" assume=0 arg
  for arg in "$@"; do
    case "$arg" in
      --restore=*) restore="${arg#*=}" ;;
      --yes | -y) assume=1 ;;
      -*) die "Unknown option: ${arg}" ;;
      *) [[ -z "$commit" ]] || die "rollback takes one commit."; commit="$arg" ;;
    esac
  done
  if [[ -z "$commit" ]]; then
    head_line "Recent versions"
    git -C "$ROOT" log --oneline -10 | sed 's/^/  /'
    printf '\n'
    info "Go back to one of them with: sudo velnox rollback COMMIT"
    printf '\n'
    return 0
  fi
  git -C "$ROOT" rev-parse --verify --quiet "${commit}^{commit}" >/dev/null ||
    die "'${commit}' is not a commit here."
  require_clean_checkout

  # Migrations only run forwards, so older code cannot run on a newer schema.
  if [[ -z "$restore" ]] && ! git -C "$ROOT" diff --quiet "$commit" HEAD -- "$MIGRATIONS"; then
    die "The database changed between ${commit} and this version, so the older code cannot run on it. Name the backup from before the upgrade: sudo velnox rollback ${commit} --restore=FILE"
  fi

  if [[ -n "$restore" ]]; then
    require_readable_backup "$restore"
    confirm "This replaces the whole database with ${restore} and goes back to ${commit}." rollback "$assume"
    backup_database
    local services=()
    mapfile -t services < <(running_app_services)
    if ((${#services[@]})); then compose stop "${services[@]}"; fi
    if ! restore_database "$restore"; then
      if ((${#services[@]})); then compose start "${services[@]}"; fi
      die "The restore failed and was undone. Nothing was rolled back."
    fi
  else
    confirm "This goes back to ${commit}." rollback "$assume"
  fi

  git -C "$ROOT" checkout --quiet --detach "$commit"
  exec bash "${ROOT}/install.sh" --non-interactive
}

# ---------------------------------------------------------------------------
# Certificates
# ---------------------------------------------------------------------------

cmd_cert() {
  local sub="${1:-status}"
  (($# == 0)) || shift
  local tls=(bash "${ROOT}/scripts/tls.sh")
  case "$sub" in
    status) "${tls[@]}" --status ;;
    self-signed) "${tls[@]}" --self-signed ;;
    letsencrypt)
      (($# == 1)) || die "Usage: sudo velnox cert letsencrypt you@example.com"
      "${tls[@]}" "--letsencrypt=$1"
      ;;
    install)
      (($# == 2 || $# == 3)) || die "Usage: sudo velnox cert install CERT KEY [CHAIN]"
      if (($# == 3)); then
        "${tls[@]}" "--certificate=$1" "--key=$2" "--chain=$3"
      else
        "${tls[@]}" "--certificate=$1" "--key=$2"
      fi
      ;;
    *) die "Unknown: cert ${sub}. Use status, self-signed, letsencrypt or install." ;;
  esac
}

# ---------------------------------------------------------------------------
# Disk space
# ---------------------------------------------------------------------------

cmd_disk() {
  head_line "Disk"
  df -h /
  head_line "Docker"
  docker system df
  head_line "Largest container logs"
  du -sh /var/lib/docker/containers/* 2>/dev/null | sort -h | tail -5 || true
  head_line "Database backups"
  du -ch "${BACKUP_DIR}"/velnox-*.dump 2>/dev/null | tail -1 || info "None."
  head_line "ISO library"
  du -sh "/var/lib/docker/volumes/${LIBRARY_VOLUME}" 2>/dev/null || info "Empty."
  printf '\n'
}

cmd_clean() {
  local assume=0 arg
  for arg in "$@"; do
    case "$arg" in
      --yes | -y) assume=1 ;;
      *) die "Unknown option: ${arg}" ;;
    esac
  done
  head_line "This removes"
  info "the Docker build cache, which the next upgrade downloads again"
  info "images left behind by earlier upgrades"
  info "system logs beyond 200 MB, and the package cache"
  info "It does not touch the database, the ISO library or your backups."
  confirm "Remove these?" clean "$assume"

  local before after
  before="$(df -BM --output=avail / | tail -1 | tr -dc '0-9')"
  docker builder prune --all --force >/dev/null
  docker image prune --force >/dev/null
  if command -v journalctl >/dev/null 2>&1; then journalctl --vacuum-size=200M >/dev/null 2>&1 || true; fi
  if command -v apt-get >/dev/null 2>&1; then apt-get clean; fi
  after="$(df -BM --output=avail / | tail -1 | tr -dc '0-9')"
  ok "Done. Freed about $((after > before ? after - before : 0)) MB."
}

cmd_version() {
  local version commit
  version="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "${ROOT}/package.json" | head -1)"
  commit="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
  printf 'Velnox %s (%s)\n' "$version" "$commit"
}

# ---------------------------------------------------------------------------

main() {
  local command="${1:-help}"
  (($# == 0)) || shift

  case "$command" in
    help | -h | --help) usage; return 0 ;;
    version | --version) cmd_version; return 0 ;;
    status | logs | check | start | stop | restart | update | rollback | backup | cert | disk | clean) ;;
    *)
      printf '  Unknown command: %s\n\n' "$command" >&2
      usage >&2
      return 1
      ;;
  esac

  if ((EUID != 0)); then
    exec sudo bash "${BASH_SOURCE[0]}" "$command" "$@"
  fi
  require_installation

  case "$command" in
    status) cmd_status "$@" ;;
    logs) cmd_logs "$@" ;;
    check) cmd_check "$@" ;;
    start) cmd_start "$@" ;;
    stop) cmd_stop "$@" ;;
    restart) cmd_restart "$@" ;;
    update) cmd_update "$@" ;;
    rollback) cmd_rollback "$@" ;;
    backup) cmd_backup "$@" ;;
    cert) cmd_cert "$@" ;;
    disk) cmd_disk "$@" ;;
    clean) cmd_clean "$@" ;;
  esac
}

# On one line on purpose. Bash reads a script as it runs, and `update` can replace
# this file: nothing after this point may be read from disk once main has started.
{ main "$@"; exit $?; }
