const { PrismaClient } = require('../apps/server/node_modules/@prisma/client');
const path = require('path');

const prisma = new PrismaClient({
  datasources: {
    db: {
      url:
        'file:' +
        path.join(__dirname, '..', 'apps', 'server', 'data', 'wewe-rss.db'),
    },
  },
});

async function main() {
  const feed = await prisma.feed.findFirst({
    where: { mpName: 'J家姐妹花' },
    include: {
      articles: {
        orderBy: { publishTime: 'desc' },
        take: 10,
      },
    },
  });

  if (!feed) {
    console.log('Feed not found: J家姐妹花');
    const allFeeds = await prisma.feed.findMany({ select: { mpName: true } });
    console.log('Available feeds:', allFeeds.map((f) => f.mpName).join(', '));
    return;
  }

  console.log('Feed ID:', feed.id);
  console.log('Sync Time:', new Date(feed.syncTime * 1000).toLocaleString());
  console.log('Articles count in DB for this feed:', feed.articles.length);
  feed.articles.forEach((a) => {
    console.log(
      `- [${new Date(a.publishTime * 1000).toLocaleDateString()}] ${a.title} (${a.id})`,
    );
  });
}

main()
  .catch((e) => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
