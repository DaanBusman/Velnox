#!/usr/bin/env bash
#
# Verify Velnox as an installable app (ADR-058) against a running stack.
#
#   bash scripts/verify-pwa.sh
#
# Signs a throwaway read-only MSP user in through the API, then drives a real
# headless Chromium — in a container, reaching the stack's https://localhost —
# over the DevTools protocol (scripts/pwa-probe.mjs). Proves: the manifest and
# the service worker are served without a session; Chromium finds the
# interface installable; the worker takes control and stores static files
# only — never an API answer, a page or its data, after screens a user visits;
# the user menu's "Install as app" asks the browser's own prompt; with no
# network the worker's page says so and shows nothing from before; signing out
# clears the caches, after which only the sign-in page's static files return.
#
# Not proven here: the browser's refusal on an untrusted certificate (Chromium
# runs with certificate errors ignored, as the stack's own CA is not in it),
# and installing on a real Windows desktop.
#
# Needs: a running stack, node, curl, docker. The first run builds a small
# Chromium image (velnox-harness-chromium:1).

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ROOT_NATIVE="$(cd "$ROOT" && { pwd -W 2>/dev/null || pwd; })"
BASE="${1:-https://localhost}"
RUN="vp$(date +%s)"
COMPOSE=(docker compose -f "$ROOT_NATIVE/deploy/compose/docker-compose.yml" --env-file "$ROOT_NATIVE/.env")
BROWSER_NAME="velnox-chromium-${RUN}"
BROWSER_IMAGE="velnox-harness-chromium:1"
DEVTOOLS_PORT=9339

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

for tool in node curl docker; do
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

WORK="$(mktemp -d)"
WORK_NATIVE="$(cd "$WORK" && { pwd -W 2>/dev/null || pwd; })"
JAR="$WORK/cookies"
STATUS_FILE="$WORK/status"
USER_ID=""

call() {
  local method="$1" path="$2" data="${3:-}"
  local csrf=""
  [[ -f "$JAR" ]] && csrf="$(awk '$6 == "velnox_csrf" { print $7 }' "$JAR" | tail -1)"
  local args=(--silent --insecure --max-time 60 --cookie "$JAR" --cookie-jar "$JAR"
    --request "$method" --header 'accept: application/json'
    --output "$WORK/body" --write-out '%{http_code}')
  [[ -n "$csrf" ]] && args+=(--header "x-velnox-csrf: ${csrf}")
  [[ -n "$data" ]] && args+=(--header 'content-type: application/json' --data "$data")
  curl "${args[@]}" "${BASE}${path}" >"$STATUS_FILE"
  cat "$WORK/body"
}
last_status() { cat "$STATUS_FILE"; }
# A path's status, content type and one header, without a session.
head_of() { curl --silent --insecure --max-time 30 --output /dev/null --write-out '%{http_code} %{content_type}' "${BASE}$1"; }
header_of() { curl --silent --insecure --max-time 30 --dump-header - --output /dev/null "${BASE}$1" | tr -d '\r' | grep -i "^$2:" | head -1 | cut -d' ' -f2-; }

