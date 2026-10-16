#!/usr/bin/env bash
# shellcheck disable=SC2329  # helpers are called through wait_until and the EXIT trap
#
# Verify merging two registrations of one Proxmox cluster (ADR-055) against a
# running stack.
#
#   bash scripts/verify-merge.sh
#   VELNOX_ADMIN_EMAIL=... VELNOX_ADMIN_PASSWORD=... bash scripts/verify-merge.sh
#
# The fixture Proxmox in its operations mode, reachable under two names, is
# added twice — as two servers added one by one and joined in Proxmox later
# would be. Proves that Velnox sees they are one cluster, refuses to merge what
# is not one, and that merging keeps one registration, renamed, with what the
# other held: its SSH set-up and host-key pins, a placement rule, its update
# policy, its history — and removes the other with its API credential.
#
# Needs: a running stack, node, openssl, ssh-keygen, curl, docker.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_NATIVE="$(cd "$ROOT" && { pwd -W 2>/dev/null || pwd; })"
BASE="${1:-https://localhost}"
RUN="vm$(date +%s)"
COMPOSE=(docker compose -f "$ROOT_NATIVE/deploy/compose/docker-compose.yml" --env-file "$ROOT_NATIVE/.env")
FIXTURE_NAME="velnox-fake-pve-${RUN}"
FIXTURE_HOST="fake-pve-merge-a"
FIXTURE_HOST_B="fake-pve-merge-b"
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
  [[ -n "${CLUSTER_B:-}" ]] && call DELETE "/api/v1/clusters/${CLUSTER_B}" >/dev/null 2>&1
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
subjectAltName = DNS:${FIXTURE_HOST},DNS:${FIXTURE_HOST_B}
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
  --network "$NETWORK" --network-alias "$FIXTURE_HOST" --network-alias "$FIXTURE_HOST_B" \
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
register_cluster() { # host name
  call POST /api/v1/clusters "$(T="$TENANT_ID" R="$2" H="$1" F="$TLS_FINGERPRINT" I="$TOKEN_ID" S="$TOKEN_SECRET" body '{ tenantId: e.T, name: e.R, host: e.H, port: 8006, fingerprint: e.F, auth: { kind: "API_TOKEN", tokenId: e.I, secret: e.S } }')"
}
CLUSTER="$(register_cluster "$FIXTURE_HOST" "${RUN}-pve1")"
# A run that was interrupted leaves its cluster on the same fixture address behind.
LEFTOVER="$(printf '%s' "$CLUSTER" | json error.params.clusterId)"
if [[ "$(printf '%s' "$CLUSTER" | json error.code)" == cluster.duplicate && -n "$LEFTOVER" ]]; then
  info "Removing a cluster an interrupted run left behind."
  call DELETE "/api/v1/clusters/${LEFTOVER}" >/dev/null
  CLUSTER="$(register_cluster "$FIXTURE_HOST" "${RUN}-pve1")"
fi
CLUSTER_ID="$(printf '%s' "$CLUSTER" | json id)"
[[ -n "$CLUSTER_ID" ]] || { red "no cluster to test against: $(printf '%s' "$CLUSTER" | head -c 300)"; exit 1; }
for _ in $(seq 1 60); do
  [[ -n "$(call GET "/api/v1/clusters/${CLUSTER_ID}" | json lastDiscoveryAt)" ]] && break
  sleep 1
done
check "cluster: discovered" 3 "$(nodes_now | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>process.stdout.write(String(JSON.parse(r).length)))')"

# ---------------------------------------------------------------------------
# The same cluster, added a second time under another name
# ---------------------------------------------------------------------------

CLUSTER_B="$(register_cluster "$FIXTURE_HOST_B" "${RUN}-pve2" | json id)"
check "second registration: the same cluster under another address" 201 "$(last_status)"
for _ in $(seq 1 60); do
  [[ -n "$(call GET "/api/v1/clusters/${CLUSTER_B}" | json lastDiscoveryAt)" ]] && break
  sleep 1
