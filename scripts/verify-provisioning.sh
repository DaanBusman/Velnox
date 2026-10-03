#!/usr/bin/env bash
#
# Verify Phase 5B — Autoconfig templates, provisioning, mail — against a running stack.
#
#   bash scripts/verify-provisioning.sh
#   VELNOX_ADMIN_EMAIL=... VELNOX_ADMIN_PASSWORD=... bash scripts/verify-provisioning.sh
#
# With no administrator given, a throwaway MSP Super Administrator is created for
# the run and disabled at the end. A second tenant and a throwaway administrator
# in it are created too, to prove what a customer sees, and are archived and
# disabled at the end.
#
# Stands up the fixture Proxmox with storage, VMs and a mail sink switched on,
# adds it as a cluster, fills the library with a Windows ISO built by wimlib and
# genisoimage (so the edition list is read from a real WIM), a stand-in VirtIO
# ISO and a stand-in cloud image, and then builds VMs: a Windows one and a Linux
# one that succeed, one that fails, and one that is cancelled. The fixture keeps
# a copy of every answer ISO a VM was handed, which is how the checks below see
# what a guest would have read.
#
# **It switches outgoing mail to the fixture's sink for the run** and puts the
# previous server settings back afterwards, switched off — a switched-off mail
# needs a new test to come back on. Do not run it against an installation whose
# mail is in use.
#
# What it cannot prove: that Windows Setup and cloud-init accept what they are
# handed. That is proven by the generators' tests, xmllint and cloud-init's own
# schema check; this proves Velnox hands it over, and cleans up after.
#
# Needs: a running stack built from this tree, node, openssl, curl, docker.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_NATIVE="$(cd "$ROOT" && { pwd -W 2>/dev/null || pwd; })"
BASE="${1:-https://localhost}"
RUN="vp$(date +%s)"
SHORT="${RUN: -6}"
COMPOSE=(docker compose -f "$ROOT_NATIVE/deploy/compose/docker-compose.yml" --env-file "$ROOT_NATIVE/.env")
FIXTURE_NAME="velnox-fake-pve-${RUN}"
FIXTURE_HOST="fake-pve"
SMTP_PORT=2525
TOKEN_ID='root@pam!velnox'
TOKEN_SECRET='fixture-secret-0000-0000-000000000000'
SSH_KEY='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHV2ZWxub3gtaGFybmVzcy1rZXktbm90LXJlYWw ops@harness'

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

# A JSON body from a JavaScript expression, with the harness's variables in `e`.
body() { node -e 'const e = process.env; process.stdout.write(JSON.stringify(eval("(" + process.argv[1] + ")")))' "$1"; }

psql_at() { "${COMPOSE[@]}" exec -T postgres psql -U velnox -d velnox -v ON_ERROR_STOP=1 -Atc "$1"; }
in_fixture() { MSYS_NO_PATHCONV=1 docker exec "$FIXTURE_NAME" sh -c "$1"; }

WORK="$(mktemp -d)"
STATUS_FILE="$WORK/status"
JAR="$WORK/admin-cookies"
TENANT_JAR="$WORK/tenant-cookies"
CREATED_USERS=()
CREATED_TENANT=""
CLUSTER_ID=""
ITEMS=()
TEMPLATES=()
MAIL_BEFORE=""

# `call` uses $JAR; `as_tenant call …` uses the customer's session instead.
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
as_tenant() { local saved="$JAR"; JAR="$TENANT_JAR"; "$@"; local rc=$?; JAR="$saved"; return $rc; }
last_status() { cat "$STATUS_FILE"; }

upload() {
  local file="$1" name="$2" size start id
  size=$(wc -c <"$file" | tr -d ' ')
  start="$(call POST /api/v1/library/uploads "$(N="$name" S="$size" body '{ filename: e.N, sizeBytes: Number(e.S) }')")"
  id="$(printf '%s' "$start" | json item.id)"
  [[ -n "$id" ]] || { printf ''; return; }
  ITEMS+=("$id")
  local csrf
  csrf="$(awk '$6 == "velnox_csrf" { print $7 }' "$JAR" | tail -1)"
  curl --silent --insecure --max-time 300 --cookie "$JAR" --cookie-jar "$JAR" --request PUT \
    --header "x-velnox-csrf: ${csrf}" --header 'content-type: application/octet-stream' \
    --data-binary "@${file}" --output /dev/null "${BASE}/api/v1/library/uploads/${id}/chunks?offset=0"
  for _ in $(seq 1 60); do
    [[ "$(call GET "/api/v1/library/${id}" | json state)" == READY ]] && break
    sleep 1
  done
  printf '%s' "$id"
}

job_field() { call GET "/api/v1/jobs/$1" | json "$2"; }

