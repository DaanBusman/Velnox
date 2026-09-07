#!/usr/bin/env bash
#
# Change the certificate Velnox serves, after it is installed.
#
#   sudo bash scripts/tls.sh --status
#   sudo bash scripts/tls.sh --self-signed
#   sudo bash scripts/tls.sh --letsencrypt=admin@example.com
#   sudo bash scripts/tls.sh --certificate=/path/fullchain.pem --key=/path/privkey.pem
#
# The address Velnox is reached on is not changed here; it comes from
# VELNOX_SITE_ADDRESS in .env and a certificate has to match it.
#
# Everything is validated before anything is written, so a certificate that
# would not have worked is refused while the working one is still in place.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT}/deploy/compose/docker-compose.yml"
ENV_FILE="${ROOT}/.env"

# shellcheck source=lib/env-file.sh
source "${ROOT}/scripts/lib/env-file.sh"
# shellcheck source=lib/tls-config.sh
source "${ROOT}/scripts/lib/tls-config.sh"

C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'
C_RED=$'\033[0;31m'; C_GREEN=$'\033[0;32m'; C_YELLOW=$'\033[0;33m'; C_CYAN=$'\033[0;36m'

info() { printf '  %s\n' "$*"; }
ok()   { printf '  %s✔%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
die()  { printf '\n  %s%sRefused.%s %s\n\n' "$C_BOLD" "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

usage() {
  sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

MODE=""
ACME_EMAIL=""
CERT_FILE=""
KEY_FILE=""
CHAIN_FILE=""
ASSUME_YES=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --status) MODE="status" ;;
    --self-signed | --internal) MODE="internal" ;;
    --letsencrypt=*) MODE="acme"; ACME_EMAIL="${1#*=}" ;;
    --certificate=*) MODE="certificate"; CERT_FILE="${1#*=}" ;;
    --key=*) KEY_FILE="${1#*=}" ;;
    --chain=*) CHAIN_FILE="${1#*=}" ;;
    -y | --yes) ASSUME_YES=1 ;;
    -h | --help) usage 0 ;;
    *) printf 'Unknown option: %s\n\n' "$1" >&2; usage 2 ;;
  esac
  shift
done

[[ -n "$MODE" ]] || usage 2
[[ -f "$ENV_FILE" ]] || die "No .env at ${ENV_FILE}. Is Velnox installed?"

command -v openssl >/dev/null 2>&1 || die "openssl is required and was not found."

SITE_ADDRESS="$(get_env_var "$ENV_FILE" VELNOX_SITE_ADDRESS)"
[[ -n "$SITE_ADDRESS" ]] || die "VELNOX_SITE_ADDRESS is not set in .env."

# ---------------------------------------------------------------------------
# Reading a certificate
# ---------------------------------------------------------------------------

# The leaf only. A fullchain.pem holds the leaf first, then intermediates; every
# question below is about the leaf, and asking openssl about the whole file
# answers it about whichever certificate it happened to parse last.
leaf_of() {
  awk '/-----BEGIN CERTIFICATE-----/{n++} n==1{print} /-----END CERTIFICATE-----/{if(n==1) exit}' "$1"
}

cert_field() {
  leaf_of "$1" | openssl x509 -noout "$2" 2>/dev/null | sed 's/^[^=]*=//'
}

# Every name the leaf is valid for: the SANs, falling back to the CN for a
# certificate old enough not to have any.
cert_names() {
  local text
  text="$(leaf_of "$1" | openssl x509 -noout -ext subjectAltName 2>/dev/null || true)"
  if [[ -n "$text" ]]; then
    printf '%s' "$text" | tr ',' '\n' | sed -n 's/.*DNS://p; s/.*IP Address://p' | tr -d ' '
    return
  fi
  leaf_of "$1" | openssl x509 -noout -subject 2>/dev/null | sed -n 's/.*CN *= *\([^,/]*\).*/\1/p'
}

# Does any name cover the address operators use? Handles one level of wildcard,
# which is what a wildcard certificate actually grants.
covers_address() {
  local file="$1" address="$2" name
  # `|| [[ -n "$name" ]]` so a final line without a trailing newline is still
  # considered, whatever a future openssl decides to print.
  while IFS= read -r name || [[ -n "$name" ]]; do
    [[ -n "$name" ]] || continue
    [[ "$name" == "$address" ]] && return 0
    if [[ "$name" == '*.'* && "$address" == *.* ]]; then
      [[ "${address#*.}" == "${name#\*.}" ]] && return 0
    fi
  done < <(cert_names "$file")
  return 1
}

