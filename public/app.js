const elements = {
  actionCount: document.querySelector('#actionCountValue'),
  activityRows: document.querySelector('#activityRows'),
  activitySummary: document.querySelector('#activitySummary'),
  backend: document.querySelector('#backendValue'),
  bandwidth: document.querySelector('#bandwidthValue'),
  conflict: document.querySelector('#conflictValue'),
  duration: document.querySelector('#durationValue'),
  health: document.querySelector('#healthValue'),
  interval: document.querySelector('#intervalValue'),
  lastRun: document.querySelector('#lastRunValue'),
  localPath: document.querySelector('#localPathValue'),
  manualApi: document.querySelector('#manualApiValue'),
  nextSync: document.querySelector('#nextSyncValue'),
  refreshButton: document.querySelector('#refreshButton'),
  rcloneRemote: document.querySelector('#rcloneRemoteValue'),
  remotePath: document.querySelector('#remotePathValue'),
  serial: document.querySelector('#serialValue'),
  syncButton: document.querySelector('#syncButton'),
  toast: document.querySelector('#toast'),
  topStatus: document.querySelector('#topStatus'),
  webhook: document.querySelector('#webhookValue'),
};

const state = {
  activity: loadActivity(),
  filter: 'all',
  health: null,
  status: null,
};

function loadActivity() {
  try {
    return JSON.parse(localStorage.getItem('docksync.activity') || '[]');
  } catch {
    return [];
  }
}

function saveActivity() {
  localStorage.setItem('docksync.activity', JSON.stringify(state.activity.slice(0, 80)));
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `${response.status} ${response.statusText}`);
  }
  return body;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('is-visible');
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    elements.toast.classList.remove('is-visible');
  }, 2600);
}

