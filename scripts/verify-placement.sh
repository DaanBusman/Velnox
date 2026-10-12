#!/usr/bin/env bash
# shellcheck disable=SC2329  # helpers are called through wait_until and the EXIT trap
#
# Verify Phase 7B — placement rules and balancing — against a running stack.
#
#   bash scripts/verify-placement.sh
#   VELNOX_ADMIN_EMAIL=... VELNOX_ADMIN_PASSWORD=... bash scripts/verify-placement.sh
#
# With no administrator given, a throwaway MSP Super Administrator is created
# for the run and disabled at the end.
#
# Stands up the fixture Proxmox in its operations mode — three nodes, guests that
# move, node memory that follows them — first as PVE 8 and then as PVE 9 with
# Proxmox's HA rules. Proves Phase 7B's acceptance: two VMs kept apart are
# never put on one node, by a correction or by a rolling update emptying a
# node; a rule not met is reported and corrected by a migration job; on PVE 9
# the rule is one of Proxmox's own HA rules and outlasts Velnox being stopped;
# balancing moves nothing while the cluster is not whole.
#
# Needs: a running stack, node, openssl, ssh-keygen, curl, docker.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_NATIVE="$(cd "$ROOT" && { pwd -W 2>/dev/null || pwd; })"
BASE="${1:-https://localhost}"
RUN="vp$(date +%s)"
COMPOSE=(docker compose -f "$ROOT_NATIVE/deploy/compose/docker-compose.yml" --env-file "$ROOT_NATIVE/.env")
FIXTURE_NAME="velnox-fake-pve-${RUN}"
FIXTURE_HOST="fake-pve-ops"
SSH_PORT=2222
TOKEN_ID='root@pam!velnox'
TOKEN_SECRET='fixture-secret-0000-0000-000000000000'

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

for tool in node openssl ssh-keygen curl docker; do
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
# One node's row from /updates/nodes, by name.
node_row() {
  node -e '
    let r = ""; process.stdin.on("data", (c) => (r += c)).on("end", () => {
      const row = JSON.parse(r).find((n) => n.node === process.argv[1]) || {};
      process.stdout.write(JSON.stringify(row));
    });' "$1"
}

psql_at() { "${COMPOSE[@]}" exec -T postgres psql -U velnox -d velnox -v ON_ERROR_STOP=1 -Atc "$1"; }
in_fixture() { MSYS_NO_PATHCONV=1 docker exec "$FIXTURE_NAME" sh -c "$1"; }

WORK="$(mktemp -d)"
JAR="$WORK/cookies"
STATUS_FILE="$WORK/status"
CREATED_USERS=()
CLUSTER_ID=""
WINDOW_IDS=()

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
last_status() { cat "$STATUS_FILE"; }

job_field() { call GET "/api/v1/jobs/$1" | json "$2"; }
wait_for() {
  local id="$1" timeout="$2"
  shift 2
  local deadline=$((SECONDS + timeout)) status=""
  while ((SECONDS < deadline)); do
    status="$(job_field "$id" status)"
    for want in "$@"; do [[ "$status" == "$want" ]] && { printf '%s' "$status"; return 0; }; done
    sleep 1
  done
  printf '%s' "${status:-timeout}"
}
logs_of() { call GET "/api/v1/jobs/$1/logs" | json lines; }
nodes_now() { call GET "/api/v1/updates/nodes?clusterId=${CLUSTER_ID}"; }

make_user() { # tenant role label → id
  local tenant="$1" role="$2" label="$3" pw hash id
  pw="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')"
  printf '%s' "$pw" >"$WORK/pw-${label}"
  hash="$(P="$pw" node -e 'require(process.argv[1]).hashPassword(process.env.P).then((h) => process.stdout.write(h));' "$ROOT_NATIVE/packages/crypto/dist/index.js")"
  [[ "$hash" == \$argon2id\$* ]] || { red "could not hash a password (is @velnox/crypto built?)"; exit 1; }
  id="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
  psql_at "INSERT INTO users (id, tenant_id, email, display_name, password_hash, updated_at)
           VALUES ('${id}', '${tenant}', '${RUN}-${label}@example.invalid', 'Update verification', '${hash}', now());" >/dev/null
  psql_at "INSERT INTO role_assignments (id, user_id, role_id, scope_type, scope_id, tenant_id)
           SELECT gen_random_uuid(), '${id}', r.id,
                  CASE WHEN '${role}' LIKE 'msp_%' THEN 'GLOBAL'::scope_type ELSE 'TENANT'::scope_type END,
                  CASE WHEN '${role}' LIKE 'msp_%' THEN NULL ELSE '${tenant}'::uuid END,
                  CASE WHEN '${role}' LIKE 'msp_%' THEN NULL ELSE '${tenant}'::uuid END
           FROM roles r WHERE r.key = '${role}';" >/dev/null
  CREATED_USERS+=("$id")
}
login() { # jar label → status
  local saved="$JAR"; JAR="$1"
  call POST /api/v1/auth/login "$(E="${RUN}-$2@example.invalid" P="$(cat "$WORK/pw-$2")" body '{ email: e.E, password: e.P }')" >/dev/null
  local status; status="$(last_status)"
  JAR="$saved"
  printf '%s' "$status"
}

