import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { LocalArticleStore } from '../article-local-save';
import { XiaohongshuService } from './xiaohongshu.service';
import { articlePageRequest } from './article-page';

jest.mock('./article-page', () => ({
  ...jest.requireActual('./article-page'),
  articlePageRequest: jest.fn(() => {
    throw Error('ORACLE_NETWORK_FORBIDDEN');
  }),
}));

// Independent acceptance oracle. Requires existing Python + Pillow, configurable
// with XHS_TEST_PYTHON. No network, provider, database, application HTML parser,
// Markdown exporter or image validator is used to compute the expectations.
// PNGs were authored offline with these explicit RGBA pixels using Pillow.
const pictures = [
  {
    base64:
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADklEQVR4nGP4z8DwHwQBEPgD/U6VwW8AAAAASUVORK5CYII=',
    width: 2,
    height: 1,
    rgba: 'ff0000ff00ff00ff',
    sha256: '5a852fbaaaecaf4cd14c01e150c7f881c5c5894b0a1e3c53be7e007c58374ee6',
  },
  {
    base64:
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAACCAYAAACZgbYnAAAADklEQVR4nGNgYPj/H4wAFPUE/Emk7RQAAAAASUVORK5CYII=',
    width: 1,
    height: 2,
    rgba: '0000ffffffff00ff',
    sha256: 'e0499f35da713e56bbbaff43a57c95deb1ddcedf04788151bdb956b59ca827a8',
  },
  {
    base64:
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGElEQVR4nAXBAQEAAAjDIG7/zhOmalyYeUIGBQKBnusGAAAAAElFTkSuQmCC',
    width: 2,
    height: 2,
    rgba: '00ffffffff00ffffffffffff000000ff',
    sha256: 'adea2032e2b853ef4faf1c6891384ed1e8c3be2beaf59a3f51c2afccdefc1e20',
  },
] as const;
// Deliberately written separately from HTML. Do not derive this from fixture HTML
// or use the production text cleaner: disappearing paragraphs must remain visible.
const expectedBody = [
  'Paragraph alpha: rice & tea.',
  '[IMAGE]',
  'Middle paragraph: keep every sentence, including 2 < 3.',
  '[IMAGE]',
  'Final paragraph: order matters.',
  '[IMAGE]',
];
const html = `<div id="js_content">
  <p>Paragraph alpha: rice &amp; tea.</p>
  <p><img src="data:image/png;base64,${pictures[0].base64}"></p>
  <p>Middle paragraph: keep every sentence, including 2 &lt; 3.</p>
  <p><img src="data:image/png;base64,${pictures[1].base64}"></p>
  <p>Final paragraph: order matters.</p>
  <p><img src="data:image/png;base64,${pictures[2].base64}"></p>
</div>`;
const noteId = '["xiaohongshu","note","synthetic-integrity"]';
const fail = (code: string): never => {
  throw Error(code);
};
// Only these HTML escapes and formatting whitespace may be normalized. Neither
// punctuation, case, paragraph membership nor paragraph/image ordering is erased.
const normalize = (s: string) =>
  s
    .replace(
      /&(amp|lt|gt|quot|#39);/g,
      (_, entity: string) =>
        ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[entity]!,
    )
    .replace(/[ \t\r\n]+/g, ' ')
    .trim();
function imageLinks(markdown: string) {
  return [...markdown.matchAll(/!\[[^\]]*\]\(([^)\r\n]+)\)/g)].map(
    (match) => match[1],
  );
}
async function inspectSaved(markdownPath: string) {
  const markdown = await fs.readFile(markdownPath, 'utf8');
  const references = imageLinks(markdown);
  if (references.length !== 3) fail('ORACLE_IMAGE_COUNT_MISMATCH');
  // Strict, single heading boundary followed by one known provenance block.
  // Only export metadata before this boundary is outside this body-only oracle.
  const parts = markdown
    .replace(/\r\n/g, '\n')
    .split('# Synthetic integrity note\n\n');
  if (parts.length !== 2) fail('ORACLE_BODY_BOUNDARY_MISMATCH');
  const blocks = parts[1]
    .split(/\n[ \t]*\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    blocks.shift() !==
    '原文来源：[原文](https://www.xiaohongshu.com/explore/synthetic-integrity)'
  )
    fail('ORACLE_PROVENANCE_MISMATCH');
  const body = blocks.map((block) =>
    normalize(block.replace(/!\[[^\]]*\]\(([^)\r\n]+)\)/g, '[IMAGE]')),
  );
  if (JSON.stringify(body) !== JSON.stringify(expectedBody))
    fail('ORACLE_BODY_MISMATCH');
  for (let index = 0; index < references.length; index++) {
    const relative = references[index];
    if (!/^image\/image_[a-f0-9_]+\.png$/.test(relative))
      fail('ORACLE_NONLOCAL_IMAGE');
    const file = path.join(path.dirname(markdownPath), relative);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(file);
    } catch {
      return fail('ORACLE_IMAGE_READ_FAILED');
    }
    let decoded: { width: number; height: number; rgba: string };
    try {
      decoded = JSON.parse(
        execFileSync(
          process.env.XHS_TEST_PYTHON || 'python',
          [
            '-B',
            path.join(__dirname, 'test-support/decode-integrity-image.py'),
            file,
          ],
          {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 10000,
            windowsHide: true,
          },
        ),
      );
    } catch {
      return fail('ORACLE_IMAGE_DECODE_FAILED');
    }
    const expected = pictures[index];
    if (
      decoded.width !== expected.width ||
      decoded.height !== expected.height ||
      decoded.rgba !== expected.rgba
    )
      fail('ORACLE_IMAGE_PIXELS_OR_ORDER_MISMATCH');
    if (
      createHash('sha256').update(bytes).digest('hex') !== expected.sha256 ||
      !bytes.equals(Buffer.from(expected.base64, 'base64'))
    )
      fail('ORACLE_IMAGE_BYTES_MISMATCH');
  }
}

