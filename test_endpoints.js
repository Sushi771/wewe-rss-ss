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

async function run() {
  const account = await prisma.account.findFirst({
    where: { status: 1 }
  });

  if (!account) {
    console.log('No account');
    return;
  }

  const accountsToTest = ['MP_WXS_3895431412', 'MP_WXS_3014778416'];

  for (const mpId of accountsToTest) {
    console.log('Testing: ' + mpId);
    
    // Add delay to test for silent rate-limiting
    await new Promise(r => setTimeout(r, 5000));

    for (const url of ['https://weread.111965.xyz', 'https://weread.965111.xyz']) {
      try {
        const res = await got(`${url}/api/v2/platform/mps/${mpId}/articles`, {
          headers: {
            xid: account.id,
            Authorization: `Bearer ${account.token}`
          },
          searchParams: { page: 1 },
          responseType: 'json'
        });
        console.log(url + ' count: ' + res.body.length);
      } catch(err) {
        console.log(url + ' ERR: ' + err.message);
      }
    }
  }
}

run().catch(console.error).finally(() => prisma.$disconnect());
