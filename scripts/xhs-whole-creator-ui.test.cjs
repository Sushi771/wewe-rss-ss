const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const from = path.resolve('apps/web');
const resolve = (name) => require(require.resolve(name, { paths: [from] }));
const ts = resolve('typescript'),
  React = resolve('react'),
  { renderToStaticMarkup } = resolve('react-dom/server');
const text = fs.readFileSync(
  'apps/web/src/components/XhsWholeCreator.tsx',
  'utf8',
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
      throw Error('render must not dispatch');
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
    },
  };
  const mod = { exports: {} };
  new Function('require', 'exports', 'module', output)(
    (name) => (name === '@web/utils/trpc' ? { trpc } : resolve(name)),
    mod.exports,
    mod,
  );
  return renderToStaticMarkup(
    React.createElement(mod.exports.default, { creatorId: 'synthetic' }),
  );
}
test('coverage separates root replies, supplements and unknown deletion; no percent claim', () => {
  const html = render([
    {
      id: 'synthetic',
      state: 'paused',
      listEnd: true,
      updatedAt: 1,
      code: 'XHS_REQUEST_BUDGET_EXHAUSTED',
      budget: { used: 7, limit: 7 },
      items: [
        {
          noteId: 'n',
          title: 'Synthetic',
          metrics: 1,
          top: 1,
          status: 'restricted',
          stage: 'replies',
          reason: 'XHS_REQUEST_BUDGET_EXHAUSTED',
          supplement: 'pending',
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
test('empty local coverage rendering never triggers a mutation', () =>
  assert.match(render([]), /整号互动覆盖与待补清单/));
