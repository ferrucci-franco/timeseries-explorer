#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

if ! command -v npm >/dev/null 2>&1; then
    echo
    echo "npm was not found."
    echo "Install Node.js to run the Full Desktop version from this checkout."
    echo
    exit 1
fi

if [ ! -d node_modules/electron ]; then
    echo
    echo "Preparing Time Series Explorer Full Desktop dependencies..."
    echo "This may take a while the first time."
    echo
    npm install
fi

echo
echo "Starting Time Series Explorer Full Desktop..."
echo
npm run desktop
