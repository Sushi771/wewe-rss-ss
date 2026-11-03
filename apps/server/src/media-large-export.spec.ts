import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { LocalArticleStore } from './article-local-save';
import { prepareCachedArticleLocalExport } from './cached-article-local-export';
import { automaticMediaPlan } from './collection/automatic-media-body';
import { readAutomaticMediaImage } from './feeds/automatic-media-queue';
import { canonicalArticleUrl } from './collection/collection-format';
import * as imageFetch from './collection/image-fetch';

const hash = (v: string | Buffer) =>
  createHash('sha256').update(v).digest('hex');
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});
// Actual decodable PNG pixels, not invented image headers or real user data.
function png(seed: number) {
  const pixels = Buffer.alloc((1024 * 3 + 1) * 1024);
  let state = seed;
  for (let y = 0; y < 1024; y++)
    for (let x = 1; x <= 1024 * 3; x++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      pixels[y * (1024 * 3 + 1) + x] = state & 255;
    }
  const chunk = (type: string, data: Buffer) => {
    const value = Buffer.concat([Buffer.from(type), data]);
    let crc = 0xffffffff;
    for (const byte of value) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
    const size = Buffer.alloc(4),
      check = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    check.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, value, check]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1024, 0);
  header.writeUInt32BE(1024, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
const first = png(31),
  second = png(79);
const inline = (b: Buffer) => 'data:image/png;base64,' + b.toString('base64');
const identity = canonicalArticleUrl(
  'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA==&mid=88&idx=1',
);

describe('large cached articles use existing Markdown and local attachment publisher', () => {
  const env = { ...process.env };
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'large-media-export-synthetic-'));
    const database = join(root, 'synthetic.sqlite');
    await fs.writeFile(database, 'synthetic cache binding');
    process.env.DATABASE_URL = 'file:' + database.replace(/\\/g, '/');
    await fs.mkdir(join(root, '.wechat2rss-automatic-media', 'bytes'), {
      recursive: true,
    });
    jest.spyOn(global, 'fetch').mockRejectedValue(Error('NO_NETWORK'));
    jest
      .spyOn(imageFetch, 'fetchAllowedImage')
      .mockRejectedValue(Error('UNSEEDED_IMAGE'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    process.env = { ...env };
    await fs.rm(root, { recursive: true, force: true });
  });
  const article = (html: string, status = 'available') => ({
    id: identity.id,
    mpId: identity.mpId,
    sourceUrl: identity.url,
    verifiedSourceUrl: identity.url,
    title: 'Synthetic local archive',
    publishTime: 1700000000,
    metrics: null,
    contentHtml: html,
    lastBodyStatus: status,
    updatedAt: new Date(1700000000000),
  });
  const store = () =>
    new LocalArticleStore(join(root, 'preferences.json'), join(root, 'notes'));
  async function seed(url: string, bytes: Buffer) {
    const value = {
      version: 1,
      url,
      key: hash(url),
      sha256: hash(bytes),
      inline: inline(bytes),
    };
    const file = join(
      root,
      '.wechat2rss-automatic-media',
      'bytes',
      hash(url) + '.json',
    );
    await fs.writeFile(file, JSON.stringify(value));
    return file;
  }
  async function images(saved: { directory: string; markdownPath: string }) {
    const markdown = await fs.readFile(saved.markdownPath, 'utf8');
    expect(markdown).not.toContain('data:image');
    expect(markdown).not.toContain('https://mmbiz.qpic.cn');
    const refs = [...markdown.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(
      (m) => m[1],
    );
    expect(refs.length).toBeGreaterThan(0);
    return Promise.all(
      refs.map((ref) => fs.readFile(join(saved.directory, decodeURI(ref)))),
    );
  }
  it('already exports over-8MB fully inline HTML as verified standalone attachments without HTTP', async () => {
    const row = article(
      `<div id="js_content"><p>saved text</p><img src="${inline(first)}"><img src="${inline(second)}"></div>`,
    );
    expect(Buffer.byteLength(row.contentHtml)).toBeGreaterThan(8_000_000);
    const saved = await store().save(prepareCachedArticleLocalExport(row));
    expect(saved).toMatchObject({
      imageCount: 2,
      mediaStatus: 'complete',
      missingImageCount: 0,
    });
    expect((await images(saved)).map(hash).sort()).toEqual(
      [hash(first), hash(second)].sort(),
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(imageFetch.fetchAllowedImage).not.toHaveBeenCalled();
  }, 40000);
  it('keeps the DB write limit but exports verified cached bytes and preserves manual edits on repeat', async () => {
    const source = 'https://mmbiz.qpic.cn/synthetic-cached.png';
    const file = await seed(source, second),
      originalCache = await fs.readFile(file);
    const row = article(
      `<div id="js_content" data-wewe-image-pending="1"><p>saved annotation</p><img src="${inline(first)}"><img data-src="${source}"><img></div>`,
      'images-pending',
    );
    expect(Buffer.byteLength(row.contentHtml)).toBeLessThan(8_000_000);
    expect(() =>
      automaticMediaPlan(row, new Map([[source, inline(second)]])),
    ).toThrow('MEDIA_BODY_LIMIT');
    const publisher = store(),
      prepare = prepareCachedArticleLocalExport(row);
    const saved = await publisher.save(prepare);
    expect(saved).toMatchObject({ imageCount: 2, mediaComplete: false });
    expect((await images(saved)).map(hash).sort()).toEqual(
      [hash(first), hash(second)].sort(),
    );
    await fs.writeFile(saved.markdownPath, 'manual edit remains');
    await publisher.save(prepare);
    expect(await fs.readFile(saved.markdownPath, 'utf8')).toBe(
      'manual edit remains',
    );
    expect(await fs.readFile(file)).toEqual(originalCache);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(imageFetch.fetchAllowedImage).not.toHaveBeenCalled();
  }, 120000);
  it('rejects aliased cache directories and non-file cache entries without fetching', async () => {
    const source = 'https://mmbiz.qpic.cn/synthetic-unsafe-cache.png';
    const file = await seed(source, second);
    const bytes = join(root, '.wechat2rss-automatic-media', 'bytes');
    const canonical = await fs.realpath(bytes);
    const resolve = fs.realpath.bind(fs);
    const alias = jest
      .spyOn(fs, 'realpath')
      .mockImplementation((async (value: any) =>
        String(value) === canonical
          ? join(canonical, 'untrusted-alias')
          : resolve(value)) as any);
    try {
      await expect(readAutomaticMediaImage(source)).rejects.toThrow(
        'MEDIA_STORAGE_INVALID',
      );
    } finally {
      alias.mockRestore();
    }
    await fs.rm(file);
    await fs.mkdir(file);
    await expect(readAutomaticMediaImage(source)).rejects.toThrow(
      'MEDIA_STORAGE_INVALID',
    );
    expect(imageFetch.fetchAllowedImage).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
  it('does not invent success for uncached images or fall back to HTTP for corrupt local bytes', async () => {
    const source = 'https://mmbiz.qpic.cn/synthetic-unknown.png';
    expect(await readAutomaticMediaImage(source)).toBeUndefined();
    const row = article(
      `<div id="js_content"><p>saved text</p><img src="${inline(first)}"><img data-src="${source}"></div>`,
      'images-pending',
    );
    const saved = await store().save(prepareCachedArticleLocalExport(row));
    expect(saved).toMatchObject({ imageCount: 1, mediaComplete: false });
    expect(imageFetch.fetchAllowedImage).toHaveBeenCalledTimes(1); // mock only; existing fallback policy
    expect(global.fetch).not.toHaveBeenCalled();
    const file = await seed(source, second);
    const record = JSON.parse(await fs.readFile(file, 'utf8'));
    record.sha256 = '0'.repeat(64);
    await fs.writeFile(file, JSON.stringify(record));
    await expect(readAutomaticMediaImage(source)).rejects.toThrow(
      'MEDIA_BYTES_INVALID',
    );
    expect(JSON.parse(await fs.readFile(file, 'utf8')).sha256).toBe(
      '0'.repeat(64),
    );
  }, 40000);
});
