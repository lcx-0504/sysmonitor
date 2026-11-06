import { state } from './state.mjs';
import { createTranslator } from './i18n.mjs';
import { PROTOCOL_VERSION } from './protocol.mjs';

export function sendToExtension(command, fields = {}) {
  state.bridge.postMessage({ version: PROTOCOL_VERSION, cmd: command, ...fields });
}
export function tr(key, parameters, language) { return createTranslator(language || state.locale.language)(key, parameters); }
export function colorClass(percent) { return percent >= 90 ? 'danger' : percent >= 70 ? 'warn' : ''; }
export function tagColorClass(percent) { return 'tag-' + (colorClass(percent) || 'accent'); }
export function setBar(id, percent) {
  const node = document.getElementById(id);
  if (node) { node.style.width = (Number.isFinite(percent) ? percent : 0) + '%'; node.className = 'fill ' + colorClass(percent); }
}
export function copyText(text) {
  return Promise.resolve().then(() => navigator.clipboard.writeText(text)).then(() => true, () => false);
}
