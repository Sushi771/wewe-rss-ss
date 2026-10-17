import { createHash } from 'node:crypto';
import { Feed, PrismaClient } from '@prisma/client';
import type { BatchOutcome } from './wechat2rss-subscription-batches';
import { refreshFeedSourceDigest } from './refresh-occupancy-release';
import {
  discardAcceptedRefreshResponse,
  readRefreshResponseReceipt,
  refreshResponseContext,
  RefreshResponseContext,
} from './refresh-response-receipt';
import {
  incrementalWrite,
  assertIncrementalTransaction,
} from './incremental-write';

type Claim = {
  state: string;
  mp_id?: string;
  reserved_at: number;
  previous_at: number;
};
export type RefreshSubmissionTicket = {
  id: string;
  mpId: string;
  reservedAt: number;
  previousAt: number;
  channel: string | null;
  name: string;
  feedCreatedAt?: number;
  responseContext?: RefreshResponseContext;
};
const claimId = (batch: string, feed: string) => {
  if (!batch || batch.length > 256)
    throw new Error('REFRESH_DURABLE_CLAIM_REQUIRED');
  return createHash('sha256')
    .update(JSON.stringify([1, batch, feed]))
    .digest('hex');
};
function settled(claim?: Claim): BatchOutcome | undefined {
  if (!claim || ['prepared', 'not-sent'].includes(claim.state)) return;
  if (claim.state === 'accepted')
    return {
      state: 'waiting',
      accepted: true,
      submissionUnknown: false,
      stopBatch: false,
      message:
        'Durable accepted receipt retained; continue cache reads without resubmission.',
    };
  return {
    state: 'blocked',
    accepted: false,
    submissionUnknown: true,
    stopBatch: false,
    message:
      'Durable remote attempt has no confirmed result; automatic resubmission is prohibited.',
  };
}
export async function readRefreshSubmission(
  prisma: PrismaClient,
  batch: string,
  feed: string,
) {
  const rows = await prisma.$queryRawUnsafe<Claim[]>(
    'SELECT state,reserved_at,previous_at FROM refresh_submission_claims WHERE id=?',
    claimId(batch, feed),
  );
  return settled(rows[0]);
}
/** Read-only binding for an explicit disposition; it cannot infer acceptance. */
export async function unknownRefreshSource(
  prisma: PrismaClient,
  batch: string,
  feed: string,
  claimedAt: number,
  receiptAt: number,
) {
  const rows = await prisma.$queryRawUnsafe<Array<Claim>>(
    'SELECT state,mp_id,reserved_at,previous_at FROM refresh_submission_claims WHERE id=?',
    claimId(batch, feed),
  );
  const claim = rows[0],
    current = await prisma.feed.findUnique({ where: { id: feed } });
  if (
    !claim ||
    !['attempted', 'unknown'].includes(claim.state) ||
    claim.mp_id !== feed ||
    claim.reserved_at < Math.floor(claimedAt / 1000) ||
    claim.reserved_at * 1000 > receiptAt ||
    !current ||
    current.status !== 1 ||
    current.collectionChannel !== 'wechat2rss'
  )
    throw Error('UNKNOWN_RELEASE_SOURCE_UNPROVED');
  return refreshFeedSourceDigest(current);
}
export async function refreshSubmissionProof(
  prisma: PrismaClient,
  batch: string,
  feed: string,
) {
  const rows = await prisma.$queryRawUnsafe<Claim[]>(
    'SELECT state,mp_id,reserved_at,previous_at FROM refresh_submission_claims WHERE id=?',
    claimId(batch, feed),
  );
  const state = rows[0]?.state;
  if (!state) return;
  if (['attempted', 'unknown'].includes(state) && rows[0].mp_id === feed) {
    const current = await prisma.feed.findUnique({ where: { id: feed } });
    if (
      current?.status === 1 &&
      current.collectionChannel === 'wechat2rss' &&
      current.providerRefreshAttemptTime === rows[0].reserved_at
    ) {
      const responseContext = await refreshResponseContext(prisma);
      const ticket: RefreshSubmissionTicket = {
        id: claimId(batch, feed),
        mpId: feed,
        reservedAt: rows[0].reserved_at,
        previousAt: rows[0].previous_at,
        channel: current.collectionChannel,
        name: current.mpName,
        feedCreatedAt: current.createdAt.getTime(),
        responseContext,
      };
      if (await readRefreshResponseReceipt(responseContext, ticket)) {
        const repaired = await incrementalWrite(prisma, 4096, () =>
          prisma.$transaction(async (tx) => {
            await assertIncrementalTransaction(tx);
            const latest = await tx.feed.findUnique({ where: { id: feed } });
            if (
              !latest ||
              latest.status !== 1 ||
              latest.collectionChannel !== ticket.channel ||
              latest.mpName !== ticket.name ||
              latest.createdAt.getTime() !== ticket.feedCreatedAt ||
              latest.providerRefreshAttemptTime !== ticket.reservedAt ||
              !(await readRefreshResponseReceipt(responseContext, ticket))
            )
              return 0;
            return tx.$executeRaw`UPDATE refresh_submission_claims SET state='accepted',updated_at_ms=${Date.now()} WHERE id=${ticket.id} AND mp_id=${feed} AND reserved_at=${ticket.reservedAt} AND previous_at=${ticket.previousAt} AND state IN ('attempted','unknown')`;
          }),
        );
        if (repaired === 1) {
          await discardAcceptedRefreshResponse(ticket);
          return 'accepted' as const;
        }
        const latest = await prisma.$queryRawUnsafe<Claim[]>(
          'SELECT state,reserved_at,previous_at FROM refresh_submission_claims WHERE id=?',
          ticket.id,
        );
        return latest[0]?.state === 'accepted'
          ? ('accepted' as const)
          : ('unknown' as const);
      }
    }
  }
  return state === 'accepted'
    ? ('accepted' as const)
    : ['prepared', 'not-sent'].includes(state)
      ? ('not-submitted' as const)
      : ('unknown' as const);
}
export async function reserveRefreshSubmission(
  prisma: PrismaClient,
  feed: Feed,
  batch: string,
  now: number,
): Promise<{ ticket?: RefreshSubmissionTicket; outcome?: BatchOutcome }> {
  const id = claimId(batch, feed.id);
  const responseContext = await refreshResponseContext(prisma);
  return incrementalWrite(prisma, 4096, () =>
    prisma.$transaction(async (tx) => {
      await assertIncrementalTransaction(tx);
      const rows = await tx.$queryRawUnsafe<Claim[]>(
        'SELECT state,reserved_at,previous_at FROM refresh_submission_claims WHERE id=?',
        id,
      );
      const old = rows[0];
      const outcome = settled(old);
      if (outcome) return { outcome };
      if (old?.state === 'prepared') {
        const current = await tx.feed.findUnique({ where: { id: feed.id } });
        if (
          current?.providerRefreshAttemptTime !== old.reserved_at ||
          current.status !== 1 ||
          current.collectionChannel !== feed.collectionChannel
        )
          return {
            outcome: {
              state: 'blocked',
              accepted: false,
              submissionUnknown: false,
              stopBatch: false,
              message: 'Prepared reservation changed; no remote request sent.',
            },
          };
        return {
          ticket: {
            id,
            mpId: feed.id,
            reservedAt: old.reserved_at,
            previousAt: old.previous_at,
            channel: feed.collectionChannel,
            name: feed.mpName,
            feedCreatedAt: feed.createdAt?.getTime(),
            responseContext,
          },
        };
      }
      const reserved = await tx.feed.updateMany({
        where: {
          id: feed.id,
          status: 1,
          collectionChannel: feed.collectionChannel,
          providerRefreshAttemptTime: { lte: now - 900 },
        },
        data: { providerRefreshAttemptTime: now },
      });
      if (reserved.count !== 1)
        return {
          outcome: {
            state: 'skipped',
            accepted: false,
            submissionUnknown: false,
            stopBatch: false,
            message:
              'Subscription reservation/cooldown changed; update not sent.',
          },
        };
      if (old)
        await tx.$executeRaw`UPDATE refresh_submission_claims SET state='prepared',reserved_at=${now},previous_at=${feed.providerRefreshAttemptTime},updated_at_ms=${Date.now()} WHERE id=${id} AND state='not-sent'`;
      else
        await tx.$executeRaw`INSERT INTO refresh_submission_claims(id,mp_id,state,reserved_at,previous_at,updated_at_ms) VALUES(${id},${feed.id},'prepared',${now},${feed.providerRefreshAttemptTime},${Date.now()})`;
      return {
        ticket: {
          id,
          mpId: feed.id,
          reservedAt: now,
          previousAt: feed.providerRefreshAttemptTime,
          channel: feed.collectionChannel,
          name: feed.mpName,
          feedCreatedAt: feed.createdAt?.getTime(),
          responseContext,
        },
      };
    }),
  );
}
export async function beginRefreshSubmission(
  prisma: PrismaClient,
  ticket: RefreshSubmissionTicket,
) {
  if (
    ticket.responseContext &&
    (await readRefreshResponseReceipt(ticket.responseContext, ticket))
  )
    throw new Error('REFRESH_ALREADY_ATTEMPTED');
  const count = await incrementalWrite(prisma, 4096, () =>
    prisma.$transaction(async (tx) => {
      await assertIncrementalTransaction(tx);
      const feed = await tx.feed.findUnique({ where: { id: ticket.mpId } });
      if (
        !feed ||
        feed.status !== 1 ||
        feed.collectionChannel !== ticket.channel ||
        feed.mpName !== ticket.name ||
        (ticket.feedCreatedAt !== undefined &&
          feed.createdAt.getTime() !== ticket.feedCreatedAt) ||
        feed.providerRefreshAttemptTime !== ticket.reservedAt
      )
        throw new Error('REFRESH_PREPARATION_CHANGED');
      return tx.$executeRaw`UPDATE refresh_submission_claims SET state='attempted',updated_at_ms=${Date.now()} WHERE id=${ticket.id} AND state='prepared'`;
    }),
  );
  if (count !== 1) throw new Error('REFRESH_ALREADY_ATTEMPTED');
}
export async function finishRefreshSubmission(
  prisma: PrismaClient,
  ticket: RefreshSubmissionTicket,
  state: 'accepted' | 'unknown' | 'not-sent',
) {
  const count = await incrementalWrite(prisma, 4096, () =>
    prisma.$transaction(async (tx) => {
      await assertIncrementalTransaction(tx);
      const changed =
        await tx.$executeRaw`UPDATE refresh_submission_claims SET state=${state},updated_at_ms=${Date.now()} WHERE id=${ticket.id} AND state='attempted'`;
      if (changed === 1 && state === 'not-sent')
        await tx.feed.updateMany({
          where: {
            id: ticket.mpId,
            providerRefreshAttemptTime: ticket.reservedAt,
          },
          data: { providerRefreshAttemptTime: ticket.previousAt },
        });
      return changed;
    }),
  );
  if (count !== 1) throw new Error('REFRESH_RECEIPT_STATE_CHANGED');
  if (state === 'accepted') await discardAcceptedRefreshResponse(ticket);
}
export async function cancelRefreshPreparation(
  prisma: PrismaClient,
  ticket: RefreshSubmissionTicket,
) {
  await incrementalWrite(prisma, 4096, () =>
    prisma.$transaction(async (tx) => {
      await assertIncrementalTransaction(tx);
      const count =
        await tx.$executeRaw`UPDATE refresh_submission_claims SET state='not-sent',updated_at_ms=${Date.now()} WHERE id=${ticket.id} AND state='prepared'`;
      if (count === 1)
        await tx.feed.updateMany({
          where: {
            id: ticket.mpId,
            providerRefreshAttemptTime: ticket.reservedAt,
          },
          data: { providerRefreshAttemptTime: ticket.previousAt },
        });
    }),
  );
}
