'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function expandHome(value, home = os.homedir()) {
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(home, value.slice(2));
  return value;
}

function missingAsEmpty(error) {
  if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return [];
  throw error;
}

function globPart(part) {
  if (part === '*') return '.*';
  if (part === '?') return '.';
  return part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globPattern(pattern) {
  return new RegExp('^' + pattern.split(/([*?])/).map(globPart).join('') + '$');
}

async function expandInclude(pattern, home = os.homedir(), fileSystem = fs) {
  const homeExpanded = expandHome(pattern, home);
  const absolute = path.isAbsolute(homeExpanded) ? homeExpanded : path.join(home, '.ssh', homeExpanded);
  const resolved = path.resolve(absolute);
  const root = path.parse(resolved).root;
  const parts = resolved.slice(root.length).split(path.sep).filter(Boolean);
  let candidates = [root];
  for (const part of parts) {
    if (!/[?*]/.test(part)) {
      candidates = candidates.map((candidate) => path.join(candidate, part));
      continue;
    }
    const matcher = globPattern(part);
    const next = [];
    for (const candidate of candidates) {
      const entries = await fileSystem.readdir(candidate).catch(missingAsEmpty);
      for (const entry of entries.sort()) if (matcher.test(entry)) next.push(path.join(candidate, entry));
    }
    candidates = next;
  }
  return candidates;
}

function parseWords(raw) {
  const words = [];
  const expression = /(?:#.*$|"([^"]*)"|'([^']*)'|([^\s#]+))/g;
  let match;
  while ((match = expression.exec(raw))) {
    if (match[0].startsWith('#')) break;
    words.push(match[1] ?? match[2] ?? match[3]);
  }
  return words;
}

async function listSshHosts(configFile, { home = os.homedir(), visited = new Set(), fileSystem = fs } = {}) {
  const file = path.resolve(expandHome(configFile || path.join(home, '.ssh', 'config'), home));
  let canonical;
  try {
    canonical = await fileSystem.realpath(file);
  } catch (error) {
    return missingAsEmpty(error);
  }
  if (visited.has(canonical)) return [];
  visited.add(canonical);
  const contents = await fileSystem.readFile(canonical, 'utf8');
  const hosts = [];
  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(/^\s*(Host|Include)(?:\s*=\s*|\s+)(.*)$/i);
    if (!match) continue;
    const values = parseWords(match[2]);
    if (match[1].toLowerCase() === 'host') {
      for (const value of values) if (value && !/[?*!]/.test(value) && !value.startsWith('-')) hosts.push(value);
    } else {
      for (const include of values) {
        for (const includedFile of await expandInclude(include, home, fileSystem)) hosts.push(...await listSshHosts(includedFile, { home, visited, fileSystem }));
      }
    }
  }
  return [...new Set(hosts)];
}

module.exports = { listSshHosts, expandInclude, expandHome, parseWords };
