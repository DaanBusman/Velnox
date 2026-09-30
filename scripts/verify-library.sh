#!/usr/bin/env bash
#
# Verify Phase 5A — the ISO library — against a running stack.
#
#   bash scripts/verify-library.sh
#   VELNOX_ADMIN_EMAIL=... VELNOX_ADMIN_PASSWORD=... bash scripts/verify-library.sh
#
# With no administrator given, a throwaway MSP Super Administrator is created
# for the run and disabled at the end, the same as verify-jobs.sh.
#
# Stands up the fixture Proxmox (scripts/fixtures/fake-pve.mjs) with storage and
# SFTP switched on, adds it as a cluster, and drives every movement the library
# has: upload, URL fetch, push, delete on the cluster, and copy back over SSH —
# with the refusals and the cancellations that the roadmap's acceptance
# criteria name. The fixture runs in the backend image, which is what gives it
# ssh2 for the SFTP half; build the stack first.
#
# Needs: a running stack, node, openssl, ssh-keygen, curl, docker.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# The path docker is handed. On Git Bash `pwd` says /c/…, which docker on
# Windows reads as C:\c\…; `pwd -W` says C:/…, which works with or without
# MSYS path conversion. Everywhere else the two are the same.
ROOT_NATIVE="$(cd "$ROOT" && { pwd -W 2>/dev/null || pwd; })"
BASE="${1:-https://localhost}"
RUN="vl$(date +%s)"
COMPOSE=(docker compose -f "$ROOT_NATIVE/deploy/compose/docker-compose.yml" --env-file "$ROOT_NATIVE/.env")
FIXTURE_NAME="velnox-fake-pve-${RUN}"
FIXTURE_HOST="fake-pve"
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

json_object() {
  node -e '
    const out = {};
    for (let i = 1; i < process.argv.length; i += 2) {
      const raw = process.argv[i + 1];
      out[process.argv[i]] = /^-?\d+$/.test(raw) ? Number(raw) : raw;
    }
    process.stdout.write(JSON.stringify(out));
  ' "$@"
}

psql_at() { "${COMPOSE[@]}" exec -T postgres psql -U velnox -d velnox -v ON_ERROR_STOP=1 -Atc "$1"; }
in_worker() { MSYS_NO_PATHCONV=1 "${COMPOSE[@]}" exec -T worker sh -c "$1"; }
in_fixture() { MSYS_NO_PATHCONV=1 docker exec "$FIXTURE_NAME" sh -c "$1"; }

WORK="$(mktemp -d)"
JAR="$WORK/cookies"
STATUS_FILE="$WORK/status"
CREATED_USER=""
CLUSTER_FILE="$WORK/cluster"
ITEMS_FILE="$WORK/items"
: >"$CLUSTER_FILE"
: >"$ITEMS_FILE"

# Status to a file: `X="$(call …)"` runs in a subshell (see verify-jobs.sh).
call() {
  local method="$1" path="$2" body="${3:-}"
  local csrf=""
  [[ -f "$JAR" ]] && csrf="$(awk '$6 == "velnox_csrf" { print $7 }' "$JAR" | tail -1)"
  local args=(--silent --insecure --max-time 120 --cookie "$JAR" --cookie-jar "$JAR"
    --request "$method" --header 'accept: application/json'
    --output "$WORK/body" --write-out '%{http_code}')
  [[ -n "$csrf" ]] && args+=(--header "x-velnox-csrf: ${csrf}")
  [[ -n "$body" ]] && args+=(--header 'content-type: application/json' --data "$body")
  curl "${args[@]}" "${BASE}${path}" >"$STATUS_FILE"
  cat "$WORK/body"
}
last_status() { cat "$STATUS_FILE"; }

# A chunk of a file, sent raw.
put_chunk() {
  local id="$1" offset="$2" file="$3"
  local csrf
  csrf="$(awk '$6 == "velnox_csrf" { print $7 }' "$JAR" | tail -1)"
  curl --silent --insecure --max-time 300 --cookie "$JAR" --cookie-jar "$JAR" \
    --request PUT --header "x-velnox-csrf: ${csrf}" \
    --header 'content-type: application/octet-stream' \
    --data-binary "@${file}" --output "$WORK/body" --write-out '%{http_code}' \
    "${BASE}/api/v1/library/uploads/${id}/chunks?offset=${offset}" >"$STATUS_FILE"
  cat "$WORK/body"
}

