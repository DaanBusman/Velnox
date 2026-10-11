#!/usr/bin/env bash
# shellcheck disable=SC2329  # helpers are called through wait_until and the EXIT trap
#
# Verify Phase 8 — the major upgrade framework — against a running stack.
#
#   bash scripts/verify-upgrades.sh
#   VELNOX_ADMIN_EMAIL=... VELNOX_ADMIN_PASSWORD=... bash scripts/verify-upgrades.sh
#
# With no administrator given, a throwaway MSP Super Administrator is created
# for the run and disabled at the end.
#
# Stands up the fixture Proxmox in its operations mode — three nodes and ten
# Ceph daemons in the inventory — and runs the engine's self-test playbooks,
# which change nothing outside Velnox, against it. Proves Phase 8's acceptance:
# a playbook defined as data runs on the generic runner; remediation metadata
# routes a change to automatic or to approval; a composite plan sequences two
# child plans and stops when a child fails; reports render for node-targeted
# and daemon-targeted runs. The genericity itself is proven in 9A and 9B.
#
# Needs: a running stack, node, openssl, ssh-keygen, curl, docker.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_NATIVE="$(cd "$ROOT" && { pwd -W 2>/dev/null || pwd; })"
BASE="${1:-https://localhost}"
RUN="vg$(date +%s)"
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
cp "$ROOT/scripts/fixtures/fake-pve.mjs" "$ROOT/scripts/fixtures/fake-pve-storage.mjs" "$ROOT/scripts/fixtures/fake-pve-ops.mjs" "$WORK/"
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
CLUSTER="$(call POST /api/v1/clusters "$(T="$TENANT_ID" R="$RUN" H="$FIXTURE_HOST" F="$TLS_FINGERPRINT" I="$TOKEN_ID" S="$TOKEN_SECRET" body '{ tenantId: e.T, name: e.R, host: e.H, port: 8006, fingerprint: e.F, auth: { kind: "API_TOKEN", tokenId: e.I, secret: e.S } }')")"
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
# Upgrade plans
# ---------------------------------------------------------------------------

control() { in_fixture "printf '%s' '$1' > /fixture/store/ops-control.json"; }
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
plan() { call GET "/api/v1/upgrades/plans/$1"; }
plan_is() { [[ "$(plan "$1" | json status)" == "$2" ]] && printf yes; }
pve3_online_is() { [[ "$(nodes_now | node_row pve3 | json online)" == "$1" ]] && printf yes; }
count() { # json-array → length
  node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(r).length))}catch{process.stdout.write("")}})'
}
pick() { # js expression over the JSON on stdin, as `d`
  node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{try{const d=JSON.parse(r);const v=eval(process.argv[1]);process.stdout.write(typeof v==="object"?JSON.stringify(v):String(v))}catch(e){}})' "$1"
}
steps_of() { call GET "/api/v1/jobs/$1" | pick 'd.steps.map(s=>s.key+"="+s.status).join(",")'; }
new_plan() { call POST /api/v1/upgrades/plans "$1" | json id; }
selftest() { # name playbook options → plan id
  new_plan "$(N="$1" P="$2" O="$3" C="$CLUSTER_ID" body '{ kind: "PLAYBOOK", clusterId: e.C, name: e.N, playbookId: e.P, options: JSON.parse(e.O) }')"
}

