# shellcheck shell=bash
#
# Helpers for reading and writing the .env file, and for generating secrets.
#
# Shared by gen-env.sh and install.sh so there is exactly one implementation of
# "set this variable" and no chance of the two drifting into subtly different
# escaping rules.
#
# Randomness comes from /dev/urandom through coreutils, deliberately: a fresh
# Debian or Ubuntu VM has neither Node nor openssl guaranteed, and the installer
# has to generate secrets before it has installed anything.

# Sets KEY=VALUE in a .env file, replacing an existing line or appending.
#
# The sed delimiter is `|` rather than `/` because generated secrets are base64
# and contain `/` and `+` — but never `|`.
set_env_var() {
  local file="$1" key="$2" value="$3"

  if grep -qE "^${key}=" "$file" 2>/dev/null; then
    sed -i.tmp "s|^${key}=.*|${key}=${value}|" "$file"
    rm -f "${file}.tmp"
  else
    printf '%s=%s\n' "$key" "$value" >>"$file"
  fi
}

# Reads a value out of a .env file. Prints nothing when the key is absent.
get_env_var() {
  local file="$1" key="$2"
  [[ -f "$file" ]] || return 0
  sed -n "s|^${key}=||p" "$file" | head -1
}

# N random bytes, base64 encoded, on one line.
random_base64() {
  head -c "$1" /dev/urandom | base64 | tr -d '\n'
}

# A 32-character alphanumeric password.
#
# Alphanumeric only because this value is interpolated into a PostgreSQL
# connection URL and passed to redis-server on a command line; `@`, `:` and `/`
# would need escaping in one of those places and eventually would not get it.
# 32 characters of base62 is about 190 bits, so nothing is lost.
random_password() {
  local raw
  raw="$(head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9')"
  printf '%s' "${raw:0:32}"
}
