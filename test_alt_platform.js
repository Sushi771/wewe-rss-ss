const { PrismaClient } = require('./apps/server/node_modules/@prisma/client');
const got = require('./apps/server/node_modules/got');
const path = require('path');

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: 'file:' + path.join(__dirname, 'apps', 'server', 'data', 'wewe-rss.db')
    }
  }
});

async function main() {
  const account = await prisma.account.findFirst({
    where: { status: 1 }
  });

  if (!account) {
    console.log('No enabled accounts found');
    return;
  }

  const mpId = 'MP_WXS_3014778416'; // J家姐妹花
  const altPlatformUrl = 'https://weread.111965.xyz';

  console.log(`--- Testing with Alt Platform: ${altPlatformUrl} ---`);
  try {
    const res = await got(`${altPlatformUrl}/api/v2/platform/mps/${mpId}/articles`, {
      headers: {
        xid: account.id,
        Authorization: `Bearer ${account.token}`
      },
      searchParams: { page: 1 },
      responseType: 'json',
      timeout: 10000
    });

    console.log('Platform Response count:', res.body.length);
    if (res.body.length > 0) {
      res.body.forEach(a => {
        console.log(`- [${new Date(a.publishTime * 1000).toLocaleDateString()}] ${a.title} (${a.id})`);
      });
    }
  } catch (err) {
    console.error('Alt Platform Error:', err.message);
  }
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
