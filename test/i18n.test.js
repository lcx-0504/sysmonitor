'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { catalogs, resolveLanguage, createTranslator, localizeError } = require('../src/i18n');
const { getWebviewHtml } = require('../src/view/webview-html');

test('all locales share one complete runtime and manifest vocabulary', () => {
  for (const [locale, dictionary] of Object.entries(catalogs)) {
    assert.deepEqual(Object.keys(dictionary).sort(), Object.keys(catalogs.en).sort(), locale);
    const suffix = locale === 'en' ? '' : '.' + locale.toLowerCase();
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.nls' + suffix + '.json'))), dictionary.manifest);
  }
  const t = createTranslator('zh-TW');
  assert.equal(t('settBtn'), '設定');
  assert.equal(t('serversTab'), '伺服器');
  assert.equal(resolveLanguage('zh-Hant'), 'zh-TW');
  assert.equal(resolveLanguage('zh-HK'), 'zh-TW');
  assert.equal(resolveLanguage('zh-CN'), 'zh-CN');
  assert.equal(resolveLanguage('fr'), 'en');
  assert.equal(localizeError({code:'ETIMEDOUT',message:'cpu collection timed out'}, 'zh-TW'), '採集逾時');
  assert.ok(createTranslator('zh-CN')('collectionInfo').startsWith('刷新间隔控制采集频率。'));
  assert.ok(createTranslator('zh-CN')('standardTimeoutInfo').includes('CPU'));
  assert.ok(createTranslator('zh-CN')('extendedTimeoutInfo').includes('GPU'));
  for (const language of ['en', 'zh-CN', 'zh-TW']) {
    const info = createTranslator(language)('collectionInfo');
    assert.ok(!/\d/.test(info), language);
    assert.ok(!/[\r\n]/.test(info), language);
  }
});

test('the generated webview includes shared translations and declares its actual locale', async () => {
  for (const language of ['en', 'zh-CN', 'zh-TW']) {
    const html = await getWebviewHtml({ initConfig: { language }, nonce: 'fixture' });
    assert.ok(html.includes('<html lang="' + language + '">'));
    assert.match(html, /type="module"[^>]+src="\.\/main\.mjs"/);
    const browser = await import('../src/view/assets/i18n.mjs');
    for (const [key,value] of Object.entries(catalogs[language])) {
      const actual=browser.catalogs[language][key];
      if (typeof value==='function') assert.equal(actual.toString(),value.toString(),language+':'+key);
      else assert.deepEqual(actual,value,language+':'+key);
    }
    assert.equal(browser.createTranslator(language)('settBtn'), createTranslator(language)('settBtn'));
    assert.equal(browser.localizeError({code:'ETIMEDOUT',message:'cpu collection timed out'}, language), localizeError({code:'ETIMEDOUT',message:'cpu collection timed out'}, language));
  }
});

test('error categories localize independently from raw diagnostic text', () => {
  assert.equal(localizeError({code:'ETIMEDOUT',message:'network detail'},'zh-CN'),'采集超时');
  assert.equal(localizeError({code:'GPU_OCCUPANCY_UNAVAILABLE',message:'command exited'},'zh-CN'),'GPU 占用信息不可用');
  assert.equal(localizeError({code:'GPU_IDENTITY_UNAVAILABLE',message:'lookup failed'},'zh-CN'),catalogs['zh-CN'].gpuIdentityUnavailable);
  assert.equal(localizeError({code:'EREMOTE',message:'contains collection timed out as payload'},'zh-CN'),'远程命令执行失败：contains collection timed out as payload');
});

