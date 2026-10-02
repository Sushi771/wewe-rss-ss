'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  BOOK_ID,
  LIST_URL,
  firstFive,
  firstPageOnce,
  fetchOneBodyOnce,
} = require('./probe-owner-native-web-five.cjs');

const article = (n) => ({
  reviewId: `${BOOK_ID}_synthetic_${n}`,
  review: {
    reviewId: `${BOOK_ID}_synthetic_${n}`,
    bookId: BOOK_ID,
    mpInfo: {
      mp_name: '妈妈部落畅聊阁',
      title: `离线标题 ${n}`,
      time: 1790000000 + n,
    },
  },
});

test('projects five distinct source-backed identities and rejects upstream refusal', () => {
  const data = {
    errCode: 0,
    bookId: BOOK_ID,
    reviews: [
      { subReviews: [article(1), article(2), article(2)] },
      { subReviews: [article(3), article(4), article(5)] },
    ],
  };
  assert.deepEqual(
    firstFive(data).map((item) => item.reviewId),
    [1, 2, 3, 4, 5].map((n) => `${BOOK_ID}_synthetic_${n}`),
  );
  assert.throws(
    () => firstFive({ ...data, errCode: -2041 }),
    /LIST_VERIFICATION_REQUIRED/,
  );
  assert.throws(
    () =>
      firstFive({
        ...data,
        reviews: [
          {
            subReviews: [
              {
                ...article(1),
                review: {
                  ...article(1).review,
                  mpInfo: {
                    ...article(1).review.mpInfo,
                    mp_name: '别的公众号',
                  },
                },
              },
            ],
          },
        ],
      }),
    /LIST_ARTICLE_IDENTITY_MISMATCH/,
  );
});

