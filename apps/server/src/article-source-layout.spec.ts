import * as fs from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalArticleStore } from './article-local-save';
import { prepareCachedArticleLocalExport } from './cached-article-local-export';
import {
  exportSourceFolders,
  exportPublication,
  exportLegacySourceFolders,
} from './article-export-source';
jest.mock('node:fs/promises', () => ({
  __esModule: true,
  ...jest.requireActual('node:fs/promises'),
}));

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
const source = {
  feedId: 'MP_WXS_1234567890',
  feedName: '妈妈部落',
  groupId: 'group-a',
  groupName: '上海教育',
};
const item = (id = 'WX_1234567890_2247000001_1') => ({
  id,
  title: '同名文章',
  sourceUrl: 'https://mp.weixin.qq.com/s/test',
  contentHtml: `<div id="js_content"><p>离线合成正文</p><img src="data:image/png;base64,${png}"></div>`,
  publishTime: 1791210060,
  lastBodyStatus: 'available',
  metrics: null,
});

describe('trusted publisher/group shared layout, real files and no network', () => {
  let root: string;
  let store: LocalArticleStore;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'wewe-source-layout-'));
    store = new LocalArticleStore(join(root, 'settings.json'), root);
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  it('writes group/publisher/title.md beside shared image and protects edited repeat saves', async () => {
    const first = await store.save(
      prepareCachedArticleLocalExport(item(), source),
    );
    expect(relative(root, first.directory)).toBe(
      join(...exportSourceFolders(source, item().publishTime)),
    );
    expect(basename(first.markdownPath)).toBe('同名文章.md');
    const markdown = await fs.readFile(first.markdownPath, 'utf8');
    expect(markdown).toContain('公众号：妈妈部落');
    expect(markdown).toContain('分组：上海教育');
    expect(markdown).toContain('原文链接：https://mp.weixin.qq.com/s/test');
    const name = markdown.match(/\(image\/([^\)]+)\)/)![1];
    expect(name).toMatch(/^image_[a-f0-9]{12}_[a-f0-9]{32}\.png$/);
    expect(await fs.readFile(join(first.directory, 'image', name))).toEqual(
      Buffer.from(png, 'base64'),
    );
    const second = await store.save(
      prepareCachedArticleLocalExport(
        item('WX_1234567890_2247000002_1'),
        source,
      ),
    );
    expect(second.directory).toBe(first.directory);
    expect(second.markdownPath).not.toBe(first.markdownPath);
    expect(await fs.readdir(join(first.directory, 'image'))).toHaveLength(2);
    await fs.writeFile(first.markdownPath, '用户编辑');
    expect(
      await store.save(prepareCachedArticleLocalExport(item(), source)),
    ).toMatchObject({ alreadySaved: true, markdownPath: first.markdownPath });
    expect(await fs.readFile(first.markdownPath, 'utf8')).toBe('用户编辑');
    expect(await fs.readdir(root)).toEqual([
      exportSourceFolders(source, item().publishTime)[0],
    ]);
  });
  it('isolates same publisher names, illegal names and ungrouped records under the confirmed root', async () => {
    const weird = {
      ...source,
      feedId: 'another-feed',
      feedName: '../CON:unsafe\\name',
      groupId: null,
      groupName: null,
    };
    const saved = await store.save(
      prepareCachedArticleLocalExport(item(), weird),
    );
    expect(relative(root, saved.directory)).toBe(
      join(...exportSourceFolders(weird, item().publishTime)),
    );
    expect(relative(root, saved.directory)).not.toContain('..');
    expect(relative(root, saved.directory)).toContain('未分组');
    const equalName = { ...source, feedId: 'different-feed' };
    const first = await store.save(
      prepareCachedArticleLocalExport(item(), source),
    );
    const other = await store.save(
      prepareCachedArticleLocalExport(item(), equalName),
    );
    expect(other.directory).not.toBe(first.directory);
    expect(other.directory).toContain('妈妈部落-');
  });
  it('rollback removes only its owned files and retains other articles images/edited notes', async () => {
    const first = await store.save(
      prepareCachedArticleLocalExport(item(), source),
    );
    await fs.writeFile(first.markdownPath, 'keep');
    const originals = await fs.readdir(join(first.directory, 'image'));
    const realOpen = fs.open;
    jest
      .spyOn(fs, 'open')
      .mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        if (String(args[0]).endsWith('.md'))
          throw new Error('simulated disk failure');
        return realOpen(...args);
      });
    await expect(
      store.save(
        prepareCachedArticleLocalExport(
          item('WX_1234567890_2247000003_1'),
          source,
        ),
      ),
    ).rejects.toThrow('未完成');
    expect(await fs.readFile(first.markdownPath, 'utf8')).toBe('keep');
    expect(await fs.readdir(join(first.directory, 'image'))).toEqual(originals);
  });
  it('uses original Shanghai publication day across UTC midnight, never the save day', async () => {
    const a = {
      ...item(),
      publishTime: Date.parse('2026-10-05T15:59:59Z') / 1000,
    };
    const b = {
      ...item('WX_1234567890_2247000002_1'),
      publishTime: a.publishTime + 1,
    };
    const first = await store.save(
      prepareCachedArticleLocalExport(a, source),
      new Date('2026-10-10T00:00:00Z'),
    );
    const second = await store.save(
      prepareCachedArticleLocalExport(b, source),
      new Date('2026-10-11T00:00:00Z'),
    );
    expect(relative(root, first.directory)).toBe(
      join('2026-10-05_上海教育', '妈妈部落'),
    );
    expect(relative(root, second.directory)).toBe(
      join('2026-10-06_上海教育', '妈妈部落'),
    );
    expect(first.publicationDate).toBe('2026-10-05');
    expect(await fs.readFile(first.markdownPath, 'utf8')).toContain(
      '原文发布日期（上海时间）：2026-10-05',
    );
    expect(await fs.readdir(root)).toHaveLength(2);
  });
  it.each([undefined, null, 0, -1, NaN, Infinity, 1791210060000, 1791210060.5])(
    'retains body with explicit pending-date reason for %s',
    async (publishTime) => {
      const prepare = prepareCachedArticleLocalExport(item(), source);
      const saved = await store.save(async (stage) => ({
        ...(await prepare(stage)),
        publishTime,
      }));
      expect(relative(root, saved.directory)).toBe(
        join('日期待核_上海教育', '妈妈部落'),
      );
      expect(saved).toMatchObject({
        publicationDate: null,
        datePendingReason: expect.any(String),
      });
      const body = await fs.readFile(saved.markdownPath, 'utf8');
      expect(body).toContain('日期待核');
      expect(body).toContain(saved.datePendingReason!);
      expect(body).toContain('离线合成正文');
      expect(exportPublication(publishTime).publicationDate).toBeNull();
    },
  );
  it('retains the old undated receipt, edited note and images without moving or duplicating it', async () => {
    const first = await store.save(
      prepareCachedArticleLocalExport(item(), source),
    );
    const oldGroup = join(root, exportLegacySourceFolders(source)[0]);
    await fs.rename(
      join(root, exportSourceFolders(source, item().publishTime)[0]),
      oldGroup,
    );
    const oldNote = join(
      oldGroup,
      source.feedName,
      basename(first.markdownPath),
    );
    await fs.writeFile(oldNote, '用户编辑不能搬移');
    const originalImages = await fs.readdir(
      join(oldGroup, source.feedName, 'image'),
    );
    const saved = await store.save(
      prepareCachedArticleLocalExport(item(), source),
    );
    expect(saved).toMatchObject({
      alreadySaved: true,
      legacyLayoutRetained: true,
      markdownPath: oldNote,
    });
    expect(await fs.readFile(oldNote, 'utf8')).toBe('用户编辑不能搬移');
    expect(await fs.readdir(join(saved.directory, 'image'))).toEqual(
      originalImages,
    );
    expect(await fs.readdir(root)).toEqual([
      exportLegacySourceFolders(source)[0],
    ]);
  });
  it('retains a pending-date note when trustworthy date later arrives and stops ambiguous copies', async () => {
    const first = await store.save(
      prepareCachedArticleLocalExport({ ...item(), publishTime: 0 }, source),
    );
    await fs.writeFile(first.markdownPath, '编辑');
    const saved = await store.save(
      prepareCachedArticleLocalExport(item(), source),
    );
    expect(saved).toMatchObject({
      alreadySaved: true,
      legacyLayoutRetained: true,
      markdownPath: first.markdownPath,
    });
    const group = join(root, '2026-10-05_上海教育');
    await fs.cp(join(root, '日期待核_上海教育'), group, { recursive: true });
    await expect(
      store.save(prepareCachedArticleLocalExport(item(), source)),
    ).rejects.toMatchObject({ diagnostic: { code: 'SAVE_LEGACY_AMBIGUOUS' } });
    expect(await fs.readFile(first.markdownPath, 'utf8')).toBe('编辑');
  });
  it('reuses the previous tool per-article receipt only for the same trusted adapter', async () => {
    const prepare = prepareCachedArticleLocalExport(item());
    const old = await store.save(
      async (stage) => ({
        ...(await prepare(stage)),
        source: 'wechat2rss' as const,
      }),
      new Date('2026-10-10T00:00:00Z'),
    );
    await fs.writeFile(old.markdownPath, '旧单篇用户编辑');
    const fresh = prepareCachedArticleLocalExport(item(), source);
    const saved = await store.save(async (stage) => ({
      ...(await fresh(stage)),
      source: 'wechat2rss' as const,
    }));
    expect(saved).toMatchObject({
      alreadySaved: true,
      legacyLayoutRetained: true,
      markdownPath: old.markdownPath,
    });
    expect(await fs.readFile(old.markdownPath, 'utf8')).toBe('旧单篇用户编辑');
  });
  it('does not duplicate an edited receipt when its image is missing or Markdown path escapes', async () => {
    const first = await store.save(
      prepareCachedArticleLocalExport(item(), source),
    );
    await fs.writeFile(first.markdownPath, '编辑');
    const receiptDirectory = join(first.directory, '.wewe-articles');
    const receiptPath = join(
      receiptDirectory,
      (await fs.readdir(receiptDirectory))[0],
    );
    const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
    await fs.writeFile(
      receiptPath,
      JSON.stringify({ ...receipt, markdown: '../escape.md' }),
    );
    await expect(
      store.save(prepareCachedArticleLocalExport(item(), source)),
    ).rejects.toMatchObject({ diagnostic: { code: 'SAVE_RECEIPT_INVALID' } });
    await fs.writeFile(receiptPath, JSON.stringify(receipt));
    await fs.unlink(join(first.directory, 'image', receipt.images[0]));
    await expect(
      store.save(prepareCachedArticleLocalExport(item(), source)),
    ).rejects.toMatchObject({ diagnostic: { code: 'SAVE_RECEIPT_INVALID' } });
    expect(await fs.readFile(first.markdownPath, 'utf8')).toBe('编辑');
    expect(
      (await fs.readdir(first.directory)).filter((n) => n.endsWith('.md')),
    ).toEqual(['同名文章.md']);
  });
});
