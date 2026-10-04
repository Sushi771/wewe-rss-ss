import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ArticleDownloadError } from './article-download';

export const DEFAULT_ARTICLE_DIRECTORY =
  'C:\\Users\\ss\\Documents\\Obsidian Vault\\公众号的文章（待分类）';
type Preferences = { directory: string; askEveryTime: boolean };
type PreparedArticle = { articleId: string; title: string; imageCount: number };

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
  ) {
    let stage: string | undefined;
    let final: string | undefined;
    const publishedFiles: string[] = [];
    let imageDirectoryCreated = false;
    let committed = false;
    try {
      const root = await validateLocalDirectory((await this.read()).directory);
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
        article.imageCount < 0
      )
        throw fail('正文保存结果无效。', 'INVALID_PREPARED_ARTICLE');
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
              marker.complete === true &&
              Array.isArray(marker.images) &&
              marker.images.every((name: string) =>
                /^image_[a-f0-9]{32}\.(?:png|jpe?g|gif|webp)$/.test(name),
              )
            ) {
              await fs.access(path.join(candidate, '正文.md'));
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
      const marker = path.join(final, '.wewe-article.json');
      await fs.writeFile(
        marker,
        JSON.stringify({
          articleId: article.articleId,
          complete: true,
          images,
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
        await fs.rmdir(final).catch(() => {});
      }
      if (stage)
        await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    }
  }
}
