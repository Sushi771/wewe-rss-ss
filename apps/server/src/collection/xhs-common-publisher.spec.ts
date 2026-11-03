import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { XiaohongshuService } from './xiaohongshu.service';
import { LocalArticleStore } from '../article-local-save';

// Real common publisher with synthetic cached adapter output; never a source request.
describe('XHS uses the common source publisher', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'wewe-xhs-common-'));
  });
  afterEach(async () => {
    if (
      path.dirname(root) === tmpdir() &&
      path.basename(root).startsWith('wewe-xhs-common-')
    )
      await fs.rm(root, { recursive: true, force: true });
  });
  async function fixture(publishTime = 1792368000) {
    const note = {
      id: JSON.stringify(['xiaohongshu', 'note', 'fixture']),
      creatorId: 'creator',
      title: '中文笔记',
      publishTime,
    };
    const service = new XiaohongshuService({
      xhsCreator: {
        findUnique: async () => ({
          id: 'creator',
          displayName: '中文博主',
          groupId: 'group',
        }),
      },
      xhsNote: { findFirst: async () => note },
      managementGroup: {
        findUnique: async () => ({ id: 'group', name: '中文分组' }),
      },
    } as any);
    const prepare = jest.fn(async (stage: string) => {
      await fs.mkdir(path.join(stage, 'image'));
      await fs.writeFile(
        path.join(stage, 'image', 'image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png'),
        Buffer.from('fixture-image'),
      );
      await fs.writeFile(
        path.join(stage, 'index.md'),
        '正文\n\n![](image/image_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png)',
      );
      return { articleId: note.id, title: note.title, imageCount: 1 };
    });
    jest
      .spyOn(service as any, 'prepareCachedLocalDownload')
      .mockResolvedValue(prepare);
    return { service, prepare };
  }
  it('publishes Chinese date/group/creator hierarchy, relative media and preserves manual edits on replay', async () => {
    const { service, prepare } = await fixture();
    const destination = path.join(root, '小红书的内容（待分类）');
    const store = new LocalArticleStore(
      path.join(root, 'xhs-settings.json'),
      destination,
    );
    const first = await store.save(
      await service.prepareLocalDownload('creator', 'fixture'),
    );
    expect(path.relative(destination, first.markdownPath)).toMatch(
      /2026-10-19_中文分组[\\/]中文博主[\\/]中文笔记\.md$/,
    );
    const md = await fs.readFile(first.markdownPath, 'utf8');
    expect(md).toContain('博主：中文博主');
    const image = md.match(/\(image\/([^)]*)\)/)![1];
    expect(
      await fs.readFile(path.join(first.directory, 'image', image), 'utf8'),
    ).toBe('fixture-image');
    await fs.writeFile(first.markdownPath, '手工编辑');
    const again = await store.save(
      await service.prepareLocalDownload('creator', 'fixture'),
    );
    expect(again.alreadySaved).toBe(true);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(first.markdownPath, 'utf8')).toBe('手工编辑');
    expect(await fs.readdir(root)).not.toContain('公众号的文章（待分类）');
  });
  it('keeps unknown publication date explicit without using download date', async () => {
    const { service } = await fixture(0);
    const store = new LocalArticleStore(path.join(root, 'settings.json'), root);
    const saved = await store.save(
      await service.prepareLocalDownload('creator', 'fixture'),
    );
    expect(path.relative(root, saved.markdownPath)).toContain(
      '日期待核_中文分组',
    );
    expect(saved.datePendingReason).toBeTruthy();
  });
  it('retains cached video bytes and refuses an edited video on replay', async () => {
    const { service } = await fixture();
    const bytes = Buffer.from('synthetic cached video bytes');
    const hash = require('node:crypto')
      .createHash('sha256')
      .update(bytes)
      .digest('hex');
    const filename = 'video_' + hash + '.mp4';
    (service as any).prepareCachedLocalDownload.mockResolvedValue(
      async (stage: string) => {
        await fs.mkdir(path.join(stage, 'image'));
        await fs.mkdir(path.join(stage, 'video'));
        await fs.writeFile(path.join(stage, 'video', filename), bytes);
        await fs.writeFile(
          path.join(stage, 'index.md'),
          '[视频](video/' + filename + ')',
        );
        return {
          articleId: JSON.stringify(['xiaohongshu', 'note', 'fixture']),
          title: '中文笔记',
          imageCount: 0,
          videoCount: 1,
        };
      },
    );
    const store = new LocalArticleStore(path.join(root, 'settings.json'), root);
    const saved = await store.save(
      await service.prepareLocalDownload('creator', 'fixture'),
    );
    expect(saved.videoCount).toBe(1);
    const again = await store.save(
      await service.prepareLocalDownload('creator', 'fixture'),
    );
    expect(again.alreadySaved).toBe(true);
    expect(again.videoCount).toBe(1);
    const file = path.join(saved.directory, 'video', filename);
    await fs.writeFile(file, 'manual');
    await expect(
      store.save(await service.prepareLocalDownload('creator', 'fixture')),
    ).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe('manual');
  });
});
