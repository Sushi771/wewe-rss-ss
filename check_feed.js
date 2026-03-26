const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const feed = await prisma.feed.findFirst({
    where: { mpName: 'J家姐妹花' },
    include: {
      articles: {
        orderBy: { publishTime: 'desc' },
        take: 5
      }
    }
  });

  if (!feed) {
    console.log('Feed not found: J家姐妹花');
    return;
  }

  console.log('Feed:', JSON.stringify(feed, null, 2));
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
