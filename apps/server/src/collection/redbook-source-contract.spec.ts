import {
  beginRedbookPage,
  disabledRedbookSource,
  newRedbookCheckpoint,
  parseRedbookCheckpoint,
  pauseRedbookCheckpoint,
  prepareRedbookPageCommit,
  recoverRedbookCheckpoint,
  RedbookCheckpoint,
  RedbookSourceStop,
  XhsPageRequest,
  XhsPageSource,
  XhsSourcePage,
} from './redbook-source-contract';
import {
  retainXhsArchiveDraft,
  xhsArchiveDraft,
  xhsIdentity,
  XhsArchiveDraft,
  XhsNormalizedCandidate,
} from './xiaohongshu-contract';

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
const note = (
  noteId = 'note-1',
  patch: Partial<XhsNormalizedCandidate> = {},
): XhsNormalizedCandidate => ({
  authorId: 'author-1',
  noteId,
  kind: 'image-text',
  publishedAt: 1700000000,
  title: 'Synthetic title',
  text: 'Synthetic text',
  textStatus: 'full',
  expectedImageCount: 1,
  images: [{ ordinal: 1, inlineData: png }],
  ...patch,
});
const page = (
  requestCursor: string | null = null,
  nextCursor: string | null = null,
  items = [note()],
): XhsSourcePage => ({
  source: 'redbook',
  authorId: 'author-1',
  requestCursor,
  nextCursor,
  items,
});
const roundtrip = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** A synthetic owner, not a new runtime store/queue. Persist requesting, call a
 * single injected source, acknowledge cache, then persist cursor. No timers/DB.
 */
function fixtureOwner(initial = newRedbookCheckpoint('author-1')) {
  let durable: RedbookCheckpoint = roundtrip(initial);
  const cache = new Map<string, XhsArchiveDraft>();
  const cacheCommit = jest.fn(async (items: XhsNormalizedCandidate[]) => {
    for (const item of items) {
      const incoming = xhsArchiveDraft('author-1', item);
      const old = cache.get(incoming.noteKey);
      cache.set(
        incoming.noteKey,
        old ? retainXhsArchiveDraft(old, incoming) : incoming,
      );
    }
  });
  return {
    cache,
    cacheCommit,
    state: () => roundtrip(durable),
    async run(source: XhsPageSource, crash?: 'before-read' | 'after-cache') {
      const started = beginRedbookPage(recoverRedbookCheckpoint(durable));
      durable = roundtrip(started.checkpoint);
      if (crash === 'before-read') return;
      try {
        const result = await source.readPage(started.request);
        const prepared = prepareRedbookPageCommit(durable, result);
        await cacheCommit(result.items);
        if (crash === 'after-cache') return;
        durable = roundtrip(prepared.checkpoint);
        return prepared.newNoteKeys;
      } catch (error) {
        durable = roundtrip(pauseRedbookCheckpoint(durable, error));
      }
    },
  };
}

