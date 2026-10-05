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