describe('independent synthetic body/image oracle against the original local saver', () => {
  let root: string;
  const network = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => {
      throw Error('ORACLE_NETWORK_FORBIDDEN');
    });
  afterAll(() => {
    expect(articlePageRequest).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    network.mockRestore();
  });
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'xhs-integrity-oracle-'));
  });
  afterEach(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  });
  async function archive(contentHtml = html) {
    const row = {
      id: noteId,
      creatorId: 'synthetic-creator',
      title: 'Synthetic integrity note',
      contentHtml,
      status: 'complete',
      kind: 'image-text',
      publishTime: 1760000000,
      videoBytes: null,
      videoMimeType: null,
      videoExpectedBytes: null,
      videoSha256: null,
    };
    // Fixed synthetic cache seam; the actual preparation and saver remain intact.
    const cache = new XiaohongshuService({
      xhsNote: { findFirst: async () => row },
    } as any);
    const prepare = await cache.prepareLocalDownload(row.creatorId, row.id);
    const store = new LocalArticleStore(path.join(root, 'settings.json'), root);
    return store.save(
      async (stage) => ({
        ...(await prepare(stage)),
        exportSource: { feedId: row.creatorId, feedName: 'Synthetic creator' },
      }),
      new Date('2026-10-24T00:00:00Z'),
      root,
    );
  }
  it('retains all manually specified paragraphs and exact decoded pixels, dimensions, bytes and image order', async () => {
    const saved = await archive();
    expect(saved).toMatchObject({ alreadySaved: false, imageCount: 3 });
    await inspectSaved(saved.markdownPath);
  });
  it.each([
    [
      'deleted middle paragraph',
      html.replace(
        '<p>Middle paragraph: keep every sentence, including 2 &lt; 3.</p>',
        '',
      ),
      'ORACLE_BODY_MISMATCH',
    ],
    [
      'missing second image',
      html.replace(
        `<p><img src="data:image/png;base64,${pictures[1].base64}"></p>`,
        '',
      ),
      'ORACLE_IMAGE_COUNT_MISMATCH',
    ],
    [
      'swapped first two images',
      html
        .replace(pictures[0].base64, 'SWAP')
        .replace(pictures[1].base64, pictures[0].base64)
        .replace('SWAP', pictures[1].base64),
      'ORACLE_IMAGE_PIXELS_OR_ORDER_MISMATCH',
    ],
  ])(
    'detects %s through the original preparation and saver',
    async (_label, changed, code) => {
      const saved = await archive(changed);
      await expect(inspectSaved(saved.markdownPath)).rejects.toThrow(code);
    },
  );
  it('detects a truncated published PNG using a full independent decoder', async () => {
    const saved = await archive();
    await inspectSaved(saved.markdownPath);
    const refs = imageLinks(await fs.readFile(saved.markdownPath, 'utf8'));
    const file = path.join(path.dirname(saved.markdownPath), refs[0]);
    const original = await fs.readFile(file);
    // IHDR remains intact: a dimensions-only/header-only check would miss this.
    await fs.writeFile(file, original.subarray(0, 33));
    await expect(inspectSaved(saved.markdownPath)).rejects.toThrow(
      'ORACLE_IMAGE_DECODE_FAILED',
    );
  });
  it('detects a missing published image file even with unchanged Markdown and saver receipt', async () => {
    const saved = await archive();
    await inspectSaved(saved.markdownPath);
    const refs = imageLinks(await fs.readFile(saved.markdownPath, 'utf8'));
    await fs.unlink(path.join(path.dirname(saved.markdownPath), refs[1]));
    await expect(inspectSaved(saved.markdownPath)).rejects.toThrow(
      'ORACLE_IMAGE_READ_FAILED',
    );
  });
});
