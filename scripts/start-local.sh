#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$REPO_ROOT"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' 'Error: Node.js es requerido para detectar puertos libres en 127.0.0.1.' >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  printf '%s\n' 'Error: Docker con Docker Compose es requerido para iniciar la aplicación.' >&2
  exit 1
fi

read_env_default() {
  key=$1
  fallback=$2
  node -e '
    const fs = require("node:fs");
    const [key, fallback] = process.argv.slice(1);
    let value = "";
    if (fs.existsSync(".env")) {
      const lines = fs.readFileSync(".env", "utf8").split(/\r?\n/);
      for (const raw of lines) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
        const idx = normalized.indexOf("=");
        if (idx <= 0) continue;
        if (normalized.slice(0, idx).trim() !== key) continue;
        let v = normalized.slice(idx + 1).trim();
        if ((v.startsWith("\"") && v.endsWith("\"") && v.length >= 2) || (v.startsWith("\x27") && v.endsWith("\x27") && v.length >= 2)) {
          v = v.slice(1, -1).trim();
        } else {
          const hash = v.indexOf("#");
          if (hash >= 0) v = v.slice(0, hash).trim();
        }
        value = v;
      }
    }
    process.stdout.write(value || fallback);
  ' "$key" "$fallback"
}

read_own_compose_port() {
  container_port=$1
  mapped=$(docker compose port app "$container_port" 2>/dev/null | head -n 1 || true)
  case "$mapped" in
    *:*) printf '%s' "${mapped##*:}" ;;
    *) printf '%s' '' ;;
  esac
}

find_free_port() {
  start_port=$1
  own_port=$2
  exclude_port=$3
  node -e '
    const net = require("node:net");
    const rawStart = (process.argv[1] || "").trim();
    const rawOwn = (process.argv[2] || "").trim();
    const rawExclude = (process.argv[3] || "").trim();
    const start = /^\d{1,5}$/.test(rawStart) ? Number.parseInt(rawStart, 10) : NaN;
    const own = /^\d{1,5}$/.test(rawOwn) ? Number.parseInt(rawOwn, 10) : NaN;
    const exclude = /^\d{1,5}$/.test(rawExclude) ? Number.parseInt(rawExclude, 10) : NaN;
    if (!Number.isInteger(start) || start < 1 || start > 65535) {
      process.stderr.write(`Puerto inicial inválido: ${process.argv[1]}\n`);
      process.exit(1);
    }
    const isFree = (port) => new Promise((resolve) => {
      const server = net.createServer();
      server.unref();
      server.once("error", () => resolve(false));
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
        server.close(() => resolve(true));
      });
    });
    (async () => {
      const maxPort = Math.min(start + 200, 65535);
      for (let port = start; port <= maxPort; port += 1) {
        if (port === exclude) continue;
        if (Number.isInteger(own) && port === own) {
          process.stdout.write(String(port));
          return;
        }
        if (await isFree(port)) {
          process.stdout.write(String(port));
          return;
        }
      }
      process.stderr.write(`No se encontró un puerto libre en 127.0.0.1 a partir de ${start}.\n`);
      process.exit(1);
    })();
  ' "$start_port" "$own_port" "$exclude_port"
}

REQUESTED_APP_PORT=${APP_PORT:-$(read_env_default APP_PORT 3000)}
REQUESTED_VIEWER_PORT=${LOGIN_VIEWER_PORT:-$(read_env_default LOGIN_VIEWER_PORT 6080)}

OWN_APP_PORT=$(read_own_compose_port 3000)
OWN_VIEWER_PORT=$(read_own_compose_port 6080)

SELECTED_APP_PORT=$(find_free_port "$REQUESTED_APP_PORT" "$OWN_APP_PORT" "")
SELECTED_VIEWER_PORT=$(find_free_port "$REQUESTED_VIEWER_PORT" "$OWN_VIEWER_PORT" "$SELECTED_APP_PORT")

if [ "$SELECTED_APP_PORT" != "$REQUESTED_APP_PORT" ]; then
  printf 'Puerto %s ocupado en 127.0.0.1; usando puerto libre %s para el panel.\n' "$REQUESTED_APP_PORT" "$SELECTED_APP_PORT"
fi
if [ "$SELECTED_VIEWER_PORT" != "$REQUESTED_VIEWER_PORT" ]; then
  printf 'Puerto %s ocupado en 127.0.0.1; usando puerto libre %s para el visor.\n' "$REQUESTED_VIEWER_PORT" "$SELECTED_VIEWER_PORT"
fi

APP_PORT=$SELECTED_APP_PORT
LOGIN_VIEWER_PORT=$SELECTED_VIEWER_PORT
APP_PUBLIC_URL="http://127.0.0.1:${APP_PORT}"

export APP_PORT LOGIN_VIEWER_PORT APP_PUBLIC_URL

mkdir -p "${REPO_ROOT}/entregas"

docker compose up -d --build --wait "$@"

(
  umask 077
  tmp_file="${REPO_ROOT}/.runtime-panel-url.tmp.$$"
  printf '%s\n' "$APP_PUBLIC_URL" > "$tmp_file"
  chmod 600 "$tmp_file"
  mv -f "$tmp_file" "${REPO_ROOT}/.runtime-panel-url"
)

printf '\nPanel local activo:      %s\n' "$APP_PUBLIC_URL"
printf 'Agente / Harness:        %s/agente\n' "$APP_PUBLIC_URL"
printf 'MCP (HTTP · Docker):     %s/mcp\n' "$APP_PUBLIC_URL"
printf 'Visor temporal de login: http://127.0.0.1:%s\n' "$LOGIN_VIEWER_PORT"
printf 'Archivo actualizado:     .runtime-panel-url (descubrimiento automático MCP/CLI)\n'
