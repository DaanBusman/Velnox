#!/usr/bin/env bash
#
# Verify "older jobs out of sight" (0.7.16) against a running stack.
#
#   VELNOX_ADMIN_EMAIL=... VELNOX_ADMIN_PASSWORD=... bash scripts/verify-jobs-history.sh
#
# Makes a customer tenant with four jobs in it: one that finished forty days
# ago, one that finished yesterday, one still running after forty days and one
# cancelled forty days ago without ever starting. Signs in five accounts: an MSP
# Super Administrator, an MSP Administrator, an MSP Engineer, the customer's
# Tenant Administrator, and an MSP account whose only role is a custom one with
# jobs.history. Proves:
#
#   - nothing is hidden until the MSP Super Administrator sets a period, and only
#     system.manage may set it; out-of-range values are refused;
#   - with thirty days set, the Engineer and the customer no longer see the two
#     old finished jobs: not in the list, not by id, not their logs or events,
#     not in a support-log export — while the running one stays in sight;
#   - the Super Administrator, the MSP Administrator and the custom role still
#     see every job, and the rows are all still in the database;
#   - a role customers may be given cannot hold jobs.history; a change is in the
#     audit log with the old and the new value; and clearing the period brings
#     every job back.
#
# Puts the period back as it found it. Needs: a running stack, curl, node, docker.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_NATIVE="$(cd "$ROOT" && { pwd -W 2>/dev/null || pwd; })"
COMPOSE=(docker compose -f "$ROOT_NATIVE/deploy/compose/docker-compose.yml" --env-file "$ROOT_NATIVE/.env")
psql_at() { "${COMPOSE[@]}" exec -T postgres psql -U velnox -d velnox -v ON_ERROR_STOP=1 -Atc "$1"; }
BASE="${1:-https://localhost}"
RUN="vh$(date +%s)"

PASS=0
FAIL=0
green() { printf '\033[0;32m  ok  \033[0m %s\n' "$*"; }
red() { printf '\033[0;31m FAIL \033[0m %s\n' "$*"; }
info() { printf '\033[0;36m----\033[0m %s\n' "$*"; }
check() {
  if [[ "$2" == "$3" ]]; then green "$1"; PASS=$((PASS + 1)); else red "$1 (expected $2, got $3)"; FAIL=$((FAIL + 1)); fi
}
contains() {
  if [[ "$3" == *"$2"* ]]; then green "$1"; PASS=$((PASS + 1)); else red "$1 (did not find '$2')"; FAIL=$((FAIL + 1)); fi
}
lacks() {
  if [[ "$3" != *"$2"* ]]; then green "$1"; PASS=$((PASS + 1)); else red "$1 (found '$2')"; FAIL=$((FAIL + 1)); fi
}

for tool in node curl docker; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Needs ${tool}." >&2; exit 1; }
done
[[ -n "${VELNOX_ADMIN_EMAIL:-}" && -n "${VELNOX_ADMIN_PASSWORD:-}" ]] ||
  { echo "Provide an MSP Super Administrator: VELNOX_ADMIN_EMAIL=... VELNOX_ADMIN_PASSWORD=... $0" >&2; exit 2; }

json() {
  node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        let value = JSON.parse(raw);
        for (const key of process.argv[1].split(".")) value = value?.[key];
        if (value !== undefined && value !== null) process.stdout.write(typeof value === "object" ? JSON.stringify(value) : String(value));
      } catch { /* no output is the answer */ }
    });
  ' "$1" 2>/dev/null
}
pick() { # js expression over the JSON on stdin, as `d`
  node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{try{const d=JSON.parse(r);const v=eval(process.argv[1]);process.stdout.write(typeof v==="object"?JSON.stringify(v):String(v))}catch(e){}})' "$1"
}
body() { node -e 'const e = process.env; process.stdout.write(JSON.stringify(eval("(" + process.argv[1] + ")")))' "$1"; }

