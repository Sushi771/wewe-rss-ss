const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
    datasources: {
        db: {
            url: 'file:./data/wewe-rss.db'
        }
    }
});
async function main() {
    console.log('====== Accounts ======');
    console.log(await prisma.account.findMany());
    console.log('====== Feeds ======');
    console.log(await prisma.feed.findMany());
}
main().catch(console.error).finally(() => prisma.$disconnect());
