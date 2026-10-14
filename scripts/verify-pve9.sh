#!/usr/bin/env bash
# shellcheck disable=SC2329  # helpers are called through wait_until and the EXIT trap
#
# Verify Phase 9B — Proxmox VE 8 → 9 — against a running stack.
#
#   bash scripts/verify-pve9.sh
#   VELNOX_ADMIN_EMAIL=... VELNOX_ADMIN_PASSWORD=... bash scripts/verify-pve9.sh
#
# With no administrator given, a throwaway MSP Super Administrator is created
# for the run and disabled at the end.
#
# Stands up the fixture Proxmox in its operations mode, whose nodes run
# Proxmox VE 8 with what pve8to9 looks at — the CPU's microcode, settings in
# /etc/sysctl.conf, the systemd-boot meta-package, free space — and answer
# `pve8to9 --full` with pve8to9.pm's own messages; with trixie sources a
# dist-upgrade installs Proxmox VE 9, run after a reboot. Proves Phase 9B's
# acceptance: structured findings with raw output kept; an unknown line a
# blocker, shown verbatim; the microcode installed by Velnox by itself (as the
# owner asked), the other fixes waiting for approval showing the exact change,
# then re-checked; a blocker nothing fixes never bypassed; the first node a
# canary the run waits after; the report with each node before and after;
# Ceph upgraded to Squid first, in a composite, before Proxmox VE.
#
# Needs: a running stack, node, openssl, ssh-keygen, curl, docker.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_NATIVE="$(cd "$ROOT" && { pwd -W 2>/dev/null || pwd; })"
BASE="${1:-https://localhost}"
RUN="v9$(date +%s)"
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
# Proxmox VE 8 → 9
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
plan_is() { [[ "$(plan "$1" | json status)" == "$2" ]] && printf yes; }
pve_plan() { # name → response
  call POST /api/v1/upgrades/plans "$(N="$1" C="$CLUSTER_ID" body '{ kind: "PLAYBOOK", clusterId: e.C, name: e.N, playbookId: "velnox.pve-8-to-9", options: { nonMigratable: "SHUTDOWN" } }')"
}
run_plan() { call POST "/api/v1/upgrades/plans/$1/run" | json job.id; }
inventory_ceph_is() { [[ "$(psql_at "SELECT string_agg(DISTINCT version, ',') FROM ceph_daemons WHERE cluster_id = '${CLUSTER_ID}';")" == "$1" ]] && printf yes; }
inventory_pve_is() { [[ "$(psql_at "SELECT string_agg(DISTINCT pve_version, ',') FROM nodes WHERE cluster_id = '${CLUSTER_ID}';")" == *"$1"* ]] && printf yes; }
fresh() { # control-json ceph-version [pve-version] → the fixture reset and the inventory reading it
  control "$1"
  discover
  [[ "$(wait_until 60 inventory_ceph_is "$2")" == yes && "$(wait_until 60 inventory_pve_is "${3:-8.4.14}")" == yes ]] && printf yes
}
node_version() { call GET "/api/v1/updates/nodes?clusterId=${CLUSTER_ID}" >/dev/null; pve GET "/nodes/$1/status" | pick 'd.data.pveversion.split("/")[1]'; }
guest_node() { pve GET /cluster/resources | pick "d.data.find(r=>r.vmid===$1).node"; }
approve() { call POST "/api/v1/jobs/$1/approve" '{}' >/dev/null; last_status; }
checks_of() { # plan run severity → "key severity remediation" lines
  plan "$1" | pick "d.checks.filter(c=>c.runIndex===$2&&c.severity!=='PASS'&&c.severity!=='INFO').map(c=>c.key+' '+c.severity+(c.remediationId?' '+c.remediationId:'')).sort().join(',')"
}

info "Proxmox VE 9 needs Ceph Squid."
check "reef: the inventory reads it" yes "$(fresh '{"pve":"8.4.14","cephStart":"18.2.4","cephReset":1,"majorReset":1}' 18.2.4)"
R="$(pve_plan "${RUN} too early")"
check "refused: Ceph is not on Squid yet" "409 upgrade.ceph_first" "$(last_status) $(printf '%s' "$R" | json error.code)"

