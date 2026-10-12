#!/usr/bin/env bash
# shellcheck disable=SC2329  # helpers are called through wait_until and the EXIT trap
#
# Verify Phase 9A — the Ceph major upgrade — against a running stack.
#
#   bash scripts/verify-ceph.sh
#   VELNOX_ADMIN_EMAIL=... VELNOX_ADMIN_PASSWORD=... bash scripts/verify-ceph.sh
#
# With no administrator given, a throwaway MSP Super Administrator is created
# for the run and disabled at the end.
#
# Stands up the fixture Proxmox in its operations mode, whose Ceph — three
# monitors, a manager, six OSDs — has a version installed per node and running
# per daemon, a repository that decides what apt offers, restarts that briefly
# degrade it, noout and require-osd-release. Proves Phase 9A's acceptance:
# plans refused when release, target and matrix disagree, naming which; runs
# refused unless Ceph is healthy, clean and fully quorate; daemons restarted
# strictly in order with health read between each; an unknown warning
# blocking; noout cleared on success, failure, cancellation and a killed
# worker; a cluster mid-upgrade blocked; every daemon's version in the report.
#
# Needs: a running stack, node, openssl, ssh-keygen, curl, docker.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_NATIVE="$(cd "$ROOT" && { pwd -W 2>/dev/null || pwd; })"
BASE="${1:-https://localhost}"
RUN="vc$(date +%s)"
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
cat >"$WORK/pvecall.mjs" <<'SCRIPT'
import https from 'node:https';
const [method, path] = process.argv.slice(2);
const request = https.request(
  {
    host: '127.0.0.1',
    port: 8006,
    path: `/api2/json${path}`,
    method,
    rejectUnauthorized: false,
    headers: { authorization: 'PVEAPIToken=root@pam!velnox=fixture-secret-0000-0000-000000000000' },
  },
  (response) => {
    let raw = '';
    response.on('data', (c) => (raw += c));
    response.on('end', () => process.stdout.write(raw));
  },
);
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
# Ceph upgrades
# ---------------------------------------------------------------------------

control() { in_fixture "printf '%s' '$1' > /fixture/store/ops-control.json"; }
pve() { MSYS_NO_PATHCONV=1 docker exec "$FIXTURE_NAME" node /fixture/pvecall.mjs "$@"; }
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
pick() { # js expression over the JSON on stdin, as `d`
  node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{try{const d=JSON.parse(r);const v=eval(process.argv[1]);process.stdout.write(typeof v==="object"?JSON.stringify(v):String(v))}catch(e){}})' "$1"
}
plan() { call GET "/api/v1/upgrades/plans/$1"; }
ceph_plan() { # name target → response
  call POST /api/v1/upgrades/plans "$(N="$1" T="$2" C="$CLUSTER_ID" body '{ kind: "PLAYBOOK", clusterId: e.C, name: e.N, playbookId: "velnox.ceph-major", options: { target: e.T, settleSeconds: 60 } }')"
}
inventory_versions_are() { [[ "$(psql_at "SELECT string_agg(DISTINCT version, ',') FROM ceph_daemons WHERE cluster_id = '${CLUSTER_ID}';")" == "$1" ]] && printf yes; }
rediscover_until() { discover; wait_until 60 inventory_versions_are "$1"; }
noout() { pve GET /cluster/ceph/flags | pick 'd.data.find(f=>f.name==="noout").value'; }
noout_is() { [[ "$(noout)" == "$1" ]] && printf yes; }
ceph_events() { FIXLOG | grep -oE 'ceph: (noout (set|unset)|restart [a-z]+\.[a-z0-9]+|require_osd_release [a-z]+|fresh at [0-9.]+)' | sed 's/^ceph: //' | tr '\n' ','; }
since_fresh() { ceph_events | awk -F'fresh at [0-9.]+,' '{print $NF}'; }
restarted_since_fresh() { [[ "$(since_fresh)" == *"restart $1,"* ]] && printf yes; }
run_plan() { call POST "/api/v1/upgrades/plans/$1/run" | json job.id; }

