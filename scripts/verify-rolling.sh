#!/usr/bin/env bash
#
# Verify Phase 7 — rolling updates — against a running stack.
#
#   bash scripts/verify-rolling.sh
#   VELNOX_ADMIN_EMAIL=... VELNOX_ADMIN_PASSWORD=... bash scripts/verify-rolling.sh
#
# With no administrator given, a throwaway MSP Super Administrator is created
# for the run and disabled at the end.
#
# Stands up the fixture Proxmox in its operations mode: three nodes with pending
# updates, guests on shared Ceph and one VM on a node's own disk, live
# migration, reboots that stop what is left running, and a control file to take
# a node away or make Ceph unhealthy after a reboot. Proves Phase 7's acceptance:
# one node at a time, refusal on a degraded cluster, guests moved away and back
# or accounted for, and a node failing its validation stopping the run as
# partially succeeded. The quorum invariant for 1–15 nodes is proven by the
# planner's property test (packages/shared/src/rolling.spec.ts).
#
# Needs: a running stack, node, openssl, ssh-keygen, curl, docker.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_NATIVE="$(cd "$ROOT" && { pwd -W 2>/dev/null || pwd; })"
BASE="${1:-https://localhost}"
RUN="vr$(date +%s)"
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
cp "$ROOT/scripts/fixtures/fake-pve.mjs" "$ROOT/scripts/fixtures/fake-pve-storage.mjs" "$ROOT/scripts/fixtures/fake-pve-ops.mjs" "$ROOT/scripts/fixtures/fake-pve-ceph.mjs" "$ROOT/scripts/fixtures/fake-pve-major.mjs" "$WORK/"
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
# Rolling updates
# ---------------------------------------------------------------------------

control() { in_fixture "printf '%s' '$1' > /fixture/store/ops-control.json"; }

info "The plan, before anything starts."
PLAN="$(call GET "/api/v1/updates/clusters/${CLUSTER_ID}/rolling-plan?concurrency=3")"
check "plan: one node at a time, even when three are asked for" '[["pve1"],["pve2"],["pve3"]]' "$(printf '%s' "$PLAN" | json groups)"
check "plan: a three-node cluster takes one down at most" 1 "$(printf '%s' "$PLAN" | json maxConcurrency)"
check "plan: the running guests to move" 4 "$(printf '%s' "$PLAN" | json guests | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>process.stdout.write(String(JSON.parse(r).length)))')"

info "A cluster that is already degraded."
control '{"offline":["pve3"]}'
R1="$(call POST "/api/v1/updates/clusters/${CLUSTER_ID}/rolling" '{"nonMigratable":"SHUTDOWN"}')"
J1="$(printf '%s' "$R1" | json id)"
check "degraded: accepted while the inventory still says all is well" 201 "$(last_status)"
check "degraded: the run refuses to start" FAILED "$(wait_for "$J1" 60 SUCCEEDED FAILED PARTIALLY_SUCCEEDED)"
check "degraded: because a node is down" update.cluster_degraded "$(job_field "$J1" errorCode)"
contains "degraded: naming it" "pve3" "$(job_field "$J1" errorDetail)"
check "degraded: and nothing was touched" 0 "$(FIXLOG | grep -c 'migrated\|dist-upgrade\|rebooting')"
call POST "/api/v1/clusters/${CLUSTER_ID}/discover" >/dev/null
for _ in $(seq 1 30); do
  [[ "$(nodes_now | node_row pve3 | json online)" == false ]] && break
  sleep 1
done
R1B="$(call POST "/api/v1/updates/clusters/${CLUSTER_ID}/rolling" '{}')"
check "degraded: once the inventory knows, the request itself is refused" "409 update.cluster_degraded" "$(last_status) $(printf '%s' "$R1B" | json error.code)"
control '{}'
call POST "/api/v1/clusters/${CLUSTER_ID}/discover" >/dev/null
for _ in $(seq 1 30); do
  [[ "$(nodes_now | node_row pve3 | json online)" == true ]] && break
  sleep 1
done

info "A guest that cannot move, with the request saying to stop on one."
J2="$(call POST "/api/v1/updates/clusters/${CLUSTER_ID}/rolling" '{"nonMigratable":"BLOCK"}' | json id)"
check "blocked: the run refuses to start" FAILED "$(wait_for "$J2" 60 SUCCEEDED FAILED PARTIALLY_SUCCEEDED)"
check "blocked: because a guest cannot be moved" update.not_migratable "$(job_field "$J2" errorCode)"
contains "blocked: naming it and why" "VM 102 on pve3 (disk on local" "$(job_field "$J2" errorDetail)"
check "blocked: nothing was moved" 0 "$(FIXLOG | grep -c 'migrated')"

