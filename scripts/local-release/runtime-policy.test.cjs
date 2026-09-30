const test = require('node:test');
const assert = require('node:assert/strict');
const { scheduledUpdatesEnabled } = require('./runtime.cjs');

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
