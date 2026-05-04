import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const APP_DIR = path.resolve(PUBLIC_DIR, '..');
const STATIC_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};
const STATIC_FILES = new Map([
  ['/app.js', path.join(PUBLIC_DIR, 'app.js')],
  ['/styles.css', path.join(PUBLIC_DIR, 'styles.css')],
  ['/variables.css', path.join(APP_DIR, 'variables.css')],
  ['/theme.css', path.join(APP_DIR, 'theme.css')],
  ['/tokens.json', path.join(APP_DIR, 'tokens.json')],
]);

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function summarizeSyncResult(result) {
  return {
    ok: result.ok,
    reason: result.reason,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    actionCount: result.actions?.length || 0,
    actions: result.actions?.map((action) => ({ type: action.type, path: action.path })) || [],
  };
}

function recordSyncResult(status, result) {
  const summary = summarizeSyncResult(result);
  status.lastSync = summary;
  status.history = [summary, ...(status.history || [])].slice(0, 20);
}

async function serveStatic(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return false;
  }

  const requestUrl = new URL(request.url, 'http://docksync.local');
  let pathname = requestUrl.pathname;
  if (pathname === '/') {
    pathname = '/index.html';
  }
  const filePath = pathname === '/index.html'
    ? path.join(PUBLIC_DIR, 'index.html')
    : STATIC_FILES.get(pathname);
  if (!filePath) {
    return false;
  }

  try {
    const body = await fs.promises.readFile(filePath);
    response.writeHead(200, {
      'content-type': STATIC_TYPES[path.extname(filePath)] || 'application/octet-stream',
      'cache-control': pathname === '/index.html' ? 'no-store' : 'public, max-age=300',
    });
    if (request.method === 'HEAD') {
      response.end();
    } else {
      response.end(body);
    }
    return true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    return false;
  }
}

export function startServer(config, logger, engine, status) {
  const server = http.createServer(async (request, response) => {
    try {
      if (await serveStatic(request, response)) {
        return;
      }
    } catch (error) {
      logger.error('static_file_failed', { error: error.message });
      sendJson(response, 500, { ok: false, error: 'failed to serve frontend asset' });
      return;
    }

    if (request.method === 'GET' && request.url === '/healthz') {
      sendJson(response, status.shuttingDown ? 503 : 200, {
        ok: !status.shuttingDown,
        running: engine.running,
        lastSync: status.lastSync,
      });
      return;
    }

    if (request.method === 'GET' && request.url === '/status') {
      sendJson(response, 200, {
        ok: !status.shuttingDown,
        backend: config.backend,
        localPath: config.localPath,
        remotePath: config.remotePath,
        syncIntervalSeconds: config.syncIntervalMs / 1000,
        running: engine.running,
        lastSync: status.lastSync,
        history: status.history || [],
        config: {
          conflictStrategy: config.conflictStrategy,
          bandwidthLimitBps: config.bandwidthLimitBps,
          manualSyncEnabled: config.api.manualSyncEnabled,
          notificationWebhookConfigured: Boolean(config.notificationWebhookUrl),
          rcloneRemote: config.rclone.remote,
          rcloneSerialTransfers: config.rclone.disableCheckers,
        },
      });
      return;
    }

    if (request.method === 'POST' && request.url === '/sync' && config.api.manualSyncEnabled) {
      if (engine.running) {
        sendJson(response, 409, { ok: false, error: 'sync already running' });
        return;
      }
      engine.syncOnce('manual').then((result) => {
        recordSyncResult(status, result);
      }).catch((error) => {
        status.lastSync = { ok: false, error: error.message, finishedAt: new Date() };
        status.history = [status.lastSync, ...(status.history || [])].slice(0, 20);
        logger.error('manual_sync_failed', { error: error.message });
      });
      sendJson(response, 202, { ok: true, accepted: true });
      return;
    }

    sendJson(response, 404, { ok: false, error: 'not found' });
  });

  server.listen(config.api.port, config.api.host, () => {
    logger.info('http_server_ready', {
      host: config.api.host,
      port: config.api.port,
      manualSyncEnabled: config.api.manualSyncEnabled,
    });
  });
  return server;
}
