import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  beijingDownloadDay,
  DEFAULT_ARTICLE_DIRECTORY,
  LocalArticleStore,
  validateLocalDirectory,
} from './article-local-save';
import { buildArticleMarkdown } from './article-export';

jest.mock('node:fs/promises', () => ({
  __esModule: true,
  ...jest.requireActual('node:fs/promises'),
}));

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);
const now = new Date('2026-10-04T16:00:00Z');
describe('local article save with real files and shared exporter, no network or database', () => {
  let temporary: string;
  let root: string;
  let store: LocalArticleStore;
  beforeEach(async () => {
    temporary = await fs.mkdtemp(join(tmpdir(), 'wewe-local-save-'));
    root = join(temporary, 'Obsidian Vault', '公众号的文章（待分类）');
    store = new LocalArticleStore(join(temporary, 'preferences.json'), root);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  const prepare =
    (id = 'WX_123_456_1', title = '测试：中文文章') =>
    async (directory: string) => {
      const exported = await buildArticleMarkdown(
        {
          id,
          title,
          sourceUrl: null,
          contentHtml: `<div id="js_content"><p>合成正文</p><img src="data:image/png;base64,${png.toString('base64')}"></div>`,
          lastBodyStatus: null,
          metrics: null,
          publishTime: 0,
        },
        '',
        directory,
        async () => {
          throw new Error('NETWORK_DISABLED');
        },
        'image',
      );
      await fs.writeFile(
        join(directory, 'index.md'),
        `# ${title}\n\n${exported.markdown}`,
      );
      return { articleId: id, title, imageCount: 1 };
    };
  it('has the requested default path and asks only when explicitly enabled', async () => {
    const defaults = await new LocalArticleStore(
      join(temporary, 'unused.json'),
    ).read();
    expect(defaults).toEqual({
      directory: DEFAULT_ARTICLE_DIRECTORY,
      askEveryTime: false,
    });
    await fs.mkdir(root, { recursive: true });
    await store.rememberPickedDirectory(root);
    await store.setAskEveryTime(true);
    await store.setAskEveryTime(false);
    expect(
      await new LocalArticleStore(
        join(temporary, 'preferences.json'),
        root,
      ).read(),
    ).toEqual({ directory: root, askEveryTime: false });
  });
  it('keeps old source-unknown notes separate from Wechat2RSS and protects edited same-source replays', async () => {
    const old = await store.save(prepare(), now);
    await fs.writeFile(old.markdownPath, '旧来源手写笔记');
    const w2r = async (directory: string) => ({
      ...(await prepare()(directory)),
      source: 'wechat2rss' as const,
    });
    const first = await store.save(w2r, now);
    expect(first.alreadySaved).toBe(false);
    expect(first.directory).not.toBe(old.directory);
    expect(await fs.readFile(old.markdownPath, 'utf8')).toBe('旧来源手写笔记');
    expect(
      JSON.parse(
        await fs.readFile(join(first.directory, '.wewe-article.json'), 'utf8'),
      ).source,
    ).toBe('wechat2rss');
    await fs.writeFile(first.markdownPath, 'Wechat2RSS笔记的用户编辑');
    const again = await store.save(w2r, now);
    expect(again.alreadySaved).toBe(true);
    expect(again.directory).toBe(first.directory);
    expect(await fs.readFile(first.markdownPath, 'utf8')).toBe(
      'Wechat2RSS笔记的用户编辑',
    );
    expect(await fs.readFile(old.markdownPath, 'utf8')).toBe('旧来源手写笔记');
  });
  it('uses the download day in Beijing, including the UTC day boundary', () => {
    expect(beijingDownloadDay(new Date('2026-10-04T15:59:59Z'))).toBe(
      '2026-10-04',
    );
    expect(beijingDownloadDay(now)).toBe('2026-10-05');
  });
  it('saves Markdown and readable relative image files in a spaced Chinese path without a ZIP', async () => {
    const saved = await store.save(prepare(), now);
    expect(saved.alreadySaved).toBe(false);
    expect(saved.directory).toContain('2026-10-05');
    const markdown = await fs.readFile(saved.markdownPath, 'utf8');
    const image = markdown.match(/\(image\/([^\)]+)\)/)![1];
    expect(await fs.readFile(join(saved.directory, 'image', image))).toEqual(
      png,
    );
    expect(await fs.readdir(saved.directory)).toEqual(
      expect.arrayContaining(['正文.md', 'image', '.wewe-article.json']),
    );
    expect((await fs.readdir(saved.directory)).join()).not.toMatch(
      /\.zip|index\.html|attachments/,
    );
    expect(await fs.readdir(join(root, '2026-10-05'))).toHaveLength(1);
  });
  it('keeps same-day articles with identical titles separate and refuses to overwrite edited duplicate notes', async () => {
    const first = await store.save(prepare('WX_123_456_1', '同名文章'), now);
    const other = await store.save(prepare('WX_123_456_2', '同名文章'), now);
    expect(first.directory).not.toBe(other.directory);
    await fs.writeFile(first.markdownPath, '用户自己的笔记');
    const duplicate = await store.save(
      prepare('WX_123_456_1', '同名文章'),
      now,
    );
    expect(duplicate).toMatchObject({
      alreadySaved: true,
      directory: first.directory,
    });
    expect(await fs.readFile(first.markdownPath, 'utf8')).toBe(
      '用户自己的笔记',
    );
    expect(await fs.readdir(join(root, '2026-10-05'))).toHaveLength(2);
  });
  it('does not replace an existing unmarked note directory of the same name', async () => {
    const original = await store.save(prepare(), now);
    await fs.unlink(join(original.directory, '.wewe-article.json'));
    await fs.writeFile(original.markdownPath, 'existing unrelated note');
    const next = await store.save(prepare(), now);
    expect(next.directory).toBe(original.directory + ' (2)');
    expect(await fs.readFile(original.markdownPath, 'utf8')).toBe(
      'existing unrelated note',
    );
  });
  it('leaves no successful article directory when the upstream body or image preparation fails', async () => {
    await expect(
      store.save(async (directory) => {
        await fs.mkdir(join(directory, 'image'));
        await fs.writeFile(join(directory, 'image', 'partial.png'), png);
        throw new Error('upstream failed');
      }, now),
    ).rejects.toThrow('未完成');
    expect(await fs.readdir(join(root, '2026-10-05'))).toEqual([]);
  });
  it('reports lack of write permission before preparation and never claims success', async () => {
    const original = fs.mkdir;
    jest
      .spyOn(fs, 'mkdir')
      .mockImplementation(async (...args: Parameters<typeof fs.mkdir>) => {
        if (args[0] === root)
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return original(...args);
      });
    const builder = jest.fn(prepare());
    await expect(store.save(builder, now)).rejects.toThrow('目录权限');
    expect(builder).not.toHaveBeenCalled();
  });
  it('rolls back only its files on a publication failure and leaves unrelated notes untouched', async () => {
    await fs.mkdir(root, { recursive: true });
    const note = join(root, '自己的笔记.md');
    await fs.writeFile(note, 'keep');
    jest
      .spyOn(fs, 'copyFile')
      .mockRejectedValue(
        Object.assign(new Error('denied'), { code: 'EACCES' }),
      );
    await expect(store.save(prepare(), now)).rejects.toThrow('未完成');
    expect(await fs.readFile(note, 'utf8')).toBe('keep');
    expect(await fs.readdir(join(root, '2026-10-05'))).toEqual([]);
  });
  it('rejects relative paths, drive roots and directory links before writing', async () => {
    await expect(validateLocalDirectory('../notes')).rejects.toThrow('有效');
    const link = join(temporary, 'link');
    await fs.mkdir(root, { recursive: true });
    await fs.symlink(
      root,
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await expect(validateLocalDirectory(link)).rejects.toThrow('链接');
  });
});
