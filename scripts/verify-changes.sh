#!/usr/bin/env bash
#
# Verify the "something changed" stream (ADR-059) against a running stack.
#
#   bash scripts/verify-changes.sh
#
# Stands up the fixture Proxmox in its operations mode as a cluster of one
# customer tenant, and signs in three users through the API: an administrator,
# a read-only MSP user, and a read-only user of another customer. Proves, with
# curl reading the stream: a stream needs a session and says what it is; while
# open it keeps the worker reading live status for the clusters on screen,
# without a single page read, and stops when it closes; a quiet cluster sends
# nothing, a guest shutting down sends one inventory change, a job sends job
# changes gathered to at most one a second; and a user of another tenant hears
# none of it and cannot make Velnox watch a cluster that is not theirs.
#
# Then, in a real headless Chromium (scripts/changes-probe.mjs): the jobs page
# with a two-second refresh, left alone for twenty seconds, re-reads nothing and
# neither does the running-jobs bar beside it, over one shared stream; a job
# started from the page is on it within seconds; and with the stream refused,
# the page goes back to re-reading every two seconds.
#
# Needs: a running stack, node, openssl, curl, docker; velnox-backend:local for
# the fixture. The first run builds a small Chromium image.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_NATIVE="$(cd "$ROOT" && { pwd -W 2>/dev/null || pwd; })"
BASE="${1:-https://localhost}"
RUN="vc$(date +%s)"
COMPOSE=(docker compose -f "$ROOT_NATIVE/deploy/compose/docker-compose.yml" --env-file "$ROOT_NATIVE/.env")
FIXTURE_NAME="velnox-fake-pve-${RUN}"
FIXTURE_HOST="fake-pve-changes"
TOKEN_ID='root@pam!velnox'
TOKEN_SECRET='fixture-secret-0000-0000-000000000000'
BROWSER_NAME="velnox-chromium-${RUN}"
BROWSER_IMAGE="velnox-harness-chromium:1"
DEVTOOLS_PORT=9340

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

for tool in node openssl curl docker; do
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
pick() { # js expression over the JSON on stdin, as `d`
  node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{try{const d=JSON.parse(r);const v=eval(process.argv[1]);process.stdout.write(typeof v==="object"?JSON.stringify(v):String(v))}catch(e){}})' "$1"
}
body() { node -e 'const e = process.env; process.stdout.write(JSON.stringify(eval("(" + process.argv[1] + ")")))' "$1"; }
psql_at() { "${COMPOSE[@]}" exec -T postgres psql -U velnox -d velnox -v ON_ERROR_STOP=1 -Atc "$1"; }
# The live-status watches that have not lapsed.
watches() {
  "${COMPOSE[@]}" exec -T redis sh -c "redis-cli --no-auth-warning \${REDIS_PASSWORD:+-a \"\$REDIS_PASSWORD\"} zrangebyscore velnox:live:watch $(node -p 'Date.now()') +inf" 2>/dev/null | tr -d '\r'
}

WORK="$(mktemp -d)"
WORK_NATIVE="$(cd "$WORK" && { pwd -W 2>/dev/null || pwd; })"
JAR="$WORK/cookies"
STATUS_FILE="$WORK/status"
CREATED_USERS=()
CLUSTER_ID=""

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

