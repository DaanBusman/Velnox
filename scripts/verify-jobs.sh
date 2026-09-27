#!/usr/bin/env bash
# Velnox — acceptance checks for the Phase 5 job system, against a running stack.
#
# docs/roadmap.md, Phase 5:
#   - a long-running job streams progress live to the browser;
#   - cancelling stops it at the next safe boundary and records CANCELLED;
#   - killing the worker mid-job leaves it FAILED with worker_lost, not RUNNING;
#   - two mutating jobs against one key cannot run concurrently;
#   - every invalid state transition throws (the exhaustive part is a unit test,
#     packages/shared/src/jobs.spec.ts; here, the API-level refusals).
# Plus approvals, four-eyes, rejection and retry, because they are Phase 5 too.
#
# Everything runs as `system.selftest` jobs, which take time and touch nothing.
#
# The worker-loss check kills and restarts the worker container. Run it on a
# development stack, not on an installation doing real work.
#
# Signing in:
#   VELNOX_ADMIN_EMAIL=... VELNOX_ADMIN_PASSWORD=... scripts/verify-jobs.sh
# or, with neither set, the script creates a throwaway MSP Super Administrator
# with a random password that exists only in this process, and disables it on
# exit. The password is never printed or written to disk.

set -uo pipefail

BASE="${1:-https://localhost}"
RUN="jv$(date +%s)"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
COMPOSE=(docker compose -f "$ROOT/deploy/compose/docker-compose.yml" --env-file "$ROOT/.env")

PASS=0
FAIL=0
green() { printf '\033[0;32m  ok  \033[0m %s\n' "$1"; }
red() { printf '\033[0;31m FAIL \033[0m %s\n' "$1"; }
info() { printf '\033[0;36m----\033[0m %s\n' "$1"; }

check() {
  local name="$1" want="$2" got="$3"
  if [[ "$got" == "$want" ]]; then
    green "$name"
    PASS=$((PASS + 1))
  else
    red "$name (expected ${want}, got ${got})"
    FAIL=$((FAIL + 1))
  fi
}

