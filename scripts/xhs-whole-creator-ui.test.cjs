const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const from = path.resolve("apps/web");
const resolve = (name) => require(require.resolve(name, { paths: [from] }));
const ts = resolve("typescript"),
  React = resolve("react"),
  { renderToStaticMarkup } = resolve("react-dom/server");
const text = fs.readFileSync(
  "apps/web/src/components/XhsWholeCreator.tsx",
  "utf8",
);
function render(data, component = 'default') {
  const output = ts.transpileModule(text, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2021,
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  }).outputText;
  const mutation = () => ({
    mutateAsync: () => {
      throw Error("render must not dispatch");
    },
    isLoading: false,
  });
  const trpc = {
    xiaohongshu: {
      wholeCreatorJobs: { useQuery: () => ({ data, refetch: async () => {} }) },
      startWholeCreator: { useMutation: mutation },
      resumeWholeCreator: { useMutation: mutation },
      cancelWholeCreator: { useMutation: mutation },
      extendWholeCreatorBudget: { useMutation: mutation },
      extendWholeCreatorHistoryPhase: { useMutation: mutation },
      prepareWholeCreatorReviewedAttempt: { useMutation: mutation },
      executeWholeCreatorReviewedAttempt: { useMutation: mutation },
      prepareWholeCreatorGeneration: { useMutation: mutation },
      executeWholeCreatorGeneration: { useMutation: mutation },
      reviewWholeCreatorGeneration: { useMutation: mutation },
      resumeWholeCreatorMedia: { useMutation: mutation },
      resumeWholeCreatorMissingBasic: { useMutation: mutation },
    },
  };
  const mod = { exports: {} };
  new Function("require", "exports", "module", output)(
    (name) => (name === "@web/utils/trpc" ? { trpc } : resolve(name)),
    mod.exports,
    mod,
  );
  return renderToStaticMarkup(
    React.createElement(mod.exports[component], component === 'default' ? { creatorId: "synthetic" } : { job: data, refresh: async () => {} }),
  );
}
test("daily summary hides technical inventory while retaining the pause and explicit continuation", () => {
  const html = render([
    {
      id: "synthetic",
      state: "paused",
      listEnd: true,
      updatedAt: 1,
      code: "XHS_REQUEST_BUDGET_EXHAUSTED",
      budget: { used: 7, limit: 7 },
      items: [
        {
          noteId: "n",
          title: "Synthetic",
          metrics: 1,
          top: 1,
          status: "restricted",
          stage: "replies",
          reason: "XHS_REQUEST_BUDGET_EXHAUSTED",
          supplement: "pending",
        },
      ],
    },
  ]);
  assert.match(html, /已暂停/);
  assert.match(html, /已发现 1 篇/);
  assert.doesNotMatch(html, /主评|根回复|删除状态未知|Synthetic/);
  assert.match(html, /明确追加/);
  assert.doesNotMatch(html, /100%/);
});

test("phase cap control is available only for a paused grant without an unresolved checkpoint", () => {
  const job = {
    id: "synthetic",
    state: "paused",
    listEnd: true,
    updatedAt: 1,
    resumable: true,
    items: [],
    budget: { used: 2, limit: 20 },
    historyGrant: {
      limits: { profile: 1, list: 3, detail: 0, media: 0, metrics: 0 },
      used: { profile: 1, list: 1, detail: 0, media: 0, metrics: 0 },
    },
  };
  assert.match(render([job]), /确认调整阶段上限/);
  assert.match(render([job]), /不会自动继续/);
  assert.doesNotMatch(
    render([
      { ...job, sourceCheckpoint: { phase: "detail", state: "unknown" } },
    ]),
    /确认调整阶段上限/,
  );
  assert.doesNotMatch(
    render([{ ...job, state: "running" }]),
    /确认调整阶段上限/,
  );
});
test("empty local coverage rendering never triggers a mutation", () =>
  assert.match(render([]), /同步博主内容/));

