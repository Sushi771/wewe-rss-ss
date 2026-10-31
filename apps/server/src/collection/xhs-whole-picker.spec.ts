import {ArticleDownloadController} from '../article-download.controller';
import {safeSourceFailure} from './xhs-source-receipt';
describe('whole creator directory grant',()=>{
 let controller:any,reserve:(token?:string)=>Promise<string>;
 beforeEach(()=>{const subscriptions={bindLocalSaver:(r:any)=>{reserve=r;}};controller=new ArticleDownloadController({} as any,undefined,undefined,undefined,undefined,undefined,subscriptions as any);});
 afterEach(()=>controller.onModuleDestroy());
 it('consumes a selected token once and reports a fixed local code without exposing a message',async()=>{
  controller.localStore=()=>({read:async()=>({directory:'synthetic-target',askEveryTime:true})});controller.xhsPickerGrant='synthetic-grant';
  expect(await reserve('synthetic-grant')).toBe('synthetic-target');let failure:any;try{await reserve('synthetic-grant');}catch(e){failure=e;}
  expect(safeSourceFailure(failure,'admitted').code).toBe('XHS_SAVE_DIRECTORY_SELECTION_REQUIRED');expect(safeSourceFailure(new Error('synthetic-private-path'),'admitted').code).toBe('XHS_LOCAL_OPERATION_FAILED');
 });
 it('locks policy updates while the directory grant is being read',async()=>{
  let release!:()=>void, entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);let setCalls=0;
  controller.localStore=()=>({read:async()=>{entered();await gate;return {directory:'synthetic-target',askEveryTime:false};},setAskEveryTime:async()=>{setCalls++;}});controller.authorized=()=>true;
  const pending=reserve();await started;let status=0;const res:any={status:(v:number)=>{status=v;return res;},json:()=>res};
  try{await controller.updateSettings({askEveryTime:true},{query:{target:'xiaohongshu'}} as any,res);expect(status).toBe(409);expect(setCalls).toBe(0);}finally{release();}expect(await pending).toBe('synthetic-target');
 });
 it('confirms only the current XHS target and consumes its one-use grant',async()=>{
  controller.authorized=()=>true;controller.localStore=()=>({read:async()=>({directory:'synthetic-target',askEveryTime:true})});
  let status=200,payload:any;const res:any={status:(v:number)=>{status=v;return res;},setHeader:()=>res,json:(v:any)=>{payload=v;return res;}};
  const req:any={query:{target:'xiaohongshu'}};
  await controller.confirmXhsDirectory({directory:'old-target'},req,res);expect(status).toBe(409);expect(controller.xhsPickerGrant).toBeUndefined();
  status=200;await controller.confirmXhsDirectory({directory:'synthetic-target'},req,res);expect(status).toBe(200);expect(payload.pickToken).toBeTruthy();
  expect(await reserve(payload.pickToken)).toBe('synthetic-target');await expect(reserve(payload.pickToken)).rejects.toThrow();
  status=200;await controller.confirmXhsDirectory({directory:'synthetic-target'},{query:{}} as any,res);expect(status).toBe(409);
 });
});
