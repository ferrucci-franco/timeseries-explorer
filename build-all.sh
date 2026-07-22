#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

echo
echo "Building web and portable distributions..."
echo

npm run build:all

echo
echo "All builds completed."
echo "Outputs: dist/ and portable-dist/"
