#!/usr/bin/env bash
#
# Verify Phase 6 — update management — against a running stack.
#
#   bash scripts/verify-updates.sh
#   VELNOX_ADMIN_EMAIL=... VELNOX_ADMIN_PASSWORD=... bash scripts/verify-updates.sh
#
# With no administrator given, a throwaway MSP Super Administrator is created
# for the run and disabled at the end.
#
# Stands up the fixture Proxmox in its operations mode (fake-pve-ops.mjs): three
# online nodes with pending updates, kernels that need a reboot to take effect,
# reboots that take a node away and bring it back, and SSH exec of exactly the
# commands Velnox's registry sends. Adds it as a cluster, sets SSH up, and
# proves the acceptance criteria: classification, a single-node update as a job
# with live output, reboot detection and a reboot, a maintenance window that
# keeps updates out, a policy that parks the job for approval, and a policy that
# updates by itself inside its window — and only there.
#
# Takes a few minutes: the policy scheduler ticks once a minute.
#
# Needs: a running stack, node, openssl, ssh-keygen, curl, docker.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_NATIVE="$(cd "$ROOT" && { pwd -W 2>/dev/null || pwd; })"
BASE="${1:-https://localhost}"
RUN="vu$(date +%s)"
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
as() { local saved="$JAR"; JAR="$1"; shift; "$@"; local rc=$?; JAR="$saved"; return $rc; }

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
chmod -R a+rwX "$WORK" 2>/dev/null || true

MSYS_NO_PATHCONV=1 docker run -d --rm --name "$FIXTURE_NAME" \
  --network "$NETWORK" --network-alias "$FIXTURE_HOST" \
  -v "$(cd "$WORK" && { pwd -W 2>/dev/null || pwd; }):/fixture" \
  --entrypoint node velnox-backend:local \
  /fixture/fake-pve.mjs --cert /fixture/cert.pem --key /fixture/key.pem --port 8006 \
  --storage-dir /fixture/store --node-address "$FIXTURE_HOST" \
  --ssh-port "$SSH_PORT" --ssh-host-key /fixture/host_key --ssh-authorized-key /fixture/client_key.pub \
  --ops --reboot-seconds 6 --fail-upgrade pve3 >/dev/null
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
# Classification and reboot detection
# ---------------------------------------------------------------------------

info "What each node would update, classified."
PVE1="$(nodes_now | node_row pve1)"
check "updates: pve1 has four pending" 4 "$(printf '%s' "$PVE1" | json total)"
check "updates: one of them a security update" 1 "$(printf '%s' "$PVE1" | json security)"
check "updates: one a kernel" 1 "$(printf '%s' "$PVE1" | json kernel)"
check "updates: two Proxmox's own" 2 "$(printf '%s' "$PVE1" | json proxmox)"
check "updates: no reboot due yet" false "$(printf '%s' "$PVE1" | json rebootRequired)"
check "updates: Velnox can apply them" true "$(printf '%s' "$PVE1" | json canApply)"
PVE1_ID="$(printf '%s' "$PVE1" | json nodeId)"
PVE2_ID="$(nodes_now | node_row pve2 | json nodeId)"
PVE3_ID="$(nodes_now | node_row pve3 | json nodeId)"
PKGS="$(call GET "/api/v1/updates/nodes/${PVE1_ID}/packages")"
check "updates: libssl3 is the security update" true "$(printf '%s' "$PKGS" | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>process.stdout.write(String(JSON.parse(r).find(p=>p.package==="libssl3").isSecurity)))')"
check "updates: and the kernel is known as one" true "$(printf '%s' "$PKGS" | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>process.stdout.write(String(JSON.parse(r).some(p=>p.isKernel&&/kernel/.test(p.package)))))')"
lacks "discovery: reading the kernels records no problem" "versions" "$(call GET "/api/v1/nodes/${PVE1_ID}" | json problems)"

# ---------------------------------------------------------------------------
# A single-node update, live, without and with a reboot
# ---------------------------------------------------------------------------

