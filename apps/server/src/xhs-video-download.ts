import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ArticleDownloadError } from './article-download';
import { MAX_SAVED_VIDEO_BYTES } from './article-local-save';
import { buildCompleteArticleDownload } from './article-verified-download';
import {
  XhsNormalizedCandidate,
  xhsArchiveDraft,
} from './collection/xiaohongshu-contract';

type Box = { type: string; start: number; end: number };
const invalid = () =>
  new ArticleDownloadError(
    '视频缓存容器、实际字节或完整性证据未通过校验，未保存。',
    422,
    { code: 'XHS_VIDEO_CACHE_INVALID' },
  );
const check = (ok: unknown): void => {
  if (!ok) throw invalid();
};

/** Narrow non-fragmented MP4 cache contract: AVC video and optional AAC audio.
 * Bounds, sample tables and mdat ranges establish container consistency only.
 * This is not a decoder, codec security scanner, or proof of upstream completeness.
 */
export function inspectCachedMp4(bytes: Buffer) {
  check(
    Buffer.isBuffer(bytes) &&
      bytes.length > 32 &&
      bytes.length <= MAX_SAVED_VIDEO_BYTES,
  );
  let boxBudget = 4096;
  const boxes = (start: number, end: number): Box[] => {
    const result: Box[] = [];
    while (start < end) {
      check(--boxBudget >= 0 && end - start >= 8);
      let length = bytes.readUInt32BE(start);
      const type = bytes.toString('latin1', start + 4, start + 8);
      let header = 8;
      if (length === 1) {
        check(end - start >= 16);
        const wide = bytes.readBigUInt64BE(start + 8);
        check(wide <= BigInt(Number.MAX_SAFE_INTEGER));
        length = Number(wide);
        header = 16;
      }
      // Zero-length boxes and fragmented streams require separate evidence.
      check(length >= header && length <= end - start);
      result.push({ type, start: start + header, end: start + length });
      start += length;
    }
    check(start === end);
    return result;
  };
  const one = (list: Box[], type: string) => {
    const found = list.filter((b) => b.type === type);
    check(found.length === 1);
    return found[0];
  };
  const children = (box: Box) => boxes(box.start, box.end);
  const exact = (box: Box, size: number) => check(box.end - box.start === size);
  const u32 = (box: Box, offset: number) => {
    check(offset >= 0 && box.start + offset + 4 <= box.end);
    return bytes.readUInt32BE(box.start + offset);
  };
  const u64 = (box: Box, offset: number) => {
    check(box.start + offset + 8 <= box.end);
    const number = bytes.readBigUInt64BE(box.start + offset);
    check(number <= BigInt(Number.MAX_SAFE_INTEGER));
    return Number(number);
  };
  const clock = (box: Box) => {
    const version = bytes[box.start];
    check(version === 0 || version === 1);
    const minimum =
      box.type === 'mvhd'
        ? version === 0
          ? 100
          : 112
        : version === 0
          ? 24
          : 36;
    check(box.end - box.start >= minimum);
    const timescale = u32(box, version === 0 ? 12 : 20);
    const duration = version === 0 ? u32(box, 16) : u64(box, 24);
    check(timescale > 0 && duration > 0);
    return { timescale, duration };
  };
  const top = boxes(0, bytes.length);
  check(top[0]?.type === 'ftyp' && !top.some((b) => b.type === 'moof'));
  const ftyp = one(top, 'ftyp');
  check(ftyp.end - ftyp.start >= 12 && (ftyp.end - ftyp.start) % 4 === 0);
  const brands = [bytes.toString('latin1', ftyp.start, ftyp.start + 4)];
  for (let offset = ftyp.start + 8; offset < ftyp.end; offset += 4)
    brands.push(bytes.toString('latin1', offset, offset + 4));
  check(
    brands.some((brand) =>
      ['isom', 'iso2', 'mp41', 'mp42', 'avc1'].includes(brand),
    ),
  );
  const media = top.filter((b) => b.type === 'mdat');
  check(media.length > 0 && media.every((b) => b.end > b.start));
  const movie = children(one(top, 'moov'));
  check(!movie.some((b) => b.type === 'mvex'));
  clock(one(movie, 'mvhd'));
  const tracks = movie.filter((b) => b.type === 'trak');
  check(tracks.length > 0 && tracks.length <= 16);
  const ranges: { start: number; end: number }[] = [];
  let videoTracks = 0,
    videoSamples = 0,
    totalSamples = 0;
  for (const track of tracks) {
    const trackBoxes = children(track),
      trackHeader = one(trackBoxes, 'tkhd');
    const trackVersion = bytes[trackHeader.start];
    check(
      (trackVersion === 0 || trackVersion === 1) &&
        trackHeader.end - trackHeader.start >= (trackVersion === 0 ? 84 : 96) &&
        u32(trackHeader, trackVersion === 0 ? 12 : 20) > 0,
    );
    const mdia = children(one(trackBoxes, 'mdia'));
    const handler = one(mdia, 'hdlr');
    check(handler.end - handler.start >= 24);
    const kind = bytes.toString(
      'latin1',
      handler.start + 8,
      handler.start + 12,
    );
    check(kind === 'vide' || kind === 'soun');
    const duration = clock(one(mdia, 'mdhd')).duration;
    const table = children(one(children(one(mdia, 'minf')), 'stbl'));
    const description = one(table, 'stsd');
    check(u32(description, 4) === 1);
    const entries = boxes(description.start + 8, description.end);
    check(
      entries.length === 1 &&
        entries[0].type === (kind === 'vide' ? 'avc1' : 'mp4a'),
    );
    const entry = entries[0];
    const fixedHeader = kind === 'vide' ? 78 : 28;
    check(entry.end - entry.start >= fixedHeader);
    const configurations = boxes(entry.start + fixedHeader, entry.end);
    check(!configurations.some((b) => b.type === 'sinf'));
    let nalLength = 0;
    if (kind === 'vide') {
      check(
        bytes.readUInt16BE(entry.start + 24) > 0 &&
          bytes.readUInt16BE(entry.start + 26) > 0,
      );
      const config = one(configurations, 'avcC');
      check(config.end - config.start >= 7 && bytes[config.start] === 1);
      nalLength = (bytes[config.start + 4] & 3) + 1;
      check(nalLength !== 3);
      let offset = config.start + 6;
      const parameters = (count: number, type: number) => {
        check(count > 0);
        for (let i = 0; i < count; i++) {
          check(offset + 2 <= config.end);
          const length = bytes.readUInt16BE(offset);
          offset += 2;
          check(
            length > 0 &&
              offset + length <= config.end &&
              (bytes[offset] & 31) === type,
          );
          offset += length;
        }
      };
      parameters(bytes[config.start + 5] & 31, 7);
      check(offset < config.end);
      parameters(bytes[offset++], 8);
      // AVC configuration extensions need a separately supported contract.
      check(offset === config.end);
    } else {
      check(bytes.readUInt16BE(entry.start + 16) > 0);
      const config = one(configurations, 'esds');
      check(config.end - config.start > 4);
    }
    const sizes = one(table, 'stsz');
    const fixedSize = u32(sizes, 4),
      count = u32(sizes, 8);
    check(count > 0 && count <= 250_000 && (totalSamples += count) <= 250_000);
    exact(sizes, fixedSize ? 12 : 12 + count * 4);
    const sampleSizes = Array.from(
      { length: count },
      (_, i) => fixedSize || u32(sizes, 12 + i * 4),
    );
    check(
      sampleSizes.every((size) => size > 0 && size <= MAX_SAVED_VIDEO_BYTES),
    );
    const timings = one(table, 'stts'),
      timingCount = u32(timings, 4);
    check(timingCount > 0 && timingCount <= count);
    exact(timings, 8 + timingCount * 8);
    let timedSamples = 0,
      timedDuration = 0;
    for (let i = 0; i < timingCount; i++) {
      const samples = u32(timings, 8 + i * 8),
        delta = u32(timings, 12 + i * 8);
      check(samples > 0 && delta > 0);
      timedSamples += samples;
      timedDuration += samples * delta;
    }
    check(
      timedSamples === count &&
        timedDuration === duration &&
        Number.isSafeInteger(timedDuration),
    );
    const chunkTables = table.filter(
      (b) => b.type === 'stco' || b.type === 'co64',
    );
    check(chunkTables.length === 1);
    const chunks = chunkTables[0],
      chunkCount = u32(chunks, 4);
    const width = chunks.type === 'stco' ? 4 : 8;
    check(chunkCount > 0 && chunkCount <= count);
    exact(chunks, 8 + chunkCount * width);
    const mapping = one(table, 'stsc'),
      mappingCount = u32(mapping, 4);
    check(mappingCount > 0 && mappingCount <= chunkCount);
    exact(mapping, 8 + mappingCount * 12);
    const rows = Array.from({ length: mappingCount }, (_, i) => ({
      first: u32(mapping, 8 + i * 12),
      samples: u32(mapping, 12 + i * 12),
      description: u32(mapping, 16 + i * 12),
    }));
    check(
      rows[0].first === 1 &&
        rows.every(
          (row, i) =>
            row.samples > 0 &&
            row.samples <= count &&
            row.description === 1 &&
            row.first <= chunkCount &&
            (!i || row.first > rows[i - 1].first),
        ),
    );
    let row = 0,
      sample = 0;
    for (let chunk = 1; chunk <= chunkCount; chunk++) {
      if (row + 1 < rows.length && rows[row + 1].first === chunk) row++;
      const amount = rows[row].samples;
      check(sample + amount <= count);
      const firstSample = sample;
      let size = 0;
      for (let i = 0; i < amount; i++) size += sampleSizes[sample++];
      const start =
        width === 4
          ? u32(chunks, 8 + (chunk - 1) * width)
          : u64(chunks, 8 + (chunk - 1) * width);
      const end = start + size;
      check(
        Number.isSafeInteger(end) &&
          media.some((m) => start >= m.start && end <= m.end),
      );
      if (kind === 'vide') {
        let cursor = start;
        for (let i = firstSample; i < sample; i++) {
          const sampleEnd = cursor + sampleSizes[i];
          let units = 0,
            hasFrame = false;
          while (cursor < sampleEnd) {
            check(++units <= 4096 && cursor + nalLength <= sampleEnd);
            const length = bytes.readUIntBE(cursor, nalLength);
            cursor += nalLength;
            check(
              length > 0 &&
                cursor + length <= sampleEnd &&
                !(bytes[cursor] & 128),
            );
            const type = bytes[cursor] & 31;
            check(type > 0 && type < 24);
            hasFrame ||= type <= 5;
            cursor += length;
          }
          check(cursor === sampleEnd && hasFrame);
        }
      }
      ranges.push({ start, end });
    }
    check(sample === count);
    if (kind === 'vide') {
      videoTracks++;
      videoSamples += count;
    }
  }
  check(videoTracks === 1 && videoSamples > 0);
  ranges.sort((a, b) => a.start - b.start);
  check(ranges.every((range, i) => !i || range.start >= ranges[i - 1].end));
  return {
    containerVerified: true as const,
    decoded: false as const,
    videoTracks,
    videoSamples,
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

export interface XhsVerifiedVideoCache {
  evidenceVerified: boolean;
  note: XhsNormalizedCandidate;
  video: {
    complete: boolean;
    mimeType: 'video/mp4';
    bytes: Buffer;
    expectedBytes: number;
    sha256: string;
  };
}
const escape = (text: string) =>
  text.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
  );

/** Internal, already acquired bytes only. No source registration, URL download,
 * short-link resolution, browser-upload entrypoint or database mutation.
 * expectedBytes/hash protect transport; evidenceVerified is the trusted adapter's
 * upstream evidence obligation. Neither declares successful video decoding.
 */
export function prepareXhsVideoDownload(input: XhsVerifiedVideoCache) {
  try {
    check(input.evidenceVerified === true && input.note.kind === 'video');
    const draft = xhsArchiveDraft(input.note.authorId, {
      ...input.note,
      kind: 'image-text',
    });
    check(draft.status === 'candidate');
    if (draft.status !== 'candidate') throw invalid();
    check(
      input.note.textStatus === 'full' &&
        input.note.expectedImageCount === draft.images.length &&
        draft.title.trim() &&
        draft.title.length <= 500 &&
        Buffer.byteLength(draft.text) <= 5_000_000,
    );
    const video = input.video;
    check(
      video.complete === true &&
        video.mimeType === 'video/mp4' &&
        Buffer.isBuffer(video.bytes) &&
        Number.isSafeInteger(video.expectedBytes) &&
        video.expectedBytes === video.bytes.length &&
        /^[a-f0-9]{64}$/.test(video.sha256),
    );
    const inspected = inspectCachedMp4(video.bytes);
    check(inspected.sha256 === video.sha256);
    const bytes = Buffer.from(video.bytes);
    const filename = 'video_' + inspected.sha256 + '.mp4';
    const article = {
      id: draft.noteKey,
      title: draft.title,
      publishTime: draft.publishedAt,
      lastBodyStatus: 'available',
      metrics: null,
      contentHtml:
        '<div id="js_content">' +
        draft.text
          .split('\n')
          .map((p) => '<p>' + escape(p) + '</p>')
          .join('') +
        draft.images
          .map(
            (image) =>
              '<img src="data:' +
              image.type +
              ';base64,' +
              image.bytes.toString('base64') +
              '">',
          )
          .join('') +
        '<p>本地视频文件见下方附件。</p></div>',
    };
    return async (directory: string) => {
      const prepared = await buildCompleteArticleDownload(
        article,
        '小红书已核视频缓存（笔记身份：' + draft.noteKey + '）',
        directory,
      );
      await mkdir(join(directory, 'video'));
      await writeFile(join(directory, 'video', filename), bytes, {
        flag: 'wx',
      });
      const markdown = await readFile(join(directory, 'index.md'), 'utf8');
      await writeFile(
        join(directory, 'index.md'),
        markdown +
          '\n[打开本地视频](video/' +
          filename +
          ')\n\n' +
          '视频缓存已通过容器与字节一致性校验；解码及真实来源完整性须由上游另行核实。\n',
      );
      return { ...prepared, videoCount: 1 };
    };
  } catch {
    throw invalid();
  }
}