info "pve8to9 read, and what Velnox fixes of it."
check "squid, with microcode missing, sysctl settings and systemd-boot" yes "$(fresh '{"pve":"8.4.14","cephStart":"19.2.0","cephReset":2,"majorReset":2,"systemdBoot":true}' 19.2.0)"
P1="$(pve_plan "${RUN} upgrade" | json id)"
check "plan: made, the nodes by name" "201 pve1,pve2,pve3" "$(last_status) $(plan "$P1" | pick 'd.targetList.map(t=>t.label).join(",")')"
J1="$(run_plan "$P1")"
check "run: waits for approval of the fixes Velnox does not make by itself" WAITING_APPROVAL "$(wait_for "$J1" 240 WAITING_APPROVAL SUCCEEDED FAILED)"
D1="$(plan "$P1")"
check "preflight: every node's pve8to9, structured" "pve8to9.microcode-missing WARNING pve.microcode,pve8to9.microcode-missing WARNING pve.microcode,pve8to9.microcode-missing WARNING pve.microcode,pve8to9.sysctl-conf WARNING pve.sysctl-move,pve8to9.sysctl-conf WARNING pve.sysctl-move,pve8to9.sysctl-conf WARNING pve.sysctl-move,pve8to9.systemd-boot BLOCKER pve.remove-systemd-boot,pve8to9.systemd-boot BLOCKER pve.remove-systemd-boot,pve8to9.systemd-boot BLOCKER pve.remove-systemd-boot" "$(checks_of "$P1" 0)"
contains "preflight: the raw line kept" "WARN: The matching CPU microcode package 'intel-microcode' could not be found!" "$(printf '%s' "$D1" | pick 'd.checks.map(c=>c.rawLine||"").join("\n")')"
check "microcode: installed by Velnox by itself, on every node, before anyone was asked" "AUTOMATIC VALIDATED,AUTOMATIC VALIDATED,AUTOMATIC VALIDATED" "$(printf '%s' "$D1" | pick 'd.remediations.filter(r=>r.remediationId==="pve.microcode").map(r=>r.mode+" "+r.status).join(",")')"
check "microcode: non-free-firmware enabled, the package installed" 3 "$(FIXLOG | grep -c 'microcode installed, sources now')"
check "the others: waiting, routed to approval by their risk" "APPROVED PLANNED HIGH,APPROVED PLANNED HIGH,APPROVED PLANNED HIGH,APPROVED PLANNED MEDIUM,APPROVED PLANNED MEDIUM,APPROVED PLANNED MEDIUM" "$(printf '%s' "$D1" | pick 'd.remediations.filter(r=>r.remediationId!=="pve.microcode").map(r=>r.mode+" "+r.status+" "+r.risk).sort().join(",")')"
CS="$(call GET "/api/v1/jobs/${J1}" | pick 'JSON.stringify(d.approvals[0].changeSet)')"
contains "approval: the exact sysctl.conf change" "- net.ipv4.ip_forward=1" "$CS"
contains "approval: and what it becomes" "+ # moved to /etc/sysctl.d/99-velnox-from-sysctl-conf.conf: net.ipv4.ip_forward=1" "$CS"
contains "approval: the new file" "+++ /etc/sysctl.d/99-velnox-from-sysctl-conf.conf" "$CS"
contains "approval: the package to remove" "systemd-boot" "$CS"
check "approval: nothing of it applied yet" 0 "$(FIXLOG | grep -c 'sysctl settings moved\|systemd-boot removed')"
check "approve the fixes" 200 "$(approve "$J1")"
check "canary: the first node done, the run waits again" WAITING_APPROVAL "$(wait_for "$J1" 600 WAITING_APPROVAL SUCCEEDED FAILED)"
check "fixes: applied and proven by pve8to9" "VALIDATED,VALIDATED,VALIDATED,VALIDATED,VALIDATED,VALIDATED" "$(plan "$P1" | pick 'd.remediations.filter(r=>r.remediationId!=="pve.microcode").map(r=>r.status).join(",")')"
check "re-check: nothing open on any node" "" "$(checks_of "$P1" 1)"
check "canary: pve1 runs Proxmox VE 9" 9.0.10 "$(node_version pve1)"
check "canary: pve2 does not yet" 8.4.14 "$(node_version pve2)"
check "canary: VM 100 is back on pve1" pve1 "$(guest_node 100)"
contains "canary: the gate says what the first node became" "9.0.10" "$(call GET "/api/v1/jobs/${J1}" | pick 'JSON.stringify(d.approvals[1].changeSet)')"
check "approve the rest" 200 "$(approve "$J1")"
check "upgrade: succeeds" SUCCEEDED "$(wait_for "$J1" 900 SUCCEEDED FAILED WAITING_APPROVAL)"
check "upgrade: every node on Proxmox VE 9" "9.0.10 9.0.10 9.0.10" "$(node_version pve1) $(node_version pve2) $(node_version pve3)"
check "upgrade: each node's reboot had noout around it, cleared after" 3 "$(FIXLOG | grep -c 'ceph: noout unset')"
check "upgrade: noout clear at the end" 0 "$(pve GET /cluster/ceph/flags | pick 'd.data.find(f=>f.name==="noout").value')"
check "upgrade: the VM on local disk shut down for its node, running again" running "$(pve GET /cluster/resources | pick 'd.data.find(r=>r.vmid===102).status')"
check "upgrade: guests back where they were" "pve1 pve1 pve2 pve3" "$(guest_node 100) $(guest_node 200) $(guest_node 101) $(guest_node 102)"
R1="$(call GET "/api/v1/upgrades/plans/${P1}/report" | json markdown)"
check "report: each node before and after" "| pve1 | DONE | version 8.4.14, kernel 6.8.12-4-pve | version 9.0.10, kernel 6.14.11-2-pve |" "$(printf '%s\n' "$R1" | grep -m1 '^| pve1 |' | cut -d'|' -f1-5)|"
contains "report: what was fixed" "pve8to9.microcode-missing" "$R1"

