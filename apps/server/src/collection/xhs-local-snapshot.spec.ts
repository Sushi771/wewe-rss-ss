import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { LocalArticleStore } from '../article-local-save';
import { buildCompleteArticleDownload } from '../article-verified-download';
import { withXhsLocalSnapshot } from './xhs-local-snapshot';

const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
describe('immutable XHS snapshot companions through actual local publisher', () => {
  let root: string, store: LocalArticleStore;
  const noteId = JSON.stringify(['xiaohongshu', 'note', 'synthetic-note']);
  const prepare = (snapshot: string) =>
    withXhsLocalSnapshot(
      async (stage) => ({
        ...(await buildCompleteArticleDownload(
          {
            id: noteId,
            title: 'Synthetic',
            publishTime: 1760000000,
            contentHtml: `<div id="js_content"><p>Body punctuation: !?。</p><img src="${png}"></div>`,
            lastBodyStatus: 'available',
            metrics: null,
          },
          'https://www.xiaohongshu.com/explore/synthetic-note',
          stage,
        )),
        exportSource: {
          feedId: 'synthetic-creator',
          feedName: 'Synthetic creator',
        },
      }),
      noteId,
      'Synthetic',
      snapshot,
    );
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'xhs-snapshot-companion-'));
    store = new LocalArticleStore(path.join(root, 'settings.json'), root);
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  it('publishes new A+B snapshot on retained edited body, preserves media, and deduplicates an unchanged snapshot', async () => {
    const first = await store.save(
      prepare('## 已保存评论\n\nA'),
      new Date(),
      root,
    );
    expect(first.supplement?.status).toBe('new');
    await fs.appendFile(first.markdownPath, '\nUSER EDIT\n');
    const body = await fs.readFile(first.markdownPath);
    const media = await fs.readdir(path.join(first.directory, 'image'));
    const bytes = await Promise.all(
      media.map((f) => fs.readFile(path.join(first.directory, 'image', f))),
    );
    const next = await store.save(
      prepare('## 已保存评论\n\nA\n\nB'),
      new Date(),
      root,
    );
    expect(next.alreadySaved).toBe(true);
    expect(next.supplement?.status).toBe('new');
    expect(next.supplement?.path).not.toBe(first.supplement?.path);
    expect(await fs.readFile(next.markdownPath)).toEqual(body);
    expect(await fs.readFile(next.supplement!.path, 'utf8')).toContain(
      'A\n\nB',
    );
    expect(await fs.readFile(first.supplement!.path, 'utf8')).not.toContain(
      'A\n\nB',
    );
    expect(
      await Promise.all(
        media.map((f) => fs.readFile(path.join(next.directory, 'image', f))),
      ),
    ).toEqual(bytes);
    const again = await store.save(
      prepare('## 已保存评论\n\nA\n\nB'),
      new Date(),
      root,
    );
    expect(again.supplement).toMatchObject({
      status: 'retained',
      path: next.supplement!.path,
    });
    expect(
      (await fs.readdir(next.directory)).filter((f) =>
        f.startsWith('互动与评论-'),
      ),
    ).toHaveLength(2);
  });
  it('preserves a user-edited companion and publishes a distinct conflict version', async () => {
    const first = await store.save(
      prepare('## 互动快照\n\n点赞：0'),
      new Date(),
      root,
    );
    await fs.appendFile(first.supplement!.path, '\nUSER SNAPSHOT EDIT');
    const edited = await fs.readFile(first.supplement!.path);
    const second = await store.save(
      prepare('## 互动快照\n\n点赞：0'),
      new Date(),
      root,
    );
    expect(second.supplement?.status).toBe('conflict-version');
    expect(await fs.readFile(first.supplement!.path)).toEqual(edited);
    expect(await fs.readFile(second.supplement!.path, 'utf8')).not.toContain(
      'USER SNAPSHOT EDIT',
    );
    const third = await store.save(
      prepare('## 互动快照\n\n点赞：0'),
      new Date(),
      root,
    );
    expect(third.supplement).toMatchObject({
      status: 'retained',
      path: second.supplement!.path,
    });
  });
  it('does not fabricate a companion for an empty saved scope', async () => {
    const saved = await store.save(prepare(''), new Date(), root);
    expect(saved.supplement).toBeUndefined();
    expect(
      (await fs.readdir(saved.directory)).filter((f) =>
        f.startsWith('互动与评论-'),
      ),
    ).toEqual([]);
  });
  it('surfaces failed companion publication after body preservation instead of claiming current comments were exported', async () => {
    const first = await store.save(prepare('A'), new Date(), root);
    await fs.appendFile(first.markdownPath, '\nUSER EDIT');
    const before = await fs.readFile(first.markdownPath);
    const link = jest
      .spyOn(fs, 'link')
      .mockRejectedValueOnce(
        Object.assign(Error('synthetic fs failure'), { code: 'EIO' }),
      );
    try {
      await expect(
        store.save(prepare('A+B'), new Date(), root),
      ).rejects.toThrow('synthetic fs failure');
    } finally {
      link.mockRestore();
    }
    expect(await fs.readFile(first.markdownPath)).toEqual(before);
    expect(
      (await fs.readdir(first.directory)).filter((f) => f.endsWith('.tmp')),
    ).toEqual([]);
    const resumed = await store.save(prepare('A+B'), new Date(), root);
    expect(resumed.supplement?.status).toBe('new');
  });
});
