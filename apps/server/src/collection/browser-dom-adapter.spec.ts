import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { CollectionService } from './collection.service';
import {
  BrowserDomEvidence,
  BrowserDomVerificationError,
  CachedImageRecord,
  inlineVerifiedBrowserDomImages,
  prepareBrowserDomReplay,
  prepareBrowserDomWithImagesReplay,
  validateImageSignature,
  verifyBrowserDomArticle,
} from './browser-dom-adapter';
import { ArticleCandidate } from './article-candidate';

jest.mock('./sqlite-backup', () => ({
  createVerifiedSqliteBackup: jest
    .fn()
    .mockResolvedValue({ integrityCheck: 'ok' }),
}));

const mpId = 'MP_WXS_3895431412';
const biz = 'Mzg5NTQzMTQxMg==';
const url = `https://mp.weixin.qq.com/s?__biz=${encodeURIComponent(biz)}&mid=2247493594&idx=1&sn=f7e88f2d65746ed67a005edc2bbd74ae`;
const title = '819人获奖！2026年化学竞赛上海赛区一二三等奖获奖详细名单来了';
const domPublishTime = 1790749883;
const indexTimestamp = 1790749882; // Search index timestamp differs from real DOM ct

const validHtml = `<meta property="og:url" content="https://mp.weixin.qq.com/s/${'a'.repeat(22)}"><h1 id="activity-name">${title}</h1><div id="js_content">真实正文内容</div><script>var biz="${biz}";var mid="2247493594";var idx="1";var sn="f7e88f2d65746ed67a005edc2bbd74ae";var ct=${domPublishTime};</script>`;

const candidate: ArticleCandidate = {
  id: 'WX_3895431412_2247493594_1',
  mpId,
  url,
  title,
  indexTimestamp,
  discovery: {
    source: 'owner-web-search',
    capturedAt: '2026-09-30T10:05:09.244Z',
    page: 1,
  },
};

function createEvidence(
  html: string,
  overrides: Partial<BrowserDomEvidence> = {},
): BrowserDomEvidence {
  return {
    source: 'owner-confirmed-browser-dom',
    observationKind: 'owner-confirmed-browser-dom',
    capturedAt: '2026-09-30T11:53:14.269Z',
    sha256: createHash('sha256').update(html).digest('hex'),
    rawUrl: url,
    ...overrides,
  };
}

