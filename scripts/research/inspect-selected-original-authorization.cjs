#!/usr/bin/env node
'use strict';
// Offline inspection of the one owner-confirmed, project-owned official page.
// Browser DOM is recorded separately and is never a background HTTP cache.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { verifiedSessionStatus } = require('./probe-weread-logged-mp-dom.cjs');
const root = path.resolve(__dirname, '../..'),
  dir = path.join(root, 'private-data/single-account-update-20260930');
const selected = JSON.parse(
  fs.readFileSync(path.join(dir, 'official-original-selection.json'), 'utf8'),
);
async function main() {
  const status = execFileSync(
    'pwsh',
    [
      '-NoProfile',
      '-File',
      path.join(__dirname, 'weread-login-window.ps1'),
      '-Action',
      'Status',
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 },
  );
  const modulePath = path.join(
    root,
    'private-data/runtime-playwright-core-1.58.2/node_modules/playwright-core',
  );
  if (
    JSON.parse(fs.readFileSync(path.join(modulePath, 'package.json')))
      .version !== '1.58.2'
  )
    throw Error('RUNTIME_GATE');
  const browser = await require(modulePath).chromium.connectOverCDP(
    verifiedSessionStatus(status),
  );
  try {
    const contexts = browser.contexts();
    if (contexts.length !== 1) throw Error('DEDICATED_CONTEXT_GATE');
    const pages = contexts[0].pages().filter((p) => {
      const u = new URL(p.url());
      return u.origin === 'https://mp.weixin.qq.com' && u.pathname === '/s';
    });
    if (pages.length !== 1)
      throw Error('OFFICIAL_PAGE_NOT_SINGLE_OR_STILL_VERIFICATION');
    const html = await pages[0].content();
    const parser = require(
      path.join(
        root,
        'apps/server/dist/apps/server/src/collection/article-page',
      ),
    );
    const identity = parser.articleIdentity(html),
      ct = parser.articlePublishTime(html),
      body = parser.articleContentHtml(html);
    if (identity.url !== selected.candidate.url || !ct || !body)
      throw Error('BROWSER_IDENTITY_TIME_OR_BODY_GATE');
    const cookieAttributes = (await contexts[0].cookies(selected.rawUrl)).map(
      ({ name, domain, path, secure, expires, httpOnly, sameSite }) => ({
        name,
        domain,
        path,
        secure,
        httpOnly,
        sameSite,
        expired: expires !== -1 && expires * 1000 <= Date.now(),
      }),
    );
    const result = {
      kind: 'owner-confirmed-browser-dom',
      observedAt: new Date().toISOString(),
      id: identity.id,
      identityMatches: true,
      publishTimeFromBrowserDOM: ct,
      sha256: crypto.createHash('sha256').update(html).digest('hex'),
      cookieAttributes,
      credentialsExported: false,
      backgroundHttpRequests: 0,
      purpose:
        '审查一次同 URL 公共原文验证的新正常条件；不把浏览器内容计为后台取文成功，不复制 Cookie 或临时签名',
    };
    fs.writeFileSync(path.join(dir, 'official-browser-dom.html'), html, {
      flag: 'wx',
      mode: 0o600,
    });
    fs.writeFileSync(
      path.join(dir, 'official-browser-observation.json'),
      JSON.stringify(result, null, 2),
      { flag: 'wx', mode: 0o600 },
    );
    console.log(JSON.stringify(result));
  } finally {
    await browser.close();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
