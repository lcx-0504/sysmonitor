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
  assert.equal(t('servers'), '伺服器');
  assert.equal(resolveLanguage('zh-Hant'), 'zh-TW');
  assert.equal(resolveLanguage('zh-HK'), 'zh-TW');
  assert.equal(resolveLanguage('zh-CN'), 'zh-CN');
  assert.equal(resolveLanguage('fr'), 'en');
  assert.equal(localizeError({code:'ETIMEDOUT',message:'cpu collection timed out'}, 'zh-TW'), '採集逾時');
  assert.ok(createTranslator('zh-CN')('timeoutInfo').startsWith('刷新间隔控制采集频率。'));
  assert.ok(createTranslator('zh-CN')('standardTimeoutInfo').includes('CPU'));
  assert.ok(createTranslator('zh-CN')('extendedTimeoutInfo').includes('GPU'));
  for (const language of ['en', 'zh-CN', 'zh-TW']) {
    const info = createTranslator(language)('timeoutInfo');
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