# shellcheck disable=SC2329  # called by the EXIT trap below
cleanup() {
  if ((FAIL > 0)); then
    info "Last lines from the fixture:"
    docker logs "$FIXTURE_NAME" 2>&1 | tail -30
  fi
  if [[ -n "$CLUSTER_ID" ]]; then
    local policy
    policy="$(call GET /api/v1/updates/policies 2>/dev/null | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{try{const p=JSON.parse(r).find(x=>x.clusterId===process.argv[1]);process.stdout.write(p?p.id:"")}catch{}})' "$CLUSTER_ID")"
    [[ -n "$policy" ]] && call DELETE "/api/v1/updates/policies/${policy}" >/dev/null 2>&1
    call DELETE "/api/v1/clusters/${CLUSTER_ID}" >/dev/null 2>&1
  fi
  for id in "${WINDOW_IDS[@]}"; do call DELETE "/api/v1/updates/windows/${id}" >/dev/null 2>&1; done
  docker rm -f "$FIXTURE_NAME" >/dev/null 2>&1 || true
  for user in "${CREATED_USERS[@]}"; do
    psql_at "UPDATE users SET status = 'DISABLED' WHERE id = '${user}';" >/dev/null 2>&1
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# The fixture: a cluster that changes
# ---------------------------------------------------------------------------

NETWORK="$(docker network ls --format '{{.Name}}' | grep -m1 'egress' || true)"
[[ -n "$NETWORK" ]] || { echo "Could not find the compose egress network. Is the stack running?" >&2; exit 1; }
docker image inspect velnox-backend:local >/dev/null 2>&1 || { echo "Build the stack first: the fixture runs in velnox-backend:local." >&2; exit 1; }

info "Preparing a certificate and SSH keys for the fixture."
cat >"$WORK/openssl.cnf" <<CONFIG
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = ${FIXTURE_HOST}
[v3]
subjectAltName = DNS:${FIXTURE_HOST}
basicConstraints = critical,CA:FALSE
CONFIG
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -config "$WORK/openssl.cnf" \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>"$WORK/openssl.log" ||
  { red "could not generate a certificate"; cat "$WORK/openssl.log"; exit 1; }
TLS_FINGERPRINT="$(openssl x509 -in "$WORK/cert.pem" -noout -fingerprint -sha256 | cut -d= -f2)"
ssh-keygen -q -t ed25519 -N '' -C fixture-host -f "$WORK/host_key" >/dev/null
ssh-keygen -q -t ed25519 -N '' -C velnox-client -f "$WORK/client_key" >/dev/null
HOST_KEY_FINGERPRINT="$(ssh-keygen -lf "$WORK/host_key.pub" | awk '{print $2}')"

mkdir -p "$WORK/store"
cp "$ROOT/scripts/fixtures/fake-pve.mjs" "$ROOT/scripts/fixtures/fake-pve-storage.mjs" "$ROOT/scripts/fixtures/fake-pve-ops.mjs" "$ROOT/scripts/fixtures/fake-pve-ceph.mjs" "$WORK/"
# Calls the fixture's own API from inside its container, as a person at the
# Proxmox console would: to read the HA rules, or remove one behind Velnox's back.
cat >"$WORK/pvecall.mjs" <<'SCRIPT'
import https from 'node:https';
const [method, path, form] = process.argv.slice(2);
const body = form ? new URLSearchParams(JSON.parse(form)).toString() : undefined;
const request = https.request(
  {
    host: '127.0.0.1',
    port: 8006,
    path: `/api2/json${path}`,
    method,
    rejectUnauthorized: false,
    headers: {
      authorization: 'PVEAPIToken=root@pam!velnox=fixture-secret-0000-0000-000000000000',
      ...(body ? { 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } : {}),
    },
  },
  (response) => {
    let raw = '';
    response.on('data', (c) => (raw += c));
    response.on('end', () => process.stdout.write(raw));
  },
);
if (body) request.write(body);
request.end();
SCRIPT
chmod -R a+rwX "$WORK" 2>/dev/null || true

MSYS_NO_PATHCONV=1 docker run -d --rm --name "$FIXTURE_NAME" \
  --network "$NETWORK" --network-alias "$FIXTURE_HOST" \
  -v "$(cd "$WORK" && { pwd -W 2>/dev/null || pwd; }):/fixture" \
  --entrypoint node velnox-backend:local \
  /fixture/fake-pve.mjs --cert /fixture/cert.pem --key /fixture/key.pem --port 8006 \
  --storage-dir /fixture/store --node-address "$FIXTURE_HOST" \
  --ssh-port "$SSH_PORT" --ssh-host-key /fixture/host_key --ssh-authorized-key /fixture/client_key.pub \
  --ops --reboot-seconds 6 >/dev/null
sleep 3
docker ps --format '{{.Names}}' | grep -q "$FIXTURE_NAME" || { red "the fixture did not start"; docker logs "$FIXTURE_NAME" 2>&1 | tail -20; exit 1; }
FIXLOG() { docker logs "$FIXTURE_NAME" 2>&1; }

# ---------------------------------------------------------------------------
# An administrator, the cluster, SSH
# ---------------------------------------------------------------------------

MSP="$(psql_at "SELECT id FROM tenants WHERE kind = 'MSP_ROOT';")"
if [[ -n "${VELNOX_ADMIN_EMAIL:-}" && -n "${VELNOX_ADMIN_PASSWORD:-}" ]]; then
  call POST /api/v1/auth/login "$(body '{ email: e.VELNOX_ADMIN_EMAIL, password: e.VELNOX_ADMIN_PASSWORD }')" >/dev/null
  check "admin: signs in" 200 "$(last_status)"
else
  make_user "$MSP" msp_super_administrator admin
  check "admin: signs in" 200 "$(login "$JAR" admin)"
fi
unset VELNOX_ADMIN_PASSWORD

TENANT_ID="$(call GET /api/v1/tenants | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{const t=JSON.parse(r).tenants.find(x=>x.kind!=="MSP_ROOT"&&x.status==="ACTIVE");process.stdout.write(t?t.id:"")})')"
register_cluster() {
  call POST /api/v1/clusters "$(T="$TENANT_ID" R="$RUN" H="$FIXTURE_HOST" F="$TLS_FINGERPRINT" I="$TOKEN_ID" S="$TOKEN_SECRET" body '{ tenantId: e.T, name: e.R, host: e.H, port: 8006, fingerprint: e.F, auth: { kind: "API_TOKEN", tokenId: e.I, secret: e.S } }')"
}
CLUSTER="$(register_cluster)"
# A run that was interrupted leaves its cluster on the same fixture address behind.
LEFTOVER="$(printf '%s' "$CLUSTER" | json error.params.clusterId)"
if [[ "$(printf '%s' "$CLUSTER" | json error.code)" == cluster.duplicate && -n "$LEFTOVER" ]]; then
  info "Removing a cluster an interrupted run left behind."
  call DELETE "/api/v1/clusters/${LEFTOVER}" >/dev/null
  CLUSTER="$(register_cluster)"
fi
CLUSTER_ID="$(printf '%s' "$CLUSTER" | json id)"
[[ -n "$CLUSTER_ID" ]] || { red "no cluster to test against: $(printf '%s' "$CLUSTER" | head -c 300)"; exit 1; }
for _ in $(seq 1 60); do
  [[ -n "$(call GET "/api/v1/clusters/${CLUSTER_ID}" | json lastDiscoveryAt)" ]] && break
  sleep 1
done
check "cluster: discovered" 3 "$(nodes_now | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>process.stdout.write(String(JSON.parse(r).length)))')"

KEY="$(node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(process.argv[1], "utf8")))' "$WORK/client_key")"
call POST "/api/v1/clusters/${CLUSTER_ID}/ssh/probe" "{\"port\":${SSH_PORT}}" >/dev/null
call PUT "/api/v1/clusters/${CLUSTER_ID}/ssh" "$(printf '{"username":"velnox","port":%s,"privateKey":%s,"hostKeys":[{"node":"pve1","fingerprint":"%s"},{"node":"pve2","fingerprint":"%s"},{"node":"pve3","fingerprint":"%s"}]}' "$SSH_PORT" "$KEY" "$HOST_KEY_FINGERPRINT" "$HOST_KEY_FINGERPRINT" "$HOST_KEY_FINGERPRINT")" >/dev/null
check "ssh: set up for the three nodes" 200 "$(last_status)"

# ---------------------------------------------------------------------------
# Placement
# ---------------------------------------------------------------------------

control() { in_fixture "printf '%s' '$1' > /fixture/store/ops-control.json"; }
pve() { MSYS_NO_PATHCONV=1 docker exec "$FIXTURE_NAME" node /fixture/pvecall.mjs "$@"; }
view() { call GET "/api/v1/placement/clusters/${CLUSTER_ID}"; }
rule_of() { # name → that rule from the view
  view | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{try{const x=(JSON.parse(r).rules||[]).find(y=>y.name===process.argv[1]);process.stdout.write(x?JSON.stringify(x):"")}catch{}})' "$1"
}
migrations() { FIXLOG | grep -c ' migrated '; }
discover() { call POST "/api/v1/clusters/${CLUSTER_ID}/discover" >/dev/null; }
wait_until() { # seconds command... — until the command prints "yes"
  local deadline=$((SECONDS + $1))
  shift
  while ((SECONDS < deadline)); do
    [[ "$("$@" 2>/dev/null)" == yes ]] && { printf yes; return 0; }
    sleep 2
  done
  printf no
}
pve3_online_is() { [[ "$(nodes_now | node_row pve3 | json online)" == "$1" ]] && printf yes; }
holds() { [[ "$(rule_of "$1" | json violations)" == "[]" ]] && printf yes; }
ha_state_is() { [[ "$(rule_of "$1" | json ha.state)" == "$2" ]] && printf yes; }
ha_on() { [[ "$(view | json cluster.haRules)" == true ]] && printf yes; }
in_proxmox() { [[ "$(pve GET /cluster/ha/rules)" == *"\"rule\":\"$1\""* ]] && printf yes; }
gone_from_proxmox() { [[ "$(pve GET /cluster/ha/rules)" != *"\"rule\":\"$1\""* ]] && printf yes; }
ha_rule() { # id → that HA rule as Proxmox holds it
  pve GET /cluster/ha/rules | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{try{const x=JSON.parse(r).data.find(y=>y.rule===process.argv[1]);process.stdout.write(x?JSON.stringify(x):"")}catch{}})' "$1"
}
auto_jobs() { psql_at "SELECT count(*) FROM jobs WHERE type = 'cluster.placement' AND '${CLUSTER_ID}' = ANY(target_ids::text[]) AND created_by_user_id IS NULL;"; }
latest_auto_job() { psql_at "SELECT id FROM jobs WHERE type = 'cluster.placement' AND '${CLUSTER_ID}' = ANY(target_ids::text[]) AND created_by_user_id IS NULL ORDER BY queued_at DESC LIMIT 1;"; }
more_auto_jobs_than() { (($(auto_jobs) > $1)) && printf yes; }
api_up() { call GET "/api/v1/placement/clusters/${CLUSTER_ID}" >/dev/null; [[ "$(last_status)" == 200 ]] && printf yes; }
settings() { call PUT "/api/v1/placement/clusters/${CLUSTER_ID}/settings" "$1" >/dev/null; last_status; }

