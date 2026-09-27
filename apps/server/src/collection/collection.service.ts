import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { load } from 'cheerio';
import {
  canonicalArticleUrl,
  parseCsv,
  parsePublishTime,
  readMetrics,
  mergeMetrics,
  Metrics,
} from './collection-format';

type CollectedArticle = ReturnType<typeof canonicalArticleUrl> & {
  title: string;
  publishTime: number;
  metrics: Metrics;
  contentHtml?: string;
};
type ImportInput = { directory: string; mpId?: string; mpName?: string };

@Injectable()
export class CollectionService {
  constructor(private readonly prisma: PrismaService) {}

  private async scan(input: ImportInput) {
    if (!path.isAbsolute(input.directory))
      throw new Error('请输入采集目录的完整绝对路径');
    const root = await fs.realpath(input.directory.trim());
    if (!(await fs.stat(root)).isDirectory())
      throw new Error('采集路径不是目录');
    const files: { path: string; time: string }[] = [];
    let entries = 0,
      bytes = 0;
    const visit = async (dir: string, depth: number) => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (++entries > 10000)
          throw new Error('目录超过 10000 个文件，请选择单个公众号的采集目录');
        if (entry.isSymbolicLink()) continue;
        const target = path.join(dir, entry.name);
        if (entry.isDirectory() && depth < 3) await visit(target, depth + 1);
        if (entry.isFile() && /\.(csv|html?)$/i.test(entry.name)) {
          const stat = await fs.stat(target);
          bytes += stat.size;
          if (stat.size > 10 * 1024 * 1024 || bytes > 200 * 1024 * 1024)
            throw new Error(
              '单文件超过 10 MB 或本次导入超过 200 MB，请分批导入',
            );
          files.push({ path: target, time: stat.mtime.toISOString() });
        }
      }
    };
    await visit(root, 0);
    const articles = new Map<string, CollectedArticle>();
    let bodyBytes = 0;
    const warnings: string[] = [];
    let csvFiles = 0;
    for (const file of files
      .filter((f) => /\.csv$/i.test(f.path))
      .sort(
        (a, b) => a.time.localeCompare(b.time) || a.path.localeCompare(b.path),
      )) {
      const rows = parseCsv(await fs.readFile(file.path, 'utf8'));
      if (!rows.length) continue;
      const get = (row: Record<string, string>, keys: string[]) =>
        keys.map((k) => row[k]).find((v) => v !== undefined) || '';
      if (
        !['title', '标题', '文章标题'].some((k) => k in rows[0]) ||
        !['url', '链接', '文章链接'].some((k) => k in rows[0])
      ) {
        warnings.push(`忽略非文章 CSV：${path.basename(file.path)}`);
        continue;
      }
      csvFiles++;
      for (let i = 0; i < rows.length; i++) {
        try {
          const row = rows[i];
          const identity = canonicalArticleUrl(
            get(row, ['url', '链接', '文章链接']),
          );
          if (input.mpId && identity.mpId !== input.mpId) continue;
          const title = get(row, ['title', '标题', '文章标题']);
          if (!title || title.length > 1000) throw new Error('标题为空或过长');
          const article = {
            ...identity,
            title,
            publishTime: parsePublishTime(
              get(row, ['time', '发布时间', '日期']),
            ),
            metrics: mergeMetrics(
              articles.get(identity.id)?.metrics || {},
              readMetrics(row, file.time),
            ),
          };
          articles.set(identity.id, article);
          if (articles.size > 5000)
            throw new Error('单次最多导入 5000 篇，请缩小日期范围');
        } catch (err: any) {
          throw new Error(
            `${path.basename(file.path)} 第 ${i + 2} 行：${err.message}`,
          );
        }
      }
    }
    if (!articles.size)
      throw new Error(
        '未找到匹配的文章 CSV；请在 WeChatDownload 导出文章数据到此目录',
      );
    for (const file of files.filter((f) => /\.html?$/i.test(f.path))) {
      const $ = load(await fs.readFile(file.path, 'utf8'));
      const url =
        $('meta[property="og:url"]').attr('content') ||
        $('link[rel="canonical"]').attr('href');
      if (!url) continue;
      let id: string;
      try {
        id = canonicalArticleUrl(url).id;
      } catch {
        continue;
      }
      const article = articles.get(id);
      if (!article) continue;
      const content = $('#js_content').first().length
        ? $('#js_content').first()
        : $('.rich_media_content').first();
      if (
        !content.length ||
        (!content.text().trim() && !content.find('img').length)
      ) {
        warnings.push(`正文为空：${path.basename(file.path)}`);
        continue;
      }
      content
        .find(
          'script,style,iframe,object,embed,form,input,button,link,meta,svg,base',
        )
        .remove();
      const allowed = new Set([
        'href',
        'src',
        'alt',
        'title',
        'colspan',
        'rowspan',
      ]);
      for (const element of content.find('*').toArray()) {
        const node = $(element);
        const src = node.attr('src');
        const source =
          src && !/^(?:https?:|data:|\/\/)/i.test(src)
            ? src
            : node.attr('data-src') || src;
        for (const attr of Object.keys(element['attribs'] || {}))
          if (!allowed.has(attr)) node.removeAttr(attr);
        const href = node.attr('href');
        if (href && !/^https?:\/\//i.test(href)) node.removeAttr('href');
        if (element['tagName'] === 'img') {
          node.removeAttr('src');
          if (!source) continue;
          if (/^https?:\/\//i.test(source)) {
            const imageUrl = new URL(source);
            if (
              /(^|\.)(qpic\.cn|qlogo\.cn|qq\.com)$/.test(imageUrl.hostname) &&
              !imageUrl.port &&
              !imageUrl.username
            )
              node.attr('src', source);
          } else if (!/^[a-z]+:/i.test(source) && !source.startsWith('//')) {
            try {
              const local = await fs.realpath(
                path.resolve(
                  path.dirname(file.path),
                  decodeURIComponent(source.split(/[?#]/)[0]),
                ),
              );
              const relative = path.relative(root, local);
              if (relative.startsWith('..') || path.isAbsolute(relative))
                throw new Error('图片位于采集目录之外');
              const stat = await fs.stat(local);
              if (stat.size > 5 * 1024 * 1024) throw new Error('图片超过 5 MB');
              const buffer = await fs.readFile(local);
              const mime = buffer
                .subarray(0, 8)
                .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
                ? 'png'
                : buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255
                  ? 'jpeg'
                  : ['GIF87a', 'GIF89a'].includes(
                        buffer.subarray(0, 6).toString(),
                      )
                    ? 'gif'
                    : buffer.subarray(0, 4).toString() === 'RIFF' &&
                        buffer.subarray(8, 12).toString() === 'WEBP'
                      ? 'webp'
                      : '';
              if (!mime) throw new Error('不是支持的图片格式');
              node.attr(
                'src',
                `data:image/${mime};base64,${buffer.toString('base64')}`,
              );
            } catch {
              warnings.push(`本地图片未读入：${path.basename(file.path)}`);
            }
          }
        } else node.removeAttr('src');
      }
      bodyBytes -= Buffer.byteLength(article.contentHtml || '');
      article.contentHtml = `<div class="rich_media_content" id="js_content">${content.html()}</div>`;
      bodyBytes += Buffer.byteLength(article.contentHtml);
      if (bodyBytes > 200 * 1024 * 1024)
        throw new Error('正文与图片总量超过 200 MB，请分批导入');
      if (Buffer.byteLength(article.contentHtml) > 20 * 1024 * 1024)
        throw new Error('单篇正文及图片超过 20 MB，请关闭下载图片后分批采集');
    }
    const items = [...articles.values()];
    if (
      items.reduce((n, a) => n + Buffer.byteLength(a.contentHtml || ''), 0) >
      200 * 1024 * 1024
    )
      throw new Error('正文与图片总量超过 200 MB，请分批导入');
    return { root, items, csvFiles, warnings: [...new Set(warnings)] };
  }

  async preview(input: ImportInput) {
    const scan = await this.scan(input);
    const feeds = [...new Set(scan.items.map((a) => a.mpId))];
    const existing = await this.prisma.feed.findMany({
      where: { id: { in: feeds } },
      select: { id: true, mpName: true },
    });
    return {
      directory: scan.root,
      articles: scan.items.length,
      bodies: scan.items.filter((a) => a.contentHtml).length,
      csvFiles: scan.csvFiles,
      feeds: feeds.map((id) => ({
        id,
        name: existing.find((f) => f.id === id)?.mpName || input.mpName || id,
      })),
      warnings: scan.warnings,
      sample: scan.items
        .slice(0, 5)
        .map((a) => ({ title: a.title, url: a.url, metrics: a.metrics })),
    };
  }

  async importDirectory(input: ImportInput) {
    const scan = await this.scan(input);
    let created = 0,
      updated = 0;
    await this.prisma.$transaction(
      async (tx) => {
        const ids = [...new Set(scan.items.map((a) => a.mpId))];
        const known = await tx.feed.count({ where: { id: { in: ids } } });
        if (ids.length - known > 1)
          throw new Error('本次包含多个新公众号，请按单个公众号分别导入并命名');
        for (const mpId of new Set(scan.items.map((a) => a.mpId))) {
          const existing = await tx.feed.findUnique({ where: { id: mpId } });
          if (!existing && !input.mpName?.trim())
            throw new Error(`新公众号 ${mpId} 需要填写公众号名称`);
          const maxTime = Math.max(
            ...scan.items
              .filter((a) => a.mpId === mpId)
              .map((a) => a.publishTime),
          );
          await tx.feed.upsert({
            where: { id: mpId },
            create: {
              id: mpId,
              mpName: input.mpName?.trim() || existing?.mpName || mpId,
              mpCover: '',
              mpIntro: 'WeChatDownload 本地采集',
              updateTime: maxTime,
              hasHistory: -1,
              localDirectory: scan.root,
            },
            update: {
              localDirectory: scan.root,
              updateTime: Math.max(existing?.updateTime || 0, maxTime),
              hasHistory: -1,
            },
          });
        }
        for (const item of scan.items) {
          const baseUrl = item.url.split('&sn=')[0];
          let existing = await tx.article.findFirst({
            where: {
              OR: [
                { id: item.id },
                { sourceUrl: baseUrl },
                { sourceUrl: { startsWith: `${baseUrl}&sn=` } },
              ],
            },
          });
          // Legacy short-link IDs remain usable; only merge an unambiguous same-title, same-time match.
          if (!existing) {
            const candidates = await tx.article.findMany({
              where: {
                mpId: item.mpId,
                title: item.title,
                publishTime: item.publishTime,
                sourceUrl: null,
              },
              take: 2,
            });
            if (candidates.length === 1) existing = candidates[0];
          }
          const metrics = mergeMetrics(
            JSON.parse(existing?.metrics || '{}'),
            item.metrics,
          );
          const data = {
            title: item.title,
            publishTime: item.publishTime,
            sourceUrl: item.url.includes('&sn=')
              ? item.url
              : existing?.sourceUrl || item.url,
            contentHtml: item.contentHtml || existing?.contentHtml,
            metrics: JSON.stringify(metrics),
            readCount: metrics.read?.value ?? null,
            likeCount: metrics.like?.value ?? null,
          };
          if (existing) {
            await tx.article.update({ where: { id: existing.id }, data });
            updated++;
          } else {
            await tx.article.create({
              data: { ...data, id: item.id, mpId: item.mpId, picUrl: '' },
            });
            created++;
          }
        }
        await tx.feed.updateMany({
          where: { id: { in: [...new Set(scan.items.map((a) => a.mpId))] } },
          data: { syncTime: Math.floor(Date.now() / 1000) },
        });
      },
      { timeout: 60000 },
    );
    return {
      created,
      updated,
      articles: scan.items.length,
      bodies: scan.items.filter((a) => a.contentHtml).length,
      warnings: scan.warnings,
      source: 'local' as const,
      hasHistory: -1,
      message: `本地导入 ${scan.items.length} 篇（新增 ${created}，更新 ${updated}）。这是已采集文件，公众号新文章需先在 WeChatDownload 下载。`,
    };
  }
}
