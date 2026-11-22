#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2034  # check() evaluates its second argument later
#
# Tests for scripts/velnox.sh, in a throwaway checkout with a stand-in `docker`.
# Nothing here reaches a real Docker daemon, database or remote.
#
#   sudo bash scripts/test-velnox-cli.sh
#
# Needs git and GNU tools, and root, because the command does. From another
# machine, run it in a container:
#
#   sudo docker run --rm -v "$PWD/scripts:/s:ro" debian:bookworm-slim sh -c \
#     'apt-get update -qq && apt-get install -y -qq git >/dev/null && bash /s/test-velnox-cli.sh'
#
# The rules checked are the ones where a mistake costs data: a backup is never
# overwritten, a failed restore changes nothing, a service someone stopped stays
# stopped, and no command ever touches a Docker volume.

set -uo pipefail

SOURCE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
((EUID == 0)) || { echo "Run as root: the command under test requires it." >&2; exit 1; }

T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
R="$T/velnox"
B="$T/backups"
LOG="$T/calls.log"
G=(git -c user.name=test -c user.email=test@example.invalid)

pass=0; fail=0
check() {
  if eval "$2"; then pass=$((pass + 1)); echo "  ok   $1"
  else fail=$((fail + 1)); echo "  FAIL $1"; fi
}
called() { grep -qE -- "$1" "$LOG"; }
not_called() { ! grep -qE -- "$1" "$LOG"; }
line_of() { grep -nE -- "$1" "$LOG" | head -1 | cut -d: -f1; }
before() { local a b; a="$(line_of "$1")"; b="$(line_of "$2")"; [[ -n "$a" && -n "$b" ]] && ((a < b)); }
v() { VELNOX_BACKUP_DIR="$B" PATH="$T/bin:$PATH" bash "$R/scripts/velnox.sh" "$@" </dev/null >"$T/out" 2>&1; }
reset_log() { cat "$LOG" >>"$T/all-calls.log" 2>/dev/null; : >"$LOG"; }
dumps() { find "$B" -maxdepth 1 -type f -name 'velnox-*.dump' 2>/dev/null | wc -l; }
partials() { find "$B" -maxdepth 1 -name '*.partial' 2>/dev/null | wc -l; }

mkdir -p "$T/bin" "$B" "$R/scripts/lib" "$R/deploy/compose" "$R/packages/db/prisma/migrations"
cp "$SOURCE/velnox.sh" "$SOURCE/prune-backups.sh" "$R/scripts/"
cp "$SOURCE/lib/env-file.sh" "$R/scripts/lib/"
for stub in install.sh scripts/tls.sh scripts/verify-stack.sh; do
  printf '#!/bin/sh\necho "%s $*" >> "%s"\n' "$stub" "$LOG" >"$R/$stub"
done
echo 'services: {}' >"$R/deploy/compose/docker-compose.yml"
printf '{\n  "name": "velnox",\n  "version": "9.8.7"\n}\n' >"$R/package.json"
printf '.env\n' >"$R/.gitignore"
printf 'VELNOX_SITE_ADDRESS=velnox.test\nCADDY_HTTPS_PORT=8443\nPOSTGRES_USER=owner\nPOSTGRES_DB=fleet\n' >"$R/.env"

# The stand-in: records every call and answers the few that return something.
cat >"$T/bin/docker" <<EOF
#!/usr/bin/env bash
echo "docker \$*" >> "$LOG"
case " \$* " in
  *" config --services "*) printf 'api\nworker\nweb\npostgres\nredis\ncaddy\nmigrate\n' ;;
  *" ps --status running --services "*) cat "$T/running" ;;
  *" pg_dump "*) [[ -e "$T/fail-dump" ]] && exit 1; [[ -e "$T/bad-dump" ]] && { echo garbage; exit 0; }; echo "DUMP \$(date +%s%N)" ;;
  *" pg_restore --list "*) grep -q '^DUMP'; exit \$? ;;
  *" pg_restore "*) cat >/dev/null; [[ -e "$T/fail-restore" ]] && exit 1; exit 0 ;;
esac
exit 0
EOF
chmod +x "$T/bin/docker"
printf 'api\nweb\n' >"$T/running"

