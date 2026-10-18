'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const {
  replayDirectoryFixture,
} = require('./replay-weread-directory-copy.cjs');
const server = path.resolve(__dirname, '../../apps/server');
const local = createRequire(path.join(server, 'package.json'));
const { prepareWereadDirectoryReplay } = require(
  path.join(server, 'dist/apps/server/src/collection/weread-directory'),
);

function replay() {
  const mpId = 'MP_WXS_3895431412';
  const name = 'Synthetic feed';
  const originalId = 'a'.repeat(22);
  const reviewId = `${mpId}_${originalId}`;
  const html = `<meta property="og:url" content="https://mp.weixin.qq.com/s/${originalId}"><h1 id="activity-name">Synthetic article</h1><span id="js_name">${name}</span><div id="js_content"><p>Synthetic body</p></div><script>var biz="${Buffer.from('3895431412').toString('base64')}";var mid="1";var idx="1";var sn="abcd";var ct=1700000099;</script>`;
  const page = {
    reviews: [
      {
        createTime: 1790000000,
        subCount: 1,
        subReviews: [
          {
            reviewId,
            review: {
              reviewId,
              type: 16,
              bookId: '',
              belongBookId: mpId,
              mpInfo: {
                originalId,
                title: 'Synthetic article',
                mp_name: name,
                time: 1700000099,
              },
            },
          },
        ],
      },
    ],
  };
  return {
    mpId,
    value: prepareWereadDirectoryReplay(
      [page],
      { mpId, name },
      [
        {
          reviewId,
          html,
          sha256: crypto.createHash('sha256').update(html).digest('hex'),
          capturedAt: '2026-10-04T00:00:00Z',
          images: [],
        },
      ],
      1,
    ),
  };
}

function fixture(t) {
  const root = fs.mkdtempSync(
    path.join(fs.realpathSync.native(os.tmpdir()), 'wewe-directory-test-'),
  );
  const old = process.env.WEWE_TEST_OUTPUT_ROOT;
  process.env.WEWE_TEST_OUTPUT_ROOT = root;
  t.after(() => {
    if (old === undefined) delete process.env.WEWE_TEST_OUTPUT_ROOT;
    else process.env.WEWE_TEST_OUTPUT_ROOT = old;
    assert.equal(path.dirname(root), fs.realpathSync.native(os.tmpdir()));
    assert(path.basename(root).startsWith('wewe-directory-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function audit(root) {
  return path.join(
    root,
    fs.readdirSync(root).find((name) => name.startsWith('run-')),
  );
}

test('directory replay writes and deduplicates only synthetic data, then reclaims databases and retains the report', async (t) => {
  const root = fixture(t),
    sample = replay();
  const result = await replayDirectoryFixture(sample.mpId, sample.value);
  assert.equal(result.syntheticDatabase, true);
  assert.equal(result.first.created, 1);
  assert.equal(result.second.created, 0);
  assert.equal(result.networkRequests, 0);
  assert.equal(result.oldRowsUnchanged, true);
  const summary = JSON.parse(
    fs.readFileSync(path.join(result.audit, 'space-summary.json')),
  );
  assert.equal(summary.usage.databases, 0);
  assert.equal(summary.retained, false);
  assert(!fs.existsSync(path.join(root, '.test-run.lock')));
  assert(fs.existsSync(path.join(result.audit, 'result.json')));
});

test('directory replay failure after fixture creation cleans only this run and restores environment/network functions', async (t) => {
  const root = fixture(t),
    sample = replay(),
    originalFetch = global.fetch,
    originalDatabase = process.env.DATABASE_URL;
  const unrelated = path.join(root, 'unapproved.txt');
  fs.writeFileSync(unrelated, 'preserve');
  sample.value.discovery = 'invalid';
  await assert.rejects(
    replayDirectoryFixture(sample.mpId, sample.value),
    /WEREAD_REPLAY_PROVENANCE_INVALID/,
  );
  const summary = JSON.parse(
    fs.readFileSync(path.join(audit(root), 'space-summary.json')),
  );
  assert.equal(summary.usage.databases, 0);
  assert.equal(summary.retained, false);
  assert(!fs.existsSync(path.join(root, '.test-run.lock')));
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'preserve');
  assert.equal(global.fetch, originalFetch);
  assert.equal(process.env.DATABASE_URL, originalDatabase);
});

test('unconfirmed disconnect preserves the owned database and lease for review', async (t) => {
  const root = fixture(t),
    sample = replay();
  const module = local('@prisma/client'),
    Original = module.PrismaClient;
  module.PrismaClient = class extends Original {
    async $disconnect() {
      await super.$disconnect();
      throw Error('INJECTED_DISCONNECT_UNCONFIRMED');
    }
  };
  try {
    await assert.rejects(
      replayDirectoryFixture(sample.mpId, sample.value),
      /INJECTED_DISCONNECT_UNCONFIRMED/,
    );
    assert(fs.existsSync(path.join(audit(root), 'copy.db')));
    assert(fs.existsSync(path.join(root, '.test-run.lock')));
    assert(!fs.existsSync(path.join(audit(root), 'space-summary.json')));
  } finally {
    module.PrismaClient = Original;
  }
});
