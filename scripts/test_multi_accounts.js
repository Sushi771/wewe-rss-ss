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
  const accounts = await prisma.account.findMany({
    where: { status: 1 },
  });

  if (accounts.length === 0) {
    console.log('No enabled accounts found');
    return;
  }

  const mpId = 'MP_WXS_3014778416'; // J家姐妹花
  const platformUrl = 'https://weread.965111.xyz';

  for (const account of accounts) {
    console.log(`--- Testing with account: ${account.id} ---`);
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
        break; // Found a working account
      }
    } catch (err) {
      console.error('Error with account:', account.id, err.message);
      if (err.response) {
        console.error('Status:', err.response.statusCode);
        console.error('Data:', err.response.body);
      }
    }
  }
}

main()
  .catch((e) => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