test('one list GET uses fixed five-item query and fresh ticket, writes only private result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-web-five-offline-'));
  try {
    let requests = 0;
    const answer = await firstPageOnce({
      runDir: dir,
      session: {},
      ownerVid: '123',
      ticket: 'new-ticket',
      wrpa: 'new-wrpa',
      ownerSessionCookie: () => 'wr_vid=123; wr_skey=private',
      fetchImpl: async (url, options) => {
        requests++;
        assert.equal(url, LIST_URL);
        assert.equal(options.method, 'GET');
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers['x-wr-ticket'], 'new-ticket');
        assert.equal(options.headers['x-wrpa-0'], 'new-wrpa');
        assert(fs.existsSync(path.join(dir, 'list-attempt.json')));
        return new Response(
          JSON.stringify({
            errCode: 0,
            bookId: BOOK_ID,
            reviews: [
              article(1),
              article(2),
              article(3),
              article(4),
              article(5),
            ],
          }),
          { status: 200 },
        );
      },
    });
    assert.equal(requests, 1);
    assert.equal(answer.result.articleCount, 5);
    assert.equal(answer.result.subscriptionRestored, false);
    assert(fs.existsSync(path.join(dir, 'list-response.bin')));
    const publicResult = fs.readFileSync(path.join(dir, 'result.json'), 'utf8');
    assert(!publicResult.includes('new-ticket'));
    assert(!publicResult.includes('离线标题'));
    await assert.rejects(
      firstPageOnce({
        runDir: dir,
        session: {},
        ownerVid: '123',
        ticket: 'new-ticket',
        wrpa: 'new-wrpa',
        ownerSessionCookie: () => 'wr_vid=123',
        fetchImpl: async () => {
          requests++;
          throw Error('should not call');
        },
      }),
    );
    assert.equal(requests, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('owner cookie failure prevents list network and marker', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-web-five-offline-'));
  try {
    let requests = 0;
    await assert.rejects(
      firstPageOnce({
        runDir: dir,
        session: {},
        ownerVid: '123',
        ticket: '',
        wrpa: 'new-wrpa',
        ownerSessionCookie: () => {
          throw Error('OWNER_COOKIE_INVALID');
        },
        fetchImpl: async () => {
          requests++;
          throw Error('should not call');
        },
      }),
      /OWNER_COOKIE_INVALID/,
    );
    assert.equal(requests, 0);
    assert(!fs.existsSync(path.join(dir, 'list-attempt.json')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('successful renewal without ticket uses renewed cookie for one five-item list GET', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-web-five-offline-'));
  try {
    let requests = 0;
    const renewedSession = { freshRenewal: true };
    const input = {
      runDir: dir,
      session: renewedSession,
      ownerVid: '123',
      ticket: undefined,
      wrpa: undefined,
      ownerSessionCookie: (session, ownerVid) => {
        assert.equal(session, renewedSession);
        assert.equal(ownerVid, '123');
        return 'wr_vid=123; wr_skey=renewed';
      },
    };
    const answer = await firstPageOnce({
      ...input,
      fetchImpl: async (url, options) => {
        requests++;
        assert.equal(url, LIST_URL);
        assert.equal(options.method, 'GET');
        assert.equal(options.headers.Cookie, 'wr_vid=123; wr_skey=renewed');
        assert(!Object.hasOwn(options.headers, 'x-wr-ticket'));
        assert(!Object.hasOwn(options.headers, 'x-wrpa-0'));
        assert(fs.existsSync(path.join(dir, 'list-attempt.json')));
        return new Response(
          JSON.stringify({
            errCode: 0,
            bookId: BOOK_ID,
            reviews: [article(1)],
          }),
          { status: 200 },
        );
      },
    });
    assert.equal(requests, 1);
    assert.equal(answer.result.articleCount, 1);
    assert.equal(answer.result.subscriptionRestored, false);
    await assert.rejects(
      firstPageOnce({
        ...input,
        fetchImpl: async () => {
          requests++;
          throw Error('should not call');
        },
      }),
    );
    assert.equal(requests, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a fresh ticket without optional wrpa still performs one fixed list request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-web-five-offline-'));
  try {
    let requests = 0;
    const answer = await firstPageOnce({
      runDir: dir,
      session: {},
      ownerVid: '123',
      ticket: 'fresh-ticket',
      wrpa: undefined,
      ownerSessionCookie: () => 'wr_vid=123',
      fetchImpl: async (url, options) => {
        requests++;
        assert.equal(url, LIST_URL);
        assert.equal(options.headers['x-wr-ticket'], 'fresh-ticket');
        assert(!Object.hasOwn(options.headers, 'x-wrpa-0'));
        return new Response(
          JSON.stringify({
            errCode: 0,
            bookId: BOOK_ID,
            reviews: [article(1)],
          }),
          { status: 200 },
        );
      },
    });
    assert.equal(requests, 1);
    assert.equal(answer.result.articleCount, 1);
    assert.equal(answer.result.state, 'partial_first_page');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ticketless body allows only a listed review ID and its private marker prevents a second GET', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-web-body-offline-'));
  const realMarker = path.join(
    path.resolve(__dirname, '../..'),
    'private-data',
    'owner-native-web-five-optional-ticket-body-attempt.json',
  );
  const isolatedMarker = path.join(dir, 'body-attempt-marker.json');
  const originalOpenSync = fs.openSync.bind(fs);
  const originalExistsSync = fs.existsSync.bind(fs);
  const realMarkerAlreadyExisted = originalExistsSync(realMarker);
  t.mock.method(fs, 'openSync', (file, flags, mode) =>
    originalOpenSync(file === realMarker ? isolatedMarker : file, flags, mode),
  );
  try {
    let requests = 0;
    const listedReviewId = `${BOOK_ID}_synthetic_listed`;
    const input = {
      runDir: dir,
      session: { freshRenewal: true },
      ownerVid: '123',
      ticket: undefined,
      wrpa: undefined,
      allowedReviewIds: [listedReviewId],
      ownerSessionCookie: () => 'wr_vid=123; wr_skey=renewed',
      fetchImpl: async (url, options) => {
        requests++;
        assert.equal(
          url,
          `https://weread.qq.com/web/mp/content?reviewId=${encodeURIComponent(listedReviewId)}`,
        );
        assert.equal(options.method, 'GET');
        assert.equal(options.headers.Cookie, 'wr_vid=123; wr_skey=renewed');
        assert(!Object.hasOwn(options.headers, 'x-wr-ticket'));
        assert(!Object.hasOwn(options.headers, 'x-wrpa-0'));
        assert(originalExistsSync(isolatedMarker));
        return new Response('<html>offline body</html>', { status: 200 });
      },
    };
    await assert.rejects(
      fetchOneBodyOnce({
        ...input,
        reviewId: `${BOOK_ID}_synthetic_unlisted`,
      }),
      /BODY_NOT_APPROVED_FROM_FIRST_PAGE/,
    );
    assert.equal(requests, 0);
    assert(!originalExistsSync(isolatedMarker));
    const answer = await fetchOneBodyOnce({
      ...input,
      reviewId: listedReviewId,
    });
    assert.equal(answer.httpStatus, 200);
    assert.equal(requests, 1);
    assert(originalExistsSync(isolatedMarker));
    await assert.rejects(
      fetchOneBodyOnce({
        ...input,
        reviewId: listedReviewId,
      }),
      /EEXIST/,
    );
    assert.equal(requests, 1);
    assert.equal(originalExistsSync(realMarker), realMarkerAlreadyExisted);
  } finally {
    t.mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
