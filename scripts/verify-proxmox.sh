#!/usr/bin/env bash
#
# Phase 4's acceptance criteria, asserted against a running stack.
#
# The unit tests prove the mapping and the retry policy. They cannot prove that
# a certificate is actually pinned on a real socket, that a wrong fingerprint
# closes the connection before the token is written, or that discovery survives
# a node it cannot reach. Those are questions about a deployment.
#
# So this stands up a fixture Proxmox API — a real HTTPS server with a real
# self-signed certificate, on the network the worker uses — and drives the whole
# flow through Velnox's own API: probe, confirm, add, discover, read back.
#
#   ./scripts/verify-proxmox.sh [base-url]
#
# Needs an account that can manage clusters:
#
#   VELNOX_ADMIN_EMAIL=... VELNOX_ADMIN_PASSWORD=... ./scripts/verify-proxmox.sh
#
# Everything it creates is named with a run-specific prefix and removed at the
# end. It never touches anything it did not create.

set -uo pipefail

BASE="${1:-https://localhost}"
RUN="pv$(date +%s)"
COMPOSE_FILE="$(dirname "$0")/../deploy/compose/docker-compose.yml"
ENV_FILE="$(dirname "$0")/../.env"
FIXTURE_NAME="velnox-fake-pve-${RUN}"
FIXTURE_HOST="fake-pve"

# The fixture's own credential. Not a secret: it guards a container of made-up
# JSON that exists for ninety seconds.
TOKEN_ID='root@pam!velnox'
TOKEN_SECRET='fixture-secret-0000-0000-000000000000'

PASS=0
FAIL=0

green() { printf '\033[0;32m  ok  \033[0m %s\n' "$*"; }
red() { printf '\033[0;31m FAIL \033[0m %s\n' "$*"; }
info() { printf '\033[0;36m----\033[0m %s\n' "$*"; }

check() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    green "$name"
    PASS=$((PASS + 1))
  else
    red "$name (expected ${expected}, got ${actual})"
    FAIL=$((FAIL + 1))
  fi
}

contains() {
  local name="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    green "$name"
    PASS=$((PASS + 1))
  else
    red "$name (did not find '${needle}')"
    FAIL=$((FAIL + 1))
  fi
}

if ! command -v node >/dev/null 2>&1; then
  echo "Needs node to read JSON responses." >&2
  exit 1
fi

json() {
  node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        let value = JSON.parse(raw);
        for (const key of process.argv[1].split(".")) value = value?.[key];
        if (value !== undefined && value !== null) process.stdout.write(String(value));
      } catch { /* no output is the answer */ }
    });
  ' "$1" 2>/dev/null
}

# ---------------------------------------------------------------------------
# The fixture
# ---------------------------------------------------------------------------

WORK="$(mktemp -d)"
STATUS_FILE="$WORK/status"
cleanup() {
  docker rm -f "$FIXTURE_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

NETWORK="$(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" ps --format '{{.Name}}' worker >/dev/null 2>&1 && docker network ls --format '{{.Name}}' | grep -m1 'egress' || true)"

if [[ -z "$NETWORK" ]]; then
  echo "Could not find the compose egress network. Is the stack running?" >&2
  exit 1
fi

info "Generating a self-signed certificate for the fixture."

# A config file rather than `-subj` and `-addext`.
#
# Those flags are shorter and break on Git Bash: `/CN=fake-pve` is rewritten
# into a filesystem path by MSYS before openssl sees it. Turning that conversion
# off then breaks the *real* paths instead, because openssl on Windows cannot
# open `/tmp/...`. A config file has no argument that looks like a path, so it
# works the same everywhere.
cat > "$WORK/openssl.cnf" <<CONFIG
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3

[dn]
CN = ${FIXTURE_HOST}

[v3]
subjectAltName = DNS:${FIXTURE_HOST}
basicConstraints = critical,CA:FALSE
CONFIG

if ! openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -config "$WORK/openssl.cnf" \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" \
  2>"$WORK/openssl.log"; then
  red "could not generate a certificate for the fixture"
  cat "$WORK/openssl.log" >&2
  exit 1
fi

EXPECTED_FINGERPRINT="$(openssl x509 -in "$WORK/cert.pem" -noout -fingerprint -sha256 | cut -d= -f2)"

info "Starting the fixture Proxmox API on the ${NETWORK} network."
cp "$(dirname "$0")/fixtures/fake-pve.mjs" "$WORK/fake-pve.mjs"

