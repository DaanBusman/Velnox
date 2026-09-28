#!/usr/bin/env bash
#
# Tests for scripts/prune-backups.sh, against a throwaway directory.
#
#   bash scripts/test-prune-backups.sh
#
# Needs GNU date, find and numfmt — any Debian or Ubuntu host. From another
# machine, run it in a container:
#
#   sudo docker run --rm -v "$PWD/scripts:/s:ro" debian:bookworm-slim bash /s/test-prune-backups.sh
#
# A script that deletes backups is the one place a wrong answer cannot be
# undone, so each rule it promises is checked here, including the ones about
# what it must leave alone.

set -uo pipefail

S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/prune-backups.sh"
B="$(mktemp -d)"
trap 'rm -rf "$B"' EXIT

pass=0; fail=0
check() {
  if eval "$2"; then pass=$((pass + 1)); echo "  ok   $1"
  else fail=$((fail + 1)); echo "  FAIL $1"; fi
}
dump() { echo "$B/velnox-$(date -d "-$1 days" +%F).dump"; }
listing() { ls -la "$B" | sort | md5sum; }

fixture() {
  rm -rf "$B"; mkdir -p "$B"
  for d in 0 1 2 3 5 10 20 29 31 40 60 90 200; do
    head -c $(( (d + 1) * 1024 )) /dev/zero > "$(dump "$d")"
  done
  echo x > "$B/velnox-2020-02-31.dump"                 # shaped like a date, is not one
  echo x > "$B/velnox-2020-01-01.dump.tmp"             # wrong name
  echo x > "$B/other-2020-01-01.dump"                  # wrong name
  echo x > "$B/target"; ln -s "$B/target" "$B/velnox-2019-01-01.dump"   # a symlink
  touch "$(dump 120)"                                  # copied back: old name, new mtime
}

echo "== a dry run touches nothing"
fixture; before="$(listing)"
out="$(bash "$S" --dir="$B" 2>&1)"; rc=$?
check "exit 0" "[ $rc = 0 ]"
check "no file changed" "[ \"\$(listing)\" = \"$before\" ]"
check "lists what would go" "grep -q 'would remove' <<<\"\$out\""
check "says nothing was touched" "grep -q 'Nothing was touched' <<<\"\$out\""

echo "== --delete with the defaults: older than 30 days, keep the 7 newest"
fixture
bash "$S" --dir="$B" --delete >/dev/null 2>&1; rc=$?
check "exit 0" "[ $rc = 0 ]"
for d in 31 40 60 90 200; do check "removed, $d days old" "[ ! -e \"$(dump "$d")\" ]"; done
for d in 0 1 2 3 5 10 20 29; do check "kept, $d days old" "[ -e \"$(dump "$d")\" ]"; done
check "age comes from the name, not the mtime" "[ ! -e \"$(dump 120)\" ]"
check "a name that is not a date is kept" "[ -e \"$B/velnox-2020-02-31.dump\" ]"
check "other names are left alone" "[ -e \"$B/velnox-2020-01-01.dump.tmp\" ] && [ -e \"$B/other-2020-01-01.dump\" ]"
check "a symlink is left alone" "[ -L \"$B/velnox-2019-01-01.dump\" ] && [ -e \"$B/target\" ]"

echo "== --keep wins over age"
fixture
bash "$S" --dir="$B" --older-than=0 --keep=3 --delete >/dev/null 2>&1
for d in 0 1 2; do check "kept, one of the 3 newest ($d days)" "[ -e \"$(dump "$d")\" ]"; done
check "the 4th newest goes at --older-than=0" "[ ! -e \"$(dump 3)\" ]"

echo "== the newest survives when everything is old"
rm -rf "$B"; mkdir -p "$B"
for d in 400 500 600; do echo x > "$(dump "$d")"; done
bash "$S" --dir="$B" --older-than=1 --keep=1 --delete >/dev/null 2>&1
check "one left" "[ \$(ls \"$B\" | wc -l) = 1 ]"
check "and it is the newest" "[ -e \"$(dump 400)\" ]"

echo "== a name that is not a date does not take a --keep place"
rm -rf "$B"; mkdir -p "$B"
echo x > "$B/velnox-2027-13-45.dump"   # sorts first, and is not a date
for d in 400 500; do echo x > "$(dump "$d")"; done
bash "$S" --dir="$B" --older-than=1 --keep=1 --delete >/dev/null 2>&1
check "the real newest is kept with --keep=1" "[ -e \"$(dump 400)\" ]"
check "the older one goes" "[ ! -e \"$(dump 500)\" ]"
check "the non-date name is kept" "[ -e \"$B/velnox-2027-13-45.dump\" ]"

echo "== refusals change nothing"
fixture; before="$(listing)"
bash "$S" --dir="$B" --keep=0 --delete >/dev/null 2>&1; rc=$?
check "--keep=0 is refused" "[ $rc != 0 ]"
bash "$S" --dir="$B" --keep=-1 --delete >/dev/null 2>&1; rc=$?
check "--keep=-1 is refused" "[ $rc != 0 ]"
bash "$S" --dir="$B" --older-than=abc --delete >/dev/null 2>&1; rc=$?
check "--older-than=abc is refused" "[ $rc != 0 ]"
bash "$S" --dir="$B/missing" --delete >/dev/null 2>&1; rc=$?
check "a missing directory is refused" "[ $rc != 0 ]"
bash "$S" --dir="$B" --bogus --delete >/dev/null 2>&1; rc=$?
check "an unknown option is refused" "[ $rc != 0 ]"
check "and none of them touched a file" "[ \"\$(listing)\" = \"$before\" ]"

echo "== an empty directory"
rm -rf "$B"; mkdir -p "$B"
out="$(bash "$S" --dir="$B" 2>&1)"; rc=$?
check "exit 0" "[ $rc = 0 ]"
check "says there is nothing to do" "grep -q 'Nothing to do' <<<\"\$out\""

echo "== --help"
out="$(bash "$S" --help 2>&1)"; rc=$?
check "exit 0" "[ $rc = 0 ]"
check "shows the usage, not the code" "grep -q -- '--older-than=N' <<<\"\$out\" && ! grep -q 'set -euo' <<<\"\$out\""

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
