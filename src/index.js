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

  const remoteBackend = await createRemoteBackend(config, logger);
  const engine = new SyncEngine(config, logger, remoteBackend);
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