test("unknown source checkpoint is visible and continuation is disabled without exposing internal markers", () => {
  const html = render([
    {
      id: "synthetic",
      state: "paused",
      listEnd: false,
      updatedAt: 1,
      resumable: false,
      items: [],
      historyGrant: { limits: { detail: 4 }, used: { detail: 2 } },
      sourceCheckpoint: { phase: "detail", state: "unknown" },
    },
  ]);
  assert.match(html, /来源请求结果尚未确认/);
  assert.doesNotMatch(html, /正文详情 2\/4/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /dispatch-pending/);
  assert.match(html, /不会自动重发/);
});

test("known source refusal is shown as restricted, not an unknown result", () => {
  const html = render([
    {
      id: "synthetic",
      state: "paused",
      listEnd: false,
      updatedAt: 1,
      resumable: false,
      items: [],
      code: "XHS_SOURCE_UNKNOWN_REJECTION_BLOCKED",
      sourceCheckpoint: { phase: "detail", state: "restricted" },
    },
  ]);
  assert.match(html, /来源拒绝了该请求/);
  assert.doesNotMatch(html, /来源请求结果尚未确认/);
  assert.match(html, /disabled=""/);
});

test("stage exhaustion permits explicit budget extension without claiming automatic resume", () => {
  const base = {
    id: "synthetic",
    state: "paused",
    listEnd: true,
    updatedAt: 1,
    resumable: true,
    items: [],
    code: "XHS_WHOLE_PHASE_BUDGET_EXHAUSTED",
    historyGrant: { limits: { detail: 0 }, used: { detail: 0 } },
  };
  const html = render([base]);
  assert.match(html, /明确追加 100 次请求（需另行继续）/);
  assert.doesNotMatch(
    render([
      { ...base, sourceCheckpoint: { phase: "detail", state: "unknown" } },
    ]),
    /明确追加 100 次请求/,
  );
});

test("reviewed recovery distinguishes a saved retry from the original unknown and never replays on render", () => {
  const base = { id: "synthetic", state: "paused", listEnd: false, updatedAt: 1, resumable: false, items: [], sourceCheckpoint: {phase:"detail",state:"unknown"} };
  const saved = render([{...base,reviewedRecovery:{state:"checkpointed",receipt:{body:"retained",media:"pending",mediaCount:2}}}]);
  assert.match(saved,/本次恢复已保存/);assert.match(saved,/原请求仍待核对/);assert.match(saved,/保留已有内容/);assert.doesNotMatch(saved,/仅执行这一次恢复/);
  const consumed = render([{...base,reviewedRecovery:{state:"consumed"}}]);
  assert.match(consumed,/结果未知，不能再次执行/);assert.doesNotMatch(consumed,/核对并准备一次恢复/);
  const legacy = render([{...base,reviewedRecovery:{state:"blocked"}}]);
  assert.match(legacy,/需要人工核对/);assert.doesNotMatch(legacy,/仅执行这一次恢复|核对并准备一次恢复/);
});