info "A node too old for pve8to9: brought to the latest Proxmox VE 8 first."
check "fresh, on 8.4.1 — before pve8to9 existed" yes "$(fresh '{"pve":"8.4.1","pve8Latest":"8.4.14","cephStart":"19.2.0","cephReset":6,"majorReset":6,"microcode":true,"sysctlConf":false}' 19.2.0 8.4.1)"
P4="$(pve_plan "${RUN} old" | json id)"
J4="$(run_plan "$P4")"
check "old: the run waits for approval before anything is checked" WAITING_APPROVAL "$(wait_for "$J4" 240 WAITING_APPROVAL SUCCEEDED FAILED)"
D4="$(plan "$P4")"
check "old: the update within 8 planned for every node, for approval" "pve.update-bookworm APPROVED PLANNED MEDIUM,pve.update-bookworm APPROVED PLANNED MEDIUM,pve.update-bookworm APPROVED PLANNED MEDIUM" "$(printf '%s' "$D4" | pick 'd.remediations.map(r=>r.remediationId+" "+r.mode+" "+r.status+" "+r.risk).sort().join(",")')"
check "old: pve8to9 not run yet" 0 "$(printf '%s' "$D4" | pick 'd.checks.length')"
contains "old: the approval says why" "now pve-manager 8.4.1; pve8to9 needs 8.4.2 or later" "$(call GET "/api/v1/jobs/${J4}" | pick 'JSON.stringify(d.approvals[0].changeSet)')"
check "old: nothing updated before approval" "8.4.1 0" "$(node_version pve1) $(FIXLOG | grep -c 'updated within Proxmox VE 8')"
check "approve the update within 8" 200 "$(approve "$J4")"
check "old: on to the canary" WAITING_APPROVAL "$(wait_for "$J4" 600 WAITING_APPROVAL SUCCEEDED FAILED)"
check "old: every node updated within 8, proven" "VALIDATED,VALIDATED,VALIDATED" "$(plan "$P4" | pick 'd.remediations.filter(r=>r.remediationId==="pve.update-bookworm").map(r=>r.status).join(",")')"
check "old: then pve8to9 ran on every node" 3 "$(plan "$P4" | pick 'new Set(d.checks.filter(c=>c.runIndex===0&&(c.rawLine||"").length).map(c=>c.targetId)).size')"
check "old: nothing it reported is open" "" "$(checks_of "$P4" 0)"
check "old: pve1 on 9, pve2 on the latest 8" "9.0.10 8.4.14" "$(node_version pve1) $(node_version pve2)"
call POST "/api/v1/jobs/${J4}/cancel" '{}' >/dev/null
check "old: cancelled at the canary" CANCELLED "$(wait_for "$J4" 120 CANCELLED SUCCEEDED FAILED)"