const projectRoot = path.join(__dirname, '..');
const GENERATED_SOURCES = new Set(['src/i18n/catalogs.js', 'src/view/assets/i18n.mjs']);
const TRANSLATION_CALL = /(?<!function\s|["'])(?:\b(?:t|tr|translate)|\btranslator\(\)|\bcreateTranslator\([^()]*\))\(\s*/g;
// Calls whose key is computed: each expression maps to the keys it can produce and the file that names them.
const INDIRECT_TRANSLATIONS = {
  'src/extension.js': { key: { file: 'src/ssh/ssh-transport.js', keys: ['remoteTimeoutUnavailable'] } },
  'src/i18n/index.js': { key: { file: 'src/i18n/index.js', keys: ['collectionTimeout', 'collectionBusy', 'collectionIncomplete', 'remoteCommandFailed', 'remoteNotLinux', 'commandOutputTooLarge', 'commandNotFound', 'psUnsupported', 'gpuOccupancyUnavailable', 'gpuIdentityUnavailable'] } },
  'src/view/assets/ui.mjs': { key: null },
  'src/view/assets/connection.mjs': { 'SOURCE_LABEL_KEYS[source]': { file: 'src/view/assets/connection.mjs', keys: ['sourceCpu', 'sourceMemory', 'sourceNetwork', 'sourceDiskIo', 'sourceDiskTopology', 'sourceAccelerators', 'sourceProcesses', 'sourceSshTraffic'] } },
  'src/view/assets/servers.mjs': { key: { file: 'src/view/assets/servers.mjs', keys: ['serverStateConnected', 'serverStateConnecting', 'serverStateLoading', 'serverStateLoadFailed', 'serverStateFailed', 'serverStateIdle'] } },
  'src/view/assets/settings.mjs': { 'field.label': 'collectionFields', 'record.definition.help': 'collectionFields' },
};

function sourceFiles(directory) {
  return fs.readdirSync(path.join(projectRoot, directory), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.(?:js|mjs)$/.test(entry.name) && !GENERATED_SOURCES.has(relative) ? [relative] : [];
  });
}

function translationUsage() {
  const literal = new Set();
  const dynamic = {};
  for (const file of ['extension.js', ...sourceFiles('src')]) {
    const source = fs.readFileSync(path.join(projectRoot, file), 'utf8');
    for (const match of source.matchAll(TRANSLATION_CALL)) {
      const rest = source.slice(match.index + match[0].length);
      const key = rest.match(/^(['"])([A-Za-z]\w*)\1/);
      if (key) literal.add(key[2]);
      else if (!rest.startsWith(')')) (dynamic[file] ||= []).push(rest.match(/^[^,)]+/)[0].trim());
    }
  }
  return { literal, dynamic };
}

test('every translation key used in source exists in all locales and every catalog key is used', () => {
  const { COLLECTION_FIELDS } = require('../src/config/default-config');
  const { literal, dynamic } = translationUsage();
  assert.deepEqual(Object.fromEntries(Object.entries(dynamic).map(([file, expressions]) => [file, [...new Set(expressions)].sort()])),
    Object.fromEntries(Object.entries(INDIRECT_TRANSLATIONS).map(([file, expressions]) => [file, Object.keys(expressions).sort()])));
  const used = new Set(literal);
  for (const expressions of Object.values(INDIRECT_TRANSLATIONS)) {
    for (const [expression, source] of Object.entries(expressions)) {
      if (source === 'collectionFields') {
        for (const field of COLLECTION_FIELDS) used.add(expression === 'field.label' ? field.label : field.help);
      } else if (source) {
        const text = fs.readFileSync(path.join(projectRoot, source.file), 'utf8');
        for (const key of source.keys) {
          assert.match(text, new RegExp(`['"]${key}['"]`), source.file + ' names ' + key);
          used.add(key);
        }
      }
    }
  }
  for (const [locale, dictionary] of Object.entries(catalogs)) {
    for (const key of used) assert.ok(Object.hasOwn(dictionary, key), locale + ' is missing ' + key);
  }
  const unused = Object.keys(catalogs.en).filter((key) => key !== 'manifest' && !used.has(key));
  assert.deepEqual(unused, []);
});

test('translations are plain text or interpolation functions without embedded markup', () => {
  for (const [locale, dictionary] of Object.entries(catalogs)) {
    for (const [key, value] of Object.entries(dictionary)) {
      if (key === 'manifest') continue;
      assert.ok(typeof value === 'string' || typeof value === 'function', locale + ':' + key);
      assert.doesNotMatch(String(value), /<[a-z/!]|&[a-z]+;/i, locale + ':' + key);
      if (typeof value === 'string') assert.doesNotMatch(value, /\{\w+\}/, locale + ':' + key);
    }
  }
});

test('manifest placeholders exist in every package localization and every manifest entry is referenced', () => {
  const manifestText = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8');
  const referenced = new Set([...manifestText.matchAll(/"%([A-Za-z]\w*)%"/g)].map((match) => match[1]));
  for (const [locale, dictionary] of Object.entries(catalogs)) {
    const suffix = locale === 'en' ? '' : '.' + locale.toLowerCase();
    const localization = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.nls' + suffix + '.json'), 'utf8'));
    for (const key of referenced) assert.ok(Object.hasOwn(localization, key), locale + ' is missing %' + key + '%');
    assert.deepEqual(Object.keys(dictionary.manifest).sort(), [...referenced].sort(), locale);
  }
});
