#!/usr/bin/env bash
#
# Verifies a running Velnox stack against the acceptance criteria of every
# phase that has landed.
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
APPLIED="$(printf '%s' "$READY_JSON" | json migrations.applied)"
EXPECTED="$(printf '%s' "$READY_JSON" | json migrations.expected)"
check "readyz: every migration the build expects is applied (${APPLIED}/${EXPECTED})" \
  bash -c "[[ -n '$APPLIED' && '$APPLIED' == '$EXPECTED' && '$APPLIED' != '0' ]]"

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
#
# Against the sign-in page, which is public. The dashboard is behind
# authentication, and an anonymous fetch of "/" is a redirect — one that Next.js
# still attaches a rendered body to, so asserting on that body passes while
# testing nothing a browser would show. -L follows to the page that is really
# served.
check "i18n: English is served by default" bash -c "
  body=\$(${CURL[*]} -L -H 'Accept-Language: en' '${BASE}/') || exit 1
  [[ \"\$body\" == *'Sign in'* ]]
"
check "i18n: Dutch is served for a Dutch browser" bash -c "
  body=\$(${CURL[*]} -L -H 'Accept-Language: nl-NL,nl;q=0.9' '${BASE}/') || exit 1
  [[ \"\$body\" == *'Inloggen'* && \"\$body\" == *'Wachtwoord'* ]]
"
check "i18n: the locale cookie overrides the browser preference" bash -c "
  body=\$(${CURL[*]} -L -H 'Accept-Language: en' -H 'Cookie: velnox_locale=nl' '${BASE}/') || exit 1
  [[ \"\$body\" == *'Inloggen'* ]]
"

# The API returns health detail as a code with parameters, not as a sentence
# (ADR-019). This used to be checked by looking for Dutch words on the dashboard,
# which is no longer reachable without a session — and asserting it against the
# API directly is the stronger test anyway, because it names the invariant
# instead of one of its symptoms.
WORKER_DETAIL_CODE="$(printf '%s' "$READY_JSON" | json checks.2.detail.code)"
check "i18n: the API returns a health detail code, not English prose" \
  bash -c "[[ -n '$WORKER_DETAIL_CODE' ]]"
check "i18n: no English sentence leaks out of the health payload" \
  expect_not_contains "$READY_JSON" "ago"

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

# --- 8. Authentication is actually enforced ---------------------------------
#
# The Phase 2 criterion that matters most: an endpoint that needs a session
# refuses one that does not have it. Checked from outside, against the running
# stack, because a guard that is registered but not reached is a guard that does
# nothing.
info "Checking that protected endpoints refuse an anonymous caller"

for ENDPOINT in "/api/v1/users" "/api/v1/auth/me" "/api/v1/identity-providers/oidc"; do
  STATUS="$("${CURL[@]}" -o /dev/null -w '%{http_code}' "${BASE}${ENDPOINT}" 2>/dev/null)"
  check "auth: ${ENDPOINT} refuses an anonymous caller (got ${STATUS})" \
    bash -c "[[ '$STATUS' == '401' || '$STATUS' == '403' ]]"
done

# A mutating request without the double-submit token must be refused even when
# it carries no session, so a cross-site page cannot reach the endpoint at all.
CSRF_STATUS="$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' -d '{}' \
  "${BASE}/api/v1/auth/logout" 2>/dev/null)"
check "auth: a POST without the CSRF header is refused (got ${CSRF_STATUS})" \
  bash -c "[[ '$CSRF_STATUS' == '401' || '$CSRF_STATUS' == '403' ]]"

# --- 8b. Setup is closed once it has run ------------------------------------
INITIALIZED="$("${CURL[@]}" "${BASE}/api/v1/setup/status" 2>/dev/null | json initialized)"

if [[ "$INITIALIZED" == "true" ]]; then
  SETUP_STATUS="$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' \
    -d '{"organisationName":"probe","displayName":"probe","email":"probe@example.invalid","password":"probe-probe-probe"}' \
    "${BASE}/api/v1/setup/initialize" 2>/dev/null)"
  # 409 is the documented answer; 403 means it never got past the CSRF check,
  # which is also a refusal. Anything that creates a second administrator is not.
  check "setup: a second initialize is refused (got ${SETUP_STATUS})" \
    bash -c "[[ '$SETUP_STATUS' == '409' || '$SETUP_STATUS' == '403' ]]"
else
  skip "setup: not initialized yet, so there is nothing to re-run"
fi

# --- 8c. The running build reports the version in the source ----------------
#
# Catches a stale `.env`: VELNOX_VERSION is written there by the installer, and
# before it refreshed that value on every run an upgrade left the API reporting
# the previous release. The documentation bundled in the web image states the
# version it applies to, so a stale value there makes every documentation page
# announce a mismatch that is not real.
SOURCE_VERSION="$(grep -m1 '"version"' "$(dirname "$0")/../package.json" 2>/dev/null | cut -d'"' -f4)"
RUNNING_VERSION="$("${CURL[@]}" "${BASE}/api/v1/system/info" 2>/dev/null | json version)"

if [[ -z "$SOURCE_VERSION" ]]; then
  skip "version: no package.json next to this script, so there is nothing to compare against"
else
  check "version: the stack reports ${SOURCE_VERSION} as the source declares" \
    expect_equals "$RUNNING_VERSION" "$SOURCE_VERSION"
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