describe('browser-DOM evidence adapter and isolated replay', () => {
  describe('validateImageSignature', () => {
    const fixtures = {
      'image/png': Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS9sAAAAASUVORK5CYII=',
        'base64',
      ),
      'image/jpeg': Buffer.from(
        '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9U6KKKAP/2Q==',
        'base64',
      ),
      'image/gif': Buffer.from(
        'R0lGODdhAQABAIEAAP8AAAAAAAAAAAAAACwAAAAAAQABAAAIBAABBAQAOw==',
        'base64',
      ),
      'image/webp': Buffer.from(
        'UklGRjwAAABXRUJQVlA4IDAAAADQAQCdASoBAAEAAUAmJaACdLoB+AADsAD+8ut//NgVzXPv9//S4P0uD9Lg/9KQAAA=',
        'base64',
      ),
    };

    it.each(Object.entries(fixtures))(
      'accepts a complete %s container and rejects a cut-off endpoint or false MIME',
      (mime, bytes) => {
        expect(validateImageSignature(bytes, mime)).toBe(true);
        expect(validateImageSignature(bytes.subarray(0, -1), mime)).toBe(false);
        expect(
          validateImageSignature(
            bytes,
            mime === 'image/png' ? 'image/jpeg' : 'image/png',
          ),
        ).toBe(false);
      },
    );

    it('rejects PNG with overflowing chunk size, missing image data, or invalid IHDR dimensions/bit depth', () => {
      const overflowing = Buffer.from(fixtures['image/png']);
      overflowing.writeUInt32BE(0xffffffff, 33);
      const missingData = Buffer.from(fixtures['image/png']);
      missingData.write('tEXt', 37, 'ascii');
      const zeroWidth = Buffer.from(fixtures['image/png']);
      zeroWidth.writeUInt32BE(0, 16);
      const zeroDepth = Buffer.from(fixtures['image/png']);
      zeroDepth[24] = 0;
      for (const bytes of [overflowing, missingData, zeroWidth, zeroDepth]) {
        expect(validateImageSignature(bytes, 'image/png')).toBe(false);
      }
    });

    it('rejects JPEG with an embedded end marker, overflowing segment, missing frame, or empty scan', () => {
      const jpeg = fixtures['image/jpeg'];
      const overflow = Buffer.from(jpeg);
      overflow.writeUInt16BE(0xffff, 4);
      const missingFrame = Buffer.from(jpeg);
      missingFrame[missingFrame.indexOf(Buffer.from([0xff, 0xc0])) + 1] = 0xfe;
      const scanStart = jpeg.indexOf(Buffer.from([0xff, 0xda]));
      const scanEnd = scanStart + 2 + jpeg.readUInt16BE(scanStart + 2);
      const emptyScan = Buffer.concat([
        jpeg.subarray(0, scanEnd),
        Buffer.from([0xff, 0xd9]),
      ]);
      for (const bytes of [
        Buffer.from('ffd8ffffd900', 'hex'),
        Buffer.concat([jpeg, Buffer.from([0])]),
        overflow,
        missingFrame,
        emptyScan,
      ]) {
        expect(validateImageSignature(bytes, 'image/jpeg')).toBe(false);
      }
    });

    it('rejects GIF impostors, invalid version/dimensions and overflowing image-data sub-blocks', () => {
      const gif = fixtures['image/gif'];
      const wrongVersion = Buffer.from(gif);
      wrongVersion.write('GIF00a', 0, 'ascii');
      const zeroWidth = Buffer.from(gif);
      zeroWidth.writeUInt16LE(0, 6);
      const overflow = Buffer.from(gif);
      const descriptor = overflow.indexOf(0x2c, 13);
      overflow[descriptor + 11] = 0xff;
      for (const bytes of [
        Buffer.from('GIF;'),
        wrongVersion,
        zeroWidth,
        overflow,
      ]) {
        expect(validateImageSignature(bytes, 'image/gif')).toBe(false);
      }
    });

    it('rejects WebP header-only data, size/codec mismatch, invalid frame signature and overflowing chunks', () => {
      const webp = fixtures['image/webp'];
      const wrongSize = Buffer.from(webp);
      wrongSize.writeUInt32LE(webp.length, 4);
      const wrongCodec = Buffer.from(webp);
      wrongCodec.write('FAKE', 12, 'ascii');
      const wrongFrame = Buffer.from(webp);
      wrongFrame[23] = 0;
      const overflow = Buffer.from(webp);
      overflow.writeUInt32LE(0xffffffff, 16);
      const truncated = Buffer.from(webp.subarray(0, -2));
      truncated.writeUInt32LE(truncated.length - 8, 4);
      for (const bytes of [
        Buffer.from('524946460400000057454250', 'hex'),
        wrongSize,
        wrongCodec,
        wrongFrame,
        overflow,
        truncated,
      ]) {
        expect(validateImageSignature(bytes, 'image/webp')).toBe(false);
      }
    });
  });

  describe('verifyBrowserDomArticle', () => {
    it('verifies genuine owner-confirmed browser DOM with strict identity and exact DOM publishTime', () => {
      const evidence = createEvidence(validHtml);
      const verified = verifyBrowserDomArticle(candidate, validHtml, evidence);

      expect(verified.article.id).toBe(candidate.id);
      expect(verified.article.mpId).toBe(mpId);
      expect(verified.article.url).toBe(candidate.url);
      expect(verified.article.title).toBe(title);
      // publishTime must come strictly from the article DOM (1790749883), not the candidate index timestamp (1790749882)
      expect(verified.article.publishTime).toBe(domPublishTime);
      expect(verified.article.publishTime).not.toBe(candidate.indexTimestamp);
      expect(verified.article.contentHtml).toContain('真实正文内容');
      expect(verified.evidence.source).toBe('owner-confirmed-browser-dom');
    });

    it('rejects mislabeled evidence that reuses official-public-original or non-browser types', () => {
      const evidence = createEvidence(validHtml, {
        source: 'official-public-original' as any,
      });
      expect(() =>
        verifyBrowserDomArticle(candidate, validHtml, evidence),
      ).toThrow(BrowserDomVerificationError);
      expect(() =>
        verifyBrowserDomArticle(candidate, validHtml, evidence),
      ).toThrow('invalid_dom_evidence');
    });

    it('rejects SHA-256 hash mismatch between DOM HTML and evidence', () => {
      const evidence = createEvidence(validHtml, {
        sha256: '0'.repeat(64),
      });
      expect(() =>
        verifyBrowserDomArticle(candidate, validHtml, evidence),
      ).toThrow('dom_hash_mismatch');
    });

    it('rejects challenge or captcha verification DOM', () => {
      const challengeHtml = validHtml.replace(
        '<h1 id="activity-name">',
        '<title>安全验证</title><h1 id="activity-name">',
      );
      const evidence = createEvidence(challengeHtml);
      expect(() =>
        verifyBrowserDomArticle(candidate, challengeHtml, evidence),
      ).toThrow('access_challenge');
    });

    it('rejects identity conflict when candidate ID or publisher does not match DOM', () => {
      const wrongCandidate: ArticleCandidate = {
        ...candidate,
        id: 'WX_3895431412_9999999999_1',
      };
      const evidence = createEvidence(validHtml);
      expect(() =>
        verifyBrowserDomArticle(wrongCandidate, validHtml, evidence),
      ).toThrow('identity_conflict');
    });

    it('rejects title conflict when DOM title deviates from discovered candidate title', () => {
      const alteredHtml = validHtml.replace(title, '篡改的标题');
      const evidence = createEvidence(alteredHtml);
      expect(() =>
        verifyBrowserDomArticle(candidate, alteredHtml, evidence),
      ).toThrow('identity_conflict');
    });

    it('rejects DOM lacking valid publishTime and does not fall back to search index timestamp', () => {
      const noTimeHtml = validHtml.replace(`var ct=${domPublishTime};`, '');
      const evidence = createEvidence(noTimeHtml);
      expect(() =>
        verifyBrowserDomArticle(candidate, noTimeHtml, evidence),
      ).toThrow('invalid_article_dom');
    });

    it('rejects DOM lacking contentHtml', () => {
      const noContentHtml = validHtml.replace(
        '<div id="js_content">真实正文内容</div>',
        '<div id="js_content"></div>',
      );
      const evidence = createEvidence(noContentHtml);
      expect(() =>
        verifyBrowserDomArticle(candidate, noContentHtml, evidence),
      ).toThrow('invalid_article_dom');
    });
  });

  describe('prepareBrowserDomReplay', () => {
    it('constructs a ProviderPage with 0 network requests and search-results coverage', () => {
      const evidence = createEvidence(validHtml);
      const replay = prepareBrowserDomReplay(candidate, validHtml, evidence);

      expect(replay.discovery).toBe('owner-confirmed-browser-dom');
      expect(replay.networkRequests).toBe(0);
      expect(replay.complete).toBe(false);
      expect(replay.page.articles).toHaveLength(1);
      expect(replay.page.articles[0].id).toBe(candidate.id);
    });
    it('marks remote body images as unarchived in the copy-only replay', () => {
      const withImage = validHtml.replace(
        '真实正文内容',
        '真实正文内容<img src="https://mmbiz.qpic.cn/example" />',
      );
      const replay = prepareBrowserDomReplay(
        candidate,
        withImage,
        createEvidence(withImage),
      );
      expect(replay.unarchivedImages).toBe(1);
      expect(replay.page.imageBlocked).toBe(1);
      expect(replay.networkRequests).toBe(0);
    });
  });

  describe('inlineVerifiedBrowserDomImages & prepareBrowserDomWithImagesReplay', () => {
    const pngBytes = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
      'hex',
    );
    const pngSha = createHash('sha256').update(pngBytes).digest('hex');

    const htmlWithImages = validHtml.replace(
      '真实正文内容',
      '真实正文内容<img src="https://mmbiz.qpic.cn/img1#imgIndex=0" /><img src="https://mmbiz.qpic.cn/img2" />',
    );

    it('inlines all remote images as data URIs only when every image is verified', () => {
      const evidence = createEvidence(htmlWithImages);
      const verified = verifyBrowserDomArticle(
        candidate,
        htmlWithImages,
        evidence,
      );

      const cachedImages: CachedImageRecord[] = [
        {
          url: 'https://mmbiz.qpic.cn/img1',
          bytes: pngBytes,
          sha256: pngSha,
          mimeType: 'image/png',
        },
        {
          url: 'https://mmbiz.qpic.cn/img2',
          bytes: pngBytes,
          sha256: pngSha,
          mimeType: 'image/png',
        },
      ];

      const inlined = inlineVerifiedBrowserDomImages(verified, cachedImages);
      expect(inlined.imageProvenance.source).toBe(
        'owner-confirmed-browser-dom-verified-image-cache',
      );
      expect(inlined.imageProvenance.inlinedImagesCount).toBe(2);
      expect(inlined.imageProvenance.distinctImagesCount).toBe(2);
      expect(inlined.article.contentHtml).toContain('data:image/png;base64,');
      expect(inlined.article.contentHtml).not.toContain(
        'https://mmbiz.qpic.cn/',
      );
      expect(inlined.article.publishTime).toBe(domPublishTime);
      expect(inlined.canonical).toBe(verified.canonical);
    });

    it('completes image archiving while single search-result coverage remains incomplete', () => {
      const evidence = createEvidence(htmlWithImages);
      const cachedImages: CachedImageRecord[] = [
        {
          url: 'https://mmbiz.qpic.cn/img1',
          bytes: pngBytes,
          sha256: pngSha,
          mimeType: 'image/png',
        },
        {
          url: 'https://mmbiz.qpic.cn/img2',
          bytes: pngBytes,
          sha256: pngSha,
          mimeType: 'image/png',
        },
      ];

      const replay = prepareBrowserDomWithImagesReplay(
        candidate,
        htmlWithImages,
        evidence,
        cachedImages,
      );

      expect(replay.unarchivedImages).toBe(0);
      expect(replay.complete).toBe(false);
      expect(replay.imagesComplete).toBe(true);
      expect(replay.page.coverage).toBe('search-results');
      expect(replay.page.imageBlocked).toBe(0);
      expect(replay.networkRequests).toBe(0);
      expect(replay.provenance).toBe(
        'owner-confirmed-browser-dom-verified-image-cache',
      );
    });

    it('rejects inlining when an image is missing from the cache', () => {
      const evidence = createEvidence(htmlWithImages);
      const verified = verifyBrowserDomArticle(
        candidate,
        htmlWithImages,
        evidence,
      );

      const partialCache: CachedImageRecord[] = [
        {
          url: 'https://mmbiz.qpic.cn/img1',
          bytes: pngBytes,
          sha256: pngSha,
          mimeType: 'image/png',
        },
      ];

      expect(() =>
        inlineVerifiedBrowserDomImages(verified, partialCache),
      ).toThrow(BrowserDomVerificationError);
      expect(() =>
        inlineVerifiedBrowserDomImages(verified, partialCache),
      ).toThrow('missing_cached_image');
    });

    it.each([
      '<img src="https://external.example.invalid/photo.jpg">',
      '<img data-src="https://external.example.invalid/photo.jpg" src="https://mmbiz.qpic.cn/img1">',
      '<img src="">',
      '<img>',
      '<object><img src="https://mmbiz.qpic.cn/img1"></object>',
    ])(
      'rejects complete-image replay when sanitization drops or empties a body image: %s',
      (image) => {
        const html = validHtml.replace('真实正文内容', `真实正文内容${image}`);
        expect(() =>
          prepareBrowserDomWithImagesReplay(
            candidate,
            html,
            createEvidence(html),
            [],
          ),
        ).toThrow('unverified_images');
      },
    );

    it('preserves an allowed lazy-load source before archiving its bytes', () => {
      const imageUrl = 'https://mmbiz.qpic.cn/img1';
      const html = validHtml.replace(
        '真实正文内容',
        `真实正文内容<img data-src="${imageUrl}#imgIndex=0" src="https://external.example.invalid/placeholder">`,
      );
      const replay = prepareBrowserDomWithImagesReplay(
        candidate,
        html,
        createEvidence(html),
        [imageRecord(imageUrl)],
      );
      expect(replay.imagesComplete).toBe(true);
      expect(replay.verified.imageProvenance.inlinedImagesCount).toBe(1);
      expect(replay.page.articles[0].contentHtml).toContain(
        'data:image/png;base64,',
      );
    });

    it('rejects inlining when cached image SHA-256 does not match bytes', () => {
      const evidence = createEvidence(htmlWithImages);
      const verified = verifyBrowserDomArticle(
        candidate,
        htmlWithImages,
        evidence,
      );

      const corruptCache: CachedImageRecord[] = [
        {
          url: 'https://mmbiz.qpic.cn/img1',
          bytes: pngBytes,
          sha256: '0'.repeat(64),
          mimeType: 'image/png',
        },
        {
          url: 'https://mmbiz.qpic.cn/img2',
          bytes: pngBytes,
          sha256: pngSha,
          mimeType: 'image/png',
        },
      ];

      expect(() =>
        inlineVerifiedBrowserDomImages(verified, corruptCache),
      ).toThrow(BrowserDomVerificationError);
      expect(() =>
        inlineVerifiedBrowserDomImages(verified, corruptCache),
      ).toThrow('image_hash_mismatch');
    });

    it('rejects inlining when cached image has invalid MIME or magic bytes', () => {
      const evidence = createEvidence(htmlWithImages);
      const verified = verifyBrowserDomArticle(
        candidate,
        htmlWithImages,
        evidence,
      );

      const invalidMimeCache: CachedImageRecord[] = [
        {
          url: 'https://mmbiz.qpic.cn/img1',
          bytes: pngBytes,
          sha256: pngSha,
          mimeType: 'text/html',
        },
        {
          url: 'https://mmbiz.qpic.cn/img2',
          bytes: pngBytes,
          sha256: pngSha,
          mimeType: 'image/png',
        },
      ];

      expect(() =>
        inlineVerifiedBrowserDomImages(verified, invalidMimeCache),
      ).toThrow(BrowserDomVerificationError);
      expect(() =>
        inlineVerifiedBrowserDomImages(verified, invalidMimeCache),
      ).toThrow('invalid_image_cache');
    });

    it('archives 39 image occurrences without claiming subscription coverage is complete', () => {
      // 39 images with 36 unique URLs (3 duplicate URLs with fragments)
      const imagesHtml = Array.from({ length: 39 }, (_, i) => {
        const uniqueIndex = i < 36 ? i : i % 36;
        return `<img src="https://mmbiz.qpic.cn/test_img_${uniqueIndex}#imgIndex=${i}" />`;
      }).join('');

      const htmlWith39Images = validHtml.replace(
        '真实正文内容',
        `真实正文内容${imagesHtml}`,
      );

      const evidence = createEvidence(htmlWith39Images);
      const verified = verifyBrowserDomArticle(
        candidate,
        htmlWith39Images,
        evidence,
      );

      // Provide mock cached images for all 36 unique URLs
      const cachedMap = new Map<string, CachedImageRecord>();
      for (let i = 0; i < 36; i++) {
        const u = `https://mmbiz.qpic.cn/test_img_${i}`;
        cachedMap.set(u, {
          url: u,
          bytes: pngBytes,
          sha256: pngSha,
          mimeType: 'image/png',
        });
      }

      const inlined = inlineVerifiedBrowserDomImages(verified, cachedMap);
      expect(inlined.imageProvenance.inlinedImagesCount).toBe(39);
      expect(inlined.imageProvenance.distinctImagesCount).toBe(36);
      expect(inlined.article.contentHtml).toContain('data:image/png;base64,');
      expect(inlined.article.contentHtml).not.toContain(
        'https://mmbiz.qpic.cn/',
      );

      const replay = prepareBrowserDomWithImagesReplay(
        candidate,
        htmlWith39Images,
        evidence,
        cachedMap,
      );
      expect(replay.unarchivedImages).toBe(0);
      expect(replay.complete).toBe(false);
      expect(replay.imagesComplete).toBe(true);
      expect(replay.page.imageBlocked).toBe(0);
      expect(replay.networkRequests).toBe(0);
      expect(replay.provenance).toBe(
        'owner-confirmed-browser-dom-verified-image-cache',
      );
    });

    const imageRecord = (imageUrl: string): CachedImageRecord => ({
      url: imageUrl,
      bytes: pngBytes,
      sha256: pngSha,
      mimeType: 'image/png',
    });

    it.each(['map', 'object', 'array'])(
      'normalizes fragment-only %s cache keys and hashes verified canonical entries',
      (cacheType) => {
        const canonical = 'https://mmbiz.qpic.cn/img1';
        const fragment = canonical + '#imgIndex=7';
        const html = validHtml.replace(
          '真实正文内容',
          `<img src="${canonical}#imgIndex=0"><img src="${canonical}#imgIndex=1">`,
        );
        const verified = verifyBrowserDomArticle(
          candidate,
          html,
          createEvidence(html),
        );
        const record = imageRecord(fragment);
        const cache =
          cacheType === 'map'
            ? new Map([[fragment, record]])
            : cacheType === 'array'
              ? [record]
              : { [fragment]: record };
        const inlined = inlineVerifiedBrowserDomImages(verified, cache);
        expect(inlined.imageProvenance).toMatchObject({
          inlinedImagesCount: 2,
          distinctImagesCount: 1,
          imagesManifestSha256: createHash('sha256')
            .update(`${canonical}:${pngSha}`)
            .digest('hex'),
        });
        expect(inlined.article.contentHtml).not.toContain('mmbiz.qpic.cn');
      },
    );

    it('ignores unused cache entries and produces the same manifest across DOM/cache order and equivalent duplicates', () => {
      const first = imageRecord('https://mmbiz.qpic.cn/img1');
      const second = imageRecord('https://mmbiz.qpic.cn/img2');
      const cache = [
        second,
        first,
        {
          ...first,
          url: first.url + '#duplicate',
          sha256: pngSha.toUpperCase(),
          mimeType: 'IMAGE/PNG',
        },
        imageRecord('https://mmbiz.qpic.cn/unused'),
      ];
      const forward = verifyBrowserDomArticle(
        candidate,
        htmlWithImages,
        createEvidence(htmlWithImages),
      );
      const reversedHtml = validHtml.replace(
        '真实正文内容',
        `<img src="${second.url}"><img src="${first.url}#imgIndex=1">`,
      );
      const reverse = verifyBrowserDomArticle(
        candidate,
        reversedHtml,
        createEvidence(reversedHtml),
      );
      const left = inlineVerifiedBrowserDomImages(forward, cache);
      const right = inlineVerifiedBrowserDomImages(reverse, [first, second]);
      const expected = createHash('sha256')
        .update(`${first.url}:${pngSha}\n${second.url}:${pngSha}`)
        .digest('hex');
      expect(left.imageProvenance.imagesManifestSha256).toBe(expected);
      expect(right.imageProvenance.imagesManifestSha256).toBe(expected);
      expect(left.imageProvenance.distinctImagesCount).toBe(2);
    });

    it.each(['hash', 'mime', 'bytes'])(
      'rejects conflicting %s records for one canonical URL',
      (conflict) => {
        const verified = verifyBrowserDomArticle(
          candidate,
          htmlWithImages,
          createEvidence(htmlWithImages),
        );
        const first = imageRecord('https://mmbiz.qpic.cn/img1');
        const other = { ...first, url: first.url + '#other' };
        if (conflict === 'hash') other.sha256 = '0'.repeat(64);
        if (conflict === 'mime') other.mimeType = 'image/jpeg';
        if (conflict === 'bytes')
          other.bytes = Buffer.concat([pngBytes, Buffer.from([0])]);
        expect(() =>
          inlineVerifiedBrowserDomImages(verified, [
            first,
            other,
            imageRecord('https://mmbiz.qpic.cn/img2'),
          ]),
        ).toThrow('invalid_image_cache');
      },
    );

    it('rejects cache keys that conflict with their declared record URL', () => {
      const verified = verifyBrowserDomArticle(
        candidate,
        htmlWithImages,
        createEvidence(htmlWithImages),
      );
      expect(() =>
        inlineVerifiedBrowserDomImages(
          verified,
          new Map([
            [
              'https://mmbiz.qpic.cn/img1',
              imageRecord('https://mmbiz.qpic.cn/different'),
            ],
          ]),
        ),
      ).toThrow('invalid_image_cache');
    });

    it('rejects malformed image bytes even when their declared SHA-256 matches', () => {
      const verified = verifyBrowserDomArticle(
        candidate,
        htmlWithImages,
        createEvidence(htmlWithImages),
      );
      const invalid = Buffer.from('GIF;');
      expect(() =>
        inlineVerifiedBrowserDomImages(verified, [
          {
            url: 'https://mmbiz.qpic.cn/img1',
            bytes: invalid,
            sha256: createHash('sha256').update(invalid).digest('hex'),
            mimeType: 'image/gif',
          },
          imageRecord('https://mmbiz.qpic.cn/img2'),
        ]),
      ).toThrow('invalid_image_cache');
      expect(verified.article.contentHtml).toContain('https://mmbiz.qpic.cn/');
    });
  });

  describe('CollectionService.replayBrowserDomUpdate (SQLite Copy Rehearsal)', () => {
    let dir: string,
      dbPath: string,
      sourcePath: string,
      prisma: PrismaClient,
      collection: CollectionService;
    const previous = process.env.DATABASE_URL;

    beforeAll(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wewe-browser-replay-'));
      dbPath = path.join(dir, 'copy.db');
      sourcePath = path.join(dir, 'source.db');
      await fs.writeFile(sourcePath, 'source marker');

      process.env.DATABASE_URL = `file:${dbPath.replace(/\\/g, '/')}`;
      prisma = new PrismaClient({
        datasources: { db: { url: process.env.DATABASE_URL } },
      });

      const migrations = path.resolve(__dirname, '../../prisma/migrations');
      for (const name of (await fs.readdir(migrations)).sort()) {
        if (!(await fs.stat(path.join(migrations, name))).isDirectory())
          continue;
        const file = path.join(migrations, name, 'migration.sql');
        for (const sql of (await fs.readFile(file, 'utf8'))
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean)) {
          await prisma.$executeRawUnsafe(sql);
        }
      }

      await fs.writeFile(
        dbPath + '.browser-dom-replay.json',
        JSON.stringify({
          mode: 'owner-confirmed-browser-dom',
          sourceDatabase: sourcePath,
        }),
      );

      collection = new CollectionService(prisma as any);
    });

    beforeEach(async () => {
      await prisma.article.deleteMany();
      await prisma.feed.deleteMany();
      await prisma.feed.create({
        data: {
          id: mpId,
          mpName: '测试号',
          mpCover: '',
          mpIntro: '',
          updateTime: 1700000000,
          syncTime: 1700000000,
        },
      });
    });

    afterAll(async () => {
      await prisma.$disconnect();
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('inserts genuine article into SQLite copy and repeats update idempotently with old rows unchanged', async () => {
      const feedBefore = await prisma.feed.findUniqueOrThrow({
        where: { id: mpId },
      });
      const evidence = createEvidence(validHtml);
      const replay = prepareBrowserDomReplay(candidate, validHtml, evidence);

      // Pass 1: Insert genuine article
      const firstResult = await collection.replayBrowserDomUpdate(mpId, replay);
      expect(firstResult).toMatchObject({
        mode: 'owner-confirmed-browser-dom',
        created: 1,
        updated: 0,
        articles: 1,
        productionSourceEnabled: false,
      });

      const savedArticle = await prisma.article.findUniqueOrThrow({
        where: { id: candidate.id },
      });
      expect(savedArticle.publishTime).toBe(domPublishTime);
      expect(savedArticle.title).toBe(title);
      expect(savedArticle.contentHtml).toContain('真实正文内容');
      expect(savedArticle.lastBodyStatus).toBe('available');

      // Feed remains unchanged in offline rehearsal
      const feedAfterFirst = await prisma.feed.findUniqueOrThrow({
        where: { id: mpId },
      });
      expect(feedAfterFirst).toEqual(feedBefore);

      // Pass 2: Repeat update idempotently
      const secondResult = await collection.replayBrowserDomUpdate(
        mpId,
        replay,
      );
      expect(secondResult).toMatchObject({
        mode: 'owner-confirmed-browser-dom',
        created: 0,
        updated: 0,
        articles: 1,
      });

      // Verify all rows and fields unchanged after repeat
      const articleAfterSecond = await prisma.article.findUniqueOrThrow({
        where: { id: candidate.id },
      });
      expect(articleAfterSecond).toEqual(savedArticle);

      const feedAfterSecond = await prisma.feed.findUniqueOrThrow({
        where: { id: mpId },
      });
      expect(feedAfterSecond).toEqual(feedBefore);
    });

    it('rejects target database if identical to source database', async () => {
      await fs.writeFile(
        dbPath + '.browser-dom-replay.json',
        JSON.stringify({
          mode: 'owner-confirmed-browser-dom',
          sourceDatabase: dbPath,
        }),
      );
      try {
        const evidence = createEvidence(validHtml);
        const replay = prepareBrowserDomReplay(candidate, validHtml, evidence);
        await expect(
          collection.replayBrowserDomUpdate(mpId, replay),
        ).rejects.toThrow('ISOLATED_SQLITE');
      } finally {
        await fs.writeFile(
          dbPath + '.browser-dom-replay.json',
          JSON.stringify({
            mode: 'owner-confirmed-browser-dom',
            sourceDatabase: sourcePath,
          }),
        );
      }
    });

    it('rejects replay if provenance is invalid', async () => {
      const evidence = createEvidence(validHtml);
      const replay = prepareBrowserDomReplay(candidate, validHtml, evidence);
      const alteredReplay = {
        ...replay,
        networkRequests: 1 as any,
      };
      await expect(
        collection.replayBrowserDomUpdate(mpId, alteredReplay),
      ).rejects.toThrow('PROVENANCE_INVALID');
    });
  });
});
