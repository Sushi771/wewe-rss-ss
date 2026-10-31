jest.mock('./xhs-whole-generation', () => ({ generationMatches: () => true, generationReviewSettled: () => true, verifiedReviewedNoteIds: () => [] }));
jest.mock('./xhs-generation-review', () => ({ generationReviewMarkers: () => ['xhs:dispatch-pending:whole:2'] }));
import { prepareHistoryHandoff } from './xhs-history-handoff';

function fixture() {
  const job = {id:'job',creatorId:'creator',state:'partial',sourceGrant:{authorId:'author'},generation:{id:'generation',selectedIds:['safe'],origin:{budgets:[{id:'job',used:1,request_limit:10,interval_ms:1},{id:'xhs:source-total',used:1,request_limit:10,interval_ms:1}],fence:{phase:'detail',noteId:'old',marker:'xhs:dispatch-pending:whole:1'}},reviews:[{fence:{phase:'detail',noteId:'other',marker:'xhs:dispatch-pending:whole:2'}}]}};
  const result:any[] = [[{document:JSON.stringify(job),state:'partial',creator_id:'creator',author:'author',enabled:1}],
    [{state:'blocked',code:'XHS_SOURCE_HISTORY_REVIEW_REQUIRED',owner:null,http_status:null,endpoint:null}],[],[],[],
    [{id:'xhs:dispatch-pending:whole:1',used:1,request_limit:1},{id:'xhs:dispatch-pending:whole:2',used:1,request_limit:1}],
    [{id:'job',used:1,request_limit:10,interval_ms:1},{id:'xhs:source-total',used:1,request_limit:10,interval_ms:1}]];
  const run = () => {let n=0; return prepareHistoryHandoff({$queryRaw:async()=>result[n++]} as any,'job','generation');};
  return {job,result,run};
}
it('prepares a digest bound to the durable historical facts and keeps excluded notes visible',async()=>{
  const f=fixture(), a=await f.run();
  expect(a.excludedIds).toEqual(['["xiaohongshu","note","old"]','["xiaohongshu","note","other"]']);
  expect(a.historicalAttemptCount).toBe(2);expect(a.digest).toMatch(/^[a-f0-9]{64}$/);
  f.result[0][0].document=JSON.stringify({...f.job,updatedAt:2});
  expect((await f.run()).digest).not.toBe(a.digest);
});
it.each([2,3,4])('refuses an active worker or unresolved recovery at check %i',async index=>{
  const f=fixture();f.result[index]=[{id:'active'}];await expect(f.run()).rejects.toThrow('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
});
it('refuses a newly added or changed unknown marker',async()=>{
  const f=fixture();f.result[5].push({id:'xhs:dispatch-pending:whole:3',used:1,request_limit:1});
  await expect(f.run()).rejects.toThrow('XHS_WHOLE_SOURCE_FENCE_BLOCKED');
});
