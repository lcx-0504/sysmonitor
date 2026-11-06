'use strict';
const pkg = require('../../package.json');
const extensionId = `${pkg.publisher}.${pkg.name}`;

function defaultExtensions(vscode) {
  const entries = vscode.workspace?.getConfiguration('remote.SSH').get('defaultExtensions');
  return Array.isArray(entries) ? entries : [];
}
function isSshDefaultExtension(vscode) {
  return defaultExtensions(vscode).some((value) => typeof value === 'string' && value.toLowerCase() === extensionId.toLowerCase());
}
async function addSshDefaultExtension(vscode) {
  if (!isSshDefaultExtension(vscode)) await vscode.workspace.getConfiguration('remote.SSH').update('defaultExtensions', [...defaultExtensions(vscode), extensionId], true);
}
module.exports = { isSshDefaultExtension, addSshDefaultExtension };
