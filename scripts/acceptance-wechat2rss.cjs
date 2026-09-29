#!/usr/bin/env node
/* Read-only private-instance preflight. Never writes the upstream or local database. */
const path = require('node:path');
const fs = require('node:fs');

// The server loads .env.local at startup; this standalone preflight must read
// the same ignored file without starting the server or enabling collection.
const serverRoot = path.resolve(__dirname, '../apps/server');
const privateEnv = path.join(serverRoot, '.env.local');
if (fs.existsSync(privateEnv)) {
  const { createRequire } = require('node:module');
  const serverRequire = createRequire(path.join(serverRoot, 'package.json'));
  const parseEnv = createRequire(serverRequire.resolve('@nestjs/config'))(
    'dotenv',
  ).parse;
  const values = parseEnv(fs.readFileSync(privateEnv));
  for (const key of [
    'WECHAT2RSS_BASE_URL',
    'WECHAT2RSS_TOKEN',
    'WECHAT2RSS_ENABLED',
  ]) {
    if (process.env[key] === undefined && values[key] !== undefined)
      process.env[key] = values[key];
  }
}

const feedId = process.argv.find((value) => /^MP_WXS_\d{5,15}$/.test(value));
const execute = process.argv.includes('--execute');
const configured = {
  baseUrl: Boolean(process.env.WECHAT2RSS_BASE_URL),
  token: Boolean(process.env.WECHAT2RSS_TOKEN),
  target: Boolean(feedId),
};

async function boundedText(url, token) {
  url.searchParams.set('k', token);
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  });
  if (response.status !== 200 || !response.body)
    throw new Error('UPSTREAM_READ_FAILED');
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4_000_000) {
      await reader.cancel();
      throw new Error('UPSTREAM_RESPONSE_TOO_LARGE');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const boundedJson = async (url, token) =>
  JSON.parse(await boundedText(url, token));
const errorCode = (error) =>
  error instanceof Error && /^[A-Z_]+$/.test(error.message)
    ? error.message
    : 'UPSTREAM_FORMAT_UNVERIFIED';

async function main() {
  if (!execute) {
    console.log(
      JSON.stringify({
        mode: 'preflight-only',
        configured,
        appEnabled: process.env.WECHAT2RSS_ENABLED === '1',
        next: '私有实例完成授权、扫码并添加目标号后，使用 --execute MP_WXS_<数字ID> 执行只读联调；无需启用应用采集。',
      }),
    );
    return;
  }
  if (!Object.values(configured).every(Boolean))
    throw new Error('PRIVATE_INSTANCE_CONFIG_INCOMPLETE');
  const { Wechat2RssProvider } = require(
    path.resolve(
      __dirname,
      '../apps/server/dist/apps/server/src/collection/providers/wechat2rss.js',
    ),
  );
  const provider = new Wechat2RssProvider(
    process.env.WECHAT2RSS_BASE_URL,
    process.env.WECHAT2RSS_TOKEN,
  );
  const account = await provider.checkAccountStatus();
  const listed = (await provider.listSubscriptions()).filter(
    (item) => item.feedId === feedId,
  );
  if (listed.length !== 1) throw new Error('TARGET_NOT_UNIQUELY_SUBSCRIBED');
  const page = await provider
    .fetchArticles(feedId, listed[0].name)
    .catch((error) => ({ error: errorCode(error) }));
  const query = new URL('/api/query', process.env.WECHAT2RSS_BASE_URL);
  query.searchParams.set('bid', feedId.slice(7));
  query.searchParams.set('content', '1');
  const queryResult = await boundedJson(
    query,
    process.env.WECHAT2RSS_TOKEN,
  ).catch((error) => ({ error: errorCode(error) }));
  const queryValid =
    queryResult && queryResult.err === '' && Array.isArray(queryResult.data);
  const fields = queryValid
    ? [
        ...new Set(
          queryResult.data.flatMap((item) =>
            item && typeof item === 'object' ? Object.keys(item) : [],
          ),
        ),
      ].sort()
    : [];
  const rssUrl = new URL(
    listed[0].feedUrl.replace(/\.json$/, '.xml'),
    process.env.WECHAT2RSS_BASE_URL,
  );
  const rss = await boundedText(rssUrl, process.env.WECHAT2RSS_TOKEN)
    .then((xml) => ({
      items: (xml.match(/<item\b/g) || []).length,
      entries: (xml.match(/<entry\b/g) || []).length,
    }))
    .catch((error) => ({ error: errorCode(error) }));
  console.log(
    JSON.stringify(
      {
        mode: 'read-only',
        feedId,
        account,
        subscription: listed[0].name,
        jsonFeed: page.error
          ? page
          : {
              count: page.articles.length,
              bodyMissing: page.bodyMissing,
              imageBlocked: page.imageBlocked,
              articles: page.articles.map((item) => ({
                id: item.id,
                publishedAt: new Date(item.publishTime * 1000).toISOString(),
                body: Boolean(item.contentHtml),
                image: Boolean(item.picUrl),
              })),
            },
        query: queryValid
          ? { count: queryResult.data.length, fields }
          : { error: queryResult.error || 'QUERY_INVALID' },
        rss,
        note: '仅说明该时刻缓存与字段结构；尚未证明任务完成、图片落盘或订阅前全史。',
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  // Upstream errors, request URLs, response bodies, and credentials stay local and hidden.
  console.error(
    error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message
      : 'PRIVATE_INSTANCE_PREFLIGHT_FAILED',
  );
  process.exitCode = 1;
});