info "Plans the matrix refuses, naming what is unexpected."
check "inventory: ten daemons on reef" yes "$(inventory_versions_are 18.2.4)"
R="$(ceph_plan "${RUN} tentacle" tentacle)"
check "refused: a target Velnox does not know" "409 upgrade.matrix_mismatch target" "$(last_status) $(printf '%s' "$R" | json error.code) $(printf '%s' "$R" | json error.params.unexpected)"
R="$(ceph_plan "${RUN} sideways" reef)"
check "refused: a target that is not newer" "409 target" "$(last_status) $(printf '%s' "$R" | json error.params.unexpected)"
control '{"cephStart":"17.2.7","cephReset":1}'
check "quincy: the inventory reads it" yes "$(rediscover_until 17.2.7)"
R="$(ceph_plan "${RUN} skip" squid)"
check "refused: quincy to squid skips reef — the matrix has no such step" "409 matrix" "$(last_status) $(printf '%s' "$R" | json error.params.unexpected)"
contains "refused: and says where quincy goes" "from quincy it goes to reef" "$(printf '%s' "$R" | json error.params.reason)"
control '{"cephMixed":true,"cephReset":2}'
check "mixed: the inventory reads it" yes "$(rediscover_until 18.2.4,19.2.0)"
R="$(ceph_plan "${RUN} mixed" squid)"
check "refused: a cluster already mid-upgrade — the running release is unexpected" "409 running" "$(last_status) $(printf '%s' "$R" | json error.params.unexpected)"
control '{"cephReset":3}'
check "reef again" yes "$(rediscover_until 18.2.4)"

info "Runs refused before anything changes."
P1="$(ceph_plan "${RUN} old manager" squid | json id)"
check "plan: made, with the matrix that made it" "201 2026-10-11 ceph-squid" "$(last_status) $(psql_at "SELECT facts->'matrix'->>'version' || ' ' || (facts->'matrix'->'entry'->>'repo') FROM upgrade_plans WHERE id = '${P1}';")"
check "plan: the daemons in Ceph's order" "mon.pve1,mon.pve2,mon.pve3,mgr.pve1,osd.0,osd.1,osd.2,osd.3,osd.4,osd.5" "$(plan "$P1" | pick 'd.targetList.map(t=>t.label).join(",")')"
J1="$(run_plan "$P1")"
check "old manager: the run is blocked" FAILED "$(wait_for "$J1" 120 SUCCEEDED FAILED)"
check "old manager: at the gate" upgrade.blockers_present "$(job_field "$J1" errorCode)"
contains "old manager: because squid needs pve-manager 8.2.8" "needs pve-manager 8.2.8 or later" "$(plan "$P1" | pick 'd.checks.filter(c=>c.severity==="BLOCKER").map(c=>c.title).join(" | ")')"
check "old manager: nothing was touched" "" "$(since_fresh)"

control '{"pve":"8.4.1","cephReset":3,"cephUnknownWarn":true}'
discover
P2="$(ceph_plan "${RUN} unknown warning" squid | json id)"
J2="$(run_plan "$P2")"
check "unknown warning: blocked" "FAILED upgrade.blockers_present" "$(wait_for "$J2" 120 SUCCEEDED FAILED) $(job_field "$J2" errorCode)"
check "unknown warning: as UNKNOWN, the line kept verbatim" "UNKNOWN DEVICE_HEALTH: 1 device has a predicted failure" "$(plan "$P2" | pick 'd.checks.filter(c=>c.runIndex===0&&c.severity==="UNKNOWN").map(c=>c.severity+" "+c.rawLine).join(" | ")')"

control '{"pve":"8.4.1","cephReset":3,"monDown":"pve3"}'
P3="$(ceph_plan "${RUN} quorum" squid | json id)"
J3="$(run_plan "$P3")"
check "quorum: blocked" FAILED "$(wait_for "$J3" 120 SUCCEEDED FAILED)"
contains "quorum: a monitor out of quorum is named" "monitor pve3 not in quorum" "$(plan "$P3" | pick 'd.checks.filter(c=>c.severity==="BLOCKER").map(c=>c.title).join(" | ")')"

control '{"pve":"8.4.1","cephReset":3}'
P4="$(ceph_plan "${RUN} mid-upgrade" squid | json id)"
control '{"pve":"8.4.1","cephReset":4,"cephMixed":true}'
J4="$(run_plan "$P4")"
check "mid-upgrade at run time: blocked" FAILED "$(wait_for "$J4" 120 SUCCEEDED FAILED)"
contains "mid-upgrade at run time: from what Proxmox says now" "mid-upgrade" "$(plan "$P4" | pick 'd.checks.filter(c=>c.severity==="BLOCKER").map(c=>c.title).join(" | ")')"
check "nothing was ever restarted, noout never set" "" "$(since_fresh)"