info "Balancing, and a cluster that is not whole."
V="$(view)"
check "view: PVE 8 has no HA rules of its own" false "$(printf '%s' "$V" | json cluster.haRules)"
check "view: no rules yet" "[]" "$(printf '%s' "$V" | json rules)"
check "view: balancing is off until someone turns it on" false "$(printf '%s' "$V" | json settings.balance)"
check "settings: saved" 200 "$(settings '{"autoCorrect":false,"balance":false,"balanceThresholdPercent":10,"quietMinutes":5}')"
MOVED="$(migrations)"
control '{"offline":["pve3"]}'
J1="$(call POST "/api/v1/placement/clusters/${CLUSTER_ID}/balance" | json id)"
check "degraded: asked for while the inventory still says all is well" 201 "$(last_status)"
check "degraded: the run refuses" FAILED "$(wait_for "$J1" 60 SUCCEEDED FAILED PARTIALLY_SUCCEEDED)"
check "degraded: because the cluster is not whole" placement.cluster_degraded "$(job_field "$J1" errorCode)"
discover
check "degraded: the inventory sees pve3 go" yes "$(wait_until 40 pve3_online_is false)"
R="$(call POST "/api/v1/placement/clusters/${CLUSTER_ID}/balance")"
check "degraded: then the request itself is refused" "409 placement.cluster_degraded" "$(last_status) $(printf '%s' "$R" | json error.code)"
AUTO="$(auto_jobs)"
check "degraded: balancing by itself turned on" 200 "$(settings '{"autoCorrect":true,"balance":true,"balanceThresholdPercent":10,"quietMinutes":5}')"
sleep 45
check "degraded: by itself, it starts nothing" "$AUTO" "$(auto_jobs)"
check "degraded: and nothing was moved" "$MOVED" "$(migrations)"

