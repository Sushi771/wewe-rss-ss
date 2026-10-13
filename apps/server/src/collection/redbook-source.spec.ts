import { RedbookSource, RedbookReader } from './redbook-source';
import { FileRedbookStateStore, freshRedbookState } from './redbook-scan-state';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import type { XhsCreator } from '@prisma/client';

describe('redbook durable bounded synthetic scans (no platform transport)', () => {
  let directory: string;
  let store: FileRedbookStateStore;
  const creator = {
    id: 'local',
    externalAuthorId: 'author',
    enabled: true,
  } as XhsCreator;
  const candidate = (noteId: string) => ({
    authorId: 'author',
    noteId,
    kind: 'image-text' as const,
    title: 'fixture',
    text: 'synthetic',
    textStatus: 'full' as const,
    publishedAt: 1700000000,
    expectedImageCount: 0,
    images: [],
  });
  const commit = jest.fn(async (result) => ({
    status: 'partial' as const,
    added: result.pages[0].items.length,
    message: 'synthetic',
  }));
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(tmpdir(), 'redbook-fixture-'));
    store = new FileRedbookStateStore(directory);
    commit.mockClear();
  });
  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });
  function setup(reader: RedbookReader, complete = async () => false) {
    return new RedbookSource({
      reader,
      store,
      contractReviewed: true,
      isComplete: complete,
    });
  }
  it('registers dormant without creating state or requests', async () => {
    const source = new RedbookSource();
    expect(source.configured).toBe(false);
    expect((await source.scan(creator, commit)).status).toBe('paused');
    expect(await fs.readdir(directory)).toEqual([]);
  });
  it('caps requests at three 30-item pages, dedupes noteIds, fresh manual refresh starts at head', async () => {
    const list = jest.fn(async (_author, cursor) => ({
      nextCursor: cursor === null ? 'p2' : cursor === 'p2' ? 'p3' : 'p4',
      notes: Array.from({ length: 30 }, (_, i) => ({
        noteId: 'n' + i,
        token: 'memory-only',
      })),
    }));
    const detail = jest.fn(async (_author, id) => candidate(id));
    const source = setup({ list, detail });
    expect(await source.scan(creator, commit)).toMatchObject({
      status: 'partial',
      added: 30,
    });
    expect(list.mock.calls.map((c) => c[1])).toEqual([null, 'p2', 'p3']);
    expect(detail).toHaveBeenCalledTimes(30);
    const saved = (await fs.readdir(directory)).find((p) =>
      p.endsWith('.json'),
    )!;
    expect(
      await fs.readFile(path.join(directory, saved), 'utf8'),
    ).not.toContain('memory-only');
    await source.scan(creator, commit);
    expect(list.mock.calls[3][1]).toBeNull();
  });
  it('skips complete cache before detail and keeps empty page cursor commits', async () => {
    const detail = jest.fn();
    const source = setup(
      {
        list: async () => ({
          nextCursor: null,
          notes: [{ noteId: 'n1', token: 't' }],
        }),
        detail,
      },
      async () => true,
    );
    expect(await source.scan(creator, commit)).toMatchObject({
      status: 'complete',
      added: 0,
    });
    expect(detail).not.toHaveBeenCalled();
    expect(commit.mock.calls[0][0].pages[0].items).toEqual([]);
  });
  it('first failure stops and persists pause across new source instances', async () => {
    const list = jest.fn(async () => {
      throw new Error('secret-cookie=captcha');
    });
    expect(
      (await setup({ list, detail: jest.fn() }).scan(creator, commit)).status,
    ).toBe('paused');
    expect(
      (await setup({ list, detail: jest.fn() }).scan(creator, commit)).status,
    ).toBe('paused');
    expect(list).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
    const file = (await fs.readdir(directory))[0];
    expect(await fs.readFile(path.join(directory, file), 'utf8')).not.toContain(
      'secret',
    );
  });
  it('rejects repeated cursor before detail and uncertain request state after restart', async () => {
    const detail = jest.fn();
    expect(
      (
        await setup({
          list: async () => ({ nextCursor: null, notes: [] }),
          detail,
        }).scan(creator, commit)
      ).status,
    ).toBe('complete');
    await store.exclusive('author', async (_old, save) =>
      save({
        ...freshRedbookState('author'),
        phase: 'requesting',
        pages: 1,
        cursors: [null],
      }),
    );
    const list = jest.fn();
    expect((await setup({ list, detail }).scan(creator, commit)).status).toBe(
      'paused',
    );
    expect(list).not.toHaveBeenCalled();
  });
  it('cycle and commit failure pause without dispatching a next page', async () => {
    const list = jest.fn(async (_author, cursor) => ({
      nextCursor: cursor === null ? 'cycle' : 'cycle',
      notes: [],
    }));
    expect(
      (await setup({ list, detail: jest.fn() }).scan(creator, commit)).status,
    ).toBe('paused');
    expect(list).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(1);
  });
  it('continues only a saved safe checkpoint within the same three-page budget', async () => {
    await store.exclusive('author', async (_old, save) =>
      save({
        ...freshRedbookState('author'),
        pages: 2,
        cursors: [null, 'p2'],
        nextCursor: 'p3',
        noteIds: ['n1'],
      }),
    );
    const list = jest.fn(async () => ({
      nextCursor: 'p4',
      notes: [
        { noteId: 'n1', token: 't' },
        { noteId: 'n2', token: 't' },
      ],
    }));
    const detail = jest.fn(async (_author, id) => candidate(id));
    expect(await setup({ list, detail }).scan(creator, commit)).toMatchObject({
      status: 'partial',
      added: 1,
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]).toEqual(['author', 'p3']);
    expect(detail).toHaveBeenCalledTimes(1);
  });
  it('pauses between details without another request or a partial cache commit', async () => {
    const detail = jest.fn(async (_author, id) => {
      await source.pause(creator);
      return candidate(id);
    });
    const source = setup({
      list: async () => ({
        nextCursor: null,
        notes: [
          { noteId: 'n1', token: 't' },
          { noteId: 'n2', token: 't' },
        ],
      }),
      detail,
    });
    expect((await source.scan(creator, commit)).status).toBe('paused');
    expect(detail).toHaveBeenCalledTimes(1);
    expect(commit).not.toHaveBeenCalled();
  });
  it('idle operator pause survives restart and only a safe operator checkpoint can resume', async () => {
    const list = jest.fn(async () => ({ nextCursor: null, notes: [] }));
    const source = setup({ list, detail: jest.fn() });
    await source.pause(creator);
    const restarted = setup({ list, detail: jest.fn() });
    expect((await restarted.scan(creator, commit)).status).toBe('paused');
    expect(list).not.toHaveBeenCalled();
    await restarted.resumeOperatorCheckpoint(creator);
    expect((await restarted.scan(creator, commit)).status).toBe('complete');
    await store.exclusive('author', async (_old, save) =>
      save({
        ...freshRedbookState('author'),
        phase: 'paused',
        reason: 'upstream',
      }),
    );
    await expect(restarted.resumeOperatorCheckpoint(creator)).rejects.toThrow(
      'REDBOOK_RESUME_BLOCKED',
    );
  });
  it('persists pause on the final single detail and after final page commit', async () => {
    const list = jest.fn(async () => ({
      nextCursor: null,
      notes: [{ noteId: 'n1', token: 't' }],
    }));
    const detail = jest.fn(async (_author, id) => {
      await source.pause(creator);
      return candidate(id);
    });
    const source = setup({ list, detail });
    expect((await source.scan(creator, commit)).status).toBe('paused');
    expect(commit).not.toHaveBeenCalled();
    expect((await setup({ list, detail }).scan(creator, commit)).status).toBe(
      'paused',
    );
    expect(list).toHaveBeenCalledTimes(1);
    await store.exclusive('author', async (_old, save) =>
      save(freshRedbookState('author')),
    );
    const final = setup({
      list: async () => ({ nextCursor: null, notes: [] }),
      detail: jest.fn(),
    });
    expect(
      (
        await final.scan(creator, async () => {
          await final.pause(creator);
          return { status: 'complete', added: 1, message: 'committed' };
        })
      ).status,
    ).toBe('paused');
    const noDispatch = jest.fn();
    expect(
      (
        await setup({ list: noDispatch, detail: jest.fn() }).scan(
          creator,
          commit,
        )
      ).status,
    ).toBe('paused');
    expect(noDispatch).not.toHaveBeenCalled();
  });
  it('commit failure records uncertainty and never retries a page on restart', async () => {
    const list = jest.fn(async () => ({ nextCursor: 'p2', notes: [] }));
    const reader = { list, detail: jest.fn() };
    const failure = jest.fn(async () => {
      throw new Error('commit failed');
    });
    expect((await setup(reader).scan(creator, failure)).status).toBe('paused');
    expect((await setup(reader).scan(creator, commit)).status).toBe('paused');
    expect(list).toHaveBeenCalledTimes(1);
    await expect(
      setup(reader).resumeOperatorCheckpoint(creator),
    ).rejects.toThrow('REDBOOK_RESUME_BLOCKED');
  });
  it('rejects corrupted persisted state rather than silently starting a new scan', async () => {
    await store.exclusive('author', async (_old, save) =>
      save(freshRedbookState('author')),
    );
    const file = (await fs.readdir(directory))[0];
    await fs.writeFile(path.join(directory, file), '{broken');
    const list = jest.fn();
    await expect(
      setup({ list, detail: jest.fn() }).scan(creator, commit),
    ).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
  });
});