check_true() {
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

command -v node >/dev/null 2>&1 || { echo "Needs node." >&2; exit 1; }

json() {
  node -e '
    let raw = "";
    process.stdin.on("data", (c) => (raw += c));
    process.stdin.on("end", () => {
      try {
        let value = JSON.parse(raw);
        for (const key of process.argv[1].split(".")) value = value?.[key];
        if (value !== undefined && value !== null)
          process.stdout.write(typeof value === "object" ? JSON.stringify(value) : String(value));
      } catch { /* no output is the answer */ }
    });
  ' "$1" 2>/dev/null
}

# Values arrive as argv and leave through JSON.stringify: nothing a password can
# contain survives into the request body as syntax.
json_object() {
  node -e '
    const out = {};
    for (let i = 1; i < process.argv.length; i += 2) {
      const raw = process.argv[i + 1];
      out[process.argv[i]] = /^-?\d+$/.test(raw) ? Number(raw) : raw === "true" ? true : raw;
    }
    process.stdout.write(JSON.stringify(out));
  ' "$@"
}

psql_at() { "${COMPOSE[@]}" exec -T postgres psql -U velnox -d velnox -v ON_ERROR_STOP=1 -Atc "$1"; }

WORK="$(mktemp -d)"
JAR="$WORK/cookies"
STATUS_FILE="$WORK/status"
CREATED_USER=""
# Started job ids go to a file for the same reason statuses do: every
# `X="$(start_selftest …)"` runs in a subshell, and an array appended to there is
# gone when it returns. The first version kept them in an array, so cleanup
# cancelled nothing — found when a run that failed half-way left a job parked
# at an approval gate.
STARTED_FILE="$WORK/started"
: >"$STARTED_FILE"

# Status goes to a file, because `X="$(call ...)"` runs in a subshell and a
# variable set there never reaches the caller. verify-tenancy.sh reported a
# clean pass for a phase while comparing every status to the first request's.
call() {
  local method="$1" path="$2" body="${3:-}"
  local csrf=""
  [[ -f "$JAR" ]] && csrf="$(awk '$6 == "velnox_csrf" { print $7 }' "$JAR" | tail -1)"
  local args=(--silent --insecure --max-time 60 --cookie "$JAR" --cookie-jar "$JAR"
    --request "$method" --header 'accept: application/json'
    --output "$WORK/body" --write-out '%{http_code}')
  [[ -n "$csrf" ]] && args+=(--header "x-velnox-csrf: ${csrf}")
  [[ -n "$body" ]] && args+=(--header 'content-type: application/json' --data "$body")
  curl "${args[@]}" "${BASE}${path}" >"$STATUS_FILE"
  cat "$WORK/body"
}
last_status() { cat "$STATUS_FILE"; }

cleanup() {
  # Leave nothing running: a failed run should not hold a lane for a minute.
  local id
  while IFS= read -r id; do
    [[ -n "$id" ]] && call POST "/api/v1/jobs/${id}/cancel" >/dev/null 2>&1
  done <"$STARTED_FILE"
  if [[ -n "$CREATED_USER" ]]; then
    psql_at "UPDATE users SET status = 'DISABLED' WHERE id = '${CREATED_USER}';" >/dev/null 2>&1 &&
      info "Disabled the throwaway account."
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# An administrator
# ---------------------------------------------------------------------------

ADMIN_EMAIL="${VELNOX_ADMIN_EMAIL:-}"
ADMIN_PASSWORD="${VELNOX_ADMIN_PASSWORD:-}"

if [[ -z "$ADMIN_EMAIL" || -z "$ADMIN_PASSWORD" ]]; then
  info "No administrator given; creating a throwaway one for this run."
  ADMIN_EMAIL="${RUN}-admin@example.invalid"
  ADMIN_PASSWORD="$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')"
  HASH="$(P="$ADMIN_PASSWORD" node -e '
    require(process.argv[1]).hashPassword(process.env.P).then((h) => process.stdout.write(h));
  ' "$ROOT/packages/crypto/dist/index.js")"
  [[ "$HASH" == \$argon2id\$* ]] || { red "could not hash a password with @velnox/crypto (is it built?)"; exit 1; }

  CREATED_USER="$(node -e 'process.stdout.write(require("crypto").randomUUID())')"
  MSP="$(psql_at "SELECT id FROM tenants WHERE kind = 'MSP_ROOT';")"
  psql_at "INSERT INTO users (id, tenant_id, email, display_name, password_hash, updated_at)
           VALUES ('${CREATED_USER}', '${MSP}', '${ADMIN_EMAIL}', 'Jobs verification', '${HASH}', now());" >/dev/null ||
    { red "could not create the throwaway account"; CREATED_USER=""; exit 1; }
  psql_at "INSERT INTO role_assignments (id, user_id, role_id, scope_type)
           SELECT gen_random_uuid(), '${CREATED_USER}', id, 'GLOBAL' FROM roles
           WHERE key = 'msp_super_administrator';" >/dev/null ||
    { red "could not grant the throwaway account its role"; exit 1; }
  unset HASH
fi

LOGIN="$(call POST /api/v1/auth/login "$(json_object email "$ADMIN_EMAIL" password "$ADMIN_PASSWORD")")"
unset ADMIN_PASSWORD
check "admin: signs in" 200 "$(last_status)"
SESSION_STATE="$(printf '%s' "$LOGIN" | json status)"
if [[ "$SESSION_STATE" != "authenticated" ]]; then
  red "the session is '${SESSION_STATE}', not authenticated — this installation requires a second factor for administrators; run with VELNOX_ADMIN_* and an enrolled account"
  exit 1
fi

# ---------------------------------------------------------------------------
# Helpers for jobs
# ---------------------------------------------------------------------------

start_selftest() {
  # Arguments are passed straight to json_object: key value key value …
  local body
  body="$(json_object "$@")"
  local out
  out="$(call POST /api/v1/jobs/selftest "$body")"
  local id
  id="$(printf '%s' "$out" | json id)"
  [[ -n "$id" ]] && printf '%s\n' "$id" >>"$STARTED_FILE"
  printf '%s' "$out"
}

job_field() { call GET "/api/v1/jobs/$1" | json "$2"; }

# Wait until the job's status is one of the given ones, or time out.
wait_for() {
  local id="$1" timeout="$2"
  shift 2
  local deadline=$((SECONDS + timeout)) status=""
  while ((SECONDS < deadline)); do
    status="$(job_field "$id" status)"
    for want in "$@"; do [[ "$status" == "$want" ]] && { printf '%s' "$status"; return 0; }; done
    sleep 0.5
  done
  printf '%s' "$status"
  return 1
}

is_terminal() { [[ "$1" =~ ^(SUCCEEDED|PARTIALLY_SUCCEEDED|FAILED|ROLLED_BACK|CANCELLED)$ ]]; }

# ---------------------------------------------------------------------------
# 1. Live progress over the stream
# ---------------------------------------------------------------------------

info "A four-step job, watched over the live stream while it runs."

A="$(start_selftest lane "${RUN}-a" steps 4 secondsPerStep 2)"
check "selftest: accepted" 201 "$(last_status)"
A_ID="$(printf '%s' "$A" | json id)"

# Each line stamped with when it arrived, so "streamed" can be told apart from
# "delivered all at once when the job had finished".
curl --silent --no-buffer --insecure --max-time 90 --cookie "$JAR" \
  --header 'accept: text/event-stream' "${BASE}/api/v1/jobs/${A_ID}/stream" |
  while IFS= read -r line; do printf '%s %s\n' "$(date +%s.%N)" "$line"; done >"$WORK/stream-a" &
STREAM_PID=$!

wait_for "$A_ID" 60 SUCCEEDED FAILED CANCELLED >/dev/null
check "stream: the job finished" SUCCEEDED "$(job_field "$A_ID" status)"

# The stream closes itself after the final event.
for _ in $(seq 1 20); do kill -0 "$STREAM_PID" 2>/dev/null || break; sleep 0.5; done
kill "$STREAM_PID" 2>/dev/null

EVENTS="$(grep -c ' event: job$' "$WORK/stream-a" || true)"
PROGRESS="$(grep -c '"key":"step.progress"' "$WORK/stream-a" || true)"
check_true "stream: carried the job's events (${EVENTS})" test "$EVENTS" -ge 45
check "stream: every progress report arrived (4 steps × 10)" 40 "$PROGRESS"
check_true "stream: ended with done" grep -q ' event: done$' "$WORK/stream-a"

SPREAD="$(grep ' event: job$' "$WORK/stream-a" | awk '{ print int($1) }' | sort -u | wc -l | tr -d ' ')"
check_true "stream: events arrived over ${SPREAD} distinct seconds, not in one burst" test "$SPREAD" -ge 6

# Only the job events: `done` repeats the last id on purpose, so the browser
# keeps its place.
SEQS="$(grep -A1 ' event: job$' "$WORK/stream-a" | grep ' id: ' | awk '{ print $3 }' | tr '\n' ' ')"
DONE_ID="$(grep -A1 ' event: done$' "$WORK/stream-a" | grep ' id: ' | awk '{ print $3 }')"
LAST_SEQ="$(printf '%s' "$SEQS" | awk '{ print $NF }')"
ALL_IDS="$(grep -c ' id: ' "$WORK/stream-a" || true)"
JOB_IDS="$(printf '%s' "$SEQS" | wc -w | tr -d ' ')"
CONTIGUOUS="$(node -e '
  const s = process.argv[1].trim().split(/\s+/).map(Number);
  process.stdout.write(String(s.length > 0 && s.every((v, i) => v === i + 1)));
' "$SEQS")"
check "stream: sequence numbers run 1..n with no gap or repeat" true "$CONTIGUOUS"
check "stream: done carries the last real id, not one of Nest's own" "$LAST_SEQ" "$DONE_ID"
check "stream: every id on the wire is a job event's, or done's" "$((JOB_IDS + 1))" "$ALL_IDS"

# Reconnecting after the end gets `done` straight away, not an open stream.
curl --silent --no-buffer --insecure --max-time 10 --cookie "$JAR" \
  --header "last-event-id: 9999" "${BASE}/api/v1/jobs/${A_ID}/stream" >"$WORK/stream-a2"
check_true "stream: reconnecting to a finished job closes at once with done" grep -q '^event: done' "$WORK/stream-a2"

# ---------------------------------------------------------------------------
# 2. Cancellation
# ---------------------------------------------------------------------------

info "Cancelling a job part-way through a step."

B="$(start_selftest lane "${RUN}-b" steps 5 secondsPerStep 6)"
B_ID="$(printf '%s' "$B" | json id)"
wait_for "$B_ID" 30 RUNNING >/dev/null
sleep 3

CANCEL_AT=$SECONDS
call POST "/api/v1/jobs/${B_ID}/cancel" >/dev/null
check "cancel: accepted" 200 "$(last_status)"
B_STATUS="$(wait_for "$B_ID" 15 CANCELLED FAILED SUCCEEDED)"
CANCEL_TOOK=$((SECONDS - CANCEL_AT))
check "cancel: the job ends CANCELLED" CANCELLED "$B_STATUS"
check_true "cancel: honoured within ${CANCEL_TOOK}s, not at the end of a six-second step" test "$CANCEL_TOOK" -le 4

B_DETAIL="$(call GET "/api/v1/jobs/${B_ID}")"
B_STEPS="$(printf '%s' "$B_DETAIL" | node -e '
  let r = ""; process.stdin.on("data", (c) => (r += c)); process.stdin.on("end", () => {
    const steps = JSON.parse(r).steps;
    process.stdout.write(steps.map((s) => s.status).join(","));
  });')"
check "cancel: the interrupted step failed and the rest were skipped" "FAILED,SKIPPED,SKIPPED,SKIPPED,SKIPPED" "$B_STEPS"

call POST "/api/v1/jobs/${B_ID}/cancel" >/dev/null
check "cancel: a finished job cannot be cancelled again" 409 "$(last_status)"
check "cancel: and says why" job.already_finished "$(json error.code <"$WORK/body")"

C0="$(start_selftest lane "${RUN}-q" steps 1 secondsPerStep 1 approvalBeforeStep 1)"
C0_ID="$(printf '%s' "$C0" | json id)"
wait_for "$C0_ID" 30 WAITING_APPROVAL >/dev/null
call POST "/api/v1/jobs/${C0_ID}/cancel" >/dev/null
check "cancel: a job waiting for approval is cancelled directly" CANCELLED "$(job_field "$C0_ID" status)"

# ---------------------------------------------------------------------------
# 3. One job per key
# ---------------------------------------------------------------------------

info "Two jobs against one concurrency key."

C="$(start_selftest lane "${RUN}-c" steps 3 secondsPerStep 5)"
C_ID="$(printf '%s' "$C" | json id)"
check "concurrency: the first is accepted" 201 "$(last_status)"

start_selftest lane "${RUN}-c" steps 1 secondsPerStep 1 >/dev/null
check "concurrency: the second is refused" 409 "$(last_status)"
check "concurrency: as job.concurrent_run" job.concurrent_run "$(json error.code <"$WORK/body")"
check "concurrency: naming the job in the way" "$C_ID" "$(json error.params.jobId <"$WORK/body")"

OTHER="$(start_selftest lane "${RUN}-c2" steps 1 secondsPerStep 1)"
check "concurrency: a different key is not affected" 201 "$(last_status)"

call POST "/api/v1/jobs/${C_ID}/cancel" >/dev/null
wait_for "$C_ID" 15 CANCELLED >/dev/null
start_selftest lane "${RUN}-c" steps 1 secondsPerStep 1 >/dev/null
check "concurrency: once the first has finished, the key is free" 201 "$(last_status)"

# ---------------------------------------------------------------------------
# 4. Approval, four-eyes, rejection, retry
# ---------------------------------------------------------------------------

info "Approval gates."

D="$(start_selftest lane "${RUN}-d" steps 2 secondsPerStep 1 approvalBeforeStep 2)"
D_ID="$(printf '%s' "$D" | json id)"
check "approval: the job parks at the gate" WAITING_APPROVAL "$(wait_for "$D_ID" 30 WAITING_APPROVAL)"
call POST "/api/v1/jobs/${D_ID}/approve" '{}' >/dev/null
check "approval: accepted" 200 "$(last_status)"
check "approval: the job carries on and finishes" SUCCEEDED "$(wait_for "$D_ID" 30 SUCCEEDED FAILED)"

call POST "/api/v1/jobs/${D_ID}/approve" '{}' >/dev/null
check "approval: a finished job cannot be approved" 409 "$(last_status)"

E="$(start_selftest lane "${RUN}-e" steps 2 secondsPerStep 1 approvalBeforeStep 2 requireDifferentApprover true)"
E_ID="$(printf '%s' "$E" | json id)"
wait_for "$E_ID" 30 WAITING_APPROVAL >/dev/null
call POST "/api/v1/jobs/${E_ID}/approve" '{}' >/dev/null
check "four-eyes: the person who asked cannot approve" 403 "$(last_status)"
check "four-eyes: and is told why" authz.four_eyes "$(json error.code <"$WORK/body")"
check "four-eyes: the job is still waiting" WAITING_APPROVAL "$(job_field "$E_ID" status)"

call POST "/api/v1/jobs/${E_ID}/reject" '{"note":"verification"}' >/dev/null
check "rejection: accepted" 200 "$(last_status)"
check "rejection: the job fails" FAILED "$(job_field "$E_ID" status)"
check "rejection: with job.rejected" job.rejected "$(job_field "$E_ID" errorCode)"

R="$(call POST "/api/v1/jobs/${E_ID}/retry")"
check "retry: a failed job can be retried" 201 "$(last_status)"
check "retry: the new job names its parent" "$E_ID" "$(printf '%s' "$R" | json parentJobId)"
R_ID="$(printf '%s' "$R" | json id)"
[[ -n "$R_ID" ]] && printf '%s\n' "$R_ID" >>"$STARTED_FILE"

call POST "/api/v1/jobs/${D_ID}/retry" >/dev/null
check "retry: a succeeded job cannot be" 409 "$(last_status)"

call GET "/api/v1/jobs/00000000-0000-4000-8000-000000000000" >/dev/null
check "a job that does not exist is 404" 404 "$(last_status)"

# ---------------------------------------------------------------------------
# 5. The worker dies mid-job
# ---------------------------------------------------------------------------

info "Killing the worker while a job runs. This restarts the worker container."

F="$(start_selftest lane "${RUN}-f" steps 5 secondsPerStep 10)"
F_ID="$(printf '%s' "$F" | json id)"
wait_for "$F_ID" 30 RUNNING >/dev/null
sleep 3

"${COMPOSE[@]}" kill -s SIGKILL worker >/dev/null 2>&1
KILLED_AT=$SECONDS
check "worker-lost: just after the kill the job still reads RUNNING" RUNNING "$(job_field "$F_ID" status)"
"${COMPOSE[@]}" up -d worker >/dev/null 2>&1

F_STATUS="$(wait_for "$F_ID" 90 FAILED SUCCEEDED CANCELLED)"
check "worker-lost: the job is reconciled to FAILED" FAILED "$F_STATUS"
check "worker-lost: with job.worker_lost" job.worker_lost "$(job_field "$F_ID" errorCode)"
info "reconciled $((SECONDS - KILLED_AT))s after the kill (lease 30s, reconcile every 15s)"

F_STEPS="$(call GET "/api/v1/jobs/${F_ID}" | node -e '
  let r = ""; process.stdin.on("data", (c) => (r += c)); process.stdin.on("end", () => {
    process.stdout.write(JSON.parse(r).steps.map((s) => s.status).join(","));
  });')"
check "worker-lost: the step in flight failed and none ran after" "FAILED,SKIPPED,SKIPPED,SKIPPED,SKIPPED" "$F_STEPS"

sleep 5
check "worker-lost: it was not retried by the queue" FAILED "$(job_field "$F_ID" status)"
STARTS="$(call GET "/api/v1/jobs/${F_ID}/events?limit=1000" | node -e '
  let r = ""; process.stdin.on("data", (c) => (r += c)); process.stdin.on("end", () => {
    process.stdout.write(String(JSON.parse(r).events.filter((e) => e.key === "job.started").length));
  });')"
check "worker-lost: started once, and never again after the worker died" 1 "$STARTS"

# ---------------------------------------------------------------------------

echo
if ((FAIL == 0)); then
  printf '\033[0;32m%d checks passed.\033[0m\n' "$PASS"
  exit 0
fi
printf '\033[0;31m%d of %d checks failed.\033[0m\n' "$FAIL" $((PASS + FAIL))
exit 1