info "Balancing by itself, once the cluster is whole again."
control '{}'
discover
check "whole: pve3 is back" yes "$(wait_until 40 pve3_online_is true)"
check "balance: the settings start a run" yes "$(wait_until 90 more_auto_jobs_than "$AUTO")"
J2="$(latest_auto_job)"
check "balance: it succeeds" SUCCEEDED "$(wait_for "$J2" 120 SUCCEEDED FAILED PARTIALLY_SUCCEEDED)"
L2="$(logs_of "$J2")"
contains "balance: it measures the spread" "differs by 17.2 points" "$L2"
contains "balance: and moves the smallest guest off the busiest node" "Moving CT 200 from pve1 to pve2" "$L2"
check "balance: started by the settings, not a person" "placement settings" "$(psql_at "SELECT params->>'by' FROM jobs WHERE id = '${J2}';")"
J2B="$(call POST "/api/v1/placement/clusters/${CLUSTER_ID}/balance" | json id)"
check "balance: asked again" SUCCEEDED "$(wait_for "$J2B" 120 SUCCEEDED FAILED PARTIALLY_SUCCEEDED)"
contains "balance: a move that would not narrow the spread is not made" "Nothing to move" "$(logs_of "$J2B")"
check "settings: off again" 200 "$(settings '{"autoCorrect":false,"balance":false,"balanceThresholdPercent":20,"quietMinutes":30}')"

