import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import type { RefreshSubmissionTicket } from './refresh-submission-claim';
import { Wechat2RssResponseError } from './providers/wechat2rss-response';

export type RefreshSubmissionFailure = {
  phase:
    | 'transport'
    | 'body'
    | 'json'
    | 'envelope'
    | 'proof'
    | 'sql-receipt'
    | 'unknown';
  code: string;
  httpStatus?: number;
  responseBytes?: number;
  responseLimitBytes?: number;
};
const codes = new Set([
  'WECHAT2RSS_RESPONSE_TOO_LARGE',
  'WECHAT2RSS_HTTP_STATUS',
  'WECHAT2RSS_RATE_LIMITED',
  'WECHAT2RSS_EMPTY_BODY',
  'WECHAT2RSS_INVALID_JSON',
  'WECHAT2RSS_INVALID_ENCODING',
  'WECHAT2RSS_REQUEST_TIMEOUT',
  'WECHAT2RSS_NETWORK_ERROR',
  'WECHAT2RSS_UPSTREAM_REJECTED',
  'WECHAT2RSS_ADD_RESPONSE_INVALID',
  'REFRESH_RESPONSE_RECEIPT_STORAGE_FAILED',
  'REFRESH_RESPONSE_RECEIPT_INVALID',
  'REFRESH_RECEIPT_SQL_FAILED',
  'REFRESH_SUBMISSION_UNKNOWN',
]);
export function validRefreshSubmissionFailure(
  value: unknown,
): value is RefreshSubmissionFailure {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as RefreshSubmissionFailure;
  return (
    Object.keys(v).every((k) =>
      [
        'phase',
        'code',
        'httpStatus',
        'responseBytes',
        'responseLimitBytes',
      ].includes(k),
    ) &&
    [
      'transport',
      'body',
      'json',
      'envelope',
      'proof',
      'sql-receipt',
      'unknown',
    ].includes(v.phase) &&
    codes.has(v.code) &&
    [v.httpStatus, v.responseBytes, v.responseLimitBytes].every(
      (n) =>
        n === undefined ||
        (Number.isSafeInteger(n) && n >= 0 && n <= 1024 ** 3),
    )
  );
}
export class RefreshSubmissionError extends Error {
  constructor(readonly failure: RefreshSubmissionFailure) {
    super(failure.code);
    this.name = 'RefreshSubmissionError';
  }
}
/** Only fixed classifications and bounded numbers cross the durable boundary. */
export function refreshSubmissionFailure(
  error: unknown,
  fallback: RefreshSubmissionFailure['phase'] = 'unknown',
): RefreshSubmissionFailure {
  if (
    error instanceof RefreshSubmissionError &&
    validRefreshSubmissionFailure(error.failure)
  )
    return error.failure;
  if (error instanceof Wechat2RssResponseError) {
    const failure: RefreshSubmissionFailure = {
      phase:
        error.phase === 'body'
          ? 'body'
          : error.phase === 'json'
            ? 'json'
            : 'transport',
      code: error.message,
      httpStatus: error.httpStatus,
      responseBytes: error.responseBytes,
      responseLimitBytes: error.responseLimitBytes,
    };
    if (validRefreshSubmissionFailure(failure)) return failure;
  }
  const code = error instanceof Error ? error.message : '';
  if (
    [
      'WECHAT2RSS_UPSTREAM_REJECTED',
      'WECHAT2RSS_ADD_RESPONSE_INVALID',
    ].includes(code)
  )
    return { phase: 'envelope', code, httpStatus: 200 };
  if (codes.has(code))
    return {
      phase: fallback,
      code,
      ...(code === 'WECHAT2RSS_RATE_LIMITED' ? { httpStatus: 429 } : {}),
    };
  return {
    phase: fallback,
    code:
      fallback === 'proof'
        ? 'REFRESH_RESPONSE_RECEIPT_STORAGE_FAILED'
        : fallback === 'sql-receipt'
          ? 'REFRESH_RECEIPT_SQL_FAILED'
          : 'REFRESH_SUBMISSION_UNKNOWN',
  };
}
export type ValidatedRefreshResponse = {
  version: 1;
  httpStatus: 200;
  receivedAt: number;
  responseDigest: string;
};
export type RefreshResponseContext = {
  database: string;
  databaseIdentity: string;
  instance: string;
};
const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
function validResponse(
  response: ValidatedRefreshResponse,
  ticket: RefreshSubmissionTicket,
) {
  return (
    !!response &&
    Object.keys(response).sort().join(',') ===
      'httpStatus,receivedAt,responseDigest,version' &&
    response.version === 1 &&
    response.httpStatus === 200 &&
    /^[a-f0-9]{64}$/.test(response.responseDigest) &&
    Number.isSafeInteger(response.receivedAt) &&
    response.receivedAt >= ticket.reservedAt * 1000 &&
    response.receivedAt <= Date.now()
  );
}
const instance = () =>
  digest([
    process.env.WECHAT2RSS_BASE_URL || '',
    process.env.WECHAT2RSS_TOKEN || '',
  ]);
export async function refreshResponseContext(
  prisma: Pick<PrismaClient, '$queryRawUnsafe'>,
): Promise<RefreshResponseContext> {
  const files = await prisma.$queryRawUnsafe<
    Array<{ name: string; file: string }>
  >('PRAGMA database_list');
  const main = files.find((file) => file.name === 'main');
  if (!main?.file) throw new Error('REFRESH_RESPONSE_RECEIPT_INVALID');
  const database = await fs.realpath(main.file);
  const stat = await fs.stat(database, { bigint: true });
  return {
    database,
    databaseIdentity: `${stat.dev}/${stat.ino}`,
    instance: instance(),
  };
}
const binding = (
  context: RefreshResponseContext,
  ticket: RefreshSubmissionTicket,
) => ({
  version: 1,
  databaseIdentity: context.databaseIdentity,
  instance: context.instance,
  claimId: ticket.id,
  feedId: ticket.mpId,
  reservedAt: ticket.reservedAt,
  previousAt: ticket.previousAt,
  channel: ticket.channel,
  nameDigest: digest(ticket.name),
  feedCreatedAt: ticket.feedCreatedAt,
});
async function location(
  context: RefreshResponseContext,
  id: string,
  create: boolean,
) {
  if (!/^[a-f0-9]{64}$/.test(id) || context.instance !== instance())
    throw new Error('REFRESH_RESPONSE_RECEIPT_INVALID');
  const stat = await fs.stat(context.database, { bigint: true });
  if (`${stat.dev}/${stat.ino}` !== context.databaseIdentity)
    throw new Error('REFRESH_RESPONSE_RECEIPT_INVALID');
  const directory = path.join(
    path.dirname(context.database),
    '.wechat2rss-refresh-responses',
  );
  if (create) await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await fs.realpath(directory)) !== directory)
    throw new Error('REFRESH_RESPONSE_RECEIPT_INVALID');
  return path.join(directory, id + '.json');
}
export async function readRefreshResponseReceipt(
  context: RefreshResponseContext,
  ticket: RefreshSubmissionTicket,
): Promise<boolean> {
  try {
    const file = await location(context, ticket.id, false);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
      throw new Error('REFRESH_RESPONSE_RECEIPT_INVALID');
    const raw = JSON.parse(await fs.readFile(file, 'utf8'));
    const expected = binding(context, ticket);
    const { response, checksum, ...actual } = raw;
    if (
      JSON.stringify(actual) !== JSON.stringify(expected) ||
      !validResponse(response, ticket) ||
      checksum !== digest({ ...actual, response })
    )
      throw new Error('REFRESH_RESPONSE_RECEIPT_INVALID');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new RefreshSubmissionError({
      phase: 'proof',
      code: 'REFRESH_RESPONSE_RECEIPT_INVALID',
    });
  }
}
/** An immutable proof becomes visible only after its complete contents fsync.
 * It records a validated response, never HTTP200 alone or a cache/check timestamp. */
export async function saveRefreshResponseReceipt(
  ticket: RefreshSubmissionTicket,
  response: ValidatedRefreshResponse,
) {
  const context = ticket.responseContext;
  if (!context || !validResponse(response, ticket))
    throw new RefreshSubmissionError({
      phase: 'proof',
      code: 'REFRESH_RESPONSE_RECEIPT_INVALID',
    });
  let temporary: string | undefined;
  try {
    const file = await location(context, ticket.id, true);
    const payload = { ...binding(context, ticket), response };
    temporary = file + '.' + randomUUID() + '.tmp';
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(
        JSON.stringify({ ...payload, checksum: digest(payload) }),
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.link(temporary, file);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'EEXIST' ||
        !(await readRefreshResponseReceipt(context, ticket))
      )
        throw error;
    }
    if (!(await readRefreshResponseReceipt(context, ticket)))
      throw new Error('REFRESH_RESPONSE_RECEIPT_INVALID');
  } catch (error) {
    throw new RefreshSubmissionError(refreshSubmissionFailure(error, 'proof'));
  } finally {
    if (temporary) await fs.unlink(temporary).catch(() => undefined);
  }
}

/** The strict SQL accepted receipt is authoritative. Remove only its verified
 * duplicate proof; failed cleanup never changes an accepted request to unknown. */
export async function discardAcceptedRefreshResponse(
  ticket: RefreshSubmissionTicket,
) {
  if (!ticket.responseContext) return;
  try {
    if (await readRefreshResponseReceipt(ticket.responseContext, ticket))
      await fs.unlink(await location(ticket.responseContext, ticket.id, false));
  } catch {
    console.warn('[REFRESH_RESPONSE_PROOF_CLEANUP_PENDING]');
  }
}
