'use strict';
// Pure admission only. Physical package/HEAD verification remains the caller's job.
const assert = require('node:assert/strict');
const hex = (v, n) =>
  typeof v === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(v);
const migrationPattern =
  /^server\/prisma\/migrations\/([A-Za-z0-9_-]+)\/migration\.sql$/;
function migrationFiles(manifest) {
  const result = {};
  for (const [name, digest] of Object.entries(manifest.files || {})) {
    const match = name.match(migrationPattern);
    if (!match) continue;
    assert(hex(digest, 64), 'RELEASE_MIGRATION_HASH_INVALID');
    result[match[1]] = digest;
  }
  assert(Object.keys(result).length > 0, 'RELEASE_MIGRATIONS_UNPROVEN');
  return Object.fromEntries(
    Object.entries(result).sort(([a], [b]) => a.localeCompare(b)),
  );
}
function migrationContract(manifest) {
  assert(
    hex(manifest.files?.['server/prisma/schema.prisma'], 64),
    'RELEASE_SCHEMA_UNPROVEN',
  );
  return {
    format: 1,
    sourceCommit: manifest.sourceCommit,
    schemaSha256: manifest.files['server/prisma/schema.prisma'],
    migrations: migrationFiles(manifest),
  };
}
const LEGACY_SHA =
  'c909a33631c9492d61b9e99e4fd68452a0358ebab3b486a1b685cc36a2460260';
const ADDED_MIGRATIONS = Object.freeze({
  '20261013000000_article_failure_events':
    '7312d22e561599fc5bdd760e5182ac8564d70a24dfb08010e129ff859f978e7c',
  '20261014000000_wechat2rss_source_gate':
    'd2f7dda0d5a9e96e8628253876abaa448f26ac5c4dee379566905e1f22b384f5',
  '20261104000000_article_failure_missing':
    '68638bf3291a0f7414910773cf33351123e40edf5e1692dbbf40fb19b0a1a279',
  '20261105000000_xhs_refresh_ledger':
    '579fd5c5d2ce4e871522fde1eb5e839dbdc2f088b8be9196a4b264b20590899d',
  '20261106000000_xhs_refresh_batches':
    '2d294c2f053537baf4676337747c062a2756f81e2b423139ca0d5f91e60491fe',
  '20261107000000_unified_bigint_timestamps':
    'a053cd7b65e603cd82a7c8c464235056e02fa3a0da46b2e4fb5827509af4ca1c',
});
// Exact observed minimal history input SHA: 541e6e3ad63ec99c722077fdfde542f63a95cdf639bcc74ced0235ff6e7e27d3
const OBSERVED_RECEIPTS = Object.freeze({
  '20240301104100_init':
    'be7026539cc52f80e7c91cd4d1cb6223ec14e9e7a6574f37d86db214f2ecf6c3',
  '20241214172323_has_history':
    'f01a784da586c72fb5c12210d99fc9a6b3b2ce6cb574e461e72149cfdf03ba20',
  '20260319021733_make_feed_optional':
    'db8791767880fd58c7060c694b168c809c82ceac4314bdb738db942ab6b18289',
  '20260319022805_add_cascade_delete':
    '53f770335c1103e5adcccba4858d524a013bba05e42817e12dcbd4633bac76da',
  '20260324094912_add_feed_order':
    '5044d45aa419bb683e2939f4d30e38e0de567dc304aaca7584f437b4e6e04fd4',
  '20260927050000_public_albums':
    '58b86e162f0b8ce2e51cc33f1a9ab9ce5525a24ca43b517b4a11fbd67ac957e0',
  '20260927080000_local_collection':
    '68c67021888fc6f8cf8df0eeee3d10b74f0b90f1bd6f7b0908ed552302dc6d56',
  '20260927090000_collection_result':
    'db9a1634af33359d3e244315cf116fd561b13b6df7e6d5fd6c036459634dbfc2',
  '20260927110000_collection_channel':
    '5473dff2cce9b4754d03c621faff055f1fabd4b16d23be81e9b0933670f59ace',
  '20260928020000_article_body_status':
    '123c2016418170136d954fc1ea8b4072977246010d0e4addaa23b27102458cc4',
  '20260928030000_article_body_retry':
    '5a70a5bbc898687af7389ab5c6a96aa409d17708c35f732cb98f6045d8b44f09',
  '20260929010000_provider_refresh_cooldown':
    '90fe98dc071013060e79f1f8569db94cf8af01f15cca661c6f9ab2c0191a7375',
  '20261009050000_add_xhs_local_archive':
    'f26dacc05b89f5b0a11be9e07eca0837e060f4ff04334f489c27949c18f2aa0b',
  '20261009063000_add_management_groups':
    '167252009b483f8837d167b82d0e4da8e9f99ceee07f66a37b1faff910483356',
  '20261009080000_add_xhs_video_cache':
    '29f1e7bcbaae2e8b139446aae3f97b4c650025a3611bdcbefbabe3c3e58de0cb',
  '20261010090000_management_group_order':
    '67ba2343c1cf6fb095ee602bf91937ff05bc3a2b8952bf9dd5028a65cf49f930',
  '20261011090000_cache_insert_batches':
    '2d328d3a3e280895df6c70cf5e93f31f707bb4aad62ceaa934eea1a1b9611288',
  '20261012043000_article_feed_lookup_index':
    '34a8db9765ef0996262629ebcff6fd0568fb92b14940a777c2fcb499c79a9ac5',
  '20261015090000_incremental_refresh_commits':
    'ae82e523742198486c7d4026274c251607901ac48ed9ec83e41287b699c450e4',
  '20261020100000_article_global_sort_index':
    'ab37c8bae12abfadb6f314f663ae35c02b093585c9289fe2f59215f0f14e83c8',
  '20261020160000_local_body_search':
    'ff72e5e104374f9ce6b45ef8a9b0320a8bc310a26a447a33f2e4636cf2c36fad',
  '20261024000000_xhs_subscription_tasks':
    'de435a4ce34d09daa578f65ae316677587c584f8a517414f95b4e13622b95304',
  '20261025090000_xhs_engagement':
    '62973c4ab21c11db6ff52caca630f32203c84c0b1f0e977d302fd453d3f0f461',
  '20261025120000_xhs_request_budget':
    '26a6dae2176fdfaf491b4b2c3803b145286c077e62d162260021f120e3539333',
  '20261027100000_xhs_source_risk':
    '88325ebb2730fc64a7e0689b2e1c92e1ed0f8b7dcd03586c56e46968bbcb01a2',
  '20261027120000_xhs_limited_recovery':
    '68ff5096d7a479b709763dcdd80e1ddf451df20e71dd94f506cbda77d85fa4b0',
  '20261027130000_xhs_limited_append':
    '83214122e6d41d2130e18aa7a0f081abae9620918fdd0c9d60f0b156b116fdd7',
});
function assertReceiptChecksum(name, bytes, receiptSha256) {
  const sha = (b) =>
    require('node:crypto').createHash('sha256').update(b).digest('hex');
  const expected = OBSERVED_RECEIPTS[name] ?? sha(bytes);
  assert.equal(
    receiptSha256,
    expected,
    'RELEASE_FIXED_RECEIPT_CHECKSUM_CHANGED',
  );
  if (Object.hasOwn(OBSERVED_RECEIPTS, name)) {
    const lf = new TextDecoder('utf-8', { fatal: true })
      .decode(bytes)
      .replace(/\r\n/g, '\n');
    const variants = [
      sha(bytes),
      sha(Buffer.from(lf, 'utf8')),
      sha(Buffer.from(lf.replace(/\n/g, '\r\n'), 'utf8')),
    ];
    assert(
      variants.includes(expected),
      'RELEASE_OBSERVED_RECEIPT_NOT_EXACT_NEWLINE_VARIANT',
    );
  }
  return true;
}
function validateRoles(roles) {
  // These are the existing install-lifecycle role names; aliases are permitted
  // only when their complete manifest pin agrees, just as in installPair.
  const seen = new Map();
  for (const name of ['current', 'candidate', 'rollback']) {
    const role = roles?.[name],
      m = role?.manifest;
    assert(
      m?.format === 1 &&
        m.schemaCompatibility === 'current' &&
        /^[A-Za-z0-9][A-Za-z0-9T.Z-]{0,159}$/.test(m.id || '') &&
        hex(m.sourceCommit, 40) &&
        hex(m.sourceHash, 64) &&
        hex(role.manifestSha256, 64) &&
        hex(m.files?.['runtime/node.exe'], 64),
      'RELEASE_ROLE_PROOF_INVALID',
    );
    assert(
      typeof m.desktopHelperIncluded === 'boolean',
      'RELEASE_HELPER_CONTRACT_INVALID',
    );
    const helper = [
      ...Object.keys(m.files),
      ...Object.keys(m.links || {}),
    ].some(
      (p) =>
        p === 'tools/wechat-desktop-collector' ||
        p.startsWith('tools/wechat-desktop-collector/'),
    );
    assert(
      helper === m.desktopHelperIncluded &&
        (!helper ||
          hex(m.files['tools/wechat-desktop-collector/collect.ps1'], 64)),
      'RELEASE_HELPER_CONTRACT_INVALID',
    );
    const exactLegacy =
      (name === 'current' || name === 'rollback') &&
      role.manifestSha256 === LEGACY_SHA &&
      m.id === '8ce1497-20261103-a' &&
      m.prisma?.clientVersion === '5.10.1' &&
      m.prisma?.cliVersion === '5.22.0' &&
      m.prisma?.engineSha256 ===
        'b83fc09260071e545b1a036a13e10f291428efefd351fb4197fa5c716bc02014' &&
      m.prisma?.engineCommit === '5a9203d0590c951969e85a7d07215503f4672eb9';
    // This exception is baseline-only. bindRoles still verifies physical manifest bytes.
    assert(
      exactLegacy ||
        (m.prisma?.clientVersion === m.prisma?.cliVersion &&
          /^\d+\.\d+\.\d+$/.test(m.prisma?.clientVersion || '') &&
          hex(m.prisma?.engineSha256, 64)),
      'RELEASE_PRISMA_VERSION_CONTRACT_INVALID',
    );
    const previous = seen.get(m.id);
    assert(
      !previous || previous === role.manifestSha256,
      'RELEASE_ROLE_ID_COLLISION',
    );
    seen.set(m.id, role.manifestSha256);
    const contract = migrationContract(m);
    if (m.migrationContract)
      assert.deepEqual(
        m.migrationContract,
        contract,
        'RELEASE_MIGRATION_CONTRACT_CHANGED',
      );
  }
  const current = migrationContract(roles.current.manifest);
  const rollback = migrationContract(roles.rollback.manifest);
  // A snapshot of the pre-update DB is only admitted to an exact same-schema
  // rollback. Additive compatibility requires its own reviewed proof, not a flag.
  assert.deepEqual(
    { schemaSha256: rollback.schemaSha256, migrations: rollback.migrations },
    { schemaSha256: current.schemaSha256, migrations: current.migrations },
    'RELEASE_ROLLBACK_SCHEMA_UNPROVEN',
  );
  const candidate = migrationContract(roles.candidate.manifest);
  for (const [name, digest] of Object.entries(current.migrations))
    assert.equal(
      candidate.migrations[name],
      digest,
      'RELEASE_HISTORICAL_MIGRATION_CHANGED: ' + name,
    );
  if (
    Object.keys(candidate.migrations).length ===
    Object.keys(current.migrations).length
  )
    assert.equal(
      candidate.schemaSha256,
      current.schemaSha256,
      'RELEASE_SCHEMA_CHANGE_WITHOUT_MIGRATION',
    );
  // Exact deployed baseline; diagnostic table is the sole additive migration.
  if (
    roles.current.manifestSha256 ===
      '0e550eade929ac0c8d119f94a9b45c976b1f176c03ad5c525dbd7807f01a0d83' &&
    roles.rollback.manifestSha256 === roles.current.manifestSha256
  ) {
    assert.equal(
      Object.keys(current.migrations).length,
      34,
      'RECEIPT_BASELINE_34_REQUIRED',
    );
    assert.equal(
      Object.keys(candidate.migrations).length,
      35,
      'RECEIPT_CANDIDATE_35_REQUIRED',
    );
    assert.equal(
      candidate.schemaSha256,
      current.schemaSha256,
      'RECEIPT_PRISMA_SCHEMA_CHANGED',
    );
    assert.deepEqual(
      Object.fromEntries(
        Object.entries(candidate.migrations).filter(
          ([name]) => !(name in current.migrations),
        ),
      ),
      {
        '20261106110000_xhs_round_source_receipt':
          '8eab15e0d8c40d87607d1acd83b575c7aa454832d9756f022393edb15d23426b',
      },
      'RECEIPT_MIGRATION_CHANGED',
    );
    assert.equal(
      roles.candidate.manifest.prisma.engineCommit,
      roles.current.manifest.prisma.engineCommit,
      'RECEIPT_ENGINE_CHANGED',
    );
    return roles;
  }
  if (
    [
      '3ab20ac6ca2352940172cb42b986fa9d1e7935bd3fef4330f55a88f368d62fc3',
      '045b6da8c4ae629524def3d909050a9eb6dc78c69456f20a15c82e7e370b5bf6',
      'c173ade52436d8a0405d057065d72cbeab50e32af8ae00a43cd1d1dc695be9b0',
      'd2610b7bb37a763158440dc0203cf38da96846859a25411150adcdf23b7d9530',
      '59cf509136299bcab2b783aeebfb3b8a8460611c5069ef18fd43db61f63635ef',
      'e787a43a3d4d87fe6c3d2336863a917a51691fdbf9ef98a5df489528d08d2f31',
      '0c02143d3483bef141a35937aa9f166ce51e1d1a29a6be6a9deee3d4be79a671',
      '5e5ffe5139528ae97dfdbee724918ac2d303cc230d05ca473edbfc281179592d',
      'ba87c177ea1b326780392ec19367f732517b0ee42a36b66f9e1c87bb597580f6',
    ].includes(roles.current.manifestSha256) &&
    roles.rollback.manifestSha256 === roles.current.manifestSha256
  ) {
    assert.equal(
      Object.keys(current.migrations).length,
      35,
      'EXACT_35_REQUIRED',
    );
    assert.deepEqual(
      {
        schemaSha256: candidate.schemaSha256,
        migrations: candidate.migrations,
      },
      { schemaSha256: current.schemaSha256, migrations: current.migrations },
      'EXACT_35_SCHEMA_REQUIRED',
    );
    assert.equal(
      roles.candidate.manifest.prisma.engineCommit,
      roles.current.manifest.prisma.engineCommit,
      'EXACT_35_ENGINE_REQUIRED',
    );
    return roles;
  }
  const exactUnboundBaseline =
    roles.current.manifestSha256 ===
      '9bdd1b22027c422761ba7a5aa9925855e0a3c8b88b08be43f5d88b40d889822e' &&
    roles.rollback.manifestSha256 ===
      '9bdd1b22027c422761ba7a5aa9925855e0a3c8b88b08be43f5d88b40d889822e';
  if (exactUnboundBaseline) {
    assert.equal(
      Object.keys(current.migrations).length,
      33,
      'RELEASE_UNBOUND_CURRENT_33_REQUIRED',
    );
    assert.equal(
      Object.keys(candidate.migrations).length,
      34,
      'RELEASE_UNBOUND_CANDIDATE_34_REQUIRED',
    );
    assert.equal(
      candidate.schemaSha256,
      current.schemaSha256,
      'RELEASE_UNBOUND_SCHEMA_CHANGED',
    );
    const additions = Object.fromEntries(
      Object.entries(candidate.migrations).filter(
        ([name]) => !(name in current.migrations),
      ),
    );
    assert.deepEqual(
      additions,
      {
        '20261106010000_xhs_unbound_round':
          '05263fa79ce07a05f11dd243cd6c39d9158913127e8e229f4ed8cbc858e0d703',
      },
      'RELEASE_UNBOUND_MIGRATION_CHANGED',
    );
    assert.equal(
      roles.candidate.manifest.prisma.engineCommit,
      roles.current.manifest.prisma.engineCommit,
      'RELEASE_UNBOUND_ENGINE_CHANGED',
    );
    return roles;
  }
  // This deployed schema34 baseline admits an application-only update only.
  const exactInstalled34 =
    [
      '0dba566d9be5b7765d648a16aea69acf5efd18c7fb4b389bd87d24fd8d0b229d',
      '28aab827138e6e40008269765560825e80c78848bc41f0c7bf30fe84e1c59973',
      'aa31e85b46d2674011d5f332bdddb6e42214a0069fb31a50a6908c47b037d52f',
      'fcd0a7f2b7fc839f1393147dc1c005a28a2e543febd4e49ee8064fdd0cd45598',
    ].includes(roles.current.manifestSha256) &&
    roles.rollback.manifestSha256 === roles.current.manifestSha256;
  if (exactInstalled34) {
    assert.equal(
      Object.keys(current.migrations).length,
      34,
      'RELEASE_EXACT_34_BASELINE_REQUIRED',
    );
    assert.deepEqual(
      {
        schemaSha256: candidate.schemaSha256,
        migrations: candidate.migrations,
      },
      { schemaSha256: current.schemaSha256, migrations: current.migrations },
      'RELEASE_EXACT_34_SCHEMA_REQUIRED',
    );
    assert.equal(
      roles.candidate.manifest.prisma.engineCommit,
      roles.current.manifest.prisma.engineCommit,
      'RELEASE_EXACT_34_ENGINE_REQUIRED',
    );
    return roles;
  }
  const exactInstalled33 =
    roles.current.manifestSha256 ===
      'b40a121b0ed68dd346fa39a60fc15fd88ceae3fe136df82b6a6a552e751595b8' &&
    roles.rollback.manifestSha256 ===
      'b40a121b0ed68dd346fa39a60fc15fd88ceae3fe136df82b6a6a552e751595b8';
  if (exactInstalled33) {
    assert.equal(
      Object.keys(current.migrations).length,
      33,
      'RELEASE_EXACT_33_BASELINE_REQUIRED',
    );
    assert.deepEqual(
      {
        schemaSha256: candidate.schemaSha256,
        migrations: candidate.migrations,
      },
      { schemaSha256: current.schemaSha256, migrations: current.migrations },
      'RELEASE_EXACT_33_SCHEMA_REQUIRED',
    );
    assert(
      hex(roles.candidate.manifest.prisma?.engineCommit, 40),
      'RELEASE_CANDIDATE_ENGINE_COMMIT_REQUIRED',
    );
    return roles;
  }
  assert(
    roles.current.manifestSha256 === LEGACY_SHA &&
      roles.rollback.manifestSha256 === LEGACY_SHA,
    'RELEASE_EXACT_27_BASELINE_REQUIRED',
  );
  assert(
    Object.keys(current.migrations).length === 27 &&
      Object.keys(candidate.migrations).length === 33,
    'RELEASE_EXACT_27_TO_33_REQUIRED',
  );
  const additions = Object.fromEntries(
    Object.entries(candidate.migrations).filter(
      ([name]) => !(name in current.migrations),
    ),
  );
  assert.deepEqual(
    additions,
    ADDED_MIGRATIONS,
    'RELEASE_SIX_MIGRATION_ALLOWLIST_CHANGED',
  );
  assert(
    hex(roles.candidate.manifest.prisma?.engineCommit, 40),
    'RELEASE_CANDIDATE_ENGINE_COMMIT_REQUIRED',
  );
  return roles;
}
function expectedPending(roles, inspection) {
  validateRoles(roles);
  assert(
    inspection?.integrity === 'ok' &&
      Array.isArray(inspection.applied) &&
      Array.isArray(inspection.pending),
    'RELEASE_MIGRATION_INSPECTION_UNPROVEN',
  );
  const current = Object.keys(migrationFiles(roles.current.manifest)).sort();
  const candidate = Object.keys(
    migrationFiles(roles.candidate.manifest),
  ).sort();
  assert.deepEqual(
    [...inspection.applied].sort(),
    current,
    'RELEASE_APPLIED_MIGRATIONS_CHANGED',
  );
  const pending = candidate.filter((name) => !current.includes(name));
  assert.deepEqual(
    [...inspection.pending].sort(),
    pending,
    'RELEASE_PENDING_MIGRATIONS_CHANGED',
  );
  return pending;
}
module.exports = {
  migrationContract,
  migrationFiles,
  validateRoles,
  expectedPending,
  ADDED_MIGRATIONS,
  LEGACY_SHA,
  OBSERVED_RECEIPTS,
  assertReceiptChecksum,
};
