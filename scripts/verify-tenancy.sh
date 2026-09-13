#!/usr/bin/env bash
#
# Cross-tenant isolation, asserted against a running stack.
#
# The unit tests in packages/db prove the filter is built correctly. They cannot
# prove it is *attached* — that the running API resolves a scope, that Prisma
# accepts the rewritten query, that a tenant administrator signing in genuinely
# cannot read another customer's rows. Those are questions about a deployment,
# and only a deployment can answer them.
#
# So this signs in as two different people and tries to cross the boundary, in
# both directions, through every route that exists: lists, filters, direct id
# lookups and writes.
#
#   ./scripts/verify-tenancy.sh [base-url]
#
# On an installation that has not run setup, it runs setup itself with a
# generated password. On one that has, it needs an account that can manage
# tenants:
#
#   VELNOX_ADMIN_EMAIL=... VELNOX_ADMIN_PASSWORD=... ./scripts/verify-tenancy.sh
#
# Everything it creates is named with a run-specific prefix and archived at the
# end. It never deletes anything it did not create.

set -uo pipefail

BASE="${1:-https://localhost}"
RUN="vt$(date +%s)"

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

# Reads a dotted path out of JSON on stdin. jq when it is there, node otherwise:
# a Debian host often has neither node nor jq, and a Windows workstation often
# has node and no jq.
if command -v jq >/dev/null 2>&1; then
  json() { jq -r --arg p "$1" '($p | split(".")) as $k | getpath($k) // empty' 2>/dev/null; }
elif command -v node >/dev/null 2>&1; then
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
else
  echo "Needs jq or node to read JSON responses." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# One signed-in identity per cookie jar
# ---------------------------------------------------------------------------

JARS="$(mktemp -d)"
trap 'rm -rf "$JARS"' EXIT

# Method, path, body, and the jar to use. Prints the body; sets LAST_STATUS.
LAST_STATUS=""
call() {
  local who="$1" method="$2" path="$3" body="${4:-}"
  local jar="${JARS}/${who}.jar"
  local csrf=""

  # Double-submit: the header has to echo the cookie, which is why the jar is
  # read rather than a token being remembered.
  if [[ -f "$jar" ]]; then
    csrf="$(awk '$6 == "velnox_csrf" { print $7 }' "$jar" | tail -1)"
  fi

  local response
  response="$(curl --silent --insecure --max-time 20 \
    --cookie "$jar" --cookie-jar "$jar" \
    --request "$method" \
    --header 'accept: application/json' \
    ${body:+--header 'content-type: application/json'} \
    ${csrf:+--header "x-velnox-csrf: ${csrf}"} \
    ${body:+--data "$body"} \
    --write-out '\n%{http_code}' \
    "${BASE}${path}")"

  LAST_STATUS="${response##*$'\n'}"
  printf '%s' "${response%$'\n'*}"
}

status() {
  call "$@" >/dev/null
  printf '%s' "$LAST_STATUS"
}

sign_in() {
  local who="$1" email="$2" password="$3"
  rm -f "${JARS}/${who}.jar"
  call "$who" POST /api/v1/auth/login \
    "{\"email\":\"${email}\",\"password\":\"${password}\"}" >/dev/null
  printf '%s' "$LAST_STATUS"
}

# ---------------------------------------------------------------------------
# Get an administrator
# ---------------------------------------------------------------------------

# Long, mixed, and not reused between runs. It is written to stdout once so a
# failed run can be investigated, and it belongs to a throwaway account.
PASSWORD="Vx-${RUN}-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"

INITIALIZED="$(call anon GET /api/v1/setup/status | json initialized)"

if [[ "$INITIALIZED" != "true" ]]; then
  info "Running setup, because this installation has none."
  call anon POST /api/v1/setup/initialize \
    "{\"organisationName\":\"Tenancy Verification\",\"displayName\":\"Verification Admin\",\"email\":\"${RUN}-admin@example.invalid\",\"password\":\"${PASSWORD}\"}" >/dev/null
  check "setup: initialize accepted" 201 "$LAST_STATUS"
  ADMIN_EMAIL="${RUN}-admin@example.invalid"
  ADMIN_PASSWORD="$PASSWORD"
else
  ADMIN_EMAIL="${VELNOX_ADMIN_EMAIL:-}"
  ADMIN_PASSWORD="${VELNOX_ADMIN_PASSWORD:-}"
  if [[ -z "$ADMIN_EMAIL" || -z "$ADMIN_PASSWORD" ]]; then
    echo "This installation is already set up. Provide an administrator:" >&2
    echo "  VELNOX_ADMIN_EMAIL=... VELNOX_ADMIN_PASSWORD=... $0 ${BASE}" >&2
    exit 2
  fi
fi

check "admin: signs in" 200 "$(sign_in msp "$ADMIN_EMAIL" "$ADMIN_PASSWORD")"

