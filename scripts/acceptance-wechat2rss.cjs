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
// 只输出本项目已定义的固定安全码，不透传未知上游消息或凭据。
const safeErrorCodes = new Set([
  'PRIVATE_INSTANCE_CONFIG_INCOMPLETE',
  'SERVER_BUILD_REQUIRED',
  'ACCOUNT_UNAVAILABLE',
  'ACCOUNT_CHALLENGED',
  'TARGET_NOT_UNIQUELY_SUBSCRIBED',
  'QUERY_INVALID',
  'UPSTREAM_READ_FAILED',
  'UPSTREAM_RESPONSE_TOO_LARGE',
  'WECHAT2RSS_PRIVATE_CONFIG_INVALID',
  'WECHAT2RSS_REQUEST_FAILED',
  'WECHAT2RSS_UPSTREAM_REJECTED',
  'WECHAT2RSS_LIST_INVALID',
  'WECHAT2RSS_FEED_LINK_INVALID',
  'WECHAT2RSS_LIST_INCOMPLETE',
  'WECHAT2RSS_LIST_CONFLICT',
  'WECHAT2RSS_LOGIN_LIST_INVALID',
  'WECHAT2RSS_FEED_ID_INVALID',
  'WECHAT2RSS_SUBSCRIPTION_MISSING',
  'WECHAT2RSS_SUBSCRIPTION_NAME_CHANGED',
  'WECHAT2RSS_ARTICLE_IDENTITY_UNVERIFIED',
  'WECHAT2RSS_BODY_TOO_LARGE',
  'WECHAT2RSS_FEED_INVALID',
  'WECHAT2RSS_FEED_TOO_LARGE',
  'WECHAT2RSS_ITEM_INVALID',
  'WECHAT2RSS_ARTICLE_IDENTITY_CONFLICT',
  'WECHAT2RSS_ARTICLE_METADATA_INVALID',
  'WECHAT2RSS_ARTICLE_DATE_INVALID',
]);
const errorCode = (error, fallback = 'UPSTREAM_FORMAT_UNVERIFIED') =>
  error instanceof Error && safeErrorCodes.has(error.message)
    ? error.message
    : fallback;

async function main() {
  let provider;
  let configCode = 'PRIVATE_INSTANCE_CONFIG_INCOMPLETE';
  if (configured.baseUrl && configured.token) {
    try {
      const { Wechat2RssProvider } = require(
        path.resolve(
          __dirname,
          '../apps/server/dist/apps/server/src/collection/providers/wechat2rss.js',
        ),
      );
      try {
        // 复用实际 Provider 的私有地址和 Token 格式门禁，构造不发送请求。
        provider = new Wechat2RssProvider(
          process.env.WECHAT2RSS_BASE_URL,
          process.env.WECHAT2RSS_TOKEN,
        );
        configCode = 'PRIVATE_CONFIG_VALID';
      } catch {
        configCode = 'WECHAT2RSS_PRIVATE_CONFIG_INVALID';
      }
    } catch {
      configCode = 'SERVER_BUILD_REQUIRED';
    }
  }
  const configCheck = { valid: Boolean(provider), code: configCode };
  if (!execute) {
    console.log(
      JSON.stringify({
        mode: 'preflight-only',
        configured,
        configCheck,
        appEnabled: process.env.WECHAT2RSS_ENABLED === '1',
        next: configCheck.valid
          ? '私有实例完成授权、扫码并添加目标号后，使用 --execute MP_WXS_<数字ID> 执行只读联调；无需启用应用采集。'
          : configCode === 'SERVER_BUILD_REQUIRED'
            ? '先构建后端，再重新执行默认配置预检；本次没有联网。'
            : '先修正本机私有配置，再重新执行默认配置预检；本次没有联网。',
        note: '仅检查配置存在与格式，未验证授权、额度、账号或图文。',
      }),
    );
    return;
  }
  if (!configCheck.valid) throw new Error(configCode);
  if (!feedId) throw new Error('PRIVATE_INSTANCE_CONFIG_INCOMPLETE');
  const account = await provider.checkAccountStatus();
  if (!account.available)
    throw new Error(
      account.challenged ? 'ACCOUNT_CHALLENGED' : 'ACCOUNT_UNAVAILABLE',
    );
  const listed = (await provider.listSubscriptions()).filter(
    (item) => item.feedId === feedId,
  );
  if (listed.length !== 1) throw new Error('TARGET_NOT_UNIQUELY_SUBSCRIBED');
  // 任一步读取失败即停止；不换端点继续尝试未知的认证或限制失败。
  const page = await provider.fetchArticles(feedId, listed[0].name);
  const query = new URL('/api/query', process.env.WECHAT2RSS_BASE_URL);
  query.searchParams.set('bid', feedId.slice(7));
  query.searchParams.set('content', '1');
  const queryResult = await boundedJson(query, process.env.WECHAT2RSS_TOKEN);
  const queryValid =
    queryResult && queryResult.err === '' && Array.isArray(queryResult.data);
  if (!queryValid) throw new Error('QUERY_INVALID');
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
        jsonFeed: {
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
        query: { count: queryResult.data.length, fields },
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
  console.error(errorCode(error, 'PRIVATE_INSTANCE_PREFLIGHT_FAILED'));
  process.exitCode = 1;
});