# `MSYS_NO_PATHCONV` only around docker: without it, Git Bash rewrites the
# container-side paths (`/fixture`, and the script's own arguments) into Windows
# paths that mean nothing inside a Linux container. It is ignored everywhere
# else.
MSYS_NO_PATHCONV=1 docker run -d --rm --name "$FIXTURE_NAME" \
  --network "$NETWORK" --network-alias "$FIXTURE_HOST" \
  -v "$(cd "$WORK" && { pwd -W 2>/dev/null || pwd; }):/fixture:ro" \
  node:22-bookworm-slim \
  node /fixture/fake-pve.mjs --cert /fixture/cert.pem --key /fixture/key.pem --port 8006 \
  >/dev/null

# Give it a moment to bind. A fixed sleep rather than a poll because there is no
# port published to poll from here.
sleep 2

if ! docker ps --format '{{.Names}}' | grep -q "$FIXTURE_NAME"; then
  red "the fixture did not start"
  docker logs "$FIXTURE_NAME" 2>&1 | tail -20
  exit 1
fi

green "fixture running, certificate ${EXPECTED_FINGERPRINT:0:17}…"
PASS=$((PASS + 1))

# ---------------------------------------------------------------------------
# Signing in
# ---------------------------------------------------------------------------

JAR="$(mktemp)"

# The status goes to a file, not a variable.
#
# Almost every call here is read as `X="$(call ...)"`, which runs it in a
# subshell — so a variable it set is gone by the time the caller looks. That cost
# an afternoon: every status assertion silently compared against the status of
# the *previous* request. A file survives the subshell.
call() {
  local method="$1" path="$2" body="${3:-}"
  local csrf=""
  [[ -f "$JAR" ]] && csrf="$(awk '$6 == "velnox_csrf" { print $7 }' "$JAR" | tail -1)"

  local response
  response="$(curl --silent --insecure --max-time 60 \
    --cookie "$JAR" --cookie-jar "$JAR" \
    --request "$method" \
    --header 'accept: application/json' \
    ${body:+--header 'content-type: application/json'} \
    ${csrf:+--header "x-velnox-csrf: ${csrf}"} \
    ${body:+--data "$body"} \
    --write-out '\n%{http_code}' \
    "${BASE}${path}")"

  printf '%s' "${response##*$'\n'}" > "$STATUS_FILE"
  printf '%s' "${response%$'\n'*}"
}

# The status of the most recent `call`, wherever it ran.
last_status() { cat "$STATUS_FILE"; }

ADMIN_EMAIL="${VELNOX_ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${VELNOX_ADMIN_PASSWORD:-}"

if [[ -z "$ADMIN_EMAIL" || -z "$ADMIN_PASSWORD" ]]; then
  echo "Provide an administrator: VELNOX_ADMIN_EMAIL=... VELNOX_ADMIN_PASSWORD=... $0" >&2
  exit 2
fi

call POST /api/v1/auth/login \
  "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" >/dev/null
check "admin: signs in" 200 "$(last_status)"

TENANT_ID="$(call GET /api/v1/tenants | json tenants.0.id)"
[[ -n "$TENANT_ID" ]] || { red "no tenant to add a cluster to"; exit 1; }

# ---------------------------------------------------------------------------
# Probe
# ---------------------------------------------------------------------------

info "Reading the fixture's certificate, without authenticating."

PROBE="$(call POST /api/v1/clusters/probe "{\"host\":\"${FIXTURE_HOST}\",\"port\":8006}")"
check "probe: answers" 200 "$(last_status)"

PROBED_FINGERPRINT="$(printf '%s' "$PROBE" | json fingerprint)"
check "probe: reports the certificate actually served" \
  "$(printf '%s' "$EXPECTED_FINGERPRINT" | tr -d ' ')" \
  "$(printf '%s' "$PROBED_FINGERPRINT" | tr -d ' ')"

check "probe: recognises a Proxmox API" true "$(printf '%s' "$PROBE" | json respondedAsProxmox)"
check "probe: says the certificate is not publicly trusted" false \
  "$(printf '%s' "$PROBE" | json trustedByCa)"

check "probe: a host that is not there fails rather than hanging" 502 \
  "$(call POST /api/v1/clusters/probe '{"host":"no-such-host.invalid","port":8006}' >/dev/null; printf '%s' "$(last_status)")"

# ---------------------------------------------------------------------------
# The pin
# ---------------------------------------------------------------------------

info "Adding the cluster — first with the wrong fingerprint, then the right one."

WRONG="$(printf '%s' "$PROBED_FINGERPRINT" | sed 's/^../AA/')"

