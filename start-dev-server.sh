#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

if [ "${1:-}" = "--help" ]; then
    script_name="$(basename "$0")"
    echo "Usage: ./$script_name [PORT]"
    echo
    echo "Starts the development server for the branch currently checked out"
    echo "in this working directory. It does not switch Git branches."
    echo "If PORT is omitted, the first free port between 8000 and 8010 is used."
    echo
    echo "To use another branch, stop the server, run:"
    echo "  git switch BRANCH_NAME"
    echo "and then start this file again."
    exit 0
fi

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
        echo "[ERROR] No free port found between 8000 and 8010."
        echo "        Try manually with: ./$(basename "$0") 8080"
        echo
        exit 1
    }
fi

echo "============================================================"
echo "   Timeseries Explorer - Development Server"
echo "============================================================"
echo

if ! command -v npm >/dev/null 2>&1; then
    echo "[ERROR] npm was not found."
    echo "        Install Node.js from https://nodejs.org and try again."
    echo
    exit 1
fi

if command -v git >/dev/null 2>&1; then
    CURRENT_BRANCH="$(git branch --show-current 2>/dev/null || true)"
else
    CURRENT_BRANCH=""
fi

if [ -n "$CURRENT_BRANCH" ]; then
    echo "Git branch: $CURRENT_BRANCH"
else
    echo "Git branch: unavailable or detached HEAD"
fi
echo

if [ ! -d node_modules ]; then
    echo "Installing project dependencies. This may take a few minutes..."
    echo
    npm install
    echo
fi

echo "Starting http://127.0.0.1:$PORT/"
echo "The browser will open when the server is ready."
echo
echo "Keep this terminal open while using the app."
echo "Press Ctrl+C to stop the server."
echo

npm run dev -- --host 127.0.0.1 --port "$PORT" --strictPort --open
