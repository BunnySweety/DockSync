import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { normalizeRelativePath } from '../local-files.js';

function rcloneHash(item) {
  const hashes = item.Hashes || item.hashes || {};
  return hashes.SHA1 || hashes['SHA-1'] || hashes.sha1 || hashes.Sha1;
}

function normalizePrefix(prefix) {
  if (!prefix) {
    throw new Error('RCLONE_REMOTE is required for SYNC_BACKEND=rclone');
  }
  const trimmed = prefix.trim();
  if (!trimmed) {
    throw new Error('RCLONE_REMOTE is required for SYNC_BACKEND=rclone');
  }
  if (!trimmed.includes(':') && !trimmed.includes('/')) {
    return `${trimmed}:`;
  }
  return trimmed;
}

export class RcloneRemoteBackend {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.binary = config.rclone.binary;
    this.prefix = normalizePrefix(config.rclone.remote);
  }

  async init() {
    await fs.promises.mkdir(this.config.rclone.cacheDir, { recursive: true });
    const version = await this.run(['version']);
    await this.run(['mkdir', this.remoteTarget()]);
    this.logger.info('rclone_remote_ready', {
      remote: this.prefix,
      remotePath: this.config.remotePath,
      version: version.split(/\r?\n/)[0],
    });
  }

  async listFiles() {
    const output = await this.run([
      'lsjson',
      '--recursive',
      '--files-only',
      '--hash',
      this.remoteTarget(),
    ]);
    const items = output.trim() ? JSON.parse(output) : [];
    const files = {};
    for (const item of items) {
      const relativePath = normalizeRelativePath(item.Path);
      files[relativePath] = {
        path: relativePath,
        size: item.Size || 0,
        mtimeMs: item.ModTime ? Date.parse(item.ModTime) : 0,
        hash: rcloneHash(item),
      };
    }
    return files;
  }

  async readFile(relativePath, destination) {
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await this.run(['copyto', this.remoteTarget(relativePath), destination]);
  }

  async writeFile(relativePath, source) {
    await this.run(['copyto', source, this.remoteTarget(relativePath)]);
  }

  async deleteFile(relativePath) {
    try {
      await this.run(['deletefile', this.remoteTarget(relativePath)]);
    } catch (error) {
      if (!/not found|object not found|directory not found/i.test(error.message)) {
        throw error;
      }
    }
  }

  remoteTarget(relativePath = '') {
    const basePath = this.config.remotePath.replace(/^\/+/, '').replace(/\/+$/, '');
    const cleanRelativePath = relativePath ? normalizeRelativePath(relativePath) : '';
    const joined = [basePath, cleanRelativePath].filter(Boolean).join('/');
    if (!joined) {
      return this.prefix;
    }
    const separator = this.prefix.endsWith(':') || this.prefix.endsWith('/') ? '' : '/';
    return `${this.prefix}${separator}${joined}`;
  }

  run(args) {
    const finalArgs = [...this.globalArgs(), ...args];
    const env = {
      ...process.env,
      HOME: this.config.stateDir,
      XDG_CACHE_HOME: this.config.rclone.cacheDir,
      PATH: process.env.PATH,
      RCLONE_CONFIG: this.config.rclone.configPath,
      ...(this.config.rclone.configPass ? { RCLONE_CONFIG_PASS: this.config.rclone.configPass } : {}),
    };

    return new Promise((resolve, reject) => {
      const child = spawn(this.binary, finalArgs, { env });
      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr?.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
          return;
        }
        reject(new Error(stderr.trim() || `rclone exited with code ${code}: ${finalArgs.join(' ')}`));
      });
    });
  }

  globalArgs() {
    const args = ['--config', this.config.rclone.configPath];
    if (this.config.bandwidthLimitBps > 0) {
      args.push('--bwlimit', `${this.config.bandwidthLimitBps}B`);
    }
    if (this.config.rclone.disableCheckers) {
      args.push('--checkers', '1', '--transfers', '1');
    }
    return args;
  }
}
