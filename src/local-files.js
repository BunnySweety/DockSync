import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function sha1File(filePath) {
  const hash = crypto.createHash('sha1');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
}

export function normalizeRelativePath(relativePath) {
  const value = String(relativePath ?? '');
  if (!value || value.includes('\0')) {
    throw new Error(`Unsafe relative path: ${value}`);
  }
  const withPosixSeparators = value.replace(/\\/g, '/');
  if (path.posix.isAbsolute(withPosixSeparators)) {
    throw new Error(`Unsafe relative path: ${value}`);
  }
  const normalized = path.posix.normalize(withPosixSeparators);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`Unsafe relative path: ${value}`);
  }
  return normalized;
}

export function resolveInsideRoot(root, relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const rootPath = path.resolve(root);
  const resolved = path.resolve(rootPath, normalized);
  const relativeToRoot = path.relative(rootPath, resolved);
  if (!relativeToRoot || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error(`Unsafe relative path: ${relativePath}`);
  }
  return resolved;
}

export async function listLocalFiles(root) {
  const files = {};

  async function walk(relativeDir) {
    const absoluteDir = relativeDir ? resolveInsideRoot(root, relativeDir) : path.resolve(root);
    const entries = await fs.promises.readdir(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.docksync.tmp-')) {
        continue;
      }
      const relativePath = normalizeRelativePath(path.posix.join(relativeDir.split(path.sep).join(path.posix.sep), entry.name));
      const absolutePath = resolveInsideRoot(root, relativePath);
      if (entry.isDirectory()) {
        await walk(relativePath);
      } else if (entry.isFile()) {
        const stat = await fs.promises.stat(absolutePath);
        files[relativePath] = {
          path: relativePath,
          absolutePath,
          size: stat.size,
          mtimeMs: Math.trunc(stat.mtimeMs),
          hash: await sha1File(absolutePath),
        };
      }
    }
  }

  await walk('');
  return files;
}

export function fileSignature(file) {
  if (!file) {
    return null;
  }
  return file.hash || `${file.size}:${Math.trunc(file.mtimeMs || 0)}`;
}

export async function ensureParentDirectory(filePath) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
}

export function conflictPath(relativePath, side, date = new Date()) {
  const parsed = path.posix.parse(normalizeRelativePath(relativePath));
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\..+$/, 'Z');
  return path.posix.join(parsed.dir, `${parsed.name}.conflict-${side}-${stamp}${parsed.ext}`);
}

export function throttleTransform(bytesPerSecond) {
  if (!bytesPerSecond || bytesPerSecond <= 0) {
    return new Transform({
      transform(chunk, _encoding, callback) {
        callback(null, chunk);
      },
    });
  }

  let nextAt = Date.now();
  return new Transform({
    transform(chunk, _encoding, callback) {
      const now = Date.now();
      const delay = Math.max(0, nextAt - now);
      nextAt = Math.max(nextAt, now) + Math.ceil((chunk.length / bytesPerSecond) * 1000);
      setTimeout(() => callback(null, chunk), delay);
    },
  });
}

export async function copyFileWithLimit(source, destination, bytesPerSecond = 0) {
  await ensureParentDirectory(destination);
  await pipeline(
    fs.createReadStream(source),
    throttleTransform(bytesPerSecond),
    fs.createWriteStream(destination, { mode: 0o600 }),
  );
}

export async function writeJsonAtomic(filePath, value) {
  await ensureParentDirectory(filePath);
  const tempPath = `${filePath}.tmp-${process.pid}`;
  await fs.promises.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.promises.rename(tempPath, filePath);
}

export async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

export function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const table = {
    '.css': 'text/css',
    '.csv': 'text/csv',
    '.gif': 'image/gif',
    '.htm': 'text/html',
    '.html': 'text/html',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.json': 'application/json',
    '.md': 'text/markdown',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain',
    '.webp': 'image/webp',
    '.xml': 'application/xml',
    '.zip': 'application/zip',
  };
  return table[ext] || 'application/octet-stream';
}
