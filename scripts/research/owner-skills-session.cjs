'use strict';

// One ephemeral same-origin Web session. Follows finlater/weread.koplugin
// @24c0765 scripts/verify_qr_login.py without saving credentials or API keys.
const ORIGIN = 'https://weread.qq.com';
const SKILLS = `${ORIGIN}/r/weread-skills`;
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 Edg/135.0.0.0';

class SessionStop extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function reject(code) {
  throw new SessionStop(code);
}

function businessGate(data, stage) {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    reject(`${stage}_SHAPE`);
  const code = data.errCode ?? data.errcode ?? data.code;
  if (code !== undefined && code !== 0) reject(`${stage}_BUSINESS_STOP`);
  if (
    [data.message, data.msg, data.errMsg].some(
      (v) =>
        typeof v === 'string' &&
        /captcha|验证码|安全验证|频繁|限流|环境异常|rate.?limit/i.test(v),
    )
  )
    reject(`${stage}_VERIFICATION_STOP`);
  return data;
}

function validCredential(value, max = 8192) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    !/[;\s\x00-\x1f\x7f]/.test(value)
  );
}

class MemoryJar {
  constructor() {
    this.values = new Map();
  }
  merge(headers) {
    if (typeof headers.getSetCookie !== 'function')
      reject('COOKIE_API_MISSING');
    for (const line of headers.getSetCookie()) {
      if (typeof line !== 'string' || line.length > 16384)
        reject('SET_COOKIE_INVALID');
      const parts = line.split(';');
      const match = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)=([^;\x00-\x1f\x7f]*)$/.exec(
        parts.shift().trim(),
      );
      if (!match) reject('SET_COOKIE_INVALID');
      let cookiePath = '/';
      let domain = 'weread.qq.com';
      let expired = false;
      for (const part of parts) {
        const [name, ...rest] = part.trim().split('=');
        const value = rest.join('=').trim();
        if (/^domain$/i.test(name)) {
          domain = value.toLowerCase().replace(/^\./, '');
          if (!['weread.qq.com', 'qq.com'].includes(domain))
            reject('SET_COOKIE_DOMAIN_INVALID');
        }
        if (/^path$/i.test(name) && value.startsWith('/')) cookiePath = value;
        if (/^max-age$/i.test(name) && Number(value) <= 0) expired = true;
        if (
          /^expires$/i.test(name) &&
          Number.isFinite(Date.parse(value)) &&
          Date.parse(value) <= Date.now()
        )
          expired = true;
      }
      const key = `${domain}|${cookiePath}|${match[1]}`;
      if (expired || !match[2]) this.values.delete(key);
      else
        this.values.set(key, {
          name: match[1],
          value: match[2],
          domain,
          path: cookiePath,
        });
    }
  }
  set(name, value) {
    if (!validCredential(value)) reject('LOGIN_CREDENTIAL_INVALID');
    for (const [key, cookie] of this.values)
      if (cookie.name === name) this.values.delete(key);
    this.values.set(`weread.qq.com|/|${name}`, {
      name,
      value,
      domain: 'weread.qq.com',
      path: '/',
    });
  }
  header(url) {
    const pathname = new URL(url).pathname;
    const entries = [...this.values.values()].filter(
      (c) =>
        pathname === c.path ||
        c.path === '/' ||
        (pathname.startsWith(c.path) &&
          (c.path.endsWith('/') || pathname[c.path.length] === '/')),
    );
    // A newly authenticated root cookie takes precedence over an old page
    // cookie with the same name, regardless of domain attribute.
    const unique = new Map();
    for (const c of entries) unique.set(c.name, c.value);
    return [...unique].map(([name, value]) => `${name}=${value}`).join('; ');
  }
  names() {
    return [...new Set([...this.values.values()].map((c) => c.name))].sort();
  }
}

