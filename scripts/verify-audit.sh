#!/usr/bin/env bash
#
# Verify the audit log's export, its tenant scope and per-tenant retention
# against a running stack.
#
#   bash scripts/verify-audit.sh
#   VELNOX_ADMIN_EMAIL=... VELNOX_ADMIN_PASSWORD=... bash scripts/verify-audit.sh
#
# With no administrator given, a throwaway MSP Super Administrator is created for
# the run and disabled at the end. Two customer tenants are created, each with a
# throwaway administrator, and are archived and disabled at the end.
#
# **It restarts the worker once**, because the retention sweep runs when the
# worker starts; jobs in flight are handled as any worker restart handles them.
# To prove a removal it writes one event dated two years back into a tenant made
# for the run — the only rows it removes are that tenant's.
#
# Needs: a running stack built from this tree, node, curl, docker.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_NATIVE="$(cd "$ROOT" && { pwd -W 2>/dev/null || pwd; })"
BASE="${1:-https://localhost}"
RUN="va$(date +%s)"
COMPOSE=(docker compose -f "$ROOT_NATIVE/deploy/compose/docker-compose.yml" --env-file "$ROOT_NATIVE/.env")

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
body() { node -e 'const e = process.env; process.stdout.write(JSON.stringify(eval("(" + process.argv[1] + ")")))' "$1"; }
psql_at() { "${COMPOSE[@]}" exec -T postgres psql -U velnox -d velnox -v ON_ERROR_STOP=1 -Atc "$1"; }

WORK="$(mktemp -d)"
STATUS_FILE="$WORK/status"
JAR="$WORK/admin-cookies"
CREATED_USERS=()
CREATED_TENANTS=()

call() {
  local method="$1" path="$2" data="${3:-}"
  local csrf=""
  [[ -f "$JAR" ]] && csrf="$(awk '$6 == "velnox_csrf" { print $7 }' "$JAR" | tail -1)"
  local args=(--silent --insecure --max-time 120 --cookie "$JAR" --cookie-jar "$JAR"
    --request "$method" --header 'accept: application/json'
    --output "$WORK/body" --write-out '%{http_code}')
  [[ -n "$csrf" ]] && args+=(--header "x-velnox-csrf: ${csrf}")
  [[ -n "$data" ]] && args+=(--header 'content-type: application/json' --data "$data")
  curl "${args[@]}" "${BASE}${path}" >"$STATUS_FILE"
  cat "$WORK/body"
}
as() { local saved="$JAR"; JAR="$1"; shift; "$@"; local rc=$?; JAR="$saved"; return $rc; }
last_status() { cat "$STATUS_FILE"; }

make_user() { # tenant role label → id
  local tenant="$1" role="$2" label="$3" pw hash id
  pw="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')"
  printf '%s' "$pw" >"$WORK/pw-${label}"
  hash="$(P="$pw" node -e 'require(process.argv[1]).hashPassword(process.env.P).then((h) => process.stdout.write(h));' "$ROOT/packages/crypto/dist/index.js")"
  [[ "$hash" == \$argon2id\$* ]] || { red "could not hash a password (is @velnox/crypto built?)"; exit 1; }
  id="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
  psql_at "INSERT INTO users (id, tenant_id, email, display_name, password_hash, updated_at)
           VALUES ('${id}', '${tenant}', '${RUN}-${label}@example.invalid', 'Audit verification', '${hash}', now());" >/dev/null
  psql_at "INSERT INTO role_assignments (id, user_id, role_id, scope_type, scope_id, tenant_id)
           SELECT gen_random_uuid(), '${id}', r.id,
                  CASE WHEN '${role}' LIKE 'msp_%' THEN 'GLOBAL'::scope_type ELSE 'TENANT'::scope_type END,
                  CASE WHEN '${role}' LIKE 'msp_%' THEN NULL ELSE '${tenant}'::uuid END,
                  CASE WHEN '${role}' LIKE 'msp_%' THEN NULL ELSE '${tenant}'::uuid END
           FROM roles r WHERE r.key = '${role}';" >/dev/null
  CREATED_USERS+=("$id")
  printf '%s' "$id"
}
login() { # jar label
  local saved="$JAR"; JAR="$1"
  call POST /api/v1/auth/login "$(E="${RUN}-$2@example.invalid" P="$(cat "$WORK/pw-$2")" body '{ email: e.E, password: e.P }')" >/dev/null
  local status; status="$(last_status)"
  JAR="$saved"
  printf '%s' "$status"
}