function recoveryInteraction(initial, component = 'default') {
  const slots=[],calls=[];let index=0,data=initial,refetches=0,work=async()=>({}),choose=async()=>({});
  const hooks={useState(value){const at=index++;if(!(at in slots))slots[at]=value;return[slots[at],v=>{slots[at]=typeof v==='function'?v(slots[at]):v;}];},useRef(value){const at=index++;if(!(at in slots))slots[at]={current:value};return slots[at];}};
  const mutation=name=>({useMutation:options=>{assert.equal(options.retry,false);return{isLoading:false,mutateAsync:async input=>{calls.push({name,input});return work(name,input);}};}});
  const api={wholeCreatorJobs:{useQuery:()=>({data,refetch:async()=>{refetches++;}})}};
  for(const name of ['startWholeCreator','resumeWholeCreator','cancelWholeCreator','extendWholeCreatorBudget','extendWholeCreatorHistoryPhase','prepareWholeCreatorReviewedAttempt','executeWholeCreatorReviewedAttempt','prepareWholeCreatorGeneration','executeWholeCreatorGeneration','reviewWholeCreatorGeneration','resumeWholeCreatorMedia','resumeWholeCreatorMissingBasic'])api[name]=mutation(name);
  const mod={exports:{}};
  const output=ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  new Function('require','exports','module',output)(name=>name==='react'?hooks:name==='@web/utils/trpc'?{trpc:{xiaohongshu:api}}:resolve(name),mod.exports,mod);
  const draw=()=>{index=0;return mod.exports[component](component === 'default' ? {creatorId:'synthetic'} : {job:data,refresh:api.wholeCreatorJobs.useQuery().refetch,chooseDirectory:()=>choose()});};
  const nodes=(tree,predicate)=>{const found=[];function walk(n){if(!n||typeof n!=='object')return;if(Array.isArray(n)){n.forEach(walk);return;}if(predicate(n))found.push(n);walk(n.props?.children);}walk(tree);return found;};
  return {calls,draw,nodes,setData:v=>{data=v;},setWork:v=>{work=v;},setChoose:v=>{choose=v;},get refetches(){return refetches;}};
}

test('partial generation prepares only an explicitly selected excluded note',async()=>{
  const id=JSON.stringify(['xiaohongshu','note','synthetic-note']);
  const job={id:'job',state:'partial',updatedAt:1,items:[{noteId:id,title:'Synthetic'}],generationRecovery:{id:'g',state:'partial',retryableExcludedIds:[id],profileUrl:'https://xhslink.cn/o/Synthetic',discovered:1,missing:0,directoryComplete:false,originalNoteStatus:'unknown',resumable:false}};
  const h=recoveryInteraction([job]);let tree=h.draw();assert.equal(h.calls.length,0);
  const button=()=>h.nodes(tree,n=>n.type==='button'&&n.props.children==='核对并准备单篇恢复')[0];
  assert.equal(button().props.disabled,true);
  h.nodes(tree,n=>n.type==='select'&&h.nodes(n,x=>x.type==='option'&&x.props.value===id).length)[0].props.onChange({target:{value:id}});
  tree=h.draw();h.nodes(tree,n=>n.type==='input'&&n.props.type==='checkbox')[0].props.onChange({target:{checked:true}});
  tree=h.draw();assert.equal(button().props.disabled,false);button().props.onClick();await new Promise(setImmediate);
  assert.deepEqual(h.calls,[{name:'prepareWholeCreatorReviewedAttempt',input:{jobId:'job',confirmUnknownRetry:true,excludedNoteId:'synthetic-note'}}]);
});
test('single recovery distinguishes live execution and an unrecognized media manifest',()=>{
  const base={id:'job',state:'partial',items:[],updatedAt:1,reviewedRecovery:{state:'in-progress',noteId:'note',phase:'detail'}};
  const live=render([base]);assert.match(live,/单篇详情请求执行中/);assert.doesNotMatch(live,/本次恢复已提交，但结果未确认/);
  const saved=render([{...base,reviewedRecovery:{state:'checkpointed',receipt:{body:'saved',media:'needs-review',mediaCount:0}}}]);
  assert.match(saved,/图片清单待核对/);assert.doesNotMatch(saved,/图片无/);
});

