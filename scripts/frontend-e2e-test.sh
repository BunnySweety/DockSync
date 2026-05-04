#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

PORT="$(
  node <<'NODE'
const net = require('node:net');
const server = net.createServer();
server.listen(0, '127.0.0.1', () => {
  console.log(server.address().port);
  server.close();
});
NODE
)"

mkdir -p "$TMP_DIR/bin" "$TMP_DIR/local" "$TMP_DIR/remote" "$TMP_DIR/state"
printf 'from local e2e\n' > "$TMP_DIR/local/local-e2e.txt"
printf 'from remote e2e\n' > "$TMP_DIR/remote/remote-e2e.txt"
: > "$TMP_DIR/rclone.conf"

cat > "$TMP_DIR/bin/rclone" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config|--bwlimit|--checkers|--transfers)
      shift 2
      ;;
    --*)
      shift
      ;;
    *)
      break
      ;;
  esac
done

cmd="${1:-}"
[ "$#" -gt 0 ] && shift

to_local_path() {
  case "$1" in
    :local:*) printf '%s\n' "${1#:local:}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

case "$cmd" in
  version)
    echo "rclone v-test"
    ;;
  mkdir)
    mkdir -p "$(to_local_path "$1")"
    ;;
  lsjson)
    target=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --recursive|--files-only|--hash) shift ;;
        *) target="$1"; shift ;;
      esac
    done
    node - "$(to_local_path "$target")" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = process.argv[2];
const files = [];

function walk(directory, prefix = '') {
  if (!fs.existsSync(directory)) return;
  for (const name of fs.readdirSync(directory)) {
    const fullPath = path.join(directory, name);
    const relativePath = prefix ? `${prefix}/${name}` : name;
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      walk(fullPath, relativePath);
    } else if (stat.isFile()) {
      files.push({
        Path: relativePath,
        Size: stat.size,
        ModTime: stat.mtime.toISOString(),
        Hashes: {
          SHA1: crypto.createHash('sha1').update(fs.readFileSync(fullPath)).digest('hex'),
        },
      });
    }
  }
}

walk(root);
console.log(JSON.stringify(files));
NODE
    ;;
  copyto)
    source="$(to_local_path "$1")"
    destination="$(to_local_path "$2")"
    mkdir -p "$(dirname "$destination")"
    cp "$source" "$destination"
    ;;
  deletefile)
    rm -f "$(to_local_path "$1")"
    ;;
  *)
    echo "unsupported rclone command: $cmd" >&2
    exit 2
    ;;
esac
SH
chmod +x "$TMP_DIR/bin/rclone"

SYNC_BACKEND=rclone \
SYNC_LOCAL_PATH="$TMP_DIR/local" \
RCLONE_BINARY="$TMP_DIR/bin/rclone" \
RCLONE_REMOTE=":local:$TMP_DIR/remote" \
RCLONE_CONFIG="$TMP_DIR/rclone.conf" \
STATE_DIR="$TMP_DIR/state" \
API_HOST=127.0.0.1 \
API_PORT="$PORT" \
SYNC_INTERVAL_SECONDS=3600 \
ENABLE_REST_API=true \
node "$ROOT/src/index.js" > "$TMP_DIR/server.log" 2>&1 &
SERVER_PID="$!"

node - "$PORT" "$TMP_DIR" <<'NODE'
const fs = require('node:fs/promises');
const path = require('node:path');

let baseUrl;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function getText(route) {
  const response = await fetch(`${baseUrl}${route}`);
  assert(response.ok, `${route} returned ${response.status}`);
  return response.text();
}

async function getJson(route) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { accept: 'application/json' },
  });
  assert(response.ok, `${route} returned ${response.status}`);
  return response.json();
}

async function waitFor(predicate, label) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < 10000) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

(async () => {
  const port = process.argv[2];
  const tmpDir = process.argv[3];
  baseUrl = `http://127.0.0.1:${port}`;

  await waitFor(() => getJson('/status'), 'HTTP server');
  const initialStatus = await waitFor(async () => {
    const status = await getJson('/status');
    return status.lastSync?.ok && !status.running ? status : null;
  }, 'initial scheduled sync');

  assert(initialStatus.backend === 'rclone', 'status exposes rclone backend');
  assert(initialStatus.config?.manualSyncEnabled === true, 'status exposes manual sync config');
  assert(initialStatus.config?.rcloneRemote?.startsWith(':local:'), 'status exposes rclone remote');
  assert(initialStatus.history?.length === 1, 'status records initial sync history');
  assert(initialStatus.lastSync.actionCount === 2, 'initial sync records upload and download');

  const health = await getJson('/healthz');
  assert(health.ok === true, 'health endpoint is healthy');

  const indexHtml = await getText('/');
  assert(indexHtml.includes('DockSync Console'), 'frontend document title is served');
  assert(indexHtml.includes('href="/variables.css"'), 'frontend loads variables.css');
  assert(indexHtml.includes('id="syncButton"'), 'frontend exposes sync button');
  assert(indexHtml.includes('id="activityRows"'), 'frontend exposes activity list');

  const styles = await getText('/styles.css');
  assert(styles.includes('var(--font-protonserif)'), 'frontend styles consume heading font token');
  assert(styles.includes('var(--radius-cards)'), 'frontend styles consume card radius token');

  const variables = await getText('/variables.css');
  assert(variables.includes('--color-action-violet'), 'variables.css is served');
  const theme = await getText('/theme.css');
  assert(theme.includes('@theme'), 'theme.css is served');
  const tokens = await getJson('/tokens.json');
  assert(tokens.color?.['privacy-violet']?.$value === '#372580', 'tokens.json is served and parseable');

  await fs.writeFile(path.join(tmpDir, 'local', 'manual-e2e.txt'), 'manual e2e\n');
  const syncResponse = await fetch(`${baseUrl}/sync`, { method: 'POST' });
  assert(syncResponse.status === 202, 'manual sync is accepted');

  const manualStatus = await waitFor(async () => {
    const status = await getJson('/status');
    return status.lastSync?.reason === 'manual' && status.lastSync?.ok && !status.running ? status : null;
  }, 'manual sync completion');

  assert(manualStatus.history?.length >= 2, 'manual sync appends sync history');
  assert(manualStatus.lastSync.actions.some((action) => action.type === 'upload' && action.path === 'manual-e2e.txt'), 'manual sync reports uploaded file');
  await fs.access(path.join(tmpDir, 'remote', 'manual-e2e.txt'));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
NODE

echo "frontend e2e test passed"
