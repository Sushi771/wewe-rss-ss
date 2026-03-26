const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const prisma = new PrismaClient({
    datasources: { db: { url: 'file:./data/wewe-rss.db' } }
});

async function main() {
    const accounts = await prisma.account.findMany();
    const account = accounts[0];
    console.log('Account Token Length:', account.token.length);

    const mpId = 'MP_WXS_3895431412';
    try {
        const res = await axios.get(`https://weread.111965.xyz/api/v2/platform/mps/${mpId}/articles?page=1`, {
            headers: {
                xid: account.id,
                Authorization: `Bearer ${account.token}`
            }
        });
        console.log('API Response:', res.status, res.data);
    } catch (err) {
        console.error('API Error:', err.response?.data || err.message);
    }
}
main().catch(console.error).finally(() => prisma.$disconnect());
