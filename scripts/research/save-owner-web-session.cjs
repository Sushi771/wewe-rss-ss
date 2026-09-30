#!/usr/bin/env node
'use strict';
// Migrate only normal authentication cookies from this project's dedicated
// owner-confirmed official login. No profiles, storage, HAR, tickets or signatures.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  safePrivateRoot,
  sqliteApi,
  oneAccount,
} = require('./probe-mobile-refresh-preflight.cjs');
const { verifiedSessionStatus } = require('./probe-weread-logged-mp-dom.cjs');
const { durable } = require('./probe-recent-account-discovery.cjs');
const root = path.resolve(__dirname, '../..');
let stage = 'arguments';
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !path.isAbsolute(args[0])) throw Error('usage_gate');
  const dest = safePrivateRoot(args[0]);
  stage = 'prior_owner_login';
  const source = JSON.parse(
    fs.readFileSync(
      path.join(root, 'private-data/owner-web-search-20260930/result.json'),
    ),
  );
  if (
    source.decision !== 'owner_search_pages_preserved' ||
    source.credentialSource !== 'owner_confirmed_official_web_login'
  )
    throw Error('owner_login_evidence_missing');
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
  const db = new (sqliteApi().DatabaseSync)(
    path.join(root, 'apps/server/data/wewe-rss.db'),
    { readOnly: true },
  );
  let vid;
  try {
    db.exec('PRAGMA query_only=ON');
    vid = oneAccount(db).mobile.vid;
  } finally {
    db.close();
  }
  const modulePath = path.join(
    root,
    'private-data/runtime-playwright-core-1.58.2/node_modules/playwright-core',
  );
  if (
    JSON.parse(fs.readFileSync(path.join(modulePath, 'package.json')))
      .version !== '1.58.2'
  )
    throw Error('runtime_gate');
  const browser = await require(modulePath).chromium.connectOverCDP(
    verifiedSessionStatus(status),
  );
  try {
    stage = 'dedicated_context';
    const contexts = browser.contexts();
    if (contexts.length !== 1) throw Error('context_gate');
    const pages = contexts[0]
      .pages()
      .filter((p) => new URL(p.url()).origin === 'https://weread.qq.com');
    if (
      pages.length !== 1 ||
      (await pages[0]
        .locator('iframe[src*="captcha"]')
        .isVisible()
        .catch(() => false))
    )
      throw Error('official_page_gate');
    const allowed = new Set(['wr_pf', 'wr_ql', 'wr_rt', 'wr_skey', 'wr_vid']);
    const cookies = (
      await contexts[0].cookies(
        'https://weread.qq.com/web/wx_search_broker_proxy',
      )
    )
      .filter((c) => allowed.has(c.name))
      .map(({ name, value, domain, path, secure, expires }) => ({
        name,
        value,
        domain,
        path,
        secure,
        expires,
      }));
    stage = 'normal_cookie_gate';
    console.log(
      JSON.stringify({
        cookieAttributes: cookies.map(
          ({ name, domain, path, secure, expires }) => ({
            name,
            domain,
            path,
            secure,
            expired: expires !== -1 && expires * 1000 <= Date.now(),
          }),
        ),
        ownerMatches: cookies.find((c) => c.name === 'wr_vid')?.value === vid,
      }),
    );
    const session = {
      source: 'owner-confirmed-dedicated-web-login',
      capturedAt: new Date().toISOString(),
      ownerVid: vid,
      cookies,
    };
    require(
      path.join(
        root,
        'apps/server/dist/apps/server/src/collection/owner-web-search.js',
      ),
    ).ownerSessionCookie(session, vid);
    durable(path.join(dest, 'session.json'), session);
    // Carry the preceding successful search cooldown into the durable backend budget.
    durable(path.join(dest, 'request-state.json'), {
      lastAttemptAt: Date.parse(source.capturedAt),
      stops: {},
    });
    console.log(
      JSON.stringify({
        saved: true,
        source: session.source,
        cookieNames: cookies.map((c) => c.name),
        networkRequests: 0,
      }),
    );
  } finally {
    await browser.close();
  }
}
main().catch(() => {
  console.log(
    JSON.stringify({
      saved: false,
      decision: 'session_export_gate_failed',
      stage,
      networkRequests: 0,
    }),
  );
  process.exitCode = 1;
});