info "Updating pve1, the policy left to the request: no reboot."
J1="$(call POST "/api/v1/updates/nodes/${PVE1_ID}/run" '{"rebootPolicy":"NEVER"}' | json id)"
check "update: accepted as a job" 201 "$(last_status)"
LIVE="no"
for _ in $(seq 1 60); do
  STEP="$(job_field "$J1" currentStep)"; STATUS="$(job_field "$J1" status)"
  if [[ "$STATUS" == RUNNING && ( "$STEP" == upgrade || "$STEP" == reboot ) ]] && [[ "$(logs_of "$J1")" == *"Unpacking"* ]]; then LIVE="yes"; break; fi
  [[ "$STATUS" == SUCCEEDED || "$STATUS" == FAILED ]] && break
  sleep 0.3
done
check "update: the dist-upgrade's output is in the job while it runs" yes "$LIVE"
check "update: the job succeeds" SUCCEEDED "$(wait_for "$J1" 120 SUCCEEDED FAILED CANCELLED)"
L1="$(logs_of "$J1")"
contains "update: it read what would change, from the security archive" "1 from a security archive" "$L1"
contains "update: and installed it" "Setting up libssl3" "$L1"
contains "update: it says a reboot is due and the policy does not reboot" "the policy does not reboot" "$L1"
contains "update: the commands ran as the account, privileged ones through sudo" "dist-upgrade (4 packages)" "$(FIXLOG)"
lacks "update: the fixture refused nothing Velnox sent" "EXEC REFUSED" "$(FIXLOG)"
PVE1="$(nodes_now | node_row pve1)"
check "after: nothing pending on pve1" 0 "$(printf '%s' "$PVE1" | json total)"
check "after: a reboot is now due" true "$(printf '%s' "$PVE1" | json rebootRequired)"
contains "after: because a newer kernel is installed than the one running" "Kernel 6.8.12-5 is installed" "$(printf '%s' "$PVE1" | json rebootReason)"

info "Updating pve1 again, rebooting if required."
J2="$(call POST "/api/v1/updates/nodes/${PVE1_ID}/run" '{"rebootPolicy":"IF_REQUIRED"}' | json id)"
check "reboot: the job succeeds" SUCCEEDED "$(wait_for "$J2" 180 SUCCEEDED FAILED CANCELLED)"
L2="$(logs_of "$J2")"
contains "reboot: it rebooted the node for its kernel" "Rebooting pve1: kernel 6.8.12-5 is installed" "$L2"
contains "reboot: and waited for it to come back on the new kernel" "pve1 is back, running 6.8.12-5-pve" "$L2"
contains "reboot: the node really went away and came back" "pve1 is back on 6.8.12-5" "$(FIXLOG)"
check "reboot: no reboot is due any more" false "$(nodes_now | node_row pve1 | json rebootRequired)"

info "A dist-upgrade that fails."
J3="$(call POST "/api/v1/updates/nodes/${PVE3_ID}/run" '{"rebootPolicy":"NEVER"}' | json id)"
check "failure: the job fails" FAILED "$(wait_for "$J3" 120 SUCCEEDED FAILED CANCELLED)"
check "failure: as a command that failed" update.command_failed "$(job_field "$J3" errorCode)"
contains "failure: with dpkg's own words in the output" "dpkg returned an error code" "$(logs_of "$J3")"

# ---------------------------------------------------------------------------
# Windows and policies
# ---------------------------------------------------------------------------