done
check "both: read, with the name Proxmox gives the cluster" "fixture fixture" "$(psql_at "SELECT string_agg(coalesce(pve_cluster_name, '-'), ' ' ORDER BY name) FROM clusters WHERE id IN ('${CLUSTER_ID}', '${CLUSTER_B}');")"

info "The second one holds things: SSH, a placement rule, an update policy."
KEY="$(node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(process.argv[1], "utf8")))' "$WORK/client_key")"
call POST "/api/v1/clusters/${CLUSTER_B}/ssh/probe" "{\"port\":${SSH_PORT}}" >/dev/null
call PUT "/api/v1/clusters/${CLUSTER_B}/ssh" "$(printf '{"username":"velnox","port":%s,"privateKey":%s,"hostKeys":[{"node":"pve1","fingerprint":"%s"},{"node":"pve2","fingerprint":"%s"},{"node":"pve3","fingerprint":"%s"}]}' "$SSH_PORT" "$KEY" "$HOST_KEY_FINGERPRINT" "$HOST_KEY_FINGERPRINT" "$HOST_KEY_FINGERPRINT")" >/dev/null
check "b: SSH set up" 200 "$(last_status)"
RULE="$(call POST "/api/v1/placement/clusters/${CLUSTER_B}/rules" '{"name":"web apart","kind":"KEEP_APART","vmids":[101,200]}' | json id)"
check "b: a placement rule" 201 "$(last_status)"
call PUT /api/v1/updates/policies "$(C="$CLUSTER_B" body '{ clusterId: e.C, name: "Merged policy", requireApproval: true }')" >/dev/null
check "b: an update policy" 200 "$(last_status)"
B_TOKEN="$(psql_at "SELECT credential_id FROM clusters WHERE id = '${CLUSTER_B}';")"
B_SSH="$(psql_at "SELECT ssh_credential_id FROM clusters WHERE id = '${CLUSTER_B}';")"
B_RUNS="$(psql_at "SELECT count(*) FROM discovery_runs WHERE cluster_id = '${CLUSTER_B}';")"
A_RUNS="$(psql_at "SELECT count(*) FROM discovery_runs WHERE cluster_id = '${CLUSTER_ID}';")"

# ---------------------------------------------------------------------------
# Seen, refused when it should be, merged
# ---------------------------------------------------------------------------

candidates() { call GET /api/v1/clusters/merge-candidates; }
check "seen: the two are offered as one cluster" "fixture ${RUN}-pve1,${RUN}-pve2 pve1,pve2,pve3" "$(candidates | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{const g=(JSON.parse(r).candidates||[]).find(x=>x.clusters.some(c=>c.id===process.argv[1]));if(g)process.stdout.write(g.pveClusterName+" "+g.clusters.map(c=>c.name).sort().join(",")+" "+g.nodes.join(","))})' "$CLUSTER_ID")"
merge_body() { K="$1" R="$2" N="$3" F="${4:-keep}" body '{ keepId: e.K, removeId: e.R, name: e.N, sshFrom: e.F }'; }
merge_code() { local out; out="$(call POST /api/v1/clusters/merge "$(merge_body "$@")")"; printf '%s %s' "$(last_status)" "$(printf '%s' "$out" | json error.code)"; }
check "refused: a cluster with itself" "409 cluster.merge_not_same" "$(merge_code "$CLUSTER_ID" "$CLUSTER_ID" "x")"
psql_at "UPDATE clusters SET pve_cluster_name = 'another' WHERE id = '${CLUSTER_B}';" >/dev/null
check "refused: two that report different Proxmox clusters" "409 cluster.merge_not_same" "$(merge_code "$CLUSTER_ID" "$CLUSTER_B" "x")"
check "and not offered either" "" "$(candidates | json candidates.0.pveClusterName)"
psql_at "UPDATE clusters SET pve_cluster_name = 'fixture' WHERE id = '${CLUSTER_B}';" >/dev/null
BUSY="$(psql_at "INSERT INTO jobs (id, tenant_id, type, status, target_kind, target_ids, concurrency_key, updated_at) VALUES (gen_random_uuid(), '${TENANT_ID}', 'harness.hold', 'WAITING_APPROVAL', 'cluster', ARRAY['${CLUSTER_B}']::uuid[], 'cluster:${CLUSTER_B}', now()) RETURNING id;" | head -1)"
check "refused: while a job runs against either" "409 cluster.merge_busy" "$(merge_code "$CLUSTER_ID" "$CLUSTER_B" "x")"
psql_at "DELETE FROM jobs WHERE id = '${BUSY}';" >/dev/null