async function boundedBody(response, maxBytes) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes)
    reject('RESPONSE_TOO_LARGE');
  const reader = response.body?.getReader();
  if (!reader) reject('MISSING_RESPONSE_BODY');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        reject('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

async function boundedText(response, maxBytes) {
  return (await boundedBody(response, maxBytes)).toString('utf8');
}

class SkillsSession {
  constructor(fetchImpl = fetch) {
    this.fetchImpl = fetchImpl;
    this.jar = new MemoryJar();
    this.stageNames = {};
    this.polls = 0;
    this.startedAt = 0;
  }
  async request(
    url,
    {
      method = 'GET',
      referer = SKILLS,
      json,
      headers = {},
      allowRedirect = false,
      stage,
    } = {},
  ) {
    if (!url.startsWith(`${ORIGIN}/`)) reject('ORIGIN_INVALID');
    for (let redirects = 0; redirects <= (allowRedirect ? 5 : 0); redirects++) {
      let response;
      try {
        response = await this.fetchImpl(url, {
          method,
          redirect: 'manual',
          cache: 'no-store',
          signal: AbortSignal.timeout(stage === 'loginInfo' ? 70000 : 20000),
          headers: {
            'User-Agent': UA,
            Accept: 'application/json, text/plain, */*',
            Referer: referer,
            ...(this.jar.header(url) ? { Cookie: this.jar.header(url) } : {}),
            ...(json ? { 'Content-Type': 'application/json' } : {}),
            ...headers,
          },
          ...(json ? { body: JSON.stringify(json) } : {}),
        });
      } catch {
        reject(`${stage}_TRANSPORT_STOP`);
      }
      this.jar.merge(response.headers);
      this.stageNames[stage] = this.jar.names();
      if (response.status >= 300 && response.status < 400 && allowRedirect) {
        const location = response.headers.get('location');
        if (!location) reject(`${stage}_REDIRECT_STOP`);
        const next = new URL(location, url);
        if (next.origin !== ORIGIN) reject(`${stage}_REDIRECT_STOP`);
        if (/captcha|verify|challenge/i.test(next.pathname))
          reject(`${stage}_VERIFICATION_STOP`);
        await response.body?.cancel();
        url = next.href;
        continue;
      }
      if (response.status !== 200) reject(`${stage}_HTTP_STOP`);
      return response;
    }
    reject(`${stage}_REDIRECT_STOP`);
  }
  async json(url, options) {
    const response = await this.request(url, options);
    let data;
    try {
      data = JSON.parse(await boundedText(response, 65536));
    } catch (error) {
      if (error instanceof SessionStop) throw error;
      reject(`${options.stage}_NON_JSON`);
    }
    return { data: businessGate(data, options.stage.toUpperCase()), response };
  }
  async begin() {
    const page = await this.request(SKILLS, {
      referer: `${ORIGIN}/`,
      allowRedirect: true,
      stage: 'skillsPage',
    });
    const pageText = await boundedText(page, 1024 * 1024);
    if (/captcha|安全验证|异常访问|行为验证/i.test(pageText))
      reject('SKILLS_PAGE_VERIFICATION_STOP');
    const { data } = await this.json(`${ORIGIN}/api/auth/getLoginUid`, {
      stage: 'loginUid',
    });
    if (typeof data.uid !== 'string' || !/^[A-Za-z0-9-]{8,128}$/.test(data.uid))
      reject('LOGIN_UID_INVALID');
    this.uid = data.uid;
    this.startedAt = Date.now();
    return `${ORIGIN}/web/confirm?uid=${encodeURIComponent(data.uid)}`;
  }
  async poll(otp = '') {
    if (!this.uid || Date.now() - this.startedAt > 120000 || this.polls >= 20)
      reject('LOGIN_TIMEOUT');
    this.polls++;
    const otpSuffix = `=${encodeURIComponent(otp)}`;
    const query = `uid=${encodeURIComponent(this.uid)}&otp${otpSuffix}`;
    const { data } = await this.json(
      `${ORIGIN}/api/auth/getLoginInfo?${query}`,
      { stage: 'loginInfo' },
    );
    if (data.succeed === true) {
      if (
        !/^\d+$/.test(String(data.webLoginVid || '')) ||
        !validCredential(data.accessToken) ||
        !validCredential(data.refreshToken)
      )
        reject('LOGIN_CREDENTIAL_INVALID');
      this.login = {
        vid: String(data.webLoginVid),
        accessToken: data.accessToken,
      };
      this.jar.set('wr_vid', this.login.vid);
      this.jar.set('wr_skey', data.accessToken);
      this.jar.set('wr_ql', '0');
      this.jar.set('wr_rt', encodeURIComponent(data.refreshToken));
      this.stageNames.credentials = this.jar.names();
      return { ready: true, vid: this.login.vid };
    }
    if (['WAITING_SCAN', 'WAITING_CONFIRM'].includes(data.logicCode))
      return { ready: false, state: data.logicCode };
    reject('LOGIN_STATE_STOP');
  }
  async verifyAndRenew(ownerVid) {
    if (!this.login || this.login.vid !== ownerVid)
      reject('OWNER_IDENTITY_MISMATCH');
    const headers = { 'X-Vid': ownerVid, 'X-Skey': this.login.accessToken };
    const { data: userInfo } = await this.json(
      `${ORIGIN}/api/userInfo?userVid=${encodeURIComponent(ownerVid)}`,
      { stage: 'userInfo', headers },
    );
    for (const field of ['userVid', 'vid'])
      if (userInfo[field] !== undefined && String(userInfo[field]) !== ownerVid)
        reject('USER_INFO_IDENTITY_MISMATCH');
    const { data: apiResult } = await this.json(
      `${ORIGIN}/api/skills/apikeyGet?only_show=1`,
      { stage: 'apikeyGet', headers },
    );
    if (!validCredential(apiResult.apikey)) reject('API_KEY_MISSING');
    // The API key is only checked for presence and is never retained.
    const { data: renewal, response } = await this.json(
      `${ORIGIN}/web/login/renewal`,
      {
        method: 'POST',
        stage: 'renewal',
        referer: `${ORIGIN}/`,
        headers: { Origin: ORIGIN },
        json: { rq: '%2Fweb%2Fbook%2Fread', ql: false },
      },
    );
    if (![true, 1, '1'].includes(renewal.succ)) reject('RENEWAL_NOT_SUCCESS');
    const ticket = response.headers.get('x-wr-ticket');
    const wrpa = response.headers.get('x-wrpa-0');
    if (!validCredential(ticket)) reject('FRESH_TICKET_MISSING');
    if (wrpa !== null && !validCredential(wrpa)) reject('WRPA_INVALID');
    return { ticket, wrpa: wrpa || undefined };
  }
  async listOnce(url, ticket, wrpa) {
    if (!validCredential(ticket)) reject('FRESH_TICKET_MISSING');
    const response = await this.request(url, {
      stage: 'mpArticles',
      referer: `${ORIGIN}/`,
      headers: {
        'x-wr-ticket': ticket,
        ...(wrpa ? { 'x-wrpa-0': wrpa } : {}),
      },
    });
    return await boundedText(response, 2 * 1024 * 1024);
  }
  async bodyOnce(reviewId, ticket, wrpa) {
    if (!validCredential(ticket)) reject('FRESH_TICKET_MISSING');
    if (!/^MP_WXS_3895431412_[A-Za-z0-9_~-]+$/.test(reviewId))
      reject('BODY_REVIEW_ID_INVALID');
    const response = await this.request(
      `${ORIGIN}/web/mp/content?reviewId=${encodeURIComponent(reviewId)}`,
      {
        stage: 'mpContent',
        referer: `${ORIGIN}/`,
        headers: {
          Accept: 'text/html,application/xhtml+xml,*/*',
          'x-wr-ticket': ticket,
          ...(wrpa ? { 'x-wrpa-0': wrpa } : {}),
        },
      },
    );
    return await boundedBody(response, 12 * 1024 * 1024);
  }
}

module.exports = { SkillsSession, SessionStop, MemoryJar, ORIGIN, SKILLS };
