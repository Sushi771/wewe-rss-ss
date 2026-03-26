const { PrismaClient } = require('./apps/server/node_modules/@prisma/client');

const prisma = new PrismaClient({
    datasources: {
        db: {
            url: 'file:../../data/wewe-rss.db'
        }
    }
});

async function main() {
    const accounts = await prisma.account.findMany();
    console.log('========= ACCOUNTS =========');
    console.log(JSON.stringify(accounts, null, 2));

    const feeds = await prisma.feed.findMany();
    console.log('========= FEEDS =========');
    console.log(JSON.stringify(feeds, null, 2));

    const articlesCount = await prisma.article.count();
    console.log('========= ARTICLES COUNT =========');
    console.log(articlesCount);
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
