#!/usr/bin/env bash
#
# Verify the update check (0.7.21, ADR-060) against a running stack.
#
#   VELNOX_ADMIN_EMAIL=... VELNOX_ADMIN_PASSWORD=... bash scripts/verify-velnox-release.sh
#
# Proves, with an MSP Super Administrator and an MSP Engineer:
#
#   - only system.manage reads the status, switches the check, or checks now;
#   - a newer version is reported with the advisories that concern the running
#     version — critical first — and not the ones fixed in it, introduced after
#     it, or fixed only in a version not yet on offer;
#   - the same version is up to date; a read that failed is "could not check",
#     never up to date; a check that is off reports nothing newer;
#   - switching it is audited both ways; Check now reads the real file through
#     the worker while the check is off; and the worker checks by itself when
#     it starts, once the check is on and due.
#
# Puts the update check back as it found it. Needs: a running stack, curl, node, docker.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_NATIVE="$(cd "$ROOT" && { pwd -W 2>/dev/null || pwd; })"
COMPOSE=(docker compose -f "$ROOT_NATIVE/deploy/compose/docker-compose.yml" --env-file "$ROOT_NATIVE/.env")
psql_at() { "${COMPOSE[@]}" exec -T postgres psql -U velnox -d velnox -v ON_ERROR_STOP=1 -Atc "$1"; }
BASE="${1:-https://localhost}"
RUN="vr$(date +%s)"

PASS=0
FAIL=0
green() { printf '\033[0;32m  ok  \033[0m %s\n' "$*"; }
red() { printf '\033[0;31m FAIL \033[0m %s\n' "$*"; }
info() { printf '\033[0;36m----\033[0m %s\n' "$*"; }
check() {
  if [[ "$2" == "$3" ]]; then green "$1"; PASS=$((PASS + 1)); else red "$1 (expected $2, got $3)"; FAIL=$((FAIL + 1)); fi
}

for tool in node curl docker; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Needs ${tool}." >&2; exit 1; }
done
[[ -n "${VELNOX_ADMIN_EMAIL:-}" && -n "${VELNOX_ADMIN_PASSWORD:-}" ]] ||
  { echo "Provide an MSP Super Administrator: VELNOX_ADMIN_EMAIL=... VELNOX_ADMIN_PASSWORD=... $0" >&2; exit 2; }

pick() { # js expression over the JSON on stdin, as `d`
  node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{try{const d=JSON.parse(r);const v=eval(process.argv[1]);if(v!==undefined&&v!==null)process.stdout.write(typeof v==="object"?JSON.stringify(v):String(v))}catch(e){}})' "$1"
}
body() { node -e 'const e = process.env; process.stdout.write(JSON.stringify(eval("(" + process.argv[1] + ")")))' "$1"; }

JARS="$(mktemp -d)"
STATUS_FILE="${JARS}/status"
CREATED_USERS=()
SAVED=""

call() { # who method path [body]
  local who="$1" method="$2" path="$3" data="${4:-}"
  local jar="${JARS}/${who}.jar" csrf=""
  [[ -f "$jar" ]] && csrf="$(awk '$6 == "velnox_csrf" { print $7 }' "$jar" | tail -1)"
  local args=(--silent --insecure --max-time 60 --cookie "$jar" --cookie-jar "$jar"
    --request "$method" --header 'accept: application/json'
    --output "${JARS}/body" --write-out '%{http_code}')
  [[ -n "$csrf" ]] && args+=(--header "x-velnox-csrf: ${csrf}")
  [[ -n "$data" ]] && args+=(--header 'content-type: application/json' --data "$data")
  curl "${args[@]}" "${BASE}${path}" >"$STATUS_FILE"
  cat "${JARS}/body"
}
last_status() { cat "$STATUS_FILE"; }
status() { call "$@" >/dev/null; last_status; }
sign_in() { # who email password → status
  rm -f "${JARS}/${1}.jar"
  call "$1" POST /api/v1/auth/login "$(E="$2" P="$3" body '{ email: e.E, password: e.P }')" >/dev/null
  last_status
}

COLUMNS_SQL="update_check_enabled, update_manifest, update_checked_at, update_succeeded_at, update_check_error, update_check_error_detail"

# shellcheck disable=SC2329  # called by the EXIT trap below
cleanup() {
  if [[ -n "$SAVED" ]]; then
    psql_at "UPDATE system_settings SET (${COLUMNS_SQL}) = (SELECT ${COLUMNS_SQL} FROM json_populate_record(NULL::system_settings, '${SAVED//\'/\'\'}'::json)) WHERE id = 1;" >/dev/null 2>&1
  fi
  for user in "${CREATED_USERS[@]}"; do
    psql_at "UPDATE users SET status = 'DISABLED' WHERE id = '${user}';" >/dev/null 2>&1
  done
  rm -rf "$JARS"
}
trap cleanup EXIT

