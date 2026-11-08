const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const seams = require('./fixtures/legacy-writer-seams.json');
const installed = require('./fixtures/installed-writer-compat.json');
const sha = (source) =>
  crypto.createHash('sha256').update(source).digest('hex');
function restoreCompatible(file, source) {
  const reviewed = installed[file];
  if (!reviewed) return source;
  if (sha(source) === reviewed.beforeSha256) return source;
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
