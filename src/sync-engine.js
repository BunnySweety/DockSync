import fs from 'node:fs';
import path from 'node:path';
import {
  conflictPath,
  copyFileWithLimit,
  ensureParentDirectory,
  fileSignature,
  listLocalFiles,
  readJsonFile,
  writeJsonAtomic,
} from './local-files.js';

function emptyState() {
  return { version: 1, updatedAt: null, entries: {} };
}

function sideChanged(previousSignature, currentSignature) {
  return previousSignature !== currentSignature;
}

export class SyncEngine {
  constructor(config, logger, remoteBackend) {
    this.config = config;
    this.logger = logger;
    this.remote = remoteBackend;
    this.running = false;
  }

  async syncOnce(reason = 'scheduled') {
    if (this.running) {
      throw new Error('sync already running');
    }
    this.running = true;
    const startedAt = new Date();
    const actions = [];

    try {
      const previous = await readJsonFile(this.config.stateFile, emptyState());
      const local = await listLocalFiles(this.config.localPath);
      const remote = await this.remote.listFiles();
      const allPaths = [...new Set([...Object.keys(local), ...Object.keys(remote), ...Object.keys(previous.entries)])].sort();

      for (const relativePath of allPaths) {
        const action = await this.decide(relativePath, local[relativePath], remote[relativePath], previous.entries[relativePath]);
        if (action.type !== 'noop') {
          await this.execute(action, local[relativePath], remote[relativePath]);
          actions.push(action);
        }
      }

      const nextLocal = await listLocalFiles(this.config.localPath);
      const nextRemote = await this.remote.listFiles();
      await this.saveState(nextLocal, nextRemote);
      const finishedAt = new Date();
      this.logger.info('sync_completed', {
        reason,
        actionCount: actions.length,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
      });
      return { ok: true, reason, startedAt, finishedAt, actions };
    } finally {
      this.running = false;
    }
  }

  async decide(relativePath, local, remote, previous = {}) {
    const localSignature = fileSignature(local);
    const remoteSignature = fileSignature(remote);
    const previousLocal = previous.localSignature || null;
    const previousRemote = previous.remoteSignature || null;

    if (!local && !remote) {
      return { type: 'noop', path: relativePath };
    }

    if (local && remote && localSignature === remoteSignature) {
      return { type: 'noop', path: relativePath };
    }

    if (local && !remote) {
      if (previousRemote && previousLocal === localSignature) {
        return { type: 'delete-local', path: relativePath };
      }
      return { type: 'upload', path: relativePath };
    }

    if (!local && remote) {
      if (previousLocal && previousRemote === remoteSignature) {
        return { type: 'delete-remote', path: relativePath };
      }
      return { type: 'download', path: relativePath };
    }

    const localChanged = sideChanged(previousLocal, localSignature);
    const remoteChanged = sideChanged(previousRemote, remoteSignature);
    if (localChanged && !remoteChanged) {
      return { type: 'upload', path: relativePath };
    }
    if (remoteChanged && !localChanged) {
      return { type: 'download', path: relativePath };
    }
    return this.conflictDecision(relativePath, local, remote);
  }

  conflictDecision(relativePath, local, remote) {
    if (this.config.conflictStrategy === 'local-wins') {
      return { type: 'conflict-local-wins', path: relativePath };
    }
    if (this.config.conflictStrategy === 'remote-wins') {
      return { type: 'conflict-remote-wins', path: relativePath };
    }
    return local.mtimeMs >= remote.mtimeMs
      ? { type: 'conflict-local-wins', path: relativePath }
      : { type: 'conflict-remote-wins', path: relativePath };
  }

  async execute(action, local, remote) {
    this.logger.info('sync_action', { action: action.type, path: action.path });
    if (action.type === 'upload') {
      await this.remote.writeFile(action.path, local.absolutePath, local);
    } else if (action.type === 'download') {
      await this.downloadToLocal(action.path, remote);
    } else if (action.type === 'delete-local') {
      await fs.promises.rm(path.join(this.config.localPath, action.path), { force: true });
    } else if (action.type === 'delete-remote') {
      await this.remote.deleteFile(action.path);
    } else if (action.type === 'conflict-local-wins') {
      await this.preserveRemoteConflict(action.path, remote);
      await this.remote.writeFile(action.path, local.absolutePath, local);
    } else if (action.type === 'conflict-remote-wins') {
      await this.preserveLocalConflict(action.path);
      await this.downloadToLocal(action.path, remote);
    }
  }

  async downloadToLocal(relativePath, remoteMetadata) {
    const destination = path.join(this.config.localPath, relativePath);
    await ensureParentDirectory(destination);
    const tempPath = `${destination}.docksync.tmp-${process.pid}`;
    await this.remote.readFile(relativePath, tempPath);
    await fs.promises.rename(tempPath, destination);
    if (remoteMetadata?.mtimeMs) {
      const mtime = new Date(remoteMetadata.mtimeMs);
      await fs.promises.utimes(destination, mtime, mtime);
    }
  }

  async preserveLocalConflict(relativePath) {
    const source = path.join(this.config.localPath, relativePath);
    const destination = path.join(this.config.localPath, conflictPath(relativePath, 'local'));
    await copyFileWithLimit(source, destination, this.config.bandwidthLimitBps);
  }

  async preserveRemoteConflict(relativePath, remoteMetadata) {
    const tempPath = path.join(this.config.stateDir, 'tmp', `${Buffer.from(relativePath).toString('hex')}-${process.pid}`);
    const remoteConflictPath = conflictPath(relativePath, 'remote');
    await this.remote.readFile(relativePath, tempPath);
    await this.remote.writeFile(remoteConflictPath, tempPath, remoteMetadata);
    await fs.promises.rm(tempPath, { force: true });
  }

  async saveState(localFiles, remoteFiles) {
    const entries = {};
    const allPaths = [...new Set([...Object.keys(localFiles), ...Object.keys(remoteFiles)])].sort();
    for (const relativePath of allPaths) {
      const local = localFiles[relativePath];
      const remote = remoteFiles[relativePath];
      entries[relativePath] = {
        localSignature: fileSignature(local),
        remoteSignature: fileSignature(remote),
        localSize: local?.size,
        remoteSize: remote?.size,
        localMtimeMs: local?.mtimeMs,
        remoteMtimeMs: remote?.mtimeMs,
      };
    }
    await writeJsonAtomic(this.config.stateFile, {
      version: 1,
      updatedAt: new Date().toISOString(),
      entries,
    });
  }
}
