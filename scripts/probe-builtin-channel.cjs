// Read-only, credential-free first-party channel probe. No DB or downloader access.
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const crypto = require('node:crypto');
const exec = promisify(execFile);
const out = path.resolve(__dirname, '../output/playwright/channel-builtin');
const biz = 'Mzg5NTQzMTQxMg==';
const origin = 'https://mp.weixin.qq.com';
const probes = [
  ['home', '/mp/profile_ext', { action: 'home', __biz: biz, scene: '124' }],
  [
    'getmsg',
    '/mp/profile_ext',
    {
      action: 'getmsg',
      __biz: biz,
      f: 'json',
      offset: '0',
      count: '10',
      is_ok: '1',
      scene: '124',
    },
  ],
];
// This opt-in branch must only be run after explicit permission to inspect
// recent WeChat WEB cache for the target account. It never reads chat databases.
async function captureAndVerify() {
  const axios = require('../apps/server/node_modules/axios/dist/node/axios.cjs');
  const root = path.join(
    process.env.APPDATA,
    'Tencent/xwechat/radium/web/profiles',
  );
  const cutoff = Date.now() - 30 * 60000;
  const deadline = Date.now() + 20000;
  const summary = {
    at: new Date().toISOString(),
    mode: 'authorized-web-cache-probe',
    root: '%APPDATA%/Tencent/xwechat/radium/web/profiles',
    scannedFiles: 0,
    scannedBytes: 0,
    directories: 0,
    candidateCount: 0,
    truncated: false,
    validations: [],
    credentialsPersisted: false,
    databaseTouched: false,
    fullAccountCollectionVerified: false,
  };
  const queue = [root];
  const candidates = new Map();
  const allowedFields = [
    'uin',
    'key',
    'pass_ticket',
    'appmsg_token',
    'poc_token',
  ];
  while (queue.length) {
    if (
      Date.now() > deadline ||
      summary.directories >= 500 ||
      summary.scannedFiles >= 500 ||
      summary.scannedBytes >= 100 * 1024 * 1024
    ) {
      summary.truncated = true;
      break;
    }
    const dir = queue.pop();
    summary.directories++;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isSymbolicLink()) continue;
      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full);
      if (ent.isDirectory()) {
        if (
          !/^(?:Network|Local Storage|Session Storage|IndexedDB|Service Worker|GPUCache|Code Cache|Extensions|File System|blob_storage|Video|Image|Attachment)$/i.test(
            ent.name,
          )
        )
          queue.push(full);
        continue;
      }
      // Only Chromium HTTP cache files; no Cookies, History, Login Data, logs,
      // chat DBs, account DBs, attachments or arbitrary app files.
      if (
        !ent.isFile() ||
        !rel.split(path.sep).some((s) => /^(Cache|Cache_Data)$/i.test(s)) ||
        /\.(db|sqlite|sqlite3|log|exe|dll|jpg|png|jpeg|webp)$/i.test(ent.name)
      )
        continue;
      let stat;
      try {
        stat = await fs.stat(full);
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
        summary.scannedFiles >= 500 ||
        summary.scannedBytes + stat.size > 100 * 1024 * 1024
      ) {
        summary.truncated = true;
        break;
      }
      let buf;
      try {
        buf = await fs.readFile(full);
      } catch {
        continue;
      }
      summary.scannedFiles++;
      summary.scannedBytes += buf.length;
      const text = buf.toString('latin1');
      for (const m of text.matchAll(
        /https?:\/\/mp\.weixin\.qq\.com\/mp\/profile_ext\?[^\x00-\x20\x7f"'<>]{1,16000}/g,
      )) {
        let u;
        try {
          u = new URL(m[0].replace(/&amp;/g, '&'));
        } catch {
          continue;
        }
        if (
          u.hostname !== 'mp.weixin.qq.com' ||
          u.searchParams.get('__biz') !== biz
        )
          continue;
        const fields = Object.fromEntries(
          allowedFields
            .filter((k) => u.searchParams.get(k))
            .map((k) => [k, u.searchParams.get(k)]),
        );
        if (
          !(fields.uin && fields.key && fields.pass_ticket) &&
          !(fields.appmsg_token && fields.pass_ticket)
        )
          continue;
        const digest = crypto
          .createHash('sha256')
          .update(JSON.stringify(fields))
          .digest('hex');
        if (!candidates.has(digest)) candidates.set(digest, fields);
      }
    }
  }
  summary.candidateCount = candidates.size;
  const client = axios.create({
    proxy: { protocol: 'http', host: '127.0.0.1', port: 7890 },
    timeout: 20000,
    maxRedirects: 0,
    maxContentLength: 4 * 1024 * 1024,
    validateStatus: () => true,
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
      Referer: `${origin}/mp/profile_ext?action=home&__biz=${encodeURIComponent(biz)}&scene=124`,
    },
  });
  for (const fields of [...candidates.values()].slice(0, 3)) {
    const validation = { fieldNames: Object.keys(fields), pages: [] };
    try {
      let cookie = '';
      if (!fields.poc_token && fields.uin && fields.key && fields.pass_ticket) {
        const home = await client.get(`${origin}/mp/profile_ext`, {
          params: { action: 'home', __biz: biz, scene: '124', ...fields },
        });
        const token =
          typeof home.data === 'string' &&
          home.data.match(/poc_token\s*:\s*["']([^"']+)["']/);
        if (token) fields.poc_token = token[1];
        const setCookies = home.headers['set-cookie'] || [];
        validation.home = {
          httpStatus: home.status,
          bytes:
            typeof home.data === 'string' ? Buffer.byteLength(home.data) : 0,
          pocTokenFound: Boolean(token),
          cookieNames: setCookies.map((v) => v.split('=')[0]),
          hasMsgList:
            typeof home.data === 'string' &&
            /var\s+msgList\s*=/.test(home.data),
          verificationGate:
            typeof home.data === 'string' &&
            /请在微信客户端|环境异常|完成验证/.test(home.data),
        };
        if (typeof home.data === 'string') {
          const inline = home.data.match(
            /var\s+msgList\s*=\s*(['"])(.*?)\1\s*;/s,
          );
          validation.home.inlineMsgListLength = inline?.[2]?.length ?? null;
          if (inline) {
            try {
              validation.home.inlineMsgListShape = safeShape(
                JSON.parse(
                  inline[2]
                    .replace(/&quot;/g, '"')
                    .replace(/&amp;/g, '&')
                    .replace(/&#39;/g, "'"),
                ),
              );
            } catch {
              validation.home.inlineMsgListParseFailed = true;
            }
          }
          validation.home.scriptSources = [
            ...home.data.matchAll(/<script[^>]+src=["']([^"']+)["']/g),
          ]
            .map((m) => {
              try {
                const u = new URL(m[1], origin);
                return ['mp.weixin.qq.com', 'res.wx.qq.com'].includes(
                  u.hostname,
                )
                  ? u.origin + u.pathname
                  : null;
              } catch {
                return null;
              }
            })
            .filter(Boolean);
          validation.home.moduleNames = [
            ...new Set(
              home.data.match(
                /[a-zA-Z0-9_/-]*(?:profile|history|homepage)[a-zA-Z0-9_/-]*\.js/g,
              ) || [],
            ),
          ];
          validation.home.staticScriptUrls = [
            ...new Set(
              home.data.match(
                /https:\/\/res\.wx\.qq\.com\/[a-zA-Z0-9_./-]+\.js/g,
              ) || [],
            ),
          ];
          validation.home.listVariables = [
            ...home.data.matchAll(
              /(?:var\s+)?(\w*(?:[Ll]ist|offset|[Tt]ype|count)\w*)\s*=\s*([^;\n]{1,100})[;\n]/g,
            ),
          ].map((m) => ({
            name: m[1],
            valueType: /^\s*\d+\s*;?$/.test(m[2]) ? Number(m[2]) : 'redacted',
          }));
        }
        cookie = setCookies
          .filter((v) =>
            /^(poc_sid|wxuin|devicetype|version|lang|pass_ticket|wap_sid2)=/.test(
              v,
            ),
          )
          .map((v) => v.split(';')[0])
          .join('; ');
      }
      let offset = 0;
      for (let i = 0; i < 2; i++) {
        const response = await client.get(`${origin}/mp/profile_ext`, {
          params: {
            action: 'getmsg',
            __biz: biz,
            f: 'json',
            offset,
            count: 10,
            is_ok: 1,
            scene: 124,
            ...fields,
          },
          headers: cookie ? { Cookie: cookie } : {},
        });
        const data = response.data;
        const ret =
          data && typeof data === 'object'
            ? (data.ret ?? data.base_resp?.ret ?? null)
            : null;
        const page = {
          offset,
          httpStatus: response.status,
          ret,
          responseShape: safeShape(data),
          msgCount: typeof data?.msg_count === 'number' ? data.msg_count : null,
          continueFlag:
            typeof data?.can_msg_continue === 'number'
              ? data.can_msg_continue
              : null,
          hasList: Boolean(data?.general_msg_list),
          nextOffset: null,
          canContinue: null,
          articles: [],
        };
        validation.pages.push(page);
        if (ret !== 0 || !data?.general_msg_list) break;
        const general =
          typeof data.general_msg_list === 'string'
            ? JSON.parse(data.general_msg_list)
            : data.general_msg_list;
        if (!Array.isArray(general?.list)) break;
        for (const item of general.list) {
          const main = item.app_msg_ext_info;
          for (const article of [
            main,
            ...(main?.multi_app_msg_item_list || []),
          ].filter(Boolean)) {
            let link;
            try {
              link = new URL(
                (article.content_url || '').replace(/&amp;/g, '&'),
              );
            } catch {
              continue;
            }
            if (
              link.hostname !== 'mp.weixin.qq.com' ||
              link.searchParams.get('__biz') !== biz
            )
              continue;
            page.articles.push({
              title: article.title,
              mid: link.searchParams.get('mid'),
              idx: link.searchParams.get('idx'),
              biz,
              publishTime: item.comm_msg_info?.datetime,
              messageType: item.comm_msg_info?.type,
              itemType: article.item_show_type ?? null,
            });
          }
        }
        page.nextOffset = data.next_offset ?? null;
        page.canContinue = data.can_msg_continue ?? null;
        if (
          !data.can_msg_continue ||
          !Number.isInteger(data.next_offset) ||
          data.next_offset <= offset
        )
          break;
        offset = data.next_offset;
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    } catch {
      validation.error = 'REQUEST_OR_PARSE_FAILED';
    }
    summary.validations.push(validation);
    if (validation.pages.some((p) => p.articles.length)) break;
  }
  await fs.writeFile(
    path.join(out, 'authorized-summary.json'),
    JSON.stringify(summary, null, 2),
  );
  await fs.writeFile(
    path.join(
      out,
      `authorized-summary-${summary.at.replace(/[:.]/g, '-')}.json`,
    ),
    JSON.stringify(summary, null, 2),
  );
  console.log(JSON.stringify(summary, null, 2));
}
function safeShape(value, depth = 0) {
  if (depth > 3) return Array.isArray(value) ? 'array' : typeof value;
  if (Array.isArray(value))
    return {
      length: value.length,
      first: value.length ? safeShape(value[0], depth + 1) : null,
    };
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 40)
        .map(([key, item]) => [key, safeShape(item, depth + 1)]),
    );
  return typeof value;
}
(async () => {
  await fs.mkdir(out, { recursive: true });
  if (process.argv.includes('--authorized-web-cache'))
    return captureAndVerify();
  const results = [];
  for (const [name, pathname, params] of probes) {
    const url = new URL(pathname, origin);
    url.search = new URLSearchParams(params).toString();
    const dest = path.join(out, `${name}.body`);
    const stamp = new Date().toISOString();
    try {
      const { stdout } = await exec(
        'curl.exe',
        [
          '--silent',
          '--show-error',
          '--max-time',
          '35',
          '--proxy',
          'http://127.0.0.1:7890',
          '--user-agent',
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
          '--output',
          dest,
          '--write-out',
          '%{http_code}',
          url.href,
        ],
        { timeout: 40000 },
      );
      const body = await fs.readFile(dest, 'utf8');
      let data;
      try {
        data = JSON.parse(body);
      } catch {
        /* HTML may be a gate */
      }
      const row = {
        name,
        at: stamp,
        url: url.href,
        httpStatus: Number(stdout),
        bytes: Buffer.byteLength(body),
        sha256: crypto.createHash('sha256').update(body).digest('hex'),
        json: Boolean(data),
        ret: data?.ret ?? data?.base_resp?.ret ?? null,
        errmsg: data?.errmsg ?? data?.base_resp?.err_msg ?? null,
        hasGeneralMsgList: Boolean(data?.general_msg_list),
        hasMessageListInHtml: /var\s+msgList\s*=/.test(body),
        requiresWeChat:
          /请在微信客户端打开链接|请在微信客户端打开|请使用微信/.test(body),
        requiresVerification: /环境异常|完成验证|访问过于频繁/.test(body),
        title: body.match(/<title[^>]*>([^<]*)<\/title>/)?.[1] || null,
      };
      results.push(row);
    } catch (error) {
      results.push({ name, at: stamp, error: error.code || 'REQUEST_FAILED' });
    }
  }
  const result = {
    capturedAt: new Date().toISOString(),
    authenticated: false,
    credentialsUsed: false,
    databaseTouched: false,
    fullAccountCollectionVerified: false,
    results,
  };
  await fs.writeFile(
    path.join(out, 'summary.json'),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result, null, 2));
})();
