import { ConfigService } from '@nestjs/config';
import { TrpcRouter } from '../trpc/trpc.router';
import { TrpcService } from '../trpc/trpc.service';
it('rejects read-only review context and accepts authenticated local write context',async()=>{
 const config=new ConfigService({auth:{code:'synthetic'},platform:{url:''},feed:{updateDelayTime:0}});
 const whole:any={reviewUnknown:jest.fn(async()=>({state:'recorded',executionAllowed:false}))};
 const router=new TrpcRouter(new TrpcService({} as any,config,{} as any,{} as any),{} as any,config,{} as any,{} as any,undefined,undefined,undefined,undefined,whole).appRouter;
 const input={jobId:'synthetic',expectedAuthorId:'author',expectedNoteId:'note',expectedMarker:'xhs:dispatch-pending:whole:00000000-0000-4000-8000-000000000001',decision:'request-retry' as const};
 await expect(router.createCaller({errorMsg:null,isLocalSave:false,isLocalXhsRead:true}).xiaohongshu.reviewWholeCreatorUnknown(input)).rejects.toMatchObject({code:'FORBIDDEN'});
 expect(whole.reviewUnknown).not.toHaveBeenCalled();
 await expect(router.createCaller({errorMsg:null,isLocalSave:true}).xiaohongshu.reviewWholeCreatorUnknown(input)).resolves.toMatchObject({state:'recorded'});
 expect(whole.reviewUnknown).toHaveBeenCalledTimes(1);
});
