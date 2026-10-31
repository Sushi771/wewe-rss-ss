import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { ConfigService } from '@nestjs/config';
import { XiaohongshuService } from './collection/xiaohongshu.service';
import { LocalArticleStore } from './article-local-save';
import { ArticleDownloadController } from './article-download.controller';
import {
  freezeCachedXhsSelection,
  saveFrozenXhsCache,
} from './xhs-cached-local-export';
import { pickArticleDirectory } from './article-folder-picker';
jest.mock('./article-folder-picker', () => ({
  pickArticleDirectory: jest.fn(),
}));

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/f9sAAAAASUVORK5CYII=';
describe('frozen cached XHS export scope without source fallback', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'wewe-cached-scope-'));
    jest.spyOn(global, 'fetch').mockRejectedValue(Error('NO_SOURCE'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    jest.mocked(pickArticleDirectory).mockReset();
    if (
      path.dirname(root) === tmpdir() &&
      path.basename(root).startsWith('wewe-cached-scope-')
    )
      await fs.rm(root, { recursive: true, force: true });
  });
  function fixture(count = 130) {
    const creator = {
      id: 'creator',
      displayName: '中文博主',
      groupId: 'group',
      group: { id: 'group', name: '中文分组' },
    };
    const rows = Array.from({ length: count }, (_, i) => ({
      id: JSON.stringify(['xiaohongshu', 'note', 'fixture-' + i]),
      creatorId: 'creator',
      title: '笔记 ' + i,
      publishTime: 1792368000,
      kind: 'image-text',
      status: 'complete',
      contentHtml:
        '<div id="js_content"><p>缓存正文</p><img src="data:image/png;base64,' +
        png +
        '"></div>',
      videoBytes: null,
      videoMimeType: null,
      videoExpectedBytes: null,
      videoSha256: null,
      creator,
    }));
    const db: any = {
      xhsNote: {
        findMany: jest.fn(async ({ where }: any) =>
          rows.filter((row) => where.id.in.includes(row.id)),
        ),
        findFirst: jest.fn(
          async ({ where }: any) =>
            rows.find(
              (row) =>
                row.id === where.id &&
                row.creatorId === where.creatorId &&
                (!where.status || row.status === where.status),
            ) || null,
        ),
      },
      xhsCreator: { findUnique: async () => creator },
      managementGroup: { findUnique: async () => creator.group },
    };
    const source = {
      read: jest.fn().mockRejectedValue(Error('SOURCE_FORBIDDEN')),
    };
    const service = new XiaohongshuService(db, source as any);
    jest.spyOn(service as any, 'exportEngagement').mockResolvedValue('');
    return {
      rows,
      db,
      service,
      source,
      items: rows.map((row) => ({ id: row.id, creatorId: row.creatorId })),
    };
  }
  it('one native selection covers >100 ordered targets, mixed missing cache, replay and hand edits with zero source calls', async () => {
    const f = fixture();
    f.rows[2].status = 'pending';
    f.rows[3].contentHtml =
      '<div id="js_content"><img src="https://unverified.invalid/a.png"></div>';
    const store = new LocalArticleStore(
      path.join(root, 'settings.json'),
      root,
      true,
    );
    const controller = new ArticleDownloadController(
      new ConfigService(),
      f.db,
      undefined,
      f.service,
    );
    const internal = controller as any;
    jest.spyOn(internal, 'authorized').mockReturnValue(true);
    jest.spyOn(internal, 'localStore').mockImplementation((target: any) => {
      expect(target).toBe('xiaohongshu');
      return store;
    });
    jest.mocked(pickArticleDirectory).mockResolvedValue(root);
    const req: any = Object.assign(new EventEmitter(), {
      query: {},
      aborted: false,
    });
    const res: any = Object.assign(new EventEmitter(), {
      writableEnded: false,
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    });
    await controller.exportXhsCachedSelection({ items: f.items }, req, res);
    expect(pickArticleDirectory).toHaveBeenCalledTimes(1);
    expect(pickArticleDirectory).toHaveBeenCalledWith(
      root,
      expect.objectContaining({ count: 130, platform: 'xiaohongshu' }),
    );
    const receipt = res.json.mock.calls[0][0];
    expect(receipt.results.map((x: any) => x.id)).toEqual(
      f.items.map((x) => x.id),
    );
    expect(receipt.results.filter((x: any) => x.error)).toHaveLength(2);
    expect(receipt.results[2].error).toBe('XHS_CACHED_ARTICLE_UNAVAILABLE');
    expect(receipt.results[3].error).toBe('VERIFIED_ARTICLE_UNAVAILABLE');
    const note = receipt.results[0].saved.markdownPath;
    await fs.writeFile(note, '手工保留');
    res.json.mockClear();
    await controller.exportXhsCachedSelection({ items: f.items }, req, res);
    expect(res.json.mock.calls[0][0].results[0].saved.alreadySaved).toBe(true);
    expect(await fs.readFile(note, 'utf8')).toBe('手工保留');
    expect(f.source.read).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(internal.xhsPickerGrant).toBeUndefined();
  }, 30000);
  it('rejects duplicate or foreign membership before any preparation or picker', async () => {
    const f = fixture(2);
    await expect(
      freezeCachedXhsSelection(f.db, [f.items[0], f.items[0]]),
    ).rejects.toThrow();
    await expect(
      freezeCachedXhsSelection(f.db, [{ ...f.items[0], creatorId: 'foreign' }]),
    ).rejects.toThrow('XHS_SELECTION_CHANGED');
    expect(pickArticleDirectory).not.toHaveBeenCalled();
    expect(f.source.read).not.toHaveBeenCalled();
  });
  it('cancel after one atomic article stops next members and preserves the completed receipt', async () => {
    const f = fixture(70);
    const frozen = await freezeCachedXhsSelection(f.db, f.items);
    const store = new LocalArticleStore(path.join(root, 'settings.json'), root);
    let cancelled = false;
    const result = await saveFrozenXhsCache(
      frozen,
      store,
      root,
      async (c, id) => {
        const prepare = await f.service.prepareLocalDownload(c, id);
        prepare.afterSave = async () => {
          cancelled = true;
          return undefined;
        };
        return prepare;
      },
      () => cancelled,
    );
    expect(result.cancelled).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].saved).toBeDefined();
    expect(
      await fs.readFile(result.results[0].saved!.markdownPath, 'utf8'),
    ).toContain('缓存正文');
    expect(f.source.read).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('HTTP disconnect stops later articles, returns no complete acknowledgement and releases locks', async () => {
    const f = fixture(70);
    const store = new LocalArticleStore(path.join(root, 'settings.json'), root);
    const controller = new ArticleDownloadController(
      new ConfigService(),
      f.db,
      undefined,
      f.service,
    );
    const internal = controller as any;
    jest.spyOn(internal, 'authorized').mockReturnValue(true);
    jest.spyOn(internal, 'localStore').mockReturnValue(store);
    const req: any = Object.assign(new EventEmitter(), {
      query: {},
      aborted: false,
    });
    const res: any = Object.assign(new EventEmitter(), {
      writableEnded: false,
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    });
    const original = f.service.prepareLocalDownload.bind(f.service);
    let prepared = 0;
    jest
      .spyOn(f.service, 'prepareLocalDownload')
      .mockImplementation(async (c, id) => {
        prepared++;
        const prepare = await original(c, id);
        prepare.afterSave = async () => {
          res.emit('close');
          return undefined;
        };
        return prepare;
      });
    await controller.exportXhsCachedSelection({ items: f.items }, req, res);
    expect(prepared).toBe(1);
    expect(res.json).not.toHaveBeenCalled();
    expect(internal.running).toBe(false);
    expect(f.source.read).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('native cancellation authorizes no files or reusable token', async () => {
    const f = fixture(2);
    const store = new LocalArticleStore(
      path.join(root, 'settings.json'),
      root,
      true,
    );
    const controller = new ArticleDownloadController(
      new ConfigService(),
      f.db,
      undefined,
      f.service,
    );
    const internal = controller as any;
    jest.spyOn(internal, 'authorized').mockReturnValue(true);
    jest.spyOn(internal, 'localStore').mockReturnValue(store);
    const prepare = jest.spyOn(f.service, 'prepareLocalDownload');
    jest.mocked(pickArticleDirectory).mockResolvedValue(null);
    const req: any = Object.assign(new EventEmitter(), {
      query: {},
      aborted: false,
    });
    const res: any = Object.assign(new EventEmitter(), {
      writableEnded: false,
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    });
    await controller.exportXhsCachedSelection({ items: f.items }, req, res);
    expect(res.json).toHaveBeenCalledWith({ results: [], cancelled: true });
    expect(prepare).not.toHaveBeenCalled();
    expect(internal.xhsPickerGrant).toBeUndefined();
    expect(f.source.read).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('already destroyed scope response cannot prompt or publish a frozen selection', async () => {
    const f = fixture(2);
    const store = new LocalArticleStore(
      path.join(root, 'settings.json'),
      root,
      true,
    );
    const controller = new ArticleDownloadController(
      new ConfigService(),
      f.db,
      undefined,
      f.service,
    );
    const internal = controller as any;
    jest.spyOn(internal, 'authorized').mockReturnValue(true);
    jest.spyOn(internal, 'localStore').mockReturnValue(store);
    const prepare = jest.spyOn(f.service, 'prepareLocalDownload');
    const req: any = Object.assign(new EventEmitter(), {
      query: {},
      aborted: false,
    });
    const res: any = Object.assign(new EventEmitter(), {
      destroyed: true,
      writableEnded: false,
      setHeader: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
    });
    await controller.exportXhsCachedSelection({ items: f.items }, req, res);
    expect(pickArticleDirectory).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalled();
    expect(internal.running).toBe(false);
  });

  function auditEndpoint(){
    const f=fixture(2),store=new LocalArticleStore(path.join(root,'settings.json'),root,true);
    const c=new ArticleDownloadController(new ConfigService({auth:{code:'synthetic-auth'}}),f.db,undefined,f.service);
    jest.spyOn(c as any,'localStore').mockReturnValue(store);
    const req:any=Object.assign(new EventEmitter(),{protocol:'http',get:()=> 'localhost:4777',socket:{remoteAddress:'127.0.0.1'},headers:{authorization:'synthetic-auth',origin:'http://localhost:4777'},query:{},aborted:false});
    const res:any=Object.assign(new EventEmitter(),{writableEnded:false,setHeader:jest.fn(),status:jest.fn().mockReturnThis(),json:jest.fn().mockReturnThis()});
    return {f,store,c,req,res};
  }
  it('confirmed remembered XHS directory exports the frozen cache once without a native dialog or source',async()=>{
    const h=auditEndpoint();h.req.query={target:'xiaohongshu'};
    const settings=await h.store.read();
    await h.c.confirmXhsDirectory({directory:settings.directory},h.req,h.res);
    const grant=h.res.json.mock.calls[0][0].pickToken;expect(grant).toBeTruthy();h.res.json.mockClear();
    await h.c.exportXhsCachedSelection({items:h.f.items,pickToken:grant},h.req,h.res);
    expect(h.res.json.mock.calls[0][0].results).toHaveLength(2);expect(pickArticleDirectory).not.toHaveBeenCalled();expect(global.fetch).not.toHaveBeenCalled();expect(h.f.source.read).not.toHaveBeenCalled();
    h.res.status.mockClear();await h.c.exportXhsCachedSelection({items:h.f.items,pickToken:grant},h.req,h.res);expect(h.res.status).toHaveBeenCalledWith(400);
  });
  it.each(['no-origin','foreign-origin','bad-auth','remote-client'])('AUDIT: authenticates %s before freezing or native selection',async mode=>{
    const h=auditEndpoint();
    if(mode==='no-origin')delete h.req.headers.origin;
    if(mode==='foreign-origin')h.req.headers.origin='https://foreign.invalid';
    if(mode==='bad-auth')h.req.headers.authorization='wrong';
    if(mode==='remote-client')h.req.socket.remoteAddress='192.0.2.1';
    await h.c.exportXhsCachedSelection({items:h.f.items},h.req,h.res);
    expect(h.res.status).toHaveBeenCalledWith(mode==='bad-auth'?401:403);
    expect(h.f.db.xhsNote.findMany).not.toHaveBeenCalled();expect(pickArticleDirectory).not.toHaveBeenCalled();expect(global.fetch).not.toHaveBeenCalled();
  });
  it.each(['path','pickToken','platform'])('AUDIT: rejects injected %s instead of accepting an old grant',async field=>{
    const h=auditEndpoint();(h.c as any).xhsPickerGrant='old-grant';
    await h.c.exportXhsCachedSelection({items:h.f.items,[field]:field==='path'?'C:\\forbidden':'old-grant'},h.req,h.res);
    expect(h.res.status).toHaveBeenCalledWith(400);expect(h.f.db.xhsNote.findMany).not.toHaveBeenCalled();expect(pickArticleDirectory).not.toHaveBeenCalled();
  });
  it('AUDIT: valid same-origin authenticated request freezes metadata before native choice and prompts again on repetition',async()=>{
    const h=auditEndpoint();
    jest.mocked(pickArticleDirectory).mockImplementation(async()=>{
      expect(h.f.db.xhsNote.findMany).toHaveBeenCalledTimes(1);
      h.f.rows[0].title='changed after selection';h.f.rows[0].creator.displayName='changed creator';h.f.rows[0].publishTime=0;
      return root;
    });
    await h.c.exportXhsCachedSelection({items:h.f.items},h.req,h.res);
    const receipt=h.res.json.mock.calls[0][0];expect(receipt.results).toHaveLength(2);
    expect(receipt.results[0].saved.markdownPath).toContain('笔记 0.md');
    expect(await fs.readFile(receipt.results[0].saved.markdownPath,'utf-8')).toContain('博主：中文博主');
    expect((h.c as any).xhsPickerGrant).toBeUndefined();
    jest.mocked(pickArticleDirectory).mockResolvedValue(root);h.res.json.mockClear();
    await h.c.exportXhsCachedSelection({items:h.f.items},h.req,h.res);
    expect(pickArticleDirectory).toHaveBeenCalledTimes(2);expect(global.fetch).not.toHaveBeenCalled();expect(h.f.source.read).not.toHaveBeenCalled();
  });
  it('AUDIT: 5001 selected IDs reject before querying or prompting',async()=>{
    const h=auditEndpoint();await h.c.exportXhsCachedSelection({items:Array.from({length:5001},(_,i)=>({id:'id'+i,creatorId:'creator'}))},h.req,h.res);
    expect(h.res.status).toHaveBeenCalledWith(400);expect(h.f.db.xhsNote.findMany).not.toHaveBeenCalled();expect(pickArticleDirectory).not.toHaveBeenCalled();
  });
});