function formatDate(value) {
  if (!value) return 'Never';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatDuration(startedAt, finishedAt) {
  if (!startedAt || !finishedAt) return 'Waiting';
  const ms = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return 'Unknown';
  return `${Math.round(ms)} ms`;
}

function formatSeconds(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return `${hours}h`;
}

function formatBytes(bytesPerSecond) {
  if (!bytesPerSecond) return 'Unlimited';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let value = bytesPerSecond;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

function nextSyncLabel(status) {
  const finishedAt = status?.lastSync?.finishedAt;
  const interval = status?.syncIntervalSeconds;
  if (status?.running) return 'Running now';
  if (!finishedAt || !interval) return 'After first run';
  const nextAt = new Date(new Date(finishedAt).getTime() + interval * 1000);
  if (nextAt.getTime() <= Date.now()) return 'Due now';
  return formatDate(nextAt);
}

function classifyAction(type) {
  if (type.includes('conflict')) return 'conflict';
  if (type.includes('delete')) return 'delete';
  if (type.includes('download')) return 'download';
  if (type.includes('upload')) return 'upload';
  return 'noop';
}

function labelAction(type) {
  return type
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function mergeActivity(lastSync) {
  if (!lastSync?.finishedAt) return;
  const actions = lastSync.actions?.length
    ? lastSync.actions
    : [{ type: lastSync.ok ? 'noop' : 'error', path: lastSync.error || 'No file changes' }];
  const nextEntries = actions.map((action) => ({
    id: `${lastSync.finishedAt}:${action.type}:${action.path}`,
    ok: lastSync.ok,
    path: action.path,
    reason: lastSync.reason || 'scheduled',
    time: lastSync.finishedAt,
    type: action.type,
  }));
  const known = new Set(state.activity.map((entry) => entry.id));
  const fresh = nextEntries.filter((entry) => !known.has(entry.id));
  if (!fresh.length) return;
  state.activity = [...fresh, ...state.activity]
    .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
    .slice(0, 80);
  saveActivity();
}

function mergeSyncHistory(status) {
  const runs = status?.history?.length ? [...status.history].reverse() : [status?.lastSync];
  for (const run of runs) {
    mergeActivity(run);
  }
}

function renderStatus() {
  const status = state.status || {};
  const config = status.config || {};
  const healthy = state.health?.ok && !status.shuttingDown;
  const running = Boolean(status.running);
  const manualEnabled = config.manualSyncEnabled !== false;

  elements.topStatus.textContent = running ? 'Sync running' : healthy ? 'Healthy' : 'Needs attention';
  elements.topStatus.classList.toggle('is-ok', healthy);
  elements.topStatus.classList.toggle('is-bad', !healthy);
  elements.health.textContent = running ? 'Running' : healthy ? 'Healthy' : 'Unavailable';
  elements.backend.textContent = status.backend || 'rclone';
  elements.localPath.textContent = status.localPath || '/data';
  elements.remotePath.textContent = status.remotePath || '/DockSync';
  elements.nextSync.textContent = nextSyncLabel(status);

  elements.rcloneRemote.textContent = config.rcloneRemote || 'proton:';
  elements.interval.textContent = formatSeconds(status.syncIntervalSeconds || 300);
  elements.conflict.textContent = config.conflictStrategy || 'newer-wins';
  elements.bandwidth.textContent = formatBytes(config.bandwidthLimitBps || 0);
  elements.manualApi.textContent = manualEnabled ? 'Enabled' : 'Disabled';
  elements.webhook.textContent = config.notificationWebhookConfigured ? 'Configured' : 'Not configured';
  elements.serial.textContent = config.rcloneSerialTransfers ? 'On' : 'Off';

  const lastSync = status.lastSync;
  elements.lastRun.textContent = lastSync?.finishedAt ? `${lastSync.reason || 'sync'} at ${formatDate(lastSync.finishedAt)}` : 'No completed run';
  elements.actionCount.textContent = String(lastSync?.actionCount || 0);
  elements.duration.textContent = formatDuration(lastSync?.startedAt, lastSync?.finishedAt);
  elements.activitySummary.textContent = lastSync?.finishedAt
    ? `${lastSync.actionCount || 0} action${lastSync.actionCount === 1 ? '' : 's'} completed in the last ${lastSync.reason || 'sync'} run.`
    : 'No completed run yet.';

  elements.syncButton.disabled = running || !manualEnabled;
  elements.syncButton.querySelector('span').textContent = running ? 'Syncing' : 'Sync now';
}

function renderActivity() {
  const filtered = state.filter === 'all'
    ? state.activity
    : state.activity.filter((entry) => classifyAction(entry.type) === state.filter);

  if (!filtered.length) {
    elements.activityRows.innerHTML = '<div class="empty-state">No activity for this filter yet.</div>';
    return;
  }

  elements.activityRows.innerHTML = filtered.slice(0, 40).map((entry) => {
    const actionClass = classifyAction(entry.type);
    return `
      <div class="table-row" role="row">
        <span class="action-badge ${actionClass}" role="cell">${labelAction(entry.type)}</span>
        <span class="file-path" role="cell" title="${escapeHtml(entry.path)}">${escapeHtml(entry.path)}</span>
        <span role="cell">${escapeHtml(entry.reason)}</span>
        <span role="cell">${formatDate(entry.time)}</span>
      </div>
    `;
  }).join('');
}

function render() {
  renderStatus();
  renderActivity();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function refreshStatus({ silent = false } = {}) {
  elements.refreshButton.disabled = true;
  try {
    const [status, health] = await Promise.all([
      requestJson('/status'),
      requestJson('/healthz').catch(() => ({ ok: false })),
    ]);
    state.status = status;
    state.health = health;
    mergeSyncHistory(status);
    render();
    if (!silent) showToast('Status refreshed');
  } catch (error) {
    state.health = { ok: false };
    render();
    showToast(error.message);
  } finally {
    elements.refreshButton.disabled = false;
  }
}

async function triggerSync() {
  elements.syncButton.disabled = true;
  try {
    await requestJson('/sync', { method: 'POST' });
    showToast('Sync accepted');
    await refreshStatus({ silent: true });
  } catch (error) {
    showToast(error.message);
    await refreshStatus({ silent: true });
  }
}

document.querySelectorAll('[data-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((item) => {
      item.classList.toggle('is-selected', item === button);
    });
    renderActivity();
  });
});

elements.refreshButton.addEventListener('click', () => refreshStatus());
elements.syncButton.addEventListener('click', triggerSync);

refreshStatus({ silent: true });
window.setInterval(() => refreshStatus({ silent: true }), 15000);
