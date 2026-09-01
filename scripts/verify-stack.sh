#!/usr/bin/env bash
#
# Verifies a running Velnox stack against the Phase 1 acceptance criteria.
#
# This exists so "the stack works" is something the machine asserts rather than
# something a human claims after glancing at a browser tab. It runs in CI and
# locally against the same stack.
#
#   ./scripts/verify-stack.sh [base-url]
#
# Default base URL is https://localhost. Certificates are Caddy-internal, so
# verification is deliberately skipped for the probe itself.

set -uo pipefail

BASE="${1:-https://localhost}"
CURL=(curl --silent --show-error --insecure --max-time 15)

PASS=0
FAIL=0
SKIP=0

green() { printf '\033[0;32m  ok  \033[0m %s\n' "$*"; }
red() { printf '\033[0;31m FAIL \033[0m %s\n' "$*"; }
grey() { printf '\033[0;90m skip \033[0m %s\n' "$*"; }
info() { printf '\033[0;36m----\033[0m %s\n' "$*"; }

skip() {
  grey "$*"
  SKIP=$((SKIP + 1))
}

check() {
  local name="$1"
  shift
  if "$@"; then
    green "$name"
    PASS=$((PASS + 1))
  else
    red "$name"
    FAIL=$((FAIL + 1))
  fi
}

# Reads a dotted path out of a JSON document on stdin.
#
# Prefers jq, falls back to node. Neither is assumed: a freshly installed Debian
# or Ubuntu host has no Node, and a developer's Windows machine often has no jq,
# so the script has to work with whichever is present.
if command -v jq >/dev/null 2>&1; then
  json() {
    jq -r --arg path "$1" '
      ($path | split(".")) as $keys
      | reduce $keys[] as $k (.; if . == null then null else .[$k]? end)
      | if . == null then "" else tostring end
    ' 2>/dev/null || printf ''
  }
elif command -v node >/dev/null 2>&1; then
  json() {
    node -e '
      let raw = "";
      process.stdin.on("data", (c) => (raw += c));
      process.stdin.on("end", () => {
        try {
          const value = process.argv[1]
            .split(".")
            .reduce((acc, key) => (acc == null ? acc : acc[key]), JSON.parse(raw));
          process.stdout.write(value === undefined || value === null ? "" : String(value));
        } catch {
          process.stdout.write("");
        }
      });
    ' "$1"
  }
else
  echo "This script needs either jq or node to read JSON responses." >&2
  echo "Install one:  sudo apt-get install -y jq" >&2
  exit 2
fi

# Invoked indirectly, as `check expect_equals ...`.
# shellcheck disable=SC2329
expect_equals() {
  local actual="$1" expected="$2"
  if [[ "$actual" == "$expected" ]]; then return 0; fi
  printf '       expected %q, got %q\n' "$expected" "$actual" >&2
  return 1
}

# shellcheck disable=SC2329
expect_contains() {
  local haystack="$1" needle="$2"
  if [[ "$haystack" == *"$needle"* ]]; then return 0; fi
  printf '       expected output to contain %q\n' "$needle" >&2
  return 1
}

# shellcheck disable=SC2329
expect_not_contains() {
  local haystack="$1" needle="$2"
  if [[ "$haystack" != *"$needle"* ]]; then return 0; fi
  printf '       expected output NOT to contain %q\n' "$needle" >&2
  return 1
}

# Visible text only: strips <script> and <style> blocks and all tags.
#
# Necessary because the page embeds the whole message catalogue in the RSC
# payload, so a raw grep matches translation *keys* (`noHeartbeat`) as well as
# rendered text — which is exactly how the first version of the check below
# produced a false failure.
#
# perl rather than node: perl-base is a required package on Debian and Ubuntu, so
# it is present on every host this runs on, and Git for Windows ships it too.
visible_text() {
  perl -0777 -pe '
    s{<script\b.*?</script>}{ }gsi;
    s{<style\b.*?</style>}{ }gsi;
    s{<[^>]+>}{ }gs;
    s{\s+}{ }gs;
  '
}