JARS="$(mktemp -d)"
STATUS_FILE="${JARS}/status"
CREATED_USERS=()
JOB_IDS=()
BEFORE=""

call() { # who method path [body]
  local who="$1" method="$2" path="$3" data="${4:-}" jar="${JARS}/${1}.jar" csrf=""
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
role_id() { call admin GET /api/v1/roles | K="$1" pick '(d.roles.find(r=>r.key===process.env.K)||{}).id'; }
make_user() { # who tenant roleId scopeType [scopeId] → status of the sign-in
  local who="$1" tenant="$2" role="$3" scope="$4" scope_id="${5:-}" id
  id="$(call admin POST /api/v1/users "$(E="${RUN}-${who}@example.invalid" T="$tenant" P="$PASSWORD" body '{ email: e.E, displayName: "Jobs history verification", password: e.P, tenantId: e.T }')" | json id)"
  [[ -n "$id" ]] || { red "could not make ${who}"; return 1; }
  CREATED_USERS+=("$id")
  if [[ -n "$scope_id" ]]; then
    call admin POST "/api/v1/users/${id}/role-assignments" "$(R="$role" S="$scope" I="$scope_id" body '{ roleId: e.R, scopeType: e.S, scopeId: e.I }')" >/dev/null
  else
    call admin POST "/api/v1/users/${id}/role-assignments" "$(R="$role" S="$scope" body '{ roleId: e.R, scopeType: e.S }')" >/dev/null
  fi
  sign_in "$who" "${RUN}-${who}@example.invalid" "$PASSWORD"
}
visible_ids() { # who → the ids of this run's jobs in the list, in a fixed order
  call "$1" GET "/api/v1/jobs?type=verify.jobs_history&tenantId=${TENANT}&limit=200" |
    IDS="${JOB_IDS[*]}" pick 'd.jobs.map(j=>j.id).filter(id=>process.env.IDS.split(" ").includes(id)).sort().join(" ")'
}
expect_ids() { printf '%s\n' "$@" | sort | tr '\n' ' ' | sed 's/ $//'; }
set_period() { call admin PUT /api/v1/jobs/visibility "$1" | json visibleDays; }

# shellcheck disable=SC2329  # called by the EXIT trap below
cleanup() {
  if [[ -n "$BEFORE" ]]; then
    psql_at "UPDATE system_settings SET jobs_visible_days = ${BEFORE} WHERE id = 1;" >/dev/null 2>&1
  fi
  for job in "${JOB_IDS[@]}"; do psql_at "DELETE FROM jobs WHERE id = '${job}';" >/dev/null 2>&1; done
  for user in "${CREATED_USERS[@]}"; do
    psql_at "UPDATE users SET status = 'DISABLED' WHERE id = '${user}';" >/dev/null 2>&1
  done
  rm -rf "$JARS"
}
trap cleanup EXIT

PASSWORD="Vx-${RUN}-$(node -e 'process.stdout.write(require("crypto").randomBytes(9).toString("hex"))')"

# ---------------------------------------------------------------------------
info "Who is looking, and at what."
# ---------------------------------------------------------------------------

check "admin: signs in" 200 "$(sign_in admin "$VELNOX_ADMIN_EMAIL" "$VELNOX_ADMIN_PASSWORD")"
unset VELNOX_ADMIN_PASSWORD
BEFORE="$(psql_at "SELECT coalesce(jobs_visible_days::text, 'NULL') FROM system_settings WHERE id = 1;")"
psql_at "UPDATE system_settings SET jobs_visible_days = NULL WHERE id = 1;" >/dev/null

MSP="$(psql_at "SELECT id FROM tenants WHERE kind = 'MSP_ROOT';")"
TENANT="$(call admin POST /api/v1/tenants "$(N="${RUN} Customer" body '{ name: e.N }')" | json id)"
check "a customer tenant" 201 "$(last_status)"

ROLES="$(call admin GET /api/v1/roles)"
holders() { printf '%s' "$ROLES" | pick 'd.roles.filter(r=>r.isSystem&&r.permissions.includes("jobs.history")).map(r=>r.key).sort().join(",")'; }
check "jobs.history: the MSP Super Administrator and the MSP Administrator, no other system role" \
  "msp_administrator,msp_super_administrator" "$(holders)"
check "jobs.history: in the role editor's catalogue, under Jobs" yes \
  "$(printf '%s' "$ROLES" | pick 'JSON.stringify(d.catalogue).includes("jobs.history")?"yes":"no"')"

CUSTOM="$(call admin POST /api/v1/roles "$(N="${RUN} Job historian" body '{ name: e.N, mspOnly: true, permissions: ["jobs.history", "jobs.read"] }')" | json id)"
check "a custom MSP role may hold jobs.history" 201 "$(last_status)"
check "a role customers may be given may not" 400 \
  "$(status admin POST /api/v1/roles "$(N="${RUN} Customer historian" body '{ name: e.N, mspOnly: false, permissions: ["jobs.history"] }')")"

check "mspadmin: signs in" 200 "$(make_user mspadmin "$MSP" "$(role_id msp_administrator)" GLOBAL)"
check "engineer: signs in" 200 "$(make_user engineer "$MSP" "$(role_id msp_engineer)" GLOBAL)"
check "customer: signs in" 200 "$(make_user customer "$TENANT" "$(role_id tenant_administrator)" TENANT "$TENANT")"
check "historian: signs in" 200 "$(make_user historian "$MSP" "$CUSTOM" GLOBAL)"

# Four jobs, written straight into the database: their age is the point, and
# no job type takes forty days.
job() { # status queued-days-ago finished-days-ago|null → id
  local id finished
  id="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
  [[ "$3" == null ]] && finished=NULL || finished="now() - interval '$3 days'"
  psql_at "INSERT INTO jobs (id, tenant_id, type, status, queued_at, started_at, finished_at, updated_at)
           VALUES ('${id}', '${TENANT}', 'verify.jobs_history', '$1', now() - interval '$2 days',
                   CASE WHEN '$1' = 'CANCELLED' THEN NULL ELSE now() - interval '$2 days' END, ${finished}, now());" >/dev/null
  printf '%s' "$id"
}
OLD="$(job SUCCEEDED 45 40)"
NEW="$(job FAILED 2 1)"
RUNNING="$(job RUNNING 40 null)"
NEVER="$(job CANCELLED 40 null)"
JOB_IDS=("$OLD" "$NEW" "$RUNNING" "$NEVER")
psql_at "INSERT INTO job_logs (job_id, stream, at, content) VALUES ('${OLD}', 'STDOUT', now() - interval '40 days', '${RUN} old output');" >/dev/null
ALL="$(expect_ids "$OLD" "$NEW" "$RUNNING" "$NEVER")"
IN_SIGHT="$(expect_ids "$NEW" "$RUNNING")"

# ---------------------------------------------------------------------------
info "Nothing hidden until a period is set."
# ---------------------------------------------------------------------------

check "engineer: every job, before" "$ALL" "$(visible_ids engineer)"
check "engineer: reads the setting: nothing hidden, and it applies to them" "null false 3650" \
  "$(call engineer GET /api/v1/jobs/visibility | pick '[d.visibleDays,d.seesAll,d.maxDays].map(String).join(" ")')"

# ---------------------------------------------------------------------------
info "Only system.manage sets it."
# ---------------------------------------------------------------------------

check "mspadmin: may not set it" 403 "$(status mspadmin PUT /api/v1/jobs/visibility '{"visibleDays":30}')"
check "engineer: may not set it" 403 "$(status engineer PUT /api/v1/jobs/visibility '{"visibleDays":30}')"
check "customer: may not set it" 403 "$(status customer PUT /api/v1/jobs/visibility '{"visibleDays":30}')"
check "historian: may not set it" 403 "$(status historian PUT /api/v1/jobs/visibility '{"visibleDays":30}')"
check "refused: zero days" 400 "$(status admin PUT /api/v1/jobs/visibility '{"visibleDays":0}')"
check "refused: more than ten years" 400 "$(status admin PUT /api/v1/jobs/visibility '{"visibleDays":3651}')"
check "refused: half a day" 400 "$(status admin PUT /api/v1/jobs/visibility '{"visibleDays":0.5}')"
check "admin: sets thirty days" 30 "$(set_period '{"visibleDays":30}')"
check "audit: recorded, with the old and the new value" "null 30" \
  "$(psql_at "SELECT coalesce(metadata->>'from','null') || ' ' || (metadata->>'to') FROM audit_events WHERE action = 'jobs.visibility_changed' ORDER BY at DESC LIMIT 1;")"

# ---------------------------------------------------------------------------
info "Out of sight for whoever lacks jobs.history."
# ---------------------------------------------------------------------------

for who in engineer customer; do
  check "${who}: the list keeps the recent and the running one only" "$IN_SIGHT" "$(visible_ids "$who")"
  check "${who}: the old job by id reads as not found" 404 "$(status "$who" GET "/api/v1/jobs/${OLD}")"
  check "${who}: so do its logs" 404 "$(status "$who" GET "/api/v1/jobs/${OLD}/logs")"
  check "${who}: and its events" 404 "$(status "$who" GET "/api/v1/jobs/${OLD}/events")"
  check "${who}: the one cancelled before it started too" 404 "$(status "$who" GET "/api/v1/jobs/${NEVER}")"
  check "${who}: the running one, forty days old, still opens" 200 "$(status "$who" GET "/api/v1/jobs/${RUNNING}")"
  check "${who}: the recent one opens" 200 "$(status "$who" GET "/api/v1/jobs/${NEW}")"
  check "${who}: told, and told it applies to them" "30 false" \
    "$(call "$who" GET /api/v1/jobs/visibility | pick '[d.visibleDays,d.seesAll].map(String).join(" ")')"
done

FROM="$(node -e 'process.stdout.write(new Date(Date.now() - 60 * 86400e3).toISOString())')"
EXPORT="$(call customer GET "/api/v1/support/export?tenantId=${TENANT}&from=${FROM}")"
check "customer: exports the support logs" 200 "$(last_status)"
lacks "customer: the export leaves out the old job" "$OLD" "$EXPORT"
contains "customer: and keeps the recent one" "$NEW" "$EXPORT"
EXPORT="$(call admin GET "/api/v1/support/export?tenantId=${TENANT}&from=${FROM}")"
contains "admin: the same export holds the old job" "$OLD" "$EXPORT"

# ---------------------------------------------------------------------------
info "In sight for jobs.history, and nothing deleted."
# ---------------------------------------------------------------------------

for who in admin mspadmin historian; do
  check "${who}: every job" "$ALL" "$(visible_ids "$who")"
  check "${who}: the old job opens" 200 "$(status "$who" GET "/api/v1/jobs/${OLD}")"
  check "${who}: told the period does not apply to them" "30 true" \
    "$(call "$who" GET /api/v1/jobs/visibility | pick '[d.visibleDays,d.seesAll].map(String).join(" ")')"
done
check "database: all four jobs are still there" 4 \
  "$(psql_at "SELECT count(*) FROM jobs WHERE tenant_id = '${TENANT}' AND type = 'verify.jobs_history';")"

# ---------------------------------------------------------------------------
info "Cleared, everything is back."
# ---------------------------------------------------------------------------

check "admin: clears the period" "" "$(set_period '{"visibleDays":null}')"
check "admin: cleared" 200 "$(last_status)"
check "engineer: every job again" "$ALL" "$(visible_ids engineer)"
check "customer: the old job opens again" 200 "$(status customer GET "/api/v1/jobs/${OLD}")"

echo
if [[ "$FAIL" -eq 0 ]]; then
  printf '\033[0;32m%d checks passed.\033[0m\n' "$PASS"
else
  printf '\033[0;31m%d passed, %d failed.\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi
