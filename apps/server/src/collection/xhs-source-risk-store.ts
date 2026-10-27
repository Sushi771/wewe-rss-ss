import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  incrementalWrite,
  assertIncrementalWriteAdmission,
  assertIncrementalTransaction,
} from './incremental-write';
import { sqliteWrites } from './sqlite-write-coordinator';
import { XhsSubscriptionError } from './xhs-subscription-errors';

const UNAVAILABLE = 'XHS_SOURCE_RISK_UNAVAILABLE';
const REVIEW = 'XHS_SOURCE_RISK_REVIEW_REQUIRED';
const allowed = new Set([
  'XHS_SOURCE_AUTHENTICATION_BLOCKED',
  'XHS_SOURCE_VERIFICATION_BLOCKED',
  'XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED',
  'XHS_SOURCE_PERMISSION_BLOCKED',
  'XHS_SOURCE_SIGNATURE_BLOCKED',
  'XHS_SOURCE_RATE_LIMIT_BLOCKED',
  'XHS_SOURCE_HISTORY_REVIEW_REQUIRED',
  REVIEW,
]);
type Row = {
  state: string;
  code: string | null;
  owner: string | null;
  http_status: number | null;
  endpoint: string | null;
};
export class XhsSourceRiskStore {
  constructor(private readonly db: PrismaService) {}
  private async rows(db: Pick<Prisma.TransactionClient, '$queryRaw'>) {
    const rows = await db.$queryRaw<
      Row[]
    >`SELECT state,code,owner,http_status,endpoint FROM xhs_source_risk WHERE id='source'`;
    if (
      rows.length !== 1 ||
      !['clear', 'pending', 'blocked'].includes(rows[0].state) ||
      (rows[0].state === 'clear' &&
        (rows[0].code !== null ||
          rows[0].owner !== null ||
          rows[0].http_status !== null ||
          rows[0].endpoint !== null)) ||
      (rows[0].state === 'pending' &&
        (rows[0].code !== null ||
          !rows[0].owner ||
          !/^[a-f0-9-]{36}$/.test(rows[0].owner) ||
          rows[0].http_status !== null ||
          rows[0].endpoint !== null)) ||
      (rows[0].state === 'blocked' && rows[0].owner !== null) ||
      (rows[0].state === 'blocked' &&
        rows[0].http_status !== null &&
        ![401, 403, 406, 429, 461, 471].includes(rows[0].http_status)) ||
      (rows[0].state === 'blocked' &&
        rows[0].endpoint !== null &&
        !['profile', 'list', 'detail', 'comments', 'replies'].includes(
          rows[0].endpoint,
        )) ||
      (rows[0].state === 'blocked' &&
        (!rows[0].code || !allowed.has(rows[0].code)))
    )
      throw new XhsSubscriptionError(UNAVAILABLE);
    return rows[0];
  }
  async read() {
    try {
      const row = await this.rows(this.db);
      return row.state === 'clear'
        ? undefined
        : row.state === 'pending'
          ? REVIEW
          : row.code!;
    } catch {
      throw new XhsSubscriptionError(UNAVAILABLE);
    }
  }
  private async write<T>(run: (tx: Prisma.TransactionClient) => Promise<T>) {
    return incrementalWrite(this.db, 8192, () =>
      sqliteWrites.write(async () => {
        await assertIncrementalWriteAdmission();
        return this.db.$transaction(async (tx) => {
          await assertIncrementalTransaction(tx);
          return run(tx);
        });
      }),
    );
  }
  async begin() {
    const owner = randomUUID();
    try {
      await this.write(async (tx) => {
        const row = await this.rows(tx);
        if (row.state !== 'clear')
          throw new XhsSubscriptionError(
            row.state === 'pending' ? REVIEW : row.code!,
          );
        const changed =
          await tx.$executeRaw`UPDATE xhs_source_risk SET state='pending',owner=${owner},updated_at=${BigInt(Date.now())} WHERE id='source' AND state='clear'`;
        if (changed !== 1) throw new XhsSubscriptionError(REVIEW);
      });
      return owner;
    } catch (error) {
      if (error instanceof XhsSubscriptionError) throw error;
      throw new XhsSubscriptionError(UNAVAILABLE);
    }
  }
  async finish(
    owner: string,
    code?: string,
    evidence?: { status?: number; endpoint?: string },
  ) {
    if (code && !allowed.has(code)) code = REVIEW;
    const status =
      code &&
      evidence?.status &&
      [401, 403, 406, 429, 461, 471].includes(evidence.status)
        ? evidence.status
        : null;
    const endpoint =
      code &&
      evidence?.endpoint &&
      ['profile', 'list', 'detail', 'comments', 'replies'].includes(
        evidence.endpoint,
      )
        ? evidence.endpoint
        : null;
    try {
      const changed = await this.write(
        (tx) =>
          tx.$executeRaw`UPDATE xhs_source_risk SET state=${code ? 'blocked' : 'clear'},code=${code ?? null},owner=NULL,http_status=${status},endpoint=${endpoint},updated_at=${BigInt(Date.now())} WHERE id='source' AND state='pending' AND owner=${owner}`,
      );
      if (changed !== 1) throw Error();
    } catch {
      throw new XhsSubscriptionError(UNAVAILABLE);
    }
  }
}
