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

async function inspectPath(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    let readable = true;
    let writable = true;
    try {
      await fs.promises.access(filePath, fs.constants.R_OK);
    } catch {
      readable = false;
    }
    try {
      await fs.promises.access(filePath, fs.constants.W_OK);
    } catch {
      writable = false;
    }
    return {
      exists: true,
      readable,
      writable,
      type: stat.isDirectory() ? 'directory' : 'file',
      size: stat.size,
    };
  } catch {
    return {
      exists: false,
      readable: false,
      writable: false,
      type: 'missing',
      size: 0,
    };
  }
}

async function summarizeOnboarding(config) {
  const [localPath, stateDir, rcloneConfig] = await Promise.all([
    inspectPath(config.localPath),
    inspectPath(config.stateDir),
    inspectPath(config.rclone.configPath),
  ]);
  const localRemote = config.rclone.remote.startsWith(':local:');
  const runtimeReady = localPath.exists && localPath.writable && stateDir.exists && stateDir.writable;
  const rcloneReady = localRemote || (rcloneConfig.exists && rcloneConfig.readable);

  const checks = [
    {
      id: 'runtime-mounts',
      label: 'Runtime mounts',
      status: runtimeReady ? 'ready' : 'action',
      detail: runtimeReady
        ? `${config.localPath} and ${config.stateDir} are writable.`
        : `Mount writable host directories at ${config.localPath} and ${config.stateDir}.`,
    },
    {
      id: 'rclone-config',
      label: 'Rclone config',
      status: rcloneReady ? 'ready' : 'action',
      detail: rcloneReady
        ? `Rclone can use ${localRemote ? config.rclone.remote : config.rclone.configPath}.`
        : `Create a Proton Drive remote and mount rclone.conf at ${config.rclone.configPath}.`,
    },
    {
      id: 'encrypted-config',
      label: 'Encrypted Rclone config',
      status: config.rclone.configPass ? 'ready' : 'optional',
      detail: config.rclone.configPass
        ? 'RCLONE_CONFIG_PASS is provided from an environment variable or secret file.'
        : 'Only required when rclone.conf is encrypted.',
    },
    {
      id: 'webhook-secret',
      label: 'Error webhook',
      status: config.notificationWebhookUrl ? 'ready' : 'optional',
      detail: config.notificationWebhookUrl
        ? 'Error webhook notifications are configured.'
        : 'Optional. Store the URL in secrets/docksync_error_webhook before using the Compose secrets override.',
    },
    {
      id: 'manual-sync',
      label: 'Manual sync API',
      status: config.api.manualSyncEnabled ? 'ready' : 'optional',
      detail: config.api.manualSyncEnabled
        ? 'POST /sync is enabled for the Sync now button.'
        : 'Set ENABLE_REST_API=true to enable frontend-triggered syncs.',
    },
  ];

  return {
    ok: checks.every((check) => check.status !== 'action'),
    generatedAt: new Date().toISOString(),
    paths: {
      localPath,
      stateDir,
      rcloneConfig,
    },
    checks,
    commands: [
      {
        id: 'host-preflight',
        label: 'Prepare host workspace',
        command: 'npm ci\nnpm run onboard',
      },
      {
        id: 'proton-rclone',
        label: 'Authenticate Proton Drive with Rclone',
        command: 'rclone config\nrclone lsd proton:\ncp ~/.config/rclone/rclone.conf rclone/rclone.conf\nchmod 600 rclone/rclone.conf',
      },
      {
        id: 'optional-secrets',
        label: 'Fill optional secret files',
        command: "printf '%s\\n' 'your-rclone-config-passphrase' > secrets/rclone_config_pass\nprintf '%s\\n' 'https://example.invalid/webhook' > secrets/docksync_error_webhook\nchmod 600 secrets/rclone_config_pass secrets/docksync_error_webhook",
      },
      {
        id: 'deploy-compose',
        label: 'Deploy with Compose',
        command: 'npm run release:check\ndocker compose -f docker-compose.yml -f docker-compose.secrets.yml up --build -d\ncurl -fsS http://127.0.0.1:8080/healthz',
      },
    ],
  };
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

    if (request.method === 'GET' && request.url === '/onboarding') {
      sendJson(response, 200, await summarizeOnboarding(config));
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