test('legacy recovery explains the remaining unknown and submits separate consent only after confirmation',async()=>{
  const base={id:'job',state:'paused',items:[],updatedAt:1,reviewedRecovery:{state:'review-required',noteId:'note',phase:'detail',legacyUnknown:true}};
  assert.match(render([base]),/旧请求缺少进程记录/);
  assert.match(render([base]),/再次请求可能重复产生费用/);
  const h=recoveryInteraction([base]);let tree=h.draw();assert.equal(h.calls.length,0);
  h.nodes(tree,n=>n.type==='input'&&n.props.type==='checkbox')[0].props.onChange({target:{checked:true}});
  tree=h.draw();const button=h.nodes(tree,n=>n.type==='button'&&typeof n.props.onClick==='function'&&n.props.onClick.toString().includes('recover('))[0];
  assert.equal(button.props.disabled,false);button.props.onClick();await new Promise(setImmediate);
  assert.equal(h.calls.length,1);assert.deepEqual(h.calls[0],{name:'prepareWholeCreatorReviewedAttempt',input:{jobId:'job',confirmUnknownRetry:true,confirmLegacyUnknown:true}});
});
test("product actions prepare without a request and execute once after a second explicit confirmation", async()=>{
  const base={id:'job',state:'paused',items:[],updatedAt:1,reviewedRecovery:{state:'review-required',noteId:'note',phase:'detail'}};
  const h=recoveryInteraction([base]);let tree=h.draw();assert.equal(h.calls.length,0);
  h.nodes(tree,n=>n.type==='input'&&n.props.type==='checkbox')[0].props.onChange({target:{checked:true}});
  tree=h.draw();h.nodes(tree,n=>n.type==='button'&&n.props.children==='核对并准备一次恢复')[0].props.onClick();
  await new Promise(setImmediate);
  assert.deepEqual(h.calls,[{name:'prepareWholeCreatorReviewedAttempt',input:{jobId:'job',confirmUnknownRetry:true}}]);assert.equal(h.refetches,1);
  h.setData([{...base,reviewedRecovery:{...base.reviewedRecovery,state:'prepared',attemptId:'a'.repeat(64),expiresAt:Date.now()+60000}}]);
  tree=h.draw();assert(h.nodes(tree,n=>n.type==='button'&&n.props.children==='仅执行这一次恢复')[0].props.disabled);
  h.nodes(tree,n=>n.type==='input'&&n.props.type==='url')[0].props.onChange({target:{value:'https://www.xiaohongshu.com/explore/note?xsec_token=synthetic'}});
  tree=h.draw();h.nodes(tree,n=>n.type==='input'&&n.props.type==='checkbox')[0].props.onChange({target:{checked:true}});
  tree=h.draw();const button=h.nodes(tree,n=>n.type==='button'&&n.props.children==='仅执行这一次恢复')[0];assert.equal(button.props.disabled,false);
  let done;h.setWork(()=>new Promise(r=>{done=r;}));button.props.onClick();button.props.onClick();
  assert.equal(h.calls.length,2);assert.deepEqual(h.calls[1].input,{jobId:'job',attemptId:'a'.repeat(64),url:'https://www.xiaohongshu.com/explore/note?xsec_token=synthetic',confirmUnknownRetry:true});
  assert.equal(h.nodes(h.draw(),n=>n.type==='input'&&n.props.type==='url')[0].props.value,'');done({});await new Promise(setImmediate);assert.equal(h.refetches,2);
});
test("a lost execute acknowledgement refreshes receipt without preparing or executing again", async()=>{
  const base={id:'job',state:'paused',items:[],updatedAt:1,reviewedRecovery:{state:'prepared',noteId:'note',phase:'detail',attemptId:'b'.repeat(64),expiresAt:Date.now()+60000}};
  const h=recoveryInteraction([base]);let tree=h.draw();h.nodes(tree,n=>n.type==='input'&&n.props.type==='url')[0].props.onChange({target:{value:'https://www.xiaohongshu.com/explore/note?xsec_token=synthetic'}});
  tree=h.draw();h.nodes(tree,n=>n.type==='input'&&n.props.type==='checkbox')[0].props.onChange({target:{checked:true}});
  h.setWork(async()=>{h.setData([{...base,reviewedRecovery:{state:'checkpointed',receipt:{body:'saved',media:'none',mediaCount:0}}}]);throw Error('synthetic lost response');});
  tree=h.draw();h.nodes(tree,n=>n.type==='button'&&n.props.children==='仅执行这一次恢复')[0].props.onClick();await new Promise(setImmediate);
  assert.equal(h.calls.length,1);assert.equal(h.refetches,1);
  tree=h.draw();assert.equal(h.nodes(tree,n=>n.type==='button'&&n.props.children==='仅执行这一次恢复').length,0);
  assert.equal(h.calls.length,1);
});

