#!/usr/bin/env bash
#
# Remove old database backups — the dumps docs/deployment.md tells you to make.
#
#   sudo bash scripts/prune-backups.sh                  show what would go
#   sudo bash scripts/prune-backups.sh --delete         remove it
#   sudo bash scripts/prune-backups.sh --older-than=90 --keep=14 --delete
#
#   --dir=PATH        where the dumps are            (default /var/backups)
#   --older-than=N    remove dumps older than N days (default 30)
#   --keep=N          always keep the N newest       (default 7, at least 1)
#   --delete          actually remove; without it nothing is touched
#
# Only files named exactly velnox-YYYY-MM-DD.dump are considered, and a dump's
# age is the date in its name, not its modification time: copying a backup back
# from off-site storage gives it a new mtime, and it would stop looking old.

set -euo pipefail

C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
C_RED=$'\033[0;31m'; C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[0;33m'

info() { printf '  %s\n' "$*"; }
ok()   { printf '  %s✔%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
die()  { printf '\n  %s%sRefused.%s %s\n\n' "$C_BOLD" "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

usage() {
  sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

DIR=/var/backups
OLDER_THAN=30
KEEP=7
DELETE=0

for arg in "$@"; do
  case "$arg" in
    --dir=*)        DIR="${arg#*=}" ;;
    --older-than=*) OLDER_THAN="${arg#*=}" ;;
    --keep=*)       KEEP="${arg#*=}" ;;
    --delete)       DELETE=1 ;;
    -h|--help)      usage 0 ;;
    *)              printf '  Unknown option: %s\n\n' "$arg" >&2; usage 1 ;;
  esac
done

[[ "$OLDER_THAN" =~ ^[0-9]+$ ]] || die "--older-than takes a whole number of days, not '${OLDER_THAN}'."
[[ "$KEEP" =~ ^[0-9]+$ ]] || die "--keep takes a whole number, not '${KEEP}'."
# Keeping none would let one command remove every backup there is, including
# the one an upgrade is about to depend on.
(( KEEP >= 1 )) || die "--keep must be at least 1. The newest backup is never removed."
[[ -d "$DIR" ]] || die "${DIR} is not a directory."

# The dumps, newest first. The name sorts by date, so a reverse sort by name is
# a sort by age — and it does not depend on mtimes, for the reason above.
mapfile -t DUMPS < <(
  find "$DIR" -maxdepth 1 -type f -regextype posix-extended \
    -regex '.*/velnox-[0-9]{4}-[0-9]{2}-[0-9]{2}\.dump' -printf '%f\n' | sort -r
)

printf '\n  %sDatabase backups in %s%s\n\n' "$C_BOLD" "$DIR" "$C_RESET"

if (( ${#DUMPS[@]} == 0 )); then
  info "No files named velnox-YYYY-MM-DD.dump here. Nothing to do."
  echo
  exit 0
fi

TODAY="$(date +%s)"
removed=0; kept=0; freed=0
# Counts real dumps only. Indexing the list instead would let a file whose
# name is not a date — velnox-2027-13-45.dump sorts first — take one of the
# --keep places, and with --keep=1 the actual newest backup would be removed.
valid=0

for name in "${DUMPS[@]}"; do
  path="${DIR}/${name}"
  day="${name#velnox-}"; day="${day%.dump}"
  size="$(stat -c %s "$path")"
  human="$(numfmt --to=iec --suffix=B "$size")"

  # A name shaped like a date that is not one (velnox-2026-02-31.dump) is kept:
  # its age is unknown, and unknown is not old.
  if ! stamp="$(date -d "$day" +%s 2>/dev/null)"; then
    warn "${name}  ${human}  kept — the name is not a real date"
    kept=$((kept + 1))
    continue
  fi
  age=$(( (TODAY - stamp) / 86400 ))
  valid=$((valid + 1))

  if (( valid <= KEEP )); then
    printf '  %skeep%s    %s  %8s  %4d days  %s(one of the %d newest)%s\n' \
      "$C_GREEN" "$C_RESET" "$name" "$human" "$age" "$C_DIM" "$KEEP" "$C_RESET"
    kept=$((kept + 1))
  elif (( age <= OLDER_THAN )); then
    printf '  %skeep%s    %s  %8s  %4d days\n' "$C_GREEN" "$C_RESET" "$name" "$human" "$age"
    kept=$((kept + 1))
  else
    if (( DELETE )); then
      rm -f -- "$path"
      printf '  %sremoved%s %s  %8s  %4d days\n' "$C_RED" "$C_RESET" "$name" "$human" "$age"
    else
      printf '  %swould remove%s %s  %8s  %4d days\n' "$C_YELLOW" "$C_RESET" "$name" "$human" "$age"
    fi
    removed=$((removed + 1))
    freed=$((freed + size))
  fi
done

echo
freed_human="$(numfmt --to=iec --suffix=B "$freed")"
if (( removed == 0 )); then
  ok "Nothing is older than ${OLDER_THAN} days outside the ${KEEP} newest. ${kept} kept."
elif (( DELETE )); then
  ok "Removed ${removed}, freeing ${freed_human}. ${kept} kept."
else
  info "${removed} would be removed, freeing ${freed_human}. ${kept} kept."
  info "Nothing was touched. Run again with ${C_BOLD}--delete${C_RESET} to remove them."
fi
echo
