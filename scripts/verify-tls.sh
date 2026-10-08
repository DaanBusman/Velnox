#!/usr/bin/env bash
#
# Verify changing the certificate from Server management (Phase 5C, ADR-045)
# against a running stack.
#
#   bash scripts/verify-tls.sh
#   VELNOX_ADMIN_EMAIL=... VELNOX_ADMIN_PASSWORD=... bash scripts/verify-tls.sh
#
# With no administrator given, a throwaway MSP Super Administrator is created for
# the run and disabled at the end, with a throwaway customer administrator.
#
# **It changes the certificate this installation serves**, several times, and
# hands it back to the installer's at the end however the run ends. It restarts
# Caddy and the API once each, to prove the choice survives both. For ACME it
# runs Pebble, Let's Encrypt's test server, on the stack's network for the run.
#
# Needs: a running stack built from this tree, node, curl, docker, openssl.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_NATIVE="$(cd "$ROOT" && { pwd -W 2>/dev/null || pwd; })"
BASE="${1:-https://localhost}"
RUN="vt$(date +%s)"
COMPOSE=(docker compose -f "$ROOT_NATIVE/deploy/compose/docker-compose.yml" --env-file "$ROOT_NATIVE/.env")
PEBBLE="velnox-pebble-${RUN}"

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

for tool in node curl docker openssl; do
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
# Container paths are not Windows paths: no conversion for anything said to Docker.
dc() { MSYS_NO_PATHCONV=1 "${COMPOSE[@]}" "$@"; }
psql_at() { dc exec -T postgres psql -U velnox -d velnox -v ON_ERROR_STOP=1 -Atc "$1"; }
in_api() { dc exec -T api sh -c "$1"; }

WORK="$(mktemp -d)"
WORK_NATIVE="$(cd "$WORK" && { pwd -W 2>/dev/null || pwd; })"
STATUS_FILE="$WORK/status"
JAR="$WORK/admin-cookies"
CREATED_USERS=()
CREATED_TENANTS=()

call() {
  local method="$1" path="$2" data="${3:-}"
  local csrf=""
  [[ -f "$JAR" ]] && csrf="$(awk '$6 == "velnox_csrf" { print $7 }' "$JAR" | tail -1)"
  local args=(--silent --insecure --max-time 120 --cookie "$JAR" --cookie-jar "$JAR"
    --request "$method" --header 'accept: application/json'
    --output "$WORK/body" --write-out '%{http_code}')
  [[ -n "$csrf" ]] && args+=(--header "x-velnox-csrf: ${csrf}")
  [[ -n "$data" ]] && args+=(--header 'content-type: application/json' --data-binary "@${data}")
  curl "${args[@]}" "${BASE}${path}" >"$STATUS_FILE"
  cat "$WORK/body"
}
# A JSON body from a JavaScript expression, written to a file: certificates are
# too long, and a key has no business on a command line.
put_tls() {
  body "$1" >"$WORK/request.json"
  call PUT /api/v1/system/tls "$WORK/request.json"
  rm -f "$WORK/request.json"
}
as() { local saved="$JAR"; JAR="$1"; shift; "$@"; local rc=$?; JAR="$saved"; return $rc; }
last_status() { cat "$STATUS_FILE"; }

make_user() { # tenant role label → id
  local tenant="$1" role="$2" label="$3" pw hash id
  pw="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')"
  printf '%s' "$pw" >"$WORK/pw-${label}"
  hash="$(P="$pw" node -e 'require(process.argv[1]).hashPassword(process.env.P).then((h) => process.stdout.write(h));' "$ROOT_NATIVE/packages/crypto/dist/index.js")"
  [[ "$hash" == \$argon2id\$* ]] || { red "could not hash a password (is @velnox/crypto built?)"; exit 1; }
  id="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
  psql_at "INSERT INTO users (id, tenant_id, email, display_name, password_hash, updated_at)
           VALUES ('${id}', '${tenant}', '${RUN}-${label}@example.invalid', 'TLS verification', '${hash}', now());" >/dev/null
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
  E="${RUN}-$2@example.invalid" P="$(cat "$WORK/pw-$2")" body '{ email: e.E, password: e.P }' >"$WORK/login.json"
  call POST /api/v1/auth/login "$WORK/login.json" >/dev/null
  rm -f "$WORK/login.json"
  local status; status="$(last_status)"
  JAR="$saved"
  printf '%s' "$status"
}