make_user() { # tenant role label → id
  local tenant="$1" role="$2" label="$3" pw hash id
  pw="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')"
  printf '%s' "$pw" >"$WORK/pw-${label}"
  hash="$(P="$pw" node -e 'require(process.argv[1]).hashPassword(process.env.P).then((h) => process.stdout.write(h));' "$ROOT_NATIVE/packages/crypto/dist/index.js")"
  [[ "$hash" == \$argon2id\$* ]] || { red "could not hash a password (is @velnox/crypto built?)"; exit 1; }
  id="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
  psql_at "INSERT INTO users (id, tenant_id, email, display_name, password_hash, updated_at)
           VALUES ('${id}', '${tenant}', '${RUN}-${label}@example.invalid', 'Change stream verification', '${hash}', now());" >/dev/null
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

# A stream, read by curl in the background for some seconds into a file.
stream() { # jar query seconds file
  curl --silent --insecure --no-buffer --max-time "$3" --cookie "$1" \
    --header 'accept: text/event-stream' "${BASE}/api/v1/changes?$2" >"$4" 2>/dev/null &
}
# The data of one kind of event in a stream's file, one per line.
events() { # file type
  awk -v want="$2" '/^event: /{type=substr($0, 8)} /^data: /{if (type == want) print substr($0, 7)} /^$/{type=""}' "$1" | tr -d '\r'
}
count() { # file type topic
  events "$1" "$2" | grep -c "\"topic\":\"$3\"" || true
}

# shellcheck disable=SC2329  # called by the EXIT trap below
cleanup() {
  [[ -n "$CLUSTER_ID" ]] && call DELETE "/api/v1/clusters/${CLUSTER_ID}" >/dev/null 2>&1
  docker rm -f "$FIXTURE_NAME" "$BROWSER_NAME" >/dev/null 2>&1 || true
  for user in "${CREATED_USERS[@]}"; do
    psql_at "UPDATE users SET status = 'DISABLED' WHERE id = '${user}';" >/dev/null 2>&1
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# The fixture, and who is looking
# ---------------------------------------------------------------------------

NETWORK="$(docker network ls --format '{{.Name}}' | grep -m1 'egress' || true)"
[[ -n "$NETWORK" ]] || { echo "Could not find the compose egress network. Is the stack running?" >&2; exit 1; }
docker image inspect velnox-backend:local >/dev/null 2>&1 || { echo "Build the stack first: the fixture runs in velnox-backend:local." >&2; exit 1; }

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
  -v "${WORK_NATIVE}:/fixture" \
  --entrypoint node velnox-backend:local \
  /fixture/fake-pve.mjs --cert /fixture/cert.pem --key /fixture/key.pem --port 8006 \
  --storage-dir /fixture/store --node-address "$FIXTURE_HOST" --ops >/dev/null
sleep 3
docker ps --format '{{.Names}}' | grep -q "$FIXTURE_NAME" || { red "the fixture did not start"; docker logs "$FIXTURE_NAME" 2>&1 | tail -20; exit 1; }
pve() { MSYS_NO_PATHCONV=1 docker exec "$FIXTURE_NAME" node /fixture/pvecall.mjs "$@"; }

MSP="$(psql_at "SELECT id FROM tenants WHERE kind = 'MSP_ROOT';")"
if [[ -n "${VELNOX_ADMIN_EMAIL:-}" && -n "${VELNOX_ADMIN_PASSWORD:-}" ]]; then
  call POST /api/v1/auth/login "$(body '{ email: e.VELNOX_ADMIN_EMAIL, password: e.VELNOX_ADMIN_PASSWORD }')" >/dev/null
  check "admin: signs in" 200 "$(last_status)"
else
  make_user "$MSP" msp_super_administrator admin
  check "admin: signs in" 200 "$(login "$JAR" admin)"
fi
unset VELNOX_ADMIN_PASSWORD

read -r TENANT_ID OTHER_TENANT <<<"$(call GET /api/v1/tenants | pick 'd.tenants.filter(x=>x.kind!=="MSP_ROOT"&&x.status==="ACTIVE").slice(0,2).map(t=>t.id).join(" ")')"
[[ -n "$TENANT_ID" && -n "$OTHER_TENANT" ]] || { red "needs two active customer tenants"; exit 1; }
CLUSTER="$(call POST /api/v1/clusters "$(T="$TENANT_ID" R="$RUN" H="$FIXTURE_HOST" F="$TLS_FINGERPRINT" I="$TOKEN_ID" S="$TOKEN_SECRET" body '{ tenantId: e.T, name: e.R, host: e.H, port: 8006, fingerprint: e.F, auth: { kind: "API_TOKEN", tokenId: e.I, secret: e.S } }')")"
LEFTOVER="$(printf '%s' "$CLUSTER" | json error.params.clusterId)"
if [[ "$(printf '%s' "$CLUSTER" | json error.code)" == cluster.duplicate && -n "$LEFTOVER" ]]; then
  info "Removing a cluster an interrupted run left behind."
  call DELETE "/api/v1/clusters/${LEFTOVER}" >/dev/null
  CLUSTER="$(call POST /api/v1/clusters "$(T="$TENANT_ID" R="$RUN" H="$FIXTURE_HOST" F="$TLS_FINGERPRINT" I="$TOKEN_ID" S="$TOKEN_SECRET" body '{ tenantId: e.T, name: e.R, host: e.H, port: 8006, fingerprint: e.F, auth: { kind: "API_TOKEN", tokenId: e.I, secret: e.S } }')")"
fi
CLUSTER_ID="$(printf '%s' "$CLUSTER" | json id)"
[[ -n "$CLUSTER_ID" ]] || { red "no cluster to test against: $(printf '%s' "$CLUSTER" | head -c 300)"; exit 1; }
for _ in $(seq 1 60); do
  [[ -n "$(call GET "/api/v1/clusters/${CLUSTER_ID}" | json lastDiscoveryAt)" ]] && break
  sleep 1
done
check "cluster: discovered" yes "$([[ -n "$(call GET "/api/v1/clusters/${CLUSTER_ID}" | json lastDiscoveryAt)" ]] && printf yes)"

make_user "$MSP" msp_read_only viewer
check "a read-only MSP user signs in" 200 "$(login "$WORK/viewer.jar" viewer)"
make_user "$OTHER_TENANT" tenant_read_only other
check "a read-only user of another customer signs in" 200 "$(login "$WORK/other.jar" other)"

# ---------------------------------------------------------------------------
# The stream itself
# ---------------------------------------------------------------------------

info "What a stream needs, and what it says first."
check "no session: refused" 401 "$(curl --silent --insecure --max-time 10 --output /dev/null --write-out '%{http_code}' "${BASE}/api/v1/changes?topics=jobs")"
check "no topic: refused" 400 "$(curl --silent --insecure --max-time 10 --cookie "$WORK/viewer.jar" --output /dev/null --write-out '%{http_code}' "${BASE}/api/v1/changes")"
check "a topic it does not know: refused" 400 "$(curl --silent --insecure --max-time 10 --cookie "$WORK/viewer.jar" --output /dev/null --write-out '%{http_code}' "${BASE}/api/v1/changes?topics=secrets")"
check "an interval it does not offer: refused" 400 "$(curl --silent --insecure --max-time 10 --cookie "$WORK/viewer.jar" --output /dev/null --write-out '%{http_code}' "${BASE}/api/v1/changes?topics=jobs&refresh=1")"
stream "$WORK/viewer.jar" "topics=jobs" 3 "$WORK/first"
wait
check "it is an event stream" "text/event-stream" "$(curl --silent --insecure --max-time 3 --cookie "$WORK/viewer.jar" --output /dev/null --write-out '%{content_type}' "${BASE}/api/v1/changes?topics=jobs" | cut -d';' -f1)"
check "it starts by saying what it listens for" '{"topics":["jobs"],"watching":0}' "$(events "$WORK/first" ready)"
contains "and how soon to reconnect" "retry: 3000" "$(tr -d '\r' <"$WORK/first")"

info "Live status, kept read while a screen with the cluster is open — and nothing else."
# Nobody has read a page with the cluster on it: no watch yet, from anyone.
for _ in $(seq 1 15); do [[ "$(watches)" != *"${CLUSTER_ID}:"* ]] && break; sleep 1; done
check "before: the cluster is not watched" "" "$(watches | grep "${CLUSTER_ID}" || true)"
stream "$WORK/other.jar" "topics=inventory,jobs&clusters=${CLUSTER_ID}&refresh=5" 30 "$WORK/other"
stream "$WORK/viewer.jar" "topics=inventory,jobs&clusters=${CLUSTER_ID}&refresh=2" 30 "$WORK/viewer"
sleep 2
check "another customer's user: told it watches nothing" '{"topics":["inventory","jobs"],"watching":0}' "$(events "$WORK/other" ready)"
check "the MSP user: told it watches the cluster" '{"topics":["inventory","jobs"],"watching":1}' "$(events "$WORK/viewer" ready)"
# Past the ten seconds a watch outlives the read that made it: renewed by the
# stream, with no page read at all.
sleep 12
check "after 14 s, no page read: watched at the viewer's interval" "${CLUSTER_ID}:2" "$(watches | grep "${CLUSTER_ID}" | sort -u | tr '\n' ' ' | sed 's/ $//')"
lacks "another customer's user could not make Velnox watch it" "${CLUSTER_ID}:5" "$(watches)"

# Quiet: the fixture changes nothing but its uptime.
QUIET_BEFORE="$(count "$WORK/viewer" change inventory)"
sleep 6
check "a quiet cluster: no inventory change in 6 s" "$QUIET_BEFORE" "$(count "$WORK/viewer" change inventory)"
pve POST /nodes/pve2/qemu/101/status/shutdown >/dev/null
sleep 6
check "a guest shut down: one inventory change, naming the cluster" "{\"topic\":\"inventory\",\"clusterId\":\"${CLUSTER_ID}\"}" "$(events "$WORK/viewer" change | grep inventory | tail -1)"
check "and only one" "$((QUIET_BEFORE + 1))" "$(count "$WORK/viewer" change inventory)"
check "the shutdown is in the inventory it signalled" stopped "$(call GET "/api/v1/workloads?clusterId=${CLUSTER_ID}" | pick '(d.workloads||d).find(w=>w.vmid===101).state.toLowerCase()')"
wait
check "another customer's user heard nothing of it" "" "$(events "$WORK/other" change)"
sleep 12
check "the stream closed: the watch lapses" "" "$(watches | grep "${CLUSTER_ID}" || true)"

info "Jobs: heard where jobs may be read, gathered to one a second."
stream "$WORK/viewer.jar" "topics=jobs" 20 "$WORK/viewer-jobs"
stream "$WORK/other.jar" "topics=jobs" 20 "$WORK/other-jobs"
sleep 2
JOB="$(call POST /api/v1/jobs/selftest '{"lane":"changes","steps":4,"secondsPerStep":1}' | json id)"
check "a self-test job starts" 201 "$(last_status)"
wait
JOB_CHANGES="$(count "$WORK/viewer-jobs" change jobs)"
check "the MSP user heard it" yes "$([[ "$JOB_CHANGES" -ge 1 ]] && printf yes)"
check "as a job change, with nothing about which job" '{"topic":"jobs","clusterId":null}' "$(events "$WORK/viewer-jobs" change | sort -u)"
check "gathered: at most one a second, over 18 s" yes "$([[ "$JOB_CHANGES" -le 19 ]] && printf yes)"
check "the job ran to the end meanwhile" SUCCEEDED "$(call GET "/api/v1/jobs/${JOB}" | json status)"
check "another customer's user heard nothing of an MSP job" "" "$(events "$WORK/other-jobs" change)"

# ---------------------------------------------------------------------------
# A real browser
# ---------------------------------------------------------------------------

if ! docker image inspect "$BROWSER_IMAGE" >/dev/null 2>&1; then
  info "Building ${BROWSER_IMAGE} (once)."
  docker build --quiet --tag "$BROWSER_IMAGE" - >/dev/null <<'DOCKERFILE' || { red "could not build the Chromium image"; exit 1; }
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium socat fonts-dejavu-core ca-certificates \
 && rm -rf /var/lib/apt/lists/*
DOCKERFILE
fi

info "Chromium: the jobs page, with a two-second refresh."
docker run --detach --name "$BROWSER_NAME" --add-host=host.docker.internal:host-gateway \
  --publish "127.0.0.1:${DEVTOOLS_PORT}:9223" "$BROWSER_IMAGE" sh -c '
    socat TCP-LISTEN:443,fork,reuseaddr TCP:host.docker.internal:443 &
    socat TCP-LISTEN:9223,fork,reuseaddr TCP:127.0.0.1:9222 &
    exec chromium --headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage \
      --remote-debugging-port=9222 --user-data-dir=/tmp/profile --ignore-certificate-errors about:blank' >/dev/null
ready=no
for _ in $(seq 1 30); do
  curl --silent --max-time 2 "http://127.0.0.1:${DEVTOOLS_PORT}/json/version" >/dev/null && { ready=yes; break; }
  sleep 1
done
check "chromium is up" yes "$ready"
# The administrator's session: the page starts a self-test job, as one would.
node -e '
  const lines = require("fs").readFileSync(process.argv[1], "utf8").split(/\r?\n/);
  const cookies = lines.filter((l) => l.trim() && (!l.startsWith("#") || l.startsWith("#HttpOnly_"))).map((l) => {
    const [domain, , path, secure, , name, value] = l.split("\t");
    return { name, value, path, secure: secure === "TRUE", httpOnly: domain.startsWith("#HttpOnly_") };
  });
  require("fs").writeFileSync(process.argv[2], JSON.stringify(cookies));
' "$JAR" "$WORK/browser-cookies.json"
R="$(node "$ROOT_NATIVE/scripts/changes-probe.mjs" "http://127.0.0.1:${DEVTOOLS_PORT}" "https://localhost" "$WORK_NATIVE/browser-cookies.json")"
check "probe: ran to the end" ran "$(printf '%s' "$R" | pick 'd.error ? "error: " + d.error : "ran"')"
check "signed in, in the browser" true "$(printf '%s' "$R" | json signedIn)"
check "one stream, for the page and the running-jobs bar together" 1 "$(printf '%s' "$R" | json streamsOnOpen)"
check "20 s with nothing happening: the page re-read nothing (polling: ~10)" 0 "$(printf '%s' "$R" | json idle.refreshes)"
check "nor did the running-jobs bar (polling: ~10)" 0 "$(printf '%s' "$R" | json idle.jobLists)"
check "and the stream stayed open" 0 "$(printf '%s' "$R" | json idle.streams)"
check "a job started from the page" 201 "$(printf '%s' "$R" | json job.status)"
check "the page re-read within 3 s of it" yes "$(printf '%s' "$R" | pick 'd.refreshAfterJobMs!==null&&d.refreshAfterJobMs<=3000?"yes":"no: "+d.refreshAfterJobMs')"
check "and shows it" true "$(printf '%s' "$R" | json jobShown)"
check "while it ran, never more often than every 2 s" yes "$(printf '%s' "$R" | pick 'd.whileRunning.refreshes>=1&&d.whileRunning.refreshes<=7?"yes":"no: "+d.whileRunning.refreshes')"
check "the stream refused: back to every 2 s" yes "$(printf '%s' "$R" | pick 'd.fallback.refreshes>=4?"yes":"no: "+d.fallback.refreshes')"

printf '\n'
if ((FAIL == 0)); then
  printf '\033[0;32m%d checks passed.\033[0m\n' "$PASS"
  exit 0
fi
printf '\033[0;31m%d passed, %d failed.\033[0m\n' "$PASS" "$FAIL"
exit 1
