const { PrismaClient } = require('../apps/server/node_modules/@prisma/client');
const got = require('../apps/server/node_modules/got');
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
  const account = await prisma.account.findFirst({
    where: { status: 1 },
  });

  if (!account) {
    console.log('No enabled accounts found');
    return;
  }

  // Find another feed that is not J家姐妹花
  const otherFeed = await prisma.feed.findFirst({
    where: { NOT: { mpName: 'J家姐妹花' } },
  });

  if (!otherFeed) {
    console.log('No other feeds found');
    return;
  }

  const mpId = otherFeed.id;
  const platformUrl = 'https://weread.965111.xyz';

  console.log(`--- Testing with other feed: ${otherFeed.mpName} (${mpId}) ---`);
  try {
    const res = await got(
      `${platformUrl}/api/v2/platform/mps/${mpId}/articles`,
      {
        headers: {
          xid: account.id,
          Authorization: `Bearer ${account.token}`,
        },
        searchParams: { page: 1 },
        responseType: 'json',
        timeout: 10000,
      },
    );

    console.log('Platform Response count:', res.body.length);
    if (res.body.length > 0) {
      console.log('Latest Article:', res.body[0].title);
    }
  } catch (err) {
    console.error('Platform Error:', err.message);
  }
}

main()
  .catch((e) => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
