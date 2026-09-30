#!/usr/bin/env node
'use strict';
// Exactly one same-URL backend validation after the owner's new official-page
// condition. No browser Cookie, tickets, URL variants, redirects or retries.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto'),
  https = require('node:https');
const { environmentGate } = require('./probe-refreshed-mobile-web-health.cjs');
const root = path.resolve(__dirname, '../..'),
  dir = path.join(root, 'private-data/single-account-update-20260930');
const hash = (b) => crypto.createHash('sha256').update(b).digest('hex');
const write = (name, value) =>
  fs.writeFileSync(path.join(dir, name), JSON.stringify(value, null, 2), {
    flag: 'wx',
    mode: 0o600,
  });
function request(url) {
  return new Promise((resolve, reject) => {
    const r = https.request(
      url,
      {
        method: 'GET',
        agent: false,
        timeout: 12000,
        headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0' },
      },
      (res) => {
        if (res.statusCode !== 200) {
          const location = res.headers.location;
          let redirectVerification = false;
          try {
            const u = new URL(location);
            redirectVerification =
              u.hostname === 'mp.weixin.qq.com' &&
              /verify|captcha|login/i.test(u.pathname);
          } catch {}
          res.resume();
          resolve({ status: res.statusCode, redirectVerification });
          return;
        }
        const chunks = [];
        let size = 0;
        res.on('data', (b) => {
          size += b.length;
          if (size > 6 * 1024 * 1024) res.destroy(Error('ORIGINAL_SIZE_LIMIT'));
          else chunks.push(b);
        });
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: 200,
            html: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    r.on('error', reject);
    r.on('timeout', () => r.destroy(Error('ORIGINAL_TIMEOUT')));
    r.end();
  });
}
async function main() {
  environmentGate(process.env);
  const s = JSON.parse(
    fs.readFileSync(path.join(dir, 'official-original-selection.json'), 'utf8'),
  );
  const observation = JSON.parse(
    fs.readFileSync(
      path.join(dir, 'official-browser-observation.json'),
      'utf8',
    ),
  );
  if (
    observation.id !== s.candidate.id ||
    !observation.identityMatches ||
    observation.credentialsExported ||
    Date.now() - Date.parse(observation.observedAt) > 30 * 60 * 1000
  )
    throw Error('NEW_OFFICIAL_CONDITION_GATE');
  const url = new URL(s.rawUrl);
  if (url.origin !== 'https://mp.weixin.qq.com' || url.pathname !== '/s')
    throw Error('SAME_ORIGINAL_URL_GATE');
  const { canonicalArticleUrl } = require(
    path.join(
      root,
      'apps/server/dist/apps/server/src/collection/collection-format',
    ),
  );
  if (
    canonicalArticleUrl(s.rawUrl).url !== s.candidate.url ||
    hash(fs.readFileSync(path.join(dir, 'official-browser-dom.html'))) !==
      observation.sha256
  )
    throw Error('ORIGINAL_IDENTITY_OR_BROWSER_EVIDENCE_CHANGED');
  const marker = path.join(dir, 'selected-backend-original-attempt.json');
  const fd = fs.openSync(marker, 'wx', 0o600);
  try {
    fs.writeFileSync(
      fd,
      JSON.stringify({
        id: s.candidate.id,
        urlHash: hash(s.rawUrl),
        reservedAt: new Date().toISOString(),
        normalCondition:
          'owner-confirmed same article official page, independently inspected identity/ct',
        priorAnonymousStopRetained: true,
        cookiesSent: false,
        requestBudget: 1,
      }),
    );
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  let result;
  try {
    const response = await request(s.rawUrl);
    if (response.status !== 200) {
      result = {
        stage: 'original',
        status: 'blocked',
        httpStatus: response.status,
        redirectVerification: response.redirectVerification,
        requests: 1,
        stopFurtherOriginalRequests: true,
      };
    } else {
      const evidence = {
        source: 'official-public-original',
        transport: 'live-original',
        requestedUrl: s.rawUrl,
        capturedAt: new Date().toISOString(),
        sha256: hash(response.html),
      };
      fs.writeFileSync(
        path.join(dir, 'selected-backend-original.html'),
        response.html,
        { flag: 'wx', mode: 0o600 },
      );
      write('selected-backend-original-evidence.json', evidence);
      const { verifyCandidateOriginal } = require(
        path.join(
          root,
          'apps/server/dist/apps/server/src/collection/article-candidate',
        ),
      );
      try {
        const verified = verifyCandidateOriginal(
          s.candidate,
          response.html,
          evidence,
        );
        write('selected-backend-verified.json', verified);
        result = {
          stage: 'original',
          status: 'verified',
          id: verified.article.id,
          publishTime: verified.article.publishTime,
          requests: 1,
          source: 'live independent backend HTTP',
          cookiesSent: false,
          productionWrites: 0,
        };
      } catch (e) {
        result = {
          stage: 'original-verification',
          status: 'blocked',
          reason: e.code || 'local_parser_failure',
          httpStatus: 200,
          requests: 1,
          stopFurtherOriginalRequests: true,
        };
      }
    }
  } catch (e) {
    result = {
      stage: 'original-transport',
      status: 'failed',
      reason:
        e.message === 'ORIGINAL_TIMEOUT'
          ? 'timeout'
          : 'network_or_size_failure',
      requests: 1,
      stopFurtherOriginalRequests: true,
    };
  }
  write('selected-backend-original-result.json', result);
  if (result.stopFurtherOriginalRequests)
    write('selected-backend-original-stop.json', {
      ...result,
      at: new Date().toISOString(),
      priorStopRetained: true,
    });
  console.log(JSON.stringify(result));
}
main().catch((e) => {
  console.error(
    e.code === 'EEXIST' ? 'ONE_REQUEST_ALREADY_RESERVED_NO_RETRY' : e.message,
  );
  process.exitCode = 1;
});