info "Rules, and what is refused."
R="$(call POST "/api/v1/placement/clusters/${CLUSTER_ID}/rules" '{"name":"x","kind":"KEEP_APART","vmids":[100,4242]}')"
check "refused: a guest the cluster does not have" "400 placement.unknown_member" "$(last_status) $(printf '%s' "$R" | json error.code)"
R="$(call POST "/api/v1/placement/clusters/${CLUSTER_ID}/rules" '{"name":"x","kind":"KEEP_APART","vmids":[100,101,102,200]}')"
check "refused: four guests kept apart on three nodes" "400 placement.impossible" "$(last_status) $(printf '%s' "$R" | json error.code)"
R="$(call POST "/api/v1/placement/clusters/${CLUSTER_ID}/rules" '{"name":"x","kind":"KEEP_APART","vmids":[100]}')"
check "refused: a rule between guests with one guest" 400 "$(last_status)"
RULE1="$(call POST "/api/v1/placement/clusters/${CLUSTER_ID}/rules" '{"name":"web apart","kind":"KEEP_APART","vmids":[101,200]}' | json id)"
check "rule: kept apart, CT 200 and VM 101" 201 "$(last_status)"
R="$(call POST "/api/v1/placement/clusters/${CLUSTER_ID}/rules" '{"name":"x","kind":"KEEP_TOGETHER","vmids":[101,200]}')"
check "refused: the same two kept together as well" "409 placement.contradiction" "$(last_status) $(printf '%s' "$R" | json error.code)"
call POST "/api/v1/placement/clusters/${CLUSTER_ID}/rules" '{"name":"WEB APART","kind":"KEEP_APART","vmids":[100,101]}' >/dev/null
check "refused: a second rule by the same name" 409 "$(last_status)"
make_user "$TENANT_ID" tenant_read_only viewer
VIEWER_JAR="$WORK/viewer-cookies"
check "viewer: signs in" 200 "$(login "$VIEWER_JAR" viewer)"
SAVED_JAR="$JAR"
JAR="$VIEWER_JAR"
call GET "/api/v1/placement/clusters/${CLUSTER_ID}" >/dev/null
check "viewer: reads the rules" 200 "$(last_status)"
call POST "/api/v1/placement/clusters/${CLUSTER_ID}/rules" '{"name":"y","kind":"KEEP_APART","vmids":[100,101]}' >/dev/null
check "viewer: may not write one" 403 "$(last_status)"
call POST "/api/v1/placement/clusters/${CLUSTER_ID}/correct" >/dev/null
check "viewer: nor move guests" 403 "$(last_status)"
JAR="$SAVED_JAR"