info "A maintenance window that is open now, and a policy that asks for approval."
HOUR_NOW="$(date -u +%H | sed 's/^0//')"
OPEN_WINDOW="$(call POST /api/v1/updates/windows "$(T="$TENANT_ID" H="$HOUR_NOW" R="$RUN" body '{ tenantId: e.T, name: "Open " + e.R, timezone: "UTC", rrule: "FREQ=DAILY;BYHOUR=" + e.H, durationMinutes: 120 }')")"
check "window: created" 201 "$(last_status)"
OPEN_ID="$(printf '%s' "$OPEN_WINDOW" | json id)"; WINDOW_IDS+=("$OPEN_ID")
check "window: it says it is open" true "$(printf '%s' "$OPEN_WINDOW" | json open)"
call POST /api/v1/updates/windows "$(T="$TENANT_ID" body '{ tenantId: e.T, name: "Bad", timezone: "UTC", rrule: "FREQ=WEEKLY;INTERVAL=2", durationMinutes: 60 }')" >/dev/null
check "window: a rule it cannot honour exactly is refused" 400 "$(last_status)"
call PUT /api/v1/updates/policies "$(C="$CLUSTER_ID" W="$OPEN_ID" body '{ clusterId: e.C, name: "Approval", requireApproval: true, rebootPolicy: "NEVER", maintenanceWindowId: e.W }')" >/dev/null
check "policy: saved for the cluster" 200 "$(last_status)"
call PUT /api/v1/updates/policies "$(C="$CLUSTER_ID" body '{ clusterId: e.C, name: "No window", autoApply: true }')" >/dev/null
check "policy: updating by itself without a window is refused" 400 "$(last_status)"

J4="$(call POST "/api/v1/updates/nodes/${PVE2_ID}/run" '{}' | json id)"
check "approval: the update is accepted" 201 "$(last_status)"
check "approval: and parks for approval" WAITING_APPROVAL "$(wait_for "$J4" 60 WAITING_APPROVAL SUCCEEDED FAILED)"
check "approval: nothing ran on the node yet" 0 "$(FIXLOG | grep -c 'ops: pve2 dist-upgrade')"
call POST "/api/v1/jobs/${J4}/approve" '{"note":"harness"}' >/dev/null
check "approval: approving it runs it" SUCCEEDED "$(wait_for "$J4" 120 SUCCEEDED FAILED CANCELLED)"
contains "approval: inside the window" "Open ${RUN}" "$(logs_of "$J4" | grep -o 'Window [^,]*is open until')"

info "A window that is not open."
HOUR_LATER=$(( (HOUR_NOW + 12) % 24 ))
call PUT "/api/v1/updates/windows/${OPEN_ID}" "$(T="$TENANT_ID" H="$HOUR_LATER" R="$RUN" body '{ tenantId: e.T, name: "Open " + e.R, timezone: "UTC", rrule: "FREQ=DAILY;BYHOUR=" + e.H, durationMinutes: 60 }')" >/dev/null
check "window: moved twelve hours on" 200 "$(last_status)"
R5="$(call POST "/api/v1/updates/nodes/${PVE3_ID}/run" '{}')"
check "window: an update outside it is refused" "409 update.outside_window" "$(last_status) $(printf '%s' "$R5" | json error.code)"
contains "window: saying when it next opens" "T$(printf '%02d' "$HOUR_LATER"):00:00" "$(printf '%s' "$R5" | json error.params.nextOpening)"

info "A job approved after its window closed changes nothing."
call PUT "/api/v1/updates/windows/${OPEN_ID}" "$(T="$TENANT_ID" H="$HOUR_NOW" R="$RUN" body '{ tenantId: e.T, name: "Open " + e.R, timezone: "UTC", rrule: "FREQ=DAILY;BYHOUR=" + e.H, durationMinutes: 120 }')" >/dev/null
J6="$(call POST "/api/v1/updates/nodes/${PVE3_ID}/run" '{}' | json id)"
wait_for "$J6" 60 WAITING_APPROVAL >/dev/null
call PUT "/api/v1/updates/windows/${OPEN_ID}" "$(T="$TENANT_ID" H="$HOUR_LATER" R="$RUN" body '{ tenantId: e.T, name: "Open " + e.R, timezone: "UTC", rrule: "FREQ=DAILY;BYHOUR=" + e.H, durationMinutes: 60 }')" >/dev/null
UPGRADES_BEFORE="$(FIXLOG | grep -c 'ops: pve3 dist-upgrade')"
call POST "/api/v1/jobs/${J6}/approve" '{}' >/dev/null
check "window: the job stops at the window" FAILED "$(wait_for "$J6" 60 SUCCEEDED FAILED CANCELLED)"
check "window: as a window that closed" update.window_closed "$(job_field "$J6" errorCode)"
check "window: and the node was not touched" "$UPGRADES_BEFORE" "$(FIXLOG | grep -c 'ops: pve3 dist-upgrade')"