info "Playbooks, and who is offered them."
check "inventory: ten Ceph daemons" 10 "$(psql_at "SELECT count(*) FROM ceph_daemons WHERE cluster_id = '${CLUSTER_ID}';")"
PB="$(call GET /api/v1/upgrades/playbooks | json playbooks)"
contains "playbooks: the node self-test" "velnox.selftest-nodes" "$PB"
contains "playbooks: and the daemon self-test" "velnox.selftest-ceph" "$PB"
make_user "$TENANT_ID" tenant_administrator tadmin
TADMIN_JAR="$WORK/tadmin-cookies"
check "tenant admin: signs in" 200 "$(login "$TADMIN_JAR" tadmin)"
SAVED_JAR="$JAR"
JAR="$TADMIN_JAR"
check "tenant admin: self-tests are not offered" "[]" "$(call GET /api/v1/upgrades/playbooks | json playbooks)"
call POST /api/v1/upgrades/plans "$(C="$CLUSTER_ID" body '{ kind: "PLAYBOOK", clusterId: e.C, name: "x", playbookId: "velnox.selftest-nodes", options: {} }')" >/dev/null
check "tenant admin: and cannot plan one" 403 "$(last_status)"
JAR="$SAVED_JAR"
call POST /api/v1/upgrades/plans "$(C="$CLUSTER_ID" body '{ kind: "PLAYBOOK", clusterId: e.C, name: "x", playbookId: "no.such", options: {} }')" >/dev/null
check "a playbook that does not exist is refused" 400 "$(last_status)"

info "A node-by-node plan: automatic remediation only."
P1="$(selftest "${RUN} nodes" velnox.selftest-nodes '{"markerMissing":true,"configOld":false}')"
check "plan: made" 201 "$(last_status)"
D1="$(plan "$P1")"
check "plan: not started" DRAFT "$(printf '%s' "$D1" | json status)"
check "plan: the nodes, by name" "pve1,pve2,pve3" "$(printf '%s' "$D1" | pick 'd.targetList.map(t=>t.label).join(",")')"
J1="$(call POST "/api/v1/upgrades/plans/${P1}/run" | json job.id)"
check "run: a job" 201 "$(last_status)"
check "run: it succeeds" SUCCEEDED "$(wait_for "$J1" 120 SUCCEEDED FAILED PARTIALLY_SUCCEEDED WAITING_APPROVAL)"
S1="$(steps_of "$J1")"
contains "steps: built from the playbook, node by node where it says so" "node-1=SUCCEEDED,node-validate-1=SUCCEEDED,node-2=SUCCEEDED" "$S1"
contains "steps: nothing to approve, so nobody was asked" "remediate-approve=SKIPPED" "$S1"
D1="$(plan "$P1")"
check "plan: completed" COMPLETED "$(printf '%s' "$D1" | json status)"
check "preflight: the missing marker on each node, as a warning" "3" "$(printf '%s' "$D1" | pick 'd.checks.filter(c=>c.runIndex===0&&c.key==="selftest.marker-missing"&&c.severity==="WARNING").length')"
check "remediation: routed to Velnox by its metadata, three times" "AUTOMATIC,AUTOMATIC,AUTOMATIC" "$(printf '%s' "$D1" | pick 'd.remediations.map(r=>r.mode).join(",")')"
check "remediation: applied and proven" "VALIDATED,VALIDATED,VALIDATED" "$(printf '%s' "$D1" | pick 'd.remediations.map(r=>r.status).join(",")')"
check "re-check: everything passes now" "0" "$(printf '%s' "$D1" | pick 'd.checks.filter(c=>c.runIndex===1&&c.severity!=="PASS").length')"
check "targets: each before and after" 'DONE {"version":"1"} {"version":"2"}' "$(printf '%s' "$D1" | pick 'd.targetList[0].status+" "+JSON.stringify(d.targetList[0].preState)+" "+JSON.stringify(d.targetList[0].postState)')"
R1="$(call GET "/api/v1/upgrades/plans/${P1}/report")"
check "report: completed" COMPLETED "$(printf '%s' "$R1" | json report.verdict)"
contains "report: a node table" "| Node | Result | Before | After | Fixed | Still open |" "$(printf '%s' "$R1" | json markdown)"
contains "report: what each node was and became, and what was fixed" "| pve1 | DONE | version 1 | version 2 | selftest.marker-missing | — |" "$(printf '%s' "$R1" | json markdown)"
call POST "/api/v1/upgrades/plans/${P1}/run" >/dev/null
check "run again: refused, it is not a draft" 409 "$(last_status)"
call DELETE "/api/v1/upgrades/plans/${P1}" >/dev/null
check "remove: refused once it ran" 409 "$(last_status)"