info "Merged: keep the first one's connection, take the second's SSH."
MERGED="$(call POST /api/v1/clusters/merge "$(merge_body "$CLUSTER_ID" "$CLUSTER_B" "${RUN} PVE-PROD")")"
check "merge: done" 201 "$(last_status)"
check "merge: says what came along" "ssh,host keys,update policy" "$(printf '%s' "$MERGED" | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{const x=JSON.parse(r);process.stdout.write((x.carried||[]).map(c=>c.replace(/ \(.*\)$/,"")).join(","))})')"
call GET "/api/v1/clusters/${CLUSTER_B}" >/dev/null
check "merge: the second registration is gone" 404 "$(last_status)"
check "merge: the first is renamed" "${RUN} PVE-PROD" "$(call GET "/api/v1/clusters/${CLUSTER_ID}" | json name)"
check "merge: its connection is its own" "${FIXTURE_HOST}" "$(psql_at "SELECT endpoint_host FROM clusters WHERE id = '${CLUSTER_ID}';")"
check "kept: the SSH set-up, the same key" "${B_SSH} velnox" "$(psql_at "SELECT ssh_credential_id || ' ' || ssh_username FROM clusters WHERE id = '${CLUSTER_ID}';")"
check "kept: and its public key shown" "$(cut -d' ' -f1-2 "$WORK/client_key.pub")" "$(call GET "/api/v1/clusters/${CLUSTER_ID}/ssh" | json publicKey)"
check "kept: every node's host-key pin" "3" "$(psql_at "SELECT count(*) FROM nodes WHERE cluster_id = '${CLUSTER_ID}' AND ssh_host_key_fingerprint = '${HOST_KEY_FINGERPRINT}';")"
check "kept: the placement rule" "${CLUSTER_ID}" "$(psql_at "SELECT cluster_id FROM placement_rules WHERE id = '${RULE}';")"
check "kept: the update policy" "Merged policy" "$(psql_at "SELECT name FROM update_policies WHERE cluster_id = '${CLUSTER_ID}';")"
HISTORY="$(psql_at "SELECT count(*) FROM discovery_runs WHERE cluster_id = '${CLUSTER_ID}';")"
if ((HISTORY >= A_RUNS + B_RUNS)); then KEPT_HISTORY=yes; else KEPT_HISTORY="${HISTORY} of $((A_RUNS + B_RUNS))"; fi
check "kept: the second's discovery history, beside the first's" yes "$KEPT_HISTORY"
check "removed: the second's API token, which nobody owns now" 0 "$(psql_at "SELECT count(*) FROM credentials WHERE id = '${B_TOKEN}';")"
check "kept: its SSH key, which the first owns now" "${CLUSTER_ID}" "$(psql_at "SELECT scope_id FROM credentials WHERE id = '${B_SSH}';")"
check "audit: the merge recorded on both" 2 "$(psql_at "SELECT count(*) FROM audit_events WHERE action = 'cluster.merged' AND resource_id IN ('${CLUSTER_ID}', '${CLUSTER_B}');")"
check "nothing left to merge" "" "$(candidates | json candidates.0.pveClusterName)"
check "read again: three nodes, one cluster" 3 "$(nodes_now | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>process.stdout.write(String(JSON.parse(r).length)))')"
ssh_still_works() { [[ "$(call GET "/api/v1/clusters/${CLUSTER_ID}/ssh" | json configured)" == true ]] && printf yes; }
check "the merged cluster's SSH is set up" yes "$(ssh_still_works)"
CLUSTER_B=""

echo
if ((FAIL == 0)); then
  printf '\033[0;32m%s checks passed.\033[0m\n' "$PASS"
else
  printf '\033[0;31m%s passed, %s failed.\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi
