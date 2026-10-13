import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { promises as mutableFs } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import axios from 'axios';
import {
  inspectCachedMp4,
  prepareXhsVideoDownload,
  XhsVerifiedVideoCache,
} from './xhs-video-download';
import { LocalArticleStore } from './article-local-save';

const box = (type: string, ...payload: Buffer[]) => {
  const content = Buffer.concat(payload),
    header = Buffer.alloc(8);
  header.writeUInt32BE(content.length + 8);
  header.write(type, 4, 4, 'latin1');
  return Buffer.concat([header, content]);
};
const ints = (...values: number[]) => {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => bytes.writeUInt32BE(value, i * 4));
  return bytes;
};
/** Deliberately synthetic AVC-labelled sample container. It proves sample/mdat
 * mapping and actual file publication, never successful H.264 decoding.
 */
function mp4() {
  const ftyp = box(
    'ftyp',
    Buffer.from('isom'),
    ints(0),
    Buffer.from('isomavc1'),
  );
  const sample = Buffer.from([0, 0, 0, 4, 0x65, 0x88, 0x84, 0x21]);
  const videoEntry = Buffer.alloc(78);
  videoEntry.writeUInt16BE(1, 6);
  videoEntry.writeUInt16BE(16, 24);
  videoEntry.writeUInt16BE(16, 26);
  const avcC = box(
    'avcC',
    Buffer.from([1, 66, 0, 10, 255, 225, 0, 1, 103, 1, 0, 1, 104]),
  );
  const description = box('stsd', ints(0, 1), box('avc1', videoEntry, avcC));
  const trackHeader = Buffer.alloc(84);
  trackHeader.writeUInt32BE(1, 12);
  trackHeader.writeUInt32BE(1000, 20);
  trackHeader.writeUInt32BE(16 << 16, 76);
  trackHeader.writeUInt32BE(16 << 16, 80);
  const movie = (offset: number) =>
    box(
      'moov',
      box('mvhd', ints(0, 0, 0, 1000, 1000), Buffer.alloc(80)),
      box(
        'trak',
        box('tkhd', trackHeader),
        box(
          'mdia',
          box('mdhd', ints(0, 0, 0, 1000, 1000), Buffer.alloc(4)),
          box('hdlr', ints(0, 0), Buffer.from('vide'), Buffer.alloc(12)),
          box(
            'minf',
            box(
              'stbl',
              description,
              box('stts', ints(0, 1, 1, 1000)),
              box('stsc', ints(0, 1, 1, 1, 1)),
              box('stsz', ints(0, 0, 1, sample.length)),
              box('stco', ints(0, 1, offset)),
            ),
          ),
        ),
      ),
    );
  const moov = movie(ftyp.length + movie(0).length + 8);
  return Buffer.concat([ftyp, moov, box('mdat', sample)]);
}
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=';
const hash = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const input = (): XhsVerifiedVideoCache => {
  const bytes = mp4();
  return {
    evidenceVerified: true,
    note: {
      authorId: 'verified-author',
      noteId: 'verified-video',
      kind: 'video',
      publishedAt: 1700000000,
      title: '视频笔记',
      text: '完整视频说明',
      textStatus: 'full',
      expectedImageCount: 1,
      images: [{ ordinal: 1, inlineData: 'data:image/png;base64,' + png }],
    },
    video: {
      complete: true,
      mimeType: 'video/mp4',
      bytes,
      expectedBytes: bytes.length,
      sha256: hash(bytes),
    },
  };
};

