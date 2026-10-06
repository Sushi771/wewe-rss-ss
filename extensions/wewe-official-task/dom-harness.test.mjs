import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { captureOfficialArticle } from './capture.mjs';
import { projectOfficialArticle } from './projection.mjs';
import { probeOfficialArticle } from './probe.mjs';

// Synthetic DOM facade exercises the serialized functions, with no browser
// install/CDP/platform call. This does not claim Edge permission/UI acceptance.
const require = createRequire(
  new URL('../../apps/server/package.json', import.meta.url),
);
const { load } = require('cheerio');
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
class Document {
  constructor(html) {
    this.$ = load(html);
  }
  querySelectorAll(selector) {
    return this.$(selector)
      .toArray()
      .map((node) => new Element(this, node));
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}
class Element {
  constructor(document, node) {
    this.document = document;
    this.node = node;
    this.complete = true;
    this.naturalWidth = 1;
    this.naturalHeight = 1;
  }
  get textContent() {
    return this.document.$(this.node).text();
  }
  get outerHTML() {
    return this.document.$.html(this.node);
  }
  get tagName() {
    return this.node.tagName.toUpperCase();
  }
  get attributes() {
    return Object.entries(this.node.attribs).map(([name, value]) => ({
      name,
      value,
    }));
  }
  get currentSrc() {
    return this.getAttribute('src');
  }
  getAttribute(name) {
    return this.document.$(this.node).attr(name);
  }
  setAttribute(name, value) {
    this.document.$(this.node).attr(name, value);
  }
  removeAttribute(name) {
    this.document.$(this.node).removeAttr(name);
  }
  querySelectorAll(selector) {
    return this.document
      .$(this.node)
      .find(selector)
      .toArray()
      .map((node) => new Element(this.document, node));
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  cloneNode() {
    return new Document(this.outerHTML).querySelector('#js_content');
  }
  remove() {
    this.document.$(this.node).remove();
  }
}
const html = `<meta property="og:url" content="https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv"><h1 id="activity-name">离线新文章</h1><span id="js_name">测试公众号</span><script>var biz="MTIzNDU2Nzg5MA==";var mid="2247000001";var idx="1";var sn="abcd";var ct="1700000000";var token="NEVER_RETURN";</script><div id="js_content" onclick="NEVER_RETURN"><p>完整正文开头</p><p>末尾完整内容</p><img src="data:image/png;base64,${png}" data-src="https://mmbiz.qpic.cn/fixture"></div>`;
function setup(raw = html) {
  const doc = new Document(raw);
  const frame = { srcdoc: raw, contentDocument: doc };
  globalThis.location = {
    origin: 'https://weread.qq.com',
    pathname: '/web/mp/reader/fixture',
  };
  const current = {
    reviewId: 'MP_WXS_1234567890_abcdefghijklmnopqrstuv',
    review: {
      reviewId: 'MP_WXS_1234567890_abcdefghijklmnopqrstuv',
      belongBookId: 'MP_WXS_1234567890',
      bookId: '',
      type: 16,
      mpInfo: {
        originalId: 'abcdefghijklmnopqrstuv',
        title: '离线新文章',
        mp_name: '测试公众号',
        time: 1700000008,
        pic_url: '',
      },
    },
  };
  const reader = {
    $options: { name: 'MpReader' },
    bookInfo: { bookId: 'MP_WXS_1234567890' },
    currentChapter: current,
    showLoading: false,
    showError: false,
    isBookForbidden: false,
    isBookInfoError: false,
    mpRawData: raw,
  };
  for (const field of ['$store', 'user', 'token', 'envConfig'])
    Object.defineProperty(reader, field, {
      get() {
        throw new Error('FORBIDDEN_SECRET_READ');
      },
    });
  globalThis.document = {
    querySelector: () => null,
    querySelectorAll: (selector) =>
      selector === '.wr_mp_reader'
        ? [{ __vue__: reader, querySelectorAll: () => [frame] }]
        : [frame],
  };
  globalThis.DOMParser = class {
    parseFromString(value) {
      return new Document(value);
    }
  };
  return { doc, frame, reader };
}
test('real serialized collector strips scripts/secrets/events and preserves image bytes', async () => {
  setup();
  const result = await captureOfficialArticle();
  assert.ok(!result.html.includes('NEVER_RETURN'));
  assert.ok(!result.html.includes('onclick'));
  assert.ok(result.html.includes('var ct="1700000000";'));
  assert.ok(result.html.includes('src="wewe-image:0"'));
  assert.equal(result.images[0].inline, 'data:image/png;base64,' + png);
  const projection = await projectOfficialArticle();
  assert.equal(projection.bookId, 'MP_WXS_1234567890');
  assert.equal(
    projection.current.review.reviewId,
    'MP_WXS_1234567890_abcdefghijklmnopqrstuv',
  );
  assert.match(projection.bodyFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(Object.keys(projection).length, 3);
});

test('probe title/source matches require nonempty business and DOM values', async () => {
  setup();
  const success = await probeOfficialArticle();
  assert.equal(success.titleMatched, true);
  assert.equal(success.publisherMatched, true);
  assert.equal(success.bodyProjectionMatched, true);
  assert.equal(success.canonicalPresent, true);
  for (const htmlValue of [
    html,
    html.replace(/<h1[^>]*>.*?<\/h1>|<span[^>]*>.*?<\/span>/g, ''),
  ]) {
    const partial = setup(htmlValue);
    partial.reader.currentChapter.review.mpInfo.title = '';
    partial.reader.currentChapter.review.mpInfo.mp_name = undefined;
    const result = await probeOfficialArticle();
    assert.equal(result.titleMatched, false);
    assert.equal(result.publisherMatched, false);
    assert.equal(Object.hasOwn(result, 'title'), false);
    assert.equal(Object.hasOwn(result, 'bookId'), false);
  }
  setup(html.replace(/<h1[^>]*>.*?<\/h1>|<span[^>]*>.*?<\/span>/g, ''));
  const domMissing = await probeOfficialArticle();
  assert.equal(domMissing.titleMatched, false);
  assert.equal(domMissing.publisherMatched, false);
});

test('probe first gate separates absent Vue/name from mismatch without business values or tree reads', async () => {
  setup();
  const root = {};
  globalThis.document.querySelectorAll = () => [root];
  const absent = await probeOfficialArticle();
  assert.equal(absent.vuePropertyPresent, false);
  assert.equal(absent.vueValuePresent, false);
  assert.equal(absent.namePresent, false);
  assert.equal(Object.hasOwn(absent, 'componentMatched'), false);
  root.__vue__ = null;
  const emptyInstance = await probeOfficialArticle();
  assert.equal(emptyInstance.vuePropertyPresent, true);
  assert.equal(emptyInstance.vueValuePresent, false);
  const reader = {};
  root.__vue__ = reader;
  for (const field of [
    'bookInfo',
    'currentChapter',
    'mpRawData',
    '$store',
    'user',
    'token',
    'envConfig',
    '$children',
    '$parent',
  ])
    Object.defineProperty(reader, field, {
      get() {
        throw new Error('NO_VALUE_OR_TREE_READ');
      },
    });
  const anonymous = await probeOfficialArticle();
  assert.equal(anonymous.vueValuePresent, true);
  assert.equal(anonymous.optionsPresent, false);
  assert.equal(Object.hasOwn(anonymous, 'componentMatched'), false);
  assert.equal(anonymous.displayedBookFieldDefined, true);
  assert.equal(anonymous.displayedChapterFieldDefined, true);
  assert.equal(anonymous.displayedBodyFieldDefined, true);
  reader.$options = {};
  const nameless = await probeOfficialArticle();
  assert.equal(nameless.optionsPresent, true);
  assert.equal(nameless.namePresent, false);
  assert.equal(Object.hasOwn(nameless, 'componentMatched'), false);
  reader.$options = { name: 'SyntheticOtherComponent' };
  const mismatch = await probeOfficialArticle();
  assert.equal(mismatch.namePresent, true);
  assert.equal(mismatch.componentMatched, false);
  assert.ok(!JSON.stringify(mismatch).includes('SyntheticOtherComponent'));
  assert.equal(Object.hasOwn(mismatch, 'rawBody'), false);
});
test('readiness / conflicting static identity / challenge refuse before return', async () => {
  const h = setup();
  h.reader.showError = true;
  await assert.rejects(projectOfficialArticle(), /READER_NOT_READY/);
  setup(
    html.replace(
      'var ct="1700000000";',
      'var ct="1700000000";var ct="1700000001";',
    ),
  );
  await assert.rejects(captureOfficialArticle(), /SCALAR_CONFLICT/);
  setup(html + '<div id="js_verify"></div>');
  await assert.rejects(captureOfficialArticle(), /UNSUPPORTED_OR_CHALLENGE/);
});

test('same-origin existing Blob is read as bounded original bytes', async () => {
  setup(
    html.replace(
      'data:image/png;base64,' + png,
      'blob:https://weread.qq.com/offline',
    ),
  );
  const originalFetch = globalThis.fetch;
  const originalReader = globalThis.FileReader;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'blob:https://weread.qq.com/offline');
    assert.equal(options.credentials, 'omit');
    return new Response(Buffer.from(png, 'base64'), {
      headers: { 'Content-Type': 'image/png' },
    });
  };
  globalThis.FileReader = class {
    readAsDataURL(blob) {
      blob.arrayBuffer().then((bytes) => {
        this.result =
          'data:' +
          blob.type +
          ';base64,' +
          Buffer.from(bytes).toString('base64');
        this.onload();
      });
    }
  };
  try {
    assert.equal(
      (await captureOfficialArticle()).images[0].inline,
      'data:image/png;base64,' + png,
    );
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.FileReader = originalReader;
  }
});

test('DOM-only candidate reads the evidenced class/srcdoc frame with no Vue or network', async () => {
  const h = setup(
    html.replace(
      'data:image/png;base64,' + png,
      'blob:https://weread.qq.com/offline',
    ),
  );
  h.frame.id = '';
  h.frame.className = 'mp_i_frame fontLevel2';
  const selectors = [];
  globalThis.document.querySelectorAll = (selector) => {
    selectors.push(selector);
    assert.equal(selector, 'iframe.mp_i_frame[srcdoc]');
    return [h.frame];
  };
  Object.defineProperty(h.frame, '__vue__', {
    get() {
      throw new Error('NO_VUE_READ');
    },
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw new Error('NO_NETWORK_OR_BLOB_READ');
  };
  try {
    const result = await captureOfficialArticle({ candidateOnly: true });
    assert.equal(result.candidateOnly, true);
    assert.equal(result.verification.articleIdentity, 'unverified');
    assert.equal(result.verification.reviewBinding, 'unavailable');
    assert.equal(result.verification.upstreamCompleteness, 'unproved');
    assert.equal(result.verification.imageBytes, 'unverified');
    assert.deepEqual(result.images, [{ index: 0, kind: 'blob', loaded: true }]);
    assert.ok(!result.html.includes('NEVER_RETURN'));
    assert.ok(!result.html.includes('blob:'));
    assert.ok(result.html.includes('src="wewe-image:0"'));
    assert.deepEqual(selectors, ['iframe.mp_i_frame[srcdoc]']);
    assert.equal(Object.hasOwn(result, 'projection'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DOM candidate preserves missing canonical/identity as missing, never synthesizes values', async () => {
  setup(html.replace(/<meta[^>]*>|<script>.*?<\/script>/g, ''));
  const result = await captureOfficialArticle({ candidateOnly: true });
  assert.equal(result.fieldsPresent.canonical, false);
  assert.equal(result.fieldsPresent.biz, false);
  assert.equal(result.fieldsPresent.mid, false);
  assert.equal(result.fieldsPresent.idx, false);
  assert.equal(result.fieldsPresent.publishTime, false);
  assert.equal(result.fieldsPresent.title, true);
  assert.equal(result.fieldsPresent.publisher, true);
  assert.ok(!result.html.includes('og:url'));
  assert.ok(!result.html.includes('var biz'));
  assert.equal(result.images[0].kind, 'data');
  assert.equal(Object.hasOwn(result.images[0], 'inline'), false);
  await assert.rejects(captureOfficialArticle(), /IDENTITY_UNAVAILABLE/);
});

test('DOM candidate retains challenge, ambiguity, conflict, and size refusal', async () => {
  for (const [raw, error] of [
    [html + '<div id="js_verify"></div>', /UNSUPPORTED_OR_CHALLENGE/],
    [
      html.replace(
        'var ct="1700000000";',
        'var ct="1700000000";var ct="1700000001";',
      ),
      /SCALAR_CONFLICT/,
    ],
    [html + '<div id="js_content">ambiguous</div>', /BODY_MISSING/],
  ]) {
    setup(raw);
    await assert.rejects(
      captureOfficialArticle({ candidateOnly: true }),
      error,
    );
  }
  const h = setup();
  globalThis.document.querySelectorAll = () => [h.frame, h.frame];
  await assert.rejects(
    captureOfficialArticle({ candidateOnly: true }),
    /ARTICLE_FRAME_AMBIGUOUS/,
  );
  const tooLarge = setup();
  tooLarge.frame.srcdoc = 'x'.repeat(15_000_001);
  await assert.rejects(
    captureOfficialArticle({ candidateOnly: true }),
    /FRAME_UNREADABLE/,
  );
});

test('DOM candidate describes unloaded remote images without requesting or returning source URLs', async () => {
  const h = setup(
    html.replace(
      'data:image/png;base64,' + png,
      'https://mmbiz.qpic.cn/fixture',
    ),
  );
  const originalAll = h.doc.querySelectorAll.bind(h.doc);
  h.doc.querySelectorAll = (selector) =>
    originalAll(selector).map((node) => {
      const originalChildren = node.querySelectorAll.bind(node);
      node.querySelectorAll = (childSelector) =>
        originalChildren(childSelector).map((child) => {
          if (child.tagName === 'IMG') {
            child.complete = false;
            child.naturalWidth = 0;
          }
          return child;
        });
      return node;
    });
  const result = await captureOfficialArticle({ candidateOnly: true });
  assert.deepEqual(result.images, [
    { index: 0, kind: 'exactCdn', loaded: false },
  ]);
  assert.ok(!JSON.stringify(result).includes('https://mmbiz.qpic.cn'));
});