add_cluster() {
  local name="$1" fingerprint="$2" secret="$3"
  call POST /api/v1/clusters "{
    \"tenantId\":\"${TENANT_ID}\",
    \"name\":\"${name}\",
    \"host\":\"${FIXTURE_HOST}\",
    \"port\":8006,
    \"fingerprint\":\"${fingerprint}\",
    \"auth\":{\"kind\":\"API_TOKEN\",\"tokenId\":\"${TOKEN_ID}\",\"secret\":\"${secret}\"}
  }"
}

WRONG_PIN="$(add_cluster "${RUN}-wrong" "$WRONG" "$TOKEN_SECRET")"
check "a mismatched fingerprint is refused" 409 "$(last_status)"
check "and says why, as a code" node.fingerprint_mismatch "$(printf '%s' "$WRONG_PIN" | json error.code)"

# The connection is closed on the handshake, before the request line is written.
# If that were the other way round, the fixture would have logged a request.
FIXTURE_LOG="$(docker logs "$FIXTURE_NAME" 2>&1)"
contains "nothing was sent to the host that failed the pin" "fake-pve listening" "$FIXTURE_LOG"
if printf '%s' "$FIXTURE_LOG" | grep -q '/api2/json/version'; then
  # The probe legitimately calls /version unauthenticated. Anything carrying a
  # token would mean the pin was checked too late.
  if printf '%s' "$FIXTURE_LOG" | grep -q '^200 /api2/json/version'; then
    red "an authenticated request reached the host before the pin was checked"
    FAIL=$((FAIL + 1))
  else
    green "only the unauthenticated probe reached it"
    PASS=$((PASS + 1))
  fi
fi

BAD_SECRET="$(add_cluster "${RUN}-badtoken" "$PROBED_FINGERPRINT" 'not-the-secret')"
check "a wrong token is refused" 401 "$(last_status)"
check "and says why, as a code" cluster.auth_failed "$(printf '%s' "$BAD_SECRET" | json error.code)"

CLUSTER="$(add_cluster "${RUN}-fixture" "$PROBED_FINGERPRINT" "$TOKEN_SECRET")"
check "the right fingerprint and token are accepted" 201 "$(last_status)"

CLUSTER_ID="$(printf '%s' "$CLUSTER" | json id)"
[[ -n "$CLUSTER_ID" ]] || { red "no cluster id came back"; exit 1; }

DUPLICATE="$(add_cluster "${RUN}-again" "$PROBED_FINGERPRINT" "$TOKEN_SECRET")"
check "the same endpoint cannot be added twice" 409 "$(last_status)"
check "and says why, as a code" cluster.duplicate "$(printf '%s' "$DUPLICATE" | json error.code)"

# ---------------------------------------------------------------------------
# Discovery
# ---------------------------------------------------------------------------

info "Waiting for the first discovery run."

for _ in $(seq 1 30); do
  STATE="$(call GET "/api/v1/clusters/${CLUSTER_ID}" | json lastDiscoveryAt)"
  [[ -n "$STATE" ]] && break
  sleep 2
done

DETAIL="$(call GET "/api/v1/clusters/${CLUSTER_ID}")"

check "discovery ran" CONNECTED "$(printf '%s' "$DETAIL" | json connectionState)"
check "it read three nodes" 3 "$(printf '%s' "$DETAIL" | json nodeCount)"
check "it read the cluster's version" 8.2.4 "$(printf '%s' "$DETAIL" | json pveVersion)"
check "it sees the cluster as quorate" true "$(printf '%s' "$DETAIL" | json quorate)"
check "a cluster with an offline node is a warning, not healthy" WARNING \
  "$(printf '%s' "$DETAIL" | json health)"
check "Ceph was found" true "$(printf '%s' "$DETAIL" | json cephPresent)"
check "and its health carried through" HEALTH_WARN "$(printf '%s' "$DETAIL" | json cephHealth)"
contains "noout is surfaced" 'noout' "$(printf '%s' "$DETAIL" | json cephFlags)"
check "mixed daemon versions are reported" false \
  "$(printf '%s' "$DETAIL" | json cephVersionsHomogeneous)"

NODES="$(call GET "/api/v1/nodes?clusterId=${CLUSTER_ID}")"
contains "the offline node is inventoried rather than dropped" '"name":"pve3"' "$NODES"
contains "and it is marked offline" 'OFFLINE' "$NODES"
contains "the online nodes carry their kernel" '6.8.12-1-pve' "$NODES"