info "A rule not met, reported and corrected."
discover
violated() { local v; v="$(rule_of "$1" | json violations)"; [[ -n "$v" && "$v" != "[]" ]] && printf yes; }
check "reported: the inventory shows it" yes "$(wait_until 40 violated 'web apart')"
VIOL="$(rule_of 'web apart' | json violations)"
contains "reported: both on pve2" '"vmids":[101,200]' "$VIOL"
check "on PVE 8 it is kept by Velnox" velnox "$(rule_of 'web apart' | json ha.state)"
J3="$(call POST "/api/v1/placement/clusters/${CLUSTER_ID}/correct" | json id)"
check "correct: a migration job" 201 "$(last_status)"
check "correct: it succeeds" SUCCEEDED "$(wait_for "$J3" 120 SUCCEEDED FAILED PARTIALLY_SUCCEEDED)"
L3="$(logs_of "$J3")"
contains "correct: the smaller guest goes, to a node with neither" "Moving CT 200 from pve2 to pve3" "$L3"
contains "correct: and every rule holds afterwards" "Every placement rule holds" "$L3"
discover
check "correct: the screen says it holds" yes "$(wait_until 40 holds 'web apart')"

info "A rolling update keeps the rules while it empties each node."
call DELETE "/api/v1/placement/rules/${RULE1}" >/dev/null
check "removed: on PVE 8 at once" "204 0" "$(last_status) $(psql_at "SELECT count(*) FROM placement_rules WHERE id = '${RULE1}';")"
RULE2="$(call POST "/api/v1/placement/clusters/${CLUSTER_ID}/rules" '{"name":"db apart","kind":"KEEP_APART","vmids":[100,101]}' | json id)"
check "rule: VM 100 and VM 101 kept apart" 201 "$(last_status)"
RULE3="$(call POST "/api/v1/placement/clusters/${CLUSTER_ID}/rules" '{"name":"web on pve2","kind":"PREFER_NODES","vmids":[101],"nodes":["pve2"],"strict":true}' | json id)"
check "rule: VM 101 only on pve2" 201 "$(last_status)"
MOVED="$(migrations)"
J4="$(call POST "/api/v1/updates/clusters/${CLUSTER_ID}/rolling" '{"nonMigratable":"SHUTDOWN","rebootPolicy":"NEVER","settleMinutes":2}' | json id)"
check "blocked: a rolling update that would have to break a rule refuses" FAILED "$(wait_for "$J4" 120 SUCCEEDED FAILED PARTIALLY_SUCCEEDED)"
check "blocked: saying so" update.placement_blocked "$(job_field "$J4" errorCode)"
D4="$(job_field "$J4" errorDetail)"
contains "blocked: naming the guest" "may take VM 101" "$D4"
contains "blocked: and the rule" "web on pve2" "$D4"
check "blocked: before anything moved" "$MOVED" "$(migrations)"
call DELETE "/api/v1/placement/rules/${RULE3}" >/dev/null
J5="$(call POST "/api/v1/updates/clusters/${CLUSTER_ID}/rolling" '{"nonMigratable":"SHUTDOWN","rebootPolicy":"NEVER","settleMinutes":2}' | json id)"
check "rolling: succeeds" SUCCEEDED "$(wait_for "$J5" 600 SUCCEEDED FAILED PARTIALLY_SUCCEEDED CANCELLED)"
L5="$(logs_of "$J5")"
contains "rolling: it reads the rules" 'Placement rules in force: \"db apart\"' "$L5"
contains "rolling: VM 100 leaves pve1 for pve3, not for VM 101's pve2" "Moving VM 100 from pve1 to pve3" "$L5"
contains "rolling: VM 101 leaves pve2 for pve3, not for VM 100's pve1" "Moving VM 101 from pve2 to pve3" "$L5"
lacks "rolling: VM 100 never went to pve2" "Moving VM 100 from pve1 to pve2" "$L5"
lacks "rolling: VM 101 never went to pve1" "Moving VM 101 from pve2 to pve1" "$L5"
discover
check "rolling: and the rule holds afterwards" yes "$(wait_until 40 holds 'db apart')"

