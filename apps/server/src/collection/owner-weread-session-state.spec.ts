import { createHash } from 'node:crypto';
import { ownerSessionCookie, OwnerWebSession } from './owner-web-search';
import {
  ownerLatestAuthHash,
  ownerLatestFailureReason,
  ownerLatestStopMessage,
  recordOwnerLatestOfflineVerification,
} from './owner-weread-session-state';
import { ProviderPage } from './subscription-provider';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const mpId = 'MP_WXS_1234567890';
const session = (): OwnerWebSession => ({
  source: 'owner-confirmed-native-web-login',
  ownerVid: '123',
  capturedAt: '2025-01-02T00:00:00.000Z',
  cookies: ['wr_vid', 'wr_skey', 'wr_pf'].map((name) => ({
    name,
    value: name === 'wr_vid' ? '123' : 'fixture-' + name,
    domain: '.weread.qq.com',
    path: '/',
    secure: true,
    expires: -1,
  })),
});
function evidence() {
  const sessionText = JSON.stringify(session());
  const stateText = JSON.stringify({
    sessionHash: sha('old-login-cookie'),
    lastAttemptAt: Date.parse('2025-01-01T00:00:00Z'),
    response: { stage: 'cover', httpStatus: 401, bytes: 20, requests: 1 },
    stop: {
      at: '2025-01-01T00:00:00Z',
      stage: 'cover',
      reason: 'HTTP 401',
      requests: 1,
    },
  });
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN1kAAAAASUVORK5CYII=',
    'base64',
  );
  const contentHtml = `<div>完整正文<img src="data:image/png;base64,${image.toString('base64')}"></div>`;
  const page: ProviderPage = {
    articles: [
      {
        id: 'WX_1234567890_100_1',
        mpId,
        title: '测试文章',
        publishTime: 1700000000,
        url: 'https://mp.weixin.qq.com/s?__biz=MTIzNDU2Nzg5MA%3D%3D&mid=100&idx=1&sn=abcd',
        picUrl: '',
        contentHtml,
      },
    ],
    coverage: 'recent-window',
    upstreamCount: 1,
    bodyMissing: 0,
    imageBlocked: 0,
    pages: 1,
  };
  const cookieHash = sha(ownerSessionCookie(JSON.parse(sessionText), '123'));
  const lastAttemptAt = Date.parse('2025-01-02T00:00:01.010Z');
  const lastSuccessAt = Date.parse('2025-01-02T00:00:02.000Z');
  return {
    stateText,
    sessionText,
    ownerVid: '123',
    mpId,
    page,
    savedImages: [image],
    attempt: {
      target: mpId,
      sessionCapturedAt: session().capturedAt,
      sessionSha: sha(sessionText),
      freshCookieHash: cookieHash,
      oldStopSha: sha(stateText),
      oldStopStage: 'cover',
      oldStopReason: 'HTTP 401',
      commit: 'a'.repeat(40),
      approvedCase:
        'one cover, one body, at most 60 unique images; no article DB writes',
      reservedAt: '2025-01-02T00:00:01.000Z',
      noRetry: true,
    },
    result: {
      success: true,
      commit: 'a'.repeat(40),
      finishedAt: '2025-01-02T00:00:02.100Z',
      noRetry: true,
      oldMarkersUnchanged: true,
      savedSessionUnchanged: true,
      productionArticleWrites: 0,
      directoryRequests: 0,
      textRequests: 2,
      bodyMissing: 0,
      imageBlocked: 0,
      coverage: 'recent-window',
      textResponses: ['cover', 'content'].map((stage) => ({
        stage,
        status: 200,
        bytes: 100,
        requestCookieSha: cookieHash,
      })),
      article: {
        id: page.articles[0].id,
        mpId,
        title: '测试文章',
        publishTime: 1700000000,
        allBodyImagesInline: true,
        imageOccurrences: 1,
        bodyBytes: Buffer.byteLength(contentHtml),
      },
      savedUniqueImages: 1,
      imageRequests: 1,
      uniqueImageRequests: 1,
    },
    probeState: {
      sessionHash: cookieHash,
      lastAttemptAt,
      lastSuccessAt,
      articleId: page.articles[0].id,
    },
  };
}