# ---------------------------------------------------------------------------
# Build two customers
# ---------------------------------------------------------------------------

info "Creating two tenants, a site each, and an administrator in the first."

TENANT_A="$(call msp POST /api/v1/tenants "{\"name\":\"${RUN} Alpha\"}" | json id)"
check "msp: creates tenant A" 201 "$LAST_STATUS"
TENANT_B="$(call msp POST /api/v1/tenants "{\"name\":\"${RUN} Beta\"}" | json id)"
check "msp: creates tenant B" 201 "$LAST_STATUS"

SITE_A="$(call msp POST /api/v1/sites "{\"tenantId\":\"${TENANT_A}\",\"name\":\"${RUN} Site A\"}" | json id)"
check "msp: creates a site in tenant A" 201 "$LAST_STATUS"
SITE_B="$(call msp POST /api/v1/sites "{\"tenantId\":\"${TENANT_B}\",\"name\":\"${RUN} Site B\"}" | json id)"
check "msp: creates a site in tenant B" 201 "$LAST_STATUS"

ALPHA_EMAIL="${RUN}-alpha@example.invalid"
ALPHA_ID="$(call msp POST /api/v1/users \
  "{\"email\":\"${ALPHA_EMAIL}\",\"displayName\":\"Alpha Administrator\",\"password\":\"${PASSWORD}\",\"tenantId\":\"${TENANT_A}\"}" | json id)"
check "msp: creates an account inside tenant A" 201 "$LAST_STATUS"

# The Tenant Administrator role, granted at tenant scope — the grant this whole
# phase exists to make possible.
TENANT_ADMIN_ROLE="$(call msp GET /api/v1/roles | node -e '
  let raw = ""; process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    const roles = JSON.parse(raw).roles ?? [];
    const role = roles.find((r) => r.key === "tenant_administrator");
    if (role) process.stdout.write(role.id);
  });
' 2>/dev/null)"

if [[ -z "$TENANT_ADMIN_ROLE" ]]; then
  red "could not find the tenant_administrator role"
  FAIL=$((FAIL + 1))
else
  check "msp: grants a role at TENANT scope" 201 \
    "$(status msp POST "/api/v1/users/${ALPHA_ID}/role-assignments" \
      "{\"roleId\":\"${TENANT_ADMIN_ROLE}\",\"scopeType\":\"TENANT\",\"scopeId\":\"${TENANT_A}\"}")"
fi

check "msp: a grant at GLOBAL scope is refused for a customer's account" 409 \
  "$(status msp POST "/api/v1/users/${ALPHA_ID}/role-assignments" \
    "{\"roleId\":\"${TENANT_ADMIN_ROLE}\",\"scopeType\":\"GLOBAL\"}")"

check "msp: a grant scoped to another tenant is refused" 409 \
  "$(status msp POST "/api/v1/users/${ALPHA_ID}/role-assignments" \
    "{\"roleId\":\"${TENANT_ADMIN_ROLE}\",\"scopeType\":\"TENANT\",\"scopeId\":\"${TENANT_B}\"}")"

check "msp: a grant naming a site that does not exist is refused" 404 \
  "$(status msp POST "/api/v1/users/${ALPHA_ID}/role-assignments" \
    "{\"roleId\":\"${TENANT_ADMIN_ROLE}\",\"scopeType\":\"SITE\",\"scopeId\":\"00000000-0000-4000-8000-000000000000\"}")"

# ---------------------------------------------------------------------------
# The boundary, from inside tenant A
# ---------------------------------------------------------------------------

info "Signing in as the tenant administrator and trying to reach tenant B."

check "tenant admin: signs in" 200 "$(sign_in alpha "$ALPHA_EMAIL" "$PASSWORD")"

TENANT_LIST="$(call alpha GET /api/v1/tenants)"
check "tenant admin: the tenant list is one row" 1 \
  "$(printf '%s' "$TENANT_LIST" | grep -o '"id":' | wc -l | tr -d ' ')"
check "tenant admin: the row is their own tenant" "$TENANT_A" \
  "$(printf '%s' "$TENANT_LIST" | json tenants.0.id)"

check "tenant admin: another tenant by id is 404, not 403" 404 \
  "$(status alpha GET "/api/v1/tenants/${TENANT_B}")"
check "tenant admin: another tenant's site by id is 404" 404 \
  "$(status alpha GET "/api/v1/sites/${SITE_B}")"
check "tenant admin: their own site by id is readable" 200 \
  "$(status alpha GET "/api/v1/sites/${SITE_A}")"

SITE_LIST="$(call alpha GET /api/v1/sites)"
check "tenant admin: the site list is one row" 1 \
  "$(printf '%s' "$SITE_LIST" | grep -o '"id":' | wc -l | tr -d ' ')"

