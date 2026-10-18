import { createHash } from 'node:crypto';
import { constants, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { load } from 'cheerio';
import { Article, Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { canonicalArticleUrl } from './collection-format';
import { assertSavedArticleIdentity } from './article-body-retry';
import { allowedImageUrl, decodeInlineImage } from './image-fetch';
import { ProviderPage } from './subscription-provider';

const hash = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const sha = z.string().regex(/^[a-f0-9]{64}$/);
export const savedMediaIds = z
  .array(z.string().min(1).max(128))
  .min(1)
  .max(5)
  .refine((ids) => new Set(ids).size === ids.length);
const manifestSchema = z
  .object({
    version: z.literal(1),
    mpId: z.string().regex(/^MP_WXS_\d+$/),
    articles: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            sourceUrl: z.string().max(2048),
            bodySha256: sha,
            assets: z
              .array(
                z
                  .object({
                    sourceUrl: z.string().max(4096),
                    file: z
                      .string()
                      .regex(
                        /^[A-Za-z0-9][A-Za-z0-9_-]{0,100}\.(?:png|jpe?g|gif|webp)$/,
                      ),
                    bytes: z.number().int().positive().max(10_000_000),
                    sha256: sha,
                    type: z.enum([
                      'image/png',
                      'image/jpeg',
                      'image/gif',
                      'image/webp',
                    ]),
                    /** Trusted operator's prior full decode, bound to these bytes. */
                    decodedSha256: sha,
                  })
                  .strict(),
              )
              .max(60),
          })
          .strict(),
      )
      .min(1)
      .max(5),
  })
  .strict();

/** Read only a basename in the explicitly configured root, with bounded I/O.
 * No caller-controlled paths, directory traversal, symlinks or unbounded reads. */
async function readBounded(root: string, name: string, limit: number) {
  const file = path.join(root, name);
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > limit)
    throw new Error('SAVED_MEDIA_FILE_INVALID');
  const handle = await fs.open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW || 0),
  );
  try {
    const opened = await handle.stat();
    if (
      opened.ino !== before.ino ||
      opened.dev !== before.dev ||
      opened.size !== before.size
    )
      throw new Error('SAVED_MEDIA_FILE_CHANGED');
    const bytes = Buffer.alloc(before.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const read = await handle.read(bytes, used, bytes.length - used, used);
      if (!read.bytesRead) break;
      used += read.bytesRead;
    }
    const after = await handle.stat();
    if (
      used !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs
    )
      throw new Error('SAVED_MEDIA_FILE_CHANGED');
    return bytes.subarray(0, used);
  } finally {
    await handle.close();
  }
}

export async function readSavedMediaManifest() {
  const configured = process.env.WEWE_SAVED_MEDIA_ROOT || '';
  const pinned = process.env.WEWE_SAVED_MEDIA_MANIFEST_SHA256 || '';
  if (
    !path.isAbsolute(configured) ||
    /^(\\\\|\/\/)/.test(configured) ||
    !sha.safeParse(pinned).success
  )
    throw new Error('SAVED_MEDIA_NOT_CONFIGURED');
  const root = await fs.realpath(configured);
  const normalized = (value: string) =>
    process.platform === 'win32'
      ? path.resolve(value).toLowerCase()
      : path.resolve(value);
  if (normalized(root) !== normalized(configured))
    throw new Error('SAVED_MEDIA_ROOT_INVALID');
  const bytes = await readBounded(root, 'manifest.json', 128 * 1024);
  if (hash(bytes) !== pinned) throw new Error('SAVED_MEDIA_MANIFEST_CHANGED');
  const manifest = manifestSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (
    new Set(manifest.articles.map((row) => row.id)).size !==
    manifest.articles.length
  )
    throw new Error('SAVED_MEDIA_SCOPE_INVALID');
  for (const article of manifest.articles) {
    if (canonicalArticleUrl(article.sourceUrl).mpId !== manifest.mpId)
      throw new Error('SAVED_MEDIA_SCOPE_INVALID');
    const sources = new Set<string>();
    for (const asset of article.assets) {
      allowedImageUrl(asset.sourceUrl);
      if (sources.has(asset.sourceUrl) || asset.decodedSha256 !== asset.sha256)
        throw new Error('SAVED_MEDIA_ASSET_INVALID');
      sources.add(asset.sourceUrl);
    }
  }
  return { root, manifest };
}

/** Missing/unsupported slots remain unknown; local copies never prove CSS,
 * responsive or non-image media complete merely by filling ordinary img tags. */