# ---------------------------------------------------------------------------
# Status
# ---------------------------------------------------------------------------

show_status() {
  local configured mode dir
  configured="$(get_env_var "$ENV_FILE" VELNOX_TLS)"
  mode="$(tls_mode_of "$configured")"
  dir="$(tls_dir "$ROOT")"

  printf '\n  %sTLS%s  %s%s%s\n\n' "$C_BOLD" "$C_RESET" "$C_DIM" "https://${SITE_ADDRESS}" "$C_RESET"

  case "$mode" in
    internal)
      info "Mode      self-signed (Caddy's own certificate authority)"
      info "          Browsers warn once. Right for an appliance reached by IP."
      ;;
    acme)
      info "Mode      Let's Encrypt, ACME account ${configured}"
      info "          Needs ${SITE_ADDRESS} to resolve publicly and reach ports 80 and 443."
      ;;
    certificate)
      info "Mode      certificate supplied by you"
      local cert="${dir}/${TLS_CERT_NAME}"
      if [[ -s "$cert" ]]; then
        info "Subject   $(cert_field "$cert" -subject)"
        info "Issuer    $(cert_field "$cert" -issuer)"
        info "Expires   $(cert_field "$cert" -enddate)"
        if ! leaf_of "$cert" | openssl x509 -noout -checkend 0 >/dev/null 2>&1; then
          warn "This certificate has expired."
        elif ! leaf_of "$cert" | openssl x509 -noout -checkend 2592000 >/dev/null 2>&1; then
          warn "Expires within 30 days. Renewals are not automatic in this mode."
        fi
      else
        warn "No certificate file at ${cert}."
      fi
      ;;
  esac

  printf '\n  %sWhat is actually being served%s\n' "$C_BOLD" "$C_RESET"
  local served
  if served="$(echo | openssl s_client -connect "${SITE_ADDRESS}:443" -servername "${SITE_ADDRESS}" 2>/dev/null | openssl x509 -noout -subject -issuer -enddate 2>/dev/null)"; then
    printf '%s\n' "$served" | sed 's/^/  /'
  else
    warn "Could not complete a TLS handshake with ${SITE_ADDRESS}:443."
    info "That is expected if the address does not resolve from this machine."
  fi
  printf '\n'
}

# ---------------------------------------------------------------------------
# Applying a change
# ---------------------------------------------------------------------------

confirm() {
  [[ $ASSUME_YES -eq 1 ]] && return 0
  local answer
  read -r -p "  $1 [y/N]: " answer </dev/tty || answer=""
  [[ "$answer" =~ ^[Yy]$ ]]
}

reload_caddy() {
  info "Restarting Caddy…"
  # Restart, not `caddy reload`: the admin API is deliberately off, so there is
  # nothing to reload through. It costs about a second of downtime on the
  # console and nothing on a managed node — the worker holds no connection
  # through Caddy.
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" restart caddy >/dev/null
}

verify_served() {
  local expect_self_signed="$1" attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    sleep 2
    if echo | openssl s_client -connect "${SITE_ADDRESS}:443" -servername "${SITE_ADDRESS}" 2>/dev/null |
      openssl x509 -noout -subject >/dev/null 2>&1; then
      ok "Velnox answered a TLS handshake on ${SITE_ADDRESS}:443."
      return 0
    fi
  done

  warn "No TLS handshake after 20 seconds."
  if [[ "$expect_self_signed" == "acme" ]]; then
    info "Let's Encrypt issuance can take a minute, and fails if ${SITE_ADDRESS}"
    info "does not resolve publicly or ports 80 and 443 are not reachable."
    info "Watch it: docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} logs -f caddy"
  fi
  return 1
}

apply_mode() {
  local value="$1"
  set_env_var "$ENV_FILE" VELNOX_TLS "$value"
  write_tls_config "$ROOT" "$value"
  reload_caddy
}

