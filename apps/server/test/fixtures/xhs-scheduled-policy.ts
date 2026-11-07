import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { XhsSubscriptionRuntime } from '../../src/collection/xhs-subscription-runtime';
import { assertLegacyXhsSourceReady } from '../../src/collection/xhs-legacy-source-fence';
import {
  prepareScheduledPolicy,
  confirmScheduledPolicy,
} from '../../src/collection/xhs-scheduled-review-scope';

/** Synthetic SQLite/transport fixtures only. No production snapshot is created.
 * The real policy, idle checks, finite caps, request ledger and risk CAS remain.
 */
export async function approveSyntheticScheduledPolicy(
  db: PrismaClient,
  runtime: XhsSubscriptionRuntime,
  creatorIds: string[],
) {
  const fillers: string[] = [];
  while (creatorIds.length + fillers.length < 3) {
    const id = 'zz-policy-' + randomUUID();
    await db.xhsCreator.create({
      data: {
        id,
        enabled: true,
        externalAuthorId: 'author-' + id,
        profileUrl: 'https://www.xiaohongshu.com/user/profile/author-' + id,
        displayName: 'Synthetic policy-only creator',
      },
    });
    fillers.push(id);
  }
  const input = {
    creatorIds: [...creatorIds, ...fillers],
    maxRequests: 100,
    phaseLimits: { profile: 10, list: 20, detail: 50, media: 50 },
  };
  runtime.bindFullHistoryWriter((work) => db.$transaction((tx) => work(tx)));
  runtime.bindFullHistoryReader((work) => db.$transaction((tx) => work(tx)));
  runtime.bindFullHistoryLegacyGuard(() => assertLegacyXhsSourceReady(db));
  const policy = await db.$transaction(async (tx) => {
    const plan = await prepareScheduledPolicy(tx, input);
    return confirmScheduledPolicy(
      tx,
      input,
      plan.digest,
      {
        assertQuiescent: async () => {
          const active = await tx.$queryRawUnsafe<any[]>(
            "SELECT id FROM xhs_subscription_tasks WHERE state IN ('queued','running') UNION ALL SELECT id FROM xhs_whole_creator_jobs WHERE state IN ('queued','running') LIMIT 1",
          );
          if (active.length) throw Error('SYNTHETIC_POLICY_REQUIRES_IDLE');
        },
        verifyBackup: async (stateDigest) => {
          if (stateDigest !== plan.digest)
            throw Error('SYNTHETIC_SNAPSHOT_BINDING_CHANGED');
          return createHash('sha256')
            .update('synthetic-metadata-witness:' + stateDigest)
            .digest('hex');
        },
      },
      BigInt(Date.now()),
    );
  });
  return {
    ...policy,
    fillerCreatorIds: fillers,
    cleanup: () => db.xhsCreator.deleteMany({ where: { id: { in: fillers } } }),
  };
}