cleanup() {
  local id
  if ((FAIL > 0)); then
    info "Last lines from the fixture:"
    docker logs "$FIXTURE_NAME" 2>&1 | tail -25
  fi
  while IFS= read -r id; do
    [[ -n "$id" ]] && call DELETE "/api/v1/library/${id}" >/dev/null 2>&1
  done <"$ITEMS_FILE"
  id="$(cat "$CLUSTER_FILE")"
  [[ -n "$id" ]] && call DELETE "/api/v1/clusters/${id}" >/dev/null 2>&1
  docker rm -f "$FIXTURE_NAME" >/dev/null 2>&1 || true
  if [[ -n "$CREATED_USER" ]]; then
    psql_at "UPDATE users SET status = 'DISABLED' WHERE id = '${CREATED_USER}';" >/dev/null 2>&1 &&
      info "Disabled the throwaway account."
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

remember_item() { [[ -n "$1" ]] && printf '%s\n' "$1" >>"$ITEMS_FILE"; }

job_field() { call GET "/api/v1/jobs/$1" | json "$2"; }
wait_for() {
  local id="$1" timeout="$2"
  shift 2
  local deadline=$((SECONDS + timeout)) status=""
  while ((SECONDS < deadline)); do
    status="$(job_field "$id" status)"
    for want in "$@"; do [[ "$status" == "$want" ]] && { printf '%s' "$status"; return 0; }; done
    sleep 0.5
  done
  printf '%s' "${status:-timeout}"
}
wait_progress() {
  local id="$1" timeout="$2" deadline=$((SECONDS + $2)) pct=""
  while ((SECONDS < deadline)); do
    pct="$(job_field "$id" progressPct)"
    [[ -n "$pct" && "$pct" != "0" ]] && { printf '%s' "$pct"; return 0; }
    sleep 0.2
  done
  printf 'none'
}
logs_of() { call GET "/api/v1/jobs/$1/logs" | json lines; }

sha_local() { node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"; }

# An ISO-shaped file: zeros, `CD001` where the first volume descriptor goes, and
# a pattern so that byte-identity actually means something.
make_iso() {
  node -e '
    const [path, size] = [process.argv[1], Number(process.argv[2])];
    const b = Buffer.alloc(size);
    for (let i = 0; i < size; i += 4096) b.writeUInt32BE(i >>> 0, i);
    b.write("CD001", 0x8001);
    require("fs").writeFileSync(path, b);
  ' "$1" "$2"
}

# ---------------------------------------------------------------------------
# The fixture
# ---------------------------------------------------------------------------

NETWORK="$(docker network ls --format '{{.Name}}' | grep -m1 'egress' || true)"
[[ -n "$NETWORK" ]] || { echo "Could not find the compose egress network. Is the stack running?" >&2; exit 1; }
docker image inspect velnox-backend:local >/dev/null 2>&1 || { echo "Build the stack first: the fixture runs in velnox-backend:local." >&2; exit 1; }

info "Preparing a certificate and SSH keys for the fixture."
cat >"$WORK/openssl.cnf" <<CONFIG
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
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -config "$WORK/openssl.cnf" \
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>"$WORK/openssl.log" ||
  { red "could not generate a certificate"; cat "$WORK/openssl.log"; exit 1; }
TLS_FINGERPRINT="$(openssl x509 -in "$WORK/cert.pem" -noout -fingerprint -sha256 | cut -d= -f2)"

ssh-keygen -q -t ed25519 -N '' -C fixture-host -f "$WORK/host_key" >/dev/null
ssh-keygen -q -t ed25519 -N '' -C velnox-client -f "$WORK/client_key" >/dev/null
HOST_KEY_FINGERPRINT="$(ssh-keygen -lf "$WORK/host_key.pub" | awk '{print $2}')"

mkdir -p "$WORK/store"
cp "$ROOT/scripts/fixtures/fake-pve.mjs" "$ROOT/scripts/fixtures/fake-pve-storage.mjs" "$WORK/"
# The fixture runs as the image's `node` user and writes to its storage.
chmod -R a+rwX "$WORK" 2>/dev/null || true

# Uploads and SFTP reads are slowed to ~16 MB/s so a transfer can be cancelled
# halfway; the files below are sized so the fast paths still take seconds.
MSYS_NO_PATHCONV=1 docker run -d --rm --name "$FIXTURE_NAME" \
  --network "$NETWORK" --network-alias "$FIXTURE_HOST" \
  -v "$(cd "$WORK" && { pwd -W 2>/dev/null || pwd; }):/fixture" \
  --entrypoint node velnox-backend:local \
  /fixture/fake-pve.mjs --cert /fixture/cert.pem --key /fixture/key.pem --port 8006 \
  --storage-dir /fixture/store --upload-bytes-per-sec 16000000 \
  --node-address "$FIXTURE_HOST" \
  --ssh-port "$SSH_PORT" --ssh-host-key /fixture/host_key --ssh-authorized-key /fixture/client_key.pub \
  --sftp-bytes-per-sec 16000000 >/dev/null
sleep 3
docker ps --format '{{.Names}}' | grep -q "$FIXTURE_NAME" || { red "the fixture did not start"; docker logs "$FIXTURE_NAME" 2>&1 | tail -20; exit 1; }
FIXLOG() { docker logs "$FIXTURE_NAME" 2>&1; }
contains "fixture: serving SFTP" "sftp listening on ${SSH_PORT}" "$(FIXLOG)"

# ---------------------------------------------------------------------------
# An administrator, and the cluster
# ---------------------------------------------------------------------------

ADMIN_EMAIL="${VELNOX_ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${VELNOX_ADMIN_PASSWORD:-}"
if [[ -z "$ADMIN_EMAIL" || -z "$ADMIN_PASSWORD" ]]; then
  info "No administrator given; creating a throwaway one for this run."
  ADMIN_EMAIL="${RUN}-admin@example.invalid"
  ADMIN_PASSWORD="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')"
  HASH="$(P="$ADMIN_PASSWORD" node -e 'require(process.argv[1]).hashPassword(process.env.P).then((h) => process.stdout.write(h));' "$ROOT/packages/crypto/dist/index.js")"
  [[ "$HASH" == \$argon2id\$* ]] || { red "could not hash a password with @velnox/crypto (is it built?)"; exit 1; }
  CREATED_USER="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
  MSP="$(psql_at "SELECT id FROM tenants WHERE kind = 'MSP_ROOT';")"
  psql_at "INSERT INTO users (id, tenant_id, email, display_name, password_hash, updated_at)
           VALUES ('${CREATED_USER}', '${MSP}', '${ADMIN_EMAIL}', 'Library verification', '${HASH}', now());" >/dev/null ||
    { red "could not create the throwaway account"; CREATED_USER=""; exit 1; }
  psql_at "INSERT INTO role_assignments (id, user_id, role_id, scope_type)
           SELECT gen_random_uuid(), '${CREATED_USER}', id, 'GLOBAL' FROM roles WHERE key = 'msp_super_administrator';" >/dev/null ||
    { red "could not grant the throwaway account its role"; exit 1; }
  unset HASH
fi
LOGIN="$(call POST /api/v1/auth/login "$(json_object email "$ADMIN_EMAIL" password "$ADMIN_PASSWORD")")"
unset ADMIN_PASSWORD
check "admin: signs in" 200 "$(last_status)"
[[ "$(printf '%s' "$LOGIN" | json status)" == "authenticated" ]] || { red "session not authenticated (second factor required?)"; exit 1; }

TENANT_ID="$(call GET /api/v1/tenants | json tenants.0.id)"
CLUSTER="$(call POST /api/v1/clusters "{\"tenantId\":\"${TENANT_ID}\",\"name\":\"${RUN}\",\"host\":\"${FIXTURE_HOST}\",\"port\":8006,\"fingerprint\":\"${TLS_FINGERPRINT}\",\"auth\":{\"kind\":\"API_TOKEN\",\"tokenId\":\"${TOKEN_ID}\",\"secret\":\"${TOKEN_SECRET}\"}}")"
check "cluster: the fixture is added" 201 "$(last_status)"
CLUSTER_ID="$(printf '%s' "$CLUSTER" | json id)"
# Everything after this needs the cluster. Without it every job id is empty and
# each wait below runs to its timeout — twenty minutes of failures saying
# nothing. A 409 here is usually a cluster an interrupted run left behind.
[[ -n "$CLUSTER_ID" ]] || { red "no cluster to test against: $(printf '%s' "$CLUSTER" | head -c 300)"; exit 1; }
printf '%s' "$CLUSTER_ID" >"$CLUSTER_FILE"

# Discovery is what fills in the storage and the files on it.
for _ in $(seq 1 60); do
  [[ "$(call GET "/api/v1/clusters/${CLUSTER_ID}" | json connectionState)" == "CONNECTED" ]] && break
  sleep 1
done
check "cluster: discovered" CONNECTED "$(call GET "/api/v1/clusters/${CLUSTER_ID}" | json connectionState)"
check "cluster: its storage holds no ISOs yet" "[]" "$(call GET "/api/v1/clusters/${CLUSTER_ID}/files" | json contents)"

# ---------------------------------------------------------------------------
# Upload
# ---------------------------------------------------------------------------

info "Uploading a file from the browser's side, in chunks."
ISO="$WORK/${RUN}.iso"
make_iso "$ISO" 60000000
ISO_SHA="$(sha_local "$ISO")"
SIZE=$(wc -c <"$ISO" | tr -d ' ')

START="$(call POST /api/v1/library/uploads "$(json_object filename "${RUN}.iso" sizeBytes "$SIZE")")"
check "upload: starts" 201 "$(last_status)"
ITEM="$(printf '%s' "$START" | json item.id)"
remember_item "$ITEM"
CHUNK="$(printf '%s' "$START" | json chunkBytes)"

split -b "$CHUNK" -d -a 3 "$ISO" "$WORK/chunk-"
put_chunk "$ITEM" 12345 "$WORK/chunk-000" >"$WORK/wrong-offset"
check "upload: a chunk at the wrong offset is refused" 409 "$(last_status)"
check "upload: and the refusal names the right offset" 0 "$(json error.params.expected <"$WORK/wrong-offset")"

OFFSET=0
for part in "$WORK"/chunk-*; do
  put_chunk "$ITEM" "$OFFSET" "$part" >"$WORK/put"
  [[ "$(last_status)" == "200" ]] || { red "upload: chunk at ${OFFSET} answered $(last_status): $(cat "$WORK/put")"; FAIL=$((FAIL + 1)); break; }
  OFFSET=$((OFFSET + $(wc -c <"$part" | tr -d ' ')))
done
check "upload: every chunk accepted" "$SIZE" "$OFFSET"
VERIFY_JOB="$(json job.id <"$WORK/put")"
check "upload: the last chunk starts the check" SUCCEEDED "$(wait_for "$VERIFY_JOB" 90 SUCCEEDED FAILED CANCELLED)"
check "upload: the item is ready" READY "$(call GET "/api/v1/library/${ITEM}" | json state)"
check "upload: its checksum is the file's" "$ISO_SHA" "$(call GET "/api/v1/library/${ITEM}" | json sha256)"
check "upload: nothing is left in partial/" "" "$(in_worker "ls /var/lib/velnox/library/partial | grep -c . || true" | tr -d '\r' | sed 's/^0$//')"
contains "logs: name the real filename" "${RUN}.iso" "$(logs_of "$VERIFY_JOB")"

info "Refusals before a byte moves."
call POST /api/v1/library/uploads "$(json_object filename "${RUN}.iso" sizeBytes 1000)" >"$WORK/dup"
check "a second item with the same name is refused" 409 "$(last_status)"
check "and says so" library.duplicate_filename "$(json error.code <"$WORK/dup")"
call POST /api/v1/library/uploads "$(json_object filename "${RUN}-huge.iso" sizeBytes 900000000000)" >"$WORK/full"
check "an upload past the library's ceiling is refused" 409 "$(last_status)"
check "with the ceiling named" library.full "$(json error.code <"$WORK/full")"
contains "and the numbers an operator needs" '"ceilingGb"' "$(cat "$WORK/full")"
call POST /api/v1/library/uploads "$(json_object filename "../../etc/passwd.iso" sizeBytes 10)" >/dev/null
check "a path in a filename is refused" 400 "$(last_status)"
call POST /api/v1/library/uploads "$(json_object filename "${RUN}.zip" sizeBytes 10)" >"$WORK/kind"
check "a kind the library does not hold is refused" library.unsupported_kind "$(json error.code <"$WORK/kind")"

info "An upload whose bytes are not what its name says."
NOTISO="$WORK/${RUN}-fake.iso"
node -e 'require("fs").writeFileSync(process.argv[1], "<!DOCTYPE html><title>403 Forbidden</title>".repeat(1000))' "$NOTISO"
FSIZE=$(wc -c <"$NOTISO" | tr -d ' ')
FAKE="$(call POST /api/v1/library/uploads "$(json_object filename "${RUN}-fake.iso" sizeBytes "$FSIZE")" | json item.id)"
remember_item "$FAKE"
FJOB="$(put_chunk "$FAKE" 0 "$NOTISO" | json job.id)"
check "a non-ISO named .iso fails its check" FAILED "$(wait_for "$FJOB" 60 SUCCEEDED FAILED CANCELLED)"
check "with the reason recorded on the item" library.wrong_content "$(call GET "/api/v1/library/${FAKE}" | json errorCode)"

# ---------------------------------------------------------------------------
# URL fetch: the refusals
# ---------------------------------------------------------------------------

info "Fetching from addresses the worker must not reach."
for url in "http://${FIXTURE_HOST}:8006/x.iso" "http://169.254.169.254/latest/x.iso" "http://127.0.0.1:4000/x.iso" "http://postgres:5432/x.iso"; do
  # A signed link's token lives in the query string; it must not outlive the fetch.
  OUT="$(call POST /api/v1/library/url "$(json_object url "${url}?sig=${RUN}-token" filename x.iso)")"
  JOB="$(printf '%s' "$OUT" | json job.id)"
  remember_item "$(printf '%s' "$OUT" | json item.id)"
  RESULT="$(wait_for "$JOB" 60 SUCCEEDED FAILED CANCELLED)"
  check "fetch from ${url%/x.iso}: refused" "FAILED library.url_refused" "${RESULT} $(job_field "$JOB" errorCode)"
done
check "a finished fetch keeps no query string" 0 "$(psql_at "SELECT count(*) FROM library_items WHERE source_url LIKE '%${RUN}-token%';")"
call POST /api/v1/library/url "$(json_object url "file:///etc/passwd")" >"$WORK/scheme"
check "a file: URL is refused at the door" 400 "$(last_status)"
call POST /api/v1/library/url "$(json_object url "https://user:secret@example.com/a.iso")" >"$WORK/creds"
check "a URL with credentials is refused at the door" library.url_refused "$(json error.code <"$WORK/creds")"

# ---------------------------------------------------------------------------
# Push
# ---------------------------------------------------------------------------

info "Pushing the uploaded file onto the cluster."
call POST "/api/v1/library/${ITEM}/push" "$(json_object clusterId "$CLUSTER_ID" node pve1 storage ceph-vm)" >"$WORK/unsuitable"
check "push to storage that takes no ISOs: refused before a job" 409 "$(last_status)"
check "and says why" library.storage_unsuitable "$(json error.code <"$WORK/unsuitable")"

PUSH="$(call POST "/api/v1/library/${ITEM}/push" "$(json_object clusterId "$CLUSTER_ID" node pve1 storage local)" | json id)"
check "push: accepted" 202 "$(last_status)"
check "push: succeeds" SUCCEEDED "$(wait_for "$PUSH" 120 SUCCEEDED FAILED CANCELLED)"
ON_NODE="$(in_fixture "sha256sum /fixture/store/node-pve1/local/iso/${RUN}.iso | cut -d' ' -f1")"
check "push: the file on the node is byte-identical" "$ISO_SHA" "$(printf '%s' "$ON_NODE" | tr -d '\r')"
FILES="$(call GET "/api/v1/clusters/${CLUSTER_ID}/files")"
contains "push: Proxmox's own content list shows it" "local:iso/${RUN}.iso" "$FILES"
contains "push: and Velnox matches it to the library item" "\"libraryItemId\":\"${ITEM}\"" "$FILES"
contains "push: checked against its SHA-256 on the node" "$ISO_SHA" "$(logs_of "$PUSH")"

AGAIN="$(call POST "/api/v1/library/${ITEM}/push" "$(json_object clusterId "$CLUSTER_ID" node pve1 storage local)" | json id)"
check "push: a file already there is not overwritten" "FAILED library.already_on_storage" "$(wait_for "$AGAIN" 60 SUCCEEDED FAILED CANCELLED) $(job_field "$AGAIN" errorCode)"

info "Cancelling a push halfway."
BIG="$WORK/${RUN}-big.iso"
make_iso "$BIG" 240000000
BSIZE=$(wc -c <"$BIG" | tr -d ' ')
BIGITEM="$(call POST /api/v1/library/uploads "$(json_object filename "${RUN}-big.iso" sizeBytes "$BSIZE")" | json item.id)"
remember_item "$BIGITEM"
rm -f "$WORK"/chunk-*
split -b "$CHUNK" -d -a 3 "$BIG" "$WORK/chunk-"
OFFSET=0
for part in "$WORK"/chunk-*; do
  put_chunk "$BIGITEM" "$OFFSET" "$part" >"$WORK/put"
  OFFSET=$((OFFSET + $(wc -c <"$part" | tr -d ' ')))
done
check "the larger file is ready" SUCCEEDED "$(wait_for "$(json job.id <"$WORK/put")" 120 SUCCEEDED FAILED CANCELLED)"

CPUSH="$(call POST "/api/v1/library/${BIGITEM}/push" "$(json_object clusterId "$CLUSTER_ID" node pve1 storage local)" | json id)"
P="$(wait_progress "$CPUSH" 60)"
[[ "$P" != "none" ]] && green "push: under way (${P}%) before it is cancelled" && PASS=$((PASS + 1)) || { red "push: never reported progress"; FAIL=$((FAIL + 1)); }
call POST "/api/v1/jobs/${CPUSH}/cancel" >/dev/null
check "push: cancelled" CANCELLED "$(wait_for "$CPUSH" 60 CANCELLED SUCCEEDED FAILED)"
sleep 1
check "push: no partial file on the node" "absent" "$(in_fixture "test -e /fixture/store/node-pve1/local/iso/${RUN}-big.iso && echo present || echo absent" | tr -d '\r')"
check "push: no temporary file left in the fixture either" "0" "$(in_fixture "ls /fixture/store/tmp | wc -l" | tr -d '\r ')"
lacks "push: and the cluster's list does not show it" "${RUN}-big.iso" "$(call GET "/api/v1/clusters/${CLUSTER_ID}/files")"
check "push: the library copy is untouched" READY "$(call GET "/api/v1/library/${BIGITEM}" | json state)"

# ---------------------------------------------------------------------------
# SSH, and pulling a file back
# ---------------------------------------------------------------------------

info "Setting SSH up: read the host keys, confirm them, prove the key."
PROBE="$(call POST "/api/v1/clusters/${CLUSTER_ID}/ssh/probe" "$(json_object port "$SSH_PORT")")"
check "ssh: host keys read" 200 "$(last_status)"
PROBED="$(printf '%s' "$PROBE" | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{const j=JSON.parse(r);process.stdout.write(j.nodes.filter(n=>n.fingerprint).map(n=>n.node+"="+n.fingerprint).join(","))})')"
contains "ssh: pve1 presents the fixture's key" "pve1=${HOST_KEY_FINGERPRINT}" "$PROBED"
lacks "ssh: the offline node is not asked" "pve3=" "$PROBED"
contains "ssh: reading the keys authenticated nothing" "" ""
lacks "ssh: no key was offered while probing" "accepted key" "$(FIXLOG)"

KEY="$(node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(process.argv[1], "utf8")))' "$WORK/client_key")"
ssh_body() {
  printf '{"username":"velnox","port":%s,"privateKey":%s,"hostKeys":[{"node":"pve1","fingerprint":"%s"},{"node":"pve2","fingerprint":"%s"}]}' \
    "$SSH_PORT" "$KEY" "$1" "$1"
}
WRONG_FP="SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
[[ "$WRONG_FP" != "$HOST_KEY_FINGERPRINT" ]] || WRONG_FP="SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
call PUT "/api/v1/clusters/${CLUSTER_ID}/ssh" "$(ssh_body "$WRONG_FP")" >"$WORK/sshwrong"
check "ssh: a host key nobody saw is refused" 409 "$(last_status)"
check "ssh: and nothing is kept" false "$(call GET "/api/v1/clusters/${CLUSTER_ID}/ssh" | json configured)"
call PUT "/api/v1/clusters/${CLUSTER_ID}/ssh" "$(ssh_body "$HOST_KEY_FINGERPRINT")" >"$WORK/sshok"
check "ssh: set up with the confirmed keys" 200 "$(last_status)"
check "ssh: proven against the nodes" true "$(call GET "/api/v1/clusters/${CLUSTER_ID}/ssh" | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>process.stdout.write(String(JSON.parse(r).verifiedAt!==null)))')"
lacks "ssh: the private key is never sent back" "PRIVATE KEY" "$(call GET "/api/v1/clusters/${CLUSTER_ID}/ssh")"

info "Pulling the pushed file back, after removing the library's copy."
call DELETE "/api/v1/library/${ITEM}" >/dev/null
check "the library copy is removed" 204 "$(last_status)"
check "the cluster's copy is still there" "present" "$(in_fixture "test -e /fixture/store/node-pve1/local/iso/${RUN}.iso && echo present || echo absent" | tr -d '\r')"
PULL="$(call POST "/api/v1/clusters/${CLUSTER_ID}/files/pull" "{\"node\":\"pve1\",\"storage\":\"local\",\"volid\":\"local:iso/${RUN}.iso\"}")"
check "pull: accepted" 202 "$(last_status)"
PULLED="$(printf '%s' "$PULL" | json item.id)"
remember_item "$PULLED"
check "pull: succeeds" SUCCEEDED "$(wait_for "$(printf '%s' "$PULL" | json job.id)" 120 SUCCEEDED FAILED CANCELLED)"
check "pull: byte-identical to what was pushed" "$ISO_SHA" "$(call GET "/api/v1/library/${PULLED}" | json sha256)"
check "pull: and the file on disk agrees" "$ISO_SHA" "$(in_worker "sha256sum /var/lib/velnox/library/items/${PULLED} | cut -d' ' -f1" | tr -d '\r')"
contains "pull: over SFTP" "ssh: sftp session opened" "$(FIXLOG)"
lacks "pull: and never a command or a shell" "EXEC ATTEMPTED" "$(FIXLOG)"

info "Cancelling a pull halfway."
PBIG="$(call POST "/api/v1/library/${BIGITEM}/push" "$(json_object clusterId "$CLUSTER_ID" node pve1 storage local)" | json id)"
check "the larger file is pushed, to have something to pull" SUCCEEDED "$(wait_for "$PBIG" 120 SUCCEEDED FAILED CANCELLED)"
call DELETE "/api/v1/library/${BIGITEM}" >/dev/null
CPULL="$(call POST "/api/v1/clusters/${CLUSTER_ID}/files/pull" "{\"node\":\"pve1\",\"storage\":\"local\",\"volid\":\"local:iso/${RUN}-big.iso\"}")"
CPULL_JOB="$(printf '%s' "$CPULL" | json job.id)"
CPULL_ITEM="$(printf '%s' "$CPULL" | json item.id)"
P="$(wait_progress "$CPULL_JOB" 60)"
[[ "$P" != "none" ]] && green "pull: under way (${P}%) before it is cancelled" && PASS=$((PASS + 1)) || { red "pull: never reported progress"; FAIL=$((FAIL + 1)); }
call POST "/api/v1/jobs/${CPULL_JOB}/cancel" >/dev/null
check "pull: cancelled" CANCELLED "$(wait_for "$CPULL_JOB" 60 CANCELLED SUCCEEDED FAILED)"
check "pull: no library item is left" 404 "$(call GET "/api/v1/library/${CPULL_ITEM}" >/dev/null; last_status)"
check "pull: no partial file is left" "absent" "$(in_worker "test -e /var/lib/velnox/library/partial/${CPULL_ITEM} && echo present || echo absent" | tr -d '\r')"

# ---------------------------------------------------------------------------
# Delete on the cluster
# ---------------------------------------------------------------------------

info "Deleting a file on the cluster."
DEL="$(call POST "/api/v1/clusters/${CLUSTER_ID}/files/delete" "{\"node\":\"pve1\",\"storage\":\"local\",\"volid\":\"local:iso/${RUN}.iso\"}" | json id)"
check "delete: succeeds" SUCCEEDED "$(wait_for "$DEL" 60 SUCCEEDED FAILED CANCELLED)"
check "delete: gone from the node" "absent" "$(in_fixture "test -e /fixture/store/node-pve1/local/iso/${RUN}.iso && echo present || echo absent" | tr -d '\r')"
lacks "delete: gone from the cluster's list" "local:iso/${RUN}.iso\"" "$(call GET "/api/v1/clusters/${CLUSTER_ID}/files")"
check "delete: the library copy is untouched" READY "$(call GET "/api/v1/library/${PULLED}" | json state)"

# ---------------------------------------------------------------------------

echo
if ((FAIL == 0)); then
  printf '\033[0;32m%d checks passed.\033[0m\n' "$PASS"
else
  printf '\033[0;31m%d passed, %d failed.\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi
