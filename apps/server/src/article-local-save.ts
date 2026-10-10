import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ArticleDownloadError } from './article-download';
import {
  ArticleExportSource,
  exportIdentity,
  exportSafeName,
  exportSourceFolders,
  exportSourceMarkdown,
} from './article-export-source';

export const DEFAULT_ARTICLE_DIRECTORY =
  'C:\\Users\\ss\\Documents\\Obsidian Vault\\公众号的文章（待分类）';
type Preferences = { directory: string; askEveryTime: boolean };
export type PreparedArticle = {
  articleId: string;
  title: string;
  imageCount: number;
  videoCount?: number;
  mediaComplete?: boolean;
  /** Set only by a trusted internal source adapter, never browser JSON. */
  source?: 'wechat2rss';
  exportSource?: ArticleExportSource;
  sourceUrl?: string | null;
};
type SavedArticle = {
  directory: string;
  markdownPath: string;
  alreadySaved: boolean;
  imageCount: number;
  videoCount?: number;
  mediaComplete?: boolean;
};
export const MAX_SAVED_VIDEO_BYTES = 100_000_000;
const videoFilename = /^video_([a-f0-9]{64})\.mp4$/;
const sourceDirectoryReservations = new Map<string, Promise<void>>();
type VideoManifest = { filename: string; bytes: number; sha256: string };

/** Internal prepared files only; the HTTP API never accepts paths or bytes. */
async function checkedVideo(directory: string, filename: string) {
  const match = videoFilename.exec(filename);
  if (!match) throw fail('视频缓存文件名无效。', 'INVALID_PREPARED_VIDEO');
  const target = path.join(directory, filename);
  const stat = await fs.lstat(target);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > MAX_SAVED_VIDEO_BYTES
  )
    throw fail('视频缓存大小或文件类型无效。', 'INVALID_PREPARED_VIDEO');
  const bytes = await fs.readFile(target);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length !== stat.size || sha256 !== match[1])
    throw fail('视频缓存字节与校验值不一致。', 'INVALID_PREPARED_VIDEO');
  return { filename, bytes: bytes.length, sha256 };
}

const fail = (message: string, code: string) =>
  new ArticleDownloadError(message, 422, { code });

export function beijingDownloadDay(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Paths are granted by the native picker, never supplied by an HTTP save body. */
export async function validateLocalDirectory(directory: string) {
  if (
    typeof directory !== 'string' ||
    !path.isAbsolute(directory) ||
    directory.startsWith('\\\\') ||
    directory.startsWith('//') ||
    /[\x00-\x1f\x7f]/.test(directory) ||
    directory !== directory.trim()
  )
    throw fail('请选择本机的有效文件夹。', 'INVALID_SAVE_DIRECTORY');
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root)
    throw fail(
      '请选择具体文件夹，不能选择磁盘根目录。',
      'INVALID_SAVE_DIRECTORY',
    );
  const parts: string[] = [];
  for (
    let current = resolved;
    current !== path.dirname(current);
    current = path.dirname(current)
  )
    parts.unshift(current);
  for (const current of parts) {
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw fail(
          '保存路径包含文件或链接目录，请选择普通本机文件夹。',
          'UNSAFE_SAVE_DIRECTORY',
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return resolved;
}

/** Separate tool preferences; never edits the database, source config or existing Obsidian exports. */
export class LocalArticleStore {
  private preferences?: Preferences;
  constructor(
    private readonly settingsFile: string,
    private readonly defaultDirectory = DEFAULT_ARTICLE_DIRECTORY,
  ) {}

  async read(): Promise<Preferences> {
    if (!this.preferences) {
      try {
        const parsed = JSON.parse(await fs.readFile(this.settingsFile, 'utf8'));
        if (
          typeof parsed.askEveryTime !== 'boolean' ||
          typeof parsed.directory !== 'string'
        )
          throw new Error();
        await validateLocalDirectory(parsed.directory);
        this.preferences = {
          directory: parsed.directory,
          askEveryTime: parsed.askEveryTime,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw fail(
            '保存设置无法读取，请检查本机设置文件。',
            'SAVE_SETTINGS_UNAVAILABLE',
          );
        this.preferences = {
          directory: this.defaultDirectory,
          askEveryTime: false,
        };
      }
    }
    return { ...this.preferences };
  }

  private async persist(next: Preferences) {
    const temporary = this.settingsFile + '.' + randomUUID() + '.tmp';
    try {
      await fs.writeFile(temporary, JSON.stringify(next), {
        flag: 'wx',
        mode: 0o600,
      });
      await fs.rename(temporary, this.settingsFile);
      this.preferences = next;
    } catch {
      throw fail(
        '保存设置失败，请检查本机目录权限。',
        'SAVE_SETTINGS_UNAVAILABLE',
      );
    } finally {
      await fs.unlink(temporary).catch(() => {});
    }
    return { ...next };
  }

  async setAskEveryTime(value: boolean) {
    if (typeof value !== 'boolean')
      throw fail('路径询问设置无效。', 'INVALID_SAVE_SETTINGS');
    return this.persist({ ...(await this.read()), askEveryTime: value });
  }

  /** Caller passes only a successful native folder-dialog result. Cancel never reaches this method. */
  async rememberPickedDirectory(selected: string) {
    const directory = await validateLocalDirectory(selected);
    await fs.access(directory, constants.W_OK);
    return this.persist({ ...(await this.read()), directory });
  }

  async save(
    prepare: (temporary: string) => Promise<PreparedArticle>,
    now = new Date(),
    /** Frozen by an authorized internal job; never taken from an HTTP body. */
    confirmedDirectory?: string,
  ): Promise<SavedArticle> {
    let stage: string | undefined;
    let final: string | undefined;
    const publishedFiles: string[] = [];
    let imageDirectoryCreated = false;
    let videoDirectoryCreated = false;
    let committed = false;
    let sourcedDateDirectory: string | undefined;
    try {
      const root = await validateLocalDirectory(
        confirmedDirectory ?? (await this.read()).directory,
      );
      await fs.mkdir(root, { recursive: true });
      await validateLocalDirectory(root);
      const dateDirectory = path.join(root, beijingDownloadDay(now));
      await validateLocalDirectory(dateDirectory);
      await fs.mkdir(dateDirectory, { recursive: true });
      stage = await fs.mkdtemp(path.join(dateDirectory, '.wewe-incomplete-'));
      const article = await prepare(stage);
      if (
        !article.articleId ||
        !article.title ||
        !Number.isInteger(article.imageCount) ||
        article.imageCount < 0 ||
        (article.mediaComplete !== undefined &&
          typeof article.mediaComplete !== 'boolean') ||
        (article.source !== undefined && article.source !== 'wechat2rss') ||
        (article.videoCount !== undefined &&
          (!Number.isInteger(article.videoCount) ||
            article.videoCount < 0 ||
            article.videoCount > 1))
      )
        throw fail('正文保存结果无效。', 'INVALID_PREPARED_ARTICLE');
      if (article.exportSource) {
        sourcedDateDirectory = dateDirectory;
        return await this.publishSourcedArticle(root, stage, article);
      }
      const shortId = createHash('sha256')
        .update(article.articleId)
        .digest('hex')
        .slice(0, 12);
      const title =
        Array.from(
          article.title
            .normalize('NFKC')
            .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '-')
            .replace(/^[. ]+|[. ]+$/g, ''),
        )
          .slice(0, 60)
          .join('') || '文章';
      const stem = `${title}-${shortId}`;
      if (path.join(dateDirectory, stem, '正文.md').length > 235)
        throw fail(
          '保存路径过长，请选择较短的文件夹路径。',
          'SAVE_PATH_TOO_LONG',
        );
      const images = await fs.readdir(path.join(stage, 'image'));
      if (
        images.some(
          (name) => !/^image_[a-f0-9]{32}\.(?:png|jpe?g|gif|webp)$/.test(name),
        )
      )
        throw fail('图片文件名无效。', 'INVALID_PREPARED_ARTICLE');
      const markdown = await fs.readFile(path.join(stage, 'index.md'), 'utf8');
      if (!markdown.trim() || markdown.includes('attachments/'))
        throw fail('正文或图片引用无效。', 'INVALID_PREPARED_ARTICLE');
      const stagedVideoDirectory = path.join(stage, 'video');
      let videoFiles: string[] = [];
      try {
        await validateLocalDirectory(stagedVideoDirectory);
        videoFiles = await fs.readdir(stagedVideoDirectory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (videoFiles.length !== (article.videoCount || 0))
        throw fail(
          '视频缓存数量与内部保存合同不一致。',
          'INVALID_PREPARED_VIDEO',
        );
      const videos: VideoManifest[] = [];
      for (const name of videoFiles) {
        if (path.join(dateDirectory, stem, 'video', name).length > 255)
          throw fail(
            '视频保存路径过长，请选择较短目录。',
            'SAVE_PATH_TOO_LONG',
          );
        if (!markdown.includes('video/' + name))
          throw fail('正文缺少本地视频关联。', 'INVALID_PREPARED_VIDEO');
        videos.push(await checkedVideo(stagedVideoDirectory, name));
      }
      // mkdir is the exclusive reservation. No rename or copy may replace an existing note.
      for (let suffix = 1; suffix <= 100; suffix++) {
        const candidate = path.join(
          dateDirectory,
          `${stem}${suffix === 1 ? '' : ` (${suffix})`}`,
        );
        try {
          await fs.mkdir(candidate);
          final = candidate;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          await validateLocalDirectory(candidate);
          try {
            const marker = JSON.parse(
              await fs.readFile(
                path.join(candidate, '.wewe-article.json'),
                'utf8',
              ),
            );
            if (
              marker.articleId === article.articleId &&
              (!article.source || marker.source === article.source) &&
              marker.complete === true &&
              Array.isArray(marker.images) &&
              marker.images.every((name: string) =>
                /^image_[a-f0-9]{32}\.(?:png|jpe?g|gif|webp)$/.test(name),
              )
            ) {
              await fs.access(path.join(candidate, '正文.md'));
              const retainedVideos =
                marker.videos === undefined ? [] : marker.videos;
              if (
                !Array.isArray(retainedVideos) ||
                retainedVideos.length > 1 ||
                (videos.length > 0 && retainedVideos.length !== videos.length)
              )
                throw new Error();
              if (retainedVideos.length) {
                const retainedDirectory = path.join(candidate, 'video');
                await validateLocalDirectory(retainedDirectory);
                const retainedNames = await fs.readdir(retainedDirectory);
                if (retainedNames.length !== retainedVideos.length)
                  throw new Error();
                for (const retained of retainedVideos) {
                  if (!retained || typeof retained.filename !== 'string')
                    throw new Error();
                  const actual = await checkedVideo(
                    retainedDirectory,
                    retained.filename,
                  );
                  if (
                    actual.bytes !== retained.bytes ||
                    actual.sha256 !== retained.sha256
                  )
                    throw new Error();
                }
              }
              await validateLocalDirectory(path.join(candidate, 'image'));
              for (const name of marker.images) {
                const stat = await fs.lstat(
                  path.join(candidate, 'image', name),
                );
                if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
              }
              return {
                directory: candidate,
                markdownPath: path.join(candidate, '正文.md'),
                alreadySaved: true,
                imageCount: marker.images.length,
                ...(marker.mediaComplete === false
                  ? { mediaComplete: false }
                  : {}),
                ...(retainedVideos.length
                  ? { videoCount: retainedVideos.length }
                  : {}),
              };
            }
          } catch {
            /* User notes and incomplete/edited exports remain untouched. Try a new name. */
          }
        }
      }
      if (!final)
        throw fail('同名目录过多，请选择其他保存路径。', 'SAVE_NAME_CONFLICT');
      await validateLocalDirectory(dateDirectory);
      const imageDir = path.join(final, 'image');
      await fs.mkdir(imageDir);
      imageDirectoryCreated = true;
      for (const name of images) {
        const source = path.join(stage, 'image', name);
        const stat = await fs.lstat(source);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
        const destination = path.join(imageDir, name);
        await fs.copyFile(source, destination, constants.COPYFILE_EXCL);
        publishedFiles.push(destination);
      }
      const markdownPath = path.join(final, '正文.md');
      await fs.writeFile(markdownPath, markdown, { flag: 'wx' });
      publishedFiles.push(markdownPath);
      if (videos.length) {
        const videoDir = path.join(final, 'video');
        await fs.mkdir(videoDir);
        videoDirectoryCreated = true;
        for (const video of videos) {
          const source = path.join(stagedVideoDirectory, video.filename);
          const bytes = await fs.readFile(source);
          if (
            bytes.length !== video.bytes ||
            createHash('sha256').update(bytes).digest('hex') !== video.sha256
          )
            throw fail('视频缓存已改变，未发布。', 'INVALID_PREPARED_VIDEO');
          const destination = path.join(videoDir, video.filename);
          // Reserve ownership before writing so a partial disk write is rolled
          // back without deleting a pre-existing user's file on EEXIST.
          const output = await fs.open(destination, 'wx');
          publishedFiles.push(destination);
          try {
            await output.writeFile(bytes);
          } finally {
            await output.close();
          }
        }
      }
      const marker = path.join(final, '.wewe-article.json');
      await fs.writeFile(
        marker,
        JSON.stringify({
          articleId: article.articleId,
          ...(article.source ? { source: article.source } : {}),
          complete: true,
          ...(article.mediaComplete === false ? { mediaComplete: false } : {}),
          images,
          ...(videos.length ? { videos } : {}),
        }),
        { flag: 'wx' },
      );
      publishedFiles.push(marker);
      committed = true;
      return {
        directory: final,
        markdownPath,
        alreadySaved: false,
        imageCount: images.length,
        ...(article.mediaComplete === false ? { mediaComplete: false } : {}),
        ...(videos.length ? { videoCount: videos.length } : {}),
      };
    } catch (error) {
      if (error instanceof ArticleDownloadError) throw error;
      throw fail(
        '本机保存失败，请检查目录权限或磁盘空间；未完成保存。',
        'LOCAL_SAVE_FAILED',
      );
    } finally {
      // Roll back only exact files created by this request, never recursively delete a user's note folder.
      if (!committed && final) {
        for (const file of publishedFiles.reverse())
          await fs.unlink(file).catch(() => {});
        if (imageDirectoryCreated)
          await fs.rmdir(path.join(final, 'image')).catch(() => {});
        if (videoDirectoryCreated)
          await fs.rmdir(path.join(final, 'video')).catch(() => {});
        await fs.rmdir(final).catch(() => {});
      }
      if (stage)
        await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
      if (sourcedDateDirectory)
        await fs.rmdir(sourcedDateDirectory).catch(() => {});
    }
  }

  /** Shared publisher image pool. Receipts reserve one article, never the whole
   * publisher directory; rollback deletes only files this save created. */
  private async publishSourcedArticle(
    root: string,
    stage: string,
    article: PreparedArticle,
  ): Promise<SavedArticle> {
    const source = article.exportSource!;
    const [groupName, feedName] = exportSourceFolders(source);
    const group = await this.sourceDirectory(
      root,
      groupName,
      source.groupId || 'ungrouped',
    );
    const folder = await this.sourceDirectory(group, feedName, source.feedId);
    const receipts = path.join(folder, '.wewe-articles');
    await validateLocalDirectory(receipts);
    await fs.mkdir(receipts, { recursive: true });
    await validateLocalDirectory(receipts);
    const identity = exportIdentity(article.articleId);
    const receiptPath = path.join(
      receipts,
      `${identity}-${article.source || 'cached'}.json`,
    );
    // Both source receipts can share images for the same stable article.
    // Reserve that identity, so a failed writer cannot delete a peer's image.
    const lock = path.join(receipts, `${identity}.lock`);
    const created: string[] = [];
    let locked = false;
    let complete = false;
    try {
      const reservation = JSON.stringify({
        pid: process.pid,
        token: randomUUID(),
      });
      try {
        await fs.writeFile(lock, reservation, { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const stat = await fs.lstat(lock);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
        const previous = await fs.readFile(lock, 'utf8');
        const owner = JSON.parse(previous);
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1)
          throw new Error();
        try {
          process.kill(owner.pid, 0);
          throw fail('该文章正在保存，请稍后再试。', 'SAVE_IN_PROGRESS');
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code !== 'ESRCH') throw probe;
        }
        if ((await fs.readFile(lock, 'utf8')) !== previous) throw new Error();
        await fs.unlink(lock);
        await fs.writeFile(lock, reservation, { flag: 'wx' });
      }
      locked = true;
      try {
        const receipt = JSON.parse(await fs.readFile(receiptPath, 'utf8'));
        if (
          receipt.articleId === article.articleId &&
          receipt.source === article.source &&
          receipt.complete === true &&
          typeof receipt.markdown === 'string' &&
          path.basename(receipt.markdown) === receipt.markdown &&
          Array.isArray(receipt.images)
        ) {
          const markdownPath = path.join(folder, receipt.markdown);
          const note = await fs.lstat(markdownPath);
          if (!note.isFile() || note.isSymbolicLink()) throw new Error();
          await validateLocalDirectory(path.join(folder, 'image'));
          for (const name of receipt.images) {
            if (
              !/^image_[a-f0-9]{12}_[a-f0-9]{32}\.(png|jpe?g|gif|webp)$/.test(
                name,
              )
            )
              throw new Error();
            const image = await fs.lstat(path.join(folder, 'image', name));
            if (!image.isFile() || image.isSymbolicLink()) throw new Error();
          }
          return {
            directory: folder,
            markdownPath,
            alreadySaved: true,
            imageCount: receipt.images.length,
            ...(receipt.mediaComplete === false
              ? { mediaComplete: false }
              : {}),
          };
        }
        throw fail(
          '已有保存回执无效，未覆盖正文或图片。',
          'SAVE_RECEIPT_INVALID',
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw fail(
            '已有保存回执或文件不完整，未覆盖正文或图片。',
            'SAVE_RECEIPT_INVALID',
          );
      }
      // WeChat article exports have no videos. Other adapters retain their
      // original per-article layout unless they explicitly supply this contract.
      if (article.videoCount)
        throw fail('来源导出暂不支持视频。', 'INVALID_PREPARED_VIDEO');
      let markdown = await fs.readFile(path.join(stage, 'index.md'), 'utf8');
      if (!markdown.trim() || markdown.includes('attachments/'))
        throw fail('正文或图片引用无效。', 'INVALID_PREPARED_ARTICLE');
      const imageDir = path.join(folder, 'image');
      await validateLocalDirectory(imageDir);
      await fs.mkdir(imageDir, { recursive: true });
      await validateLocalDirectory(imageDir);
      await validateLocalDirectory(path.join(stage, 'image'));
      const images = await fs.readdir(path.join(stage, 'image'));
      const publishedImages = new Set<string>();
      for (const name of images) {
        if (!/^image_[a-f0-9]{32}\.(png|jpe?g|gif|webp)$/.test(name))
          throw fail('图片文件名无效。', 'INVALID_PREPARED_ARTICLE');
        const staged = path.join(stage, 'image', name);
        const stat = await fs.lstat(staged);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error();
        const bytes = await fs.readFile(staged);
        const hash = createHash('sha256')
          .update(bytes)
          .digest('hex')
          .slice(0, 32);
        const filename = `image_${identity}_${hash}${path.extname(name)}`;
        const destination = path.join(imageDir, filename);
        if (destination.length > 255)
          throw fail('图片保存路径过长。', 'SAVE_PATH_TOO_LONG');
        try {
          const output = await fs.open(destination, 'wx');
          created.push(destination);
          try {
            await output.writeFile(bytes);
          } finally {
            await output.close();
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const retained = await fs.lstat(destination);
          if (
            !retained.isFile() ||
            retained.isSymbolicLink() ||
            !(await fs.readFile(destination)).equals(bytes)
          )
            throw fail('已有图片内容不同，未覆盖。', 'SAVE_IMAGE_CONFLICT');
        }
        markdown = markdown.split(`image/${name}`).join(`image/${filename}`);
        publishedImages.add(filename);
      }
      if (images.length > article.imageCount)
        throw fail(
          '图片数量与内部保存合同不一致。',
          'INVALID_PREPARED_ARTICLE',
        );
      markdown =
        exportSourceMarkdown(article.exportSource!, article.sourceUrl) +
        markdown;
      const cleanTitle = exportSafeName(article.title);
      const stem =
        cleanTitle === article.title ? cleanTitle : `${cleanTitle}-${identity}`;
      let markdownPath: string | undefined;
      for (let suffix = 1; suffix <= 100; suffix++) {
        const candidate = path.join(
          folder,
          `${stem}${suffix === 1 ? '' : `-${identity}${suffix === 2 ? '' : ` (${suffix - 1})`}`}.md`,
        );
        if (candidate.length > 255)
          throw fail('保存路径过长，请选择较短目录。', 'SAVE_PATH_TOO_LONG');
        try {
          const output = await fs.open(candidate, 'wx');
          created.push(candidate);
          try {
            await output.writeFile(markdown);
          } finally {
            await output.close();
          }
          markdownPath = candidate;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      if (!markdownPath) throw fail('同名正文过多。', 'SAVE_NAME_CONFLICT');
      const output = await fs.open(receiptPath, 'wx');
      created.push(receiptPath);
      try {
        await output.writeFile(
          JSON.stringify({
            articleId: article.articleId,
            source: article.source,
            exportSource: article.exportSource,
            complete: true,
            ...(article.mediaComplete === false
              ? { mediaComplete: false }
              : {}),
            markdown: path.basename(markdownPath),
            images: [...publishedImages],
          }),
        );
      } finally {
        await output.close();
      }
      complete = true;
      return {
        directory: folder,
        markdownPath,
        alreadySaved: false,
        imageCount: publishedImages.size,
        ...(article.mediaComplete === false ? { mediaComplete: false } : {}),
      };
    } finally {
      if (!complete)
        for (const file of created.reverse())
          await fs.unlink(file).catch(() => {});
      if (locked) await fs.unlink(lock).catch(() => {});
    }
  }

  /** Plain readable names unless a different stable source already owns it. */
  private async sourceDirectory(
    parent: string,
    name: string,
    identity: string,
  ) {
    const key = path.join(parent, name).toLowerCase();
    const preceding = sourceDirectoryReservations.get(key);
    let release!: () => void;
    const reservation = new Promise<void>((done) => {
      release = done;
    });
    sourceDirectoryReservations.set(key, reservation);
    await preceding;
    try {
      return await this.createSourceDirectory(parent, name, identity);
    } finally {
      release();
      if (sourceDirectoryReservations.get(key) === reservation)
        sourceDirectoryReservations.delete(key);
    }
  }

  private async createSourceDirectory(
    parent: string,
    name: string,
    identity: string,
  ) {
    for (const candidateName of [name, `${name}-${exportIdentity(identity)}`]) {
      const directory = path.join(parent, candidateName);
      await validateLocalDirectory(directory);
      const marker = path.join(directory, '.wewe-source.json');
      try {
        await fs.mkdir(directory);
        try {
          await fs.writeFile(marker, JSON.stringify({ identity }), {
            flag: 'wx',
          });
          return directory;
        } catch (error) {
          await fs.rmdir(directory).catch(() => {});
          throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await validateLocalDirectory(directory);
        try {
          const stat = await fs.lstat(marker);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          if (
            JSON.parse(await fs.readFile(marker, 'utf8')).identity === identity
          )
            return directory;
        } catch {
          /* Unmarked/user directories are protected. Try the stable suffix. */
        }
      }
    }
    throw fail('来源目录发生冲突，未覆盖已有文件。', 'SAVE_SOURCE_CONFLICT');
  }
}