# The filter parameter is the interesting case: it is attacker-controlled, and
# it must only ever narrow.
FILTERED="$(call alpha GET "/api/v1/sites?tenantId=${TENANT_B}")"
check "tenant admin: filtering by another tenant returns nothing, not its sites" 0 \
  "$(printf '%s' "$FILTERED" | grep -o '"id":' | wc -l | tr -d ' ')"

USER_LIST="$(call alpha GET "/api/v1/users?tenantId=${TENANT_B}")"
check "tenant admin: the same for accounts" 0 \
  "$(printf '%s' "$USER_LIST" | grep -o '"email":' | wc -l | tr -d ' ')"

check "tenant admin: creating a site in another tenant is refused" 403 \
  "$(status alpha POST /api/v1/sites "{\"tenantId\":\"${TENANT_B}\",\"name\":\"${RUN} Trespass\"}")"

check "tenant admin: creating a site in their own tenant works" 201 \
  "$(status alpha POST /api/v1/sites "{\"tenantId\":\"${TENANT_A}\",\"name\":\"${RUN} Second\"}")"

check "tenant admin: renaming another tenant is refused" 403 \
  "$(status alpha PATCH "/api/v1/tenants/${TENANT_B}" '{"name":"Taken over"}')"

check "tenant admin: creating a tenant is refused" 403 \
  "$(status alpha POST /api/v1/tenants "{\"name\":\"${RUN} Gamma\"}")"

check "tenant admin: creating an account in another tenant is refused" 403 \
  "$(status alpha POST /api/v1/users \
    "{\"email\":\"${RUN}-trespass@example.invalid\",\"displayName\":\"Trespass\",\"password\":\"${PASSWORD}\",\"tenantId\":\"${TENANT_B}\"}")"

# An audit trail that crosses the boundary is the same leak in a different
# shape. What a customer may read is events belonging to their own tenant —
# including ones their MSP performed on them, which is the point of an audit
# trail — and nothing belonging to anyone else.
AUDIT="$(call alpha GET '/api/v1/audit-events?limit=100')"

check "tenant admin: the audit trail carries none of the MSP's own sign-ins" 0 \
  "$(printf '%s' "$AUDIT" | grep -o '"action":"auth.login.succeeded","result":"SUCCESS","actorType":"USER","actorLabel":"'"${ADMIN_EMAIL}" | wc -l | tr -d ' ')"
check "tenant admin: the audit trail never names the other tenant" 0 \
  "$(printf '%s' "$AUDIT" | grep -o "${RUN} Beta" | wc -l | tr -d ' ')"
check "tenant admin: nor the other tenant's site" 0 \
  "$(printf '%s' "$AUDIT" | grep -o "${RUN} Site B" | wc -l | tr -d ' ')"

# Names rather than ids, and that distinction is the finding. A denied request
# is audited with the target the caller asked for, so tenant B's *id* does
# appear — in the record of this tenant administrator being refused, echoed back
# from their own request. Their own input is not a leak. A name they never had
# would be.
#
# The other half is deliberate too: a customer sees what was done to them, and
# by whom. It looks like a leak and is the point of an audit trail, so it is
# pinned here — otherwise someone tightening the filter takes it away and nobody
# notices until a customer asks who changed their cluster.
check "tenant admin: but does see what the MSP did inside their own tenant" 1 \
  "$(printf '%s' "$AUDIT" | grep -o "\"resourceLabel\":\"${RUN} Site A\"" | wc -l | tr -d ' ')"

# ---------------------------------------------------------------------------
# The MSP still sees everything
# ---------------------------------------------------------------------------

info "Confirming the filter narrows without blinding the MSP."

ALL_TENANTS="$(call msp GET /api/v1/tenants)"
check "msp: sees both new tenants" 2 \
  "$(printf '%s' "$ALL_TENANTS" | grep -o "\"name\":\"${RUN} " | wc -l | tr -d ' ')"

check "msp: reads tenant B by id" 200 "$(status msp GET "/api/v1/tenants/${TENANT_B}")"
check "msp: reads tenant B's site by id" 200 "$(status msp GET "/api/v1/sites/${SITE_B}")"

# ---------------------------------------------------------------------------
# Put it back
# ---------------------------------------------------------------------------

info "Cleaning up."

# Tenant A still has an enabled account. That refusal is worth asserting on the
# way out: an archived tenant whose people can still sign in is the worst of
# both states.
check "cleanup: archiving a tenant with an enabled account is refused" 409 \
  "$(status msp DELETE "/api/v1/tenants/${TENANT_A}")"

call msp PATCH "/api/v1/users/${ALPHA_ID}/status" '{"status":"DISABLED"}' >/dev/null

check "cleanup: once the account is disabled, tenant A archives" 200 \
  "$(status msp DELETE "/api/v1/tenants/${TENANT_A}")"
check "cleanup: tenant B archives" 200 "$(status msp DELETE "/api/v1/tenants/${TENANT_B}")"

printf '\n  %d passed, %d failed\n\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] || exit 1