info "Verifying ${BASE}"

# --- 1. The UI is served -----------------------------------------------------
check "web: the dashboard shell is served over HTTPS" bash -c "
  body=\$(${CURL[*]} '${BASE}/') || exit 1
  [[ \"\$body\" == *'<html'* ]] || exit 1
"

# --- 2. The API answers through the reverse proxy ----------------------------
HEALTH_JSON="$("${CURL[@]}" "${BASE}/api/v1/health" 2>/dev/null)"
check "api: /api/v1/health responds through Caddy" expect_equals \
  "$(printf '%s' "$HEALTH_JSON" | json status)" "ok"

# --- 3. Readiness: every dependency reachable, schema current ----------------
READY_JSON="$("${CURL[@]}" "${BASE}/readyz" 2>/dev/null)"
check "readyz: overall status is ok" expect_equals "$(printf '%s' "$READY_JSON" | json status)" "ok"
check "readyz: PostgreSQL reachable" expect_contains "$READY_JSON" '"name":"database","status":"ok"'
check "readyz: Redis reachable" expect_contains "$READY_JSON" '"name":"redis","status":"ok"'
check "readyz: worker heartbeat is fresh" expect_contains "$READY_JSON" '"name":"worker","status":"ok"'
check "readyz: no pending migrations" expect_equals \
  "$(printf '%s' "$READY_JSON" | json migrations.status)" "ok"
check "readyz: the initial migration is applied" expect_equals \
  "$(printf '%s' "$READY_JSON" | json migrations.applied)" "1"

# --- 4. OpenAPI --------------------------------------------------------------
check "api: /api/docs serves the OpenAPI UI" bash -c "
  body=\$(${CURL[*]} '${BASE}/api/docs/') || exit 1
  [[ \"\$body\" == *'swagger'* || \"\$body\" == *'Velnox API'* ]]
"

# --- 5. AGPL section 13 source offer ----------------------------------------
SOURCE_JSON="$("${CURL[@]}" "${BASE}/api/v1/system/source" 2>/dev/null)"
check "licence: the source offer declares AGPL-3.0-or-later" expect_equals \
  "$(printf '%s' "$SOURCE_JSON" | json license)" "AGPL-3.0-or-later"
check "licence: a source URL is published" bash -c "
  url=\$(printf '%s' '$SOURCE_JSON' | grep -o '\"url\":\"[^\"]*\"' | head -1)
  [[ -n \"\$url\" ]]
"
check "licence: the build commit is embedded, so the offer is verifiable" bash -c "
  commit=\$(printf '%s' '$SOURCE_JSON' | grep -o '\"commit\":\"[^\"]*\"' | head -1)
  [[ -n \"\$commit\" && \"\$commit\" != '\"commit\":\"\"' ]]
"

# --- 6. Localization ---------------------------------------------------------
check "i18n: English is served by default" bash -c "
  body=\$(${CURL[*]} -H 'Accept-Language: en' '${BASE}/') || exit 1
  [[ \"\$body\" == *'Dashboard'* && \"\$body\" == *'Service status'* ]]
"
check "i18n: Dutch is served for a Dutch browser" bash -c "
  body=\$(${CURL[*]} -H 'Accept-Language: nl-NL,nl;q=0.9' '${BASE}/') || exit 1
  [[ \"\$body\" == *'Servicestatus'* && \"\$body\" == *'Overzicht van de omgeving'* ]]
"
check "i18n: the locale cookie overrides the browser preference" bash -c "
  body=\$(${CURL[*]} -H 'Accept-Language: en' -H 'Cookie: velnox_locale=nl' '${BASE}/') || exit 1
  [[ \"\$body\" == *'Servicestatus'* ]]
"

# The API returns health detail as a code with parameters, not as a sentence
# (ADR-019). If that ever regresses, English prose from the API shows up in the
# middle of a Dutch page — which is exactly how it was caught the first time.
NL_TEXT="$("${CURL[@]}" -H 'Accept-Language: nl' "${BASE}/" 2>/dev/null | visible_text)"
check "i18n: API-supplied health detail is rendered in Dutch" \
  expect_contains "$NL_TEXT" "Hartslag"
check "i18n: no English health detail leaks onto the Dutch page" \
  expect_not_contains "$NL_TEXT" "Heartbeat "

# --- 7. Security headers -----------------------------------------------------
HEADERS="$("${CURL[@]}" --head "${BASE}/" 2>/dev/null)"
for header in \
  'strict-transport-security' \
  'x-content-type-options' \
  'x-frame-options' \
  'content-security-policy' \
  'referrer-policy'; do
  check "headers: ${header} is set" bash -c "
    printf '%s' \"\$(echo '$HEADERS' | tr 'A-Z' 'a-z')\" | grep -q '$header'
  "
done

# --- 8. The queue actually round-trips --------------------------------------
#
# The self-test endpoint is a diagnostic and is off in a normal installation, so
# its absence is reported as skipped rather than failed. The worker's heartbeat
# check above already proves the worker is alive and reaching Redis; this adds
# proof that submitted work is actually executed.
DEV_ENDPOINTS="$("${CURL[@]}" "${BASE}/api/v1/system/info" 2>/dev/null | json features.devEndpoints)"

if [[ "$DEV_ENDPOINTS" != "true" ]]; then
  skip "queue: self-test endpoint disabled (set VELNOX_DEV_ENDPOINTS=true to include it)"
  JOB_ID=""
else
  info "Running the queue self-test (api -> Redis -> worker)"
  JOB_ID="$("${CURL[@]}" -X POST "${BASE}/api/v1/system/selftest/queue" 2>/dev/null | json jobId)"
fi

if [[ "$DEV_ENDPOINTS" == "true" && -z "$JOB_ID" ]]; then
  red "queue: the self-test endpoint is enabled but would not accept a job"
  FAIL=$((FAIL + 1))
elif [[ -n "$JOB_ID" ]]; then
  green "queue: job ${JOB_ID} accepted"
  PASS=$((PASS + 1))

  STATE=""
  PROCESSED_BY=""
  for _ in $(seq 1 40); do
    JOB_JSON="$("${CURL[@]}" "${BASE}/api/v1/system/selftest/queue/${JOB_ID}" 2>/dev/null)"
    STATE="$(printf '%s' "$JOB_JSON" | json state)"
    if [[ "$STATE" == "completed" || "$STATE" == "failed" ]]; then
      PROCESSED_BY="$(printf '%s' "$JOB_JSON" | json result.processedBy)"
      break
    fi
    sleep 1
  done

  check "queue: the worker completed the job" expect_equals "$STATE" "completed"
  check "queue: the result names the worker that executed it" bash -c "[[ -n '$PROCESSED_BY' ]]"
fi

# --- 9. Data tier is not exposed --------------------------------------------
check "network: PostgreSQL is not published to the host" bash -c "
  ! (exec 3<>/dev/tcp/127.0.0.1/5432) 2>/dev/null
"
check "network: Redis is not published to the host" bash -c "
  ! (exec 3<>/dev/tcp/127.0.0.1/6379) 2>/dev/null
"

echo
SKIPPED_NOTE=""
[[ $SKIP -gt 0 ]] && SKIPPED_NOTE=", $SKIP skipped"

if [[ $FAIL -eq 0 ]]; then
  printf '\033[0;32m%s checks passed%s.\033[0m\n' "$PASS" "$SKIPPED_NOTE"
  exit 0
fi
printf '\033[0;31m%s passed, %s failed%s.\033[0m\n' "$PASS" "$FAIL" "$SKIPPED_NOTE"
exit 1
