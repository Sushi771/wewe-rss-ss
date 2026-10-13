import assert from 'node:assert/strict';
import test from 'node:test';
import { bindTaskControls } from './popup.mjs';
import { localEndpoint } from './task-client.mjs';

const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
const d = {
  title: 'Synthetic current article',
  publisher: 'Synthetic publisher',
  originalUrl:
    'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=2247000001&idx=1&sn=abcd',
  publishTime: 1700000000,
  imageCount: 1,
  destination: '/tmp/synthetic-notes',
};
function harness(options = {}) {
  const elements = new Map(),
    calls = [];
  for (const name of [
    'grant',
    'prepare',
    'send',
    'cancel',
    'revoke',
    'content-consent',
    'permission-consent',
    'base',
    'key',
    'taskId',
    'status',
    'task-review',
    'task',
    'current-tab',
  ]) {
    const value = {
      disabled: false,
      checked: false,
      textContent: '',
      value: '',
      addEventListener(event, run) {
        this[event] = run;
      },
    };
    Object.defineProperty(value, 'innerHTML', {
      set() {
        throw new Error('HTML_RENDER_FORBIDDEN');
      },
    });
    elements.set('#' + name, value);
  }
  const el = (name) => elements.get('#' + name);
  el('base').value = 'http://127.0.0.1:4000/';
  el('key').value = 'k'.repeat(43);
  el('taskId').value = '12345678-1234-1234-1234-123456789012';
  let permission = false;
  const tab = {
    id: 4,
    windowId: 2,
    url: 'https://weread.qq.com/web/mp/reader/fixture',
    title: 'Synthetic browser title',
  };
  const chrome = {
    tabs: { query: async () => [tab], get: async () => tab },
    permissions: {
      request: async (value) => {
        calls.push({ request: value });
        permission = options.grant
          ? await options.grant()
          : options.denied !== true;
        return permission;
      },
      contains: async () => permission,
      remove: async (value) => {
        calls.push({ remove: value });
        permission = false;
        return true;
      },
    },
    scripting: {
      executeScript: async (value) => {
        calls.push({ script: value });
        assert.equal(value.world, 'ISOLATED');
        assert.deepEqual(
          value.args[0].expectedArticle,
          options.disclosure || d,
        );
        if (options.script) await options.script();
        return [
          {
            frameId: 0,
            result: {
              pageUrl: tab.url,
              html: 'synthetic reduced HTML',
              images: [
                {
                  index: 0,
                  inline: options.remote
                    ? null
                    : 'data:image/png;base64,' + png,
                  ...(options.remote
                    ? { source: 'https://mmbiz.qpic.cn/synthetic-image' }
                    : {}),
                },
              ],
              omittedEmptyImageNodes: 27,
              assetFingerprint: 'a'.repeat(64),
            },
          },
        ];
      },
    },
  };
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.startsWith('https:')) {
      if (options.media) await options.media(init.signal);
      return new Response(Buffer.from(png, 'base64'), {
        status: 200,
        headers: { 'content-type': 'image/png' },
      });
    }
    if (url.endsWith('/claim') && options.claim) await options.claim();
    if (url.endsWith('/complete') && options.complete) await options.complete();
    const body = url.endsWith('/claim')
      ? {
          nonce: 'n'.repeat(43),
          expiresAt: new Date(
            Date.now() + (options.expired ? -1 : 300000),
          ).toISOString(),
          contentMode: 'confirmed-dom',
          confirmedImageCount: 1,
          disclosure: options.disclosure || d,
        }
      : { accepted: true };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  bindTaskControls(
    { querySelector: (selector) => elements.get(selector) },
    chrome,
    fetch,
  );
  return {
    el,
    calls,
    click: (name) => el(name).click?.(),
    submit: () => el('task').submit({ preventDefault() {} }),
    grant: async () => {
      el('permission-consent').checked = true;
      await el('grant').click();
    },
    approve: () => {
      el('content-consent').checked = true;
      el('content-consent').change();
    },
  };
}