test("AUDIT: recovery phase is rendered in user language",()=>{
 for(const phase of ["detail","metrics"]){
  const html=render([{id:"job",state:"paused",items:[],updatedAt:1,reviewedRecovery:{state:"review-required",noteId:"note",phase}}]);
  assert.doesNotMatch(html,/阶段：(detail|metrics)/);
 }
});
test("AUDIT: terminal recovery copy describes user results without storage diagnostics",()=>{
 for(const state of ["consumed","checkpointed"]){
  const html=render([{id:"job",state:"paused",items:[],updatedAt:1,reviewedRecovery:{state,receipt:{body:"saved",media:"none",mediaCount:0}}}]);
  assert.doesNotMatch(html,/落盘|已记账/);
 }
});

const generationJob = {id:'job',items:[{noteId:'synthetic-safe',title:'Safe'}],canPrepareGeneration:true,budget:{used:6,limit:310},historyGrant:{limits:{profile:2,list:3,detail:5,media:300,metrics:0},used:{profile:2,list:2,detail:1,media:1,metrics:0}}};
test('a live generation does not display the stopped unknown warning',()=>{
 const generationRecovery={id:'g',state:'running',profileUrl:'https://xhslink.cn/o/Synthetic',discovered:1,missing:0,directoryComplete:false,originalNoteStatus:'unknown',resumable:false,newResult:'in-progress'};
 const live=render({...generationJob,canPrepareGeneration:false,generationRecovery},'XhsWholeGeneration');
 assert.match(live,/正在继续采集/);assert.doesNotMatch(live,/本次还有请求结果未确认，已停止/);
 const stopped=render({...generationJob,canPrepareGeneration:false,generationRecovery:{...generationRecovery,state:'paused',newResult:'unknown'}},'XhsWholeGeneration');
 assert.match(stopped,/本次还有请求结果未确认，已停止/);
});
test('received response and local storage failures have distinct readable reasons without backend diagnostics',()=>{
 const base={...generationJob,canPrepareGeneration:false,generationRecovery:{id:'g',state:'paused',profileUrl:'https://xhslink.cn/o/Synthetic',discovered:0,missing:0,directoryComplete:false,originalNoteStatus:'unknown',resumable:false,newResult:'unknown'}};
 const received=render({...base,generationRecovery:{...base.generationRecovery,failure:{stage:'response',outcome:'response-received',code:'XHS_SOURCE_TRANSPORT_BLOCKED',status:200}}},'XhsWholeGeneration');
 assert.match(received,/来源已响应，但资料未能完成处理/);assert.doesNotMatch(received,/请求结果尚未确认|XHS_SOURCE_|owner|marker/);
 const local=render({...base,generationRecovery:{...base.generationRecovery,failure:{stage:'storage',outcome:'local-failure',code:'XHS_STORAGE_FAILED',status:200}}},'XhsWholeGeneration');
 assert.match(local,/资料保存失败/);assert.doesNotMatch(local,/XHS_STORAGE_FAILED|P2002/);
});
test('directory mismatch explains the local pause without claiming an unknown request',()=>{
 const job={...generationJob,canPrepareGeneration:false,generationRecovery:{id:'g',state:'paused',profileUrl:'https://xhslink.cn/o/Synthetic',discovered:23,missing:0,directoryComplete:true,resumable:true,failure:{stage:'archive',outcome:'local-failure',code:'XHS_RESUME_DIRECTORY_CHANGED'}}};
 const html=render(job,'XhsWholeGeneration');assert.match(html,/保存目录与本次任务已使用的目录不同/);assert.doesNotMatch(html,/请求结果尚未确认|XHS_RESUME_DIRECTORY_CHANGED/);
});
test('missing picker grant explains local selection without unknown request claim',()=>{
 const job={...generationJob,canPrepareGeneration:false,generationRecovery:{id:'g',state:'paused',profileUrl:'https://xhslink.cn/o/Synthetic',discovered:23,missing:0,directoryComplete:true,resumable:true,failure:{stage:'archive',outcome:'local-failure',code:'XHS_SAVE_DIRECTORY_SELECTION_REQUIRED'}}};
 const html=render(job,'XhsWholeGeneration');assert.match(html,/请先选择本次小红书保存目录/);assert.doesNotMatch(html,/请求结果尚未确认|XHS_SAVE_DIRECTORY_SELECTION_REQUIRED/);
});
test('review of this generation never executes until another explicit confirmation',async()=>{
 const job={...generationJob,canPrepareGeneration:false,generationRecovery:{id:'g',state:'paused',profileUrl:'https://xhslink.cn/o/Synthetic',discovered:0,missing:0,directoryComplete:false,originalNoteStatus:'unknown',resumable:false,reviewable:true,newResult:'unknown'}};
 const h=recoveryInteraction(job,'XhsWholeGeneration');let tree=h.draw();assert.equal(h.calls.length,0);
 h.nodes(tree,n=>n.type==='input'&&n.props.type==='checkbox')[0].props.onChange({target:{checked:true}});tree=h.draw();
 h.nodes(tree,n=>n.type==='button')[0].props.onClick();await new Promise(setImmediate);
 assert.deepEqual(h.calls,[{name:'reviewWholeCreatorGeneration',input:{jobId:'job',generationId:'g',confirmUnknown:true}}]);
 h.setData({...job,generationRecovery:{...job.generationRecovery,reviewable:false,resumable:true}});tree=h.draw();assert.equal(h.nodes(tree,n=>n.type==='button')[0].props.disabled,true);assert.equal(h.calls.length,1);
});
test('whole generation explains cumulative counts and separates preparation from source execution', async()=>{
 const html=render(generationJob,'XhsWholeGeneration');
 assert.match(html,/旧次数继续保留/);assert.match(html,/剩余 304 次本地请求额度/);assert.match(html,/准备操作不发来源请求/);
 assert.doesNotMatch(html,/计费|收费|dispatch-pending|proofId|originDigest/);
 const h=recoveryInteraction(generationJob,'XhsWholeGeneration');let tree=h.draw();assert.equal(h.calls.length,0);
 h.nodes(tree,n=>n.type==='input'&&n.props.type==='url')[0].props.onChange({target:{value:'https://xhslink.cn/o/Synthetic'}});
 tree=h.draw();h.nodes(tree,n=>n.type==='input'&&n.props.type==='checkbox')[0].props.onChange({target:{checked:true}});
 tree=h.draw();const prepare=h.nodes(tree,n=>n.type==='button')[0];assert.equal(prepare.props.disabled,false);
 let finish;h.setWork(()=>new Promise(r=>{finish=r}));prepare.props.onClick();prepare.props.onClick();assert.equal(h.calls.length,1);
 assert.equal(h.calls[0].name,'prepareWholeCreatorGeneration');assert.equal(h.calls[0].input.confirmUnknown,true);
 assert.equal(h.calls[0].input.profileUrl,'https://xhslink.cn/o/Synthetic');finish({});await new Promise(setImmediate);
 const prepared={...generationJob,canPrepareGeneration:false,generationRecovery:{id:'generation',state:'prepared',profileUrl:'https://xhslink.cn/o/Synthetic',discovered:0,missing:0,directoryComplete:false,originalNoteStatus:'unknown',resumable:true}};
 h.setData(prepared);tree=h.draw();assert.equal(h.nodes(tree,n=>n.type==='button')[0].props.disabled,true);
 h.nodes(tree,n=>n.type==='input'&&n.props.type==='checkbox').at(-1).props.onChange({target:{checked:true}});tree=h.draw();
 h.setWork(async()=>{h.setData({...prepared,generationRecovery:{...prepared.generationRecovery,state:'paused',newResult:'unknown',resumable:false}});throw Error('synthetic lost response')});
 h.nodes(tree,n=>n.type==='button')[0].props.onClick();await new Promise(setImmediate);
 assert.equal(h.calls.length,2);assert.deepEqual(h.calls[1],{name:'executeWholeCreatorGeneration',input:{jobId:'job',generationId:'generation',confirmUnknown:true,selectedIds:['synthetic-safe']}});
 tree=h.draw();assert.equal(h.nodes(tree,n=>n.type==='button').length,0);assert.equal(h.calls.length,2);
});
test('cache recovery waits for explicit consent and never opens export directory chooser',async()=>{
 const job={...generationJob,canPrepareGeneration:false,generationRecovery:{id:'generation',state:'prepared',profileUrl:'https://xhslink.cn/o/Synthetic',discovered:0,missing:0,directoryComplete:false,resumable:true}};
 const h=recoveryInteraction(job,'XhsWholeGeneration');let selections=0;h.setChoose(async()=>{selections++;throw Error('unexpected directory selection');});let tree=h.draw();const button=h.nodes(tree,n=>n.type==='button')[0];assert.equal(button.props.disabled,true);assert.equal(h.calls.length,0);
 h.nodes(tree,n=>n.type==='input'&&n.props.type==='checkbox').at(-1).props.onChange({target:{checked:true}});tree=h.draw();h.nodes(tree,n=>n.type==='button')[0].props.onClick();await new Promise(setImmediate);assert.equal(selections,0);assert.deepEqual(h.calls,[{name:'executeWholeCreatorGeneration',input:{jobId:'job',generationId:'generation',confirmUnknown:true,selectedIds:['synthetic-safe']}}]);
});
test('whole generation shows missing separately and never promises full coverage from a cache count',()=>{
 const html=render({...generationJob,canPrepareGeneration:false,generationRecovery:{id:'g',state:'paused',profileUrl:'https://xhslink.cn/o/Synthetic',discovered:2,missing:1,directoryComplete:true,originalNoteStatus:'not-returned',resumable:false,newResult:'unknown'}},'XhsWholeGeneration');
 assert.match(html,/目录已到末页/);assert.match(html,/本次返回 2 篇/);assert.match(html,/不认定为删除/);assert.match(html,/本次还有请求结果未确认/);
 assert.doesNotMatch(html,/100%|计费|收费|明确开始或继续/);
});


