import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { LocalArticleStore } from './article-local-save';
import { prepareCachedArticleLocalExport } from './cached-article-local-export';
import { exportIdentity } from './article-export-source';

jest.mock('node:fs/promises', () => ({
  __esModule: true,
  ...jest.requireActual('node:fs/promises'),
}));
const source = {
  feedId: 'MP_WXS_1234567890',
  feedName: 'Synthetic',
  groupId: 'g',
  groupName: 'Group',
};
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
const preparation = (id = 'one') =>
  prepareCachedArticleLocalExport(
    {
      id,
      title: id,
      sourceUrl: null,
      publishTime: 1791210060,
      metrics: null,
      lastBodyStatus: 'available',
      contentHtml: `<div id="js_content">Body<img src="data:image/png;base64,${png}"></div>`,
    },
    source,
  );

describe('fixed-member retained export scope with real locks/files', () => {
  let root: string, store: LocalArticleStore;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'wewe-batch-scope-'));
    store = new LocalArticleStore(join(root, 'settings.json'), root);
    jest.spyOn(global, 'fetch').mockRejectedValue(Error('NO_NETWORK'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });
  it('indexes once, registers newly published folders, rejects unknown members and expires', async () => {
    const ids = ['one', 'two'].map((id) => preparation(id).identity!);
    const otherRoot = join(root, 'different-preference');
    await fs.mkdir(otherRoot);
    await fs.writeFile(
      join(root, 'settings.json'),
      JSON.stringify({ directory: otherRoot, askEveryTime: false }),
    );

    const scan = jest.spyOn(store as any, 'buildRetainedIndex');
    let escaped!: LocalArticleStore;
    await store.withRetainedBatch(ids, root, async (scoped) => {
      escaped = scoped;
      expect((await scoped.save(preparation('one'))).status).toBe('new');
      expect((await scoped.save(preparation('one'))).status).toBe('skipped');
      expect((await scoped.save(preparation('two'))).status).toBe('new');
      await expect(scoped.save(preparation('unknown'))).rejects.toMatchObject({
        diagnostic: { code: 'SAVE_BATCH_MEMBER' },
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });
    expect(scan).toHaveBeenCalledTimes(1);
    expect(await fs.readdir(otherRoot)).toEqual([]);
    await expect(escaped.save(preparation())).rejects.toMatchObject({
      diagnostic: { code: 'SAVE_BATCH_EXPIRED' },
    });
    expect(
      (await fs.readdir(root)).filter((name) => name.startsWith('.wewe-save-')),
    ).toEqual([]);
    await store.withRetainedBatch(ids, root, async (scoped) =>
      expect((await scoped.save(preparation('two'))).status).toBe('skipped'),
    );
    expect(scan).toHaveBeenCalledTimes(2);
  });
  it('rejects overlapping stores/processes and permits a different external identity', async () => {
    const identity = preparation().identity!;
    await store.withRetainedBatch([identity], root, async (scoped) => {
      const other = new LocalArticleStore(join(root, 'other.json'), root);
      await expect(
        other.withRetainedBatch([identity], root, async () => {}),
      ).rejects.toMatchObject({ diagnostic: { code: 'SAVE_BUSY' } });
      for (const late of [false, true]) {
        const script = `const {LocalArticleStore}=require('./src/article-local-save'); const fs=require('fs/promises'),path=require('path'); const identity=JSON.parse(process.env.SYNTHETIC_IDENTITY); const prepare=async dir=>{await fs.mkdir(path.join(dir,'image'));await fs.writeFile(path.join(dir,'index.md'),'synthetic');return identity}; if(!${late})prepare.identity=identity; new LocalArticleStore('unused',process.env.SYNTHETIC_ROOT).save(prepare).then(()=>{console.log('UNEXPECTED');process.exit(1)},e=>{console.log(e.diagnostic?.code);process.exit(e.diagnostic?.code==='SAVE_BUSY'?0:2)});`;
        const child = spawnSync(
          process.execPath,
          ['-r', 'ts-node/register/transpile-only', '-e', script],
          {
            cwd: join(__dirname, '..'),
            encoding: 'utf8',
            timeout: 30000,
            env: {
              ...process.env,
              SYNTHETIC_ROOT: root,
              SYNTHETIC_IDENTITY: JSON.stringify(identity),
            },
          },
        );
        expect({
          status: child.status,
          stdout: child.stdout.trim(),
          stderr: child.stderr,
        }).toMatchObject({ status: 0, stdout: 'SAVE_BUSY' });
      }
      const original = preparation();
      await expect(
        other.save(async (stage) => original(stage)),
      ).rejects.toMatchObject({ diagnostic: { code: 'SAVE_BUSY' } });
      expect((await other.save(preparation('different'))).status).toBe('new');
      expect((await scoped.save(preparation())).status).toBe('new');
    });
  }, 60000);
  it('releases all acquired locks on callback failure and partial acquisition failure', async () => {
    const ids = ['one', 'two'].map((id) => preparation(id).identity!);
    await expect(
      store.withRetainedBatch(ids, root, async () => {
        throw Error('cancelled');
      }),
    ).rejects.toThrow('cancelled');
    expect(
      (await fs.readdir(root)).filter((name) => name.startsWith('.wewe-save-')),
    ).toEqual([]);
    const held = [...ids]
      .sort((a, b) =>
        exportIdentity(
          JSON.stringify([a.articleId, a.source, a.exportSource!.feedId]),
        ).localeCompare(
          exportIdentity(
            JSON.stringify([b.articleId, b.source, b.exportSource!.feedId]),
          ),
        ),
      )
      .pop()!;
    await store.withRetainedBatch([held], root, async () => {
      const other = new LocalArticleStore('unused', root);
      await expect(
        other.withRetainedBatch(ids, root, async () => {}),
      ).rejects.toMatchObject({ diagnostic: { code: 'SAVE_BUSY' } });
      expect(
        (await fs.readdir(root)).filter((name) =>
          name.startsWith('.wewe-save-'),
        ),
      ).toHaveLength(1);
    });
    expect(
      (await fs.readdir(root)).filter((name) => name.startsWith('.wewe-save-')),
    ).toEqual([]);
    await store.withRetainedBatch(ids, root, async (scoped) =>
      expect((await scoped.save(preparation())).status).toBe('new'),
    );
  });
  it('revalidates edited notes and missing images instead of caching filesystem success', async () => {
    const saved = await store.save(preparation());
    await fs.appendFile(saved.markdownPath, '\nUser edit\n');
    const image = join(
      saved.directory,
      'image',
      (await fs.readdir(join(saved.directory, 'image')))[0],
    );
    await fs.unlink(image);
    await store.withRetainedBatch(
      [preparation().identity!],
      root,
      async (scoped) => {
        const result = await scoped.save(preparation());
        expect(result.status).toBe('repaired');
        expect(await fs.readFile(saved.markdownPath, 'utf8')).toContain(
          'User edit',
        );
        expect((await fs.stat(image)).isFile()).toBe(true);
      },
    );
  });
  it('preserves legacy duplicate detection', async () => {
    for (const name of ['first', 'second']) {
      const folder = join(root, '2026-10-05', name);
      await fs.mkdir(join(folder, 'image'), { recursive: true });
      await fs.writeFile(
        join(folder, '.wewe-article.json'),
        JSON.stringify({ articleId: 'one', complete: true, images: [] }),
      );
      await fs.writeFile(join(folder, '正文.md'), 'Legacy user note');
    }
    await store.withRetainedBatch(
      [preparation().identity!],
      root,
      async (scoped) => {
        await expect(scoped.save(preparation())).rejects.toMatchObject({
          diagnostic: { code: 'SAVE_LEGACY_AMBIGUOUS' },
        });
      },
    );
  });
  it('falls back safely when the directory budget is exceeded', async () => {
    const opendir = jest.spyOn(fs, 'opendir').mockResolvedValueOnce(
      (async function* () {
        for (let n = 0; n < 2049; n++)
          yield {
            name: 'empty' + n,
            isDirectory: () => true,
            isSymbolicLink: () => false,
          };
      })() as any,
    );
    const lstat = jest.spyOn(fs, 'lstat').mockImplementation(
      async (file) =>
        ({
          isDirectory: () => true,
          isSymbolicLink: () => false,
          isFile: () => !String(file).endsWith('.wewe-source.json'),
        }) as any,
    );
    expect(await (store as any).buildRetainedIndex(root)).toBeUndefined();
    opendir.mockRestore();
    lstat.mockRestore();
    jest.spyOn(store as any, 'buildRetainedIndex').mockResolvedValue(undefined);
    const scans = jest.spyOn(fs, 'readdir');
    await store.withRetainedBatch(
      [preparation().identity!],
      root,
      async (scoped) => {
        await scoped.save(preparation());
        await scoped.save(preparation());
      },
    );
    expect(
      scans.mock.calls.filter(([directory]) => directory === root),
    ).toHaveLength(2);
  });
  it('bounds the path index byte budget before the directory count budget', async () => {
    const group = 'group-' + 'x'.repeat(180);
    const opendir = jest.spyOn(fs, 'opendir').mockImplementation(
      async (directory) =>
        (async function* () {
          if (directory === root)
            yield {
              name: group,
              isDirectory: () => true,
              isSymbolicLink: () => false,
            };
          else
            for (let n = 0; n < 1900; n++)
              yield {
                name: 'publisher-' + n + 'x'.repeat(140),
                isDirectory: () => true,
                isSymbolicLink: () => false,
              };
        })() as any,
    );
    const lstat = jest.spyOn(fs, 'lstat').mockImplementation(
      async () =>
        ({
          isDirectory: () => true,
          isSymbolicLink: () => false,
          isFile: () => true,
        }) as any,
    );
    const read = jest
      .spyOn(fs, 'readFile')
      .mockResolvedValue(JSON.stringify({ identity: 'synthetic-marker' }));
    expect(await (store as any).buildRetainedIndex(root)).toBeUndefined();
    expect(read.mock.calls.length).toBeLessThan(1900);
    opendir.mockRestore();
    lstat.mockRestore();
    read.mockRestore();
  });
  it('drains an accepted save before releasing locks when the callback returns early', async () => {
    let operation!: ReturnType<LocalArticleStore['save']>;
    let escaped!: LocalArticleStore;
    await store.withRetainedBatch(
      [preparation().identity!],
      root,
      async (scoped) => {
        escaped = scoped;
        operation = scoped.save(preparation());
      },
    );
    expect((await operation).status).toBe('new');
    await expect(escaped.save(preparation())).rejects.toMatchObject({
      diagnostic: { code: 'SAVE_BATCH_EXPIRED' },
    });
    expect(
      (await fs.readdir(root)).filter((name) => name.startsWith('.wewe-save-')),
    ).toEqual([]);
  });
});