# The certificate a browser receives for the site, as an SHA-256 fingerprint,
# read from the host — not through Velnox.
served_fingerprint() {
  echo | openssl s_client -connect "${SITE}:443" -servername "$SITE" 2>/dev/null |
    openssl x509 -noout -fingerprint -sha256 2>/dev/null | sed 's/^[^=]*=//'
}
served_issuer() {
  echo | openssl s_client -connect "${SITE}:443" -servername "$SITE" 2>/dev/null |
    openssl x509 -noout -issuer 2>/dev/null | sed 's/^issuer=//'
}
fingerprint_of() { openssl x509 -in "$1" -noout -fingerprint -sha256 | sed 's/^[^=]*=//'; }

cleanup() {
  # Whatever happened, the installation serves the installer's certificate again.
  put_tls '{ mode: "installer" }' >/dev/null 2>&1
  docker rm -f "$PEBBLE" >/dev/null 2>&1
  for user in "${CREATED_USERS[@]}"; do
    psql_at "UPDATE users SET status = 'DISABLED' WHERE id = '${user}';" >/dev/null 2>&1
  done
  for tenant in "${CREATED_TENANTS[@]}"; do
    psql_at "UPDATE tenants SET status = 'ARCHIVED', deleted_at = now() WHERE id = '${tenant}';" >/dev/null 2>&1
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------

MSP="$(psql_at "SELECT id FROM tenants WHERE kind = 'MSP_ROOT';")"
if [[ -n "${VELNOX_ADMIN_EMAIL:-}" && -n "${VELNOX_ADMIN_PASSWORD:-}" ]]; then
  body '{ email: e.VELNOX_ADMIN_EMAIL, password: e.VELNOX_ADMIN_PASSWORD }' >"$WORK/login.json"
  call POST /api/v1/auth/login "$WORK/login.json" >/dev/null
  rm -f "$WORK/login.json"
  check "admin: signs in" 200 "$(last_status)"
else
  make_user "$MSP" msp_super_administrator admin >/dev/null
  check "admin: signs in" 200 "$(login "$JAR" admin)"
fi
unset VELNOX_ADMIN_PASSWORD

RUN="$RUN" body '{ name: "TLS customer " + e.RUN }' >"$WORK/t.json"
T_ID="$(call POST /api/v1/tenants "$WORK/t.json" | json id)"
[[ -n "$T_ID" ]] && CREATED_TENANTS+=("$T_ID")
make_user "$T_ID" tenant_administrator customer >/dev/null
CUSTOMER_JAR="$WORK/customer-cookies"
check "a customer administrator signs in" 200 "$(login "$CUSTOMER_JAR" customer)"

STATUS="$(call GET /api/v1/system/tls)"
SITE="$(printf '%s' "$STATUS" | json siteAddress)"
info "The site is ${SITE}."
check "at first the installer's certificate is served" installer "$(printf '%s' "$STATUS" | json managedBy)"
INSTALLER_FP="$(served_fingerprint)"
[[ -n "$INSTALLER_FP" ]] && { green "and a browser gets one"; PASS=$((PASS + 1)); } || { red "no certificate served at all"; FAIL=$((FAIL + 1)); }
check "the managed file hands over to the installer's" "import /etc/caddy/tls/tls.caddy" "$(in_api 'tail -1 /var/lib/velnox/tls/tls.caddy')"

info "Refusals."
as "$CUSTOMER_JAR" put_tls '{ mode: "internal" }' >/dev/null
check "a customer cannot change the certificate" 403 "$(last_status)"
as "$CUSTOMER_JAR" call GET /api/v1/system/tls >/dev/null
check "nor read how it is configured" 403 "$(last_status)"

MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK_NATIVE/a.key" -out "$WORK_NATIVE/a.crt" -days 30 \
  -subj "/CN=${SITE}" -addext "subjectAltName=DNS:${SITE}" >/dev/null 2>&1
MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes -keyout "$WORK_NATIVE/b.key" -out "$WORK_NATIVE/b.crt" -days 30 \
  -subj "/CN=${SITE}" -addext "subjectAltName=DNS:${SITE}" >/dev/null 2>&1
openssl pkey -in "$WORK_NATIVE/a.key" -aes256 -passout pass:harness -out "$WORK_NATIVE/a-encrypted.key" >/dev/null 2>&1
export CERT_A="$(cat "$WORK/a.crt")" KEY_A="$(cat "$WORK/a.key")" KEY_B="$(cat "$WORK/b.key")" KEY_ENC="$(cat "$WORK/a-encrypted.key")"

R="$(put_tls '{ mode: "certificate", certificate: e.CERT_A, key: e.KEY_B }')"
check "a key that is not the certificate's is refused" "400 tls.key_mismatch" "$(last_status) $(printf '%s' "$R" | json error.code)"
R="$(put_tls '{ mode: "certificate", certificate: e.CERT_A, key: e.KEY_ENC }')"
check "an encrypted key is refused" "400 tls.key_invalid" "$(last_status) $(printf '%s' "$R" | json error.code)"
R="$(put_tls '{ mode: "certificate", certificate: "not a certificate", key: e.KEY_A }')"
check "what is not a certificate is refused" "400 tls.certificate_invalid" "$(last_status) $(printf '%s' "$R" | json error.code)"
put_tls '{ mode: "acme", email: "ops@example.com\n}\nimport /etc/passwd" }' >/dev/null
check "an ACME address that would be a second directive is refused" 400 "$(last_status)"
put_tls '{ mode: "acme", email: "ops@example.com", directory: "http://plain.example/dir" }' >/dev/null
check "an ACME directory that is not https is refused" 400 "$(last_status)"
check "after the refusals the installer's certificate is still served" "$INSTALLER_FP" "$(served_fingerprint)"

info "An uploaded certificate."
R="$(put_tls '{ mode: "certificate", certificate: e.CERT_A, key: e.KEY_A }')"
check "a certificate with its key is accepted" 200 "$(last_status)"
check "and the certificate served afterwards is verified to be it" true "$(printf '%s' "$R" | json verified)"
check "a browser gets exactly that certificate" "$(fingerprint_of "$WORK_NATIVE/a.crt")" "$(served_fingerprint)"
check "the screen says the interface chose it" "interface|certificate" "$(printf '%s' "$R" | json status.managedBy)|$(printf '%s' "$R" | json status.mode)"
lacks "the response carries no key" "PRIVATE KEY" "$R"
lacks "nor does reading the status" "PRIVATE KEY" "$(call GET /api/v1/system/tls)"
check "the database holds no key in the clear" 0 "$(psql_at "SELECT count(*) FROM system_settings WHERE row_to_json(system_settings)::text LIKE '%PRIVATE KEY%';")"
check "the audit log holds no key" 0 "$(psql_at "SELECT count(*) FROM audit_events WHERE metadata::text LIKE '%PRIVATE KEY%';")"
check "the key is in the secret store, encrypted" 1 "$(psql_at "SELECT count(*) FROM credentials WHERE kind = 'TLS_PRIVATE_KEY';")"
check "the key file is readable by its owner only" 600 "$(in_api 'stat -c %a /var/lib/velnox/tls/velnox.key')"
check "the change is audited" 1 "$(psql_at "SELECT count(*) FROM audit_events WHERE action = 'system.tls_changed' AND actor_label LIKE '${RUN}%' AND metadata->>'to' = 'certificate' AND result = 'SUCCESS';")"

info "It survives restarts."
dc restart caddy >/dev/null 2>&1
for _ in $(seq 1 30); do [[ -n "$(served_fingerprint)" ]] && break; sleep 1; done
check "after Caddy restarts, the same certificate" "$(fingerprint_of "$WORK_NATIVE/a.crt")" "$(served_fingerprint)"
in_api 'rm -f /var/lib/velnox/tls/velnox.crt /var/lib/velnox/tls/velnox.key /var/lib/velnox/tls/tls.caddy'
dc restart api >/dev/null 2>&1
for _ in $(seq 1 60); do [[ "$(curl -sk -o /dev/null -w '%{http_code}' "${BASE}/api/v1/health")" == 200 ]] && break; sleep 1; done
check "with its files gone, the API writes them again from what is stored" "tls /etc/caddy/managed/velnox.crt /etc/caddy/managed/velnox.key" "$(in_api 'tail -1 /var/lib/velnox/tls/tls.caddy')"
dc restart caddy >/dev/null 2>&1
for _ in $(seq 1 30); do [[ -n "$(served_fingerprint)" ]] && break; sleep 1; done
check "and Caddy serves it from them" "$(fingerprint_of "$WORK_NATIVE/a.crt")" "$(served_fingerprint)"

info "Caddy's own certificate authority."
R="$(put_tls '{ mode: "internal" }')"
check "switching to Caddy's own certificate is verified" "200 true" "$(last_status) $(printf '%s' "$R" | json verified)"
contains "a browser gets one from Caddy's authority" "Caddy Local Authority" "$(served_issuer)"
check "the uploaded key's file is gone" "" "$(in_api 'ls /var/lib/velnox/tls/velnox.key 2>/dev/null')"
check "and so is its stored copy" 0 "$(psql_at "SELECT count(*) FROM credentials WHERE kind = 'TLS_PRIVATE_KEY';")"

info "ACME, against Pebble (Let's Encrypt's test server), for ${SITE}."
NETWORK="$(docker inspect "$(dc ps -q caddy)" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | awk '{print $1}')"
MSYS_NO_PATHCONV=1 docker run -d --rm --name "$PEBBLE" --network "$NETWORK" --network-alias pebble \
  -e PEBBLE_VA_ALWAYS_VALID=1 -e PEBBLE_VA_NOSLEEP=1 ghcr.io/letsencrypt/pebble:latest >/dev/null 2>&1
sleep 2
MSYS_NO_PATHCONV=1 docker cp "$PEBBLE:/test/certs/pebble.minica.pem" "$WORK_NATIVE/pebble-root.pem" >/dev/null 2>&1
if [[ -s "$WORK/pebble-root.pem" ]]; then
  export PEBBLE_ROOT="$(cat "$WORK/pebble-root.pem")"
  R="$(put_tls '{ mode: "acme", email: "ops@example.com", directory: "https://pebble:14000/dir", caRoot: e.PEBBLE_ROOT }')"
  check "ACME with another directory and its root is accepted by Caddy" 200 "$(last_status)"
  contains "the directive names the directory and its root" "ca https://pebble:14000/dir" "$(in_api 'cat /var/lib/velnox/tls/tls.caddy')"
  ISSUER=""
  for _ in $(seq 1 45); do
    ISSUER="$(served_issuer)"
    [[ "$ISSUER" == *[Pp]ebble* ]] && break
    sleep 2
  done
  if [[ "$ISSUER" == *[Pp]ebble* ]]; then
    green "Caddy obtained a certificate from the ACME server (${ISSUER})"; PASS=$((PASS + 1))
    check "and the screen says it is served" false "$(call GET /api/v1/system/tls | json certificate.selfSigned)"
  else
    red "no certificate from Pebble within 90 seconds (served: ${ISSUER})"; FAIL=$((FAIL + 1))
    dc logs --since 2m caddy 2>&1 | grep -i 'acme\|obtain\|error' | tail -8
  fi
else
  red "could not start Pebble"; FAIL=$((FAIL + 1))
fi

info "Back to the installer's."
R="$(put_tls '{ mode: "installer" }')"
check "handing it back is accepted" "200 installer" "$(last_status) $(printf '%s' "$R" | json status.managedBy)"
check "the installer's certificate is served again" "$INSTALLER_FP" "$(served_fingerprint)"
check "the managed file imports the installer's again" "import /etc/caddy/tls/tls.caddy" "$(in_api 'tail -1 /var/lib/velnox/tls/tls.caddy')"
check "every change was audited" 4 "$(psql_at "SELECT count(*) FROM audit_events WHERE action = 'system.tls_changed' AND actor_label LIKE '${RUN}%' AND result = 'SUCCESS';")"
check "the admin API has no port: only its socket" "" "$(dc exec -T caddy sh -c 'netstat -ltn 2>/dev/null | grep -E ":2019 " || true')"

printf '\n'
if ((FAIL == 0)); then
  printf '\033[0;32m%d checks passed.\033[0m\n' "$PASS"
  exit 0
fi
printf '\033[0;31m%d passed, %d failed.\033[0m\n' "$PASS" "$FAIL"
exit 1
