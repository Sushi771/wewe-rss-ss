'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { requestUrl, metadata } = require('./probe-native-review-owner07.cjs');
const id = 'MP_WXS_3895431412_test';
test('native review shape uses only the actual resolved reviewId', () => {
  const url = requestUrl(id);
  assert.equal(url.origin, 'https://i.weread.qq.com');
  assert.equal(url.pathname, '/review/single');
  assert.deepEqual([...url.searchParams.entries()], [['reviewId', id]]);
  assert.throws(() => requestUrl('OTHER_MP_test'));
});
test('native metadata preserves distinct book identities and never verifies publication or body', () => {
  const r = metadata(
    {
      reviewId: id,
      review: {
        type: 16,
        bookId: 'mpbook',
        belongBookId: 'MP_WXS_3895431412',
        mpInfo: {
          inner: false,
          title: 'sample',
          time: 1,
          doc_url: 'https://mp.weixin.qq.com/s/example',
        },
      },
    },
    id,
  );
  assert.equal(r.bookId, 'mpbook');
  assert.equal(r.belongBookId, 'MP_WXS_3895431412');
  assert.equal(r.inner, false);
  assert.equal(r.publicationVerified, false);
  assert.equal(r.bodyVerified, false);
  assert.throws(() =>
    metadata({ reviewId: 'different', review: { mpInfo: {} } }, id),
  );
  assert.throws(() => metadata({ errCode: -2041 }, id));
});
test('actual numeric inner flag selects a route only for 0 or 1', () => {
  const make = (inner) =>
    metadata({ reviewId: id, review: { type: 16, mpInfo: { inner } } }, id);
  assert.equal(make(0).inner, false);
  assert.equal(make(1).inner, true);
  assert.equal(make(2).inner, null);
  assert.equal(make(undefined).inner, null);
});
