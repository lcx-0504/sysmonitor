import { state } from './state.mjs';
import { createTranslator } from './i18n.mjs';
import { PROTOCOL_VERSION } from './protocol.mjs';

const WARN_PERCENT = 70;
const DANGER_PERCENT = 90;

export function sendToExtension(command, fields = {}) {
  state.bridge.postMessage({ version: PROTOCOL_VERSION, cmd: command, ...fields });
}

export function storedViewState() {
  return state.bridge.getState() || {};
}

export function storeViewState(changes) {
  state.bridge.setState({ ...storedViewState(), ...changes });
}

export function tr(key, parameters, language) {
  return createTranslator(language || state.locale.language)(key, parameters);
}

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

export function setClass(node, className) {
  if (node.className !== className) node.className = className;
}

export function colorClass(percent) {
  if (percent >= DANGER_PERCENT) return 'danger';
  return percent >= WARN_PERCENT ? 'warn' : '';
}

export function tagColorClass(percent) {
  return 'tag-' + (colorClass(percent) || 'accent');
}

export function percentText(percent) {
  return Number.isFinite(percent) ? percent + '%' : '--';
}

export function barWidth(percent) {
  return (Number.isFinite(percent) ? percent : 0) + '%';
}

export function setBar(id, percent) {
  const node = document.getElementById(id);
  if (!node) return;
  node.style.width = barWidth(percent);
  node.className = 'fill ' + colorClass(percent);
}

export function copyText(text) {
  return Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(() => true, () => false);
}
