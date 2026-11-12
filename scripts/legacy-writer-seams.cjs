const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const seams = require('./fixtures/legacy-writer-seams.json');
const installed = require('./fixtures/installed-writer-compat.json');
const runtimeFamilies = require('./fixtures/runtime-family-compat.json');
const priorBootRestarts = require('./fixtures/prior-boot-restart-compat.json');
const sha = (source) =>
  crypto.createHash('sha256').update(source).digest('hex');
// Test-only inverse of the exact error-retention delta. No admission, family,
// reference or historical source pin is relaxed by this comparison layer.
function restoreLifecycleErrors(file, source) {
  const reviewed = require('./fixtures/lifecycle-error-chain-compat.json')[
    file
  ];
  if (!reviewed || sha(source) === reviewed.beforeSha256) return source;
  assert.equal(
    sha(source),
    reviewed.afterSha256,
    'exact reviewed lifecycle error-chain source: ' + file,
  );
  for (const hunk of reviewed.hunks) {
    assert.equal(
      source.split(hunk.after).length,
      2,
      'exact reviewed lifecycle error-chain hunk: ' + file,
    );
    source = source.replace(hunk.after, hunk.before);
  }
  assert.equal(
    sha(source),
    reviewed.beforeSha256,
    'unchanged pre-error-chain source: ' + file,
  );
  return source;
}
function restoreCompatible(file, source) {
  const reviewed = installed[file];
  if (!reviewed) return source;
  if (sha(source) === reviewed.beforeSha256) return source;
  const family = runtimeFamilies[file];
  const priorBoot = priorBootRestarts[file];
  if (priorBoot && sha(source) !== reviewed.afterSha256) {
    assert.equal(priorBoot.beforeSha256, family.afterSha256);
    source = restorePriorBootRestart(file, source);
  }
  if (family && sha(source) !== reviewed.afterSha256) {
    // Invert only the reviewed 52a34b1 installer-family delta. Both complete
    // sources stay pinned; all earlier compatibility and admission pins remain.
    assert.equal(family.beforeSha256, reviewed.afterSha256);
    assert.equal(
      sha(source),
      family.afterSha256,
      'exact candidate legacy writer seam: reviewed runtime family source',
    );
    for (const hunk of family.hunks) {
      assert.equal(
        source.split(hunk.after).length,
        2,
        'exact candidate legacy writer seam: runtime family hunk',
      );
      source = source.replace(hunk.after, hunk.before);
    }
    assert.equal(
      sha(source),
      family.beforeSha256,
      'exact candidate legacy writer seam: unchanged pre-family source',
    );
  }
  if (
    file === 'scripts/local-release/runtime.cjs' &&
    sha(source) !== reviewed.afterSha256
  ) {
    // f61a39d removed only the retired Mp2RSS scheduler input/shortcut.
    // Reconstruct them solely for comparison with the historical writer pin.
    for (const [after, before] of [
      [
        "  if (settings.wechat2RssEnabled === '1' && validWechat2RssConfig(settings)) {",
        "  if (settings.mp2RssFeedKey?.trim()) return true;\n  if (settings.wechat2RssEnabled === '1' && validWechat2RssConfig(settings)) {",
      ],
      [
        '      enabled: process.env.ENABLE_SCHEDULED_UPDATES,\n      publicAlbumFeeds,',
        '      enabled: process.env.ENABLE_SCHEDULED_UPDATES,\n      mp2RssFeedKey: process.env.MP2RSS_FEED_KEY,\n      publicAlbumFeeds,',
      ],
    ]) {
      assert.equal(
        source.split(after).length,
        2,
        'exact candidate legacy writer seam: retired Mp2RSS input',
      );
      source = source.replace(after, before);
    }
  }
  // 434b964: Prisma's lazy query must be awaited inside the async-local
  // startup control. Undo only those two exact callbacks, then enforce the
  // unchanged whole-source compatibility hash below.
  if (
    file === 'apps/server/src/prisma/prisma.service.ts' &&
    sha(source) !== reviewed.afterSha256
  ) {
    for (const mode of ['ON', 'OFF']) {
      const after = `this.updateModeControl.run(true, async () => {\n${mode === 'ON' ? '        ' : '            '}await this.$executeRawUnsafe('PRAGMA query_only=${mode}');\n${mode === 'ON' ? '      ' : '          '}})`;
      const before = `this.updateModeControl.run(true, () =>\n${mode === 'ON' ? '        ' : '            '}this.$executeRawUnsafe('PRAGMA query_only=${mode}'),\n${mode === 'ON' ? '      ' : '          '})`;
      assert.equal(
        source.split(after).length,
        2,
        'exact candidate legacy writer seam: async startup control',
      );
      source = source.replace(after, before);
    }
  }
  assert.equal(
    sha(source),
    reviewed.afterSha256,
    'exact candidate legacy writer seam: reviewed installed compatibility source',
  );
  for (const hunk of reviewed.hunks) {
    assert.equal(
      source.split(hunk.after).length,
      2,
      'exact candidate legacy writer seam: installed compatibility hunk',
    );
    source = source.replace(hunk.after, hunk.before);
  }
  assert.equal(
    sha(source),
    reviewed.beforeSha256,
    'exact candidate legacy writer seam: restored precursor',
  );
  return source;
}
function restorePriorBootRestart(file, source) {
  const reviewed = priorBootRestarts[file];
  if (!reviewed || sha(source) === reviewed.beforeSha256) return source;
  // Invert only the approved prior-boot branch before the unchanged historical
  // family/installed/writer layers. Never repin an old artifact to new source.
  assert.equal(
    sha(source),
    reviewed.afterSha256,
    'exact candidate legacy writer seam: reviewed prior-boot source',
  );
  for (const hunk of reviewed.hunks) {
    assert.equal(
      source.split(hunk.after).length,
      2,
      'exact candidate legacy writer seam: prior-boot hunk',
    );
    source = source.replace(hunk.after, hunk.before);
  }
  assert.equal(
    sha(source),
    reviewed.beforeSha256,
    'exact candidate legacy writer seam: unchanged pre-boot source',
  );
  return source;
}
// Only the separately reviewed local-only adapter delta is invertible. Every
// earlier integration/writer hash still applies to the reconstructed source.
function restoreLocalCacheOnly(file, source) {
  const reviewed = require('./fixtures/local-cache-only-compat.json')[file];
  if (!reviewed) return source;
  assert.equal(
    sha(source),
    reviewed.afterSha256,
    'exact reviewed local-cache-only source: ' + file,
  );
  for (const hunk of reviewed.hunks) {
    assert.equal(
      source.split(hunk.after).length,
      2,
      'exact reviewed local-cache-only hunk: ' + file,
    );
    source = source.replace(hunk.after, hunk.before);
  }
  assert.equal(
    sha(source),
    reviewed.beforeSha256,
    'unchanged pre-local-cache-only source: ' + file,
  );
  return source;
}
function restoreCollectionIntegration(file, source) {
  const reviewed = require('./fixtures/collection-integration-compat.json')[
    file
  ];
  if (!reviewed) return source;
  assert.equal(
    sha(source),
    reviewed.afterSha256,
    'exact reviewed collection integration source: ' + file,
  );
  for (const hunk of reviewed.hunks) {
    assert.equal(
      source.split(hunk.after).length,
      2,
      'exact reviewed collection integration hunk: ' + file,
    );
    source = source.replace(hunk.after, hunk.before);
  }
  assert.equal(
    sha(source),
    reviewed.originalSha256,
    'unchanged historical collection source pin: ' + file,
  );
  return source;
}
module.exports = function restoreLegacyWriter(file, source) {
  const errorChain = require('./fixtures/lifecycle-error-chain-compat.json')[
    file
  ];
  if (errorChain && sha(source) === errorChain.afterSha256)
    source = restoreLifecycleErrors(file, source);
  if (file === 'apps/server/src/collection/sqlite-write-coordinator.ts') {
    // Invert only the reviewed metadata-only exclusion method. The complete
    // pre-existing coordinator source must still match its historical pin.
    const added = `

  /** Exact control-metadata review: exclusion without a full-snapshot contract.
   * The caller must use incrementalWrite + a durable SQLite transaction and
   * preserve original values in its audit. This does not authorize source work. */
  async knownAuthMetadataWrite<T>(operation: () => Promise<T>): Promise<T> {
    if (
      this.context.getStore()?.active ||
      this.protectedContext.getStore()?.active
    )
      throw new Error('Nested metadata SQLite operation refused');
    const release = await this.acquire('backup');
    const permit = { active: true };
    try {
      return await this.protectedContext.run(permit, operation);
    } finally {
      permit.active = false;
      release();
    }
  }`;
    assert.equal(
      source.split(added).length,
      2,
      'exact known-auth metadata exclusion method',
    );
    source = source.replace(added, '');
  }
  source = restoreLocalCacheOnly(file, source);
  source = restoreCollectionIntegration(file, source);
  source = restoreCompatible(file, source);
  for (const seam of seams[file] || []) {
    assert.equal(
      source.split(seam.after).length,
      2,
      'exact candidate legacy writer seam',
    );
    source = source.replace(seam.after, seam.before);
  }
  const transaction = require('./fixtures/prisma-transaction-compat.json');
  if (file === transaction.file) {
    assert.equal(
      sha(source),
      transaction.afterSha256,
      'exact transaction-aware admission version',
    );
    assert.equal(
      source.split(transaction.after).length,
      2,
      'exact transaction-aware admission seam',
    );
    source = source.replace(transaction.after, transaction.before);
    assert.equal(
      sha(source),
      transaction.originalSha256,
      'unchanged original recovery pin',
    );
  }
  return source;
};
module.exports.restoreCompatible = restoreCompatible;
module.exports.restorePriorBootRestart = restorePriorBootRestart;

module.exports.restoreLocalCacheOnly = restoreLocalCacheOnly;
module.exports.restoreLifecycleErrors = restoreLifecycleErrors;
