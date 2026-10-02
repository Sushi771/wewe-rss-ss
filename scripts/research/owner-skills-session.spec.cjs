'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SkillsSession, MemoryJar } = require('./owner-skills-session.cjs');
const { selectBodyReviewId } = require('./probe-owner-skills-session-five.cjs');

function response(body, cookies = [], headers = {}) {
  const values = new Headers(headers);
  for (const cookie of cookies) values.append('Set-Cookie', cookie);
  return new Response(body, { status: 200, headers: values });
}

function fixture({ apiKey = true, ticket = true } = {}) {
  const calls = [];
  const answers = [
    response('<html>offline</html>', ['ptcz=page; Domain=.qq.com; Path=/']),
    response(JSON.stringify({ uid: 'offline-uid-123' }), [
      'RK=uid; Domain=.qq.com; Path=/',
    ]),
    response(
      JSON.stringify({
        succeed: true,
        webLoginVid: '123',
        accessToken: 'access',
        refreshToken: 'refresh+value',
      }),
      ['pgv_pvid=poll; Domain=.qq.com; Path=/'],
    ),
    response(JSON.stringify({ userVid: '123', name: 'owner' }), [
      'wr_pf=user; Path=/',
    ]),
    response(JSON.stringify(apiKey ? { apikey: 'PRIVATE-KEY' } : {}), [
      'skills_session=api; Path=/',
    ]),
    response(
      JSON.stringify({ succ: 1 }),
      ['renewed=yes; Path=/'],
      ticket ? { 'x-wr-ticket': 'new-ticket' } : {},
    ),
    response('{"errCode":0,"reviews":[]}', [], {}),
    response('<html>offline article</html>', [], {}),
  ];
  const session = new SkillsSession(async (url, options) => {
    calls.push({ url, options });
    assert(answers.length, 'no unplanned network request');
    return answers.shift();
  });
  return { calls, session };
}

test('one temporary jar carries all same-origin cookies through source order and list', async () => {
  const { calls, session } = fixture();
  const scanUrl = await session.begin();
  assert.match(scanUrl, /web\/confirm\?uid=offline-uid-123$/);
  assert.equal((await session.poll()).vid, '123');
  const { ticket, wrpa } = await session.verifyAndRenew('123');
  assert.equal(ticket, 'new-ticket');
  assert.equal(wrpa, undefined);
  const list = await session.listOnce(
    'https://weread.qq.com/web/mp/articles?bookId=MP_WXS_3895431412&maxIdx=0&count=5',
    ticket,
    wrpa,
  );
  assert.match(list, /reviews/);
  assert.deepEqual(
    calls.map((item) => new URL(item.url).pathname),
    [
      '/r/weread-skills',
      '/api/auth/getLoginUid',
      '/api/auth/getLoginInfo',
      '/api/userInfo',
      '/api/skills/apikeyGet',
      '/web/login/renewal',
      '/web/mp/articles',
    ],
  );
  assert.match(calls[1].options.headers.Cookie, /ptcz=page/);
  assert.match(calls[2].options.headers.Cookie, /RK=uid/);
  assert.match(calls[3].options.headers.Cookie, /pgv_pvid=poll/);
  assert.equal(calls[3].options.headers['X-Vid'], '123');
  assert.equal(calls[3].options.headers['X-Skey'], 'access');
  assert.match(calls[4].options.headers.Cookie, /wr_pf=user/);
  assert.match(calls[5].options.headers.Cookie, /skills_session=api/);
  assert.match(calls[5].options.headers.Cookie, /wr_rt=refresh%2Bvalue/);
  assert.match(calls[6].options.headers.Cookie, /renewed=yes/);
  assert.equal(calls[6].options.headers['x-wr-ticket'], 'new-ticket');
  const body = await session.bodyOnce(
    'MP_WXS_3895431412_offline_1',
    ticket,
    wrpa,
  );
  assert.match(body.toString('utf8'), /offline article/);
  assert.match(calls[7].options.headers.Cookie, /renewed=yes/);
  assert.equal(calls[7].options.headers['x-wr-ticket'], 'new-ticket');
  assert.equal(new URL(calls[7].url).pathname, '/web/mp/content');
  assert(!JSON.stringify(session.stageNames).includes('PRIVATE-KEY'));
  assert(!JSON.stringify(session.stageNames).includes('access'));
});

test('explicit body selection accepts only a new ID from this first page', () => {
  const articles = [{ reviewId: 'MP_WXS_3895431412_offline_1' }];
  assert.equal(
    selectBodyReviewId(articles, 0, []),
    'MP_WXS_3895431412_offline_1',
  );
  assert.throws(
    () => selectBodyReviewId(articles, 1, []),
    /BODY_NOT_APPROVED_FROM_FIRST_PAGE/,
  );
  assert.throws(
    () => selectBodyReviewId(articles, 0, ['MP_WXS_3895431412_offline_1']),
    /BODY_PREVIOUS_ZERO_BYTE_ID/,
  );
});

test('missing API key stops before renewal and list', async () => {
  const { calls, session } = fixture({ apiKey: false });
  await session.begin();
  await session.poll();
  await assert.rejects(session.verifyAndRenew('123'), /API_KEY_MISSING/);
  assert.equal(calls.length, 5);
});

test('missing fresh ticket stops before list', async () => {
  const { calls, session } = fixture({ ticket: false });
  await session.begin();
  await session.poll();
  await assert.rejects(session.verifyAndRenew('123'), /FRESH_TICKET_MISSING/);
  assert.equal(calls.length, 6);
});

test('owner mismatch stops before account verification requests', async () => {
  const { calls, session } = fixture();
  await session.begin();
  await session.poll();
  await assert.rejects(
    session.verifyAndRenew('999'),
    /OWNER_IDENTITY_MISMATCH/,
  );
  assert.equal(calls.length, 3);
});

test('cookie jar rejects alien domains and never exports values in names', () => {
  const jar = new MemoryJar();
  jar.merge(
    new Headers([['Set-Cookie', 'ptcz=private; Domain=.qq.com; Path=/']]),
  );
  assert.deepEqual(jar.names(), ['ptcz']);
  assert.match(
    jar.header('https://weread.qq.com/r/weread-skills'),
    /ptcz=private/,
  );
  assert.throws(
    () =>
      jar.merge(new Headers([['Set-Cookie', 'x=1; Domain=evil.test; Path=/']])),
    /SET_COOKIE_DOMAIN_INVALID/,
  );
});
