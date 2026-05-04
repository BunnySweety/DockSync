import { createRemoteBackend } from './backends/index.js';
import { loadConfig } from './config.js';
import { Logger, errorToFields } from './logger.js';
import { notifyError } from './notification.js';
import { withRetry, sleep } from './retry.js';
import { startServer } from './server.js';
import { SyncEngine } from './sync-engine.js';

const logger = new Logger();
const config = loadConfig();
const status = {
  startedAt: new Date().toISOString(),
  shuttingDown: false,
  backendReady: false,
  backendError: null,
  lastSync: null,
  history: [],
};
const shutdownController = new AbortController();

function serializeSyncResult(result) {
  return {
    ok: result.ok,
    reason: result.reason,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    actionCount: result.actions?.length || 0,
    actions: result.actions?.map((action) => ({ type: action.type, path: action.path })) || [],
  };
}

class RuntimeSyncEngine {
  constructor(config, logger, status) {
    this.config = config;
    this.logger = logger;
    this.status = status;
    this.engine = null;
    this.initPromise = null;
    this.running = false;
  }

  async ensureEngine() {
    if (this.engine) {
      return this.engine;
    }
    if (!this.initPromise) {
      this.status.backendReady = false;
      this.status.backendError = null;
      this.initPromise = createRemoteBackend(this.config, this.logger)
        .then((remoteBackend) => {
          this.engine = new SyncEngine(this.config, this.logger, remoteBackend);
          this.status.backendReady = true;
          this.status.backendError = null;
          return this.engine;
        })
        .catch((error) => {
          this.status.backendReady = false;
          this.status.backendError = error.message;
          throw error;
        })
        .finally(() => {
          this.initPromise = null;
        });
    }
    return this.initPromise;
  }

  async syncOnce(reason = 'scheduled') {
    if (this.running) {
      throw new Error('sync already running');
    }
    this.running = true;
    try {
      const engine = await this.ensureEngine();
      return await engine.syncOnce(reason);
    } finally {
      this.running = false;
    }
  }
}

async function runSyncWithRetry(engine, reason) {
  const result = await withRetry(
    () => engine.syncOnce(reason),
    config,
    logger,
    shutdownController.signal,
  );
  status.lastSync = serializeSyncResult(result);
  status.history = [status.lastSync, ...status.history].slice(0, 20);
}

async function main() {
  logger.info('docksync_starting', {
    backend: config.backend,
    localPath: config.localPath,
    remotePath: config.remotePath,
  });

  const engine = new RuntimeSyncEngine(config, logger, status);
  const server = startServer(config, logger, engine, status);

  const stop = async (signalName) => {
    if (status.shuttingDown) {
      return;
    }
    status.shuttingDown = true;
    logger.info('shutdown_requested', { signal: signalName });
    shutdownController.abort(new Error(`shutdown requested by ${signalName}`));
    server.close(() => logger.info('http_server_closed'));
  };

  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  if (config.syncOnce) {
    await runSyncWithRetry(engine, 'once');
    await stop('SYNC_ONCE');
    return;
  }

  while (!shutdownController.signal.aborted) {
    try {
      await runSyncWithRetry(engine, 'scheduled');
    } catch (error) {
      status.lastSync = { ok: false, error: error.message, finishedAt: new Date().toISOString() };
      logger.error('sync_failed', errorToFields(error));
      await notifyError(config, logger, error, { reason: 'scheduled' });
    }
    try {
      await sleep(config.syncIntervalMs, shutdownController.signal);
    } catch {
      break;
    }
  }
}

main().catch(async (error) => {
  status.lastSync = { ok: false, error: error.message, finishedAt: new Date().toISOString() };
  logger.error('fatal_error', errorToFields(error));
  await notifyError(config, logger, error, { reason: 'fatal' });
  process.exitCode = 1;
});
