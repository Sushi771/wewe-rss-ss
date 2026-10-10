import { createHash } from 'node:crypto';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ArticleDownloadError } from './article-download';
import { LocalArticleStore } from './article-local-save';
import { Wechat2RssSingleTasks } from './wechat2rss-single-tasks';
import { prepareWechat2RssSingleDownload } from './wechat2rss-single-download';
import { readWechat2RssSingleCandidates } from './wechat2rss-single-candidates';
import { Wechat2RssSubscriptionBatches } from './collection/wechat2rss-subscription-batches';

const url = 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv';
const owner = createHash('sha256').update('synthetic-owner').digest('hex');
const otherOwner = createHash('sha256')
  .update('synthetic-other-owner')
  .digest('hex');
const batchId = '12345678-1234-1234-1234-123456789012';
describe('durable single download consumer; synthetic queue and real temporary files', () => {
  let root: string,
    directory: string,
    database: string,
    time: number,
    item: {
      state: string;
      feedId?: string;
      bodyReady?: boolean;
      articleUrl?: string;
      articleUrlHash?: string;
    },
    batchState: string;
  let store: LocalArticleStore, manager: Wechat2RssSingleTasks;
  let prepare: jest.MockedFunction<typeof prepareWechat2RssSingleDownload>;
  let readCandidates: jest.MockedFunction<
    typeof readWechat2RssSingleCandidates
  >;
  let save: jest.Mock,
    queue: {
      addSingleDownloadBatch: jest.Mock;
      subscriptionBatchList: jest.Mock;
      stopSubscriptionBatch: jest.Mock;
      resumeSubscriptionBatch: jest.Mock;
    };
  const make = () =>
    new Wechat2RssSingleTasks(
      () => database,
      () => 'synthetic-instance',
      queue,
      save,
      () => true,
      () => time,
      prepare,
      readCandidates,
    );
  const missing = () =>
    new ArticleDownloadError('目标缓存未就绪。', 409, {
      code: 'WECHAT2RSS_SINGLE_SHORT_UNAVAILABLE',
    });
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'wewe-single-task-'));
    directory = join(root, 'Vault');
    await mkdir(directory);
    database = join(root, 'synthetic.sqlite');
    await writeFile(database, '');
    time = 1800000000000;
    item = {
      state: 'waiting',
      feedId: 'MP_WXS_1234567890',
      articleUrl: url,
      articleUrlHash: createHash('sha256').update(url).digest('hex'),
    };
    batchState = 'running';
    queue = {
      addSingleDownloadBatch: jest.fn(async () => ({
        batchId,
        items: [item],
        state: batchState,
      })),
      subscriptionBatchList: jest.fn(async () => [
        { batchId, items: [item], state: batchState },
      ]),
      stopSubscriptionBatch: jest.fn(async () => {
        batchState = 'stopped';
      }),
      resumeSubscriptionBatch: jest.fn(async () => {
        if (batchState === 'stopped')
          return { batchId, items: [item], state: batchState };
        batchState = 'running';
        item.state = 'waiting';
        return { batchId, items: [item], state: batchState };
      }),
    };
    prepare = jest.fn<
      ReturnType<typeof prepareWechat2RssSingleDownload>,
      Parameters<typeof prepareWechat2RssSingleDownload>
    >(async () => async (target: string) => {
      await mkdir(join(target, 'image'));
      await writeFile(join(target, 'index.md'), '# 精确合成正文');
      return {
        articleId: 'WX_1234567890_2247000001_1',
        title: '合成正文',
        sourceUrl:
          'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=2247000001&idx=1&sn=abcdef',
        imageCount: 0,
        source: 'wechat2rss' as const,
      };
    });
    store = new LocalArticleStore(join(root, 'settings.json'), directory);
    readCandidates = jest.fn<
      ReturnType<typeof readWechat2RssSingleCandidates>,
      Parameters<typeof readWechat2RssSingleCandidates>
    >(async () => [
      {
        articleId: 'WX_1234567890_2247000001_1',
        title: '用户明确选择',
        publishTime: 1800000000,
        url: 'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=2247000001&idx=1&sn=abcdef',
      },
    ]);
    save = jest.fn((prepared, folder, startedAt) =>
      store.save(prepared, new Date(startedAt), folder),
    );
    manager = make();
  });
  afterEach(async () => {
    manager.close();
    await rm(root, { recursive: true, force: true });
  });
  it('persists before the shared queue, deduplicates clicks, waits for cache then saves automatically', async () => {
    const task = await manager.enqueue(url, owner, directory);
    expect(
      await manager.enqueue(url + '?scene=1#rd', owner, directory),
    ).toEqual(task);
    expect(queue.addSingleDownloadBatch).not.toHaveBeenCalled();
    expect(await readdir(join(root, '.wechat2rss-single-downloads'))).toEqual([
      task.taskId + '.json',
    ]);
    await manager.runDue();
    expect(queue.addSingleDownloadBatch).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
    await manager.runDue();
    expect(queue.addSingleDownloadBatch).toHaveBeenCalledTimes(1);
    item.state = 'succeeded';
    batchState = 'completed';
    time += 30000;
    await manager.runDue();
    const done = await manager.get(task.taskId, owner);
    expect(done).toMatchObject({
      state: 'saved',
      saved: true,
      contentSource: 'wechat2rss-cache',
      alreadySaved: false,
    });
    expect(prepare).toHaveBeenCalledWith(url, item.feedId);
    expect(await readFile(done.markdownPath!, 'utf8')).toBe('# 精确合成正文');
    expect(save).toHaveBeenCalledTimes(1);
    expect(await manager.hasPending()).toBe(false);
    expect(done).not.toHaveProperty('owner');
    expect(done).not.toHaveProperty('instance');
    await expect(manager.get(task.taskId, otherOwner)).rejects.toMatchObject({
      status: 404,
    });
    expect(await manager.list(otherOwner)).toEqual([]);
  });
  it('restart continues the original receipt and frozen directory, ignoring changed preferences', async () => {
    const task = await manager.enqueue(url, owner, directory);
    await manager.runDue();
    manager.close();
    const changed = join(root, 'new-Vault');
    await mkdir(changed);
    await store.rememberPickedDirectory(changed);
    manager = make();
    item.state = 'succeeded';
    time += 30000;
    await manager.runDue();
    const done = await manager.get(task.taskId, owner);
    expect(done.directory?.startsWith(directory)).toBe(true);
    expect(queue.addSingleDownloadBatch).toHaveBeenCalledTimes(1);
    expect(await readdir(changed)).toEqual([]);
  });
  it('absence of the precise article ends without saving or resubmitting after ten cache reads', async () => {
    const task = await manager.enqueue(url, owner, directory);
    item.state = 'succeeded';
    prepare.mockRejectedValue(missing());
    for (let i = 0; i < 11; i++) {
      await manager.runDue();
      time += 30000;
    }
    expect(await manager.get(task.taskId, owner)).toMatchObject({
      state: 'failed',
    });
    expect(queue.addSingleDownloadBatch).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledTimes(10);
    expect(save).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
  it('complete publisher cache without a short alias stops on the first exact read, with a recovery publisher link', async () => {
    const task = await manager.enqueue(url, owner, directory);
    item.state = 'succeeded';
    item.bodyReady = true;
    batchState = 'completed';
    prepare.mockRejectedValue(missing());
    await manager.runDue();
    expect(await manager.get(task.taskId, owner)).toMatchObject({
      state: 'failed',
      code: 'WECHAT2RSS_SINGLE_SHORT_UNAVAILABLE',
      feedId: item.feedId,
      message: expect.stringContaining('无法确定目标'),
    });
    time += 30000;
    await manager.runDue();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(queue.addSingleDownloadBatch).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
  it('old terminal tasks gain only a publisher-list link from the local receipt; original intent stays unchanged', async () => {
    const task = await manager.enqueue(url, owner, directory);
    await manager.runDue();
    const file = join(
      root,
      '.wechat2rss-single-downloads',
      task.taskId + '.json',
    );
    const old = JSON.parse(await readFile(file, 'utf8'));
    old.state = 'failed';
    old.attempts = 10;
    await writeFile(file, JSON.stringify(old));
    const before = await readFile(file, 'utf8');
    const result = await manager.get(task.taskId, owner);
    expect(result).toMatchObject({ state: 'failed', feedId: item.feedId });
    expect(result).not.toHaveProperty('code'); // No inferred failure diagnosis.
    expect(await manager.list(owner)).toEqual([result]);
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(prepare).not.toHaveBeenCalled();
    expect(queue.addSingleDownloadBatch).toHaveBeenCalledTimes(1);
  });
  it('explicit cached identity selection saves to the frozen task directory after restart, without another subscription', async () => {
    const task = await manager.enqueue(url, owner, directory);
    item.state = 'succeeded';
    item.bodyReady = true;
    batchState = 'completed';
    prepare.mockRejectedValueOnce(missing());
    await manager.runDue();
    const options = await manager.candidates(task.taskId, owner);
    expect(options).toMatchObject({
      destination: directory,
      articles: [{ articleId: 'WX_1234567890_2247000001_1' }],
    });
    expect(options.articles[0]).not.toHaveProperty('url');
    await expect(
      manager.select(task.taskId, otherOwner, options.articles[0].articleId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      manager.select(task.taskId, owner, 'WX_9999999999_2247000001_1'),
    ).rejects.toMatchObject({ status: 409 });
    const picked = await manager.select(
      task.taskId,
      owner,
      options.articles[0].articleId,
    );
    expect(picked).toMatchObject({
      selectedArticle: { title: '用户明确选择' },
      destination: directory,
    });
    manager.close();
    manager = make();
    const changed = join(root, 'other-directory');
    await mkdir(changed);
    await store.rememberPickedDirectory(changed);
    await manager.runDue();
    const saved = await manager.get(task.taskId, owner);
    expect(saved).toMatchObject({
      state: 'saved',
      selectedArticle: { articleId: 'WX_1234567890_2247000001_1' },
    });
    expect(saved.directory?.startsWith(directory)).toBe(true);
    expect(await readdir(changed)).toEqual([]);
    expect(prepare).toHaveBeenLastCalledWith(
      (await readCandidates(item.feedId!))[0].url,
      item.feedId,
    );
    const file = join(
      root,
      '.wechat2rss-single-downloads',
      task.taskId + '.json',
    );
    expect(JSON.parse(await readFile(file, 'utf8')).url).toBe(url);
    await writeFile(saved.markdownPath!, '用户编辑保护');
    expect(
      await manager.select(task.taskId, owner, options.articles[0].articleId),
    ).toMatchObject({ state: 'saved' });
    expect(await readFile(saved.markdownPath!, 'utf8')).toBe('用户编辑保护');
    expect(queue.addSingleDownloadBatch).toHaveBeenCalledTimes(1);
    expect(queue.resumeSubscriptionBatch).not.toHaveBeenCalled();
  });
  it('uses the real redacted batch view to bind candidates, and rejects another original intent', async () => {
    const batches = new Wechat2RssSubscriptionBatches(
      () => database,
      () => 'synthetic-instance',
      jest.fn(async () => ({
        state: 'succeeded' as const,
        message: 'ready',
        feedId: 'MP_WXS_1234567890',
        bodyReady: true,
      })),
      jest.fn(),
      jest.fn(),
      () => time,
    );
    try {
      queue.addSingleDownloadBatch.mockImplementation((urls: string[]) =>
        batches.enqueue(urls),
      );
      queue.subscriptionBatchList.mockImplementation(() => batches.list());
      const task = await manager.enqueue(url, owner, directory);
      await manager.runDue();
      await batches.runDue();
      time += 30000;
      prepare.mockRejectedValueOnce(missing());
      await manager.runDue();
      const actual = await batches.list();
      expect(actual[0].items[0]).not.toHaveProperty('articleUrl');
      expect(actual[0].items[0].articleUrlHash).toBe(
        createHash('sha256').update(url).digest('hex'),
      );
      expect(
        (await manager.candidates(task.taskId, owner)).articles,
      ).toHaveLength(1);
      queue.subscriptionBatchList.mockResolvedValue([
        {
          ...actual[0],
          items: [{ ...actual[0].items[0], articleUrlHash: '0'.repeat(64) }],
        },
      ]);
      await expect(
        manager.candidates(task.taskId, owner),
      ).rejects.toMatchObject({ status: 409 });
      expect(save).not.toHaveBeenCalled();
    } finally {
      batches.close();
    }
  });
  it('cancellation while rechecking selected cache cannot revive a task or write files', async () => {
    const task = await manager.enqueue(url, owner, directory);
    item.state = 'succeeded';
    item.bodyReady = true;
    batchState = 'completed';
    prepare.mockRejectedValueOnce(missing());
    await manager.runDue();
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const original = readCandidates.getMockImplementation()!;
    readCandidates.mockImplementationOnce(async (...args) => {
      await held;
      return original(...args);
    });
    const selecting = manager.select(
      task.taskId,
      owner,
      'WX_1234567890_2247000001_1',
    );
    for (let i = 0; i < 100 && !readCandidates.mock.calls.length; i++)
      await new Promise((r) => setTimeout(r, 2));
    await manager.cancel(task.taskId, owner);
    release();
    await expect(selecting).rejects.toMatchObject({ status: 409 });
    expect(await manager.get(task.taskId, owner)).toMatchObject({
      state: 'cancelled',
    });
    expect(save).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
  it('paused collection is separate from existing cache and explicit resume checks the same receipt without resuming collection', async () => {
    const task = await manager.enqueue(url, owner, directory);
    item.state = 'blocked';
    batchState = 'paused';
    prepare.mockRejectedValueOnce(missing());
    await manager.runDue();
    expect(await manager.get(task.taskId, owner)).toMatchObject({
      state: 'failed',
      feedId: item.feedId,
      batchState: 'paused',
    });
    expect(prepare).toHaveBeenCalledTimes(1);
    await manager.resume(task.taskId, owner);
    expect(queue.resumeSubscriptionBatch).not.toHaveBeenCalled();
    await manager.runDue();
    expect(await manager.get(task.taskId, owner)).toMatchObject({
      state: 'saved',
    });
    expect(queue.addSingleDownloadBatch).toHaveBeenCalledTimes(1);
    expect(batchState).toBe('paused');
  });
  it('cancel before processing never enqueues a subscription or publishes files', async () => {
    const task = await manager.enqueue(url, owner, directory);
    await manager.cancel(task.taskId, owner);
    await manager.runDue();
    expect(queue.addSingleDownloadBatch).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(await manager.get(task.taskId, owner)).toMatchObject({
      state: 'cancelled',
    });
  });
  it('snapshots private intent and continuing a stopped batch reads cache without re-entering submission', async () => {
    const task = await manager.enqueue(url, owner, directory);
    await manager.runDue();
    const backup = join(root, 'backup', 'database.sqlite');
    await manager.snapshot(backup);
    expect(
      await readFile(
        join(
          root,
          'backup',
          '.wechat2rss-single-downloads',
          task.taskId + '.json',
        ),
        'utf8',
      ),
    ).toBe(
      await readFile(
        join(root, '.wechat2rss-single-downloads', task.taskId + '.json'),
        'utf8',
      ),
    );
    await manager.cancel(task.taskId, owner);
    await manager.resume(task.taskId, owner);
    const raw = JSON.parse(
      await readFile(
        join(root, '.wechat2rss-single-downloads', task.taskId + '.json'),
        'utf8',
      ),
    );
    expect(raw.batchId).toBe(batchId);
    await manager.runDue();
    expect(queue.addSingleDownloadBatch).toHaveBeenCalledTimes(1);
    expect(await manager.get(task.taskId, owner)).toMatchObject({
      state: 'saved',
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(queue.resumeSubscriptionBatch).not.toHaveBeenCalled();
    expect(batchState).toBe('stopped');
  });

  it('an old blocked job exposes same-receipt candidates even when the collection batch is stopped, and chosen cache saves after restart', async () => {
    const task = await manager.enqueue(url, owner, directory);
    await manager.runDue();
    const file = join(
      root,
      '.wechat2rss-single-downloads',
      task.taskId + '.json',
    );
    const raw = JSON.parse(await readFile(file, 'utf8'));
    raw.state = 'blocked';
    await writeFile(file, JSON.stringify(raw));
    item.state = 'blocked';
    batchState = 'stopped';
    const result = await manager.get(task.taskId, owner);
    expect(result).toMatchObject({
      state: 'blocked',
      feedId: item.feedId,
      batchState: 'stopped',
    });
    const options = await manager.candidates(task.taskId, owner);
    await manager.select(task.taskId, owner, options.articles[0].articleId);
    manager.close();
    manager = make();
    await manager.runDue();
    expect(await manager.get(task.taskId, owner)).toMatchObject({
      state: 'saved',
      destination: directory,
    });
    expect(prepare).toHaveBeenCalledWith(
      (await readCandidates(item.feedId!))[0].url,
      item.feedId,
    );
    expect(queue.addSingleDownloadBatch).toHaveBeenCalledTimes(1);
    expect(queue.resumeSubscriptionBatch).not.toHaveBeenCalled();
    expect(batchState).toBe('stopped');
  });

  it('failed job resume reads the latest same-batch revision after upstream has already completed, retaining its native directory', async () => {
    const task = await manager.enqueue(url, owner, directory);
    item.state = 'blocked';
    batchState = 'paused';
    prepare.mockRejectedValueOnce(missing());
    await manager.runDue();
    item.state = 'succeeded';
    item.bodyReady = true;
    batchState = 'completed';
    queue.subscriptionBatchList.mockImplementation(async () => [
      { batchId, items: [item], state: batchState, updatedAt: time + 1000 },
    ]);
    await manager.resume(task.taskId, owner);
    manager.close();
    manager = make();
    await manager.runDue();
    expect(await manager.get(task.taskId, owner)).toMatchObject({
      state: 'saved',
      batchState: 'completed',
      batchUpdatedAt: time + 1000,
      destination: directory,
    });
    expect(queue.addSingleDownloadBatch).toHaveBeenCalledTimes(1);
    expect(queue.resumeSubscriptionBatch).not.toHaveBeenCalled();
  });

  it('stopped receipt with missing exact long-URL body stops after one cache check instead of waiting or resubmitting', async () => {
    const long = (await readCandidates(item.feedId!))[0].url;
    item.articleUrlHash = createHash('sha256').update(long).digest('hex');
    item.state = 'blocked';
    batchState = 'stopped';
    prepare.mockRejectedValue(
      new ArticleDownloadError('未缓存', 409, {
        code: 'WECHAT2RSS_SINGLE_CACHE_MISS',
      }),
    );
    const task = await manager.enqueue(long, owner, directory);
    await manager.runDue();
    expect(await manager.get(task.taskId, owner)).toMatchObject({
      state: 'blocked',
      code: 'WECHAT2RSS_SINGLE_CACHE_MISS',
    });
    time += 30000;
    await manager.runDue();
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(queue.addSingleDownloadBatch).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
  });

  it('new publisher-level title Markdown results survive restart while unrelated-directory or root-escaping results remain invalid', async () => {
    item.state = 'succeeded';
    const target = join(directory, '可信分组', '可信公众号');
    save.mockImplementationOnce(async () => {
      await mkdir(target, { recursive: true });
      const markdownPath = join(target, '合成正文.md');
      await writeFile(markdownPath, '# 新布局');
      return {
        directory: target,
        markdownPath,
        alreadySaved: false,
        imageCount: 0,
      };
    });
    const task = await manager.enqueue(url, owner, directory);
    await manager.runDue();
    manager.close();
    manager = make();
    const result = await manager.get(task.taskId, owner);
    expect(result).toMatchObject({
      state: 'saved',
      destination: directory,
      directory: target,
      markdownPath: join(target, '合成正文.md'),
    });
    const file = join(
      root,
      '.wechat2rss-single-downloads',
      task.taskId + '.json',
    );
    const raw = JSON.parse(await readFile(file, 'utf8'));
    raw.result.markdownPath = join(directory, '其他笔记.md');
    await writeFile(file, JSON.stringify(raw));
    await expect(manager.get(task.taskId, owner)).rejects.toMatchObject({
      status: 404,
    });
    raw.result.directory = root;
    raw.result.markdownPath = join(root, '其他笔记.md');
    await writeFile(file, JSON.stringify(raw));
    await expect(manager.get(task.taskId, owner)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('missing trusted export source remains a source failure rather than a misleading directory error', async () => {
    item.state = 'succeeded';
    save.mockRejectedValueOnce(
      new ArticleDownloadError('来源信息缺失', 409, {
        code: 'EXPORT_SOURCE_MISSING',
      }),
    );
    const task = await manager.enqueue(url, owner, directory);
    await manager.runDue();
    expect(await manager.get(task.taskId, owner)).toMatchObject({
      state: 'failed',
      code: 'SINGLE_EXPORT_SOURCE_MISSING',
      destination: directory,
      message: expect.stringContaining('可信公众号和分组'),
    });
    expect(await readdir(directory)).toEqual([]);
    expect(queue.addSingleDownloadBatch).toHaveBeenCalledTimes(1);
  });
  it('cancel during a late precise-body read cannot revive or save the task', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const original = prepare.getMockImplementation()!;
    prepare.mockImplementation(async (...args) => {
      await hold;
      return original(...args);
    });
    const task = await manager.enqueue(url, owner, directory);
    item.state = 'succeeded';
    const running = manager.runDue();
    for (let i = 0; i < 100 && !prepare.mock.calls.length; i++)
      await new Promise((r) => setTimeout(r, 2));
    await manager.cancel(task.taskId, owner);
    release();
    await running;
    expect(await manager.get(task.taskId, owner)).toMatchObject({
      state: 'cancelled',
    });
    expect(save).not.toHaveBeenCalled();
    expect(queue.stopSubscriptionBatch).toHaveBeenCalledWith(batchId);
  });
  it('user edits stay intact across interrupted saving-state recovery', async () => {
    const task = await manager.enqueue(url, owner, directory);
    item.state = 'succeeded';
    await manager.runDue();
    const done = await manager.get(task.taskId, owner);
    await writeFile(done.markdownPath!, '用户编辑');
    const file = join(
      root,
      '.wechat2rss-single-downloads',
      task.taskId + '.json',
    );
    const raw = JSON.parse(await readFile(file, 'utf8'));
    delete raw.result;
    raw.state = 'saving';
    raw.nextCheckAt = time;
    await writeFile(file, JSON.stringify(raw));
    manager.close();
    manager = make();
    await manager.runDue();
    expect(await readFile(done.markdownPath!, 'utf8')).toBe('用户编辑');
    expect(await manager.get(task.taskId, owner)).toMatchObject({
      state: 'saved',
      alreadySaved: true,
    });
    expect(queue.addSingleDownloadBatch).toHaveBeenCalledTimes(1);
  });
});
