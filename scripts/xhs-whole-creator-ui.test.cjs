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
function render(data) {
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
    },
  };
  const mod = { exports: {} };
  new Function("require", "exports", "module", output)(
    (name) => (name === "@web/utils/trpc" ? { trpc } : resolve(name)),
    mod.exports,
    mod,
  );
  return renderToStaticMarkup(
    React.createElement(mod.exports.default, { creatorId: "synthetic" }),
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

function recoveryInteraction(initial) {
  const slots=[],calls=[];let index=0,data=initial,refetches=0,work=async()=>({});
  const hooks={useState(value){const at=index++;if(!(at in slots))slots[at]=value;return[slots[at],v=>{slots[at]=typeof v==='function'?v(slots[at]):v;}];},useRef(value){const at=index++;if(!(at in slots))slots[at]={current:value};return slots[at];}};
  const mutation=name=>({useMutation:options=>{assert.equal(options.retry,false);return{isLoading:false,mutateAsync:async input=>{calls.push({name,input});return work(name,input);}};}});
  const api={wholeCreatorJobs:{useQuery:()=>({data,refetch:async()=>{refetches++;}})}};
  for(const name of ['startWholeCreator','resumeWholeCreator','cancelWholeCreator','extendWholeCreatorBudget','extendWholeCreatorHistoryPhase','prepareWholeCreatorReviewedAttempt','executeWholeCreatorReviewedAttempt'])api[name]=mutation(name);
  const mod={exports:{}};
  const output=ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  new Function('require','exports','module',output)(name=>name==='react'?hooks:name==='@web/utils/trpc'?{trpc:{xiaohongshu:api}}:resolve(name),mod.exports,mod);
  const draw=()=>{index=0;return mod.exports.default({creatorId:'synthetic'});};
  const nodes=(tree,predicate)=>{const found=[];function walk(n){if(!n||typeof n!=='object')return;if(Array.isArray(n)){n.forEach(walk);return;}if(predicate(n))found.push(n);walk(n.props?.children);}walk(tree);return found;};
  return {calls,draw,nodes,setData:v=>{data=v;},setWork:v=>{work=v;},get refetches(){return refetches;}};
}
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
