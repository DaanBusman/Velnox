#!/usr/bin/env bash
#
# Generates .env from .env.example, filling in strong random secrets.
#
# Idempotent by refusing to act: an existing .env is never overwritten, because
# overwriting MASTER_ENCRYPTION_KEY would make every stored credential
# permanently unreadable. Use --force only when you mean to lose them.
#
# install.sh calls this; you only need to run it by hand for a manual deployment
# or a development environment.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=lib/env-file.sh
source "${ROOT}/scripts/lib/env-file.sh"

ENV_FILE="${ROOT}/.env"
EXAMPLE_FILE="${ROOT}/.env.example"
FORCE=0
QUIET=0

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --quiet) QUIET=1 ;;
    -h | --help)
      sed -n '2,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

log() { [[ $QUIET -eq 1 ]] || printf '\033[0;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[0;33m warn\033[0m %s\n' "$*" >&2; }
die() {
  printf '\033[0;31merror\033[0m %s\n' "$*" >&2
  exit 1
}

[[ -f "$EXAMPLE_FILE" ]] || die ".env.example not found at ${EXAMPLE_FILE}"

if [[ -f "$ENV_FILE" && $FORCE -eq 0 ]]; then
  log ".env already exists — leaving it untouched."
  if [[ $QUIET -eq 0 ]]; then
    cat <<'EOF'

  Re-running this script never rotates your secrets by accident.
  Losing MASTER_ENCRYPTION_KEY makes every stored credential unreadable.
  If you really want a fresh file, back the current one up and pass --force.
EOF
  fi
  exit 0
fi

if [[ -f "$ENV_FILE" && $FORCE -eq 1 ]]; then
  BACKUP="${ENV_FILE}.$(date +%Y%m%d%H%M%S).bak"
  cp "$ENV_FILE" "$BACKUP"
  chmod 600 "$BACKUP"
  warn "Existing .env backed up to $(basename "$BACKUP")"
fi

log "Generating secrets"
POSTGRES_PASSWORD="$(random_password)"
REDIS_PASSWORD="$(random_password)"
MASTER_ENCRYPTION_KEY="$(random_base64 32)"
JWT_SECRET="$(random_base64 32)"

log "Writing ${ENV_FILE}"
cp "$EXAMPLE_FILE" "$ENV_FILE"

set_env_var "$ENV_FILE" POSTGRES_PASSWORD "$POSTGRES_PASSWORD"
set_env_var "$ENV_FILE" REDIS_PASSWORD "$REDIS_PASSWORD"
set_env_var "$ENV_FILE" MASTER_ENCRYPTION_KEY "$MASTER_ENCRYPTION_KEY"
set_env_var "$ENV_FILE" JWT_SECRET "$JWT_SECRET"
set_env_var "$ENV_FILE" DATABASE_URL \
  "postgresql://velnox:${POSTGRES_PASSWORD}@postgres:5432/velnox?schema=public"

if command -v git >/dev/null 2>&1 && git -C "$ROOT" rev-parse --git-dir >/dev/null 2>&1; then
  set_env_var "$ENV_FILE" VELNOX_BUILD_COMMIT \
    "$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)"
fi

chmod 600 "$ENV_FILE"

if [[ $QUIET -eq 0 ]]; then
  cat <<'BANNER'

  .env created with generated secrets (mode 0600).

  ############################################################################
  #  BACK UP MASTER_ENCRYPTION_KEY NOW, SEPARATELY FROM THE DATABASE.        #
  #                                                                          #
  #  Every credential Velnox stores is encrypted under a key derived from it. #
  #  If you lose it there is no recovery path, by design.                     #
  ############################################################################

BANNER
fi
