import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_STATE_DIR = '/state';

function readSecret(env, name) {
  const fileValue = env[`${name}_FILE`];
  if (fileValue) {
    return fs.readFileSync(fileValue, 'utf8').trim();
  }
  return env[name];
}

function parseBool(value, defaultValue = false) {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseNumber(value, defaultValue, { min = 0 } = {}) {
  if (value === undefined || value === '') {
    return defaultValue;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) {
    throw new Error(`Invalid numeric value: ${value}`);
  }
  return parsed;
}

function normalizeRemotePath(value) {
  const normalized = path.posix.normalize(`/${value || ''}`);
  return normalized === '.' ? '/' : normalized;
}

function requireChoice(value, choices, name) {
  if (!choices.includes(value)) {
    throw new Error(`${name} must be one of: ${choices.join(', ')}`);
  }
  return value;
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true });
}

export function loadConfig(env = process.env) {
  const stateDir = env.STATE_DIR || DEFAULT_STATE_DIR;
  const localPath = env.SYNC_LOCAL_PATH || '/data';
  const backend = requireChoice(env.SYNC_BACKEND || 'rclone', ['rclone'], 'SYNC_BACKEND');
  const conflictStrategy = requireChoice(
    env.CONFLICT_STRATEGY || 'newer-wins',
    ['newer-wins', 'local-wins', 'remote-wins'],
    'CONFLICT_STRATEGY',
  );

  ensureDirectory(localPath);
  ensureDirectory(stateDir);
  ensureDirectory(path.join(stateDir, 'tmp'));

  return {
    backend,
    localPath,
    stateDir,
    stateFile: env.SYNC_STATE_FILE || path.join(stateDir, 'sync-state.json'),
    remotePath: normalizeRemotePath(env.SYNC_REMOTE_PATH || '/'),
    syncOnce: parseBool(env.SYNC_ONCE, false),
    syncIntervalMs: parseNumber(env.SYNC_INTERVAL_SECONDS, 300, { min: 1 }) * 1000,
    conflictStrategy,
    bandwidthLimitBps: parseNumber(env.BANDWIDTH_LIMIT_BYTES_PER_SECOND, 0, { min: 0 }),
    api: {
      host: env.API_HOST || '0.0.0.0',
      port: parseNumber(env.API_PORT, 8080, { min: 1 }),
      manualSyncEnabled: parseBool(env.ENABLE_REST_API, true),
    },
    setup: {
      enabled: parseBool(env.SETUP_API_ENABLED, true),
      allowOverwrite: parseBool(env.SETUP_ALLOW_OVERWRITE, false),
    },
    retry: {
      maxAttempts: parseNumber(env.RETRY_MAX_ATTEMPTS, 5, { min: 1 }),
      initialDelayMs: parseNumber(env.RETRY_INITIAL_DELAY_MS, 1000, { min: 1 }),
      maxDelayMs: parseNumber(env.RETRY_MAX_DELAY_MS, 60000, { min: 1 }),
    },
    notificationWebhookUrl: readSecret(env, 'ERROR_WEBHOOK_URL'),
    rclone: {
      binary: env.RCLONE_BINARY || '/usr/local/bin/rclone',
      remote: env.RCLONE_REMOTE || 'proton:',
      configPath: env.RCLONE_CONFIG || env.RCLONE_CONFIG_PATH || '/config/rclone/rclone.conf',
      configPass: backend === 'rclone' ? readSecret(env, 'RCLONE_CONFIG_PASS') : undefined,
      cacheDir: env.RCLONE_CACHE_DIR || path.join(stateDir, 'rclone-cache'),
      disableCheckers: parseBool(env.RCLONE_SERIAL_TRANSFERS, false),
    },
  };
}
