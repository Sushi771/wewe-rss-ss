import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { XiaohongshuService } from './xiaohongshu.service';
import { LocalArticleStore } from '../article-local-save';

const noteId = 'synthetic-original';
const canonical = 'https://www.xiaohongshu.com/explore/' + noteId;
const note = {
  id: JSON.stringify(['xiaohongshu', 'note', noteId]),
  creatorId: 'synthetic-creator',
  title: 'Synthetic original title',
  kind: 'image-text',
  status: 'complete',
  publishTime: 1760000000,
  contentHtml: '<div id="js_content"><p>Synthetic complete body.</p></div>',
  videoBytes: null,
  videoMimeType: null,
  videoExpectedBytes: null,
  videoSha256: null,
};
const service = (row = note) => {
  const cache = new XiaohongshuService({
    xhsNote: { findFirst: async () => row },
    xhsCreator: { findUnique: async ({where}:any) => where.id==='synthetic-creator'?{id:where.id,displayName:'Synthetic creator',externalAuthorId:'synthetic-author',groupId:null}:null },
  } as any);
  // This isolated identity/saver oracle has no database. Real snapshot storage
  // remains covered by the synthetic SQLite integration suite.
  jest.spyOn(cache, 'engagement').mockResolvedValue({
    metrics: null,
    creatorMetrics: null,
    comments: [],
    windows: [],
    totalSaved: 0,
    returned: 0,
    offset: 0,
  });
  return cache;
};

it('writes exactly one clickable canonical original and one title; repeat preserves handwritten Markdown', async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'xhs-original-link-'));
  const prepare = await service().prepareLocalDownload(note.creatorId, note.id);
  const store = new LocalArticleStore(path.join(root, 'settings.json'), root);
  const save = () =>
    store.save(
      async (stage) => ({
        ...(await prepare(stage)),
        exportSource: { feedId: note.creatorId, feedName: 'Synthetic creator' },
      }),
      new Date('2026-10-25T00:00:00Z'),
      root,
    );
  const first = await save();
  expect(first.alreadySaved).toBe(false);
  const markdown = await fs.readFile(first.markdownPath, 'utf8');
  expect(path.basename(first.markdownPath)).toBe('Synthetic original title.md');
  expect(markdown).not.toMatch(/^# Synthetic original title$/m);
  expect(
    markdown.match(
      /https:\/\/www\.xiaohongshu\.com\/explore\/synthetic-original/g,
    ),
  ).toHaveLength(1);
  expect(markdown).toContain('原文链接：' + canonical);
  expect(markdown).toContain('Synthetic complete body.');
  const edited = markdown + '\nHandwritten local note.\n';
  await fs.writeFile(first.markdownPath, edited);
  const before = (await fs.stat(first.markdownPath)).mtimeMs;
  expect(await save()).toMatchObject({
    alreadySaved: true,
    markdownPath: first.markdownPath,
  });
  expect(await fs.readFile(first.markdownPath, 'utf8')).toBe(edited);
  expect((await fs.stat(first.markdownPath)).mtimeMs).toBe(before);
});

it.each([
  'not-json',
  JSON.stringify(['other', 'note', noteId]),
  JSON.stringify(['xiaohongshu', 'author', noteId]),
  JSON.stringify(['xiaohongshu', 'note', 'bad)\n[link](https://evil.test)']),
])(
  'refuses an invalid cached identity before constructing a source link: %s',
  async (id) => {
    await expect(
      service({ ...note, id }).prepareLocalDownload(note.creatorId, id),
    ).rejects.toMatchObject({
      diagnostic: { code: 'XHS_CACHED_NOTE_ID_INVALID' },
    });
  },
);

it('rejects an orphan cached note with HTTP422 before preparing or publishing files',async()=>{
 const findFirst=jest.fn(async()=>note);
 const cache=new XiaohongshuService({xhsNote:{findFirst},xhsCreator:{findUnique:async()=>null}} as any);
 await expect(cache.prepareLocalDownload(note.creatorId,note.id)).rejects.toMatchObject({status:422});
 expect(findFirst).toHaveBeenCalledWith({where:{id:note.id,creatorId:note.creatorId,status:'complete'}});
});