describe('Redbook source preparation contract (bounded synthetic data only)', () => {
  let network: jest.SpyInstance;
  beforeEach(() => {
    network = jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  });
  afterEach(() => {
    expect(network).not.toHaveBeenCalled();
    jest.restoreAllMocks();
  });
  it('is disabled without a real transport or registration', async () => {
    await expect(
      disabledRedbookSource.readPage({
        source: 'redbook',
        authorId: 'author-1',
        requestCursor: null,
      }),
    ).rejects.toMatchObject({ reason: 'disabled' });
  });
  it('shares archive identity across adapters and ignores mutable locators', () => {
    expect(xhsIdentity('note', 'note-1')).toBe(
      xhsArchiveDraft('author-1', note()).noteKey,
    );
    expect(xhsIdentity('author', 'note-1')).not.toBe(
      xhsIdentity('note', 'note-1'),
    );
    expect(() => xhsIdentity('note', 'bad\nID')).toThrow();
    expect(() => xhsIdentity('note', '')).toThrow();
  });
  it('deduplicates within and across pages while retaining complete cached bytes', async () => {
    const owner = fixtureOwner();
    const readPage = jest
      .fn()
      .mockResolvedValueOnce(page(null, 'p2', [note(), note()]))
      .mockResolvedValueOnce(
        page('p2', null, [
          note('note-1', { title: 'changed' }),
          note('note-2'),
        ]),
      );
    const source: XhsPageSource = { source: 'redbook', readPage };
    expect(await owner.run(source)).toEqual([xhsIdentity('note', 'note-1')]);
    const first = owner.cache.get(xhsIdentity('note', 'note-1'));
    expect(await owner.run(source)).toEqual([xhsIdentity('note', 'note-2')]);
    expect(owner.cache.size).toBe(2);
    expect(owner.cache.get(xhsIdentity('note', 'note-1'))).toBe(first);
    expect(owner.state().phase).toBe('window-complete');
    expect(
      readPage.mock.calls.map(([request]) => request.requestCursor),
    ).toEqual([null, 'p2']);
  });
  it('continues from a JSON-roundtripped acknowledged checkpoint with the same budget', async () => {
    const first = fixtureOwner();
    await first.run({
      source: 'redbook',
      readPage: async () => page(null, 'p2'),
    });
    const restarted = fixtureOwner(roundtrip(first.state()));
    const readPage = jest.fn(async (_request: XhsPageRequest) =>
      page('p2', 'p3', [note('note-2')]),
    );
    await restarted.run({ source: 'redbook', readPage });
    expect(readPage.mock.calls[0][0].requestCursor).toBe('p2');
    expect(restarted.state().ledger.requestedCursors).toEqual([null, 'p2']);
  });
  it.each(['before-read', 'after-cache'] as const)(
    'restart after %s does not replay uncertain dispatch or advance the cursor',
    async (crash) => {
      const owner = fixtureOwner();
      const readPage = jest.fn(async () => page(null, 'p2'));
      await owner.run({ source: 'redbook', readPage }, crash);
      expect(owner.state().phase).toBe('requesting');
      expect(owner.state().ledger.nextCursor).toBeNull();
      const recovered = recoverRedbookCheckpoint(roundtrip(owner.state()));
      expect(recovered).toMatchObject({
        phase: 'paused',
        reason: 'interrupted',
      });
      const forbidden = jest.fn();
      await expect(
        fixtureOwner(recovered).run({ source: 'redbook', readPage: forbidden }),
      ).rejects.toThrow();
      expect(forbidden).not.toHaveBeenCalled();
      expect(owner.cache.size).toBe(crash === 'after-cache' ? 1 : 0);
    },
  );
  it.each(['rate-limit', 'login-expired'] as const)(
    '%s pauses across restart without retry or leaking upstream text',
    async (reason) => {
      const owner = fixtureOwner();
      const readPage = jest.fn(async () => {
        throw new RedbookSourceStop(reason);
      });
      const source: XhsPageSource = { source: 'redbook', readPage };
      await owner.run(source);
      expect(owner.state()).toMatchObject({ phase: 'paused', reason });
      expect(owner.cacheCommit).not.toHaveBeenCalled();
      await expect(fixtureOwner(owner.state()).run(source)).rejects.toThrow();
      expect(readPage).toHaveBeenCalledTimes(1);
    },
  );
  it('sanitizes unexpected failures and cannot weaken an existing restriction', () => {
    const pending = beginRedbookPage(
      newRedbookCheckpoint('author-1'),
    ).checkpoint;
    const unknown = pauseRedbookCheckpoint(
      pending,
      new Error('signed-url=secret'),
    );
    expect(JSON.stringify(unknown)).not.toContain('secret');
    expect(unknown.reason).toBe('unknown');
    const limited = pauseRedbookCheckpoint(
      pending,
      new RedbookSourceStop('rate-limit'),
    );
    expect(pauseRedbookCheckpoint(limited, new Error())).toEqual(limited);
  });
  it('a failed cache acknowledgement never advances or replays the page', async () => {
    const owner = fixtureOwner();
    owner.cacheCommit.mockRejectedValueOnce(
      new Error('synthetic commit failure'),
    );
    const readPage = jest.fn(async () => page(null, 'p2'));
    const source = { source: 'redbook', readPage };
    await owner.run(source);
    expect(owner.state()).toMatchObject({
      phase: 'paused',
      reason: 'unknown',
      ledger: { nextCursor: null, requestedCursors: [] },
    });
    expect(owner.cache.size).toBe(0);
    await expect(fixtureOwner(owner.state()).run(source)).rejects.toThrow();
    expect(readPage).toHaveBeenCalledTimes(1);
  });
  it('expired media keeps cache; an explicitly separate reviewed fill uses existing draft retention', async () => {
    const incomplete = xhsArchiveDraft(
      'author-1',
      note('note-1', { images: [] }),
    );
    const owner = fixtureOwner();
    owner.cache.set(incomplete.noteKey, incomplete);
    const expired = jest.fn(async () => {
      throw new RedbookSourceStop('media-expired');
    });
    await owner.run({ source: 'redbook', readPage: expired });
    expect(owner.state().reason).toBe('media-expired');
    expect(owner.cache.get(incomplete.noteKey)).toBe(incomplete);
    expect(owner.cacheCommit).not.toHaveBeenCalled();
    // Contract-only fill, not an automatic resume or real CDN request.
    const filled = retainXhsArchiveDraft(
      incomplete,
      xhsArchiveDraft('author-1', note()),
    );
    expect(filled).toMatchObject({
      readyForEvidenceCheck: true,
      verified: false,
    });
    expect(filled.noteKey).toBe(incomplete.noteKey);
    expect(filled.authorKey).toBe(incomplete.authorKey);
    expect(retainXhsArchiveDraft(filled, incomplete)).toBe(filled);
    expect(expired).toHaveBeenCalledTimes(1);
  });
  it('rejects incomplete/corrupt images, video and wrong authors before cache commit', async () => {
    for (const bad of [
      note('n', { images: [] }),
      note('n', { kind: 'video' }),
      note('n', { authorId: 'other' }),
      note('n', {
        images: [{ ordinal: 1, inlineData: 'data:image/png;base64,YQ==' }],
      }),
    ]) {
      const owner = fixtureOwner();
      await owner.run({
        source: 'redbook',
        readPage: async () => page(null, null, [bad]),
      });
      expect(owner.state().phase).toBe('paused');
      expect(owner.cacheCommit).not.toHaveBeenCalled();
    }
  });
  it('bounds 30 items per page and three serial pages, including empty pages', async () => {
    const over = fixtureOwner();
    await over.run({
      source: 'redbook',
      readPage: async () =>
        page(
          null,
          null,
          Array.from({ length: 31 }, (_, i) => note('n' + i)),
        ),
    });
    expect(over.cacheCommit).not.toHaveBeenCalled();
    const owner = fixtureOwner();
    const readPage = jest.fn(async (request) =>
      page(
        request.requestCursor,
        request.requestCursor === null
          ? 'p2'
          : request.requestCursor === 'p2'
            ? 'p3'
            : 'p4',
        [],
      ),
    );
    const source: XhsPageSource = { source: 'redbook', readPage };
    for (let i = 0; i < 3; i++) await owner.run(source);
    expect(owner.state().phase).toBe('window-complete');
    expect(owner.state().ledger.supplierReportedEnd).toBe(false);
    await expect(owner.run(source)).rejects.toThrow();
    expect(readPage).toHaveBeenCalledTimes(3);
  });
  it('rejects replay cycles and foreign source binding before any cache change', () => {
    const initial = beginRedbookPage(
      newRedbookCheckpoint('author-1'),
    ).checkpoint;
    const next = prepareRedbookPageCommit(initial, page(null, 'p2')).checkpoint;
    const pending = beginRedbookPage(next).checkpoint;
    expect(() => prepareRedbookPageCommit(pending, page('p2', 'p2'))).toThrow();
    expect(() => prepareRedbookPageCommit(pending, page(null, null))).toThrow();
    expect(() =>
      prepareRedbookPageCommit(initial, {
        ...page(),
        source: 'other' as 'redbook',
      }),
    ).toThrow();
  });
  it('rejects extra persisted secrets, foreign identity and corrupt checkpoint metadata', () => {
    const good = newRedbookCheckpoint('author-1');
    for (const bad of [
      { ...good, token: 'synthetic-secret' },
      { ...good, source: 'other' },
      { ...good, authorId: 'other' },
      { ...good, phase: 'ready', reason: 'rate-limit' },
      { ...good, ledger: { ...good.ledger, noteKeys: ['unscoped-id'] } },
      { ...good, ledger: { ...good.ledger, requestedCursors: [null, null] } },
    ])
      expect(() => parseRedbookCheckpoint(bad)).toThrow();
  });
});
