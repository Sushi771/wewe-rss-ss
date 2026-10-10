import * as fs from 'node:fs/promises';
import { join, relative, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalArticleStore } from './article-local-save';
import { prepareCachedArticleLocalExport } from './cached-article-local-export';
import { exportSourceFolders } from './article-export-source';
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
  publishTime: 0,
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
      join(...exportSourceFolders(source)),
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
    expect(await fs.readdir(root)).toEqual([exportSourceFolders(source)[0]]);
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
      join(...exportSourceFolders(weird)),
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
});