# What the stored answer says, written straight into the row: the version on
# offer and its advisories are the point, and GitHub's file says what it says.
plant() { # manifest-json error succeeded(now|null)
  local manifest="$1" error="${2:-}" succeeded="${3:-now}"
  local m="NULL" e="NULL" s="NULL"
  [[ -n "$manifest" ]] && m="'${manifest//\'/\'\'}'::jsonb"
  [[ -n "$error" ]] && e="'${error}'"
  [[ "$succeeded" == now ]] && s="now()"
  psql_at "UPDATE system_settings SET update_check_enabled = true, update_manifest = ${m}, update_checked_at = now(), update_succeeded_at = ${s}, update_check_error = ${e}, update_check_error_detail = CASE WHEN ${e} IS NULL THEN NULL ELSE 'planted by the harness' END WHERE id = 1;" >/dev/null
}
update_status() { call "$1" GET /api/v1/system/update; }

PASSWORD="Vx-${RUN}-$(node -e 'process.stdout.write(require("crypto").randomBytes(9).toString("hex"))')"

# ---------------------------------------------------------------------------
info "Who may look."
# ---------------------------------------------------------------------------

check "admin: signs in" 200 "$(sign_in admin "$VELNOX_ADMIN_EMAIL" "$VELNOX_ADMIN_PASSWORD")"
unset VELNOX_ADMIN_PASSWORD
SAVED="$(psql_at "SELECT row_to_json(s) FROM (SELECT ${COLUMNS_SQL} FROM system_settings WHERE id = 1) s;")"

MSP="$(psql_at "SELECT id FROM tenants WHERE kind = 'MSP_ROOT';")"
ENGINEER_ROLE="$(call admin GET /api/v1/roles | pick '(d.roles.find(r=>r.key==="msp_engineer")||{}).id')"
ENGINEER="$(call admin POST /api/v1/users "$(E="${RUN}-engineer@example.invalid" T="$MSP" P="$PASSWORD" body '{ email: e.E, displayName: "Update check verification", password: e.P, tenantId: e.T }')" | pick 'd.id')"
[[ -n "$ENGINEER" ]] && CREATED_USERS+=("$ENGINEER")
call admin POST "/api/v1/users/${ENGINEER}/role-assignments" "$(R="$ENGINEER_ROLE" body '{ roleId: e.R, scopeType: "GLOBAL" }')" >/dev/null
check "engineer: signs in" 200 "$(sign_in engineer "${RUN}-engineer@example.invalid" "$PASSWORD")"

RUNNING="$(call admin GET /api/v1/system/info | pick 'd.version')"
STATUS="$(update_status admin)"
check "admin: reads the status" 200 "$(last_status)"
check "it names the running version" "$RUNNING" "$(printf '%s' "$STATUS" | pick 'd.running')"
check "and where it reads" "https://raw.githubusercontent.com/DaanBusman/Velnox/main/release.json" "$(printf '%s' "$STATUS" | pick 'd.source')"
check "engineer: may not read it" 403 "$(status engineer GET /api/v1/system/update)"
check "engineer: may not switch it" 403 "$(status engineer PUT /api/v1/system/update '{"enabled":false}')"
check "engineer: may not check now" 403 "$(status engineer POST /api/v1/system/update/check)"

# ---------------------------------------------------------------------------
info "What a stored answer means for the running version."
# ---------------------------------------------------------------------------

