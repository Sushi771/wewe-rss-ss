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

  const url = 'https://mp.weixin.qq.com/s/ga8QSQV1S8NBlz1pDn5RgSklw'; // The latest article I saw in DB
  const platformUrl = 'https://weread.965111.xyz';

  console.log(`--- Testing wxs2mp with account: ${account.id} ---`);
  try {
    const res = await got.post(`${platformUrl}/api/v2/platform/wxs2mp`, {
      json: { url },
      headers: {
        xid: account.id,
        Authorization: `Bearer ${account.token}`
      },
      responseType: 'json',
      timeout: 10000
    });

    console.log('wxs2mp Response:', JSON.stringify(res.body, null, 2));
  } catch (err) {
    console.error('wxs2mp Error:', err.message);
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
