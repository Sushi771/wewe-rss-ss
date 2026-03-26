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
  const platformUrl = 'https://weread.965111.xyz';

  console.log('Using account:', account.id);
  console.log('Fetching articles for:', mpId);

  try {
    const res = await got(`${platformUrl}/api/v2/platform/mps/${mpId}/articles`, {
      headers: {
        xid: account.id,
        Authorization: `Bearer ${account.token}`
      },
      searchParams: { page: 1 },
      responseType: 'json'
    });

    console.log('Platform Response count:', res.body.length);
    if (res.body.length > 0) {
      res.body.forEach(a => {
        console.log(`- [${new Date(a.publishTime * 1000).toLocaleDateString()}] ${a.title} (${a.id})`);
      });
    }
  } catch (err) {
    console.error('Platform Error:', err.message);
    if (err.response) {
      console.error('Status:', err.response.statusCode);
      console.error('Data:', err.response.body);
    }
  }
}

main()
  .catch(e => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
