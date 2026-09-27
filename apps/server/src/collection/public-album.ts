import axios from 'axios';
import { canonicalArticleUrl } from './collection-format';
import { articleIdentity } from './article-page';

export type PublicArticle = ReturnType<typeof canonicalArticleUrl> & {
  title: string;
  publishTime: number;
  picUrl: string;
};

export async function fetchPublicAlbums(mpId: string, albumIds: string[]) {
  if (
    !/^MP_WXS_\d{5,15}$/.test(mpId) ||
    !albumIds.length ||
    albumIds.length > 10 ||
    albumIds.some((id) => !/^\d{10,30}$/.test(id))
  )
    throw new Error('需要有效公众号和 1–10 个公开合集 ID');
  const biz = Buffer.from(mpId.replace('MP_WXS_', '')).toString('base64');
  const proxy = publicProxy();
  const articles = new Map<string, PublicArticle>();
  const albums: {
    id: string;
    title: string;
    pages: number;
    articles: number;
  }[] = [];
  let pages = 0;
  for (const albumId of [...new Set(albumIds)]) {
    let cursor: { begin_msgid?: string; begin_itemidx?: string } = {};
    const cursors = new Set<string>();
    const albumArticles = new Set<string>();
    let title = '';
    let complete = false;
    let albumPages = 0;
    let expectedCount: number | undefined;
    for (let page = 0; page < 50; page++) {
      if (pages) await new Promise((resolve) => setTimeout(resolve, 350));
      let data: any;
      try {
        ({ data } = await axios.get('https://mp.weixin.qq.com/mp/appmsgalbum', {
          params: {
            action: 'getalbum',
            __biz: biz,
            album_id: albumId,
            count: 10,
            f: 'json',
            ...cursor,
          },
          proxy,
          timeout: 15000,
          maxContentLength: 5 * 1024 * 1024,
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
          },
        }));
      } catch {
        throw new Error(
          '公开合集请求失败，本次未写入；请检查网络或本机代理后重试',
        );
      }
      const response = data?.getalbum_resp;
      if (
        ![0, '0'].includes(data?.base_resp?.ret) ||
        !response ||
        !Array.isArray(response.article_list)
      )
        throw new Error('公开合集返回验证页或无效列表，本次未写入');
      if (page === 0 && response.base_info?.article_count != null) {
        const count = String(response.base_info.article_count);
        if (!/^\d+$/.test(count))
          throw new Error('公开合集文章总数无效，本次未写入');
        expectedCount = Number(count);
      }
      pages++;
      albumPages++;
      title ||= String(response.base_info?.title || albumId);
      for (const item of response.article_list) {
        const identity = canonicalArticleUrl(item.url);
        const publishTime = Number(item.create_time);
        if (
          identity.mpId !== mpId ||
          !item.title ||
          !Number.isInteger(publishTime) ||
          publishTime < 946684800 ||
          publishTime > Date.now() / 1000 + 300
        )
          throw new Error('公开合集文章身份或发布日期异常，本次未写入');
        if (
          identity.id !==
          `WX_${mpId.replace('MP_WXS_', '')}_${item.msgid}_${item.itemidx}`
        )
          throw new Error('公开合集文章链接与分页标识不一致，本次未写入');
        articles.set(identity.id, {
          ...identity,
          title: String(item.title),
          publishTime,
          picUrl: String(item.cover_img_1_1 || ''),
        });
        albumArticles.add(identity.id);
      }
      if (String(response.continue_flag) === '0') {
        complete = true;
        break;
      }
      if (
        String(response.continue_flag) !== '1' ||
        !response.article_list.length
      )
        throw new Error('公开合集分页状态异常，本次未写入');
      const last = response.article_list.at(-1);
      const next = `${last.msgid}_${last.itemidx}`;
      if (cursors.has(next)) throw new Error('公开合集重复分页，本次未写入');
      cursors.add(next);
      cursor = {
        begin_msgid: String(last.msgid),
        begin_itemidx: String(last.itemidx),
      };
    }
    if (!complete)
      throw new Error('公开合集超过 50 页，请缩小合集范围；本次未写入');
    if (expectedCount !== undefined && expectedCount !== albumArticles.size)
      throw new Error(
        '公开合集总数与分页结果不一致，内容可能已变化，请重试；本次未写入',
      );
    albums.push({
      id: albumId,
      title,
      pages: albumPages,
      articles: albumArticles.size,
    });
  }
  if (!articles.size) throw new Error('公开合集没有返回文章，本次未写入');
  return { articles: [...articles.values()], pages, albums };
}

function publicProxy() {
  const proxyUrl = process.env.WECHAT_PUBLIC_PROXY_URL;
  let proxy: false | { protocol: string; host: string; port: number } = false;
  if (proxyUrl) {
    const url = new URL(proxyUrl);
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.username ||
      url.password
    )
      throw new Error('公开合集代理仅支持无凭据的本机 HTTP 代理');
    proxy = {
      protocol: 'http',
      host: url.hostname,
      port: Number(url.port || 80),
    };
  }
  return proxy;
}

export async function resolvePublicArticle(shortId: string, mpId: string) {
  if (!/^[A-Za-z0-9_-]{22}$/.test(shortId))
    throw new Error('旧文章不是可验证的微信短链');
  try {
    const { data } = await axios.get(`https://mp.weixin.qq.com/s/${shortId}`, {
      proxy: publicProxy(),
      timeout: 15000,
      maxContentLength: 10 * 1024 * 1024,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
      },
    });
    const identity = articleIdentity(data);
    if (
      identity.mpId !== mpId ||
      identity.canonical !== `https://mp.weixin.qq.com/s/${shortId}`
    )
      throw new Error('身份不一致');
    return identity;
  } catch {
    throw new Error(
      `无法核验旧文章 ${shortId} 的原文身份，本次未写入，避免创建重复文章`,
    );
  }
}