cleanup() {
  for user in "${CREATED_USERS[@]}"; do
    psql_at "UPDATE users SET status = 'DISABLED' WHERE id = '${user}';" >/dev/null 2>&1
  done
  for tenant in "${CREATED_TENANTS[@]}"; do
    psql_at "UPDATE tenants SET status = 'ARCHIVED', audit_retention_days = NULL WHERE id = '${tenant}';" >/dev/null 2>&1
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------

MSP="$(psql_at "SELECT id FROM tenants WHERE kind = 'MSP_ROOT';")"
if [[ -n "${VELNOX_ADMIN_EMAIL:-}" && -n "${VELNOX_ADMIN_PASSWORD:-}" ]]; then
  call POST /api/v1/auth/login "$(body '{ email: e.VELNOX_ADMIN_EMAIL, password: e.VELNOX_ADMIN_PASSWORD }')" >/dev/null
  check "admin: signs in" 200 "$(last_status)"
else
  make_user "$MSP" msp_super_administrator admin >/dev/null
  check "admin: signs in" 200 "$(login "$JAR" admin)"
fi
unset VELNOX_ADMIN_PASSWORD

A_ID="$(call POST /api/v1/tenants "$(R="$RUN" body '{ name: "Audit A " + e.R }')" | json id)"
B_ID="$(call POST /api/v1/tenants "$(R="$RUN" body '{ name: "Audit B " + e.R }')" | json id)"
[[ -n "$A_ID" && -n "$B_ID" ]] || { red "could not create two tenants"; exit 1; }
CREATED_TENANTS+=("$A_ID" "$B_ID")
make_user "$A_ID" tenant_administrator a >/dev/null
A_JAR="$WORK/a-cookies"
check "a customer administrator signs in" 200 "$(login "$A_JAR" a)"

# ---------------------------------------------------------------------------
info "The append-only rule still holds."

OLD_ID="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
psql_at "INSERT INTO audit_events (id, at, tenant_id, actor_type, actor_label, action, result, metadata)
         VALUES ('${OLD_ID}', now() - interval '730 days', '${A_ID}', 'SYSTEM', 'verify-audit', 'verify.old_event', 'SUCCESS', '{}');" >/dev/null
check "an event can be written" 1 "$(psql_at "SELECT count(*) FROM audit_events WHERE id = '${OLD_ID}';")"
psql_at "DELETE FROM audit_events WHERE id = '${OLD_ID}';" >/dev/null 2>&1
check "an ordinary DELETE is still refused" 1 "$(psql_at "SELECT count(*) FROM audit_events WHERE id = '${OLD_ID}';")"
psql_at "UPDATE audit_events SET action = 'x' WHERE id = '${OLD_ID}';" >/dev/null 2>&1
check "and so is an UPDATE" verify.old_event "$(psql_at "SELECT action FROM audit_events WHERE id = '${OLD_ID}';")"
psql_at "SELECT velnox_prune_audit_events('${A_ID}', false, now() - interval '30 days');" >/dev/null 2>&1
check "the prune function refuses anything younger than a year" 1 "$(psql_at "SELECT count(*) FROM audit_events WHERE id = '${OLD_ID}';")"

# ---------------------------------------------------------------------------
info "Retention is the MSP's to set."

as "$A_JAR" call PATCH "/api/v1/tenants/${A_ID}" '{"auditRetentionDays":365}' >/dev/null
check "a customer administrator cannot set their own tenant's retention" 403 "$(last_status)"
call PATCH "/api/v1/tenants/${A_ID}" '{"auditRetentionDays":100}' >/dev/null
check "a period that is not offered is refused" 400 "$(last_status)"
check "the MSP sets one year" 365 "$(call PATCH "/api/v1/tenants/${A_ID}" '{"auditRetentionDays":365}' | json auditRetentionDays)"
check "the change is recorded" 1 "$(psql_at "SELECT count(*) FROM audit_events WHERE action = 'tenant.updated' AND resource_id = '${A_ID}' AND metadata->>'auditRetentionDays' = '365';")"
psql_at "UPDATE tenants SET audit_retention_days = 100 WHERE id = '${A_ID}';" >/dev/null 2>&1
check "the database refuses less than a year as well" 365 "$(psql_at "SELECT audit_retention_days FROM tenants WHERE id = '${A_ID}';")"

# ---------------------------------------------------------------------------
info "The retention sweep."

NEW_ID="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
psql_at "INSERT INTO audit_events (id, at, tenant_id, actor_type, actor_label, action, result, metadata)
         VALUES ('${NEW_ID}', now() - interval '30 days', '${A_ID}', 'SYSTEM', 'verify-audit', 'verify.recent_event', 'SUCCESS', '{}');" >/dev/null
B_OLD="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
psql_at "INSERT INTO audit_events (id, at, tenant_id, actor_type, actor_label, action, result, metadata)
         VALUES ('${B_OLD}', now() - interval '730 days', '${B_ID}', 'SYSTEM', 'verify-audit', 'verify.old_event', 'SUCCESS', '{}');" >/dev/null
"${COMPOSE[@]}" restart worker >/dev/null 2>&1
for _ in $(seq 1 60); do
  [[ "$(psql_at "SELECT count(*) FROM audit_events WHERE action = 'audit.pruned' AND tenant_id = '${A_ID}';")" != 0 ]] && break
  sleep 2
done
check "the sweep removed the event past the tenant's retention" 0 "$(psql_at "SELECT count(*) FROM audit_events WHERE id = '${OLD_ID}';")"
check "and kept the one within it" 1 "$(psql_at "SELECT count(*) FROM audit_events WHERE id = '${NEW_ID}';")"
check "another tenant kept for ever keeps its old event" 1 "$(psql_at "SELECT count(*) FROM audit_events WHERE id = '${B_OLD}';")"
check "the removal is itself recorded, with the count" 1 "$(psql_at "SELECT metadata->>'removed' FROM audit_events WHERE action = 'audit.pruned' AND tenant_id = '${A_ID}';")"

# ---------------------------------------------------------------------------
info "Reading and exporting, in scope."

call GET "/api/v1/audit-events?tenantId=${B_ID}&limit=200" >"$WORK/b-list"
contains "the MSP can narrow the log to one tenant" "verify.old_event" "$(cat "$WORK/b-list")"
lacks "and sees only that tenant's events" "verify.recent_event" "$(cat "$WORK/b-list")"
A_LIST="$(as "$A_JAR" call GET "/api/v1/audit-events?tenantId=${B_ID}&limit=200")"
lacks "a customer asking for another tenant's log gets their own" "$B_OLD" "$A_LIST"
contains "their own" "verify.recent_event" "$A_LIST"

curl --silent --insecure --cookie "$JAR" --dump-header "$WORK/h" --output "$WORK/export.csv" \
  "${BASE}/api/v1/audit-events/export?format=csv&tenantId=${A_ID}"
contains "the export downloads as a file" "attachment; filename=\"velnox-audit-" "$(cat "$WORK/h")"
check "as CSV with a header row" "at,tenant,action,result,actor_type,actor,resource_type,resource_id,resource,ip,request_id,metadata" "$(head -1 "$WORK/export.csv" | tr -d '\r\357\273\277')"
contains "holding the tenant's events" "verify.recent_event" "$(cat "$WORK/export.csv")"
lacks "and not another tenant's" "Audit B ${RUN}" "$(cat "$WORK/export.csv")"
check "the export is recorded, with its filters" 1 "$(psql_at "SELECT count(*) FROM audit_events WHERE action = 'audit.exported' AND metadata->>'tenantId' = '${A_ID}' AND metadata->>'format' = 'csv';")"
curl --silent --insecure --cookie "$A_JAR" --output "$WORK/a-export.jsonl" \
  "${BASE}/api/v1/audit-events/export?format=json&tenantId=${B_ID}"
lacks "a customer's export stays inside their own tenant" "$B_OLD" "$(cat "$WORK/a-export.jsonl")"
check "and is JSON, one event per line" ok "$(node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n");process.stdout.write(l.length>0&&l.every(x=>{try{return !!JSON.parse(x).action}catch{return false}})?"ok":"bad")' "$WORK/a-export.jsonl")"
curl --silent --insecure --output /dev/null --write-out '%{http_code}' "${BASE}/api/v1/audit-events/export" >"$STATUS_FILE"
check "nobody signed out can export" 401 "$(last_status)"

echo
if ((FAIL == 0)); then
  printf '\033[0;32m%d checks passed.\033[0m\n' "$PASS"
else
  printf '\033[0;31m%d passed, %d failed.\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi
