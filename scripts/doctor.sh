#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INIT=false
FAILURES=0

for arg in "$@"; do
  case "$arg" in
    --init) INIT=true ;;
    -h|--help)
      cat <<'HELP'
Usage: npm run doctor [-- --init]

Checks local prerequisites and deployment inputs. With --init, creates ignored
runtime directories used by Docker and local development.
HELP
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

pass() {
  printf 'ok   %s\n' "$1"
}

warn() {
  printf 'warn %s\n' "$1"
}

fail() {
  printf 'fail %s\n' "$1"
  FAILURES=$((FAILURES + 1))
}

find_docker() {
  if [ -n "${DOCKER_BIN:-}" ]; then
    printf '%s\n' "$DOCKER_BIN"
    return
  fi
  if command -v docker >/dev/null 2>&1; then
    command -v docker
    return
  fi
  if [ -x "/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe" ]; then
    printf '%s\n' "/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe"
  fi
}

if [ "$INIT" = true ]; then
  mkdir -p "$ROOT/data" "$ROOT/state" "$ROOT/rclone" "$ROOT/secrets"
  chmod 700 "$ROOT/secrets"
  pass "created ignored runtime directories"
fi

if command -v node >/dev/null 2>&1; then
  if node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
    pass "Node.js $(node -v) satisfies >=22"
  else
    fail "Node.js >=22 is required, found $(node -v)"
  fi
else
  fail "Node.js is not installed"
fi

if command -v npm >/dev/null 2>&1; then
  pass "npm $(npm -v) is available"
else
  fail "npm is not installed"
fi

DOCKER="$(find_docker || true)"
if [ -n "$DOCKER" ]; then
  pass "Docker CLI found at $DOCKER"
  if "$DOCKER" version >/dev/null 2>&1; then
    pass "Docker daemon is reachable"
  else
    fail "Docker CLI is installed but the daemon is not reachable"
  fi
else
  fail "Docker CLI was not found; set DOCKER_BIN if it is outside PATH"
fi

if command -v rclone >/dev/null 2>&1; then
  pass "host rclone $(rclone version | head -n 1) is available"
else
  warn "host rclone not found; install it to create or test a Proton Drive remote"
fi

for file in \
  "$ROOT/config/docksync.env.example" \
  "$ROOT/docker-compose.yml" \
  "$ROOT/Dockerfile" \
  "$ROOT/README.md" \
  "$ROOT/tokens.json"; do
  if [ -f "$file" ]; then
    pass "found ${file#$ROOT/}"
  else
    fail "missing ${file#$ROOT/}"
  fi
done

if node -e 'JSON.parse(require("node:fs").readFileSync("tokens.json", "utf8"))' >/dev/null 2>&1; then
  pass "tokens.json is valid JSON"
else
  fail "tokens.json is not valid JSON"
fi

if grep -q '^RCLONE_REMOTE=' "$ROOT/config/docksync.env.example" &&
  grep -q '^RCLONE_CONFIG=' "$ROOT/config/docksync.env.example"; then
  pass "Rclone environment template is present"
else
  fail "config/docksync.env.example is missing Rclone settings"
fi

for dir in data state rclone secrets; do
  if [ -d "$ROOT/$dir" ]; then
    pass "local $dir/ directory exists"
  else
    warn "local $dir/ directory is missing; run npm run onboard"
  fi
done

if [ -f "$ROOT/rclone/rclone.conf" ]; then
  pass "rclone/rclone.conf exists"
else
  warn "rclone/rclone.conf is missing until Proton Drive is configured with rclone"
fi

if npm pack --dry-run --json | grep -Eq 'PROMPT|data;C|state;C|secrets|rclone.conf|docker-test|[.]github'; then
  fail "npm package dry-run includes ignored local or CI material"
else
  pass "npm package dry-run excludes local secrets and generated data"
fi

if [ "$FAILURES" -gt 0 ]; then
  printf '\n%d preflight check(s) failed\n' "$FAILURES" >&2
  exit 1
fi

printf '\nDockSync preflight passed\n'