describe('owner latest session stop ownership (offline only)', () => {
  it('describes the observed login timeout without changing or releasing a saved stop', () => {
    const reason = '微信读书登录超时（业务码 -2012）';
    expect(ownerLatestFailureReason(new Error('业务码 -2012'))).toBe(reason);
    expect(ownerLatestFailureReason(reason)).toBe(reason);
    const state = {
      stop: {
        sessionAuthHash: ownerLatestAuthHash(session(), '123'),
        stage: 'directory-0',
        reason: '业务码 -2012',
        requests: 1,
      },
    };
    const before = JSON.stringify(state);
    expect(ownerLatestStopMessage(state, session(), '123', mpId)).toContain(
      reason,
    );
    expect(JSON.stringify(state)).toBe(before);
    expect(ownerLatestFailureReason(new Error('业务码 -2041'))).toBe(
      '业务码 -2041',
    );
    expect(
      ownerLatestFailureReason(new Error('登录超时 token=private-fixture')),
    ).not.toContain('private-fixture');
  });
  it.each([
    ['directory-0', '目录'],
    ['directory-next', '目录'],
    ['content-1', '正文'],
    ['content-10', '正文'],
    ['images', '图片归档'],
    ['cover', '最新篇'],
    ['unknown', '更新'],
  ])(
    'reports the actual stopped stage without changing the state (%s)',
    (stage, label) => {
      const state = {
        stop: {
          sessionAuthHash: ownerLatestAuthHash(session(), '123'),
          stage,
          reason: 'HTTP 401',
        },
      };
      const before = JSON.stringify(state);
      expect(ownerLatestStopMessage(state, session(), '123', mpId)).toContain(
        `${label}已停止：HTTP 401`,
      );
      expect(JSON.stringify(state)).toBe(before);
    },
  );
  it('never exposes arbitrary transport or historical error text in the product message', () => {
    const privateError = 'https://weread.qq.com/?token=private-fixture';
    expect(ownerLatestFailureReason(new Error(privateError))).toBe(
      '请求、响应或本地保存失败',
    );
    expect(
      ownerLatestFailureReason(new Error('WEREAD_BODY_ACCESS_CHALLENGE')),
    ).toBe('腾讯验证或访问限制');
    const state = {
      stop: {
        sessionAuthHash: ownerLatestAuthHash(session(), '123'),
        stage: 'directory-0',
        reason: privateError,
      },
    };
    expect(ownerLatestStopMessage(state, session(), '123', mpId)).not.toContain(
      'private-fixture',
    );
    expect(state.stop.reason).toBe(privateError);
  });
  it('identifies auth independently of auxiliary cookies, capture time and cookie order', () => {
    const first = session(),
      next = session();
    next.capturedAt = '2025-02-01T00:00:00Z';
    next.cookies.find((v) => v.name === 'wr_pf')!.value = 'changed-auxiliary';
    next.cookies.reverse();
    expect(ownerLatestAuthHash(next, '123')).toBe(
      ownerLatestAuthHash(first, '123'),
    );
    next.cookies.find((v) => v.name === 'wr_skey')!.value = 'new-login';
    expect(ownerLatestAuthHash(next, '123')).not.toBe(
      ownerLatestAuthHash(first, '123'),
    );
  });
  it('rejects another owner even with internally matching cookies', () => {
    const next = session();
    next.ownerVid = '999';
    next.cookies.find((v) => v.name === 'wr_vid')!.value = '999';
    expect(() => ownerLatestAuthHash(next, '123')).toThrow(
      'OWNER_WEB_SESSION_INVALID',
    );
  });
  it('keeps the stopped auth session stopped after only auxiliary or timestamp changes', () => {
    const state = {
      stop: {
        sessionAuthHash: ownerLatestAuthHash(session(), '123'),
        stage: 'cover',
        reason: 'HTTP 401',
      },
    };
    const next = session();
    next.capturedAt = '2025-02-01T00:00:00Z';
    next.cookies.find((v) => v.name === 'wr_pf')!.value = 'changed-auxiliary';
    expect(ownerLatestStopMessage(state, next, '123', mpId)).toContain(
      '当前读书会话最新篇已停止：HTTP 401',
    );
  });
  it('treats legacy hash mismatches as unverified rather than releasing the stop', () => {
    const state = JSON.parse(evidence().stateText);
    expect(ownerLatestStopMessage(state, session(), '123', mpId)).toContain(
      '当前会话尚未核实',
    );
    state.sessionHash = sha(ownerSessionCookie(session(), '123'));
    expect(ownerLatestStopMessage(state, session(), '123', mpId)).toContain(
      '已停止：HTTP 401',
    );
  });
  it('keeps success with another login pending separate refresh authorization', () => {
    const state = {
      sessionAuthHash: ownerLatestAuthHash(session(), '123'),
      lastSuccessAt: 1,
    };
    const next = session();
    next.cookies.find((v) => v.name === 'wr_skey')!.value = 'new-login';
    expect(ownerLatestStopMessage(state, next, '123', mpId)).toContain(
      '当前会话尚未核实',
    );
  });
  it('uses stop auth ownership before conflicting state metadata and rejects migration of ambiguous ownership', () => {
    const input = evidence();
    const state = JSON.parse(input.stateText);
    state.stop.sessionAuthHash = ownerLatestAuthHash(session(), '123');
    state.sessionAuthHash = 'other-auth-hash';
    expect(ownerLatestStopMessage(state, session(), '123', mpId)).toContain(
      '已停止：HTTP 401',
    );
    state.stop.sessionAuthHash = 'stopped-auth-hash';
    input.stateText = JSON.stringify(state);
    input.attempt.oldStopSha = sha(input.stateText);
    expect(() => recordOwnerLatestOfflineVerification(input)).toThrow(
      'OWNER_LATEST_OFFLINE_EVIDENCE_INVALID',
    );
  });
  it('records verified saved evidence without clearing historical stop, response, cooldown or permitting retry', () => {
    const input = evidence();
    const original = JSON.parse(input.stateText);
    const state = recordOwnerLatestOfflineVerification(input);
    expect(state.stop).toEqual(original.stop);
    expect(state.response).toEqual(original.response);
    expect(state.lastAttemptAt).toBe(original.lastAttemptAt);
    expect(state.offlineSessionVerification).toMatchObject({
      status: 'single-article-verified-refresh-not-authorized',
      target: mpId,
      articleId: 'WX_1234567890_100_1',
      lastAttemptAt: input.probeState.lastAttemptAt,
    });
    expect(ownerLatestStopMessage(state, session(), '123', mpId)).toContain(
      '本次未发联网请求',
    );
    expect(ownerLatestStopMessage(state, session(), '123', mpId)).toContain(
      '一篇正文及图片已由保存证据核实',
    );
    state.response.httpStatus = 200;
    expect(ownerLatestStopMessage(state, session(), '123', mpId)).toContain(
      '当前会话尚未核实',
    );
  });
  it.each([
    'target',
    'session-sha',
    'cookie-hash',
    'old-state-sha',
    'commit',
    'old-stop-reason',
    'failure',
    'unapproved',
    'directory-request',
    'production-write',
    'owner',
    'prior-capture',
    'content-http',
    'article-id',
    'publish-time',
    'empty-body',
    'missing-image',
    'changed-image',
    'prior-stop-changed',
  ])('rejects mismatched or incomplete evidence (%s)', (change) => {
    const input = evidence();
    switch (change) {
      case 'target':
        input.attempt.target = 'MP_WXS_9999999999';
        break;
      case 'session-sha':
        input.attempt.sessionSha = '0'.repeat(64);
        break;
      case 'cookie-hash':
        input.attempt.freshCookieHash = '0'.repeat(64);
        break;
      case 'old-state-sha':
        input.attempt.oldStopSha = '0'.repeat(64);
        break;
      case 'commit':
        input.result.commit = 'b'.repeat(40);
        break;
      case 'old-stop-reason':
        input.attempt.oldStopReason = 'HTTP 403';
        break;
      case 'failure':
        input.result.success = false;
        break;
      case 'unapproved':
        input.attempt.approvedCase = '';
        break;
      case 'directory-request':
        input.result.directoryRequests = 1;
        break;
      case 'production-write':
        input.result.productionArticleWrites = 1;
        break;
      case 'owner':
        input.ownerVid = '999';
        break;
      case 'prior-capture': {
        const next = session();
        next.capturedAt = '2024-01-01T00:00:00Z';
        input.sessionText = JSON.stringify(next);
        input.attempt.sessionSha = sha(input.sessionText);
        input.attempt.sessionCapturedAt = next.capturedAt;
        break;
      }
      case 'content-http':
        input.result.textResponses[1].status = 401;
        break;
      case 'article-id':
        input.result.article.id = 'WX_1234567890_101_1';
        break;
      case 'publish-time':
        input.result.article.publishTime++;
        break;
      case 'empty-body':
        input.page.articles[0].contentHtml = '';
        break;
      case 'missing-image':
        input.savedImages = [];
        break;
      case 'changed-image':
        input.savedImages = [Buffer.from('different')];
        break;
      case 'prior-stop-changed': {
        const state = JSON.parse(input.stateText);
        state.stop.reason = 'HTTP 403';
        input.stateText = JSON.stringify(state);
        break;
      }
    }
    expect(() => recordOwnerLatestOfflineVerification(input)).toThrow();
  });
});
