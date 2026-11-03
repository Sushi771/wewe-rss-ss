import { selectMissingBasic } from './xhs-missing-basic';
import { XhsSubscriptionService } from './xhs-subscription.service';

describe('local missing basic selection',()=>{
  const complete={values:{likes:0,collects:2,shares:3,comments:4},collectedAt:100,contract:'synthetic',evidence:'source-only'};
  let jobs:any[]=[], limited:any[]=[];
  const db:any={xhsNote:{findMany:jest.fn(async(input:any)=>[{id:'complete',publishTime:1},{id:'missing',publishTime:1}].filter(row=>input.where.id.in.includes(row.id)))},
    $queryRaw:jest.fn(async(sql:TemplateStringsArray)=>sql.join('').includes('xhs_whole_creator_jobs')?jobs:sql.join('').includes('xhs_limited_recovery')?limited:[{owner_id:'complete',document:JSON.stringify(complete)},{owner_id:'missing',document:JSON.stringify({...complete,values:{...complete.values,shares:null}})}])};
  it('returns only requested notes with missing exact basic fields',async()=>{
    await expect(selectMissingBasic(db,'creator',['complete','missing'])).resolves.toEqual({noteIds:['missing'],complete:['complete']});
  });
  it('rejects duplicate or foreign notes before any scheduling',async()=>{
    await expect(selectMissingBasic(db,'creator',['complete','complete'])).rejects.toThrow('XHS_SELECTION_INVALID');
    await expect(selectMissingBasic(db,'creator',['foreign'])).rejects.toThrow('XHS_SELECTION_INVALID');
  });
  it('refuses historical unknown details rather than scheduling them',async()=>{
    const id=JSON.stringify(['xiaohongshu','note','missing']);
    const guarded:any={...db,xhsNote:{findMany:async()=>[{id,publishTime:0}]}};
    jobs=[{document:JSON.stringify({generation:{reviews:[{fence:{phase:'detail',noteId:'missing'}}]}})}];
    const service=new XhsSubscriptionService(guarded,{} as any),enqueue=jest.spyOn(service,'refreshFull');
    try {await expect(service.refreshMissingBasic({id:'creator',noteIds:[id]})).rejects.toThrow('XHS_WHOLE_SOURCE_FENCE_BLOCKED');expect(enqueue).not.toHaveBeenCalled();}
    finally {jobs=[];}
  });
  it('refuses an unresolved limited recovery for the selected note',async()=>{
    const id=JSON.stringify(['xiaohongshu','note','missing']);
    const guarded:any={...db,xhsNote:{findMany:async()=>[{id,publishTime:0}]}};limited=[{note_id:'missing'}];
    const service=new XhsSubscriptionService(guarded,{} as any),enqueue=jest.spyOn(service,'refreshFull');
    try {await expect(service.refreshMissingBasic({id:'creator',noteIds:[id]})).rejects.toThrow('XHS_WHOLE_SOURCE_FENCE_BLOCKED');expect(enqueue).not.toHaveBeenCalled();}
    finally {limited=[];}
  });
  it('the product entry delegates the narrowed subset to the existing guarded selected queue',async()=>{
    const service=new XhsSubscriptionService(db,{} as any);
    const enqueue=jest.spyOn(service,'refreshFull').mockResolvedValue({taskId:'synthetic'} as any);
    await service.refreshMissingBasic({id:'creator',noteIds:['complete','missing']});
    expect(enqueue).toHaveBeenCalledWith({id:'creator',scope:'selected',noteIds:['missing'],basicOnly:true,reuseCompleteCache:true});
    await expect(service.refreshMissingBasic({id:'creator',noteIds:['complete']})).resolves.toEqual({state:'nothing-missing'});
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
});
