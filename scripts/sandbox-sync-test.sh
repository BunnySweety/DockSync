#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

mkdir -p "$TMP_DIR/bin" "$TMP_DIR/local" "$TMP_DIR/remote" "$TMP_DIR/state"
printf 'from local\n' > "$TMP_DIR/local/local.txt"
printf 'from remote\n' > "$TMP_DIR/remote/remote.txt"
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

run_sync() {
  SYNC_BACKEND=rclone \
  SYNC_LOCAL_PATH="$TMP_DIR/local" \
  RCLONE_BINARY="$TMP_DIR/bin/rclone" \
  RCLONE_REMOTE=":local:$TMP_DIR/remote" \
  RCLONE_CONFIG="$TMP_DIR/rclone.conf" \
  STATE_DIR="$TMP_DIR/state" \
  SYNC_ONCE=true \
  ENABLE_REST_API=false \
  node "$ROOT/src/index.js" >/tmp/docksync-test.log
}

run_sync
cmp "$TMP_DIR/local/local.txt" "$TMP_DIR/remote/local.txt"
cmp "$TMP_DIR/local/remote.txt" "$TMP_DIR/remote/remote.txt"

printf 'same base\n' > "$TMP_DIR/local/shared.txt"
run_sync
printf 'local edit\n' > "$TMP_DIR/local/shared.txt"
printf 'remote edit\n' > "$TMP_DIR/remote/shared.txt"
run_sync

find "$TMP_DIR/local" "$TMP_DIR/remote" -name 'shared.conflict-*' | grep -q .

node --input-type=module - "$ROOT" "$TMP_DIR" <<'NODE'
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const tmpDir = process.argv[3];
const { normalizeRelativePath, resolveInsideRoot } = await import(pathToFileURL(path.join(root, 'src/local-files.js')).href);
const { SyncEngine } = await import(pathToFileURL(path.join(root, 'src/sync-engine.js')).href);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

for (const unsafePath of ['../escape.txt', '/escape.txt', 'nested/../../escape.txt', 'nested\\..\\..\\escape.txt']) {
  try {
    normalizeRelativePath(unsafePath);
    throw new Error(`accepted unsafe path ${unsafePath}`);
  } catch (error) {
    assert(error.message.includes('Unsafe relative path'), `unexpected error for ${unsafePath}: ${error.message}`);
  }
}

const guardedRoot = path.join(tmpDir, 'guard-local');
const guardedState = path.join(tmpDir, 'guard-state');
await fs.mkdir(guardedRoot, { recursive: true });
await fs.mkdir(guardedState, { recursive: true });
const safePath = resolveInsideRoot(guardedRoot, 'nested/file.txt');
assert(safePath === path.join(guardedRoot, 'nested', 'file.txt'), 'safe relative path resolves inside root');

const logger = { info() {}, error() {} };
const remote = {
  async listFiles() {
    return {
      '../escape.txt': {
        path: '../escape.txt',
        size: 7,
        mtimeMs: Date.now(),
        hash: 'malicious',
      },
    };
  },
  async readFile(_relativePath, destination) {
    await fs.writeFile(destination, 'escape\n');
  },
  async writeFile() {},
  async deleteFile() {},
};
const engine = new SyncEngine({
  localPath: guardedRoot,
  stateDir: guardedState,
  stateFile: path.join(guardedState, 'sync-state.json'),
  conflictStrategy: 'newer-wins',
  bandwidthLimitBps: 0,
}, logger, remote);

let rejected = false;
try {
  await engine.syncOnce('path-guard');
} catch (error) {
  rejected = error.message.includes('Unsafe relative path');
}
assert(rejected, 'sync rejects remote paths that escape the local root');

try {
  await fs.access(path.join(tmpDir, 'escape.txt'));
  throw new Error('escape file was written outside the local root');
} catch (error) {
  assert(error.code === 'ENOENT', error.message);
}
NODE
echo "sandbox sync test passed"
