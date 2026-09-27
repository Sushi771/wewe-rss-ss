// Read-only observation of one known public article. Default is credential-free.
// --authorized-web-cache is opt-in, only after the user opens this article and
// authorizes the existing restricted recent HTTP-cache scope. Never reads Cookies,
// chat databases or arbitrary profiles; never persists credentials or raw HTML.
// Missing/static counters are never interpreted as verified article metrics.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const axios = require('../apps/server/node_modules/axios/dist/node/axios.cjs');

const article = 'https://mp.weixin.qq.com/s/K_oKauPpwhSyavBWQXFMKw';
const expected = { biz: 'Mzg5NTQzMTQxMg==', mid: '2247493540', idx: '1' };
const fields = [
  'read_num_new',
  'read_num',
  'like_count',
  'old_like_count',
  'like_num',
  'old_like_num',
  'share_count',
  'favorite_count',
];

function assignments(html, name) {
  // A token boundary prevents like_count from matching old_like_count.
  const pattern = new RegExp(
    `(?<![\\w$])${name}\\s*[:=]\\s*(["'])([^"'\\r\\n]{0,80})\\1`,
    'g',
  );
  return [...html.matchAll(pattern)].map((m) => ({
    field: name,
    value: /^\d+$/.test(m[2]) ? Number(m[2]) : null,
    state:
      m[2] === ''
        ? 'empty'
        : /^\d+$/.test(m[2])
          ? 'numeric_unverified'
          : 'non_numeric_redacted',
  }));
}

async function recentArticleRequest(report) {
  const root = path.join(
    process.env.APPDATA,
    'Tencent/xwechat/radium/web/profiles',
  );
  const cutoff = Date.now() - 30 * 60000;
  const deadline = Date.now() + 20000;
  const scan = {
    scope: '%APPDATA%/Tencent/xwechat/radium/web/profiles/**/Cache{,_Data}',
    minutes: 30,
    directories: 0,
    files: 0,
    bytes: 0,
    candidates: 0,
    truncated: false,
    targetRequestShapes: [],
  };
  report.cacheScan = scan;
  const pending = [root];
  let candidate = null;
  let candidateTime = 0;
  const allowed = [
    '__biz',
    'mid',
    'idx',
    'sn',
    'chksm',
    'scene',
    'key',
    'ascene',
    'uin',
    'devicetype',
    'version',
    'lang',
    'acctmode',
    'pass_ticket',
    'wx_header',
    'appmsg_token',
  ];
  while (pending.length) {
    if (
      Date.now() > deadline ||
      scan.directories >= 500 ||
      scan.files >= 500 ||
      scan.bytes >= 100 * 1024 * 1024
    ) {
      scan.truncated = true;
      break;
    }
    const directory = pending.pop();
    scan.directories++;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (
          !/^(Network|Local Storage|Session Storage|IndexedDB|Service Worker|GPUCache|Code Cache|Extensions|File System|blob_storage|Video|Image|Attachment)$/i.test(
            entry.name,
          )
        )
          pending.push(file);
        continue;
      }
      if (
        !entry.isFile() ||
        !path
          .relative(root, file)
          .split(path.sep)
          .some((p) => /^(Cache|Cache_Data)$/i.test(p)) ||
        /\.(db|sqlite|sqlite3|log|exe|dll|jpg|png|jpeg|webp)$/i.test(entry.name)
      )
        continue;
      let stat;
      try {
        stat = await fs.stat(file);
      } catch {
        continue;
      }
      if (
        stat.mtimeMs < cutoff ||
        stat.size <= 0 ||
        stat.size > 16 * 1024 * 1024
      )
        continue;
      if (
        Date.now() > deadline ||
        scan.files >= 500 ||
        scan.bytes + stat.size > 100 * 1024 * 1024
      ) {
        scan.truncated = true;
        break;
      }
      let buffer;
      try {
        buffer = await fs.readFile(file);
      } catch {
        continue;
      }
      scan.files++;
      scan.bytes += buffer.length;
      for (const match of buffer
        .toString('latin1')
        .matchAll(
          /https?:\/\/mp\.weixin\.qq\.com\/s(?:\?[^\x00-\x20\x7f"'<>]{1,16000}|\/K_oKauPpwhSyavBWQXFMKw(?:\?[^\x00-\x20\x7f"'<>]{1,16000})?)/g,
        )) {
        let url;
        try {
          url = new URL(match[0].replace(/&amp;/g, '&'));
        } catch {
          continue;
        }
        if (url.hostname !== 'mp.weixin.qq.com' || url.port) continue;
        const targetLong =
          url.pathname === '/s' &&
          url.searchParams.get('__biz') === expected.biz &&
          url.searchParams.get('mid') === expected.mid &&
          url.searchParams.get('idx') === expected.idx;
        const targetShort = url.pathname === '/s/K_oKauPpwhSyavBWQXFMKw';
        if (!targetLong && !targetShort) continue;
        const shape = {
          kind: targetLong ? 'long' : 'short',
          protocol: url.protocol,
          queryFields: [
            ...new Set(
              [...url.searchParams.keys()].filter((key) =>
                /^[A-Za-z_][A-Za-z_0-9]{0,31}$/.test(key),
              ),
            ),
          ].sort(),
        };
        if (
          !scan.targetRequestShapes.some(
            (existing) => JSON.stringify(existing) === JSON.stringify(shape),
          )
        )
          scan.targetRequestShapes.push(shape);
        if (
          !['uin', 'key', 'pass_ticket'].every((field) =>
            url.searchParams.get(field),
          )
        )
          continue;
        scan.candidates++;
        if (stat.mtimeMs < candidateTime) continue;
        const clean = new URL('https://mp.weixin.qq.com' + url.pathname);
        for (const key of allowed)
          if (url.searchParams.has(key))
            clean.searchParams.set(key, url.searchParams.get(key));
        candidate = clean.href;
        candidateTime = stat.mtimeMs;
      }
    }
  }
  return candidate;
}

