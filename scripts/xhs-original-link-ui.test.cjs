const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
function fixture(prepare) {
  const slots = [],
    effects = [],
    cleanups = [];
  let index = 0;
  const react = {
    useState(v) {
      const i = index++;
      if (!(i in slots)) slots[i] = v;
      return [slots[i], (v) => (slots[i] = v)];
    },
    useRef(v) {
      const i = index++;
      return slots[i] ?? (slots[i] = { current: v });
    },
    useEffect(fn) {
      if (!cleanups.length) effects.push(fn);
    },
  };
  const helperMod = { exports: {} };
  new Function(
    'exports',
    'module',
    ts.transpileModule(
      fs.readFileSync('apps/web/src/utils/xhs-note-presentation.ts', 'utf8'),
      { compilerOptions: { module: ts.ModuleKind.CommonJS } },
    ).outputText,
  )(helperMod.exports, helperMod);
  const helper = helperMod.exports;
  const jsx = (type, props) => ({ type, props }),
    mod = { exports: {} };
  new Function(
    'require',
    'exports',
    'module',
    ts.transpileModule(
      fs.readFileSync('apps/web/src/components/XhsOriginalLink.tsx', 'utf8'),
      {
        compilerOptions: {
          module: ts.ModuleKind.CommonJS,
          jsx: ts.JsxEmit.ReactJSX,
        },
      },
    ).outputText,
  )(
    (n) =>
      n === 'react'
        ? react
        : n.includes('xhs-note-presentation')
          ? helper
          : { jsx, jsxs: jsx },
    mod.exports,
    mod,
  );
  const noteId = JSON.stringify(['xiaohongshu', 'note', 'a'.repeat(24)]),
    all = (n) =>
      n == null
        ? []
        : Array.isArray(n)
          ? n.flatMap(all)
          : typeof n === 'object'
            ? [n, ...all(n.props?.children)]
            : [n];
  return {
    noteId,
    slots,
    render() {
      index = 0;
      const tree = all(
        mod.exports.default({
          creatorId: 'owner',
          noteId,
          title: '原文',
          prepare,
        }),
      );
      while (effects.length) cleanups.push(effects.shift()());
      return tree;
    },
    unmount() {
      cleanups.forEach((c) => c?.());
    },
  };
}
const tick = () => new Promise((r) => setImmediate(r));
test('prepare is explicit, synchronous duplicate clicks are ignored, then a safe user link appears', async () => {
  let calls = 0,
    finish,
    input;
  const f = fixture((value) => {
    calls++;
    input = value;
    return new Promise((r) => (finish = r));
  });
  const button = f.render().find((n) => n.type === 'button');
  assert.equal(calls, 0);
  button.props.onClick();
  button.props.onClick();
  assert.equal(calls, 1);
  assert.deepEqual(input, { creatorId: 'owner', noteId: f.noteId });
  const url =
    'https://www.xiaohongshu.com/explore/' +
    'a'.repeat(24) +
    '?xsec_token=synthetic-private&xsec_source=pc_share';
  finish({ state: 'ready', url });
  await tick();
  const anchor = f.render().find((n) => n.type === 'a');
  assert.equal(anchor.props.href, url);
  assert.equal(anchor.props.rel, 'noopener noreferrer');
  assert.equal(anchor.props.target, '_blank');
  assert.equal(anchor.props.referrerPolicy, 'no-referrer');
});
test('failed or invalid preparation has a fixed visible error and never retries automatically', async () => {
  for (const value of [
    'javascript:alert(1)',
    'https://evil.invalid/explore/a',
    'https://www.xiaohongshu.com/explore/wrong',
  ]) {
    let calls = 0;
    const f = fixture(async () => {
      calls++;
      return { state: 'ready', url: value };
    });
    f.render()
      .find((n) => n.type === 'button')
      .props.onClick();
    await tick();
    const tree = f.render();
    assert(tree.some((n) => n.props?.role === 'alert'));
    assert(!tree.some((n) => n.type === 'a'));
    assert.equal(calls, 1);
  }
});
test('a result after its row unmounts cannot write a link or error', async () => {
  let finish;
  const f = fixture(() => new Promise((r) => (finish = r)));
  f.render()
    .find((n) => n.type === 'button')
    .props.onClick();
  f.unmount();
  finish({
    state: 'ready',
    url: 'https://www.xiaohongshu.com/explore/' + 'a'.repeat(24),
  });
  await tick();
  assert.equal(f.slots[0], undefined);
  assert.equal(f.slots[2], false);
});
test('a missing budget is a visible configuration next step without a retry', async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    return { state: 'not_ready', code: 'XHS_REQUEST_BUDGET_REQUIRED' };
  });
  f.render()
    .find((n) => n.type === 'button')
    .props.onClick();
  await tick();
  const tree = f.render();
  assert(
    tree.some(
      (n) => typeof n === 'string' && n.includes('请先设置来源请求额度'),
    ),
  );
  assert(!tree.some((n) => n.type === 'a'));
  assert.equal(calls, 1);
});


test('an expired link can be explicitly prepared again without automatic requests or closing the original tab', async () => {
  const inputs=[];let next;
  const f=fixture(input=>{inputs.push(input);return new Promise(resolve=>next=resolve)});
  f.render().find(n=>n.type==='button').props.onClick();
  const base='https://www.xiaohongshu.com/explore/'+'a'.repeat(24);
  next({state:'ready',url:base+'?xsec_token=synthetic-first&xsec_source=pc_user'});await tick();
  assert.equal(inputs.length,1);
  const retry=f.render().find(n=>n.type==='button'&&n.props['aria-label']?.startsWith('重新准备原文'));
  assert(retry);retry.props.onClick();retry.props.onClick();assert.equal(inputs.length,2);assert.equal(inputs[1].refreshContext,true);
  next({state:'ready',url:base+'?xsec_token=synthetic-renewed&xsec_source=pc_user'});await tick();
  assert.match(f.render().find(n=>n.type==='a').props.href,/synthetic-renewed/);assert.equal(inputs.length,2);
});

test('explicit renewal failure removes the stale URL and a late renewal after unmount cannot restore it', async () => {
  let next;let calls=0;
  const f=fixture(()=>{calls++;return new Promise(resolve=>next=resolve)});
  const ready={state:'ready',url:'https://www.xiaohongshu.com/explore/'+'a'.repeat(24)+'?xsec_token=synthetic-only&xsec_source=pc_user'};
  f.render().find(n=>n.type==='button').props.onClick();next(ready);await tick();
  f.render().find(n=>n.type==='button').props.onClick();
  next({state:'not_ready',code:'XHS_REQUEST_BUDGET_EXHAUSTED'});await tick();
  assert(!f.render().some(n=>n.type==='a'));assert(f.render().some(n=>n.props?.role==='alert'));assert.equal(calls,2);
  f.render().find(n=>n.type==='button').props.onClick();f.unmount();next(ready);await tick();
  assert.equal(f.slots[0],undefined);assert.equal(calls,3);
});