info "A daemon-by-daemon plan with a change that needs approval."
P2="$(selftest "${RUN} daemons" velnox.selftest-ceph '{"markerMissing":false,"configOld":true}')"
D2="$(plan "$P2")"
check "plan: Ceph's order — monitors, managers, OSDs" "MON,MON,MON,MGR,OSD,OSD,OSD,OSD,OSD,OSD" "$(printf '%s' "$D2" | pick 'd.targetList.map(t=>t.group).join(",")')"
J2="$(call POST "/api/v1/upgrades/plans/${P2}/run" | json job.id)"
check "approval: the run waits for a person" WAITING_APPROVAL "$(wait_for "$J2" 120 SUCCEEDED FAILED WAITING_APPROVAL)"
CS="$(call GET "/api/v1/jobs/${J2}" | pick 'JSON.stringify(d.approvals[0].changeSet)')"
contains "approval: it shows the exact change, line by line" '- mode=old' "$CS"
contains "approval: and what it becomes" '+ mode=new' "$CS"
check "approval: routed by metadata — high risk, cannot be undone" "APPROVED HIGH PLANNED" "$(plan "$P2" | pick 'd.remediations.map(r=>r.mode+" "+r.risk+" "+r.status).join(",")')"
check "approval: the plan says it is waiting" WAITING_APPROVAL "$(plan "$P2" | json jobStatus)"
call POST "/api/v1/jobs/${J2}/approve" '{}' >/dev/null
check "approval: given" 200 "$(last_status)"
check "approval: then the run carries on and succeeds" SUCCEEDED "$(wait_for "$J2" 120 SUCCEEDED FAILED WAITING_APPROVAL)"
check "approval: the approved change was applied and proven" "APPROVED VALIDATED" "$(plan "$P2" | pick 'd.remediations.map(r=>r.mode+" "+r.status).join(",")')"
R2="$(call GET "/api/v1/upgrades/plans/${P2}/report" | json markdown)"
contains "report: a daemon table" "| Daemon | Result | Before | After |" "$R2"
contains "report: an OSD by name" "| osd.0 (OSD) | DONE | version 1 | version 2 |" "$R2"
contains "report: a monitor, with its group" "(MON) | DONE" "$R2"

info "A blocker nothing fixes stops the run before any target."
P3="$(selftest "${RUN} blocked" velnox.selftest-nodes '{"markerMissing":false,"unfixable":true}')"
J3="$(call POST "/api/v1/upgrades/plans/${P3}/run" | json job.id)"
check "blocked: the run fails" FAILED "$(wait_for "$J3" 120 SUCCEEDED FAILED WAITING_APPROVAL)"
check "blocked: at the gate, because a blocker is open" upgrade.blockers_present "$(job_field "$J3" errorCode)"
check "blocked: the plan says so" BLOCKED "$(plan "$P3" | json status)"
contains "blocked: no node was touched" "node-1=SKIPPED" "$(steps_of "$J3")"
check "blocked: the report too" BLOCKED "$(call GET "/api/v1/upgrades/plans/${P3}/report" | json report.verdict)"

info "A guard: the cluster must be whole."
control '{"offline":["pve3"]}'
discover
check "guard: the inventory sees pve3 go" yes "$(wait_until 40 pve3_online_is false)"
P4="$(selftest "${RUN} guard" velnox.selftest-nodes '{"markerMissing":false}')"
J4="$(call POST "/api/v1/upgrades/plans/${P4}/run" | json job.id)"
check "guard: the run fails" FAILED "$(wait_for "$J4" 120 SUCCEEDED FAILED WAITING_APPROVAL)"
check "guard: because a condition does not hold" upgrade.guard_failed "$(job_field "$J4" errorCode)"
contains "guard: naming it" "cluster.offline = 0 (is 1)" "$(job_field "$J4" errorDetail)"
control '{}'
discover
check "guard: pve3 is back" yes "$(wait_until 40 pve3_online_is true)"