# shellcheck disable=SC2329  # called by the EXIT trap below
cleanup() {
  docker rm -f "$BROWSER_NAME" >/dev/null 2>&1 || true
  [[ -n "$USER_ID" ]] && psql_at "UPDATE users SET status = 'DISABLED' WHERE id = '${USER_ID}';" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Served to anyone: the manifest, the worker, the policy that allows them
# ---------------------------------------------------------------------------

info "What a browser fetches before anyone signs in."
VERSION="$(sed -n 's/^VELNOX_VERSION=//p' "$ROOT/.env")"
check "manifest: served without a session, as a manifest" "200 application/manifest+json" "$(head_of /manifest.webmanifest)"
MANIFEST="$(curl --silent --insecure "${BASE}/manifest.webmanifest")"
check "manifest: a window of its own, from the root" "standalone / /" "$(printf '%s' "$MANIFEST" | pick 'd.display+" "+d.start_url+" "+d.scope')"
check "manifest: icons of 192 and 512, and a maskable one" "192x192:any,512x512:any,512x512:maskable" "$(printf '%s' "$MANIFEST" | pick 'd.icons.map(i=>i.sizes+":"+i.purpose).join(",")')"
ICONS_OK=yes
for icon in $(printf '%s' "$MANIFEST" | pick 'd.icons.map(i=>i.src).join(" ")'); do
  [[ "$icon" == /_next/static/media/* && "$(head_of "$icon")" == "200 image/png" ]] || ICONS_OK="no: $icon"
done
check "manifest: every icon a static PNG the worker may keep" yes "$ICONS_OK"
check "worker: served without a session, as JavaScript" "200 text/javascript; charset=utf-8" "$(head_of /sw.js)"
check "worker: never cached on the way, so a new build is found" "no-cache" "$(header_of /sw.js cache-control)"
contains "worker: named after this build" "velnox-static-${VERSION}-" "$(curl --silent --insecure "${BASE}/sw.js")"
CSP="$(header_of /login content-security-policy)"
contains "policy: the worker allowed from this origin only" "worker-src 'self'" "$CSP"
contains "policy: the manifest too" "manifest-src 'self'" "$CSP"
contains "the sign-in page points at the manifest" 'rel="manifest" href="/manifest.webmanifest"' "$(curl --silent --insecure "${BASE}/login")"

# ---------------------------------------------------------------------------
# A read-only user, signed in through the API
# ---------------------------------------------------------------------------

PASSWORD="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')"
HASH="$(P="$PASSWORD" node -e 'require(process.argv[1]).hashPassword(process.env.P).then((h) => process.stdout.write(h));' "$ROOT_NATIVE/packages/crypto/dist/index.js")"
[[ "$HASH" == \$argon2id\$* ]] || { red "could not hash a password (is @velnox/crypto built?)"; exit 1; }
USER_ID="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
MSP="$(psql_at "SELECT id FROM tenants WHERE kind = 'MSP_ROOT';")"
psql_at "INSERT INTO users (id, tenant_id, email, display_name, password_hash, updated_at)
         VALUES ('${USER_ID}', '${MSP}', '${RUN}-viewer@example.invalid', 'App verification', '${HASH}', now());" >/dev/null
psql_at "INSERT INTO role_assignments (id, user_id, role_id, scope_type)
         SELECT gen_random_uuid(), '${USER_ID}', id, 'GLOBAL' FROM roles WHERE key = 'msp_read_only';" >/dev/null
unset HASH
call POST /api/v1/auth/login "$(E="${RUN}-viewer@example.invalid" P="$PASSWORD" body '{ email: e.E, password: e.P }')" >/dev/null
unset PASSWORD
check "a read-only user signs in" 200 "$(last_status)"
# The session, as the browser will be given it.
node -e '
  // curl on Windows ends its lines with CRLF; a stray \r makes a cookie invalid.
  const lines = require("fs").readFileSync(process.argv[1], "utf8").split(/\r?\n/);
  const cookies = lines.filter((l) => l.trim() && (!l.startsWith("#") || l.startsWith("#HttpOnly_"))).map((l) => {
    const [domain, , path, secure, , name, value] = l.split("\t");
    return { name, value, path, secure: secure === "TRUE", httpOnly: domain.startsWith("#HttpOnly_") };
  });
  require("fs").writeFileSync(process.argv[2], JSON.stringify(cookies));
' "$JAR" "$WORK/browser-cookies.json"

# ---------------------------------------------------------------------------
# A real Chromium
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

info "Chromium, with https://localhost forwarded to the stack."
# localhost inside the container is forwarded to the stack's Caddy, so the
# browser sees the very origin users do — a secure context, the same
# certificate name. DevTools is forwarded out on a port of the host's loopback.
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

INSTALL_LABEL="$(node -e 'process.stdout.write(require(process.argv[1]).pwa.install)' "$ROOT_NATIVE/packages/i18n/locales/en.json")"
SIGN_OUT_LABEL="$(node -e 'process.stdout.write(require(process.argv[1]).auth.signOut)' "$ROOT_NATIVE/packages/i18n/locales/en.json")"
OFFLINE_TITLE="$(node -e 'process.stdout.write(require(process.argv[1]).pwa.offlineTitle)' "$ROOT_NATIVE/packages/i18n/locales/en.json")"
R="$(node "$ROOT_NATIVE/scripts/pwa-probe.mjs" "http://127.0.0.1:${DEVTOOLS_PORT}" "https://localhost" \
  "$WORK_NATIVE/browser-cookies.json" "$SIGN_OUT_LABEL" "$INSTALL_LABEL")"
check "probe: ran to the end" ran "$(printf '%s' "$R" | pick 'd.error ? "error: " + d.error : "ran"')"

info "Installable, and what is kept."
check "signed in, in the browser" true "$(printf '%s' "$R" | json signedIn)"
check "the worker is active" true "$(printf '%s' "$R" | json workerActive)"
check "it controls the page after a reload" true "$(printf '%s' "$R" | json controlled)"
check "chromium finds it installable: no installability errors" "[]" "$(printf '%s' "$R" | json installabilityErrors)"
check "and no manifest errors" "[]" "$(printf '%s' "$R" | json manifestErrors)"
check "static files are kept, after four screens" yes "$(printf '%s' "$R" | pick '(d.cached.length>0)?"yes":"no"')"
check "only static files: nothing outside /_next/static" "" "$(printf '%s' "$R" | pick 'd.cached.filter(e=>!e.split(" ")[1].startsWith("/_next/static/")).join(", ")')"
check "only this build's cache" "velnox-static-${VERSION}" "$(printf '%s' "$R" | pick '[...new Set(d.cached.map(e=>e.split(" ")[0].replace(/-[^-]*$/,"")))].join(",")')"

info "The button, no network, signing out."
check "user menu: 'Install as app' asks the browser's own prompt" prompted "$(printf '%s' "$R" | json installButton)"
check "no network: the worker's page" "$OFFLINE_TITLE" "$(printf '%s' "$R" | json offlineTitle)"
OFFLINE_TEXT="$(printf '%s' "$R" | json offlineText)"
check "no network: nothing from before on it" no "$([[ "$OFFLINE_TEXT" == *"${RUN}"* || "$OFFLINE_TEXT" == *"App verification"* ]] && echo yes || echo no)"
check "signed out through the menu" true "$(printf '%s' "$R" | json signedOut)"
# Signing out empties every cache; the sign-in page that follows is loaded
# through the worker again, and its own static files — the same for everyone —
# are kept anew. Without the clearing nothing kept would ever go (the cache is
# never evicted within a build), so an entry gone is the proof it ran.
check "signing out cleared what the session's screens had kept" yes "$(printf '%s' "$R" | pick 'const after=new Set(d.cachedAfterSignOut);(d.cachedBeforeSignOut.length>0&&d.cachedBeforeSignOut.some(e=>!after.has(e)))?"yes":"no"')"
check "after signing out, still nothing but static files" "" "$(printf '%s' "$R" | pick 'd.cachedAfterSignOut.filter(e=>!e.split(" ")[1].startsWith("/_next/static/")).join(", ")')"

printf '\n'
if ((FAIL == 0)); then
  printf '\033[0;32m%d checks passed.\033[0m\n' "$PASS"
  exit 0
fi
printf '\033[0;31m%d passed, %d failed.\033[0m\n' "$PASS" "$FAIL"
printf '%s\n' "$R" | head -c 3000
exit 1
