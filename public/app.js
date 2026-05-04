const elements = {
  actionCount: document.querySelector('#actionCountValue'),
  activityRows: document.querySelector('#activityRows'),
  activitySummary: document.querySelector('#activitySummary'),
  assistantCommand: document.querySelector('#assistantCommand'),
  assistantCopyButton: document.querySelector('#assistantCopyButton'),
  assistantDetail: document.querySelector('#assistantDetail'),
  assistantRefreshButton: document.querySelector('#assistantRefreshButton'),
  assistantRcloneForm: document.querySelector('#assistantRcloneForm'),
  assistantState: document.querySelector('#assistantState'),
  assistantStep: document.querySelector('#assistantStep'),
  assistantSyncButton: document.querySelector('#assistantSyncButton'),
  assistantTitle: document.querySelector('#assistantTitle'),
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
  onboardingChecks: document.querySelector('#onboardingChecks'),
  onboardingCommands: document.querySelector('#onboardingCommands'),
  onboardingProgress: document.querySelector('#onboardingProgress'),
  onboardingSummary: document.querySelector('#onboardingSummary'),
  refreshButton: document.querySelector('#refreshButton'),
  rcloneConfigFile: document.querySelector('#rcloneConfigFile'),
  rcloneConfigInput: document.querySelector('#rcloneConfigInput'),
  rcloneRemote: document.querySelector('#rcloneRemoteValue'),
  remotePath: document.querySelector('#remotePathValue'),
  serial: document.querySelector('#serialValue'),
  syncButton: document.querySelector('#syncButton'),
  toast: document.querySelector('#toast'),
  topStatus: document.querySelector('#topStatus'),
  webhook: document.querySelector('#webhookValue'),
};

const ONBOARDING_STEPS = [
  {
    id: 'workspace',
    title: 'Prepare the host workspace',
    detail: 'Create the local mounts and placeholders used by the container.',
    checkIds: ['runtime-mounts'],
    commandId: 'host-preflight',
  },
  {
    id: 'proton',
    title: 'Connect Proton Drive',
    detail: 'Authenticate with Rclone on the host, then mount the generated config.',
    checkIds: ['rclone-config'],
    action: 'rclone-config',
    commandId: 'proton-rclone',
  },
  {
    id: 'verify',
    title: 'Verify backend initialization',
    detail: 'Once the Rclone config is mounted, start a sync from the console.',
    checkIds: ['backend-init', 'manual-sync'],
    action: 'sync',
  },
  {
    id: 'secrets',
    title: 'Review optional secrets',
    detail: 'Only fill these files when using an encrypted Rclone config or webhook notifications.',
    checkIds: ['encrypted-config', 'webhook-secret'],
    commandId: 'optional-secrets',
    optional: true,
  },
];

