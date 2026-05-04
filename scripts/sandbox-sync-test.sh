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
echo "sandbox sync test passed"