info "The whole cluster, one node at a time; the VM that cannot move is shut down for its node's reboot."
J3="$(call POST "/api/v1/updates/clusters/${CLUSTER_ID}/rolling" '{"nonMigratable":"SHUTDOWN","rebootPolicy":"IF_REQUIRED","settleMinutes":2}' | json id)"
check "rolling: accepted" 201 "$(last_status)"
check "rolling: the run succeeds" SUCCEEDED "$(wait_for "$J3" 600 SUCCEEDED FAILED PARTIALLY_SUCCEEDED CANCELLED)"
L3="$(logs_of "$J3")"
SEQUENCE="$(FIXLOG | grep -oE 'ops: pve[0-9] (rebooting|is back)' | sed 's/ops: //;s/ (reboot.*//' | tr '\n' ',')"
check "rolling: strictly one node down at a time, in order" "pve1 rebooting,pve1 is back,pve2 rebooting,pve2 is back,pve3 rebooting,pve3 is back," "$SEQUENCE"
contains "rolling: VM 100 was moved off pve1 before its reboot" "Moving VM 100 from pve1" "$L3"
contains "rolling: the container restarts on its new node" "Moving CT 200 from pve1" "$L3"
contains "rolling: VM 102 was shut down for pve3, not moved" "Shutting VM 102 down on pve3" "$L3"
lacks "rolling: nothing was stopped by a reboot" "stopped by" "$(FIXLOG)"
contains "rolling: VM 100 is back on pve1" "VM 100: back on pve1 (running)" "$L3"
contains "rolling: CT 200 is back on pve1" "CT 200: back on pve1 (running)" "$L3"
contains "rolling: VM 101 is back on pve2" "VM 101: back on pve2 (running)" "$L3"
contains "rolling: VM 102 runs again on pve3" "VM 102: back on pve3 (running)" "$L3"
contains "rolling: and the summary counts them" "3 nodes updated; 4 guests moved or shut down, 4 back where they were" "$L3"
ALL="$(nodes_now)"
check "rolling: nothing pending on any node" "0,0,0" "$(printf '%s' "$ALL" | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>process.stdout.write(JSON.parse(r).sort((a,b)=>a.node.localeCompare(b.node)).map(n=>n.total).join(",")))')"
check "rolling: no reboot due on any node" "false,false,false" "$(printf '%s' "$ALL" | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>process.stdout.write(JSON.parse(r).sort((a,b)=>a.node.localeCompare(b.node)).map(n=>n.rebootRequired).join(",")))')"

info "A node that fails its validation stops the run, partially succeeded."
control '{"cephWarnAfterReboot":"pve2"}'
J4="$(call POST "/api/v1/updates/clusters/${CLUSTER_ID}/rolling" '{"nonMigratable":"SHUTDOWN","rebootPolicy":"ALWAYS","settleMinutes":1}' | json id)"
check "partial: the run ends partially succeeded" PARTIALLY_SUCCEEDED "$(wait_for "$J4" 600 SUCCEEDED FAILED PARTIALLY_SUCCEEDED CANCELLED)"
check "partial: as a validation that failed" update.validation_failed "$(job_field "$J4" errorCode)"
M4="$(job_field "$J4" errorDetail)"
contains "partial: naming the node and why" "pve2 did not validate within 1 minute: Ceph is HEALTH_WARN" "$M4"
contains "partial: and accounting for the guest it moved" "VM 101 is on" "$M4"
STEPS="$(call GET "/api/v1/jobs/${J4}" | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{const s=JSON.parse(r).steps||[];process.stdout.write(s.map(x=>x.key+"="+x.status).join(","))})')"
contains "partial: pve1's group finished" "g1-return=SUCCEEDED" "$STEPS"
contains "partial: pve3's group was never started" "g3-evacuate=SKIPPED" "$STEPS"
check "partial: pve3 was not rebooted again" 1 "$(FIXLOG | grep -c 'ops: pve3 rebooting')"
control '{}'

printf '\n'
if ((FAIL == 0)); then
  printf '\033[0;32m%d checks passed.\033[0m\n' "$PASS"
  exit 0
fi
printf '\033[0;31m%d passed, %d failed.\033[0m\n' "$PASS" "$FAIL"
exit 1
