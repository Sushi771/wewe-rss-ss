import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { batchStorageLock } from '../collection/batch-storage-lock';
import {
  automaticMediaPlan,
  automaticMediaSources,
  automaticMediaVersion,
} from '../collection/automatic-media-body';
import {
  allowedImageUrl,
  decodeInlineImage,
  ImageRequestBlockedError,
  ImageRequestTransientError,
} from '../collection/image-fetch';
import { SavedMediaSnapshot } from '../collection/saved-media-writeback';

const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const MAX_STATE = 4_000_000;
const MAX_ARTICLES = 1024;
const MAX_RESOURCES = 2048;
const MAX_CACHE = 128_000_000;
const BACKOFF = [60_000, 300_000, 1_800_000, 21_600_000];
const resourceSchema = z
  .object({
    url: z.string().max(4096),
    attempts: z.number().int().min(0).max(4),
    due: z.number().nonnegative(),
    state: z.enum(['pending', 'failed', 'blocked']),
    code: z.string().max(64).optional(),
  })
  .strict();
const articleSchema = z
  .object({
    id: z.string().min(1).max(128),
    feedId: z.string().min(1).max(128),
    body: sha,
    resources: z.array(sha).max(60),
    unknown: z.number().int().nonnegative(),
    writes: z.number().int().min(0).max(4),
    due: z.number().nonnegative(),
    code: z.string().max(64).optional(),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    database: sha,
    cursor: z.string().max(128),
    since: z.number().nonnegative(),
    windowStart: z.number().nonnegative(),
    windowCount: z.number().int().min(0).max(120),
    nextScan: z.number().nonnegative(),
    nextRequest: z.number().nonnegative(),
    blocked: z.boolean(),
    articles: z.array(articleSchema).max(MAX_ARTICLES),
    resources: z.record(resourceSchema),
  })
  .strict()
  .refine((value) => Object.keys(value.resources).length <= MAX_RESOURCES);
type State = z.infer<typeof stateSchema>;
type Entry = State['articles'][number];
export type AutomaticMediaSummary = {
  feedId: string;
  pending: number;
  failed: number;
  unconfirmed: number;
  attempts: number;
  nextRetryAt: string | null;
  code?: string;
};
export type AutomaticMediaScanRow = Pick<
  SavedMediaSnapshot,
  'id' | 'mpId' | 'contentHtml'
> &
  Partial<SavedMediaSnapshot> & { oversized?: boolean };
export type AutomaticMediaDependencies = {
  now(): number;
  scan(
    cursor: string,
    since: number,
  ): Promise<{ rows: AutomaticMediaScanRow[]; cursor: string; end: boolean }>;
  load(id: string): Promise<SavedMediaSnapshot | undefined>;
  commit(
    row: SavedMediaSnapshot,
    images: ReadonlyMap<string, string>,
  ): Promise<void>;
  fetch(url: string): Promise<{ bytes: Buffer; type: string }>;
  canFetch(feedId: string): boolean;
  stop(): Promise<void>;
  publish(summary: AutomaticMediaSummary[], code?: string): void;
};

async function readBounded(file: string, limit: number) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit)
    throw Error('MEDIA_STORAGE_INVALID');
  const handle = await fs.open(file, 'r');
  try {
    const opened = await handle.stat();
    if (
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      before.size !== opened.size
    )
      throw Error('MEDIA_STORAGE_INVALID');
    const buffer = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < buffer.length) {
      const part = await handle.read(buffer, used, buffer.length - used, used);
      if (!part.bytesRead) break;
      used += part.bytesRead;
    }
    const after = await handle.stat();
    if (
      used !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw Error('MEDIA_STORAGE_INVALID');
    return buffer.subarray(0, used);
  } finally {
    await handle.close();
  }
}
async function atomic(file: string, value: unknown, limit: number) {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > limit) throw Error('MEDIA_STORAGE_CAPACITY');
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(text);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

