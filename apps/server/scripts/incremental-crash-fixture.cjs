// Isolated synthetic crash harness. Invoked only by incremental-refresh.spec.ts.
const path = require('node:path');
const fs = require('node:fs');
const server = path.resolve(__dirname, '..');
require('ts-node').register({
  project: path.join(server, 'tsconfig.json'),
  transpileOnly: true,
});
require('tsconfig-paths').register({
  baseUrl: server,
  paths: {
    '@server/*': ['src/*'],
    '@wewe-rss/shared': [
      path.resolve(server, '../../packages/shared/src/index.ts'),
    ],
  },
});
const { PrismaClient } = require('@prisma/client');
const {
  CollectionService,
} = require('../src/collection/collection.service.ts');
const { TrpcService } = require('../src/trpc/trpc.service.ts');
const registry = require('../src/collection/provider-registry.ts');
const [stage, database, counter, pageFile] = process.argv.slice(2);
const page = JSON.parse(fs.readFileSync(pageFile, 'utf8'));
const never = () => new Promise(() => {});
const barrier = async (label) => {
  process.send({ barrier: label });
  await never();
};
const prisma = new PrismaClient({
  datasources: { db: { url: 'file:' + database } },
});
async function main() {
  if (stage.startsWith('cache-')) {
    const transaction = prisma.$transaction.bind(prisma);
    prisma.$transaction = async (fn, options) => {
      const result = await transaction(async (tx) => {
        const value = await fn(tx);
        if (stage === 'cache-precommit') await barrier(stage);
        return value;
      }, options);
      if (stage === 'cache-postcommit') await barrier(stage);
      return result;
    };
    await new CollectionService(prisma).collectWechat2RssRecent({
      mpId: 'MP_WXS_1234567890',
      mpName: 'fixture',
      trigger: 'scheduled',
      cachedPage: page,
      fetchMedia: false,
    });
  } else {
    registry.wechat2RssProvider = () => ({
      checkAccountStatus: async () => ({ available: true, challenged: false }),
      prepareRefreshSubscription:
        async (_id, _automatic, accepted) => async () => {
          if (stage === 'remote-attempted') await barrier(stage);
          fs.appendFileSync(counter, 'request\n');
          if (stage === 'remote-response') await barrier(stage);
          await accepted?.({
            version: 1,
            httpStatus: 200,
            receivedAt: Date.now(),
            responseDigest: 'a'.repeat(64),
          });
          if (stage === 'remote-validated-response') await barrier(stage);
        },
      fetchArticles: async () => page,
    });
    const trpc = new TrpcService(
      prisma,
      { get: () => ({ url: '', updateDelayTime: 0 }) },
      {},
      new CollectionService(prisma),
    );
    const batches = trpc.subscriptionBatches;
    const persist = batches.persistWrite.bind(batches);
    batches.persistWrite = async (record) => {
      if (stage === 'remote-accepted' && record.items.some((x) => x.accepted))
        await barrier(stage);
      return persist(record);
    };
    await batches.enqueueRefresh(['MP_WXS_1234567890'], 'f'.repeat(64));
    await batches.runDue();
  }
  throw new Error('Expected crash barrier not reached');
}
main().catch((error) => {
  process.send?.({ error: String(error.message) });
  process.exitCode = 1;
});
