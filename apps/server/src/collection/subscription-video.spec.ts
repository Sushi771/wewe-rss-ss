import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import { inspectCachedMp4, XhsVerifiedVideoCache } from '../xhs-video-download';
import { LocalArticleStore } from '../article-local-save';
import {
  XiaohongshuService,
  XhsSource,
  XhsSubscriptionCandidate,
} from './xiaohongshu.service';
import * as backup from './sqlite-backup';

jest.setTimeout(60000);
// Execute the actual ESM ZIP implementation using the existing CJS-test bridge.
jest.mock('../offline-archive', () => ({
  archiveDirectory: async (folder: string, destination: string) => {
    const source = resolve(__dirname, '../offline-archive.ts');
    const child = spawnSync(
      process.execPath,
      [
        '-e',
        "const fs=require('fs'),ts=require('typescript'),M=require('module'),path=require('path');const file=process.argv[3];const m=new M(file);m.paths=M._nodeModulePaths(path.dirname(file));m._compile(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2021,module:ts.ModuleKind.CommonJS}}).outputText,file);m.exports.archiveDirectory(process.argv[1],process.argv[2]).catch(()=>process.exit(1));",
        folder,
        destination,
        source,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    if (child.status !== 0) throw new Error('ACTUAL_ARCHIVE_CHILD_FAILED');
  },
}));

// Reuse the synthetic fixture from xhs-video-download.spec.ts. This container
// has mapped sample bytes but is not evidence of decoding or supplier content.
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
const fixture = (): XhsVerifiedVideoCache => {
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

describe('subscription video cache → SQLite → original saver/ZIP, offline', () => {
  const migration = '20261009080000_add_xhs_video_cache';
  const originalEnv = { ...process.env };
  const videoKey = JSON.stringify(['xiaohongshu', 'note', 'verified-video']);
  const imageKey = JSON.stringify(['xiaohongshu', 'note', 'old-image']);
  const skippedKey = JSON.stringify(['xiaohongshu', 'note', 'old-skipped']);
  const html =
    '<div id="js_content"><p>old complete body</p><img src="data:image/png;base64,' +
    png +
    '"></div>';
  let root: string, prisma: PrismaClient, oldWechat: unknown, oldImage: unknown;
  const oldRows = async (tables = ['accounts', 'feeds', 'articles']) => {
    const rows: Record<string, unknown> = {};
    for (const table of tables) {
      const columns = (
        await prisma.$queryRawUnsafe<any[]>(`PRAGMA table_info(${table})`)
      )
        .map((column) => column.name)
        .filter(
          (name) =>
            ![
              'kind',
              'video_bytes',
              'video_mime_type',
              'video_expected_bytes',
              'video_sha256',
            ].includes(name),
        );
      rows[table] = await prisma.$queryRawUnsafe(
        `SELECT ${columns.map((name) => '"' + name + '"').join(',')} FROM ${table} ORDER BY id`,
      );
    }
    return rows;
  };
  const videoNote = (id = 'verified-video'): XhsSubscriptionCandidate => {
    const input = fixture();
    return { ...input.note, noteId: id, video: input.video };
  };
  const source = (
    items: XhsSubscriptionCandidate[],
    evidenceVerified = true,
  ): XhsSource => ({
    read: jest.fn().mockResolvedValue({
      authorId: 'verified-author',
      evidenceVerified,
      pages: [{ requestCursor: null, nextCursor: null, items }],
    }),
  });
  const service = (items = [videoNote()], evidenceVerified = true) =>
    new XiaohongshuService(prisma as any, source(items, evidenceVerified));
  beforeAll(async () => {
    root = await fs.mkdtemp(join(tmpdir(), 'wewe-subscription-video-'));
    const url = 'file:' + join(root, 'fixture.sqlite').replace(/\\/g, '/');
    process.env.DATABASE_URL = url;
    prisma = new PrismaClient({ datasources: { db: { url } } });
    const migrations = resolve(__dirname, '../../prisma/migrations');
    const apply = async (name: string) => {
      const sql = await fs.readFile(
        join(migrations, name, 'migration.sql'),
        'utf8',
      );
      for (const statement of sql
        .split(';')
        .map((s) => s.trim())
        .filter(Boolean))
        await prisma.$executeRawUnsafe(statement);
    };
    for (const entry of (await fs.readdir(migrations, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name)))
      if (entry.name !== migration) await apply(entry.name);
    await prisma.account.create({
      data: { id: 'old-account', name: 'old account', token: 'synthetic-only' },
    });
    await prisma.feed.create({
      data: {
        id: 'old-feed',
        mpName: 'old feed',
        mpCover: '',
        mpIntro: '',
        updateTime: 1,
        localDirectory: 'unchanged local path',
        collectionChannel: 'wechat2rss',
      },
    });
    await prisma.article.create({
      data: {
        id: 'old-article',
        mpId: 'old-feed',
        title: 'old article',
        picUrl: '',
        publishTime: 1700000000,
        contentHtml: 'original body',
        metrics: 'original metrics',
        readCount: 12,
        likeCount: 3,
      },
    });
    await prisma.managementGroup.create({
      data: { id: 'xhs-group', platform: 'xiaohongshu', name: 'local folder' },
    });
    await prisma.xhsCreator.create({
      data: {
        id: 'creator',
        profileUrl: 'https://www.xiaohongshu.com/fixture',
        displayName: 'creator',
        externalAuthorId: 'verified-author',
        groupId: 'xhs-group',
      },
    });
    await prisma.xhsCreator.create({
      data: {
        id: 'other-creator',
        profileUrl: 'https://www.xiaohongshu.com/other',
        displayName: 'other creator',
        externalAuthorId: 'other-author',
      },
    });
    await prisma.$executeRawUnsafe(
      'INSERT INTO xhs_notes(id,creator_id,title,publish_time,status,content_html) VALUES(?,?,?,?,?,?)',
      imageKey,
      'creator',
      'old image',
      1700000000,
      'complete',
      html,
    );
    await prisma.$executeRawUnsafe(
      'INSERT INTO xhs_notes(id,creator_id,title,publish_time,status,content_html) VALUES(?,?,?,?,?,?)',
      skippedKey,
      'creator',
      'old skipped',
      1700000001,
      'video-skipped',
      null,
    );
    const allOld = await oldRows([
      'accounts',
      'feeds',
      'articles',
      'management_groups',
      'xhs_creators',
      'xhs_notes',
    ]);
    const columns = await prisma.$queryRawUnsafe<any[]>(
      'PRAGMA table_info(xhs_notes)',
    );
    await apply(migration);
    expect(
      await oldRows([
        'accounts',
        'feeds',
        'articles',
        'management_groups',
        'xhs_creators',
        'xhs_notes',
      ]),
    ).toEqual(allOld);
    expect(
      (
        await prisma.$queryRawUnsafe<any[]>('PRAGMA table_info(xhs_notes)')
      ).slice(0, columns.length),
    ).toEqual(columns);
    oldWechat = await oldRows();
    oldImage = await prisma.xhsNote.findUniqueOrThrow({
      where: { id: imageKey },
    });
    expect(await prisma.$queryRawUnsafe('PRAGMA integrity_check')).toEqual([
      { integrity_check: 'ok' },
    ]);
    expect(await prisma.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual(
      [],
    );
  });
  beforeEach(async () => {
    process.env = {
      ...originalEnv,
      DATABASE_URL: 'file:' + join(root, 'fixture.sqlite').replace(/\\/g, '/'),
    };
    delete process.env.PRIVATE_ONLINE_MODE;
    delete process.env.WEWE_ACCEPTANCE_MODE;
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    jest.spyOn(axios, 'get').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    jest.spyOn(axios, 'post').mockRejectedValue(new Error('NETWORK_FORBIDDEN'));
    await prisma.xhsNote.deleteMany({
      where: { id: { notIn: [imageKey, skippedKey] } },
    });
    await prisma.xhsNote.update({
      where: { id: skippedKey },
      data: {
        title: 'old skipped',
        status: 'video-skipped',
        contentHtml: null,
        kind: null,
        videoBytes: null,
        videoMimeType: null,
        videoExpectedBytes: null,
        videoSha256: null,
      },
    });
    await prisma.xhsCreator.update({
      where: { id: 'creator' },
      data: { lastStatus: 'pending', lastCheckedAt: 0 },
    });
  });
  afterEach(async () => {
    expect(await oldRows()).toEqual(oldWechat);
    expect(
      await prisma.xhsNote.findUniqueOrThrow({ where: { id: imageKey } }),
    ).toEqual(oldImage);
    expect(
      (await prisma.xhsCreator.findUniqueOrThrow({ where: { id: 'creator' } }))
        .groupId,
    ).toBe('xhs-group');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(axios.get).not.toHaveBeenCalled();
    expect(axios.post).not.toHaveBeenCalled();
    expect(await prisma.$queryRawUnsafe('PRAGMA foreign_key_check')).toEqual(
      [],
    );
    jest.restoreAllMocks();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
    process.env = originalEnv;
    if (
      root &&
      dirname(root) === tmpdir() &&
      root.split(/[\\/]/).pop()!.startsWith('wewe-subscription-video-')
    )
      await fs.rm(root, { recursive: true, force: true });
  });
  it('caches complete bytes, exposes only metadata, and saves actual text/cover/video through the original store', async () => {
    const api = service();
    expect(await api.refresh('creator')).toMatchObject({
      status: 'complete',
      added: 1,
    });
    const cached = await prisma.xhsNote.findUniqueOrThrow({
      where: { id: videoKey },
    });
    expect(cached.videoBytes).toEqual(mp4());
    expect(cached).toMatchObject({
      kind: 'video',
      status: 'complete',
      videoExpectedBytes: mp4().length,
      videoSha256: hash(mp4()),
    });
    const metadata = {
      mimeType: 'video/mp4',
      bytes: mp4().length,
      sha256: hash(mp4()),
      containerVerified: true,
      decoded: false,
    };
    const reads = jest.spyOn(prisma.xhsNote, 'findMany');
    const notes = await api.notes('creator');
    expect(reads.mock.calls[0][0]?.select).not.toHaveProperty('videoBytes');
    expect(notes.items.find((note) => note.id === videoKey)).toMatchObject({
      kind: 'video',
      video: metadata,
    });
    const bodyRead = jest.spyOn(prisma.xhsNote, 'findFirst');
    const body = await api.body('creator', videoKey);
    expect(bodyRead.mock.calls[0][0]?.select).not.toHaveProperty('videoBytes');
    expect(body).toMatchObject({
      text: fixture().note.text,
      images: [fixture().note.images[0].inlineData],
      kind: 'video',
      video: metadata,
    });
    expect(JSON.stringify({ notes, body })).not.toContain('videoBytes');
    const output = join(root, 'save-output');
    const store = new LocalArticleStore(join(root, 'preferences.json'), output);
    const prepared = await api.prepareLocalDownload('creator', videoKey);
    const saved = await store.save(prepared, new Date('2026-10-09T00:00:00Z'));
    expect(saved).toMatchObject({
      imageCount: 1,
      videoCount: 1,
      alreadySaved: false,
    });
    const markdown = await fs.readFile(saved.markdownPath, 'utf8');
    expect(saved.markdownPath.endsWith('正文.md')).toBe(true);
    expect(markdown).toContain(fixture().note.text);
    expect(markdown).toContain('image/image_');
    expect(markdown).toContain('video/video_' + hash(mp4()) + '.mp4');
    const cover = await fs.readdir(join(saved.directory, 'image'));
    expect(await fs.readFile(join(saved.directory, 'image', cover[0]))).toEqual(
      Buffer.from(png, 'base64'),
    );
    const video = await fs.readFile(
      join(saved.directory, 'video', 'video_' + hash(mp4()) + '.mp4'),
    );
    expect(video).toEqual(mp4());
    expect(inspectCachedMp4(video).decoded).toBe(false);
    await fs.writeFile(saved.markdownPath, markdown + '\nlocal annotation');
    expect(
      await store.save(
        await api.prepareLocalDownload('creator', videoKey),
        new Date('2026-10-09T00:00:00Z'),
      ),
    ).toMatchObject({ alreadySaved: true, videoCount: 1 });
    expect(await fs.readFile(saved.markdownPath, 'utf8')).toContain(
      'local annotation',
    );
  });
  it('retains complete image/video archives on duplicates and promotes only missing skipped video data without changing identity/time', async () => {
    const api = service([videoNote(), videoNote('old-skipped')]);
    expect((await api.refresh('creator')).added).toBe(2);
    const first = await prisma.xhsNote.findUniqueOrThrow({
      where: { id: videoKey },
    });
    const promoted = await prisma.xhsNote.findUniqueOrThrow({
      where: { id: skippedKey },
    });
    expect(promoted).toMatchObject({
      id: skippedKey,
      creatorId: 'creator',
      publishTime: 1700000001,
      status: 'complete',
      kind: 'video',
    });
    const changed = videoNote();
    changed.title = 'changed incoming title';
    changed.text = 'new incoming description';
    changed.publishedAt = 1700000100;
    expect(
      (await service([changed, videoNote('old-image')]).refresh('creator'))
        .added,
    ).toBe(0);
    expect(
      await prisma.xhsNote.findUniqueOrThrow({ where: { id: videoKey } }),
    ).toEqual(first);
    const missingBytes = videoNote();
    delete missingBytes.video;
    expect((await service([missingBytes]).refresh('creator')).added).toBe(0);
    expect(
      await prisma.xhsNote.findUniqueOrThrow({ where: { id: videoKey } }),
    ).toEqual(first);
    expect((await api.refresh('creator')).added).toBe(0);
    expect(
      await prisma.xhsNote.findUniqueOrThrow({ where: { id: skippedKey } }),
    ).toEqual(promoted);
  });
  it('continues to mark video without acquired bytes as skipped and never declares it downloadable', async () => {
    const note = videoNote('no-bytes');
    delete note.video;
    const api = service([note]);
    expect((await api.refresh('creator')).added).toBe(0);
    const row = await prisma.xhsNote.findUniqueOrThrow({
      where: { id: JSON.stringify(['xiaohongshu', 'note', 'no-bytes']) },
    });
    expect(row).toMatchObject({
      status: 'video-skipped',
      kind: 'video',
      videoBytes: null,
      contentHtml: null,
    });
    expect(
      (await api.notes('creator')).items.find((item) => item.id === row.id)
        ?.video,
    ).toBeNull();
    await expect(api.prepareLocalDownload('creator', row.id)).rejects.toThrow();
  });
  it('accepts verified video with empty caption and zero covers without presenting a local placeholder as source text', async () => {
    const note = videoNote('empty-caption');
    note.text = '';
    note.images = [];
    note.expectedImageCount = 0;
    const api = service([note]);
    expect((await api.refresh('creator')).added).toBe(1);
    const id = JSON.stringify(['xiaohongshu', 'note', 'empty-caption']);
    const cached = await prisma.xhsNote.findUniqueOrThrow({ where: { id } });
    expect(cached.contentHtml).toContain('data-wewe-empty-video-caption');
    expect(await api.body('creator', id)).toMatchObject({
      text: '',
      images: [],
      kind: 'video',
      video: { decoded: false },
    });
    const store = new LocalArticleStore(
      join(root, 'empty-preferences.json'),
      join(root, 'empty-video'),
    );
    const saved = await store.save(
      await api.prepareLocalDownload('creator', id),
      new Date('2026-10-09T00:00:00Z'),
    );
    expect(saved).toMatchObject({ imageCount: 0, videoCount: 1 });
    expect(
      await fs.readFile(
        join(saved.directory, 'video', 'video_' + hash(mp4()) + '.mp4'),
      ),
    ).toEqual(mp4());
    expect(await fs.readFile(saved.markdownPath, 'utf8')).not.toContain(
      '本条视频没有正文文字。',
    );
    const image = {
      ...note,
      noteId: 'empty-image',
      kind: 'image-text' as const,
    };
    delete image.video;
    await expect(service([image]).refresh('creator')).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(
      await prisma.xhsNote.findUnique({
        where: { id: JSON.stringify(['xiaohongshu', 'note', 'empty-image']) },
      }),
    ).toBeNull();
  });
  it('rejects a complete batch before backup/write on bad hash, empty/truncated bytes, wrong author, incomplete text or covers', async () => {
    const snapshot = await prisma.xhsNote.findMany({ orderBy: { id: 'asc' } });
    const gate = jest.spyOn(backup, 'createVerifiedSqliteBackup');
    const invalid: XhsSubscriptionCandidate[] = [];
    for (const mutate of [
      (note: XhsSubscriptionCandidate) => {
        note.video!.sha256 = '0'.repeat(64);
      },
      (note: XhsSubscriptionCandidate) => {
        note.video!.bytes = Buffer.alloc(0);
        note.video!.expectedBytes = 0;
      },
      (note: XhsSubscriptionCandidate) => {
        note.video!.bytes = mp4().subarray(0, 16);
        note.video!.expectedBytes = 16;
        note.video!.sha256 = hash(note.video!.bytes);
      },
      (note: XhsSubscriptionCandidate) => {
        note.authorId = 'other-author';
      },
      (note: XhsSubscriptionCandidate) => {
        note.textStatus = 'summary';
      },
      (note: XhsSubscriptionCandidate) => {
        note.images = [];
      },
      (note: XhsSubscriptionCandidate) => {
        note.video!.complete = false;
      },
      (note: XhsSubscriptionCandidate) => {
        note.video!.bytes = new Uint8Array(mp4()) as any;
      },
    ]) {
      const note = videoNote();
      mutate(note);
      invalid.push(note);
    }
    for (const note of invalid) {
      await expect(
        service([videoNote('new-good'), note]).refresh('creator'),
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(await prisma.xhsNote.findMany({ orderBy: { id: 'asc' } })).toEqual(
        snapshot,
      );
    }
    await expect(
      service([videoNote()], false).refresh('creator'),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(gate).not.toHaveBeenCalled();
  });
  it('rejects creator mixing, corrupted cached bytes/identity and backup failure without partial writes or published files', async () => {
    const api = service();
    const before = await prisma.xhsNote.findMany({ orderBy: { id: 'asc' } });
    const gate = jest
      .spyOn(backup, 'createVerifiedSqliteBackup')
      .mockRejectedValueOnce(new Error('backup failure'));
    await expect(api.refresh('creator')).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(await prisma.xhsNote.findMany({ orderBy: { id: 'asc' } })).toEqual(
      before,
    );
    gate.mockRestore();
    await api.refresh('creator');
    await expect(
      api.prepareLocalDownload('other-creator', videoKey),
    ).rejects.toThrow();
    await expect(api.body('other-creator', videoKey)).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    await prisma.xhsNote.update({
      where: { id: videoKey },
      data: { creatorId: 'other-creator' },
    });
    const crossed = await prisma.xhsNote.findMany({ orderBy: { id: 'asc' } });
    await expect(
      service([videoNote('new-good'), videoNote()]).refresh('creator'),
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(await prisma.xhsNote.findMany({ orderBy: { id: 'asc' } })).toEqual(
      crossed,
    );
    await prisma.xhsNote.update({
      where: { id: videoKey },
      data: { creatorId: 'creator', videoSha256: '0'.repeat(64) },
    });
    await expect(
      api.prepareLocalDownload('creator', videoKey),
    ).rejects.toThrow();
    await prisma.xhsNote.update({
      where: { id: videoKey },
      data: { videoSha256: hash(mp4()), videoBytes: Buffer.alloc(0) },
    });
    await expect(
      api.prepareLocalDownload('creator', videoKey),
    ).rejects.toThrow();
    const badKey = 'noncanonical-video-id';
    await prisma.xhsNote.update({
      where: { id: videoKey },
      data: { id: badKey, videoBytes: mp4() },
    });
    await expect(api.prepareLocalDownload('creator', badKey)).rejects.toThrow();
  });
  it('checks ZIP byte budget before BLOB reads and includes actual video/cover bytes with same-note relative Markdown paths', async () => {
    const api = service();
    await api.refresh('creator');
    await prisma.xhsNote.update({
      where: { id: videoKey },
      data: { videoExpectedBytes: 25_000_001 },
    });
    const read = jest.spyOn(prisma.xhsNote, 'findFirst');
    await expect(api.export('creator', [videoKey])).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(read).not.toHaveBeenCalled();
    await prisma.xhsNote.update({
      where: { id: videoKey },
      data: { videoExpectedBytes: mp4().length },
    });
    const result = await api.export('creator', [videoKey]);
    expect(result.notes).toBe(1);
    const zip = join(root, 'video.zip');
    await fs.writeFile(zip, Buffer.from(result.base64, 'base64'));
    const inspect = spawnSync(
      'python',
      [
        '-c',
        'import zipfile,sys,json,hashlib,posixpath; z=zipfile.ZipFile(sys.argv[1]); names=z.namelist(); md=next(n for n in names if n.endswith(".md")); text=z.read(md).decode("utf8"); video=next(n for n in names if n.endswith(".mp4")); image=next(n for n in names if n.endswith(".png")); print(json.dumps({"markdownName":md,"text":text,"videoRelative":posixpath.relpath(video,posixpath.dirname(md)),"imageRelative":posixpath.relpath(image,posixpath.dirname(md)),"videoHash":hashlib.sha256(z.read(video)).hexdigest(),"imageHash":hashlib.sha256(z.read(image)).hexdigest()}))',
        zip,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(inspect.status).toBe(0);
    const archive = JSON.parse(inspect.stdout);
    expect(archive.markdownName).toMatch(/\/正文\.md$/);
    expect(archive.videoHash).toBe(hash(mp4()));
    expect(archive.imageHash).toBe(hash(Buffer.from(png, 'base64')));
    expect(archive.text).toContain(archive.videoRelative);
    expect(archive.text).toContain(archive.imageRelative);
    expect(archive.text).toContain(fixture().note.text);
  });
});
