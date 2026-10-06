import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { formatProbeSummary, bindPopup } from './popup.mjs';
import { probeOfficialArticle } from './probe.mjs';

const complete = () => ({
  supported: true,
  componentMatched: true,
  frameReadable: true,
  bookIdPresent: true,
  reviewIdPresent: true,
  originalIdPresent: true,
  reviewBindingMatched: true,
  publisherBindingMatched: true,
  titleMatched: true,
  publisherMatched: true,
  creationTimePresent: true,
  identityScalarsPresent: true,
  canonicalPresent: true,
  notLoading: true,
  notError: true,
  notForbidden: true,
  rawBody: { sha256: 'a'.repeat(64), textLength: 101, images: 4 },
  domBody: { sha256: 'a'.repeat(64), textLength: 101, images: 4 },
  bodyProjectionMatched: true,
  imageKinds: { data: 1, blob: 1, exactCdn: 2, other: 0, notLoaded: 1 },
});

test('summary covers identity/readiness/body/image contract without raw fields or hashes', () => {
  const result = complete();
  for (const field of [
    'title',
    'url',
    'bookId',
    'html',
    'token',
    'ticket',
    'secret',
  ])
    Object.defineProperty(result, field, {
      get() {
        throw new Error('FORBIDDEN_READ');
      },
    });
  result.rawBody.unrecognized = 'NEVER_DISPLAY';
  const text = formatProbeSummary(result);
  for (const phrase of [
    '组件匹配：匹配；iframe可读：是',
    '号身份字段：存在；文章身份字段：存在；原文身份字段：存在',
    '文章业务关联：匹配；公众号业务关联：匹配',
    '标题匹配：匹配；来源名称匹配：匹配',
    'canonical字段：存在（只看存在性）',
    '已返回正文指纹：存在；DOM指纹：存在',
    'DOM与已返回正文一致',
    'data 1；blob 1；指定CDN 2；其他 0',
    '图片显示已加载/总数：3/4；未加载：1',
    '上游全篇完整性：未证明',
    '原始图片字节与完整保存：本轮未验证',
  ])
    assert.ok(text.includes(phrase), phrase);
  assert.ok(!text.includes('a'.repeat(64)));
  assert.ok(!text.includes('NEVER_DISPLAY'));
  assert.ok(!text.includes('有效canonical'));
  assert.ok(!text.includes('根/iframe数量'));
});

test('early-return missing fields stay unknown and explicit false stays negative', () => {
  const missing = formatProbeSummary({ supported: false, rootCount: 1 });
  assert.ok(missing.includes('组件匹配：未核实；iframe可读：未核实'));
  assert.ok(missing.includes('根/iframe数量：1/未核实'));
  assert.ok(missing.includes('号身份字段：未核实'));
  assert.ok(missing.includes('DOM与已返回正文：未核实'));
  const negative = formatProbeSummary({
    supported: false,
    componentMatched: false,
  });
  assert.ok(negative.includes('组件匹配：未匹配'));
  assert.ok(negative.includes('标题匹配：未核实'));
  const detailed = formatProbeSummary({
    supported: false,
    vuePropertyPresent: false,
    vueValuePresent: false,
    optionsPresent: false,
    namePresent: false,
  });
  assert.ok(detailed.includes('根Vue属性：不存在；实例值：不存在'));
  assert.ok(detailed.includes('组件选项：不存在；名称字段：不存在'));
  assert.ok(detailed.includes('组件匹配：未核实'));
});

test('missing raw body is not truncation evidence; valid unequal projections show only inconsistency', () => {
  const result = complete();
  result.rawBody = null;
  result.bodyProjectionMatched = false;
  const missing = formatProbeSummary(result);
  assert.ok(missing.includes('已返回正文指纹：未提供'));
  assert.ok(missing.includes('DOM与已返回正文：未核实'));
  assert.ok(!missing.includes('DOM与已返回正文不一致'));
  assert.ok(!missing.includes('截断'));
  const unequal = formatProbeSummary({
    ...complete(),
    bodyProjectionMatched: false,
  });
  assert.ok(unequal.includes('DOM与已返回正文不一致'));
  assert.ok(unequal.includes('上游全篇完整性：未证明'));
  const unknown = formatProbeSummary({
    ...complete(),
    bodyProjectionMatched: undefined,
  });
  assert.ok(unknown.includes('DOM与已返回正文：未核实'));
});