/** One durable consumer of the existing cache-sync media lane. The PID claim is
 * held through HTTP (never an expiring lease). No feed lock or SQL transaction
 * is held through HTTP. State/bytes are private local recovery data, not exports. */
export class AutomaticMediaQueue {
  private readonly startedAt: number;
  private busy = false;
  private closed = false;
  private initialized = false;
  private database = '';
  private directory = '';
  constructor(
    private readonly databaseFile: string,
    private readonly deps: AutomaticMediaDependencies,
  ) {
    this.startedAt = deps.now();
  }
  close() {
    this.closed = true;
  }
  private async initialize() {
    if (this.initialized) return;
    const file = await fs.realpath(this.databaseFile);
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw Error('MEDIA_DATABASE_INVALID');
    this.database = hash(`${file}\n${stat.dev}\n${stat.ino}`);
    this.directory = path.join(
      path.dirname(file),
      '.wechat2rss-automatic-media',
    );
    await fs.mkdir(this.directory, { recursive: true });
    await fs.mkdir(path.join(this.directory, 'bytes'), { recursive: true });
    const normalized = (value: string) =>
      process.platform === 'win32'
        ? path.resolve(value).toLowerCase()
        : path.resolve(value);
    for (const folder of [this.directory, path.join(this.directory, 'bytes')]) {
      if (normalized(await fs.realpath(folder)) !== normalized(folder))
        throw Error('MEDIA_STORAGE_INVALID');
    }
    this.initialized = true;
  }
  private async readState(): Promise<State> {
    try {
      const state = stateSchema.parse(
        JSON.parse(
          (
            await readBounded(
              path.join(this.directory, 'queue.json'),
              MAX_STATE,
            )
          ).toString('utf8'),
        ),
      );
      if (state.database !== this.database)
        throw Error('MEDIA_DATABASE_CHANGED');
      if (
        new Set(state.articles.map((row) => row.id)).size !==
        state.articles.length
      )
        throw Error('MEDIA_STORAGE_INVALID');
      for (const [key, resource] of Object.entries(state.resources)) {
        allowedImageUrl(resource.url);
        if (hash(resource.url) !== key) throw Error('MEDIA_STORAGE_INVALID');
      }
      if (
        state.articles.some((row) =>
          row.resources.some((key) => !state.resources[key]),
        )
      )
        throw Error('MEDIA_STORAGE_INVALID');
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return {
        version: 1,
        database: this.database,
        since: this.startedAt,
        windowStart: this.deps.now(),
        windowCount: 0,
        cursor: '',
        nextScan: 0,
        nextRequest: 0,
        blocked: false,
        articles: [],
        resources: {},
      };
    }
  }
  private async save(state: State) {
    const referenced = new Set(state.articles.flatMap((row) => row.resources));
    for (const key of Object.keys(state.resources))
      if (!referenced.has(key)) delete state.resources[key];
    stateSchema.parse(state);
    await atomic(path.join(this.directory, 'queue.json'), state, MAX_STATE);
  }
  private publish(state: State, code?: string) {
    const summaries = new Map<string, AutomaticMediaSummary>();
    for (const article of state.articles) {
      const summary = summaries.get(article.feedId) || {
        feedId: article.feedId,
        pending: 0,
        failed: 0,
        unconfirmed: 0,
        attempts: 0,
        nextRetryAt: null,
      };
      const resources = article.resources.map((key) => state.resources[key]);
      const failed =
        article.writes >= 4 ||
        resources.some(
          (row) => row.state === 'failed' || row.state === 'blocked',
        ) ||
        !!article.code?.match(/LIMIT|IDENTITY/);
      summary.failed += Number(failed);
      summary.pending += Number(!failed && resources.length > 0);
      summary.unconfirmed += Number(article.unknown > 0);
      summary.attempts = Math.max(
        summary.attempts,
        article.writes,
        ...resources.map((row) => row.attempts),
      );
      const due = Math.max(
        article.due,
        state.nextRequest,
        ...resources.map((row) => row.due),
      );
      if (
        !failed &&
        due > this.deps.now() &&
        (!summary.nextRetryAt || due < Date.parse(summary.nextRetryAt))
      )
        summary.nextRetryAt = new Date(due).toISOString();
      summary.code =
        article.code || resources.find((row) => row.code)?.code || summary.code;
      summaries.set(article.feedId, summary);
    }
    this.deps.publish(
      [...summaries.values()],
      state.blocked ? 'IMAGE_REQUEST_BLOCKED' : code,
    );
  }
  private async cached(key: string, url: string) {
    try {
      const record = JSON.parse(
        (
          await readBounded(
            path.join(this.directory, 'bytes', `${key}.json`),
            14_000_000,
          )
        ).toString('utf8'),
      );
      if (
        record.version !== 1 ||
        record.url !== url ||
        record.key !== key ||
        typeof record.inline !== 'string'
      )
        throw Error('MEDIA_BYTES_INVALID');
      const decoded = decodeInlineImage(record.inline);
      if (hash(decoded.bytes) !== record.sha256)
        throw Error('MEDIA_BYTES_INVALID');
      return record.inline as string;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
  private async capacity(required: number) {
    const folder = path.join(this.directory, 'bytes');
    let bytes = 0;
    for await (const entry of await fs.opendir(folder)) {
      const name = entry.name;
      // A process death can leave our own bounded temp; count it, never follow
      // or delete it, and do not mistake it for a verified resource.
      if (!/^[a-f0-9]{64}\.json(?:\.[a-f0-9-]{36}\.tmp)?$/.test(name))
        throw Error('MEDIA_STORAGE_INVALID');
      const stat = await fs.lstat(path.join(folder, name));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 14_000_000)
        throw Error('MEDIA_STORAGE_INVALID');
      bytes += stat.size;
      if (bytes + required > MAX_CACHE) throw Error('MEDIA_STORAGE_CAPACITY');
    }
    if (bytes + required > MAX_CACHE) throw Error('MEDIA_STORAGE_CAPACITY');
    // Preserve the existing byte quota; tiny cached records do not exhaust an
    // unrelated file-count limit. Reserve disk space before spending HTTP.
    const disk = await fs.statfs(folder, { bigint: true });
    if (disk.bavail * disk.bsize < BigInt(4 * 1024 ** 3 + required))
      throw Error('MEDIA_STORAGE_CAPACITY');
  }
  private async store(key: string, url: string, inline: string) {
    const decoded = decodeInlineImage(inline);
    const value = { version: 1, key, url, sha256: hash(decoded.bytes), inline };
    await this.capacity(Buffer.byteLength(JSON.stringify(value)));
    await atomic(
      path.join(this.directory, 'bytes', `${key}.json`),
      value,
      14_000_000,
    );
  }
  private discover(state: State, rows: AutomaticMediaScanRow[]) {
    for (const row of rows) {
      const previous = state.articles.find((entry) => entry.id === row.id);
      const sources = row.oversized
        ? { ready: false, urls: [], unknown: 1 }
        : automaticMediaSources(row.contentHtml || '');
      if (sources.ready) {
        state.articles = state.articles.filter((entry) => entry.id !== row.id);
        continue;
      }
      if (!previous && state.articles.length >= MAX_ARTICLES)
        throw Error('MEDIA_STORAGE_CAPACITY');
      const body = automaticMediaVersion(row);
      const resources = sources.urls.map((url) => {
        const key = hash(url);
        if (!state.resources[key]) {
          if (Object.keys(state.resources).length >= MAX_RESOURCES)
            throw Error('MEDIA_STORAGE_CAPACITY');
          state.resources[key] = { url, attempts: 0, due: 0, state: 'pending' };
        }
        return key;
      });
      const entry: Entry = {
        id: row.id,
        feedId: row.mpId,
        body,
        resources,
        unknown: sources.unknown,
        writes: previous?.body === body ? previous.writes : 0,
        due: previous?.body === body ? previous.due : 0,
        code: row.oversized
          ? 'MEDIA_BODY_LIMIT'
          : previous?.body === body
            ? previous.code
            : undefined,
      };
      if (previous) Object.assign(previous, entry);
      else state.articles.push(entry);
    }
  }
  /** At most one bounded scan page and one resource request per tick. */
  async tick() {
    if (this.busy || this.closed) return;
    this.busy = true;
    let release: (() => Promise<void>) | undefined;
    let state: State | undefined;
    try {
      await this.initialize();
      release = await batchStorageLock(this.directory);
      if (!release || this.closed) return;
      state = await this.readState();
      let diagnostic: string | undefined;
      if (state.nextScan <= this.deps.now()) {
        const page = await this.deps.scan(state.cursor, state.since);
        const draft: State = JSON.parse(JSON.stringify(state));
        try {
          this.discover(draft, page.rows);
          draft.cursor = page.end ? '' : page.cursor;
          draft.nextScan = this.deps.now() + (page.end ? 60_000 : 2000);
          await this.save(draft);
          state = draft;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            error.message !== 'MEDIA_STORAGE_CAPACITY'
          )
            throw error;
          // Keep the previous valid queue drainable; retry the same cursor later.
          diagnostic = 'MEDIA_STORAGE_CAPACITY';
          state.nextScan = this.deps.now() + 60_000;
        }
      }
      await this.work(state);
      await this.save(state);
      this.publish(state, diagnostic);
    } catch (error) {
      // No raw URLs, body, IDs, filesystem paths or exception messages in status.
      const message = error instanceof Error ? error.message : '';
      const code =
        /^MEDIA_(?:STORAGE_CAPACITY|BODY_LIMIT|DATABASE_CHANGED|BYTES_INVALID)$/.test(
          message,
        )
          ? message
          : 'MEDIA_WORKER_UNAVAILABLE';
      if (state) this.publish(state, code);
      else this.deps.publish([], code);
    } finally {
      try {
        await release?.();
      } finally {
        this.busy = false;
      }
    }
  }
  private async work(state: State) {
    let inspected = 0;
    for (const entry of [...state.articles]) {
      if (
        this.closed ||
        entry.writes >= 4 ||
        entry.due > this.deps.now() ||
        !entry.resources.length
      )
        continue;
      if (inspected++ >= 20) break;
      const images = new Map<string, string>();
      let cachedSize = 0;
      for (const key of entry.resources) {
        const resource = state.resources[key];
        const existing = await this.cached(key, resource.url);
        if (existing) {
          cachedSize += Buffer.byteLength(existing);
          if (cachedSize > 8_000_000) {
            entry.writes = 4;
            entry.code = 'MEDIA_BODY_LIMIT';
            break;
          }
          images.set(resource.url, existing);
        }
      }
      if (entry.writes >= 4) continue;
      const canRequest =
        !state.blocked &&
        this.deps.canFetch(entry.feedId) &&
        state.nextRequest <= this.deps.now() &&
        entry.resources.some(
          (key) =>
            state.resources[key].state === 'pending' &&
            state.resources[key].due <= this.deps.now(),
        );
      if (!images.size && !canRequest) {
        state.articles = [
          ...state.articles.filter((article) => article !== entry),
          entry,
        ];
        continue;
      }
      const row = await this.deps.load(entry.id);
      if (!row || row.mpId !== entry.feedId || !row.contentHtml) {
        state.articles = state.articles.filter((article) => article !== entry);
        return;
      }
      if (automaticMediaVersion(row) !== entry.body) {
        this.discover(state, [row]);
        return;
      }
      try {
        automaticMediaPlan(row, new Map());
      } catch {
        entry.writes = 4;
        entry.code = 'MEDIA_IDENTITY_UNVERIFIED';
        return;
      }
      let fetched = false;
      for (const key of entry.resources) {
        const resource = state.resources[key];
        if (images.has(resource.url)) continue;
        if (
          fetched ||
          state.blocked ||
          !this.deps.canFetch(entry.feedId) ||
          resource.state !== 'pending' ||
          resource.due > this.deps.now() ||
          state.nextRequest > this.deps.now()
        )
          continue;
        if (resource.attempts >= 4) {
          resource.state = 'failed';
          resource.code = 'MEDIA_RETRY_EXHAUSTED';
          continue;
        }
        // Reserve enough space for the largest permitted encoded response before
        // spending an upstream attempt. Capacity failure is a visible pause.
        await this.capacity(14_000_000);
        if (this.deps.now() - state.windowStart >= 3_600_000) {
          state.windowStart = this.deps.now();
          state.windowCount = 0;
        }
        if (state.windowCount >= 120) {
          state.nextRequest = state.windowStart + 3_600_000;
          continue;
        }
        state.windowCount++;
        resource.due = this.deps.now() + BACKOFF[resource.attempts++];
        state.nextRequest =
          state.windowCount >= 120
            ? state.windowStart + 3_600_000
            : this.deps.now() + 1000;
        // A crash/ACK loss spends this attempt; restart respects the recorded due.
        await this.save(state);
        fetched = true;
        try {
          const value = await this.deps.fetch(resource.url);
          const inline = `data:${value.type};base64,${value.bytes.toString('base64')}`;
          await this.store(key, resource.url, inline);
          images.set(resource.url, inline);
          resource.code = undefined;
        } catch (error) {
          if (error instanceof ImageRequestBlockedError) {
            state.blocked = true;
            resource.state = 'blocked';
            resource.code = 'IMAGE_REQUEST_BLOCKED';
            // Persist lane stop before any SQL, even if marker I/O fails.
            try {
              await this.save(state);
            } finally {
              await this.deps.stop();
            }
          } else {
            if (
              error instanceof Error &&
              error.message === 'MEDIA_STORAGE_CAPACITY'
            )
              throw error;
            const transient =
              error instanceof ImageRequestTransientError ||
              error instanceof TypeError ||
              (error instanceof Error &&
                ['AbortError', 'TimeoutError'].includes(error.name));
            resource.state =
              transient && resource.attempts < 4 ? 'pending' : 'failed';
            resource.code = transient
              ? resource.attempts < 4
                ? 'MEDIA_RETRY_WAIT'
                : 'MEDIA_RETRY_EXHAUSTED'
              : 'MEDIA_RESOURCE_INVALID';
          }
        }
      }
      if (images.size && !this.closed) {
        entry.writes++;
        entry.due = this.deps.now() + BACKOFF[entry.writes - 1];
        await this.save(state);
        try {
          await this.deps.commit(row, images);
          // Reinspect after commit/ACK loss. Never infer all media ready from one GET.
          const current = await this.deps.load(entry.id);
          if (current) this.discover(state, [current]);
          else
            state.articles = state.articles.filter(
              (article) => article !== entry,
            );
        } catch (error) {
          if (error instanceof Error && error.message === 'MEDIA_BODY_LIMIT') {
            entry.writes = 4;
            entry.code = 'MEDIA_BODY_LIMIT';
            continue;
          }
          entry.code =
            error instanceof Error && error.message === 'SAVED_MEDIA_CONFLICT'
              ? 'MEDIA_BODY_CHANGED'
              : 'MEDIA_SAVE_RETRY';
        }
      }
      // Rotate pending rows so an unavailable resource never starves later feeds.
      state.articles = [
        ...state.articles.filter((article) => article !== entry),
        ...(state.articles.includes(entry) ? [entry] : []),
      ];
      return;
    }
  }
}