test('unknown detail exclusion requires an explicit choice and sends it only on review', async()=>{
 const job={...generationJob,canPrepareGeneration:false,generationRecovery:{id:'g',state:'paused',profileUrl:'https://xhslink.cn/o/Synthetic',discovered:1,missing:0,directoryComplete:true,originalNoteStatus:'unknown',resumable:false,reviewable:true,excludeUnknownRequired:true}};
 const h=recoveryInteraction(job,'XhsWholeGeneration'); let tree=h.draw();
 assert.match(render(job,'XhsWholeGeneration'),/跳过结果未知的笔记/);
 let boxes=h.nodes(tree,n=>n.type==='input'&&n.props.type==='checkbox');
 boxes.at(-1).props.onChange({target:{checked:true}});tree=h.draw();
 assert.equal(h.nodes(tree,n=>n.type==='button')[0].props.disabled,true);
 boxes=h.nodes(tree,n=>n.type==='input'&&n.props.type==='checkbox'); boxes[0].props.onChange({target:{checked:true}});tree=h.draw();
 boxes=h.nodes(tree,n=>n.type==='input'&&n.props.type==='checkbox'); boxes.at(-1).props.onChange({target:{checked:true}});tree=h.draw();
 h.nodes(tree,n=>n.type==='button')[0].props.onClick();await new Promise(setImmediate);
 assert.deepEqual(h.calls,[{name:'reviewWholeCreatorGeneration',input:{jobId:'job',generationId:'g',confirmUnknown:true,excludeUnknown:true}}]);
});