info "A policy that updates by itself — outside its window, then inside it."
call PUT /api/v1/updates/policies "$(C="$CLUSTER_ID" W="$OPEN_ID" body '{ clusterId: e.C, name: "Automatic", autoApply: true, rebootPolicy: "NEVER", maintenanceWindowId: e.W }')" >/dev/null
check "auto: an automatic policy with a window is saved" 200 "$(last_status)"
info "Waiting a scheduler tick with the window closed."
sleep 70
check "auto: nothing starts outside the window" 0 "$(psql_at "SELECT count(*) FROM jobs WHERE type = 'node.update' AND created_by_user_id IS NULL AND '${PVE3_ID}' = ANY(target_ids);")"
call PUT "/api/v1/updates/windows/${OPEN_ID}" "$(T="$TENANT_ID" H="$HOUR_NOW" R="$RUN" body '{ tenantId: e.T, name: "Open " + e.R, timezone: "UTC", rrule: "FREQ=DAILY;BYHOUR=" + e.H, durationMinutes: 120 }')" >/dev/null
info "Waiting for the scheduler with the window open."
AUTO=""
for _ in $(seq 1 90); do
  AUTO="$(psql_at "SELECT id FROM jobs WHERE type = 'node.update' AND created_by_user_id IS NULL AND '${PVE3_ID}' = ANY(target_ids) ORDER BY queued_at LIMIT 1;")"
  [[ -n "$AUTO" ]] && break
  sleep 1
done
if [[ -n "$AUTO" ]]; then
  green "auto: inside the window, the policy started an update"
  PASS=$((PASS + 1))
else
  red "auto: no update started inside the window"
  FAIL=$((FAIL + 1))
fi
if [[ -n "$AUTO" ]]; then
  contains "auto: and says which policy started it" 'Queued by update policy "Automatic"' "$(psql_at "SELECT message FROM job_events WHERE job_id = '${AUTO}' AND event_key = 'job.queued';")"
  wait_for "$AUTO" 120 SUCCEEDED FAILED >/dev/null
  info "Waiting a tick to see it is not started twice in one opening."
  sleep 70
  check "auto: one update per node per opening of the window" 1 "$(psql_at "SELECT count(*) FROM jobs WHERE type = 'node.update' AND created_by_user_id IS NULL AND '${PVE3_ID}' = ANY(target_ids);")"
fi

info "Who may do what."
make_user "$TENANT_ID" tenant_operator operator
OP_JAR="$WORK/operator"
check "operator: signs in" 200 "$(login "$OP_JAR" operator)"
as "$OP_JAR" call PUT /api/v1/updates/policies "$(C="$CLUSTER_ID" body '{ clusterId: e.C, name: "Mine" }')" >/dev/null
check "operator: may not set a policy (updates.manage)" 403 "$(last_status)"
make_user "$TENANT_ID" tenant_read_only reader
RD_JAR="$WORK/reader"
check "reader: signs in" 200 "$(login "$RD_JAR" reader)"
as "$RD_JAR" call GET "/api/v1/updates/nodes?clusterId=${CLUSTER_ID}" >/dev/null
check "reader: sees the updates" 200 "$(last_status)"
as "$RD_JAR" call POST "/api/v1/updates/nodes/${PVE2_ID}/run" '{}' >/dev/null
check "reader: may not run one" 403 "$(last_status)"
check "audit: windows and policies are recorded" 1 "$(psql_at "SELECT (count(*) FILTER (WHERE action = 'updates.window_saved') > 0 AND count(*) FILTER (WHERE action = 'updates.policy_saved') > 0)::int FROM audit_events WHERE at > now() - interval '1 hour';")"

printf '\n'
if ((FAIL == 0)); then
  printf '\033[0;32m%d checks passed.\033[0m\n' "$PASS"
  exit 0
fi
printf '\033[0;31m%d passed, %d failed.\033[0m\n' "$PASS" "$FAIL"
exit 1