info "On PVE 9 the rules are Proxmox's own."
control '{"pve":"9.0.6"}'
discover
check "pve9: every node reports PVE 9" yes "$(wait_until 60 ha_on)"
check "pve9: the rule is written to Proxmox" yes "$(wait_until 75 ha_state_is 'db apart' synced)"
HA_ID="$(rule_of 'db apart' | json ha.ruleId)"
HA="$(ha_rule "$HA_ID")"
check "pve9: as resource affinity" resource-affinity "$(printf '%s' "$HA" | json type)"
check "pve9: negative — kept apart" negative "$(printf '%s' "$HA" | json affinity)"
check "pve9: for both guests" "vm:100,vm:101" "$(printf '%s' "$HA" | json resources)"

info "Velnox stopped: the rule stays in Proxmox."
"${COMPOSE[@]}" stop worker api web >/dev/null 2>&1
check "stopped: Velnox's API does not answer" yes "$( curl -sk --max-time 5 -o /dev/null -w '%{http_code}' "${BASE}/api/v1/placement/clusters/${CLUSTER_ID}" | grep -qv '^200$' && printf yes)"
check "stopped: Proxmox still holds the rule" yes "$(in_proxmox "$HA_ID")"
"${COMPOSE[@]}" start api worker web >/dev/null 2>&1
check "started: Velnox is back" yes "$(wait_until 180 api_up)"

info "A rule removed in Proxmox behind Velnox's back is written again."
pve DELETE "/cluster/ha/rules/${HA_ID}" >/dev/null
check "tamper: gone from Proxmox" yes "$(gone_from_proxmox "$HA_ID")"
check "tamper: written again" yes "$(wait_until 75 in_proxmox "$HA_ID")"

info "Changing and removing a rule follows into Proxmox."
call PUT "/api/v1/placement/rules/${RULE2}" '{"name":"db apart","kind":"KEEP_APART","vmids":[100,101],"enabled":false}' >/dev/null
check "change: saved" 200 "$(last_status)"
disabled_in_proxmox() { [[ "$(ha_rule "$HA_ID" | json disable)" == 1 ]] && printf yes; }
check "change: switched off in Proxmox too" yes "$(wait_until 75 disabled_in_proxmox)"
RULE4="$(call POST "/api/v1/placement/clusters/${CLUSTER_ID}/rules" '{"name":"web prefers pve2","kind":"PREFER_NODES","vmids":[101],"nodes":["pve2"],"strict":false}' | json id)"
check "prefer: a node preference" 201 "$(last_status)"
check "prefer: written to Proxmox" yes "$(wait_until 75 ha_state_is 'web prefers pve2' synced)"
HA4="$(ha_rule "$(rule_of 'web prefers pve2' | json ha.ruleId)")"
check "prefer: as node affinity, not strict, on pve2" "node-affinity 0 pve2" "$(printf '%s' "$HA4" | json type) $(printf '%s' "$HA4" | json strict) $(printf '%s' "$HA4" | json nodes)"
call DELETE "/api/v1/placement/rules/${RULE2}" >/dev/null
check "remove: gone from the screen at once" "204 " "$(last_status) $(rule_of 'db apart')"
check "remove: and from Proxmox" yes "$(wait_until 75 gone_from_proxmox "$HA_ID")"
row_gone() { [[ "$(psql_at "SELECT count(*) FROM placement_rules WHERE id = '${RULE2}';")" == 0 ]] && printf yes; }
check "remove: then from Velnox's database" yes "$(wait_until 30 row_gone)"
[[ -n "$RULE4" ]] && call DELETE "/api/v1/placement/rules/${RULE4}" >/dev/null
control '{}'

printf '\n'
if ((FAIL == 0)); then
  printf '\033[0;32m%d checks passed.\033[0m\n' "$PASS"
  exit 0
fi
printf '\033[0;31m%d passed, %d failed.\033[0m\n' "$PASS" "$FAIL"
exit 1