test('unrecognized values and unbounded counts cannot enter summary text', () => {
  const result = complete();
  result.titleMatched = 'https://secret.invalid/NEVER_DISPLAY';
  result.componentMatched = 1;
  result.rawBody.sha256 = 'NEVER_DISPLAY';
  result.domBody.images = -1;
  result.rootCount = Infinity;
  result.frameCount = 10001;
  result.imageKinds = {
    data: -1,
    blob: 'NEVER_DISPLAY',
    exactCdn: 10001,
    other: 0,
    notLoaded: NaN,
  };
  const text = formatProbeSummary(result);
  assert.ok(text.includes('标题匹配：未核实'));
  assert.ok(text.includes('组件匹配：未核实'));
  assert.ok(text.includes('图片显示已加载/总数：未核实'));
  assert.ok(!text.includes('NEVER_DISPLAY'));
  assert.ok(!text.includes('10001'));
  assert.ok(!text.includes('Infinity'));
});

function harness(execute) {
  const elements = new Map();
  for (const selector of ['#probe', '#probe-summary', '#status', '#task'])
    elements.set(selector, {
      disabled: false,
      textContent: '',
      addEventListener(name, handler) {
        this[name] = handler;
      },
    });
  const calls = [];
  const chrome = {
    tabs: {
      query: async () => [
        { id: 4, url: 'https://weread.qq.com/web/mp/reader/fixture' },
      ],
    },
    scripting: {
      executeScript: async (options) => {
        calls.push(options);
        assert.equal(options.world, 'MAIN');
        assert.deepEqual(options.target, { tabId: 4 });
        assert.equal(options.func, probeOfficialArticle);
        return execute();
      },
    },
  };
  Object.defineProperty(chrome, 'permissions', {
    get() {
      throw new Error('NO_PERMISSION_ACCESS');
    },
  });
  const document = { querySelector: (selector) => elements.get(selector) };
  bindPopup(document, chrome, () => {
    throw new Error('NO_NETWORK');
  });
  return { elements, calls, click: () => elements.get('#probe').click() };
}

test('actual popup click renders per-field feedback with exactly one MAIN probe and zero network/permission actions', async () => {
  const result = {
    ...complete(),
    titleMatched: false,
    canonicalPresent: false,
  };
  const h = harness(async () => [{ frameId: 0, result }]);
  await h.click();
  assert.equal(h.calls.length, 1);
  const text = h.elements.get('#probe-summary').textContent;
  assert.ok(text.includes('标题匹配：未匹配'));
  assert.ok(text.includes('canonical字段：不存在'));
  assert.equal(h.elements.get('#probe').disabled, false);
});

test('probe failure shows unknown without exposing exception or retrying', async () => {
  const h = harness(async () => {
    throw new Error('NEVER_DISPLAY');
  });
  await h.click();
  assert.equal(h.calls.length, 1);
  assert.ok(
    h.elements.get('#probe-summary').textContent.includes('组件匹配：未核实'),
  );
  assert.ok(!h.elements.get('#status').textContent.includes('NEVER_DISPLAY'));
  assert.ok(h.elements.get('#status').textContent.includes('未自动重试'));
});

test('concurrent repeated button event cannot run a second probe while pending', async () => {
  let finish;
  const h = harness(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const first = h.click();
  await Promise.resolve();
  await h.click();
  assert.equal(h.calls.length, 1);
  finish([
    { frameId: 0, result: { supported: false, componentMatched: false } },
  ]);
  await first;
  assert.equal(h.calls.length, 1);
});

test('popup feedback is selectable plain text, with no HTML rendering or clipboard permission', async () => {
  const html = await readFile(new URL('./popup.html', import.meta.url), 'utf8');
  const script = await readFile(
    new URL('./popup.mjs', import.meta.url),
    'utf8',
  );
  const manifest = JSON.parse(
    await readFile(new URL('./manifest.json', import.meta.url), 'utf8'),
  );
  assert.match(html, /<pre\s+id="probe-summary"/);
  assert.match(html, /max-height: 300px;\s+overflow: auto/);
  assert.match(html, /max-height: 560px; overflow-y: auto/);
  assert.match(html, /<details>\s+<summary>/);
  assert.ok(!html.includes('<details open'));
  assert.ok(
    html.includes(
      '本次只读核验可在已打开的官方文章页直接执行，无需任务配置。回送未启用；后台停止状态保留。',
    ),
  );
  assert.ok(!html.includes('发起指定任务'));
  assert.ok(!html.includes('完成正常验证'));
  assert.ok(!script.includes('innerHTML'));
  assert.ok(!script.includes('clipboard'));
  assert.equal(manifest.version, '0.2.0');
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting']);
});
