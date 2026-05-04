#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${DOCKSYNC_RELEASE_IMAGE:-docksync:release-check}"
CONTAINER="docksync-release-check-$$"
TEST_ROOT="$ROOT/docker-test/release-check"

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
    return
  fi
  echo "Docker is required for release-check. Set DOCKER_BIN to the Docker CLI path." >&2
  exit 1
}

docker_path() {
  if [[ "$DOCKER" == *.exe ]] && command -v wslpath >/dev/null 2>&1; then
    wslpath -m "$1"
  else
    printf '%s\n' "$1"
  fi
}

free_port() {
  node <<'NODE'
const net = require('node:net');
const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  console.log(server.address().port);
  server.close();
});
NODE
}

cleanup() {
  "$DOCKER" rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

DOCKER="$(find_docker)"
PORT="$(free_port)"

while IFS= read -r -d '' file; do
  node --check "$file"
done < <(find "$ROOT/src" "$ROOT/public" -name '*.js' -print0)
npm test

rm -rf "$TEST_ROOT"
mkdir -p "$TEST_ROOT/local" "$TEST_ROOT/state/rclone-remote/DockSync" "$TEST_ROOT/rclone"
printf 'release local\n' > "$TEST_ROOT/local/release-local.txt"
printf 'release remote\n' > "$TEST_ROOT/state/rclone-remote/DockSync/release-remote.txt"
: > "$TEST_ROOT/rclone/rclone.conf"
chmod -R ugo+rwX "$TEST_ROOT/local" "$TEST_ROOT/state"
chmod -R ugo+rX "$TEST_ROOT/rclone"

"$DOCKER" build -t "$IMAGE" "$(docker_path "$ROOT")"
"$DOCKER" rm -f "$CONTAINER" >/dev/null 2>&1 || true
"$DOCKER" run -d --name "$CONTAINER" \
  --read-only \
  --user 10001:10001 \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --tmpfs /tmp:noexec,nosuid,nodev,size=64m \
  -p "127.0.0.1:$PORT:8080" \
  -e SYNC_BACKEND=rclone \
  -e SYNC_LOCAL_PATH=/data \
  -e STATE_DIR=/state \
  -e RCLONE_REMOTE=:local:/state/rclone-remote \
  -e RCLONE_CONFIG=/config/rclone/rclone.conf \
  -e SYNC_REMOTE_PATH=/DockSync \
  -e SYNC_INTERVAL_SECONDS=3600 \
  -e ENABLE_REST_API=true \
  --mount "type=bind,source=$(docker_path "$TEST_ROOT/local"),target=/data" \
  --mount "type=bind,source=$(docker_path "$TEST_ROOT/state"),target=/state" \
  --mount "type=bind,source=$(docker_path "$TEST_ROOT/rclone"),target=/config/rclone,readonly" \
  "$IMAGE" >/dev/null

for i in {1..60}; do
  if curl -fsS "http://127.0.0.1:$PORT/status" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
  if [ "$i" = 60 ]; then
    "$DOCKER" logs "$CONTAINER"
    exit 1
  fi
done

for i in {1..60}; do
  status="$(curl -fsS "http://127.0.0.1:$PORT/status")"
  if node -e 'const s=JSON.parse(process.argv[1]); process.exit(s.lastSync?.ok && !s.running && s.history?.length === 1 && s.lastSync?.actionCount === 2 ? 0 : 1)' "$status"; then
    break
  fi
  sleep 0.5
  if [ "$i" = 60 ]; then
    "$DOCKER" logs "$CONTAINER"
    exit 1
  fi
done

curl -fsS "http://127.0.0.1:$PORT/" | rg -q 'DockSync Console'
curl -fsS "http://127.0.0.1:$PORT/styles.css" | rg -q -- '--font-protonserif'
curl -fsS "http://127.0.0.1:$PORT/variables.css" | rg -q -- '--color-action-violet'
curl -fsS "http://127.0.0.1:$PORT/theme.css" | rg -q '@theme'
curl -fsS "http://127.0.0.1:$PORT/tokens.json" | rg -q 'privacy-violet'
curl -fsS "http://127.0.0.1:$PORT/healthz" | node -e 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => { const h=JSON.parse(data); process.exit(h.ok ? 0 : 1); });'

printf 'release manual\n' > "$TEST_ROOT/local/release-manual.txt"
curl -fsS -X POST "http://127.0.0.1:$PORT/sync" >/dev/null
for i in {1..60}; do
  status="$(curl -fsS "http://127.0.0.1:$PORT/status")"
  if node -e 'const s=JSON.parse(process.argv[1]); process.exit(s.lastSync?.reason === "manual" && s.lastSync?.ok && !s.running && s.history?.length >= 2 ? 0 : 1)' "$status"; then
    break
  fi
  sleep 0.5
  if [ "$i" = 60 ]; then
    "$DOCKER" logs "$CONTAINER"
    exit 1
  fi
done

cmp "$TEST_ROOT/local/release-local.txt" "$TEST_ROOT/state/rclone-remote/DockSync/release-local.txt"
cmp "$TEST_ROOT/local/release-remote.txt" "$TEST_ROOT/state/rclone-remote/DockSync/release-remote.txt"
cmp "$TEST_ROOT/local/release-manual.txt" "$TEST_ROOT/state/rclone-remote/DockSync/release-manual.txt"

inspect="$("$DOCKER" inspect "$CONTAINER" --format '{{.Config.User}} {{.HostConfig.ReadonlyRootfs}} {{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}}')"
test "$inspect" = '10001:10001 true ["ALL"] ["no-new-privileges:true"]'

echo "release check passed"
