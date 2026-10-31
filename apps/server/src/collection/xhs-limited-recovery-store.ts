import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  incrementalWrite,
  assertIncrementalWriteAdmission,
  assertIncrementalTransaction,
} from './incremental-write';
import { sqliteWrites } from './sqlite-write-coordinator';
import { XhsSubscriptionError } from './xhs-subscription-errors';

/** A single non-replayable attempt; never changes the historical risk row. */
export class XhsLimitedRecoveryStore {
  constructor(private readonly db: PrismaService) {}
  private write<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return incrementalWrite(this.db, 8192, () =>
      sqliteWrites.write(async () => {
        await assertIncrementalWriteAdmission();
        return this.db.$transaction(async (tx) => {
          await assertIncrementalTransaction(tx);
          return work(tx);
        });
      }),
    );
  }
  async arm(noteId: string, authorId: string) {
    if (
      !/^[a-zA-Z0-9_-]{1,128}$/.test(noteId) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(authorId)
    )
      throw new XhsSubscriptionError('XHS_NOTE_ID_INVALID');
    const owner = randomUUID();
    await this.write(async (tx) => {
      const risk = await tx.$queryRaw<
        Array<{ state: string; code: string | null }>
      >`
        SELECT state,code FROM xhs_source_risk WHERE id='source'`;
      if (
        risk.length !== 1 ||
        risk[0].state !== 'blocked' ||
        risk[0].code !== 'XHS_SOURCE_HISTORY_REVIEW_REQUIRED'
      )
        throw new XhsSubscriptionError('XHS_SOURCE_RISK_REVIEW_REQUIRED');
      const now = BigInt(Date.now());
      const inserted =
        await tx.$executeRaw`INSERT OR IGNORE INTO xhs_limited_recovery
        (id,note_id,author_id,owner,state,created_at,updated_at,expires_at)
        VALUES('single-round',${noteId},${authorId},${owner},'armed',${now},${now},${now + 600000n})`;
      if (inserted !== 1)
        throw new XhsSubscriptionError('XHS_SOURCE_RISK_REVIEW_REQUIRED');
    });
    return owner;
  }
  /** One explicit additional attempt, bound to the immutable original uncertain claim. */
  async armAppend(noteId: string, authorId: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(noteId) || !/^[a-zA-Z0-9_-]{1,128}$/.test(authorId))
      throw new XhsSubscriptionError('XHS_NOTE_ID_INVALID');
    const owner = randomUUID();
    await this.write(async (tx) => {
      const now = BigInt(Date.now());
      const inserted = await tx.$executeRaw`INSERT OR IGNORE INTO xhs_limited_recovery_append
        (id,note_id,author_id,owner,state,created_at,updated_at,expires_at)
        SELECT 'single-round',note_id,author_id,${owner},'armed',${now},${now},${now + 600000n}
        FROM xhs_limited_recovery WHERE id='single-round' AND state='unknown'
        AND note_id=${noteId} AND author_id=${authorId}
        AND EXISTS(SELECT 1 FROM xhs_source_risk WHERE id='source' AND state='blocked' AND code='XHS_SOURCE_HISTORY_REVIEW_REQUIRED')`;
      if (inserted !== 1) throw new XhsSubscriptionError('XHS_SOURCE_RISK_REVIEW_REQUIRED');
    });
    return owner;
  }
  /** Mark before dispatch. A crash after this point never permits replay. */
  async start(owner: string, noteId: string) {
    await this.write(async (tx) => {
      const changed =
        await tx.$executeRaw`UPDATE xhs_limited_recovery SET state='started',updated_at=${BigInt(Date.now())}
        WHERE id='single-round' AND owner=${owner} AND note_id=${noteId} AND state='armed' AND expires_at>${BigInt(Date.now())}
        AND EXISTS(SELECT 1 FROM xhs_source_risk WHERE id='source' AND state='blocked' AND code='XHS_SOURCE_HISTORY_REVIEW_REQUIRED')`;
      const appended = await tx.$executeRaw`UPDATE xhs_limited_recovery_append SET state='started',updated_at=${BigInt(Date.now())} WHERE id='single-round' AND owner=${owner} AND note_id=${noteId} AND state='armed' AND expires_at>${BigInt(Date.now())} AND EXISTS(SELECT 1 FROM xhs_source_risk WHERE id='source' AND state='blocked' AND code='XHS_SOURCE_HISTORY_REVIEW_REQUIRED')`;
      if (changed + appended !== 1)
        throw new XhsSubscriptionError('XHS_SOURCE_RISK_REVIEW_REQUIRED');
    });
  }
  async finish(owner: string, result: 'finished' | 'failed' | 'unknown') {
    await this.write(async (tx) => {
      const changed =
        await tx.$executeRaw`UPDATE xhs_limited_recovery SET state=${result},updated_at=${BigInt(Date.now())}
        WHERE id='single-round' AND owner=${owner} AND state IN ('armed','started')`;
      const appended = await tx.$executeRaw`UPDATE xhs_limited_recovery_append SET state=${result},updated_at=${BigInt(Date.now())} WHERE id='single-round' AND owner=${owner} AND state IN ('armed','started')`;
      if (changed + appended !== 1)
        throw new XhsSubscriptionError('XHS_SOURCE_RISK_REVIEW_REQUIRED');
    });
  }
  async assertActive(
    owner: string,
    tx: Pick<Prisma.TransactionClient, '$queryRaw'> = this.db,
  ) {
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT r.id FROM xhs_limited_recovery r
      WHERE r.id='single-round' AND r.owner=${owner} AND r.state='started' AND r.expires_at>${BigInt(Date.now())}
      AND EXISTS(SELECT 1 FROM xhs_source_risk WHERE id='source' AND state='blocked' AND code='XHS_SOURCE_HISTORY_REVIEW_REQUIRED')
      UNION ALL SELECT r.id FROM xhs_limited_recovery_append r WHERE r.id='single-round' AND r.owner=${owner} AND r.state='started' AND r.expires_at>${BigInt(Date.now())}
      AND EXISTS(SELECT 1 FROM xhs_source_risk WHERE id='source' AND state='blocked' AND code='XHS_SOURCE_HISTORY_REVIEW_REQUIRED')`;
    if (rows.length !== 1)
      throw new XhsSubscriptionError('XHS_SOURCE_RISK_REVIEW_REQUIRED');
  }
  async recordRefusal(owner: string, code: string) {
    const allowed = new Set([
      'XHS_SOURCE_AUTHENTICATION_BLOCKED',
      'XHS_SOURCE_VERIFICATION_BLOCKED',
      'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
      'XHS_SOURCE_PERMISSION_BLOCKED',
      'XHS_SOURCE_SIGNATURE_BLOCKED',
      'XHS_SOURCE_RATE_LIMIT_BLOCKED',
    ]);
    if (!allowed.has(code))
      throw new XhsSubscriptionError('XHS_SOURCE_RISK_REVIEW_REQUIRED');
    await this.write(async (tx) => {
      const changed =
        await tx.$executeRaw`UPDATE xhs_limited_recovery SET code=${code},state='failed',updated_at=${BigInt(Date.now())} WHERE id='single-round' AND owner=${owner} AND state='started'`;
      const appended = await tx.$executeRaw`UPDATE xhs_limited_recovery_append SET code=${code},state='failed',updated_at=${BigInt(Date.now())} WHERE id='single-round' AND owner=${owner} AND state='started'`;
      if (changed + appended !== 1)
        throw new XhsSubscriptionError('XHS_SOURCE_RISK_REVIEW_REQUIRED');
      await tx.$executeRaw`UPDATE xhs_source_risk SET code=${code},updated_at=${BigInt(Date.now())} WHERE id='source' AND state='blocked' AND code='XHS_SOURCE_HISTORY_REVIEW_REQUIRED'`;
    });
  }
}
