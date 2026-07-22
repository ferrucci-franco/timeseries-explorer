#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

open_url() {
    url="$1"
    if command -v xdg-open >/dev/null 2>&1; then
        xdg-open "$url" >/dev/null 2>&1 &
    elif command -v open >/dev/null 2>&1; then
        open "$url" >/dev/null 2>&1 &
    fi
}

port_is_free() {
    port="$1"
    if command -v python3 >/dev/null 2>&1; then
        python3 - "$port" <<'PY'
import socket
import sys

port = int(sys.argv[1])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    sock.bind(("127.0.0.1", port))
except OSError:
    sys.exit(1)
finally:
    sock.close()
PY
        return $?
    fi

    if command -v python >/dev/null 2>&1; then
        python - "$port" <<'PY'
import socket
import sys

port = int(sys.argv[1])
sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    sock.bind(("127.0.0.1", port))
except OSError:
    sys.exit(1)
finally:
    sock.close()
PY
        return $?
    fi

    return 0
}

find_free_port() {
    for candidate in 8000 8001 8002 8003 8004 8005 8006 8007 8008 8009 8010; do
        if port_is_free "$candidate"; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

PORT="${1:-}"
if [ -z "$PORT" ]; then
    PORT="$(find_free_port)" || {
        echo
        echo "No free port found between 8000 and 8010."
        echo "Try manually with: sh serve.sh 8080"
        echo
        exit 1
    }
fi

SERVER_URL="http://localhost:${PORT}/index.html"

if command -v npm >/dev/null 2>&1 && [ -f package.json ]; then
    if [ ! -x node_modules/.bin/vite ]; then
        echo
        echo "Preparing Time Series Explorer dependencies..."
        echo "This may take a few minutes the first time."
        echo
        npm install
    fi

    echo
    echo "Starting Time Series Explorer Light Web with Vite:"
    echo "  $SERVER_URL"
    echo
    echo "This mode matches the web version: no local API and no Live Update."
    echo "Press Ctrl+C to stop the server."
    echo
    exec npm run dev -- --host 127.0.0.1 --port "$PORT" --strictPort --open /index.html
fi

if command -v node >/dev/null 2>&1 && [ -f scripts/portable-server.mjs ]; then
    echo
    echo "Starting Time Series Explorer Web Preview:"
    echo "  $SERVER_URL"
    echo
    echo "This mode matches the web version: no local API and no Live Update."
    echo "Press Ctrl+C to stop the server."
    echo
    OMV_PORT="$PORT" OMV_WEB_PREVIEW=1 exec node scripts/portable-server.mjs
fi

if command -v python3 >/dev/null 2>&1; then
    PY_CMD="python3"
elif command -v python >/dev/null 2>&1; then
    PY_CMD="python"
else
    echo
    echo "Could not find npm, Node.js, or Python."
    echo "Install Node.js and run npm install, or install Python 3."
    echo
    exit 1
fi

echo
echo "Starting Time Series Explorer Light Web with Python:"
echo "  $SERVER_URL"
echo
echo "This mode matches the web version: no local API and no Live Update."
echo "Press Ctrl+C to stop the server."
echo
open_url "$SERVER_URL"
exec "$PY_CMD" -m http.server "$PORT"