case "$MODE" in
  status)
    show_status
    exit 0
    ;;

  internal)
    info "Switching to a self-signed certificate from Caddy's own CA."
    confirm "Continue?" || die "Nothing changed."
    apply_mode internal
    ok "Configured."
    verify_served internal || true
    info "Browsers will warn once. That is expected for a self-signed certificate."
    ;;

  acme)
    [[ "$ACME_EMAIL" == *@*.* ]] || die "--letsencrypt needs an email address, for the ACME account."
    if [[ "$SITE_ADDRESS" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      die "VELNOX_SITE_ADDRESS is ${SITE_ADDRESS}. Let's Encrypt does not issue certificates for IP addresses — set a hostname first."
    fi
    info "Requesting a Let's Encrypt certificate for ${SITE_ADDRESS}."
    info "This needs the name to resolve publicly and ports 80 and 443 to reach this host."
    confirm "Continue?" || die "Nothing changed."
    apply_mode "$ACME_EMAIL"
    ok "Configured. Caddy obtains and renews the certificate on its own."
    verify_served acme || true
    ;;

  certificate)
    [[ -n "$KEY_FILE" ]] || die "--certificate also needs --key."
    [[ -r "$CERT_FILE" ]] || die "Cannot read ${CERT_FILE}."
    [[ -r "$KEY_FILE" ]] || die "Cannot read ${KEY_FILE}."
    [[ -z "$CHAIN_FILE" || -r "$CHAIN_FILE" ]] || die "Cannot read ${CHAIN_FILE}."

    # Everything is checked before anything is written. A certificate that would
    # not have worked is refused while the working one is still serving.
    leaf_of "$CERT_FILE" | openssl x509 -noout >/dev/null 2>&1 ||
      die "${CERT_FILE} is not a PEM certificate."
    openssl pkey -in "$KEY_FILE" -noout >/dev/null 2>&1 ||
      die "${KEY_FILE} is not a readable PEM private key. An encrypted key must be decrypted first."

    cert_pub="$(leaf_of "$CERT_FILE" | openssl x509 -noout -pubkey 2>/dev/null)"
    key_pub="$(openssl pkey -in "$KEY_FILE" -pubout 2>/dev/null)"
    [[ -n "$cert_pub" && "$cert_pub" == "$key_pub" ]] ||
      die "That key does not belong to that certificate."
    ok "The key matches the certificate."

    leaf_of "$CERT_FILE" | openssl x509 -noout -checkend 0 >/dev/null 2>&1 ||
      die "That certificate has already expired ($(cert_field "$CERT_FILE" -enddate))."

    if ! leaf_of "$CERT_FILE" | openssl x509 -noout -checkend 2592000 >/dev/null 2>&1; then
      warn "Expires within 30 days: $(cert_field "$CERT_FILE" -enddate)"
    else
      ok "Valid until $(cert_field "$CERT_FILE" -enddate)"
    fi

    # A warning and not a refusal: an operator may be installing ahead of a DNS
    # change, and refusing would make the correct order impossible.
    if covers_address "$CERT_FILE" "$SITE_ADDRESS"; then
      ok "Covers ${SITE_ADDRESS}."
    else
      warn "Does not appear to cover ${SITE_ADDRESS}. Browsers will reject it."
      warn "Names on the certificate: $(cert_names "$CERT_FILE" | tr '\n' ' ')"
    fi

    if [[ $(leaf_of "$CERT_FILE" | wc -l) -eq $(grep -c '' "$CERT_FILE") ]]; then
      [[ -n "$CHAIN_FILE" ]] ||
        warn "Only one certificate in that file. Most browsers also need the issuer chain — pass --chain=, or use your provider's fullchain file."
    fi

    printf '\n'
    info "Subject   $(cert_field "$CERT_FILE" -subject)"
    info "Issuer    $(cert_field "$CERT_FILE" -issuer)"
    info "Expires   $(cert_field "$CERT_FILE" -enddate)"
    printf '\n'
    confirm "Install this certificate?" || die "Nothing changed."

    dir="$(tls_dir "$ROOT")"
    mkdir -p "$dir"
    chmod 700 "$dir"

    # Written to temporary names and moved into place, so a failure part-way
    # through cannot leave Caddy with a certificate and the previous key.
    cat "$CERT_FILE" >"${dir}/.${TLS_CERT_NAME}.new"
    [[ -n "$CHAIN_FILE" ]] && cat "$CHAIN_FILE" >>"${dir}/.${TLS_CERT_NAME}.new"
    cat "$KEY_FILE" >"${dir}/.${TLS_KEY_NAME}.new"
    chmod 644 "${dir}/.${TLS_CERT_NAME}.new"
    chmod 600 "${dir}/.${TLS_KEY_NAME}.new"
    mv "${dir}/.${TLS_CERT_NAME}.new" "${dir}/${TLS_CERT_NAME}"
    mv "${dir}/.${TLS_KEY_NAME}.new" "${dir}/${TLS_KEY_NAME}"

    apply_mode certificate
    ok "Installed."
    verify_served certificate || true
    warn "Renewal is yours in this mode. Velnox will warn when it is within 30 days."
    ;;
esac

printf '\n  Check it any time: %ssudo bash %s/scripts/tls.sh --status%s\n\n' \
  "$C_CYAN" "$ROOT" "$C_RESET"
