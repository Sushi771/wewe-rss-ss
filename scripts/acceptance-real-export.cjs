// Real target HTML export regression in a newly created temporary SQLite DB.
// This verifies export, NOT acquisition, paging, metrics, or complete history.
const fs = require('node:fs/promises');
const path = require('node:path');
const artifactsApi = require('./local-release/test-artifacts.cjs');
const budget = require('./local-release/space-budget.cjs');
const { createRequire } = require('node:module');
const server = path.resolve(__dirname, '../apps/server');
const serverRequire = createRequire(path.join(server, 'package.json'));
const { PrismaClient } = serverRequire('@prisma/client');
const { load } = serverRequire('cheerio');
const built = path.join(server, 'dist/apps/server/src');
const { CollectionService } = require(
  path.join(built, 'collection/collection.service'),
);
const { TrpcService } = require(path.join(built, 'trpc/trpc.service'));
const { TrpcRouter } = require(path.join(built, 'trpc/trpc.router'));
const { FeedsService } = require(path.join(built, 'feeds/feeds.service'));
const { csvCell } = require(path.join(built, 'collection/collection-format'));

(async () => {
  const source = process.argv[2];
  if (!source)
    throw new Error(
      'Usage: node scripts/acceptance-real-export.cjs <real target HTML>',
    );
  if ((await fs.stat(source)).size > 4 * 1024 ** 2)
    throw new Error('HTML input exceeds 4 MiB test limit');
  const html = await fs.readFile(source, 'utf8');
  const $ = load(html);
  const title = $('#activity-name').text().trim();
  const canonical = $('meta[property="og:url"]').attr('content');
  const get = (name) =>
    html.match(new RegExp(`var ${name}\\s*=\\s*["']([^"']+)`))?.[1];
  const timestamp = html.match(
    /\b(?:create_time|ct|CreateTime)\b["']?\s*[:=]\s*['"]?(\d{10})(?!\d)['"]?/i,
  )?.[1];
  if (
    canonical !== 'https://mp.weixin.qq.com/s/K_oKauPpwhSyavBWQXFMKw' ||
    Buffer.from(get('biz') || '', 'base64').toString() !== '3895431412' ||
    !title ||
    !timestamp ||
    !$('#js_content').text().trim()
  )
    throw new Error('HTML is not the real target article');
  if ($('img').length > 8) throw new Error('HTML exceeds 8 image test limit');
  const artifacts = artifactsApi.begin({
    migrations: path.join(server, 'prisma/migrations'),
  });
  const root = artifacts.audit;
  let prisma, failure;
  try {
    budget.preflight(artifacts.root, 256 * 1024 ** 2, 0);
    const input = path.join(root, 'input');
    await fs.mkdir(input);
    const articleUrl = new URL('https://mp.weixin.qq.com/s');
    for (const [key, value] of Object.entries({
      __biz: get('biz'),
      mid: get('mid'),
      idx: get('idx'),
      sn: get('sn'),
    }))
      articleUrl.searchParams.set(key, value);
    $('meta[property="og:url"]').attr('content', articleUrl.toString());
    await fs.writeFile(path.join(input, 'article.html'), $.html());
    await fs.writeFile(
      path.join(input, 'article.csv'),
      'title,url,time\n' +
        [title, articleUrl.toString(), timestamp].map(csvCell).join(',') +
        '\n',
    );
    prisma = new PrismaClient({
      datasources: {
        db: { url: `file:${artifacts.database.replace(/\\/g, '/')}` },
      },
    });
    artifacts.checkpoint?.();
    const collection = new CollectionService(prisma);
    const imported = await collection.importDirectory({
      directory: input,
      mpId: 'MP_WXS_3895431412',
      mpName: '妈妈部落畅聊阁',
    });
    const config = {
      get: (key) =>
        ({
          platform: { url: '' },
          feed: { updateDelayTime: 0, obsidianPath: path.join(root, 'vault') },
          database: { type: 'sqlite' },
        })[key],
    };
    const trpc = new TrpcService(prisma, config, {}, collection);
    const router = new TrpcRouter(trpc, prisma, config, {}, collection);
    const caller = router.appRouter.createCaller({
      errorMsg: null,
      isLocal: true,
    });
    const article = await prisma.article.findFirstOrThrow();
    const saved = await caller.article.saveToObsidian(article.id);
    artifacts.checkpoint?.();
    budget.preflight(artifacts.root, 0, 0);
    const markdown = await fs.readFile(saved.path, 'utf8');
    const attachments = [
      ...new Set(
        markdown.match(/image\/image_[a-f0-9]+\.(?:png|jpe?g|gif|webp)/g) || [],
      ),
    ];
    const images = await Promise.all(
      attachments.map(async (name) => {
        const bytes = await fs.readFile(
          path.join(path.dirname(saved.path), name),
        );
        const signature = bytes.subarray(0, 8).toString('hex');
        const validImage =
          signature.startsWith('ffd8ff') ||
          signature === '89504e470d0a1a0a' ||
          bytes.subarray(0, 3).toString() === 'GIF' ||
          (bytes.subarray(0, 4).toString() === 'RIFF' &&
            bytes.subarray(8, 12).toString() === 'WEBP');
        return { name, bytes: bytes.length, signature, validImage };
      }),
    );
    const rss = await new FeedsService(prisma, trpc, config).handleGenerateFeed(
      {
        id: 'MP_WXS_3895431412',
        type: 'rss',
        limit: 20,
        page: 1,
        mode: 'fulltext',
      },
    );
    const rssPath = path.join(root, 'target.rss');
    await fs.writeFile(rssPath, rss.content);
    const result = {
      scope:
        'real target retained HTML exported through real router in isolated SQLite; not complete collection',
      imported: imported.articles,
      title,
      publishTime: Number(timestamp),
      markdownPath: saved.path,
      markdownHasBody: markdown.includes('南模'),
      markdownShowsMissingFavorite: markdown.includes('| 收藏 | 未提供 |'),
      sourceImageNodes: $('#js_content img').length,
      localizedImages: images,
      rssPath,
      rssContainsBody: rss.content.includes('南模'),
      readCount: article.readCount,
      likeCount: article.likeCount,
    };
    await fs.writeFile(
      path.join(root, 'result.json'),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result, null, 2));
    if (
      !images.length ||
      images.some((image) => !image.validImage) ||
      !result.markdownHasBody ||
      !result.rssContainsBody
    )
      process.exitCode = 1;
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await prisma?.$disconnect();
      artifacts.checkpoint();
      // These paths exist only under this invocation's UUID audit directory.
      for (const name of ['input', 'vault', 'target.rss'])
        await fs.rm(path.join(root, name), { recursive: true, force: true });
    } finally {
      artifacts.finish(failure);
    }
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
