import axios from 'axios';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { load } from 'cheerio';
import { ownerSessionCookie, OwnerWebSession } from './owner-web-search';
import { OwnerWebCookieLifecycle } from './owner-web-cookie-lifecycle';
import { SearchConfig, OwnerUpdateStopped } from './owner-search-update';
import { articleIdentity, articleContentHtml } from './article-page';
import { assertProviderPage } from './subscription-provider';
import { archiveProviderImages } from './archive-provider-images';
import {
  parseWereadDirectory,
  selectWereadLatest,
  verifyWereadArticleBody,
} from './weread-directory';
import {
  ownerLatestAuthHash,
  ownerLatestStopMessage,
} from './owner-weread-session-state';

/** Normal owner Web session. The directory mode requires an explicit verified
 * private binding; old bindings retain their cover-only mode and access stops.
 * Both modes reuse the same cookie lifecycle, body/images and protected save.
 */
export async function fetchOwnerWereadLatest(c: SearchConfig) {
  if (!c.wereadLatestStateFile)
    throw new OwnerUpdateStopped('读书最新篇来源未配置，本次未更新。');
  const stateFile = c.wereadLatestStateFile;
  let lock: Awaited<ReturnType<typeof fs.open>>;
  try {
    lock = await fs.open(stateFile + '.lock', 'wx', 0o600);
  } catch {
    throw new OwnerUpdateStopped('读书更新正在进行或上次中断，未重发请求。');
  }
  let state: any = {},
    stage = 'session',
    requests = 0,
    reserved = false,
    sessionAuthHash = '';
  const write = async () => {
    const pending = await fs.open(stateFile + '.pending', 'w', 0o600);
    try {
      await pending.writeFile(JSON.stringify(state));
      await pending.sync();
    } finally {
      await pending.close();
    }
    await fs.rename(stateFile + '.pending', stateFile);
  };
  try {
    try {
      state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    let session: OwnerWebSession, Cookie: string;
    try {
      session = JSON.parse(await fs.readFile(c.sessionFile, 'utf8'));
      Cookie = ownerSessionCookie(session, c.ownerVid);
      sessionAuthHash = ownerLatestAuthHash(session, c.ownerVid);
    } catch {
      throw new OwnerUpdateStopped(
        '当前读书会话账号或凭据无法核验，本次未发联网请求；历史停止记录及旧正文保留。',
      );
    }
    const stopped = ownerLatestStopMessage(state, session, c.ownerVid, c.mpId);
    if (stopped) throw new OwnerUpdateStopped(stopped);
    if (Date.now() - (state.lastAttemptAt || 0) < 15 * 60 * 1000)
      throw new OwnerUpdateStopped(
        '读书更新处于15分钟冷却期，本次未发联网请求；已有正文保留。',
      );
    const cookies = new OwnerWebCookieLifecycle(session, c.ownerVid);
    state.lastAttemptAt = Date.now();
    state.sessionHash = createHash('sha256').update(Cookie).digest('hex');
    state.sessionAuthHash = sessionAuthHash;
    await write();
    reserved = true;
    const get = async (
      url: string,
      params: Record<string, string>,
      html = false,
    ) => {
      const requestCookie = cookies.header(url);
      requests++;
      const r = await axios.get<string>(url, {
        params,
        headers: {
          Cookie: requestCookie,
          Referer: 'https://weread.qq.com/',
          Origin: 'https://weread.qq.com',
          'User-Agent': 'Mozilla/5.0',
          Accept: html
            ? 'text/html,application/xhtml+xml,*/*'
            : 'application/json, text/plain, */*',
        },
        proxy: false,
        maxRedirects: 0,
        timeout: 20000,
        maxContentLength: 8 * 1024 * 1024,
        responseType: 'text',
        transformResponse: [(v) => v],
        validateStatus: () => true,
      });
      // Persist an immutable private response before parsing, including failures.
      await fs.writeFile(
        `${stateFile}.${state.lastAttemptAt}.${stage}.response`,
        r.data,
        { flag: 'wx', mode: 0o600 },
      );
      state.response = {
        stage,
        httpStatus: r.status,
        bytes: Buffer.byteLength(r.data),
        requests,
      };
      await write();
      if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
      cookies.absorb(url, r.headers?.['set-cookie']);
      return r.data;
    };
    if (c.wereadDirectoryEnabled === true) {
      stage = 'directory-0';
      const rawPages = [
        JSON.parse(
          await get('https://weread.qq.com/web/mp/articles', {
            bookId: c.mpId,
            offset: '0',
          }),
        ),
      ];
      let selection = selectWereadLatest(rawPages, c);
      if (selection.selected.length < 10) {
        const offset = parseWereadDirectory(rawPages[0], c).groupCount;
        if (offset === 0) throw new Error('目录未返回最近10篇');
        stage = 'directory-next';
        rawPages.push(
          JSON.parse(
            await get('https://weread.qq.com/web/mp/articles', {
              bookId: c.mpId,
              offset: String(offset),
            }),
          ),
        );
        selection = selectWereadLatest(rawPages, c);
      }
      if (selection.selected.length !== 10)
        throw new Error('目录未返回最近10篇');
      const articles: Array<ReturnType<typeof verifyWereadArticleBody>> = [];
      for (const [index, candidate] of selection.selected.entries()) {
        if (index) await pause(1000);
        stage = `content-${index + 1}`;
        const html = await get(
          'https://weread.qq.com/web/mp/content',
          { reviewId: candidate.reviewId },
          true,
        );
        const article = verifyWereadArticleBody(candidate, html);
        if (articles.some((old) => old.id === article.id))
          throw new Error('正文身份重复');
        articles.push(article);
      }
      stage = 'images';
      const page = await archiveProviderImages(
        assertProviderPage(
          {
            articles,
            coverage: 'recent-window',
            upstreamCount: selection.directory.length,
            bodyMissing: 0,
            imageBlocked: 0,
            pages: rawPages.length,
          },
          c.mpId,
        ),
        { stopOnFailure: true },
      );
      state.lastSuccessAt = Date.now();
      state.articleIds = page.articles.map((article) => article.id);
      await write();
      return page;
    }
    stage = 'cover';
    const cover = JSON.parse(
      await get('https://weread.qq.com/api/mp/cover', { bookId: c.mpId }),
    );
    if (cover.errCode || cover.errcode || cover.code)
      throw new Error(
        `业务码 ${Number(cover.errCode || cover.errcode || cover.code)}`,
      );
    if (
      cover.name !== c.name ||
      typeof cover.title !== 'string' ||
      !cover.title.trim() ||
      typeof cover.reviewId !== 'string' ||
      !new RegExp(`^${c.mpId}_[A-Za-z0-9_~-]{1,150}$`).test(cover.reviewId)
    )
      throw new Error('最新篇身份或字段无效');
    stage = 'content';
    const html = await get(
      'https://weread.qq.com/web/mp/content',
      { reviewId: cover.reviewId },
      true,
    );
    const $ = load(html);
    if (
      $(
        'iframe[src*="captcha."],form[action*="/mp/verify"],#js_verify,#verify,.weui_msg',
      ).length ||
      /<title[^>]*>[^<]*(?:验证码|请完成验证|访问过于频繁|安全验证|环境异常)|wappoc_appmsgcaptcha|verify\.html/i.test(
        html,
      )
    )
      throw new Error('腾讯验证或访问限制');
    const identity = articleIdentity(html);
    const title = $('#activity-name').text().trim();
    const norm = (v: string) => v.normalize('NFKC').replace(/\s+/gu, '');
    const contentHtml = articleContentHtml(html);
    if (
      identity.mpId !== c.mpId ||
      norm($('#js_name').text()) !== norm(c.name) ||
      norm(title) !== norm(cover.title) ||
      !identity.publishTime ||
      !contentHtml
    )
      throw new Error('正文身份、真实发布时间或内容无效');
    stage = 'images';
    const page = await archiveProviderImages(
      assertProviderPage(
        {
          articles: [
            {
              id: identity.id,
              mpId: c.mpId,
              url: identity.url,
              title,
              publishTime: identity.publishTime,
              contentHtml,
              picUrl: typeof cover.pic === 'string' ? cover.pic : '',
            },
          ],
          coverage: 'recent-window',
          upstreamCount: 1,
          bodyMissing: 0,
          imageBlocked: 0,
          pages: 1,
        },
        c.mpId,
      ),
      { stopOnFailure: true },
    );
    state.lastSuccessAt = Date.now();
    state.articleId = identity.id;
    await write();
    return page;
  } catch (e) {
    if (e instanceof OwnerUpdateStopped) throw e;
    if (reserved) {
      state.stop = {
        at: new Date().toISOString(),
        stage,
        requests,
        sessionAuthHash,
        reason:
          e instanceof Error &&
          /^(HTTP \d+|业务码 -?\d+|腾讯验证或访问限制|最新篇身份或字段无效|正文身份、真实发布时间或内容无效)$/.test(
            e.message,
          )
            ? e.message
            : '请求、响应或本地保存失败',
      };
      await write();
    }
    throw new OwnerUpdateStopped(
      '读书最新篇更新未完成，已停止后续请求，旧文章和正文保留。',
    );
  } finally {
    await lock.close();
    await fs.unlink(stateFile + '.lock');
  }
}