# A checkout with a remote, three commits, and a migration in the last one.
"${G[@]}" init -q -b main --bare "$T/origin.git"
"${G[@]}" -C "$R" init -q -b main
"${G[@]}" -C "$R" add -A
"${G[@]}" -C "$R" commit -q -m first
FIRST="$("${G[@]}" -C "$R" rev-parse --short HEAD)"
echo two >"$R/two.txt"; "${G[@]}" -C "$R" add -A; "${G[@]}" -C "$R" commit -q -m second
SECOND="$("${G[@]}" -C "$R" rev-parse --short HEAD)"
echo 'SELECT 1;' >"$R/packages/db/prisma/migrations/one.sql"
"${G[@]}" -C "$R" add -A; "${G[@]}" -C "$R" commit -q -m third
"${G[@]}" -C "$R" remote add origin "$T/origin.git"
"${G[@]}" -C "$R" push -q -u origin main

echo "Backups"
reset_log; v backup; rc=$?
FIRST_DUMP="$B/velnox-$(date +%F).dump"
check "a backup succeeds" '[[ $rc -eq 0 && -s "$FIRST_DUMP" ]]'
check "it is readable by root only" '[[ "$(stat -c %a "$FIRST_DUMP")" == 600 ]]'
check "it uses the configured user and database" 'called "pg_dump -U owner -d fleet --format=custom"'
check "it reminds about the encryption key" 'grep -q MASTER_ENCRYPTION_KEY "$T/out"'
check "no partial file stays behind" '[[ "$(partials)" -eq 0 ]]'
original="$(cat "$FIRST_DUMP")"
sleep 1; v backup
check "a second backup on one day does not overwrite the first" '[[ "$(cat "$FIRST_DUMP")" == "$original" && "$(dumps)" -eq 2 ]]'
touch "$T/fail-dump"; before_count="$(dumps)"; v backup; rc=$?; rm "$T/fail-dump"
check "a failed dump is an error and keeps nothing" '[[ $rc -ne 0 && "$(dumps)" -eq $before_count && "$(partials)" -eq 0 ]]'
touch "$T/bad-dump"; sleep 1; v backup; rc=$?; rm "$T/bad-dump"
check "a dump that cannot be read back is not kept" '[[ $rc -ne 0 && "$(dumps)" -eq $before_count && "$(partials)" -eq 0 ]]'
v backup list
check "list shows the backups" 'grep -q "velnox-$(date +%F).dump" "$T/out"'

echo "Restore"
reset_log; v backup restore "$FIRST_DUMP"; rc=$?
check "restore with nobody to answer is refused" '[[ $rc -ne 0 ]] && not_called "pg_restore -U"'
echo not-a-dump >"$T/wrong"; reset_log; v backup restore "$T/wrong" --yes; rc=$?
check "restore of a file that is no backup is refused" '[[ $rc -ne 0 ]] && not_called "pg_restore -U"'
reset_log; sleep 1; v backup restore "$FIRST_DUMP" --yes; rc=$?
check "restore succeeds" '[[ $rc -eq 0 ]]'
check "it saves the current database first" 'before "pg_dump" "pg_restore -U"'
check "it stops only what was running" 'called "stop api web$"'
check "a service stopped on purpose stays stopped" 'not_called "(stop|start) .*worker"'
check "it runs in one transaction" 'called "pg_restore -U owner -d fleet --clean --if-exists --single-transaction --exit-on-error"'
check "it applies migrations after restoring" 'before "pg_restore -U" "run --rm --no-deps migrate"'
check "it starts the services again" 'before "run --rm --no-deps migrate" "start api web$"'
touch "$T/fail-restore"; reset_log; sleep 1; v backup restore "$FIRST_DUMP" --yes; rc=$?; rm "$T/fail-restore"
check "a failed restore is an error" '[[ $rc -ne 0 ]] && grep -q "undone" "$T/out"'
check "a failed restore runs no migrations" 'not_called "migrate"'
check "a failed restore starts the services again" 'called "start api web$"'

