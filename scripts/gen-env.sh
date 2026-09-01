#!/usr/bin/env bash
#
# Generates .env from .env.example, filling in strong random secrets.
#
# Idempotent by refusing to act: an existing .env is never overwritten, because
# overwriting MASTER_ENCRYPTION_KEY would make every stored credential
# permanently unreadable. Use --force only when you mean to lose them.
#
# Phase 14's install.sh reuses this script rather than reimplementing it.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ROOT}/.env"
EXAMPLE_FILE="${ROOT}/.env.example"
FORCE=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h | --help)
      sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

log() { printf '\033[0;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m warn\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[0;31merror\033[0m %s\n' "$*" >&2
  exit 1
}

[[ -f "$EXAMPLE_FILE" ]] || die ".env.example not found at ${EXAMPLE_FILE}"

if [[ -f "$ENV_FILE" && $FORCE -eq 0 ]]; then
  log ".env already exists — leaving it untouched."
  echo
  echo "  Re-running this script never rotates your secrets by accident."
  echo "  Losing MASTER_ENCRYPTION_KEY makes every stored credential unreadable."
  echo "  If you really want a fresh file, back the current one up and pass --force."
  exit 0
fi

if [[ -f "$ENV_FILE" && $FORCE -eq 1 ]]; then
  BACKUP="${ENV_FILE}.$(date +%Y%m%d%H%M%S).bak"
  cp "$ENV_FILE" "$BACKUP"
  chmod 600 "$BACKUP"
  warn "Existing .env backed up to $(basename "$BACKUP")"
fi

# Node is a hard requirement for Velnox anyway, and its CSPRNG is available on
# every platform this runs on — including Git Bash on Windows, where openssl
# frequently is not.
random_b64() {
  node -e "process.stdout.write(require('node:crypto').randomBytes($1).toString('base64'))"
}
random_pw() {
  node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('base64url'))"
}

command -v node >/dev/null 2>&1 || die "node is required to generate secrets"

log "Generating secrets"
POSTGRES_PASSWORD="$(random_pw)"
REDIS_PASSWORD="$(random_pw)"
MASTER_ENCRYPTION_KEY="$(random_b64 32)"
JWT_SECRET="$(random_b64 32)"

log "Writing ${ENV_FILE}"
cp "$EXAMPLE_FILE" "$ENV_FILE"

# `|` as the delimiter: base64 contains `/` and `+`, but never `|`.
set_var() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i.tmp "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    rm -f "${ENV_FILE}.tmp"
  else
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE"
  fi
}

set_var POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
set_var REDIS_PASSWORD "$REDIS_PASSWORD"
set_var MASTER_ENCRYPTION_KEY "$MASTER_ENCRYPTION_KEY"
set_var JWT_SECRET "$JWT_SECRET"
set_var DATABASE_URL "postgresql://velnox:${POSTGRES_PASSWORD}@postgres:5432/velnox?schema=public"

if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  set_var VELNOX_BUILD_COMMIT "$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
fi

chmod 600 "$ENV_FILE"

cat <<'BANNER'

  .env created with generated secrets (mode 0600).

  ############################################################################
  #  BACK UP MASTER_ENCRYPTION_KEY NOW, SEPARATELY FROM THE DATABASE.        #
  #                                                                          #
  #  Every credential Velnox stores is encrypted under a key derived from it. #
  #  If you lose it there is no recovery path, by design.                     #
  ############################################################################

  Next:  pnpm docker:up

BANNER
