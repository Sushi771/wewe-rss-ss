const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduledUpdatesEnabled, guardModulePath } = require('./runtime.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('native canonical module checks preserve release boundaries including junctions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wewe-module-boundary-'));
  try {
    const release = path.join(root, 'release');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(release);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(release, 'safe.cjs'), '');
    fs.writeFileSync(path.join(outside, 'escape.cjs'), '');
    fs.symlinkSync(
      outside,
      path.join(release, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    guardModulePath(release, 'node:fs');
    guardModulePath(release, 'fs');
    guardModulePath(release, path.join(release, 'safe.cjs'));
    assert.throws(
      () => guardModulePath(release, path.join(release, 'linked/escape.cjs')),
      /escaped/,
    );
    assert.throws(
      () => guardModulePath(release, path.join(outside, 'escape.cjs')),
      /escaped/,
    );
    assert.throws(
      () => guardModulePath(release, path.join(release, 'missing.cjs')),
      /ENOENT/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const manifest = {
  schemaCompatibility: 'current',
  desktopHelperIncluded: false,
};
const feed = {
  id: 'MP_WXS_3895431412',
  status: 1,
  collectionChannel: 'public-album',
  publicAlbumIds: '["1234567890123456789"]',
};
const enabled = { enabled: '1', publicAlbumFeeds: [feed] };

test('explicitly enabled official-album scheduling requires no other provider key', () => {
  assert.equal(scheduledUpdatesEnabled(manifest, enabled), true);
  assert.equal(
    scheduledUpdatesEnabled(manifest, { ...enabled, enabled: undefined }),
    false,
  );
  assert.equal(
    scheduledUpdatesEnabled(manifest, { ...enabled, enabled: '0' }),
    false,
  );
});

test('missing, disabled and invalid bindings cannot enable anonymous scheduling', () => {
  assert.equal(
    scheduledUpdatesEnabled(manifest, { ...enabled, publicAlbumFeeds: [] }),
    false,
  );
  for (const change of [
    { status: 0 },
    { collectionChannel: 'unavailable' },
    { id: 'not-an-account' },
    { publicAlbumIds: 'not-json' },
    { publicAlbumIds: '[]' },
    { publicAlbumIds: '[1234567890123456789]' },
    { publicAlbumIds: '["http://example.invalid"]' },
  ])
    assert.equal(
      scheduledUpdatesEnabled(manifest, {
        ...enabled,
        publicAlbumFeeds: [{ ...feed, ...change }],
      }),
      false,
    );
});

test('legacy desktop bundles stay disabled and the existing explicit key path is retained', () => {
  assert.equal(
    scheduledUpdatesEnabled(
      { ...manifest, desktopHelperIncluded: true },
      enabled,
    ),
    false,
  );
  assert.equal(
    scheduledUpdatesEnabled(
      { ...manifest, schemaCompatibility: 'legacy-additive' },
      enabled,
    ),
    false,
  );
  assert.equal(
    scheduledUpdatesEnabled(manifest, {
      enabled: '1',
      mp2RssFeedKey: 'fixture',
      publicAlbumFeeds: [],
    }),
    true,
  );
  assert.equal(
    scheduledUpdatesEnabled(manifest, {
      enabled: '0',
      mp2RssFeedKey: 'fixture',
    }),
    false,
  );
});

test('enabled owner search scheduling uses the normal route without a relay key', () => {
  const settings = {
    enabled: '1',
    ownerSearchConfigFile: 'private-config.json',
    ownerSearchFeeds: [{ ...feed, collectionChannel: 'owner-web-search' }],
  };
  assert.equal(scheduledUpdatesEnabled(manifest, settings), true);
  assert.equal(
    scheduledUpdatesEnabled(manifest, {
      ...settings,
      ownerSearchConfigFile: undefined,
    }),
    false,
  );
  assert.equal(
    scheduledUpdatesEnabled(manifest, { ...settings, enabled: '0' }),
    false,
  );
});

const wechat2Rss = {
  enabled: '1',
  wechat2RssEnabled: '1',
  wechat2RssBaseUrl: 'http://127.0.0.1:18080/',
  wechat2RssToken: 'synthetic-only',
  wechat2RssFeeds: [{ ...feed, collectionChannel: 'wechat2rss' }],
};

test('Wechat2RSS scheduling requires explicit flags, private config and an enabled binding', () => {
  assert.equal(scheduledUpdatesEnabled(manifest, wechat2Rss), true);
  for (const change of [
    { enabled: undefined },
    { enabled: '0' },
    { wechat2RssEnabled: undefined },
    { wechat2RssEnabled: '0' },
    { wechat2RssBaseUrl: undefined },
    { wechat2RssToken: '' },
    { wechat2RssToken: 'x'.repeat(513) },
    { wechat2RssFeeds: [] },
    {
      wechat2RssFeeds: [
        { ...feed, status: 0, collectionChannel: 'wechat2rss' },
      ],
    },
    {
      wechat2RssFeeds: [
        { ...feed, id: 'invalid', collectionChannel: 'wechat2rss' },
      ],
    },
    {
      wechat2RssFeeds: [{ ...feed, collectionChannel: 'owner-weread-latest' }],
    },
    { wechat2RssFeeds: [{ ...feed, collectionChannel: 'unavailable' }] },
  ])
    assert.equal(
      scheduledUpdatesEnabled(manifest, { ...wechat2Rss, ...change }),
      false,
    );
  for (const change of [
    { schemaCompatibility: 'legacy-additive' },
    { desktopHelperIncluded: true },
  ])
    assert.equal(
      scheduledUpdatesEnabled({ ...manifest, ...change }, wechat2Rss),
      false,
    );
});

test('Wechat2RSS runtime config uses the existing private Provider URL contract', () => {
  for (const address of [
    'http://localhost:18080/',
    'http://wechat2rss/',
    'http://[::1]:18080/',
    'https://10.0.0.2/',
    'http://192.168.1.2/',
    'http://172.16.1.2/',
    'http://172.31.1.2/',
  ])
    assert.equal(
      scheduledUpdatesEnabled(manifest, {
        ...wechat2Rss,
        wechat2RssBaseUrl: address,
      }),
      true,
    );
  for (const address of [
    'invalid',
    'https://example.invalid/',
    'http://8.8.8.8/',
    'file:///private',
    'http://172.15.1.2/',
    'http://172.32.1.2/',
    'http://user:pass@localhost/',
    'http://localhost/private',
    'http://localhost/?k=synthetic',
    'http://localhost/#fragment',
  ])
    assert.equal(
      scheduledUpdatesEnabled(manifest, {
        ...wechat2Rss,
        wechat2RssBaseUrl: address,
      }),
      false,
    );
});

test('environment allowlist selects only unbound feeds and never overrides a saved source', () => {
  const unbound = { ...feed, collectionChannel: null, publicAlbumIds: null };
  const settings = { ...wechat2Rss, wechat2RssFeeds: [unbound] };
  assert.equal(scheduledUpdatesEnabled(manifest, settings), false);
  assert.equal(
    scheduledUpdatesEnabled(manifest, {
      ...settings,
      wechat2RssFeedIds: `invalid, ${feed.id}`,
    }),
    true,
  );
  for (const publicAlbumIds of [feed.publicAlbumIds, 'invalid'])
    assert.equal(
      scheduledUpdatesEnabled(manifest, {
        ...settings,
        wechat2RssFeedIds: feed.id,
        wechat2RssFeeds: [{ ...unbound, publicAlbumIds }],
      }),
      false,
    );
  for (const collectionChannel of [
    'public-album',
    'owner-web-search',
    'unavailable',
  ])
    assert.equal(
      scheduledUpdatesEnabled(manifest, {
        ...settings,
        wechat2RssFeedIds: feed.id,
        wechat2RssFeeds: [{ ...unbound, collectionChannel }],
      }),
      false,
    );
});

test('invalid Wechat2RSS settings do not suppress a separately enabled native source', () => {
  assert.equal(
    scheduledUpdatesEnabled(manifest, {
      ...wechat2Rss,
      wechat2RssEnabled: '0',
      publicAlbumFeeds: [feed],
    }),
    true,
  );
});