echo "Update"
HEAD_NOW="$("${G[@]}" -C "$R" rev-parse HEAD)"
W="$T/other"; "${G[@]}" clone -q "$T/origin.git" "$W"
echo four >"$W/four.txt"; "${G[@]}" -C "$W" add -A; "${G[@]}" -C "$W" commit -q -m 'fourth change'; "${G[@]}" -C "$W" push -q origin main
reset_log; v update --check; rc=$?
check "--check shows what is new" '[[ $rc -eq 0 ]] && grep -q "fourth change" "$T/out"'
check "--check changes nothing" '[[ "$("${G[@]}" -C "$R" rev-parse HEAD)" == "$HEAD_NOW" ]] && not_called "pg_dump" && not_called "install.sh"'
echo edit >>"$R/two.txt"; reset_log; v update; rc=$?
check "an edited checkout is refused before anything happens" '[[ $rc -ne 0 ]] && not_called "pg_dump" && not_called "install.sh"'
"${G[@]}" -C "$R" checkout -q -- two.txt
reset_log; sleep 1; v update; rc=$?
check "update succeeds" '[[ $rc -eq 0 && -f "$R/four.txt" ]]'
check "it backs up before it installs" 'before "pg_dump" "install.sh --non-interactive"'

echo "Rollback"
reset_log; v rollback nonsense --yes; rc=$?
check "an unknown commit is refused" '[[ $rc -ne 0 ]] && not_called "install.sh"'
reset_log; v rollback "$SECOND" --yes; rc=$?
check "across a migration without a backup is refused" '[[ $rc -ne 0 ]] && grep -q -- "--restore=" "$T/out" && not_called "install.sh"'
reset_log; sleep 1; v rollback "$FIRST" "--restore=$FIRST_DUMP" --yes; rc=$?
check "with a backup it goes back" '[[ $rc -eq 0 && "$("${G[@]}" -C "$R" rev-parse --short HEAD)" == "$FIRST" ]]'
check "it restores before it installs" 'before "pg_restore -U" "install.sh --non-interactive"'
check "it does not run the newer migrations on the restored database" 'not_called "migrate"'
reset_log; sleep 1; v update; rc=$?
check "update works again after a rollback" '[[ $rc -eq 0 && -f "$R/four.txt" && "$("${G[@]}" -C "$R" symbolic-ref --short HEAD)" == main ]]'
"${G[@]}" -C "$R" checkout -q --detach "$SECOND"
reset_log; v rollback "$FIRST" --yes; rc=$?
check "without a migration in between no backup is needed" '[[ $rc -eq 0 ]] && called "install.sh --non-interactive" && not_called "pg_restore -U"'
"${G[@]}" -C "$R" checkout -q main

echo "The rest"
reset_log; v logs nonsense; rc=$?
check "an unknown service is refused with the list" '[[ $rc -ne 0 ]] && grep -q "worker" "$T/out"'
reset_log; v logs api
check "logs follows one service" 'called "logs --follow --tail=100 api$"'
reset_log; v check
check "check uses the configured address and port" 'called "verify-stack.sh https://velnox.test:8443$"'
reset_log; v cert letsencrypt you@example.com
check "cert letsencrypt" 'called "tls.sh --letsencrypt=you@example.com$"'
reset_log; v cert install /c.pem /k.pem /chain.pem
check "cert install with a chain" 'called "tls.sh --certificate=/c.pem --key=/k.pem --chain=/chain.pem$"'
reset_log; v clean; rc=$?
check "clean with nobody to answer is refused" '[[ $rc -ne 0 ]] && not_called "prune"'
reset_log; v clean --yes; rc=$?
check "clean removes build cache and unused images" '[[ $rc -eq 0 ]] && called "builder prune --all --force" && called "image prune --force"'
reset_log; v stop; v start; v restart; v status; v disk
check "stop is a plain down" 'called " down$"'
check "start does not rebuild" 'called "up --detach --no-build"'
reset_log
check "no command in this whole run touched a Docker volume" '[[ -s "$T/all-calls.log" ]] && ! grep -qE "docker volume|system prune|--volumes|down -v" "$T/all-calls.log"'
v version
check "version names the release" 'grep -q "Velnox 9.8.7" "$T/out"'
v nonsense; rc=$?
check "an unknown command is an error" '[[ $rc -ne 0 ]]'

echo
echo "  ${pass} passed, ${fail} failed"
((fail == 0))