async function main() {
  const out = path.resolve(__dirname, '../output/playwright/article-metrics');
  await fs.mkdir(out, { recursive: true });
  const report = {
    observedAt: new Date().toISOString(),
    mode: 'public-single-article',
    article,
    expected,
    credentialsUsed: false,
    credentialsPersisted: false,
    sensitiveFilesRead: false,
    databaseTouched: false,
    read: null,
    likes: null,
    favorites: null,
    metricsVerified: false,
  };
  try {
    let requestUrl = article;
    if (process.argv.includes('--authorized-web-cache')) {
      report.mode = 'authorized-single-article-web-cache';
      report.sensitiveFilesRead = true;
      requestUrl = await recentArticleRequest(report);
      if (!requestUrl) {
        report.missingReason =
          'no_recent_exact_article_request_with_required_session_fields';
        throw Object.assign(new Error('NO_ARTICLE_SESSION'), {
          code: 'NO_ARTICLE_SESSION',
        });
      }
      report.credentialsUsed = true;
    }
    const response = await axios.get(requestUrl, {
      proxy: { protocol: 'http', host: '127.0.0.1', port: 7890 },
      maxRedirects: 0,
      timeout: 25000,
      maxContentLength: 8 * 1024 * 1024,
      validateStatus: () => true,
      responseType: 'text',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
      },
    });
    const html = typeof response.data === 'string' ? response.data : '';
    report.httpStatus = response.status;
    report.bytes = Buffer.byteLength(html);
    report.sha256 = crypto.createHash('sha256').update(html).digest('hex');
    report.hasBody = /id=["']js_content["']/.test(html);
    report.requiresVerification = /环境异常|完成验证|访问过于频繁/.test(html);
    report.identity = Object.fromEntries(
      Object.keys(expected).map((field) => {
        const match = html.match(
          new RegExp(`(?:var\\s+)?${field}\\s*=\\s*["']([^"']+)["']`),
        );
        return [field, match?.[1] === expected[field] ? expected[field] : null];
      }),
    );
    report.identityMatches = Object.entries(expected).every(
      ([key, value]) => report.identity[key] === value,
    );
    report.fieldObservations = fields.flatMap((name) =>
      assignments(html, name),
    );
    report.firstPartyScripts = [
      ...new Set(
        html.match(/https:\/\/res\.wx\.qq\.com\/[A-Za-z0-9_./-]+\.js/g) || [],
      ),
    ];
    report.hasAppmsgstat = /\bappmsgstat\b/.test(html);
    report.hasGetappmsgextReference = /getappmsgext/.test(html);
    report.missingReason = !report.hasBody
      ? 'verification_or_non_article_response'
      : 'no_authenticated_metric_response_or_semantic_validation';
  } catch (error) {
    report.error =
      typeof error.code === 'string' ? error.code : 'REQUEST_FAILED';
    report.missingReason ||= 'request_failed';
  }
  const name = `${report.mode}-probe-${report.observedAt.replace(/[:.]/g, '-')}.json`;
  await fs.writeFile(
    path.join(out, name),
    JSON.stringify(report, null, 2) + '\n',
    { flag: 'wx' },
  );
  console.log(JSON.stringify(report, null, 2));
}

main().catch(() => {
  console.error('PROBE_FAILED');
  process.exitCode = 1;
});
