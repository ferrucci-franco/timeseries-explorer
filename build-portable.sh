#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")"

echo
echo "Building portable distribution..."
echo

npm run build:portable

echo
echo "Portable build completed."
echo "Output: portable-dist/"
