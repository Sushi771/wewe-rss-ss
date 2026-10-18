import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LocalArticleStore } from './article-local-save';
import { prepareCachedArticleLocalExport } from './cached-article-local-export';

describe('one fresh lookup per locked sourced save', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wewe-save-scan-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });
  const source = {
    feedId: 'MP_WXS_1234567890',
    feedName: 'Synthetic',
    groupId: 'group',
    groupName: 'Group',
  };
  const article = {
    id: 'one',
    title: 'One',
    sourceUrl: null,
    publishTime: 1791210060,
    metrics: null,
    lastBodyStatus: 'available',
    contentHtml: '<div id="js_content">Body</div>',
  };
  it('does one enumeration for new and repeated saves, never reuses a previous save lookup', async () => {
    const store = new LocalArticleStore(join(root, 'settings.json'), root);
    const lookup = jest.spyOn(store as any, 'findRetainedArticle');
    expect(
      await store.save(prepareCachedArticleLocalExport(article, source)),
    ).toMatchObject({ status: 'new' });
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(
      await store.save(prepareCachedArticleLocalExport(article, source)),
    ).toMatchObject({ status: 'skipped' });
    expect(lookup).toHaveBeenCalledTimes(2);
  });
  it('keeps fallback discovery when the preparation has no early identity', async () => {
    const store = new LocalArticleStore(join(root, 'settings.json'), root);
    const lookup = jest.spyOn(store as any, 'findRetainedArticle');
    const original = prepareCachedArticleLocalExport(article, source);
    const late = async (stage: string) => original(stage);
    await store.save(late);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it.each(['articleId', 'feedId', 'source'] as const)(
    'rejects a preparation returning a different locked %s',
    async (field) => {
      const store = new LocalArticleStore(join(root, 'settings.json'), root);
      const original = prepareCachedArticleLocalExport(article, source);
      const prepare = Object.assign(
        async (stage: string) => {
          const result = await original(stage);
          if (field === 'articleId') result.articleId = 'different';
          if (field === 'source') result.source = 'wechat2rss';
          if (field === 'feedId')
            result.exportSource = { ...source, feedId: 'different' };
          return result;
        },
        { identity: original.identity },
      );
      await expect(store.save(prepare)).rejects.toMatchObject({
        diagnostic: { code: 'SAVE_IDENTITY_CONFLICT' },
      });
    },
  );
  it('rejects mutation of the early identity even when the prepared result matches that mutation', async () => {
    const store = new LocalArticleStore(join(root, 'settings.json'), root);
    const original = prepareCachedArticleLocalExport(article, source);
    const prepare = Object.assign(
      async (stage: string) => {
        const result = await original(stage);
        prepare.identity!.articleId = 'mutated';
        return { ...result, articleId: 'mutated' };
      },
      { identity: original.identity },
    );
    await expect(store.save(prepare)).rejects.toMatchObject({
      diagnostic: { code: 'SAVE_IDENTITY_CONFLICT' },
    });
  });
});
