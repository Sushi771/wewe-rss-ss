import { load } from 'cheerio';
import axios from 'axios';
import * as dns from 'node:dns/promises';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildArticleDownload,
  downloadArticleUrl,
  downloadRedirectKind,
  publicDownloadAddress,
  requestDownloadResource,
  resolveDownloadAddress,
} from './article-download';
import { buildArticleMarkdown } from './article-export';

const url =
  'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=2247000001&idx=1&sn=abcdef';
jest.mock('node:dns/promises', () => ({ lookup: jest.fn() }));
const shortUrl = 'https://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
  'base64',
);
const fixture = (
  body = '<p>离线正文测试</p><img data-src="https://mmbiz.qpic.cn/one?wx_fmt=png"><img data-src="https://mmbiz.qpic.cn/two?wx_fmt=png">',
) =>
  `<meta property="og:url" content="${shortUrl}"><h1 id="activity-name">离线收藏测试</h1><div id="js_content">${body}</div><script>var biz="MTIzNDU2Nzg5MA==";var mid="2247000001";var idx="1";var sn="abcdef";var ct=1700000000;</script>`;

describe('single article download, synthetic fixtures and no network', () => {
  let directory: string;
  beforeEach(async () => {
    jest
      .spyOn(axios, 'get')
      .mockRejectedValue(new Error('REAL_NETWORK_DISABLED'));
    directory = await mkdtemp(join(tmpdir(), 'wewe-download-test-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('reuses the exporter to create offline HTML, Markdown and real image files', async () => {
    const request = jest.fn(async (target: string) =>
      target.startsWith('https://mp.weixin.qq.com/')
        ? { bytes: Buffer.from(fixture()), type: 'text/html', status: 200 }
        : { bytes: png, type: 'image/png', status: 200 },
    );
    const result = await buildArticleDownload(
      url + '&pass_ticket=secret&key=credential',
      directory,
      request,
    );
    expect(result).toEqual({ filename: '离线收藏测试.zip', imageCount: 2 });
    const html = await readFile(join(directory, 'index.html'), 'utf8');
    const markdown = await readFile(join(directory, 'index.md'), 'utf8');
    expect(html).toContain('离线正文测试');
    expect(markdown).toContain('原文来源：');
    expect(html + markdown).not.toMatch(
      /secret|credential|pass_ticket|\/proxy\/image|<script/i,
    );
    const $ = load(html);
    expect($('img')).toHaveLength(2);
    for (const image of $('img').toArray()) {
      const relative = $(image).attr('src')!;
      expect(relative).toMatch(/^attachments\/image_[a-f0-9]{32}\.png$/);
      expect(markdown).toContain(relative);
      expect(await readFile(join(directory, relative))).toEqual(png);
    }
    expect(request.mock.calls[0][0]).toBe(downloadArticleUrl(url));
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('supports a verified short URL without transporting its query credentials', async () => {
    const request = jest.fn().mockResolvedValue({
      bytes: Buffer.from(fixture('<p>正文</p>')),
      type: 'text/html',
      status: 200,
    });
    await buildArticleDownload(shortUrl + '?key=secret', directory, request);
    expect(request).toHaveBeenCalledWith(shortUrl, 5_000_000);
  });

  it.each([
    'http://mp.weixin.qq.com/s/abcdefghijklmnopqrstuv',
    'https://127.0.0.1/s',
    'https://mp.weixin.qq.com.evil.invalid/s',
    'https://user:secret@mp.weixin.qq.com/s',
    'https://mp.weixin.qq.com:444/s/abcdefghijklmnopqrstuv',
    'file:///private',
    'https://mp.weixin.qq.com/mp/verify',
    url + '&mid=999',
    url.replace('abcdef', 'invalid'),
  ])('rejects invalid links before a request: %s', async (input) => {
    const request = jest.fn();
    await expect(
      buildArticleDownload(input, directory, request),
    ).rejects.toThrow('有效');
    expect(request).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    '<html>请登录</html>',
    '<div id="js_verify">请完成验证</div>',
    fixture('<script>unsafe()</script>'),
    fixture('<p> </p>'),
    fixture('<p>正文</p>') +
      '<iframe src="https://captcha.qq.com/verify"></iframe>',
    fixture('<p>正文</p>').replace('var sn="abcdef"', 'var sn="fedcba"'),
  ])('does not save an invalid or challenged page', async (html) => {
    const request = jest.fn().mockResolvedValue({
      bytes: Buffer.from(html),
      type: 'text/html',
      status: 200,
    });
    await expect(buildArticleDownload(url, directory, request)).rejects.toThrow(
      '未生成',
    );
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([302, 403, 429])('stops on article HTTP %s', async (status) => {
    const request = jest.fn().mockResolvedValue({
      bytes: Buffer.from(fixture()),
      type: 'text/html',
      status,
    });
    await expect(buildArticleDownload(url, directory, request)).rejects.toThrow(
      '未生成',
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, 'UPSTREAM_HTTP_ERROR', '要求登录'],
    [403, 'UPSTREAM_HTTP_ERROR', '拒绝访问'],
    [404, 'UPSTREAM_HTTP_ERROR', '链接不可用'],
    [429, 'RATE_LIMITED', '暂勿重复点击'],
    [500, 'UPSTREAM_HTTP_ERROR', '异常状态'],
  ])(
    'keeps HTTP %s provenance and does not retry or fetch images',
    async (status, code, reason) => {
      const request = jest.fn().mockResolvedValue({
        bytes: Buffer.from(fixture()),
        type: 'text/html',
        status,
      });
      const failure = await buildArticleDownload(url, directory, request).catch(
        (error) => error,
      );
      expect(failure.message).toContain(reason);
      expect(failure.message).toContain(`HTTP ${status}`);
      expect(failure.diagnostic).toEqual({
        code,
        stage: 'article',
        upstreamStatus: status,
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it.each([
    [
      '/mp/wappoc_appmsgcaptcha?key=secret',
      'verification',
      'VERIFICATION_REDIRECT',
    ],
    [
      'https://open.weixin.qq.com/connect/oauth2?code=secret',
      'login',
      'LOGIN_REDIRECT',
    ],
    [shortUrl + '?pass_ticket=secret', 'article', 'UNSUPPORTED_REDIRECT'],
    [
      'https://evil.invalid/private?token=secret',
      'other',
      'UNSUPPORTED_REDIRECT',
    ],
    ['', 'missing', 'UNSUPPORTED_REDIRECT'],
  ])(
    'classifies redirect %s without following or exposing its destination',
    async (location, kind, code) => {
      const redirectKind = downloadRedirectKind(location, url);
      expect(redirectKind).toBe(kind);
      const request = jest.fn().mockResolvedValue({
        bytes: Buffer.alloc(0),
        type: 'text/html',
        status: 302,
        redirectKind,
      });
      const failure = await buildArticleDownload(url, directory, request).catch(
        (error) => error,
      );
      expect(failure.diagnostic).toEqual({
        code,
        stage: 'article',
        upstreamStatus: 302,
        redirectKind: kind,
      });
      expect(
        JSON.stringify({ message: failure.message, ...failure.diagnostic }),
      ).not.toMatch(/secret|token|pass_ticket|evil\.invalid/);
      expect(request).toHaveBeenCalledTimes(1);
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it('distinguishes an HTTP 200 non-HTML response from a redirect', async () => {
    const request = jest.fn().mockResolvedValue({
      bytes: Buffer.from('{"token":"secret"}'),
      type: 'application/json',
      status: 200,
    });
    const failure = await buildArticleDownload(url, directory, request).catch(
      (error) => error,
    );
    expect(failure.diagnostic.code).toBe('NON_HTML_RESPONSE');
    expect(failure.message).not.toMatch(/secret|跳转|登录/);
    expect(await readdir(directory)).toEqual([]);
  });

  it.each([
    ['ETIMEDOUT', 'connect secret timeout', 'NETWORK_TIMEOUT'],
    ['ENOTFOUND', 'secret hostname', 'DNS_FAILURE'],
    [
      'ERR_BAD_RESPONSE',
      'maxContentLength size secret exceeded',
      'RESOURCE_TOO_LARGE',
    ],
  ])(
    'keeps transport reason %s without exposing raw exception text',
    async (code, message, expected) => {
      const request = jest
        .fn()
        .mockRejectedValue(Object.assign(new Error(message), { code }));
      const failure = await buildArticleDownload(url, directory, request).catch(
        (error) => error,
      );
      expect(failure.diagnostic).toEqual({ code: expected, stage: 'article' });
      expect(failure.message).not.toContain('secret');
      expect(request).toHaveBeenCalledTimes(1);
      expect(await readdir(directory)).toEqual([]);
    },
  );

  it('preserves image HTTP provenance and never returns a partial final file', async () => {
    const request = jest.fn(async (target: string) =>
      target.startsWith('https://mp.weixin.qq.com/')
        ? {
            bytes: Buffer.from(
              fixture(
                '<p>正文</p><img data-src="https://mmbiz.qpic.cn/one?wx_fmt=png">',
              ),
            ),
            type: 'text/html',
            status: 200,
          }
        : { bytes: Buffer.alloc(0), type: 'text/html', status: 429 },
    );
    const failure = await buildArticleDownload(url, directory, request).catch(
      (error) => error,
    );
    expect(failure.diagnostic).toEqual({
      code: 'RATE_LIMITED',
      stage: 'image',
      upstreamStatus: 429,
    });
    expect(request).toHaveBeenCalledTimes(2);
    expect(await readdir(directory)).not.toContain('index.html');
    expect(await readdir(directory)).not.toContain('index.md');
  });

  it('strips executable HTML and escapes a title before export', async () => {
    const html = fixture(
      '<p onclick="alert(1)">安全正文</p><script>alert(1)</script><iframe src="http://127.0.0.1"></iframe><a href="javascript:alert(1)">链接文字</a><video><source src="https://evil.invalid/movie"></video>',
    ).replace('离线收藏测试', '&lt;img src=x onerror=alert(1)&gt;');
    await buildArticleDownload(
      url,
      directory,
      jest.fn().mockResolvedValue({
        bytes: Buffer.from(html),
        type: 'text/html',
        status: 200,
      }),
    );
    const exported = await readFile(join(directory, 'index.html'), 'utf8');
    const $ = load(exported);
    expect(
      $('script, iframe, video, source, [onclick], [onerror]'),
    ).toHaveLength(0);
    expect($('h1').text()).toBe('<img src=x onerror=alert(1)>');
    expect($('a[href]')).toHaveLength(1);
    expect($('a[href]').attr('href')).toBe(downloadArticleUrl(url));
  });

  it.each([
    { bytes: png, type: 'image/png', status: 302 },
    { bytes: Buffer.from('login page'), type: 'text/html', status: 200 },
    { bytes: png.subarray(0, -12), type: 'image/png', status: 200 },
  ])('never returns a successful bundle with a failed image', async (image) => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        bytes: Buffer.from(
          fixture(
            '<p>正文</p><img src="https://mmbiz.qpic.cn/one?wx_fmt=png">',
          ),
        ),
        type: 'text/html',
        status: 200,
      })
      .mockResolvedValue(image);
    await expect(buildArticleDownload(url, directory, request)).rejects.toThrow(
      '未生成',
    );
    expect(await readdir(directory)).not.toContain('index.md');
    expect(await readdir(directory)).not.toContain('index.html');
  });

  it('rejects unsafe image destinations and excessive image count', async () => {
    for (const body of [
      '<p>正文</p><img src="http://127.0.0.1/private">',
      '<p>正文</p>' + '<img src="https://mmbiz.qpic.cn/photo">'.repeat(61),
    ]) {
      const request = jest.fn().mockResolvedValue({
        bytes: Buffer.from(fixture(body)),
        type: 'text/html',
        status: 200,
      });
      await expect(
        buildArticleDownload(url, directory, request),
      ).rejects.toThrow('未生成');
      expect(request).toHaveBeenCalledTimes(1);
    }
  });

  it('counts embedded and remote image bytes together before producing a download', async () => {
    // Container fixture for the byte-budget boundary; the small PNG is used for actual rendering.
    const large = Buffer.concat([
      png.subarray(0, -12),
      Buffer.alloc(10_000_000 - png.length),
      png.subarray(-12),
    ]);
    const html = fixture(
      `<p>正文</p><img src="data:image/png;base64,${png.toString('base64')}"><img src="https://mmbiz.qpic.cn/one?wx_fmt=png"><img src="https://mmbiz.qpic.cn/two?wx_fmt=png">`,
    );
    const request = jest.fn(async (target: string) =>
      target.startsWith('https://mp.weixin.qq.com/')
        ? { bytes: Buffer.from(html), type: 'text/html', status: 200 }
        : { bytes: large, type: 'image/png', status: 200 },
    );
    await expect(buildArticleDownload(url, directory, request)).rejects.toThrow(
      '未生成',
    );
    expect(await readdir(directory)).not.toContain('index.md');
    expect(await readdir(directory)).not.toContain('index.html');
  });

  it('keeps existing subscription browser and offline export behavior', async () => {
    const sourceUrl = downloadArticleUrl(url);
    const article = {
      id: 'WX_1234567890_2247000001_1',
      title: '已保存文章',
      sourceUrl,
      contentHtml: `<div class="rich_media_content"><p>已保存正文</p><img src="data:image/png;base64,${png.toString('base64')}"></div>`,
      lastBodyStatus: null,
      metrics: null,
      publishTime: 1700000000,
    };
    const browser = await buildArticleMarkdown(
      article,
      'http://localhost:4000',
    );
    expect(browser.markdown).toContain('已保存正文');
    expect(browser.markdown).toContain(sourceUrl);
    expect(browser.markdown).toContain('data:image/png;base64,');
    const offline = await buildArticleMarkdown(
      article,
      'http://localhost:4000',
      directory,
    );
    expect(offline.markdown).toContain('attachments/image_');
    expect(offline.markdown).not.toContain('/proxy/image');
    expect((await readdir(join(directory, 'attachments'))).length).toBe(1);
  });

  it('rejects private/reserved DNS results including IPv4-mapped IPv6', async () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '172.16.0.1',
      '192.168.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '198.18.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '::1',
      'fc00::1',
      'fe80::1',
      '::ffff:127.0.0.1',
      '2002:7f00:1::',
      '2001:db8::1',
    ])
      expect(publicDownloadAddress(address)).toBe(false);
    expect(publicDownloadAddress('8.8.8.8')).toBe(true);
    expect(publicDownloadAddress('2606:4700::1111')).toBe(true);
    jest.mocked(dns.lookup).mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ] as never);
    await expect(resolveDownloadAddress('mp.weixin.qq.com')).rejects.toThrow(
      '安全',
    );
  });

  it('pins validated DNS in the socket and disables redirects, proxies and credentials', async () => {
    jest
      .mocked(dns.lookup)
      .mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never);
    const get = jest
      .spyOn(axios, 'get')
      .mockImplementation(async (_url, options) => {
        expect(options).toMatchObject({
          proxy: false,
          maxRedirects: 0,
          timeout: 15000,
          maxContentLength: 1000,
        });
        expect(options?.headers).not.toHaveProperty('cookie');
        expect(options?.headers).not.toHaveProperty('authorization');
        const lookupSocket = options?.httpsAgent.options.lookup;
        await new Promise<void>((resolve) =>
          lookupSocket(
            'mp.weixin.qq.com',
            { all: true },
            (error: Error | null, addresses: unknown) => {
              expect(error).toBeNull();
              expect(addresses).toEqual([{ address: '8.8.8.8', family: 4 }]);
              resolve();
            },
          ),
        );
        return { status: 302, data: Buffer.alloc(0), headers: {} };
      });
    expect((await requestDownloadResource(url, 1000)).status).toBe(302);
    expect(get).toHaveBeenCalledTimes(1);
  });
});
