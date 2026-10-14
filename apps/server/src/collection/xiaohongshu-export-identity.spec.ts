import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import axios from 'axios';
import { XiaohongshuService } from './xiaohongshu.service';
import { LocalArticleStore } from '../article-local-save';
import { exportIdentity, exportSourceMarkdown } from '../article-export-source';

// Synthetic cache only. Exercise actual service preparation, shared exporter,
// receipt hashes and filesystem saver; no platform response or credentials.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);
const id = JSON.stringify(['xiaohongshu', 'note', 'synthetic-note']);
const creator = {
  id: 'local-creator',
  externalAuthorId: 'synthetic-author',
  displayName: '合成博主',
  group: null,
};
const cache = () => ({
  id,
  creatorId: creator.id,
  title: '合成完整图文',
  status: 'complete',
  kind: 'image-text',
  contentHtml: `<div id="js_content"><p>合成全文</p><img src="data:image/png;base64,${png.toString('base64')}"></div>`,
  publishTime: 1760000000,
  videoBytes: null,
  videoMimeType: null,
  videoExpectedBytes: null,
  videoSha256: null,
});
describe('XHS stable export identity and safe local repair (synthetic offline)', () => {
  let root: string;
  let note: ReturnType<typeof cache>;
  let author: typeof creator;
  let service: XiaohongshuService;
  let store: LocalArticleStore;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'wewe-xhs-identity-'));
    note = cache();
    author = { ...creator };
    const db = {
      xhsNote: { findFirst: jest.fn(async () => ({ ...note })) },
      xhsCreator: { findUnique: jest.fn(async () => ({ ...author })) },
    };
    service = new XiaohongshuService(db as any);
    store = new LocalArticleStore(
      path.join(root, 'settings.json'),
      path.join(root, 'vault'),
    );
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    jest.spyOn(axios, 'post').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
  });
  afterEach(async () => {
    expect(global.fetch).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  const prepare = () => service.prepareLocalDownload(creator.id, id);
  const receiptPath = (folder: string) =>
    path.join(folder, '.wewe-articles', `${exportIdentity(id)}-cached.json`);
  it('uses platform/author/note identities, writes real PNG and correct platform label', async () => {
    const prepared = await prepare();
    expect(prepared.identity).toMatchObject({
      articleId: id,
      publishTime: note.publishTime,
      exportSource: {
        platform: 'xiaohongshu',
        feedId: JSON.stringify([
          'xiaohongshu',
          'author',
          creator.externalAuthorId,
        ]),
      },
    });
    expect(prepared.canReuseLegacyImages).toBeUndefined();
    expect(prepared.seedImages).toBeUndefined();
    const saved = await store.save(prepared);
    expect(saved.status).toBe('new');
    const markdown = await fs.readFile(saved.markdownPath, 'utf8');
    expect(markdown).toContain('小红书博主：合成博主');
    expect(markdown).toContain('合成全文');
    const receipt = JSON.parse(
      await fs.readFile(receiptPath(saved.directory), 'utf8'),
    );
    expect(Object.values(receipt.imageMap)).toEqual(receipt.images);
    expect(
      await fs.readFile(path.join(saved.directory, 'image', receipt.images[0])),
    ).toEqual(png);
    expect(receipt.images[0]).toContain(
      createHash('sha256').update(png).digest('hex').slice(0, 32),
    );
    expect(
      exportSourceMarkdown({ feedId: 'wx', feedName: '原公众号' }),
    ).toContain('公众号：原公众号');
  });
  it('skips across days and renamed author with lazy body gate, preserves handwritten Markdown', async () => {
    const saved = await store.save(await prepare(), new Date('2026-10-10'));
    await fs.writeFile(saved.markdownPath, '本人手写正文\n');
    author.displayName = '后来改名';
    note.contentHtml =
      '<div>malformed body must not be parsed for pre-skip</div>';
    const result = await store.save(await prepare(), new Date('2026-10-12'));
    expect(result.status).toBe('skipped');
    expect(result.markdownPath).toBe(saved.markdownPath);
    expect(await fs.readFile(saved.markdownPath, 'utf8')).toBe(
      '本人手写正文\n',
    );
    const fresh = new LocalArticleStore(
      path.join(root, 'other.json'),
      path.join(root, 'fresh'),
    );
    await expect(fresh.save(await prepare())).rejects.toMatchObject({
      diagnostic: { code: 'VERIFIED_ARTICLE_UNAVAILABLE' },
    });
  });
  it('repairs only a missing mapped image without overwriting handwritten body', async () => {
    const saved = await store.save(await prepare());
    const receipt = JSON.parse(
      await fs.readFile(receiptPath(saved.directory), 'utf8'),
    );
    const image = path.join(saved.directory, 'image', receipt.images[0]);
    await fs.writeFile(saved.markdownPath, '手写内容不变');
    await fs.unlink(image);
    const repaired = await store.save(await prepare(), new Date('2026-10-12'));
    expect(repaired.status).toBe('repaired');
    expect(await fs.readFile(image)).toEqual(png);
    expect(await fs.readFile(saved.markdownPath, 'utf8')).toBe('手写内容不变');
  });
  it('refuses missing legacy map and malicious map without modifying user body', async () => {
    const saved = await store.save(await prepare());
    const file = receiptPath(saved.directory);
    const original = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(saved.markdownPath, '手写内容不变');
    await fs.unlink(path.join(saved.directory, 'image', original.images[0]));
    const legacy = { ...original };
    delete legacy.imageMap;
    await fs.writeFile(file, JSON.stringify(legacy));
    await expect(store.save(await prepare())).rejects.toMatchObject({
      diagnostic: { code: 'SAVE_REPAIR_UNAVAILABLE' },
    });
    await fs.writeFile(
      file,
      JSON.stringify({
        ...original,
        imageMap: { '../escape.png': original.images[0] },
      }),
    );
    await expect(store.save(await prepare())).rejects.toMatchObject({
      diagnostic: { code: 'SAVE_RECEIPT_INVALID' },
    });
    expect(await fs.readFile(saved.markdownPath, 'utf8')).toBe('手写内容不变');
    expect(await fs.readdir(path.join(saved.directory, 'image'))).toEqual([]);
  });
  it.each(['author', 'note', 'platform', 'blank'])(
    'refuses untrusted %s identity before creating files',
    async (kind) => {
      if (kind === 'author') author.externalAuthorId = '';
      if (kind === 'note') note.id = 'legacy-note-id';
      if (kind === 'platform')
        note.id = JSON.stringify(['wechat', 'note', 'synthetic-note']);
      if (kind === 'blank')
        note.id = JSON.stringify(['xiaohongshu', 'note', '']);
      await expect(prepare()).rejects.toMatchObject({
        diagnostic: { code: 'XHS_CACHED_IDENTITY_UNAVAILABLE' },
      });
      expect(await fs.readdir(root)).toEqual([]);
    },
  );
});