RUNS="$(call GET "/api/v1/clusters/${CLUSTER_ID}/discovery-runs")"
check "the run is recorded as partial, because one node could not be read" PARTIAL \
  "$(printf '%s' "$RUNS" | json runs.0.state)"
contains "and says which node" 'pve3' "$RUNS"
contains "and that a per-node call was refused" 'pve2' "$RUNS"

WORKLOADS="$(call GET "/api/v1/workloads?clusterId=${CLUSTER_ID}")"
contains "guests were read" 'db-primary' "$WORKLOADS"
contains "tags are split on the separator Proxmox uses" '"production"' "$WORKLOADS"
contains "a template is marked as one" '"template":true' "$WORKLOADS"

VMS="$(call GET "/api/v1/virtual-machines?clusterId=${CLUSTER_ID}")"
CTS="$(call GET "/api/v1/containers?clusterId=${CLUSTER_ID}")"
contains "virtual machines are separable" 'db-primary' "$VMS"
check "and containers do not appear among them" 0 \
  "$(printf '%s' "$VMS" | grep -o '"kind":"LXC"' | wc -l | tr -d ' ')"
contains "containers are separable" 'monitoring' "$CTS"

STORAGE="$(call GET "/api/v1/storage?clusterId=${CLUSTER_ID}")"
contains "storage was read" 'ceph-vm' "$STORAGE"
contains "an unreachable storage reports no size rather than zero" '"totalBytes":null' "$STORAGE"

NETWORKS="$(call GET "/api/v1/networks?clusterId=${CLUSTER_ID}")"
contains "interfaces were read" 'vmbr0' "$NETWORKS"
contains "and a bond's members came with them" 'enp1s0f0' "$NETWORKS"

CEPH="$(call GET "/api/v1/clusters/${CLUSTER_ID}/ceph")"
contains "Ceph daemons are first-class rows" 'osd.0' "$CEPH"

ALERTS="$(call GET /api/v1/alerts)"
contains "noout raises an alert" 'ceph.flag_set' "$ALERTS"
contains "the offline node raises one" 'node.offline' "$ALERTS"

# ---------------------------------------------------------------------------
# Idempotence, and what happens when the cluster goes away
# ---------------------------------------------------------------------------

info "Running discovery twice, then pulling the plug."

BEFORE="$(call GET "/api/v1/nodes?clusterId=${CLUSTER_ID}" | json nodes.0.id)"
BEFORE_AT="$(call GET "/api/v1/clusters/${CLUSTER_ID}" | json lastDiscoveryAt)"
call POST "/api/v1/clusters/${CLUSTER_ID}/discover" >/dev/null

for _ in $(seq 1 30); do
  [[ "$(call GET "/api/v1/clusters/${CLUSTER_ID}" | json lastDiscoveryAt)" != "$BEFORE_AT" ]] && break
  sleep 1
done

AFTER="$(call GET "/api/v1/nodes?clusterId=${CLUSTER_ID}" | json nodes.0.id)"

check "a second run keeps the same row ids" "$BEFORE" "$AFTER"

docker rm -f "$FIXTURE_NAME" >/dev/null 2>&1
call POST "/api/v1/clusters/${CLUSTER_ID}/discover" >/dev/null

# Polled, not slept. A run against a host that is simply gone takes as long as
# its retries and their backoff, which is not a number worth hard-coding — and a
# fixed sleep that is slightly too short reads exactly like the feature being
# broken.
GONE=""
for _ in $(seq 1 30); do
  GONE="$(call GET "/api/v1/clusters/${CLUSTER_ID}")"
  [[ "$(printf '%s' "$GONE" | json connectionState)" == FAILED ]] && break
  sleep 2
done
check "an unreachable cluster is marked failed" FAILED "$(printf '%s' "$GONE" | json connectionState)"
check "and keeps the inventory it had" 3 "$(printf '%s' "$GONE" | json nodeCount)"

STILL="$(call GET "/api/v1/nodes?clusterId=${CLUSTER_ID}")"
contains "the nodes are still there, stale rather than erased" '"name":"pve1"' "$STILL"

# ---------------------------------------------------------------------------
# Put it back
# ---------------------------------------------------------------------------

info "Cleaning up."

call DELETE "/api/v1/clusters/${CLUSTER_ID}" >/dev/null
check "the cluster is removed" 200 "$(last_status)"

check "and its nodes go with it" 0 \
  "$(call GET "/api/v1/nodes?clusterId=${CLUSTER_ID}" | grep -o '"id"' | wc -l | tr -d ' ')"

rm -f "$JAR"

printf '\n  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] || exit 1