const state = {
  activity: loadActivity(),
  assistantStepId: null,
  filter: 'all',
  health: null,
  onboarding: null,
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

function focusOnboardingIfNeeded(onboarding) {
  if (onboarding?.ok || sessionStorage.getItem('docksync.onboarding.focused') === 'true') {
    return;
  }
  sessionStorage.setItem('docksync.onboarding.focused', 'true');
  if (!window.location.hash || window.location.hash === '#status') {
    window.location.hash = 'onboarding';
  }
}

async function requestJson(url, options) {
  const requestOptions = options || {};
  const headers = {
    accept: 'application/json',
    ...(requestOptions.headers || {}),
  };
  const response = await fetch(url, {
    ...requestOptions,
    headers,
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

function labelCheckStatus(status) {
  if (status === 'pending') return 'Pending';
  if (status === 'ready') return 'Ready';
  if (status === 'optional') return 'Optional';
  return 'Action needed';
}

function checkById(onboarding, id) {
  return onboarding?.checks?.find((check) => check.id === id);
}

function commandById(onboarding, id) {
  return onboarding?.commands?.find((command) => command.id === id);
}

function stepStatus(step, onboarding) {
  const statuses = step.checkIds.map((id) => checkById(onboarding, id)?.status || 'pending');
  if (statuses.some((status) => status === 'action')) return 'action';
  if (statuses.every((status) => status === 'ready')) return 'ready';
  if (step.optional) return 'optional';
  return 'pending';
}

function nextAssistantStep(onboarding) {
  if (!onboarding) return ONBOARDING_STEPS[0];
  const requiredStep = ONBOARDING_STEPS
    .filter((step) => !step.optional)
    .find((step) => stepStatus(step, onboarding) !== 'ready');
  if (requiredStep) return requiredStep;
  return ONBOARDING_STEPS.find((step) => step.optional && stepStatus(step, onboarding) !== 'ready')
    || ONBOARDING_STEPS[ONBOARDING_STEPS.length - 1];
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
  const running = Boolean(status.running);
  const setupNeeded = Boolean(status.backendError) || Boolean(state.onboarding && !state.onboarding.ok);
  const healthy = state.health?.ok && !status.shuttingDown && !setupNeeded;
  const manualEnabled = config.manualSyncEnabled !== false;

  elements.topStatus.textContent = running ? 'Sync running' : setupNeeded ? 'Setup needed' : healthy ? 'Healthy' : 'Needs attention';
  elements.topStatus.classList.toggle('is-ok', healthy);
  elements.topStatus.classList.toggle('is-bad', !healthy);
  elements.health.textContent = running ? 'Running' : setupNeeded ? 'Setup needed' : healthy ? 'Healthy' : 'Unavailable';
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

function renderOnboarding() {
  const onboarding = state.onboarding;
  if (!onboarding) {
    elements.onboardingSummary.textContent = 'Checking setup inputs.';
    elements.onboardingProgress.textContent = 'Checking';
    elements.onboardingProgress.className = 'setup-progress';
    elements.onboardingChecks.innerHTML = '<div class="empty-state">Loading onboarding checks.</div>';
    elements.onboardingCommands.innerHTML = '';
    return;
  }

  renderAssistant(onboarding);

  const checks = onboarding.checks || [];
  const requiredChecks = checks.filter((check) => check.status !== 'optional');
  const readyRequired = requiredChecks.filter((check) => check.status === 'ready').length;
  elements.onboardingSummary.textContent = onboarding.ok
    ? 'Required setup inputs are ready for this running service.'
    : 'Complete the action items, then refresh this page.';
  elements.onboardingProgress.textContent = `${readyRequired}/${requiredChecks.length} ready`;
  elements.onboardingProgress.className = `setup-progress ${onboarding.ok ? 'is-ok' : 'is-action'}`;

  elements.onboardingChecks.innerHTML = checks.map((check) => `
    <div class="check-row ${escapeHtml(check.status)}">
      <div>
        <strong>${escapeHtml(check.label)}</strong>
        <p>${escapeHtml(check.detail)}</p>
      </div>
      <span class="check-status">${labelCheckStatus(check.status)}</span>
    </div>
  `).join('');

  elements.onboardingCommands.innerHTML = (onboarding.commands || []).map((item) => `
    <section class="command-block" aria-label="${escapeHtml(item.label)}">
      <div class="command-header">
        <span>${escapeHtml(item.label)}</span>
        <button class="command-copy" type="button" data-command-id="${escapeHtml(item.id)}" aria-label="Copy ${escapeHtml(item.label)} command">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="10" height="10" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          <span>Copy</span>
        </button>
      </div>
      <pre><code>${escapeHtml(item.command)}</code></pre>
    </section>
  `).join('');
}

function renderAssistant(onboarding) {
  const step = ONBOARDING_STEPS.find((item) => item.id === state.assistantStepId) || nextAssistantStep(onboarding);
  if (onboarding && stepStatus(step, onboarding) === 'ready') {
    const nextStep = nextAssistantStep(onboarding);
    if (nextStep.id !== step.id) {
      state.assistantStepId = nextStep.id;
      renderAssistant(onboarding);
      return;
    }
  }
  state.assistantStepId = step.id;
  const status = stepStatus(step, onboarding);
  const stepIndex = ONBOARDING_STEPS.findIndex((item) => item.id === step.id) + 1;
  const command = step.commandId ? commandById(onboarding, step.commandId)?.command : null;
  const canWriteRcloneConfig = Boolean(onboarding.setup?.rcloneConfigWritable);
  const showRcloneForm = step.action === 'rclone-config' && status !== 'ready' && canWriteRcloneConfig;
  const commandNeeded = Boolean(command && status !== 'ready' && !showRcloneForm);
  const syncAllowed = step.action === 'sync' && status !== 'ready' && state.status?.config?.manualSyncEnabled !== false;

  elements.assistantStep.textContent = `Step ${stepIndex} of ${ONBOARDING_STEPS.length}`;
  elements.assistantState.textContent = labelCheckStatus(status);
  elements.assistantState.className = status;
  elements.assistantTitle.textContent = onboarding.ok && !step.optional ? 'Setup complete' : step.title;
  elements.assistantDetail.textContent = onboarding.ok && !step.optional
    ? 'DockSync is ready to sync with the configured backend.'
    : step.detail;
  elements.assistantCommand.innerHTML = commandNeeded
    ? `<pre><code>${escapeHtml(command)}</code></pre>`
    : '';
  elements.assistantCommand.hidden = !commandNeeded;
  elements.assistantRcloneForm.hidden = !showRcloneForm;
  elements.assistantCopyButton.hidden = !commandNeeded;
  elements.assistantCopyButton.dataset.commandId = commandNeeded ? step.commandId : '';
  elements.assistantSyncButton.hidden = !syncAllowed;
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
  renderOnboarding();
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
    const [status, health, onboarding] = await Promise.all([
      requestJson('/status'),
      requestJson('/healthz').catch(() => ({ ok: false })),
      requestJson('/onboarding').catch(() => null),
    ]);
    state.status = status;
    state.health = health;
    state.onboarding = onboarding;
    focusOnboardingIfNeeded(onboarding);
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

async function saveRcloneConfig(event) {
  event.preventDefault();
  const content = elements.rcloneConfigInput.value.trim();
  if (!content) {
    showToast('Rclone config is required');
    return;
  }
  const submitButton = elements.assistantRcloneForm.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const result = await requestJson('/setup/rclone-config', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-docksync-setup': '1',
      },
      body: JSON.stringify({ content }),
    });
    elements.rcloneConfigInput.value = '';
    state.onboarding = result.onboarding || state.onboarding;
    state.assistantStepId = null;
    render();
    showToast('Rclone config saved');
    await refreshStatus({ silent: true });
  } catch (error) {
    showToast(error.message);
  } finally {
    submitButton.disabled = false;
  }
}

async function loadRcloneConfigFile() {
  const [file] = elements.rcloneConfigFile.files || [];
  if (!file) return;
  if (file.size > 65536) {
    showToast('rclone.conf is too large');
    elements.rcloneConfigFile.value = '';
    return;
  }
  elements.rcloneConfigInput.value = await file.text();
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
elements.assistantRefreshButton.addEventListener('click', () => refreshStatus());
elements.assistantRcloneForm.addEventListener('submit', saveRcloneConfig);
elements.rcloneConfigFile.addEventListener('change', loadRcloneConfigFile);
elements.assistantSyncButton.addEventListener('click', triggerSync);
elements.assistantCopyButton.addEventListener('click', async () => {
  const command = commandById(state.onboarding, elements.assistantCopyButton.dataset.commandId)?.command;
  if (!command) return;
  try {
    await navigator.clipboard.writeText(command);
    showToast('Command copied');
  } catch {
    showToast('Clipboard is unavailable');
  }
});
elements.onboardingCommands.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-command-id]');
  if (!button) return;
  const command = state.onboarding?.commands?.find((item) => item.id === button.dataset.commandId)?.command;
  if (!command) return;
  try {
    await navigator.clipboard.writeText(command);
    showToast('Command copied');
  } catch {
    showToast('Clipboard is unavailable');
  }
});

refreshStatus({ silent: true });
window.setInterval(() => refreshStatus({ silent: true }), 15000);