info "What stops the upgrade, and cannot be bypassed."
check "fresh, with pve8to9 printing a line nobody knows" yes "$(fresh '{"pve":"8.4.14","cephStart":"19.2.0","cephReset":3,"majorReset":3,"microcode":true,"sysctlConf":false,"pve8to9Unknown":"Some new check printed this"}' 19.2.0)"
P2="$(pve_plan "${RUN} unknown" | json id)"
J2="$(run_plan "$P2")"
check "unknown: blocked at the gate" "FAILED upgrade.blockers_present" "$(wait_for "$J2" 240 SUCCEEDED FAILED WAITING_APPROVAL) $(job_field "$J2" errorCode)"
check "unknown: the line kept verbatim, as UNKNOWN" "UNKNOWN Some new check printed this" "$(plan "$P2" | pick 'd.checks.filter(c=>c.runIndex===0&&c.severity==="UNKNOWN").map(c=>c.severity+" "+c.rawLine)[0]')"
check "unknown: no node touched" 8.4.14 "$(node_version pve1)"
check "fresh, with 3 GB free on /" yes "$(fresh '{"pve":"8.4.14","cephStart":"19.2.0","cephReset":4,"majorReset":4,"microcode":true,"sysctlConf":false,"rootFreeGb":3}' 19.2.0)"
P3="$(pve_plan "${RUN} space" | json id)"
J3="$(run_plan "$P3")"
check "space: blocked — nothing Velnox can fix" "FAILED upgrade.blockers_present" "$(wait_for "$J3" 240 SUCCEEDED FAILED WAITING_APPROVAL) $(job_field "$J3" errorCode)"
contains "space: said as pve8to9 said it" "Less than 5 GB free space on root file system" "$(plan "$P3" | pick 'd.checks.filter(c=>c.severity==="BLOCKER").map(c=>c.title).join(" | ")')"
check "space: no remediation was offered for it" "" "$(plan "$P3" | pick 'd.remediations.map(r=>r.remediationId).join(",")')"

info "Ceph to Squid first, then Proxmox VE, as one composite."
check "reef, clean otherwise" yes "$(fresh '{"pve":"8.4.14","cephStart":"18.2.4","cephReset":5,"majorReset":5,"microcode":true,"sysctlConf":false}' 18.2.4)"
C="$(call POST /api/v1/upgrades/plans "$(C="$CLUSTER_ID" R="$RUN" body '{ kind: "COMPOSITE", clusterId: e.C, name: e.R + " both", children: [ { name: "Ceph to Squid", playbookId: "velnox.ceph-major", options: { target: "squid", settleSeconds: 60 } }, { name: "Proxmox VE 8 to 9", playbookId: "velnox.pve-8-to-9", options: { nonMigratable: "SHUTDOWN" } } ] }')" | json id)"
check "composite: accepted, Ceph before Proxmox VE" 201 "$(last_status)"
read -r K1 K2 <<<"$(plan "$C" | pick 'd.children.map(c=>c.id).join(" ")')"
call POST "/api/v1/upgrades/plans/${C}/run" >/dev/null
check "composite: Ceph completes first" yes "$(wait_until 600 plan_is "$K1" COMPLETED)"
child_waits() { local j; j="$(plan "$K2" | json jobId)"; [[ -n "$j" && "$(job_field "$j" status)" == WAITING_APPROVAL ]] && printf yes; }
check "composite: then Proxmox VE runs, to its canary" yes "$(wait_until 600 child_waits)"
K2J="$(plan "$K2" | json jobId)"
check "composite: its preflight saw Ceph on Squid" "PASS" "$(plan "$K2" | pick 'd.checks.filter(c=>c.key==="pve.ceph-squid").map(c=>c.severity)[0]')"
check "approve the rest" 200 "$(approve "$K2J")"
check "composite: completes" yes "$(wait_until 900 plan_is "$C" COMPLETED)"
check "composite: every node on Proxmox VE 9, Ceph on Squid" "9.0.10 9.0.10 9.0.10 squid" "$(node_version pve1) $(node_version pve2) $(node_version pve3) $(pve GET /cluster/ceph/status | pick 'd.data.monmap.min_mon_release_name')"
control '{}'

printf '\n'
if ((FAIL == 0)); then
  printf '\033[0;32m%d checks passed.\033[0m\n' "$PASS"
  exit 0
fi
printf '\033[0;31m%d passed, %d failed.\033[0m\n' "$PASS" "$FAIL"
exit 1
