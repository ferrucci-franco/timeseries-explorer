#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

echo
echo "Building web distribution..."
echo

npm run build:web

echo
echo "Web build completed."
echo "Output: dist/"
