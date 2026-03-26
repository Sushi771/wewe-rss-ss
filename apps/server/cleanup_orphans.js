const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const articles = await prisma.article.findMany({
    select: {
      id: true,
      mpId: true,
      feed: {
        select: {
          id: true,
        },
      },
    },
  });

  const orphans = articles.filter((a) => !a.feed);
  console.log(`Found ${orphans.length} orphaned articles.`);

  if (orphans.length > 0) {
    const ids = orphans.map((a) => a.id);
    const result = await prisma.article.deleteMany({
      where: {
        id: {
          in: ids,
        },
      },
    });
    console.log(`Deleted ${result.count} orphaned articles.`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