# A page as the web renders it for the admin, as text, in a locale.
page_text() {
  curl --silent --insecure --max-time 60 --cookie "$JAR" --cookie "velnox_locale=$1" "${BASE}$2" |
    node -e '
      let r = ""; process.stdin.on("data", (c) => (r += c)).on("end", () => {
        process.stdout.write(r.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ")
          .replace(/&#x27;/g, "\x27").replace(/&amp;/g, "&").replace(/\s+/g, " "));
      });'
}
# The href of the sidebar entry marked as the current page.
current_nav() {
  curl --silent --insecure --max-time 60 --cookie "$JAR" "${BASE}$1" |
    node -e '
      let r = ""; process.stdin.on("data", (c) => (r += c)).on("end", () => {
        const a = (r.match(/<a\b[^>]*>/g) || []).find((tag) => tag.includes("aria-current=\"page\""));
        const m = a && /href="([^"]*)"/.exec(a);
        process.stdout.write(m ? m[1] : "");
      });'
}
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
wait_step() {
  local id="$1" step="$2" deadline=$((SECONDS + $3))
  while ((SECONDS < deadline)); do
    [[ "$(job_field "$id" currentStep)" == "$step" ]] && return 0
    sleep 0.5
  done
  return 1
}

cleanup() {
  if ((FAIL > 0)); then
    info "Last lines from the fixture:"
    docker logs "$FIXTURE_NAME" 2>&1 | tail -30
  fi
  for id in "${TEMPLATES[@]}"; do call DELETE "/api/v1/autoconfig/templates/${id}" >/dev/null 2>&1; done
  for id in "${ITEMS[@]}"; do call DELETE "/api/v1/library/${id}" >/dev/null 2>&1; done
  [[ -n "$CLUSTER_ID" ]] && call DELETE "/api/v1/clusters/${CLUSTER_ID}" >/dev/null 2>&1
  if [[ -n "$MAIL_BEFORE" ]]; then
    call PUT /api/v1/system/mail "$(M="$MAIL_BEFORE" body '(({host, port, security, username, from}) => ({ host, port, security, username, from, enabled: false }))(JSON.parse(e.M))')" >/dev/null 2>&1
  fi
  docker rm -f "$FIXTURE_NAME" >/dev/null 2>&1 || true
  for user in "${CREATED_USERS[@]}"; do
    psql_at "UPDATE users SET status = 'DISABLED' WHERE id = '${user}';" >/dev/null 2>&1
  done
  [[ -n "$CREATED_TENANT" ]] && psql_at "UPDATE tenants SET status = 'ARCHIVED' WHERE id = '${CREATED_TENANT}';" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# The fixture, and the media
# ---------------------------------------------------------------------------

NETWORK="$(docker network ls --format '{{.Name}}' | grep -m1 'egress' || true)"
[[ -n "$NETWORK" ]] || { echo "Could not find the compose egress network. Is the stack running?" >&2; exit 1; }
docker image inspect velnox-backend:local >/dev/null 2>&1 || { echo "Build the stack first." >&2; exit 1; }

info "Preparing the fixture's certificate."
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
  -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null || { red "could not generate a certificate"; exit 1; }
TLS_FINGERPRINT="$(openssl x509 -in "$WORK/cert.pem" -noout -fingerprint -sha256 | cut -d= -f2)"

mkdir -p "$WORK/store" "$WORK/media"
cp "$ROOT/scripts/fixtures/fake-pve.mjs" "$ROOT/scripts/fixtures/fake-pve-storage.mjs" "$ROOT/scripts/fixtures/fake-pve-vms.mjs" "$WORK/"
chmod -R a+rwX "$WORK" 2>/dev/null || true
WORK_NATIVE="$(cd "$WORK" && { pwd -W 2>/dev/null || pwd; })"

info "Building a Windows-shaped ISO: a real WIM listing two editions, in a real UDF image."
MSYS_NO_PATHCONV=1 docker run --rm -v "$WORK_NATIVE/media:/out" debian:bookworm-slim sh -c '
  set -e
  apt-get update -qq >/dev/null && apt-get install -y -qq wimtools genisoimage >/dev/null 2>&1
  mkdir -p /img/Windows /iso/sources && echo x > /img/Windows/a.txt
  wimlib-imagex capture /img /iso/sources/install.wim "Windows 11 Home" >/dev/null
  wimlib-imagex append /img /iso/sources/install.wim "Windows 11 Pro" >/dev/null
  genisoimage -quiet -udf -V WIN11 -o /out/win.iso /iso
  chmod a+r /out/win.iso' || { red "could not build the Windows ISO"; exit 1; }
node -e '
  const b = Buffer.alloc(1 << 20); b.write("CD001", 0x8001); require("fs").writeFileSync(process.argv[1], b);
  const q = Buffer.alloc(1 << 20); Buffer.from([0x51, 0x46, 0x49, 0xfb, 0, 0, 0, 3]).copy(q); require("fs").writeFileSync(process.argv[2], q);
' "$WORK/media/virtio.iso" "$WORK/media/cloud.img"

MSYS_NO_PATHCONV=1 docker run -d --rm --name "$FIXTURE_NAME" \
  --network "$NETWORK" --network-alias "$FIXTURE_HOST" \
  -v "$WORK_NATIVE:/fixture" --entrypoint node velnox-backend:local \
  /fixture/fake-pve.mjs --cert /fixture/cert.pem --key /fixture/key.pem --port 8006 \
  --storage-dir /fixture/store --node-address "$FIXTURE_HOST" \
  --vms --install-seconds 12 --smtp-port "$SMTP_PORT" >/dev/null
sleep 3
docker ps --format '{{.Names}}' | grep -q "$FIXTURE_NAME" || { red "the fixture did not start"; docker logs "$FIXTURE_NAME" 2>&1 | tail -20; exit 1; }
FIXLOG() { docker logs "$FIXTURE_NAME" 2>&1; }
contains "fixture: accepting mail" "smtp listening on ${SMTP_PORT}" "$(FIXLOG)"

# ---------------------------------------------------------------------------
# People, a second tenant, the cluster
# ---------------------------------------------------------------------------

make_user() { # tenant role label → id; password in $WORK/pw-<label>
  local tenant="$1" role="$2" label="$3" pw hash id
  pw="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')"
  printf '%s' "$pw" >"$WORK/pw-${label}"
  hash="$(P="$pw" node -e 'require(process.argv[1]).hashPassword(process.env.P).then((h) => process.stdout.write(h));' "$ROOT/packages/crypto/dist/index.js")"
  [[ "$hash" == \$argon2id\$* ]] || { red "could not hash a password (is @velnox/crypto built?)"; exit 1; }
  id="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
  psql_at "INSERT INTO users (id, tenant_id, email, display_name, password_hash, updated_at)
           VALUES ('${id}', '${tenant}', '${RUN}-${label}@example.invalid', 'Provisioning verification', '${hash}', now());" >/dev/null
  psql_at "INSERT INTO role_assignments (id, user_id, role_id, scope_type, scope_id, tenant_id)
           SELECT gen_random_uuid(), '${id}', r.id,
                  CASE WHEN '${role}' LIKE 'msp_%' THEN 'GLOBAL'::scope_type ELSE 'TENANT'::scope_type END,
                  CASE WHEN '${role}' LIKE 'msp_%' THEN NULL ELSE '${tenant}'::uuid END,
                  CASE WHEN '${role}' LIKE 'msp_%' THEN NULL ELSE '${tenant}'::uuid END
           FROM roles r WHERE r.key = '${role}';" >/dev/null
  CREATED_USERS+=("$id")
  printf '%s' "$id"
}
login() { # jar label
  local saved="$JAR"; JAR="$1"
  call POST /api/v1/auth/login "$(E="${RUN}-$2@example.invalid" P="$(cat "$WORK/pw-$2")" body '{ email: e.E, password: e.P }')" >/dev/null
  local status; status="$(last_status)"
  JAR="$saved"
  printf '%s' "$status"
}

MSP="$(psql_at "SELECT id FROM tenants WHERE kind = 'MSP_ROOT';")"
if [[ -n "${VELNOX_ADMIN_EMAIL:-}" && -n "${VELNOX_ADMIN_PASSWORD:-}" ]]; then
  call POST /api/v1/auth/login "$(body '{ email: e.VELNOX_ADMIN_EMAIL, password: e.VELNOX_ADMIN_PASSWORD }')" >/dev/null
  ADMIN_EMAIL="$VELNOX_ADMIN_EMAIL"
  check "admin: signs in" 200 "$(last_status)"
else
  make_user "$MSP" msp_super_administrator admin >/dev/null
  ADMIN_EMAIL="${RUN}-admin@example.invalid"
  check "admin: signs in" 200 "$(login "$JAR" admin)"
fi
unset VELNOX_ADMIN_PASSWORD

TENANT_ID="$(call GET /api/v1/tenants | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{const t=JSON.parse(r).tenants.find(x=>x.kind!=="MSP_ROOT");process.stdout.write(t?t.id:"")})')"
[[ -n "$TENANT_ID" ]] || { red "no customer tenant to build in"; exit 1; }
OTHER="$(call POST /api/v1/tenants "$(R="$RUN" body '{ name: "Other " + e.R }')")"
CREATED_TENANT="$(printf '%s' "$OTHER" | json id)"
[[ -n "$CREATED_TENANT" ]] || { red "could not create a second tenant: $(printf '%s' "$OTHER" | head -c 200)"; exit 1; }
make_user "$CREATED_TENANT" tenant_administrator other >/dev/null
check "a customer administrator signs in" 200 "$(login "$TENANT_JAR" other)"

CLUSTER="$(call POST /api/v1/clusters "$(T="$TENANT_ID" R="$RUN" H="$FIXTURE_HOST" F="$TLS_FINGERPRINT" I="$TOKEN_ID" S="$TOKEN_SECRET" body '{ tenantId: e.T, name: e.R, host: e.H, port: 8006, fingerprint: e.F, auth: { kind: "API_TOKEN", tokenId: e.I, secret: e.S } }')")"
CLUSTER_ID="$(printf '%s' "$CLUSTER" | json id)"
[[ -n "$CLUSTER_ID" ]] || { red "no cluster to test against: $(printf '%s' "$CLUSTER" | head -c 300)"; exit 1; }
for _ in $(seq 1 60); do
  [[ "$(call GET "/api/v1/clusters/${CLUSTER_ID}" | json connectionState)" == "CONNECTED" ]] && break
  sleep 1
done
check "cluster: discovered" CONNECTED "$(call GET "/api/v1/clusters/${CLUSTER_ID}" | json connectionState)"

# ---------------------------------------------------------------------------
# The library
# ---------------------------------------------------------------------------

info "Filling the library."
WIN_ISO="${RUN}-win11.iso"
WIN_ITEM="$(upload "$WORK/media/win.iso" "$WIN_ISO")"
check "the Windows ISO is ready" READY "$(call GET "/api/v1/library/${WIN_ITEM}" | json state)"
check "its editions were read from its WIM" '["Windows 11 Home","Windows 11 Pro"]' \
  "$(call GET "/api/v1/library/${WIN_ITEM}" | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>process.stdout.write(JSON.stringify((JSON.parse(r).windowsImages||[]).map(i=>i.name))))')"
VIRTIO_ISO="${RUN}-virtio.iso"
VIRTIO_ITEM="$(upload "$WORK/media/virtio.iso" "$VIRTIO_ISO")"
check "a non-Windows ISO has no edition list" "" "$(call GET "/api/v1/library/${VIRTIO_ITEM}" | json windowsImages)"
CLOUD_IMG="${RUN}-noble.img"
CLOUD_ITEM="$(upload "$WORK/media/cloud.img" "$CLOUD_IMG")"
check "the cloud image is ready" READY "$(call GET "/api/v1/library/${CLOUD_ITEM}" | json state)"

# ---------------------------------------------------------------------------
# Mail
# ---------------------------------------------------------------------------

info "Pointing outgoing mail at the fixture."
MAIL_BEFORE="$(call GET /api/v1/system/mail)"
call PUT /api/v1/system/mail "$(H="$FIXTURE_HOST" P="$SMTP_PORT" body '{ host: e.H, port: Number(e.P), security: "NONE", username: null, from: "velnox@example.invalid" }')" >/dev/null
check "mail: settings saved" 200 "$(last_status)"
call PUT /api/v1/system/mail '{"enabled":true}' >/dev/null
check "mail: cannot be switched on before a test" 409 "$(last_status)"
call POST /api/v1/system/mail/test "$(A="$ADMIN_EMAIL" body '{ to: e.A }')" >/dev/null
check "mail: the test goes out through the worker" 200 "$(last_status)"
contains "mail: and arrives" "Subject: Velnox test mail" "$(in_fixture 'cat /fixture/store/mail/*.eml 2>/dev/null')"
call PUT /api/v1/system/mail '{"enabled":true}' >/dev/null
check "mail: switched on after the test" true "$(call GET /api/v1/system/mail | json enabled)"

# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------

info "Templates: validation, secrets, visibility, cloning."
ADMIN_PW="Harness-Admin-${SHORT}-Pw9"
export WIN_ISO VIRTIO_ISO CLOUD_IMG SSH_KEY MSP TENANT_ID ADMIN_PW RUN
WIN_SETTINGS='{ family: "WINDOWS", isoFilename: e.WIN_ISO, imageName: "Windows 11 Pro", virtioIsoFilename: e.VIRTIO_ISO, administratorPassword: "FIXED", accounts: [{ name: "beheer", displayName: "Beheer", administrator: true }], locale: { uiLanguage: "nl-NL", systemLocale: "nl-NL", userLocale: "nl-NL", inputLocale: "0413:00020409", timeZone: "W. Europe Standard Time" }, rdp: true }'

call POST /api/v1/autoconfig/templates "$(body "{ tenantId: e.MSP, name: 'Win MBR ' + e.RUN, settings: Object.assign(${WIN_SETTINGS}, { diskLayout: 'MBR' }), secrets: { administrator: e.ADMIN_PW } }")" >/dev/null
check "Windows 11 on MBR is refused" 400 "$(last_status)"
call POST /api/v1/autoconfig/templates "$(body "{ tenantId: e.MSP, name: 'Win weak ' + e.RUN, settings: ${WIN_SETTINGS}, secrets: { administrator: 'short' } }")" >/dev/null
check "a weak fixed password is refused" 400 "$(last_status)"
call POST /api/v1/autoconfig/templates "$(body "{ tenantId: e.MSP, name: 'Win key ' + e.RUN, settings: Object.assign(${WIN_SETTINGS}, { hasProductKey: true }), secrets: { administrator: e.ADMIN_PW, productKey: 'not-a-key' } }")" >/dev/null
check "a malformed product key is refused" 400 "$(last_status)"
check "and nothing half-made is left" 0 "$(psql_at "SELECT count(*) FROM autoconfig_templates WHERE name LIKE '% ${RUN}';")"

WIN_T="$(call POST /api/v1/autoconfig/templates "$(body "{ tenantId: e.MSP, name: 'Windows 11 Pro ' + e.RUN, visibility: 'SHARED', settings: ${WIN_SETTINGS}, secrets: { administrator: e.ADMIN_PW } }")")"
check "an MSP Windows template is created" 201 "$(last_status)"
WIN_TID="$(printf '%s' "$WIN_T" | json id)"; TEMPLATES+=("$WIN_TID")
lacks "the response carries no password" "$ADMIN_PW" "$WIN_T"
check "it says which secret is set" true "$(printf '%s' "$WIN_T" | json secretsSet.administrator)"
check "and that none is missing" "[]" "$(printf '%s' "$WIN_T" | json secretsMissing)"
check "the database holds no password either" 0 "$(psql_at "SELECT count(*) FROM autoconfig_templates WHERE settings::text LIKE '%${ADMIN_PW}%' OR secret_refs::text LIKE '%${ADMIN_PW}%';")"

PRIV_T="$(call POST /api/v1/autoconfig/templates "$(body "{ tenantId: e.MSP, name: 'Private ' + e.RUN, visibility: 'PRIVATE', settings: Object.assign(${WIN_SETTINGS}, { administratorPassword: 'GENERATE' }) }")")"
PRIV_TID="$(printf '%s' "$PRIV_T" | json id)"; TEMPLATES+=("$PRIV_TID")

LINUX_SETTINGS='{ family: "LINUX", distribution: "UBUNTU", imageFilename: e.CLOUD_IMG, locale: "nl_NL.UTF-8", users: [{ name: "ops", sshKeys: [e.SSH_KEY], password: "GENERATE" }], swapMb: 512 }'
LIN_T="$(call POST /api/v1/autoconfig/templates "$(body "{ tenantId: e.TENANT_ID, name: 'Ubuntu ' + e.RUN, credentialDelivery: 'ENCRYPTED_PDF', pdfPasswordSource: 'SHOWN_ONCE', settings: ${LINUX_SETTINGS} }")")"
check "a customer's own Linux template is created" 201 "$(last_status)"
LIN_TID="$(printf '%s' "$LIN_T" | json id)"; TEMPLATES+=("$LIN_TID")

OFFERED_OTHER="$(as_tenant call GET "/api/v1/autoconfig/templates?offeredTo=${CREATED_TENANT}")"
contains "an MSP shared template is offered to another tenant" "$WIN_TID" "$OFFERED_OTHER"
lacks "an MSP private one is not" "$PRIV_TID" "$OFFERED_OTHER"
lacks "a customer's template is not offered to another customer" "$LIN_TID" "$OFFERED_OTHER"
lacks "nor listed for them at all" "$LIN_TID" "$(as_tenant call GET /api/v1/autoconfig/templates)"
as_tenant call PATCH "/api/v1/autoconfig/templates/${WIN_TID}" '{"description":"mine now"}' >/dev/null
check "a customer cannot change an MSP template it can see" 403 "$(last_status)"

CLONE="$(as_tenant call POST "/api/v1/autoconfig/templates/${WIN_TID}/clone" "$(T="$CREATED_TENANT" body '{ tenantId: e.T, name: "My copy " + e.RUN }')")"
check "a customer clones an MSP template" 201 "$(last_status)"
CLONE_ID="$(printf '%s' "$CLONE" | json id)"; TEMPLATES+=("$CLONE_ID")
check "the copy belongs to the customer" "$CREATED_TENANT" "$(printf '%s' "$CLONE" | json tenantId)"
check "and is private to them" PRIVATE "$(printf '%s' "$CLONE" | json visibility)"
check "the MSP's fixed password did not come with it" '["administrator"]' "$(printf '%s' "$CLONE" | json secretsMissing)"
as_tenant call PATCH "/api/v1/autoconfig/templates/${CLONE_ID}" '{"description":"changed"}' >/dev/null
check "the copy can be changed by its owner" 200 "$(last_status)"
check "and the original is untouched" "" "$(call GET "/api/v1/autoconfig/templates/${WIN_TID}" | json description)"

# ---------------------------------------------------------------------------
# Refusals before a job
# ---------------------------------------------------------------------------

info "Provisioning refusals."
export CLUSTER_ID
PROV='{ templateId: e.TID, clusterId: e.CLUSTER_ID, node: "pve1", diskStorage: e.DISK || "ceph-vm", mediaStorage: "local", bridge: e.BRIDGE || "vmbr0", hostname: e.HOST, notify: e.NOTIFY !== "no" }'
call POST /api/v1/provisionings "$(TID="$WIN_TID" HOST="much-too-long-name" body "$PROV")" >/dev/null
check "a Windows hostname over 15 characters is refused" 400 "$(last_status)"
call POST /api/v1/provisionings "$(TID="$WIN_TID" HOST="ws${SHORT}" DISK=local body "$PROV")" >/dev/null
check "disk storage that takes no images is refused" 409 "$(last_status)"
call POST /api/v1/provisionings "$(TID="$WIN_TID" HOST="ws${SHORT}" BRIDGE=vmbr9 body "$PROV")" >/dev/null
check "a bridge the node does not have is refused" 409 "$(last_status)"
call POST /api/v1/provisionings "$(TID="$WIN_TID" HOST="db-primary" body "$PROV")" >/dev/null
check "a name a VM already has is refused" 409 "$(last_status)"
as_tenant call POST /api/v1/provisionings "$(TID="$CLONE_ID" HOST="ws${SHORT}" body "$PROV")" >/dev/null
check "another customer cannot build on this cluster" 404 "$(last_status)"
NOTPRO="$(call POST /api/v1/autoconfig/templates "$(body "{ tenantId: e.MSP, name: 'Home N ' + e.RUN, settings: Object.assign(${WIN_SETTINGS}, { imageName: 'Windows 11 Home N', administratorPassword: 'GENERATE' }) }")")"
TEMPLATES+=("$(printf '%s' "$NOTPRO" | json id)")
call POST /api/v1/provisionings "$(TID="$(printf '%s' "$NOTPRO" | json id)" HOST="ws${SHORT}" body "$PROV")" >/tmp/np.$$ 2>/dev/null
check "an edition the ISO does not have is refused" autoconfig.edition_not_in_iso "$(json error.code </tmp/np.$$)"
rm -f /tmp/np.$$

# ---------------------------------------------------------------------------
# A Windows VM
# ---------------------------------------------------------------------------

info "Building a Windows VM."
WIN_HOST="ws${SHORT}"
W="$(call POST /api/v1/provisionings "$(TID="$WIN_TID" HOST="$WIN_HOST" body "$PROV")")"
check "windows: accepted" 201 "$(last_status)"
W_ID="$(printf '%s' "$W" | json provisioning.id)"
W_JOB="$(printf '%s' "$W" | json job.id)"
check "windows: no document password for a template that keeps credentials in Velnox" "" "$(printf '%s' "$W" | json documentPassword)"
check "windows: the job succeeds" SUCCEEDED "$(wait_for "$W_JOB" 240 SUCCEEDED FAILED CANCELLED)"
W_REC="$(call GET "/api/v1/provisionings/${W_ID}")"
check "windows: the record says so" SUCCEEDED "$(printf '%s' "$W_REC" | json state)"
W_VMID="$(printf '%s' "$W_REC" | json vmid)"
contains "windows: the guest reported its address" "192.0.2." "$(printf '%s' "$W_REC" | json addresses)"
contains "windows: the installer was put on the node" "${WIN_ISO}" "$(in_fixture 'ls /fixture/store/node-pve1/local/iso')"
contains "windows: and the VirtIO drivers" "${VIRTIO_ISO}" "$(in_fixture 'ls /fixture/store/node-pve1/local/iso')"
lacks "windows: the answer ISO is gone from the storage" "velnox-answers-${W_ID}" "$(in_fixture 'ls /fixture/store/node-pve1/local/iso')"
UNATTEND="$(in_fixture "cat /fixture/store/answers-seen/${W_VMID}/Autounattend.xml")"
contains "windows: the guest was handed an Autounattend.xml" "<unattend" "$UNATTEND"
contains "windows: choosing the edition by name" "<Value>Windows 11 Pro</Value>" "$UNATTEND"
contains "windows: named as asked" "<ComputerName>${WIN_HOST}</ComputerName>" "$UNATTEND"
contains "windows: with Dutch input on US-International" "<InputLocale>0413:00020409</InputLocale>" "$UNATTEND"
lacks "windows: the fixed Administrator password is not in it in the clear" "$ADMIN_PW" "$UNATTEND"
OBFUSCATED="$(P="$ADMIN_PW" node -e 'process.stdout.write(Buffer.from(process.env.P + "AdministratorPassword", "utf16le").toString("base64"))')"
contains "windows: it is in unattend's hidden form" "$OBFUSCATED" "$UNATTEND"
contains "windows: Enter was pressed at the UEFI boot prompt" "Pressed Enter" "$(call GET "/api/v1/jobs/${W_JOB}/logs" | json lines)"
lacks "windows: no password in the job output" "$ADMIN_PW" "$(call GET "/api/v1/jobs/${W_JOB}/logs")"

REVEAL="$(call POST "/api/v1/provisionings/${W_ID}/reveal")"
check "windows: the passwords can be revealed" 200 "$(last_status)"
BEHEER_PW="$(printf '%s' "$REVEAL" | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{const a=JSON.parse(r).accounts.find(x=>x.name==="beheer");process.stdout.write(a?a.password:"")})')"
check "windows: a desktop's built-in Administrator is reported as switched off" "" "$(printf '%s' "$REVEAL" | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{const a=JSON.parse(r).accounts.find(x=>x.name==="Administrator");process.stdout.write(a&&a.password?a.password:"")})')"
[[ ${#BEHEER_PW} -ge 20 ]] && { green "windows: the account got a generated password"; PASS=$((PASS + 1)); } || { red "windows: no generated password revealed"; FAIL=$((FAIL + 1)); }
contains "windows: and it is the one the guest was handed" "$(P="$BEHEER_PW" node -e 'process.stdout.write(Buffer.from(process.env.P + "Password", "utf16le").toString("base64"))')" "$UNATTEND"
check "windows: the reveal is audited" 1 "$(psql_at "SELECT count(*) FROM audit_events WHERE action = 'provisioning.credentials_revealed' AND resource_id = '${W_ID}' AND result = 'SUCCESS';")"
as_tenant call POST "/api/v1/provisionings/${W_ID}/reveal" >/dev/null
check "windows: another customer cannot reveal them" 404 "$(last_status)"

W_MAIL="$(in_fixture "grep -l 'Subject: ${WIN_HOST} is' /fixture/store/mail/*.eml | head -1 | xargs cat")"
contains "windows: the requester was mailed" "To: ${ADMIN_EMAIL}" "$W_MAIL"
lacks "windows: the mail has no password in it" "$BEHEER_PW" "$W_MAIL"
contains "windows: it carries the installation record" "application/pdf" "$W_MAIL"
check "windows: the requester was mailed once" 1 "$(in_fixture "grep -l 'Subject: ${WIN_HOST} is' /fixture/store/mail/*.eml | wc -l" | tr -d ' ')"

# ---------------------------------------------------------------------------
# A Linux VM, with an encrypted record
# ---------------------------------------------------------------------------

info "Building a Linux VM."
LIN_HOST="web-${RUN}"
L="$(call POST /api/v1/provisionings "$(TID="$LIN_TID" HOST="$LIN_HOST" body "$PROV")")"
check "linux: accepted" 201 "$(last_status)"
L_ID="$(printf '%s' "$L" | json provisioning.id)"
L_JOB="$(printf '%s' "$L" | json job.id)"
DOC_PW="$(printf '%s' "$L" | json documentPassword)"
[[ ${#DOC_PW} -ge 20 ]] && { green "linux: the record's password is shown once, in the response"; PASS=$((PASS + 1)); } || { red "linux: no document password in the response"; FAIL=$((FAIL + 1)); }
lacks "linux: and not again on the record" "$DOC_PW" "$(call GET "/api/v1/provisionings/${L_ID}")"
check "linux: the job succeeds" SUCCEEDED "$(wait_for "$L_JOB" 240 SUCCEEDED FAILED CANCELLED)"
L_VMID="$(call GET "/api/v1/provisionings/${L_ID}" | json vmid)"
contains "linux: the cloud image was put on the node as an import" "${RUN}-noble.qcow2" "$(in_fixture 'ls /fixture/store/node-pve1/local/import')"
SEED="$(in_fixture "cat /fixture/store/answers-seen/${L_VMID}/user-data")"
contains "linux: the guest was handed cloud-init" "#cloud-config" "$SEED"
contains "linux: with the key placed" "ops@harness" "$SEED"
contains "linux: and a hashed password" '"passwd": "$6$' "$SEED"
L_REVEAL="$(call POST "/api/v1/provisionings/${L_ID}/reveal")"
OPS_PW="$(printf '%s' "$L_REVEAL" | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{const a=JSON.parse(r).accounts.find(x=>x.name==="ops");process.stdout.write(a?a.password:"")})')"
lacks "linux: the password is not in the seed in the clear" "$OPS_PW" "$SEED"
contains "linux: the network config matches the NIC's MAC" "macaddress" "$(in_fixture "cat /fixture/store/answers-seen/${L_VMID}/network-config")"
L_MAIL="$(in_fixture "grep -l 'Subject: ${LIN_HOST} is' /fixture/store/mail/*.eml | head -1 | xargs cat")"
lacks "linux: the mail does not carry the PDF's password" "$DOC_PW" "$L_MAIL"
lacks "linux: nor the account's" "$OPS_PW" "$L_MAIL"
PDF="$(printf '%s' "$L_MAIL" | node -e '
  let r = ""; process.stdin.on("data", (c) => (r += c)).on("end", () => {
    const m = /Content-Type: application\/pdf[\s\S]*?\r?\n\r?\n([A-Za-z0-9+\/=\r\n]+)/.exec(r);
    process.stdout.write(m ? Buffer.from(m[1].replace(/\s+/g, ""), "base64").toString("latin1") : "");
  });')"
contains "linux: the attached record is encrypted" "/Encrypt" "$PDF"
contains "linux: as AES-256 revision 6" "/R 6" "$PDF"
lacks "linux: and the password is not readable in it" "$OPS_PW" "$PDF"

# ---------------------------------------------------------------------------
# A failure, and a cancellation
# ---------------------------------------------------------------------------

info "A VM whose install fails, and one that is cancelled."
F="$(call POST /api/v1/provisionings "$(TID="$LIN_TID" HOST="fail-${RUN}" NOTIFY=no body "$PROV")")"
F_ID="$(printf '%s' "$F" | json provisioning.id)"
F_JOB="$(printf '%s' "$F" | json job.id)"
check "failure: the job fails" FAILED "$(wait_for "$F_JOB" 300 SUCCEEDED FAILED CANCELLED)"
F_REC="$(call GET "/api/v1/provisionings/${F_ID}")"
check "failure: the record says so" FAILED "$(printf '%s' "$F_REC" | json state)"
F_VMID="$(printf '%s' "$F_REC" | json vmid)"
contains "failure: no half-created VM is left: it was destroyed, disks and all" "vm ${F_VMID} destroyed (purge=1)" "$(FIXLOG)"
lacks "failure: its answer ISO is gone" "velnox-answers-${F_ID}" "$(in_fixture 'ls /fixture/store/node-pve1/local/iso')"
call POST "/api/v1/provisionings/${F_ID}/reveal" >/dev/null
check "failure: its passwords were not kept" 410 "$(last_status)"

C="$(call POST /api/v1/provisionings "$(TID="$LIN_TID" HOST="cancel-${RUN}" NOTIFY=no body "$PROV")")"
C_ID="$(printf '%s' "$C" | json provisioning.id)"
C_JOB="$(printf '%s' "$C" | json job.id)"
wait_step "$C_JOB" install 120 || red "cancel: the job never reached the install wait"
# While it installs: the build is shown under Virtual Machines with where it has got to.
check "underway: the record carries the job's step" install "$(call GET "/api/v1/provisionings/${C_ID}" | json currentStep)"
check "underway: so does the list" install "$(call GET /api/v1/provisionings | node -e 'let r="";process.stdin.on("data",c=>r+=c).on("end",()=>{const p=JSON.parse(r).find(x=>x.id===process.argv[1]);process.stdout.write(p&&p.currentStep||"")})' "$C_ID")"
VMS_EN="$(page_text en /virtual-machines)"
contains "underway: Virtual Machines lists the VM being built" "cancel-${RUN}" "$VMS_EN"
contains "underway: with the build's state" "Being built" "$VMS_EN"
contains "underway: and the step it is on" "Installing" "$VMS_EN"
contains "underway: Virtual Machines offers a new VM" "New VM" "$VMS_EN"
contains "underway: a failed build stays listed for a while" "Build failed" "$VMS_EN"
VMS_NL="$(page_text nl /virtual-machines)"
contains "underway: in Dutch too" "Wordt uitgerold" "$VMS_NL"
contains "underway: with the step in Dutch" "Installeren" "$VMS_NL"
lacks "underway: no untranslated key on the page" "inventory.build" "$VMS_NL"
lacks "underway: the sidebar no longer has its own entry for building VMs" "New VMs" "$VMS_EN"
check "underway: a build's record keeps Virtual Machines highlighted" /virtual-machines "$(current_nav "/provisioning/${C_ID}")"
call POST "/api/v1/jobs/${C_JOB}/cancel" >/dev/null
check "cancel: the job is cancelled" CANCELLED "$(wait_for "$C_JOB" 120 CANCELLED SUCCEEDED FAILED)"
check "cancel: the record says so" CANCELLED "$(call GET "/api/v1/provisionings/${C_ID}" | json state)"
C_VMID="$(call GET "/api/v1/provisionings/${C_ID}" | json vmid)"
contains "cancel: its VM was destroyed" "vm ${C_VMID} destroyed (purge=1)" "$(FIXLOG)"
lacks "cancel: a cancelled build is not listed under Virtual Machines" "cancel-${RUN}" "$(page_text en /virtual-machines)"

# ---------------------------------------------------------------------------

echo
if ((FAIL == 0)); then
  printf '\033[0;32m%d checks passed.\033[0m\n' "$PASS"
else
  printf '\033[0;31m%d passed, %d failed.\033[0m\n' "$PASS" "$FAIL"
  exit 1
fi
