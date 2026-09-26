import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '@server/prisma/prisma.service';
import got, { Got } from 'got';
import axios from 'axios';
import { load } from 'cheerio';

export class TokenInvalidError extends Error {
  constructor(accountId: string) {
    super(`账号 ${accountId} Token 已失效，请重新登录`);
    this.name = 'TokenInvalidError';
  }
}

export interface WereadCookies {
  wr_vid?: string;
  wr_skey?: string;
  wr_rt?: string;
  wr_fp?: string;
  wr_gid?: string;
  accessToken?: string;
  refreshToken?: string;
}

@Injectable()
export class WereadService {
  private readonly logger = new Logger(WereadService.name);
  private readonly gotClient: Got;

  constructor(private readonly prismaService: PrismaService) {
    this.gotClient = got.extend({
      timeout: 10 * 1e3,
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      },
    });
  }

  /**
   * 生成微信读书官方扫码登录凭证与链接
   */
  async createLoginUrl(): Promise<{ uuid: string; scanUrl: string }> {
    this.logger.log('Fetching WeRead native login UID...');
    try {
      const resp = await axios.get<{ uid?: string }>(
        'https://weread.qq.com/api/auth/getLoginUid',
        {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            Referer: 'https://weread.qq.com/',
          },
          timeout: 10 * 1e3,
        },
      );

      const uuid = resp.data?.uid;
      if (!uuid) {
        throw new Error('未获取到微信读书登录 UID');
      }

      const scanUrl = `https://weread.qq.com/web/confirm?uid=${uuid}`;
      this.logger.log(`Created WeRead Login UID: ${uuid}`);

      return { uuid, scanUrl };
    } catch (err: any) {
      this.logger.error(`createLoginUrl error: ${err.message}`);
      throw new Error(`获取微信登录二维码失败: ${err.message}`);
    }
  }

  /**
   * 轮询微信读书官方登录确认状态
   */
  async getLoginResult(uuid: string): Promise<{
    message: string;
    vid?: number;
    token?: string;
    username?: string;
  }> {
    if (!uuid) {
      return { message: '' };
    }

    const pollUrl = `https://weread.qq.com/api/auth/getLoginInfo?uid=${encodeURIComponent(uuid)}&otp=`;

    try {
      const resp = await axios.get<{
        succeed?: number | boolean;
        accessToken?: string;
        refreshToken?: string;
        webLoginVid?: number;
        logicCode?: string;
        message?: string;
      }>(pollUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          Referer: 'https://weread.qq.com/',
        },
        timeout: 45 * 1e3,
      });

      const data = resp.data || {};

      // 登录成功
      if (data.succeed && (data.webLoginVid || data.accessToken)) {
        const vid = data.webLoginVid;
        this.logger.log(`WeRead native scan confirmed! VID: ${vid}`);

        const setCookies = resp.headers['set-cookie'] || [];
        const cookieMap: Record<string, string> = {};
        for (const sc of setCookies) {
          const parts = sc.split(';')[0].split('=');
          if (parts.length >= 2) {
            cookieMap[parts[0].trim()] = parts.slice(1).join('=').trim();
          }
        }

        if (vid) {
          cookieMap['wr_vid'] = String(vid);
        }
        if (data.accessToken) {
          cookieMap['wr_skey'] = data.accessToken;
        }
        if (data.refreshToken) {
          cookieMap['wr_rt'] = encodeURIComponent(data.refreshToken);
        }

        // 尝试自动续期以获取最完整 cookies
        try {
          const renewed = await this.renewCookie(cookieMap);
          if (renewed) {
            Object.assign(cookieMap, renewed);
          }
        } catch (e: any) {
          this.logger.warn(`Initial renewal ignored: ${e.message}`);
        }

        // 获取用户昵称
        let username = '微信读书用户';
        if (vid) {
          try {
            const userResp = await axios.get<{ name?: string }>(
              `https://weread.qq.com/api/userInfo?userVid=${vid}`,
              {
                headers: {
                  Cookie: this.stringifyCookies(cookieMap),
                  'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
                  Referer: 'https://weread.qq.com/',
                },
                timeout: 5 * 1e3,
              },
            );
            if (userResp.data?.name) {
              username = userResp.data.name;
            }
          } catch (e: any) {
            this.logger.warn(`Fetch userInfo failed: ${e.message}`);
          }
        }

        const tokenJson = JSON.stringify({
          ...cookieMap,
          accessToken: data.accessToken,
          refreshToken: data.refreshToken,
          updateTime: Date.now(),
        });

        this.logger.log(
          `WeRead native login success: VID ${vid} (${username})`,
        );
        return {
          message: '',
          vid,
          token: tokenJson,
          username,
        };
      }

      if (data.logicCode === 'LOGIN_TIMEOUT') {
        return { message: '二维码已失效，请刷新' };
      }

      if (data.logicCode === 'WAITING_SCAN') {
        return { message: '' };
      }

      if (data.logicCode === 'WAITING_CONFIRM') {
        return { message: '已扫码，请在微信中点击确认' };
      }

      return { message: '' };
    } catch (err: any) {
      if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
        return { message: '' };
      }
      this.logger.warn(`Polling getLoginInfo error: ${err.message}`);
      return { message: '' };
    }
  }

  /**
   * 自动续期 wr_skey
   */
  async renewCookie(
    cookies: Record<string, string>,
  ): Promise<Record<string, string> | null> {
    try {
      const cookieStr = this.stringifyCookies(cookies);
      const resp = await axios.post(
        'https://weread.qq.com/web/login/renewal',
        { rq: '%2Fweb%2Fbook%2Fread', ql: true },
        {
          headers: {
            'Content-Type': 'application/json',
            Cookie: cookieStr,
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            Origin: 'https://weread.qq.com',
            Referer: 'https://weread.qq.com/',
          },
        },
      );

      const setCookies = resp.headers['set-cookie'] || [];
      const updated: Record<string, string> = { ...cookies };
      let hasNewSkey = false;

      for (const sc of setCookies) {
        const parts = sc.split(';')[0].split('=');
        if (parts.length >= 2) {
          const k = parts[0].trim();
          const v = parts.slice(1).join('=').trim();
          updated[k] = v;
          if (k === 'wr_skey' && v) {
            hasNewSkey = true;
          }
        }
      }

      if (hasNewSkey) {
        this.logger.log('Successfully renewed wr_skey');
        return updated;
      }
      return null;
    } catch (err: any) {
      this.logger.warn(`renewCookie error: ${err.message}`);
      return null;
    }
  }

  /**
   * 解析微信公众号文章链接为公众号基本信息 (本地原生解析)
   */
  async getMpInfo(url: string): Promise<
    {
      id: string;
      cover: string;
      name: string;
      intro: string;
      updateTime: number;
    }[]
  > {
    url = url.trim();
    this.logger.log(`Resolving WeChat MP info for URL: ${url}`);

    let html = '';
    try {
      const resp = await this.gotClient(url, {
        headers: {
          referer: 'https://mp.weixin.qq.com/',
          accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        },
      });
      html = resp.body;
    } catch (err: any) {
      this.logger.error(`Failed to fetch article page ${url}: ${err.message}`);
      throw new Error(`无法访问微信公众号文章链接: ${err.message}`);
    }

    const $ = load(html, { decodeEntities: false });

    // 提取 __biz
    let biz = '';
    const bizUrlMatch = url.match(/[?&]__biz=([^&#]+)/);
    if (bizUrlMatch) {
      biz = decodeURIComponent(bizUrlMatch[1]);
    } else {
      const bizVarMatch =
        html.match(/var\s+biz\s*=\s*"([^"]+)"/) ||
        html.match(/var\s+__biz\s*=\s*"([^"]+)"/) ||
        html.match(/__biz=([^"&' ]+)/);
      if (bizVarMatch) {
        biz = bizVarMatch[1];
      }
    }

    if (!biz) {
      throw new Error(
        '未能在该文章中提取到公众号标识 (__biz)，请确认链接是否为微信公众号文章',
      );
    }

    // 还原原始数字 ID
    let bizNum = '';
    try {
      bizNum = Buffer.from(biz, 'base64').toString('ascii');
      if (!/^\d+$/.test(bizNum)) {
        // 如果 base64 解码后不是纯数字，则使用 biz 自身作为标识
        bizNum = biz.replace(/[^a-zA-Z0-9_]/g, '');
      }
    } catch {
      bizNum = biz.replace(/[^a-zA-Z0-9_]/g, '');
    }

    const mpId = `MP_WXS_${bizNum}`;

    // 提取公众号名称、头像、简介
    const name =
      $('#js_name').text().trim() ||
      $('.profile_nickname').text().trim() ||
      html.match(/var\s+nickname\s*=\s*"([^"]+)"/)?.[1] ||
      $('meta[property="og:article:author"]').attr('content') ||
      '微信公众号';

    const cover =
      html.match(/var\s+round_head_img\s*=\s*"([^"]+)"/)?.[1] ||
      $('#js_profile_qrcode .profile_avatar').attr('src') ||
      $('meta[property="og:image"]').attr('content') ||
      '';

    const intro =
      $('.profile_meta_value').first().text().trim() ||
      html.match(/var\s+desc\s*=\s*"([^"]+)"/)?.[1] ||
      $('meta[name="description"]').attr('content') ||
      '';

    const updateTime = Math.floor(Date.now() / 1000);

    this.logger.log(`Resolved MP: ${name} (${mpId})`);

    return [
      {
        id: mpId,
        cover,
        name,
        intro,
        updateTime,
      },
    ];
  }

  /**
   * 获取指定公众号的最新文章列表
   */
  async getMpArticles(
    mpId: string,
    page = 1,
    account: { id: string; token: string },
  ): Promise<
    {
      id: string;
      title: string;
      picUrl: string;
      publishTime: number;
    }[]
  > {
    let cookies = this.parseToken(account.token, account.id);
    let cookieStr = this.stringifyCookies(cookies);

    this.logger.log(
      `Fetching WeRead cover for ${mpId} (page: ${page}) using account ${account.id}...`,
    );

    let resData: any = null;
    let needRetryWithRenewal = false;

    try {
      const resp = await axios.get(
        `https://weread.qq.com/api/mp/cover?bookId=${encodeURIComponent(mpId)}`,
        {
          headers: {
            Cookie: cookieStr,
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            Referer: 'https://weread.qq.com/',
          },
          timeout: 15 * 1e3,
        },
      );
      resData = resp.data;
    } catch (err: any) {
      if (
        err.response?.status === 401 ||
        err.response?.data?.data?.errcode === -2012
      ) {
        needRetryWithRenewal = true;
      } else {
        this.logger.error(
          `Error requesting weread /api/mp/cover: ${err.message}`,
        );
        throw err;
      }
    }

    if (
      resData &&
      (resData.errcode === -2012 || resData.data?.errcode === -2012)
    ) {
      needRetryWithRenewal = true;
    }

    // 若登录失效，尝试通过 renewal 自动换取最新 wr_skey 续期
    if (needRetryWithRenewal) {
      this.logger.warn(
        `Account ${account.id} session expired (-2012), attempting renewal...`,
      );
      const renewed = await this.renewCookie(cookies);
      if (renewed) {
        cookies = renewed;
        cookieStr = this.stringifyCookies(cookies);
        // 保存续期后的 token 到数据库
        const updatedToken = JSON.stringify({
          ...cookies,
          updateTime: Date.now(),
        });
        await this.prismaService.account.update({
          where: { id: account.id },
          data: { token: updatedToken },
        });

        // 续期后重试一次
        try {
          const retryResp = await axios.get(
            `https://weread.qq.com/api/mp/cover?bookId=${encodeURIComponent(mpId)}`,
            {
              headers: {
                Cookie: cookieStr,
                'User-Agent':
                  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
                Referer: 'https://weread.qq.com/',
              },
              timeout: 15 * 1e3,
            },
          );
          resData = retryResp.data;
        } catch (e: any) {
          this.logger.error(`Retry after renewal failed: ${e.message}`);
          throw new TokenInvalidError(account.id);
        }
      } else {
        throw new TokenInvalidError(account.id);
      }
    }

    // 解析最新文章信息
    if (!resData) {
      return [];
    }

    const payload = resData.data || resData;
    const coverObj = payload.mpCover || payload.cover || payload;

    const reviewId =
      coverObj.reviewId || payload.reviewId || coverObj.id || payload.id;
    const title = coverObj.title || payload.title;

    if (!reviewId || !title) {
      this.logger.warn(
        `No valid article found in weread cover response for ${mpId}`,
      );
      return [];
    }

    const rawReviewId = String(reviewId).trim();
    // 微信文章短链 token 的字符集为 [A-Za-z0-9_-]
    // 微信读书将下划线 '_' 转写成了 '~'，并且 reviewId 格式为 MP_WXS_<mpId>_<articleToken>
    // 必须剥离 MP_WXS 前缀并将 '~' 还原为 '_'，否则微信打开报“参数错误”
    let token = rawReviewId;
    if (mpId && token.startsWith(`${mpId}_`)) {
      token = token.slice(mpId.length + 1);
    } else {
      const m = token.match(/^MP_WXS_\d+_(.+)$/);
      if (m) token = m[1];
    }
    const cleanArticleId = token.replace(/~/g, '_');

    const picUrl = coverObj.cover || coverObj.picUrl || payload.picUrl || '';
    let publishTime =
      coverObj.updateTime ||
      payload.updateTime ||
      Math.floor(Date.now() / 1000);

    // 尝试从 /web/mp/content 获取最准确的发布时间戳
    try {
      const contentResp = await axios.get<string>(
        `https://weread.qq.com/web/mp/content?reviewId=${encodeURIComponent(rawReviewId)}`,
        {
          headers: {
            Cookie: cookieStr,
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            Referer: 'https://weread.qq.com/',
          },
          timeout: 6 * 1e3,
        },
      );
      if (contentResp.data) {
        const ctMatch = contentResp.data.match(
          /(?:create_time|ct|CreateTime)\s*[:=]\s*['"]?(\d{10})['"]?/i,
        );
        if (ctMatch && ctMatch[1]) {
          publishTime = parseInt(ctMatch[1], 10);
        }
      }
    } catch {
      // 容错，使用默认时间
    }

    return [
      {
        id: cleanArticleId,
        title: String(title),
        picUrl: String(picUrl),
        publishTime: Number(publishTime),
      },
    ];
  }

  /**
   * 将 token 解析为 Cookie 对象（兼容 JSON、Cookie 字符串与旧版 JWT）
   */
  parseToken(token: string, accountId?: string): Record<string, string> {
    const cookies: Record<string, string> = {};
    if (!token) return cookies;

    token = token.trim();
    if (token.startsWith('{')) {
      try {
        const parsed = JSON.parse(token);
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === 'string' && v) {
            cookies[k] = v;
          }
        }
      } catch (e) {
        this.logger.warn('Failed to parse token JSON');
      }
    } else if (token.startsWith('ey')) {
      // 旧版 JWT 格式
      try {
        const payload = JSON.parse(
          Buffer.from(token.split('.')[1], 'base64').toString('utf8'),
        );
        if (payload.vid) cookies['wr_vid'] = String(payload.vid);
        if (payload.tk) cookies['wr_skey'] = String(payload.tk);
      } catch (e) {
        this.logger.warn('Failed to parse JWT token');
      }
    } else if (token.includes('=')) {
      // 类似 key=value; key2=value2
      token.split(';').forEach((item) => {
        const parts = item.trim().split('=');
        if (parts.length >= 2) {
          cookies[parts[0].trim()] = parts.slice(1).join('=').trim();
        }
      });
    }

    if (accountId && !cookies['wr_vid']) {
      cookies['wr_vid'] = accountId;
    }

    return cookies;
  }

  /**
   * 序列化 Cookie 字典为 Header 格式
   */
  stringifyCookies(cookies: Record<string, string>): string {
    return Object.entries(cookies)
      .filter(
        ([k, v]) =>
          v && !['updateTime', 'accessToken', 'refreshToken'].includes(k),
      )
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  /**
   * 获取微信读书文章正文内容 (兜底 fallback)
   */
  async getArticleContent(articleId: string, mpId?: string): Promise<string> {
    try {
      const account = await this.prismaService.account.findFirst({
        where: { status: 1 },
      });
      if (!account) return '';

      const cookieStr = this.stringifyCookies(
        this.parseToken(account.token, account.id),
      );

      let reviewId = articleId.trim();
      if (!reviewId.startsWith('MP_WXS_') && mpId) {
        reviewId = `${mpId}_${articleId.replace(/_/g, '~')}`;
      }

      const resp = await axios.get<string>(
        `https://weread.qq.com/web/mp/content?reviewId=${encodeURIComponent(reviewId)}`,
        {
          headers: {
            Cookie: cookieStr,
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
            Referer: 'https://weread.qq.com/',
          },
          timeout: 10 * 1e3,
        },
      );
      return resp.data;
    } catch (err: any) {
      this.logger.warn(
        `Failed to fetch weread content for ${articleId}: ${err.message}`,
      );
      return '';
    }
  }
}
