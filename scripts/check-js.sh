#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while IFS= read -r -d '' file; do
  node --check "$file"
done < <(find "$ROOT/src" "$ROOT/public" -name '*.js' -print0)

echo "javascript syntax check passed"
