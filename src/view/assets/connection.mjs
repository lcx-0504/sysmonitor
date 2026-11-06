import { state } from './state.mjs';
import { sendToExtension, tr } from './ui.mjs';
import { TO_EXTENSION } from './protocol.mjs';
import { LOCAL_DEVICE_ID, isSshDeviceId } from './device-id.mjs';
import { localizeError } from './i18n.mjs';
import { setChartAnimationAllowed } from './charts.mjs';

const SECOND_MILLISECONDS = 1000;
const SOURCE_LABEL_KEYS = Object.freeze({
  cpu: 'sourceCpu',
  memory: 'sourceMemory',
  network: 'sourceNetwork',
  diskIo: 'sourceDiskIo',
  diskTopology: 'sourceDiskTopology',
  accelerators: 'sourceAccelerators',
  processes: 'sourceProcesses',
  sshTraffic: 'sourceSshTraffic',
});

const freshConnection = () => ({ state: null, error: null, retryAfter: null, retryPending: false });

let connection = freshConnection();
let retryCountdownTimer = null;
let banner, bannerText, retryButton;

function hasSamplingFailure() {
  const status = state.data.status;
  return connection.state === 'connected' && !!status && !!(status.error || (status.failures || []).length > 0);
}

function retryButtonState(connectionState, pending, isPaused, retryAfter, now, language) {
  if (connectionState === 'connected' && pending) return { text: tr('collecting', {}, language), disabled: true, remaining: 0 };
  if (connectionState === 'connecting' || pending) return { text: tr('connecting', {}, language), disabled: true, remaining: 0 };
  const remaining = connectionState === 'disconnected' && !isPaused && typeof retryAfter === 'number'
    ? Math.max(0, Math.ceil((retryAfter - now) / SECOND_MILLISECONDS)) : 0;
  return { text: tr('retry', {}, language) + (remaining ? ' (' + remaining + ')' : ''), disabled: false, remaining };
}

function refreshConnectionRetryButton() {
  clearTimeout(retryCountdownTimer);
  retryCountdownTimer = null;
  const sshDevice = isSshDeviceId(state.ui.deviceId);
  const now = Date.now();
  const collecting = state.data.status?.collecting === true;
  const buttonState = retryButtonState(connection.state, connection.retryPending || collecting, state.ui.paused, connection.retryAfter, now, state.locale.language);
  const reconnectable = sshDevice && (connection.state === 'connecting' || connection.state === 'disconnected');
  retryButton.hidden = !reconnectable && !hasSamplingFailure() && !collecting;
  retryButton.disabled = buttonState.disabled;
  retryButton.textContent = buttonState.text;
  if (!buttonState.remaining) return;
  const untilNextSecond = connection.retryAfter - now - (buttonState.remaining - 1) * SECOND_MILLISECONDS;
  retryCountdownTimer = setTimeout(refreshConnectionRetryButton, Math.max(1, untilNextSecond));
}

function sourceLabel(source) {
  return Object.hasOwn(SOURCE_LABEL_KEYS, source) ? tr(SOURCE_LABEL_KEYS[source]) : source;
}

function bannerMessage() {
  if (connection.state === 'connecting') return tr('connectingToServer');
  if (connection.state === 'disconnected') return connection.error || tr('disconnectedRetrying');
  const status = state.data.status;
  if (!status) return '';
  return localizeError(status.error, state.locale.language)
    || (status.failures || []).map((failure) => sourceLabel(failure.key) + ': ' + localizeError(failure, state.locale.language)).join(' · ');
}

function updateBannerVisibility() {
  banner.classList.toggle('show', !!bannerText.textContent && state.ui.page !== 'servers');
}

function refreshConnectionBanner() {
  const text = bannerMessage();
  bannerText.textContent = text;
  bannerText.title = state.data.status?.failures?.map((failure) => sourceLabel(failure.key) + ': ' + failure.message).join('\n') || text;
  refreshConnectionRetryButton();
  updateBannerVisibility();
}

function showConnection(next) {
  connection.state = next?.state;
  connection.error = next?.error;
  connection.retryAfter = typeof next?.retryAfter === 'number' ? next.retryAfter : null;
  setChartAnimationAllowed(next.canPresent ?? next.ready !== false);
  refreshConnectionBanner();
}

function showMonitorStatus(status) {
  if (!status) return;
  state.data.status = status;
  setChartAnimationAllowed(status.canPresent ?? status.ready);
  refreshConnectionBanner();
}

function showRetryConnectionResult({ deviceId, error }) {
  if (deviceId !== (state.environment.localMode ? state.ui.deviceId : LOCAL_DEVICE_ID)) return;
  connection.retryPending = false;
  if (error && connection.state === 'disconnected') connection.error = error;
  refreshConnectionBanner();
}

function retry() {
  if (connection.retryPending) return;
  const reconnect = connection.state === 'disconnected' && isSshDeviceId(state.ui.deviceId);
  if (!reconnect && !hasSamplingFailure()) return;
  connection.retryPending = true;
  refreshConnectionRetryButton();
  if (reconnect) sendToExtension(TO_EXTENSION.retryConnection, { deviceId: state.ui.deviceId });
  else sendToExtension(TO_EXTENSION.retrySampling, { deviceId: state.ui.deviceId || LOCAL_DEVICE_ID });
}

export function resetConnection() {
  connection = freshConnection();
  state.data.status = null;
  refreshConnectionBanner();
}

export function initializeConnection() {
  state.data.status = state.initial.monitorStatus || null;
  banner = document.getElementById('connection-banner');
  bannerText = document.getElementById('connection-banner-text');
  retryButton = document.getElementById('connection-retry');
  retryButton.addEventListener('click', retry);
}

export { retryButtonState, refreshConnectionRetryButton, refreshConnectionBanner, updateBannerVisibility, showConnection, showMonitorStatus, showRetryConnectionResult };