info "Reef to squid."
control '{"pve":"8.4.1","cephReset":5,"cephRestartSeconds":2}'
check "reef, fresh" yes "$(rediscover_until 18.2.4)"
P5="$(ceph_plan "${RUN} squid" squid | json id)"
J5="$(run_plan "$P5")"
check "upgrade: succeeds" SUCCEEDED "$(wait_for "$J5" 600 SUCCEEDED FAILED CANCELLED)"
check "upgrade: noout, every daemon in order one at a time, require-osd-release, noout cleared" "noout set,restart mon.pve1,restart mon.pve2,restart mon.pve3,restart mgr.pve1,restart osd.0,restart osd.1,restart osd.2,restart osd.3,restart osd.4,restart osd.5,require_osd_release squid,noout unset," "$(since_fresh)"
check "upgrade: the repository switched on every node" 3 "$(FIXLOG | grep -c 'repository deb http://download.proxmox.com/debian/ceph-squid bookworm no-subscription')"
L5="$(logs_of "$J5")"
check "upgrade: Ceph read whole again after every daemon" 10 "$(printf '%s' "$L5" | grep -o 'Ceph is whole after [a-z]*\.[a-z0-9]*' | wc -l | tr -d ' ')"
ORDERLY="$(printf '%s' "$L5" | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{const l=JSON.parse(r).map(x=>x.content||"").join("\n");const names=["mon.pve1","mon.pve2","mon.pve3","mgr.pve1","osd.0","osd.1","osd.2","osd.3","osd.4","osd.5"];let ok=true;for(let i=1;i<names.length;i++){if(l.indexOf("Ceph is whole after "+names[i-1])>l.indexOf("Restarting "+names[i]))ok=false}process.stdout.write(ok?"each settled before the next":"overlapping")})')"
check "upgrade: no daemon restarted before the one before it settled" "each settled before the next" "$ORDERLY"
check "upgrade: noout is clear" 0 "$(noout)"
R5="$(call GET "/api/v1/upgrades/plans/${P5}/report" | json markdown)"
contains "report: a monitor's version before and after" "| mon.pve1 (MON) | DONE | version 18.2.4 | version 19.2.0 |" "$R5"
contains "report: an OSD's" "| osd.5 (OSD) | DONE | version 18.2.4 | version 19.2.0 |" "$R5"
check "after: the inventory reads squid everywhere" yes "$(rediscover_until 19.2.0)"

info "Cancelled mid-flight: noout is cleared."
control '{"pve":"8.4.1","cephReset":6,"cephRestartSeconds":8}'
check "reef, fresh" yes "$(rediscover_until 18.2.4)"
P6="$(ceph_plan "${RUN} cancelled" squid | json id)"
J6="$(run_plan "$P6")"
check "cancel: the run reaches the OSDs" yes "$(wait_until 300 restarted_since_fresh osd.0)"
check "cancel: noout is set while it runs" 1 "$(noout)"
call POST "/api/v1/jobs/${J6}/cancel" '{}' >/dev/null
check "cancel: the job is cancelled" CANCELLED "$(wait_for "$J6" 120 CANCELLED FAILED SUCCEEDED)"
check "cancel: noout is cleared" yes "$(wait_until 30 noout_is 0)"
check "cancel: the plan says so" CANCELLED "$(plan "$P6" | json status)"

info "A restart that fails: noout is cleared."
control '{"pve":"8.4.1","cephReset":7,"cephRestartSeconds":1,"cephFailRestart":"osd.3"}'
check "reef, fresh" yes "$(rediscover_until 18.2.4)"
P7="$(ceph_plan "${RUN} failing" squid | json id)"
J7="$(run_plan "$P7")"
check "failure: the run fails" "FAILED upgrade.target_failed" "$(wait_for "$J7" 600 SUCCEEDED FAILED CANCELLED) $(job_field "$J7" errorCode)"
check "failure: the daemons before it are done, the rest not reached" "DONE,DONE,DONE,DONE,DONE,DONE,DONE,FAILED,PENDING,PENDING" "$(plan "$P7" | pick 'd.targetList.map(t=>t.status).join(",")')"
check "failure: noout is cleared" yes "$(wait_until 30 noout_is 0)"

info "A worker killed mid-flight: noout is cleared by the next one."
control '{"pve":"8.4.1","cephReset":8,"cephRestartSeconds":8}'
check "reef, fresh" yes "$(rediscover_until 18.2.4)"
P8="$(ceph_plan "${RUN} killed" squid | json id)"
J8="$(run_plan "$P8")"
check "killed: the run reaches the monitors" yes "$(wait_until 300 restarted_since_fresh mon.pve2)"
"${COMPOSE[@]}" kill -s SIGKILL worker >/dev/null 2>&1
check "killed: noout is still set, with nobody to clear it" 1 "$(noout)"
"${COMPOSE[@]}" up -d worker >/dev/null 2>&1
check "killed: the job is reconciled as lost" "FAILED job.worker_lost" "$(wait_for "$J8" 120 FAILED SUCCEEDED CANCELLED) $(job_field "$J8" errorCode)"
check "killed: noout is cleared" yes "$(wait_until 60 noout_is 0)"
check "killed: the plan failed" FAILED "$(plan "$P8" | json status)"
control '{}'

printf '\n'
if ((FAIL == 0)); then
  printf '\033[0;32m%d checks passed.\033[0m\n' "$PASS"
  exit 0
fi
printf '\033[0;31m%d passed, %d failed.\033[0m\n' "$PASS" "$FAIL"
exit 1