info "A composite: two plans in order."
C1="$(new_plan "$(C="$CLUSTER_ID" R="$RUN" body '{ kind: "COMPOSITE", clusterId: e.C, name: e.R + " composite", children: [ { name: "daemons first", playbookId: "velnox.selftest-ceph", options: { markerMissing: true } }, { name: "nodes second", playbookId: "velnox.selftest-nodes", options: { markerMissing: true } } ] }')")"
check "composite: made" 201 "$(last_status)"
KIDS="$(plan "$C1" | pick 'd.children.map(c=>c.id).join(" ")')"
read -r K1 K2 <<<"$KIDS"
call POST "/api/v1/upgrades/plans/${K1}/run" >/dev/null
check "composite: a child is not started on its own" 409 "$(last_status)"
call POST "/api/v1/upgrades/plans/${C1}/run" >/dev/null
check "composite: started" 201 "$(last_status)"
check "composite: completes" yes "$(wait_until 240 plan_is "$C1" COMPLETED)"
check "composite: both children completed" "COMPLETED,COMPLETED" "$(plan "$C1" | pick 'd.children.map(c=>c.status).join(",")')"
ORDER="$(psql_at "SELECT CASE WHEN a.finished_at <= b.started_at THEN 'in order' ELSE 'overlapping' END FROM jobs a, jobs b WHERE a.id = (SELECT job_id FROM upgrade_plans WHERE id = '${K1}') AND b.id = (SELECT job_id FROM upgrade_plans WHERE id = '${K2}');")"
check "composite: the second started only after the first finished" "in order" "$ORDER"
RC="$(call GET "/api/v1/upgrades/plans/${C1}/report" | json markdown)"
contains "composite: its report holds the daemon run" "## daemons first on" "$RC"
contains "composite: and the node run" "## nodes second on" "$RC"

info "A composite whose first plan fails stops there."
C2="$(new_plan "$(C="$CLUSTER_ID" R="$RUN" body '{ kind: "COMPOSITE", clusterId: e.C, name: e.R + " failing", children: [ { name: "daemons", playbookId: "velnox.selftest-ceph", options: { markerMissing: false, failTarget: "osd.2" } }, { name: "nodes", playbookId: "velnox.selftest-nodes", options: { markerMissing: false } } ] }')")"
read -r F1 F2 <<<"$(plan "$C2" | pick 'd.children.map(c=>c.id).join(" ")')"
call POST "/api/v1/upgrades/plans/${C2}/run" >/dev/null
check "failing: the composite fails" yes "$(wait_until 180 plan_is "$C2" FAILED)"
check "failing: its first plan failed, at the target asked" "FAILED upgrade.target_failed" "$(plan "$F1" | json status) $(job_field "$(plan "$F1" | json jobId)" errorCode)"
check "failing: the targets before it were done, the rest not reached" "DONE,DONE,DONE,DONE,DONE,DONE,FAILED,PENDING,PENDING,PENDING" "$(plan "$F1" | pick 'd.targetList.map(t=>t.status).join(",")')"
check "failing: the second plan was cancelled, never started" "CANCELLED none" "$(plan "$F2" | json status) $(plan "$F2" | pick 'd.jobId||"none"')"
check "failing: the composite's report says failed" FAILED "$(call GET "/api/v1/upgrades/plans/${C2}/report" | json report.verdict)"

info "A draft can be removed."
P5="$(selftest "${RUN} draft" velnox.selftest-nodes '{}')"
call DELETE "/api/v1/upgrades/plans/${P5}" >/dev/null
check "draft: removed" "204 404" "$(last_status) $(plan "$P5" >/dev/null; last_status)"

printf '\n'
if ((FAIL == 0)); then
  printf '\033[0;32m%d checks passed.\033[0m\n' "$PASS"
  exit 0
fi
printf '\033[0;31m%d passed, %d failed.\033[0m\n' "$PASS" "$FAIL"
exit 1