test('exact4000 endpoint rejects other ports, hosts, aliases, paths and credentials', () => {
  assert.equal(
    localEndpoint('http://127.0.0.1:4000/'),
    'http://127.0.0.1:4000',
  );
  for (const input of [
    'http://127.0.0.1:4001/',
    'http://127.0.0.1:11207/',
    'http://127.1:4000/',
    'http://localhost:4000/',
    'http://u@127.0.0.1:4000/',
    'http://127.0.0.1:4000/route',
    'http://127.0.0.1:4000/?x=1',
    'https://127.0.0.1:4000/',
  ])
    assert.throws(() => localEndpoint(input), /LOCAL_ENDPOINT/);
});
test('bind does no grant/body/network; explicit permission checkbox and valid configuration are required', async () => {
  const h = harness();
  await Promise.resolve();
  assert.equal(h.calls.length, 0);
  await h.click('grant');
  assert.equal(h.calls.length, 0);
  h.el('permission-consent').checked = true;
  h.el('base').value = 'http://127.0.0.1:4001/';
  await h.click('grant');
  assert.equal(h.calls.length, 0);
});
test('permission denial blocks task association, all scripts and transmission', async () => {
  const h = harness({ denied: true });
  await h.grant();
  await h.click('prepare');
  h.approve();
  await h.submit();
  assert.equal(h.calls.length, 1);
  assert(h.el('status').textContent.includes('未读取正文'));
});
test('claim disclosure precedes body confirmation and received acknowledgement never claims saved', async () => {
  const h = harness();
  await h.grant();
  await h.click('prepare');
  assert.equal(h.calls.filter((x) => x.script).length, 0);
  assert(!h.calls.some((x) => x.url?.endsWith('/complete')));
  for (const text of [
    d.title,
    d.publisher,
    d.destination,
    '原文链接：' + d.originalUrl,
    '发布时间（北京时间）：2023-11-15 06:13:20',
    '1张',
    '127.0.0.1:4000',
    '接收不等于保存成功',
  ])
    assert(h.el('task-review').textContent.includes(text));
  await h.submit();
  assert.equal(h.calls.filter((x) => x.script).length, 0);
  h.approve();
  await h.submit();
  assert.equal(h.calls.filter((x) => x.script).length, 2);
  assert.equal(h.calls.filter((x) => x.url?.endsWith('/complete')).length, 1);
  assert(h.el('status').textContent.includes('扩展不能确认保存'));
  assert(!h.el('status').textContent.includes('保存成功'));
  await h.submit();
  assert.equal(h.calls.filter((x) => x.url?.endsWith('/complete')).length, 1);
  assert.equal(h.el('key').value, '');
});
test('CDN is exact source, credential-free, no redirects/retry; one image fetch per task', async () => {
  const h = harness({ remote: true });
  await h.grant();
  await h.click('prepare');
  h.approve();
  await h.submit();
  const media = h.calls.filter((x) => x.url?.startsWith('https:'));
  assert.equal(media.length, 1);
  assert.equal(media[0].url, 'https://mmbiz.qpic.cn/synthetic-image');
  assert.equal(media[0].init.credentials, 'omit');
  assert.equal(media[0].init.redirect, 'error');
  const completed = h.calls.find((x) => x.url?.endsWith('/complete'));
  assert(!completed.init.body.includes('mmbiz.qpic.cn'));
  assert(!completed.init.body.includes('assetFingerprint'));
});
test('duplicate prepare event while claim pending cannot claim twice', async () => {
  let finish;
  const h = harness({
    claim: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await h.grant();
  const pending = h.click('prepare');
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  await h.click('prepare');
  assert.equal(h.calls.filter((x) => x.url?.endsWith('/claim')).length, 1);
  finish();
  await pending;
});
test('expired claim is cancelled before reading any body or requesting CDN', async () => {
  const h = harness({ expired: true });
  await h.grant();
  await h.click('prepare');
  h.approve();
  await h.submit();
  assert.equal(h.calls.filter((x) => x.script).length, 0);
  assert.equal(h.calls.filter((x) => x.url?.endsWith('/cancel')).length, 1);
  assert(!h.calls.some((x) => x.url?.endsWith('/complete')));
});
test('cancel during unabortable DOM execution prevents subsequent media and complete, without retries', async () => {
  let finish;
  const h = harness({
    remote: true,
    script: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await h.grant();
  await h.click('prepare');
  h.approve();
  const pending = h.submit();
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  await h.click('cancel');
  finish();
  await pending;
  await h.submit();
  await h.click('prepare');
  assert.equal(h.calls.filter((x) => x.script).length, 1);
  assert(
    !h.calls.some(
      (x) => x.url?.startsWith('https:') || x.url?.endsWith('/complete'),
    ),
  );
  assert.equal(h.calls.filter((x) => x.url?.endsWith('/cancel')).length, 1);
  assert(h.el('status').textContent.includes('已取消'));
});
test('cancel aborts the in-flight CDN fetch and prevents complete', async () => {
  let started;
  const h = harness({
    remote: true,
    media: (signal) =>
      new Promise((resolve, reject) => {
        started = true;
        signal.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true,
        });
      }),
  });
  await h.grant();
  await h.click('prepare');
  h.approve();
  const pending = h.submit();
  while (!started) await new Promise((resolve) => setImmediate(resolve));
  await h.click('cancel');
  await pending;
  assert(!h.calls.some((x) => x.url?.endsWith('/complete')));
  assert.equal(h.calls.filter((x) => x.url?.startsWith('https:')).length, 1);
});
test('late permission grant after local cancellation cannot trigger any task/read; explicit revoke removes origins', async () => {
  let finish;
  const h = harness({
    grant: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = h.grant();
  await h.click('cancel');
  finish(true);
  await pending;
  await h.click('prepare');
  h.approve();
  await h.submit();
  assert.equal(h.calls.filter((x) => x.url || x.script).length, 0);
  await h.click('revoke');
  assert.equal(h.calls.filter((x) => x.remove).length, 1);
  assert(h.el('status').textContent.includes('已撤销'));
});
test('invalid server disclosure cancels claim before capture and does not render HTML', async () => {
  const h = harness({ disclosure: { ...d, destination: '' } });
  await h.grant();
  await h.click('prepare');
  h.approve();
  await h.submit();
  assert(!h.calls.some((x) => x.script || x.url?.endsWith('/complete')));
});

test('revocation before a pending permission grant also removes a late grant', async () => {
  let finish;
  const h = harness({
    grant: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const pending = h.grant();
  await h.click('revoke');
  assert.equal(h.calls.filter((x) => x.remove).length, 1);
  finish(true);
  await pending;
  assert.equal(h.calls.filter((x) => x.remove).length, 2);
  assert(h.el('status').textContent.includes('迟到的授权已撤销'));
  await h.click('prepare');
  h.approve();
  await h.submit();
  assert(!h.calls.some((x) => x.url || x.script));
});

test('cancel after server acceptance but before acknowledgement never promises server deletion or saving', async () => {
  let finish;
  const h = harness({
    complete: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await h.grant();
  await h.click('prepare');
  h.approve();
  const pending = h.submit();
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  await h.click('cancel');
  finish();
  await pending;
  assert(h.el('status').textContent.includes('服务器可能已接收正文'));
  assert(h.el('status').textContent.includes('原 WeWe'));
  assert(!h.el('status').textContent.includes('保存成功'));
  assert.equal(h.calls.filter((x) => x.url?.endsWith('/complete')).length, 1);
  assert.equal(h.calls.filter((x) => x.url?.endsWith('/cancel')).length, 1);
});
