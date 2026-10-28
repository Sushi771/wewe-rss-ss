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
test("coverage separates root replies, supplements and unknown deletion; no percent claim", () => {
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
  assert.match(html, /主评/);
  assert.match(html, /根回复/);
  assert.match(html, /附页待补|待补/);
  assert.match(html, /删除状态未知/);
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
  assert.match(render([]), /整号互动覆盖与待补清单/));

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
  assert.match(html, /正文详情 2\/4/);
  assert.match(html, /disabled=""/);
  assert.doesNotMatch(html, /dispatch-pending/);
  assert.match(html, /评论正文与回复采集暂停/);
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
