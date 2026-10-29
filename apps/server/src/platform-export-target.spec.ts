import {homedir} from 'node:os';
import {DEFAULT_ARTICLE_DIRECTORY} from './article-local-save';
import { ArticleDownloadController } from './article-download.controller';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

describe('platform directory settings and grants', () => {
  it('isolates XHS preferences and rejects a WeChat grant at the subscription boundary', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'wewe-platform-target-'));
    const previous = process.env.DATABASE_URL;
    const acceptance = process.env.WEWE_ACCEPTANCE_MODE;
    const online = process.env.WEWE_PRIVATE_ONLINE_MODE;
    process.env.DATABASE_URL = 'file:' + path.join(root, 'fixture.db');
    delete process.env.WEWE_ACCEPTANCE_MODE;
    delete process.env.WEWE_PRIVATE_ONLINE_MODE;
    let save: any;
    let reserve: (token?: string) => Promise<string>;
    try {
      const controller = new ArticleDownloadController(
        new ConfigService(),
        undefined,
        undefined,
        {
          prepareLocalDownload: async () => {
            const identity = {
              articleId: 'fixture-note',
              title: '中文笔记',
              imageCount: 0,
              publishTime: 1792368000,
              exportSource: {
                feedId: 'creator',
                feedName: '中文博主',
                platform: 'xiaohongshu',
              },
            };
            const prepare: any = async (stage: string) => {
              await fs.mkdir(path.join(stage, 'image'));
              await fs.writeFile(path.join(stage, 'index.md'), '正文');
              return identity;
            };
            prepare.identity = identity;
            return prepare;
          },
        } as any,
        undefined,
        undefined,
        {
          bindLocalSaver: (r: any, saver: any) => {
            reserve = r;
            save = saver;
          },
        } as any,
      );
      const internal = controller as any;
      const wechat = internal.localStore();
      const xhs = internal.localStore('xiaohongshu');
      await fs.mkdir(path.join(root, '公众号的文章（待分类）'));
      await fs.mkdir(path.join(root, '小红书的内容（待分类）'));
      await wechat.rememberPickedDirectory(
        path.join(root, '公众号的文章（待分类）'),
      );
      await xhs.rememberPickedDirectory(
        path.join(root, '小红书的内容（待分类）'),
      );
      await xhs.setAskEveryTime(true);
      expect((await wechat.read()).askEveryTime).toBe(false);
      internal.pickerGrant = 'wechat-only';
      await expect(reserve!('wechat-only')).rejects.toThrow();
      internal.xhsPickerGrant = 'xhs-only';
      expect(await reserve!('xhs-only')).toBe(
        path.join(root, '小红书的内容（待分类）'),
      );
      expect((await wechat.read()).directory).toBe(
        path.join(root, '公众号的文章（待分类）'),
      );
      await xhs.setAskEveryTime(false);
      jest.spyOn(internal, 'authorized').mockReturnValue(true);
      const response: any = {
        setHeader: jest.fn(),
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };

      // Independent platform-grant rejection before cached preparation.
      await xhs.setAskEveryTime(true);
      internal.xhsPickerGrant='xhs-grant';internal.pickerGrant='wechat-grant';
      const prepareSpy=jest.spyOn(internal.xiaohongshu,'prepareLocalDownload');
      await controller.saveXhsNote('fixture-note',{creatorId:'creator',pickToken:'wechat-grant'},{} as any,response);
      expect(response.status).toHaveBeenLastCalledWith(409);expect(await fs.readdir((await xhs.read()).directory)).toEqual([]);expect(internal.xhsPickerGrant).toBe('xhs-grant');prepareSpy.mockClear();
      await controller.saveXhsNotes({creatorId:'creator',noteIds:['fixture-note'],pickToken:'wechat-grant'},{} as any,response);
      expect(response.status).toHaveBeenLastCalledWith(409);expect(prepareSpy).not.toHaveBeenCalled();
      await controller.saveXhsNote('fixture-note',{creatorId:'creator',pickToken:'xhs-grant'},{} as any,response);
      expect(response.status).toHaveBeenLastCalledWith(200);expect(internal.pickerGrant).toBe('wechat-grant');
      await controller.saveXhsNote('fixture-note',{creatorId:'creator',pickToken:'xhs-grant'},{} as any,response);
      expect(response.status).toHaveBeenLastCalledWith(409);
      await xhs.setAskEveryTime(false);prepareSpy.mockClear();
      await expect(save({id:'creator'},'fixture-note',path.join(root,'公众号的文章（待分类）'))).rejects.toThrow();
      expect(prepareSpy).not.toHaveBeenCalled();
      // Freeze a running subscription save while another tab changes settings.
      const realPrepare=prepareSpy.getMockImplementation();
      let release:any,entered:any;
      const enteredPromise=new Promise<void>(r=>{entered=r});
      prepareSpy.mockImplementationOnce(async(...args:any[])=>{entered();await new Promise<void>(r=>{release=r});return realPrepare!.apply(internal.xiaohongshu,args)});
      const pending=save({id:'creator'},'fixture-note',path.join(root,'小红书的内容（待分类）'));
      await enteredPromise;
      await controller.updateSettings({askEveryTime:true},{query:{target:'xiaohongshu'}} as any,response);
      expect(response.status).toHaveBeenLastCalledWith(409);
      expect((await xhs.read()).askEveryTime).toBe(false);
      release();await pending;prepareSpy.mockRestore();
      await controller.saveXhsNote(
        'fixture-note',
        { creatorId: 'creator' },
        {} as any,
        response,
      );
      expect(response.status).toHaveBeenLastCalledWith(200);
      await controller.saveXhsNotes(
        { creatorId: 'creator', noteIds: ['fixture-note'] },
        {} as any,
        response,
      );
      expect(response.status).toHaveBeenLastCalledWith(200);
      const saved = await save(
        { id: 'creator' },
        'fixture-note',
        path.join(root, '小红书的内容（待分类）'),
      );
      expect(saved.alreadySaved).toBe(true);
      await expect(
        save(
          { id: 'creator' },
          'fixture-note',
          path.join(root, '公众号的文章（待分类）'),
        ),
      ).rejects.toThrow();
      expect(
        await fs.readdir(path.join(root, '公众号的文章（待分类）')),
      ).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      if (acceptance === undefined) delete process.env.WEWE_ACCEPTANCE_MODE;
      else process.env.WEWE_ACCEPTANCE_MODE = acceptance;
      if (online === undefined) delete process.env.WEWE_PRIVATE_ONLINE_MODE;
      else process.env.WEWE_PRIVATE_ONLINE_MODE = online;
      if (
        path.dirname(root) === tmpdir() &&
        path.basename(root).startsWith('wewe-platform-target-')
      )
        await fs.rm(root, { recursive: true, force: true });
    }
  });
});

it('uses the current home without embedding a personal absolute path',()=>{
 expect(DEFAULT_ARTICLE_DIRECTORY).toBe(path.join(homedir(),'Documents','Obsidian Vault','公众号的文章（待分类）'));
});
