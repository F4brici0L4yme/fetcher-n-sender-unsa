#!/bin/sh
set -eu
umask 077

# Explicit commands keep the image useful for tests without migrating a database.
if [ "${1:-app}" != app ]; then
  exec "$@"
fi

mkdir -p "${UPLOAD_DIR:-/data/uploads}" "${PROOF_DIR:-/data/uploads/proofs}" "${SESSION_DIR:-/sessions}"
chmod 700 "${UPLOAD_DIR:-/data/uploads}" "${PROOF_DIR:-/data/uploads/proofs}" "${SESSION_DIR:-/sessions}"

expected=$(sha256sum package-lock.json | cut -d ' ' -f 1)
installed=$(cat node_modules/.runtime-lock.sha256 2>/dev/null || true)
if [ "$expected" != "$installed" ]; then
  npm ci
  printf '%s\n' "$expected" > node_modules/.runtime-lock.sha256
fi

xvfb_pid=
app_pid=
cleanup() {
  [ -z "$app_pid" ] || kill "$app_pid" 2>/dev/null || true
  [ -z "$xvfb_pid" ] || kill "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'cleanup; exit 143' TERM
trap 'cleanup; exit 130' INT

if [ "${AULA_CAPTURE_MODE:-browser}" = browser ]; then
  display_num=${DISPLAY:-:99}
  display_num=${display_num#:}
  rm -f "/tmp/.X${display_num}-lock" "/tmp/.X11-unix/X${display_num}"
  Xvfb "${DISPLAY:-:99}" -screen 0 1280x900x24 -nolisten tcp &
  xvfb_pid=$!
  attempts=0
  until xdpyinfo -display "${DISPLAY:-:99}" >/dev/null 2>&1; do
    kill -0 "$xvfb_pid" 2>/dev/null || exit 1
    attempts=$((attempts + 1))
    [ "$attempts" -lt 50 ] || { echo 'Display initialization timed out.' >&2; exit 1; }
    sleep 0.1
  done
fi

if [ ! -f dist/bootstrap/main.js ] || [ "${AUTO_BUILD:-false}" = true ]; then
  npm run build
fi
if [ -z "${DATABASE_URL:-}" ]; then
  printf '%s\n' 'Error: DATABASE_URL is required to run database migrations and start the server.' >&2
  exit 1
fi
npm run db:migrate
node dist/bootstrap/main.js &
app_pid=$!
wait "$app_pid"