export function inspectSavedMedia(html: string | null) {
  if (!html) return { ready: false, missing: 1, unknown: 0 };
  const $ = load(html);
  const body = $('.rich_media_content, #js_content').first();
  if (!body.length) return { ready: false, missing: 0, unknown: 1 };
  const scope = $.root();
  let missing = 0;
  let unknown = scope.find(
    '[srcset], [data-wewe-image-unconfirmed], source, video, audio, object, embed, svg',
  ).length;
  for (const node of scope.find('[style], style').toArray())
    if (/url\s*\(/i.test($(node).attr('style') || $(node).text())) unknown++;
  for (const image of scope.find('img').toArray()) {
    const src = $(image).attr('src') || '';
    if (!src.startsWith('data:image/')) {
      if ($(image).attr('data-src') || src) missing++;
      else unknown++;
    } else {
      try {
        decodeInlineImage(src);
      } catch {
        unknown++;
      }
    }
  }
  if (scope.find('[data-wewe-image-pending]').length) unknown++;
  return { ready: missing === 0 && unknown === 0, missing, unknown };
}

export function retainUnconfirmedSavedMedia(html: string) {
  const state = inspectSavedMedia(html);
  if (state.ready) return html;
  const $ = load(html, undefined, false);
  const body = $('.rich_media_content, #js_content').first();
  body.attr('data-wewe-image-pending', String(state.missing + state.unknown));
  return $.html();
}

export type SavedMediaSnapshot = Pick<
  Article,
  | 'id'
  | 'mpId'
  | 'sourceUrl'
  | 'verifiedSourceUrl'
  | 'contentHtml'
  | 'updatedAt'
  | 'lastBodyStatus'
  | 'title'
  | 'publishTime'
>;
export type SavedMediaWrite = {
  images: ReadonlyMap<string, string>;
  snapshots: ReadonlyMap<string, SavedMediaSnapshot>;
};

export async function assertSavedMediaSnapshots(
  tx: Pick<Prisma.TransactionClient, 'article'>,
  write: SavedMediaWrite,
) {
  const rows = await tx.article.findMany({
    where: { id: { in: [...write.snapshots.values()].map((row) => row.id) } },
  });
  for (const before of write.snapshots.values()) {
    const row = rows.find((item) => item.id === before.id);
    if (
      !row ||
      Object.keys(before).some((key) =>
        key === 'updatedAt'
          ? row.updatedAt?.getTime() !== before.updatedAt?.getTime()
          : row[key] !== before[key],
      )
    )
      throw new Error('SAVED_MEDIA_CONFLICT');
  }
}

export async function prepareSavedMediaWrite(
  prisma: Pick<PrismaClient, 'article'>,
  binding: Awaited<ReturnType<typeof readSavedMediaManifest>>,
  rawIds: string[],
) {
  const ids = savedMediaIds.parse(rawIds);
  const entries = ids.map((id) =>
    binding.manifest.articles.find((item) => item.id === id),
  );
  if (entries.some((entry) => !entry))
    throw new Error('SAVED_MEDIA_SCOPE_INVALID');
  const rows = await prisma.article.findMany({ where: { id: { in: ids } } });
  if (
    rows.reduce(
      (bytes, row) => bytes + Buffer.byteLength(row.contentHtml || ''),
      0,
    ) > 32_000_000
  )
    throw new Error('SAVED_MEDIA_BODY_SIZE_LIMIT');
  const images = new Map<string, string>();
  const snapshots = new Map<string, SavedMediaSnapshot>();
  const articles: ProviderPage['articles'] = [];
  let total = 0;
  for (const entry of entries) {
    const row = rows.find((item) => item.id === entry!.id);
    if (!row || row.mpId !== binding.manifest.mpId || !row.contentHtml)
      throw new Error('SAVED_MEDIA_ARTICLE_INVALID');
    const identity = canonicalArticleUrl(entry!.sourceUrl);
    if (identity.mpId !== binding.manifest.mpId)
      throw new Error('SAVED_MEDIA_SCOPE_INVALID');
    assertSavedArticleIdentity(row, identity);
    if (
      row.id !== identity.id &&
      ![row.sourceUrl, row.verifiedSourceUrl].some((url) => {
        try {
          return !!url && canonicalArticleUrl(url).id === identity.id;
        } catch {
          return false;
        }
      })
    )
      throw new Error('SAVED_MEDIA_ARTICLE_INVALID');
    const $ = load(row.contentHtml);
    const sources = new Set(
      $('img')
        .toArray()
        .flatMap((image) => {
          const node = $(image),
            src = node.attr('src') || '';
          return src.startsWith('data:image/')
            ? []
            : [node.attr('data-src') || src].filter(Boolean);
        }),
    );
    const wanted = entry!.assets.filter((asset) =>
      sources.has(asset.sourceUrl),
    );
    // Reentry with no remaining mapped source is a read-only no-op, even after
    // this task changed the original body hash. It does not certify completeness.
    if (!wanted.length) continue;
    if (hash(row.contentHtml) !== entry!.bodySha256)
      throw new Error('SAVED_MEDIA_CONFLICT');
    const seen = new Set<string>();
    for (const asset of wanted) {
      allowedImageUrl(asset.sourceUrl);
      if (seen.has(asset.sourceUrl) || asset.decodedSha256 !== asset.sha256)
        throw new Error('SAVED_MEDIA_ASSET_INVALID');
      seen.add(asset.sourceUrl);
      const bytes = await readBounded(binding.root, asset.file, 10_000_000);
      total += bytes.length;
      if (
        total > 32_000_000 ||
        bytes.length !== asset.bytes ||
        hash(bytes) !== asset.sha256
      )
        throw new Error('SAVED_MEDIA_ASSET_INVALID');
      const inline = `data:${asset.type};base64,${bytes.toString('base64')}`;
      decodeInlineImage(inline);
      if (images.has(asset.sourceUrl) && images.get(asset.sourceUrl) !== inline)
        throw new Error('SAVED_MEDIA_ASSET_CONFLICT');
      images.set(asset.sourceUrl, inline);
    }
    const {
      id,
      mpId,
      sourceUrl,
      verifiedSourceUrl,
      contentHtml,
      updatedAt,
      lastBodyStatus,
      title,
      publishTime,
    } = row;
    snapshots.set(identity.id, {
      id,
      mpId,
      sourceUrl,
      verifiedSourceUrl,
      contentHtml,
      updatedAt,
      lastBodyStatus,
      title,
      publishTime,
    });
    articles.push({
      ...identity,
      title,
      publishTime,
      contentHtml,
      picUrl: row.picUrl || '',
    });
  }
  return {
    write: { images, snapshots } as SavedMediaWrite,
    page: {
      articles,
      coverage: 'stored-history-window',
      upstreamCount: articles.length,
      bodyMissing: 0,
      imageBlocked: 0,
    } as ProviderPage,
  };
}