describe('server-only MP4 cache contract and original local saver, zero network', () => {
  let temporary: string;
  let root: string;
  let store: LocalArticleStore;
  const now = new Date('2026-10-09T00:00:00Z');
  beforeEach(async () => {
    temporary = await fs.mkdtemp(join(tmpdir(), 'wewe-xhs-video-'));
    root = join(temporary, 'output');
    store = new LocalArticleStore(join(temporary, 'settings.json'), root);
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('NO_NETWORK'));
    jest.spyOn(global, 'fetch').mockRejectedValue(new Error('NO_NETWORK'));
  });
  afterEach(async () => {
    expect(axios.get).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    jest.restoreAllMocks();
    if (
      dirname(temporary) !== tmpdir() ||
      !temporary.split(/[\\/]/).pop()!.startsWith('wewe-xhs-video-')
    )
      throw new Error('UNSAFE_FIXTURE_CLEANUP');
    await fs.rm(temporary, { recursive: true, force: true });
  });

  it('checks actual mapped video samples and returns container evidence with decoded=false', () => {
    const bytes = mp4();
    expect(inspectCachedMp4(bytes)).toEqual({
      containerVerified: true,
      decoded: false,
      videoTracks: 1,
      videoSamples: 1,
      bytes: bytes.length,
      sha256: hash(bytes),
    });
  });

  it('rejects header-only, truncated, forged lengths, missing video, empty samples and unmapped bytes', () => {
    const valid = mp4();
    const cases = [
      valid.subarray(0, 24),
      valid.subarray(0, valid.length - 1),
      Buffer.from(valid),
      Buffer.from(valid),
      Buffer.from(valid),
      Buffer.from(valid),
      Buffer.concat([valid, Buffer.from([0])]),
      Buffer.from(valid),
    ];
    cases[2].writeUInt32BE(valid.length + 1, 0);
    cases[3].write('soun', cases[3].indexOf(Buffer.from('vide')), 4, 'latin1');
    cases[4].writeUInt32BE(0, cases[4].indexOf(Buffer.from('stsz')) + 12);
    cases[5].writeUInt32BE(1, cases[5].indexOf(Buffer.from('stco')) + 12);
    cases[7].write(
      'encv',
      cases[7].indexOf(Buffer.from('avc1'), 32),
      4,
      'latin1',
    );
    for (const bytes of cases) expect(() => inspectCachedMp4(bytes)).toThrow();
    // An outer box shell with nonempty mdat is not proof of a video track.
    expect(() =>
      inspectCachedMp4(
        Buffer.concat([
          box('ftyp', Buffer.from('isom'), ints(0), Buffer.from('isom')),
          box('moov', box('mvhd', ints(0, 0, 0, 1000, 1000))),
          box('mdat', Buffer.from([1])),
        ]),
      ),
    ).toThrow();
  });

  it('rejects malformed timing/chunk mapping, fragmented containers, zero-sized and large incomplete boxes', () => {
    const invalids = [
      Buffer.from(mp4()),
      Buffer.from(mp4()),
      Buffer.from(mp4()),
      Buffer.from(mp4()),
    ];
    invalids[0].writeUInt32BE(2, invalids[0].indexOf(Buffer.from('stts')) + 12);
    invalids[1].writeUInt32BE(2, invalids[1].indexOf(Buffer.from('stsc')) + 12);
    invalids[2].writeUInt32BE(0, 0);
    invalids[3].writeUInt32BE(1, 0);
    invalids[3].writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 8);
    for (const bytes of invalids)
      expect(() => inspectCachedMp4(bytes)).toThrow();
    expect(() =>
      inspectCachedMp4(Buffer.concat([mp4(), box('moof', ints(0))])),
    ).toThrow();
  });

  it('requires complete normalized identity/time/full text/image and transport evidence before producing a callback', () => {
    const mutations: ((value: XhsVerifiedVideoCache) => void)[] = [
      (value) => {
        value.evidenceVerified = false;
      },
      (value) => {
        value.note.authorId = '';
      },
      (value) => {
        value.note.noteId = '';
      },
      (value) => {
        value.note.publishedAt = 0;
      },
      (value) => {
        value.note.textStatus = 'summary';
      },
      (value) => {
        value.note.expectedImageCount = 2;
      },
      (value) => {
        value.note.images[0].inlineData = 'https://remote.invalid/image.png';
      },
      (value) => {
        value.note.kind = 'image-text';
      },
      (value) => {
        value.video.complete = false;
      },
      (value) => {
        (value.video as { mimeType: string }).mimeType = 'image/png';
      },
      (value) => {
        (value.video as { bytes: unknown }).bytes = new Uint8Array(
          value.video.bytes,
        );
      },
      (value) => {
        value.video.expectedBytes++;
      },
      (value) => {
        value.video.sha256 = '0'.repeat(64);
      },
      (value) => {
        value.video.bytes = value.video.bytes.subarray(0, 24);
        value.video.expectedBytes = 24;
        value.video.sha256 = hash(value.video.bytes);
      },
    ];
    for (const mutate of mutations) {
      const value = input();
      mutate(value);
      expect(() => prepareXhsVideoDownload(value)).toThrow();
    }
  });

  it('rejects a real oversized in-memory video before publishing any files', async () => {
    const value = input();
    value.video.bytes = Buffer.alloc(100_000_001);
    value.video.expectedBytes = value.video.bytes.length;
    value.video.sha256 = hash(value.video.bytes);
    expect(() => prepareXhsVideoDownload(value)).toThrow();
    await expect(fs.access(root)).rejects.toThrow();
  });

  it('writes real Markdown/PNG/MP4 files and a matching manifest, preserves repeats and snapshots producer buffers', async () => {
    const value = input(),
      original = Buffer.from(value.video.bytes);
    const prepare = prepareXhsVideoDownload(value);
    value.video.bytes.fill(0);
    value.note.text = 'mutated';
    const saved = await store.save(prepare, now);
    expect(saved).toMatchObject({
      alreadySaved: false,
      imageCount: 1,
      videoCount: 1,
    });
    const markdown = await fs.readFile(saved.markdownPath, 'utf8');
    expect(markdown).toContain('完整视频说明');
    expect(markdown).not.toContain('mutated');
    const filename = 'video_' + hash(original) + '.mp4';
    expect(markdown).toContain('(video/' + filename + ')');
    expect(markdown).toContain('解码');
    expect(await fs.readFile(join(saved.directory, 'video', filename))).toEqual(
      original,
    );
    const images = await fs.readdir(join(saved.directory, 'image'));
    expect(
      await fs.readFile(join(saved.directory, 'image', images[0])),
    ).toEqual(Buffer.from(png, 'base64'));
    const marker = JSON.parse(
      await fs.readFile(join(saved.directory, '.wewe-article.json'), 'utf8'),
    );
    expect(marker.videos).toEqual([
      { filename, bytes: original.length, sha256: hash(original) },
    ]);
    await fs.writeFile(saved.markdownPath, 'user-edited note');
    expect(
      await store.save(prepareXhsVideoDownload(input()), now),
    ).toMatchObject({
      alreadySaved: true,
      directory: saved.directory,
      videoCount: 1,
    });
    expect(await fs.readFile(saved.markdownPath, 'utf8')).toBe(
      'user-edited note',
    );
    expect(await fs.readdir(join(root, '2026-10-09'))).toHaveLength(1);
  });

  it('preserves damaged existing video and writes a new complete note instead of claiming a valid duplicate', async () => {
    const first = await store.save(prepareXhsVideoDownload(input()), now);
    const [filename] = await fs.readdir(join(first.directory, 'video'));
    await fs.writeFile(
      join(first.directory, 'video', filename),
      Buffer.from('damaged'),
    );
    const second = await store.save(prepareXhsVideoDownload(input()), now);
    expect(second).toMatchObject({
      alreadySaved: false,
      directory: first.directory + ' (2)',
    });
    expect(
      await fs.readFile(join(first.directory, 'video', filename), 'utf8'),
    ).toBe('damaged');
  });

  it('rolls back a partially written video on ENOSPC and retains an earlier complete note', async () => {
    const first = await store.save(prepareXhsVideoDownload(input()), now);
    const firstMarkdown = await fs.readFile(first.markdownPath, 'utf8');
    const actualOpen = mutableFs.open;
    const open = jest
      .spyOn(mutableFs, 'open')
      .mockImplementation(async (...args) => {
        const handle = await actualOpen(...args);
        if (String(args[0]).endsWith('.mp4')) {
          const originalWrite = handle.writeFile.bind(handle);
          handle.writeFile = async () => {
            await originalWrite(Buffer.from([1, 2]));
            throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
          };
        }
        return handle;
      });
    const next = input();
    next.note.noteId = 'other-note';
    await expect(
      store.save(prepareXhsVideoDownload(next), now),
    ).rejects.toThrow();
    expect(open).toHaveBeenCalled();
    expect(await fs.readdir(join(root, '2026-10-09'))).toHaveLength(1);
    expect(await fs.readFile(first.markdownPath, 'utf8')).toBe(firstMarkdown);
    const [filename] = await fs.readdir(join(first.directory, 'video'));
    expect(await fs.readFile(join(first.directory, 'video', filename))).toEqual(
      mp4(),
    );
  });

  it('rejects extra video files, mismatched declarations and symlinks without publishing', async () => {
    const prepare = prepareXhsVideoDownload(input());
    for (const malformed of ['extra-file', 'missing-count', 'symlink']) {
      await expect(
        store.save(async (directory) => {
          const result = await prepare(directory);
          if (malformed === 'extra-file')
            await fs.writeFile(join(directory, 'video', 'other.mp4'), mp4());
          if (malformed === 'symlink') {
            const [filename] = await fs.readdir(join(directory, 'video'));
            const videoDirectory = join(directory, 'video');
            await fs.rename(videoDirectory, join(directory, 'elsewhere'));
            await fs.symlink(
              join(directory, 'elsewhere'),
              videoDirectory,
              process.platform === 'win32' ? 'junction' : 'dir',
            );
            expect(filename).toBeTruthy();
          }
          return {
            ...result,
            videoCount: malformed === 'missing-count' ? 0 : 1,
          };
        }, now),
      ).rejects.toThrow();
      expect(await fs.readdir(join(root, '2026-10-09'))).toEqual([]);
    }
  });
});
