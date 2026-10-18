import { AsyncLocalStorage } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';

// A finite, opt-in observation window. Never include input, SQL, params or errors.
const context = new AsyncLocalStorage<ReadTiming>();
const clients = new WeakMap<object, number>();
let clientSequence = 0,
  reads = 0,
  transactions = 0,
  activeReads = 0,
  events = 0;
const MAX_READS = 32,
  MAX_EVENTS = 2048;
const deadline = performance.now() + 10 * 60 * 1000;

type ReadTiming = {
  id: number;
  start: number;
  cache: 'unknown' | 'hit' | 'miss' | 'bypass' | 'coalesced';
  phases: Record<string, number>;
  marks: Partial<Record<TransactionPhase, number>>;
};
type TransactionPhase =
  | 'requested'
  | 'admitted'
  | 'callbackEntry'
  | 'callbackDone'
  | 'wrapperReturn';
const elapsed = (start: number) =>
  Math.round((performance.now() - start) * 1000) / 1000;
const difference = (end?: number, start?: number) =>
  end === undefined || start === undefined
    ? null
    : Math.round((end - start) * 1000) / 1000;

export function articleListReadTimingEnabled() {
  return process.env.ARTICLE_LIST_READ_TIMING === '1';
}
function log(value: object) {
  if (events >= MAX_EVENTS) return;
  events++;
  try {
    console.info(
      '[ARTICLE_LIST_READ_TIMING] ' +
        JSON.stringify({ at: new Date().toISOString(), ...value }),
    );
  } catch {
    // Diagnostic output can never change a read or transaction outcome.
  }
}
function clientId(client: object) {
  let id = clients.get(client);
  if (!id) clients.set(client, (id = ++clientSequence));
  return id;
}

export function withArticleListReadTiming<T>(operation: () => Promise<T>) {
  if (
    !articleListReadTimingEnabled() ||
    reads >= MAX_READS ||
    performance.now() >= deadline
  )
    return operation();
  const sample: ReadTiming = {
    id: ++reads,
    start: performance.now(),
    cache: 'unknown',
    phases: {},
    marks: {},
  };
  activeReads++;
  return context.run(sample, async () => {
    let ok = false;
    try {
      const result = await operation();
      ok = true;
      return result;
    } finally {
      activeReads--;
      const m = sample.marks;
      log({
        event: 'read',
        read: sample.id,
        ok,
        cache: sample.cache,
        totalMs: elapsed(sample.start),
        phasesMs: sample.phases,
        coordinatorWaitMs: difference(m.admitted, m.requested),
        connectionBeginWaitMs: difference(m.callbackEntry, m.admitted),
        callbackMs: difference(m.callbackDone, m.callbackEntry),
        commitReturnMs: difference(m.wrapperReturn, m.callbackDone),
      });
    }
  });
}

export function articleListCacheTiming(cache: ReadTiming['cache']) {
  const sample = context.getStore();
  if (sample) sample.cache = cache;
}
export async function articleListReadPhase<T>(
  name: 'revisionBefore' | 'revisionAfter' | 'snapshot',
  operation: () => Promise<T>,
) {
  const sample = context.getStore();
  if (!sample) return operation();
  const start = performance.now();
  try {
    return await operation();
  } finally {
    sample.phases[name] = elapsed(start);
  }
}

export function prismaTransactionTiming(client: object) {
  if (!articleListReadTimingEnabled() || performance.now() >= deadline) return;
  const sample = context.getStore();
  const transaction = ++transactions,
    id = clientId(client),
    start = performance.now();
  const mark = (phase: TransactionPhase, ok?: boolean) => {
    if (sample) sample.marks[phase] = performance.now();
    if (activeReads || sample)
      log({
        event: 'transaction',
        client: id,
        transaction,
        read: sample?.id ?? null,
        phase,
        elapsedMs: elapsed(start),
        ...(ok === undefined ? {} : { ok }),
      });
  };
  mark('requested');
  return { mark };
}

// Native events can arrive outside the request's async context. Keep them as a
// client-level timeline; never attribute them to an ALS request or sum them into it.
export function articleListNativeQueryTiming(
  client: object,
  event: { query: string; duration: number },
) {
  if (!articleListReadTimingEnabled() || !activeReads || events >= MAX_EVENTS)
    return;
  if (!Number.isFinite(event.duration) || event.duration < 0) return;
  log({
    event: 'native-query-window',
    client: clientId(client),
    read: null,
    operation:
      /^\s*(SELECT|BEGIN|COMMIT|ROLLBACK|PRAGMA|INSERT|UPDATE|DELETE)\b/i
        .exec(event.query)?.[1]
        ?.toUpperCase() || 'OTHER',
    durationMs: event.duration,
  });
}
