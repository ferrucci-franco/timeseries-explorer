#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

if [ "$(uname -s 2>/dev/null || echo unknown)" != "Linux" ] && [ "${1:-}" != "--force" ]; then
    echo "This helper is intended for Linux ZIP extracts."
    echo "Run with --force if you still want to mark the POSIX scripts executable."
    exit 0
fi

chmod +x \
    serve.sh \
    start-dev-server.sh \
    start-full-desktop.sh \
    build-web.sh \
    build-portable.sh \
    build-all.sh \
    setup-linux.sh

echo "Linux launchers are executable now."
echo "Try: ./start-dev-server.sh"