T='{"en":"A fix","nl":"Een oplossing"}'
plant "{\"version\":\"9.9.9\",\"advisories\":[
  {\"id\":\"VELNOX-T-IMPORTANT\",\"severity\":\"important\",\"fixedIn\":\"9.9.0\",\"title\":${T}},
  {\"id\":\"VELNOX-T-CRITICAL\",\"severity\":\"critical\",\"fixedIn\":\"9.9.9\",\"title\":${T},\"url\":\"https://example.invalid/advisory\"},
  {\"id\":\"VELNOX-T-ALREADY\",\"severity\":\"critical\",\"fixedIn\":\"${RUNNING}\",\"title\":${T}},
  {\"id\":\"VELNOX-T-LATER\",\"severity\":\"critical\",\"fixedIn\":\"9.9.9\",\"introducedIn\":\"9.9.5\",\"title\":${T}},
  {\"id\":\"VELNOX-T-UNRELEASED\",\"severity\":\"critical\",\"fixedIn\":\"10.0.0\",\"title\":${T}}]}"
STATUS="$(update_status admin)"
check "newer: an update is available" true "$(printf '%s' "$STATUS" | pick 'd.updateAvailable')"
check "newer: which version" 9.9.9 "$(printf '%s' "$STATUS" | pick 'd.latest')"
check "newer: it is critical" true "$(printf '%s' "$STATUS" | pick 'd.critical')"
check "newer: only the advisories that concern this version, critical first" \
  "VELNOX-T-CRITICAL,VELNOX-T-IMPORTANT" "$(printf '%s' "$STATUS" | pick 'd.advisories.map(a=>a.id).join(",")')"

plant "{\"version\":\"9.9.9\",\"advisories\":[{\"id\":\"VELNOX-T-IMPORTANT\",\"severity\":\"important\",\"fixedIn\":\"9.9.0\",\"title\":${T}}]}"
STATUS="$(update_status admin)"
check "important only: available, not critical" "true false" "$(printf '%s' "$STATUS" | pick '[d.updateAvailable,d.critical].join(" ")')"

plant "{\"version\":\"${RUNNING}\",\"advisories\":[]}"
STATUS="$(update_status admin)"
check "same version: up to date" "false false null" "$(printf '%s' "$STATUS" | pick '[d.updateAvailable,d.critical,String(d.error)].join(" ")')"

plant "" network null
STATUS="$(update_status admin)"
check "no answer yet: says it could not check" network "$(printf '%s' "$STATUS" | pick 'd.error')"
check "and claims nothing newer" false "$(printf '%s' "$STATUS" | pick 'd.updateAvailable')"
check "and no answer to fall back on" "" "$(printf '%s' "$STATUS" | pick 'd.succeededAt')"

plant "{\"version\":\"9.9.9\",\"advisories\":[]}" timeout now
STATUS="$(update_status admin)"
check "a failed read keeps the last good answer" "9.9.9 timeout" "$(printf '%s' "$STATUS" | pick '[d.latest,d.error].join(" ")')"

plant "{\"version\":\"<script>\",\"advisories\":[]}"
check "a stored answer that is not a release file is ignored" "false" "$(update_status admin | pick 'String(d.updateAvailable)+(d.latest?" "+d.latest:"")')"

# ---------------------------------------------------------------------------
info "Switching it off and on, and Check now."
# ---------------------------------------------------------------------------

plant "{\"version\":\"9.9.9\",\"advisories\":[]}"
OFF="$(call admin PUT /api/v1/system/update '{"enabled":false}')"
check "off: switched" "200 false" "$(last_status) $(printf '%s' "$OFF" | pick 'String(d.enabled)')"
check "off: reports nothing newer" false "$(printf '%s' "$OFF" | pick 'd.updateAvailable')"
check "off: audited" 1 "$(psql_at "SELECT count(*) FROM audit_events WHERE action = 'system.update_check_changed' AND actor_label = '${VELNOX_ADMIN_EMAIL}' AND metadata->>'enabled' = 'false' AND at > now() - interval '1 minute';")"

BEFORE_CHECK="$(psql_at "SELECT update_checked_at FROM system_settings WHERE id = 1;")"
NOW="$(call admin POST /api/v1/system/update/check)"
check "check now: answered while the check is off" 200 "$(last_status)"
check "check now: the worker read" yes "$(psql_at "SELECT CASE WHEN update_checked_at > '${BEFORE_CHECK}'::timestamptz THEN 'yes' ELSE 'no' END FROM system_settings WHERE id = 1;")"
GITHUB="$(printf '%s' "$NOW" | pick 'd.error ? "error " + d.error + " (" + d.errorDetail + ")" : "latest " + d.latest')"
info "GitHub's release.json said: ${GITHUB}"
check "check now: an answer or a named reason, nothing else" yes \
  "$(printf '%s' "$NOW" | pick '(d.error===null&&/^\d+\.\d+\.\d+/.test(d.latest))||["network","timeout","http","too_large","invalid"].includes(d.error)?"yes":"no"')"

ON="$(call admin PUT /api/v1/system/update '{"enabled":true}')"
check "on: switched" "200 true" "$(last_status) $(printf '%s' "$ON" | pick 'String(d.enabled)')"
check "on: audited" 1 "$(psql_at "SELECT count(*) FROM audit_events WHERE action = 'system.update_check_changed' AND actor_label = '${VELNOX_ADMIN_EMAIL}' AND metadata->>'enabled' = 'true' AND at > now() - interval '1 minute';")"
check "on: the last attempt is forgotten, so a check is due" "" "$(printf '%s' "$ON" | pick 'd.checkedAt')"
call admin PUT /api/v1/system/update '{"enabled":true}' >/dev/null
check "on again: no second audit event for no change" 1 "$(psql_at "SELECT count(*) FROM audit_events WHERE action = 'system.update_check_changed' AND actor_label = '${VELNOX_ADMIN_EMAIL}' AND metadata->>'enabled' = 'true' AND at > now() - interval '1 minute';")"

info "The worker, restarted, checks by itself once a check is due."
"${COMPOSE[@]}" restart worker >/dev/null 2>&1
CHECKED=""
for _ in $(seq 1 90); do
  CHECKED="$(psql_at "SELECT CASE WHEN update_checked_at IS NULL THEN '' ELSE 'checked' END FROM system_settings WHERE id = 1;")"
  [[ -n "$CHECKED" ]] && break
  sleep 1
done
check "worker: checked at start-up" checked "$CHECKED"
STAMP="$(psql_at "SELECT update_checked_at FROM system_settings WHERE id = 1;")"
"${COMPOSE[@]}" restart worker >/dev/null 2>&1
sleep 20
check "worker: and not again on the next start, within six hours" "$STAMP" "$(psql_at "SELECT update_checked_at FROM system_settings WHERE id = 1;")"

echo
if ((FAIL == 0)); then
  printf '\033[0;32m%d checks passed.\033[0m\n' "$PASS"
else
  printf '\033[0;31m%d passed, %d failed.\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi
