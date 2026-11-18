import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { get, IncomingMessage } from 'node:http';
import * as path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import {
  managedWechatActiveRefresh,
  readChannelState,
  taskDatabaseFor,
  withChannelLease,
} from './channel-task-control';
import { readLocalWechat2RssSchedule } from './local-cache-reader';
import {
  beginRefreshSubmission,
  finishRefreshSubmission,
  readRefreshSubmission,
  reserveRefreshSubmission,
} from './refresh-submission-claim';
import { saveRefreshResponseReceipt } from './refresh-response-receipt';
import { databaseWritesAllowed } from '../startup-audit';

const spacing = 30_000;
const targetSpacing = 6 * 3_600_000;
const nativeWindow = 45 * 60_000;
type Stop = 401 | 403 | 429 | 'account';
type State = {
  lastAt: number;
  inFlight: boolean;
  lastScheduledAt?: number;
  stop?: Stop;
};
class Restricted extends Error {
  constructor(readonly reason: Stop) {
    super('WECHAT_ACTIVE_RESTRICTED');
  }
}

async function state(file: string): Promise<State> {
  try {
    const info = await fs.lstat(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      info.size > 512
    )
      throw Error('WECHAT_ACTIVE_STATE_INVALID');
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (
      !Number.isSafeInteger(value.lastAt) ||
      value.lastAt < 0 ||
      typeof value.inFlight !== 'boolean' ||
      (value.lastScheduledAt !== undefined &&
        (!Number.isSafeInteger(value.lastScheduledAt) ||
          value.lastScheduledAt < 0 ||
          value.lastScheduledAt > value.lastAt)) ||
      (value.stop !== undefined &&
        ![401, 403, 429, 'account'].includes(value.stop))
    )
      throw Error('WECHAT_ACTIVE_STATE_INVALID');
    return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { lastAt: 0, inFlight: false };
    throw error;
  }
}

async function save(file: string, value: State) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
  }
}

function providerEndpoint() {
  const base = new URL(process.env.WECHAT2RSS_BASE_URL || '');
  const token = process.env.WECHAT2RSS_TOKEN;
  if (
    process.env.WECHAT2RSS_ENABLED !== '1' ||
    !token ||
    token.length > 512 ||
    base.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost'].includes(base.hostname) ||
    !base.port ||
    base.pathname !== '/' ||
    base.search ||
    base.hash ||
    base.username ||
    base.password
  )
    throw Error('WECHAT_ACTIVE_LOCAL_PROVIDER_REQUIRED');
  return (endpoint: '/login/list' | `/add/${string}`) => {
    const url = new URL(endpoint, 'http://127.0.0.1:' + base.port);
    url.searchParams.set('k', token);
    return url;
  };
}

async function request(url: URL) {
  // /add is a mutation despite the HTTP method. Use one fresh connection,
  // with no redirect following or automatic retry.
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    get(url, { agent: false, signal: AbortSignal.timeout(10000) }, resolve).on(
      'error',
      reject,
    );
  });
  const code = response.statusCode;
  if (code !== 200) {
    response.destroy();
    if (code === 401 || code === 403 || code === 429)
      throw new Restricted(code);
    throw Error('WECHAT_ACTIVE_RESPONSE_UNAVAILABLE');
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response) {
    length += chunk.length;
    if (length > 65536) {
      response.destroy();
      throw Error('WECHAT_ACTIVE_RESPONSE_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (raw?.err !== '') {
    if (
      raw?.code === 429 ||
      raw?.status === 429 ||
      (typeof raw?.err === 'string' &&
        /too many requests|rate limit|风控|限频/i.test(raw.err))
    )
      throw new Restricted(429);
    throw Error('WECHAT_ACTIVE_RESPONSE_UNVERIFIED');
  }
  return raw.data as unknown;
}

export type ManagedWechatRefreshState =
  | 'accepted'
  | 'unknown'
  | 'unavailable'
  | 'retained-unknown'
  | 'paused'
  | 'restricted'
  | 'source-cooldown'
  | 'target-cooldown'
  | 'scheduled-closed';

/** Preserve the original shared gate and all older task evidence. Admission is
 * limited to this new target, and genuine account restrictions are shared. */
export async function managedWechatRefresh(
  db: PrismaClient,
  id: string,
  scheduled?: { key: string; due: number },
): Promise<ManagedWechatRefreshState> {
  if (!managedWechatActiveRefresh() || !databaseWritesAllowed())
    return 'paused';
  if (!/^MP_WXS_\d{5,15}$/.test(id)) return 'unavailable';
  const database = await taskDatabaseFor(db);
  return withChannelLease(
    'wechat',
    async () => {
      if (
        !managedWechatActiveRefresh() ||
        !databaseWritesAllowed() ||
        (await readChannelState('wechat', database)).paused
      )
        return 'paused';
      const [legacy] = await db.$queryRaw<
        Array<{ state: string; status: number | null }>
      >`
      SELECT state,status FROM Wechat2RssSourceGate WHERE id=1
    `;
      if (
        !legacy ||
        !['idle', 'pending'].includes(legacy.state) ||
        legacy.status !== null
      )
        return 'restricted';
      const file = path.join(
        path.dirname(database),
        '.collection-channel-control',
        'wechat',
        'active-refresh-v1.json',
      );
      const history = await state(file);
      if (history.stop || history.inFlight) return 'restricted';
      const now = Date.now();
      if (
        scheduled &&
        (!/^[a-f0-9]{64}$/.test(scheduled.key) ||
          !Number.isSafeInteger(scheduled.due) ||
          scheduled.due > now ||
          scheduled.due <= (history.lastScheduledAt ?? 0) ||
          now - scheduled.due > 15 * 60_000)
      )
        return 'scheduled-closed';
      const feed = await db.feed.findUnique({ where: { id } });
      if (!feed || feed.status !== 1 || feed.collectionChannel !== 'wechat2rss')
        return 'unavailable';
      const unknown = await db.$queryRaw<unknown[]>`
      SELECT 1 FROM refresh_submission_claims
      WHERE mp_id=${id} AND state IN ('attempted','unknown') LIMIT 1
    `;
      if (unknown.length) return 'retained-unknown';
      const round = scheduled?.key ?? randomUUID();
      if (await readRefreshSubmission(db, round, id)) return 'target-cooldown';
      if (now - history.lastAt < spacing) return 'source-cooldown';
      let target: ReturnType<typeof readLocalWechat2RssSchedule>;
      try {
        target = readLocalWechat2RssSchedule(id, feed.mpName);
      } catch {
        return 'unavailable';
      }
      if (
        now - target.last < targetSpacing ||
        target.next - now < nativeWindow ||
        now - feed.providerRefreshAttemptTime * 1000 < targetSpacing
      )
        return 'target-cooldown';
      const endpoint = providerEndpoint();
      const admitted = {
        lastAt: now,
        lastScheduledAt: scheduled?.due ?? history.lastScheduledAt,
      };
      await save(file, { ...admitted, inFlight: true });
      let stop: Stop | undefined;
      let attempted = false;
      try {
        const accounts = await request(endpoint('/login/list'));
        if (
          !Array.isArray(accounts) ||
          !accounts.length ||
          !accounts.every(
            (account) => account && account.needCheck === false,
          ) ||
          !accounts.some((account) => account.available === true)
        )
          throw new Restricted('account');
        const reserved = await reserveRefreshSubmission(
          db,
          feed,
          round,
          Math.floor(now / 1000),
        );
        if (!reserved.ticket) return 'target-cooldown';
        const ticket = reserved.ticket;
        await beginRefreshSubmission(db, ticket);
        attempted = true;
        try {
          const data = await request(endpoint(`/add/${id.slice(7)}`));
          if (typeof data !== 'string')
            throw Error('WECHAT_ACTIVE_RESPONSE_UNVERIFIED');
          const link = new URL(data, 'http://127.0.0.1');
          if (
            !['http:', 'https:'].includes(link.protocol) ||
            link.username ||
            link.password ||
            !['.json', '.xml'].some(
              (ext) => link.pathname === target.feedPath + ext,
            )
          )
            throw Error('WECHAT_ACTIVE_TARGET_UNVERIFIED');
          await saveRefreshResponseReceipt(ticket, {
            version: 1,
            httpStatus: 200,
            receivedAt: Date.now(),
            responseDigest: createHash('sha256').update(data).digest('hex'),
          });
          await finishRefreshSubmission(db, ticket, 'accepted');
          return 'accepted';
        } catch (error) {
          if (error instanceof Restricted) stop = error.reason;
          await finishRefreshSubmission(db, ticket, 'unknown').catch(
            () => undefined,
          );
          return stop ? 'restricted' : 'unknown';
        }
      } catch (error) {
        if (error instanceof Restricted) stop = error.reason;
        return stop ? 'restricted' : attempted ? 'unknown' : 'unavailable';
      } finally {
        await save(file, {
          ...admitted,
          inFlight: false,
          ...(stop ? { stop } : {}),
        });
      }
    },
    database,
  );
}
