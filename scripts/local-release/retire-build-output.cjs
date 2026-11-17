// One exact, unused retained build output -> a verified frozen archive in the
// SAME cumulative root. Called only while release-scope owns its registry lock.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fileSha = (f) => require('./lib.cjs').fileHash(f);
const refuse = (code) => {
  throw Error('RELEASE_BUILD_RETIREMENT_' + code);
};
function writeNew(file, data) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function underScope(c) {
  const { options, policy, configSha, ledger, directory } = c;
  const spec = options.buildRetirement;
  const raw = c.readPin(spec, 65536),
    a = JSON.parse(raw);
  const root = policy.buildOnly?.outputRoot;
  if (
    a.format !== 1 ||
    a.kind !== 'retire-retained-build-output' ||
    policy.phase !== 'build-only' ||
    policy.format !== 2 ||
    !policy.preservingUpdate?.rootRoles ||
    a.scopeId !== policy.scopeId ||
    a.policySha256 !== configSha ||
    a.moduleSha256 !== fileSha(__filename) ||
    a.scopeModuleSha256 !==
      fileSha(path.join(__dirname, 'release-scope.cjs')) ||
    a.registryDirectory !== directory ||
    !same(a.registryIdentity, policy.registryIdentity) ||
    !a.reviewEvidence ||
    !a.owner?.entry ||
    a.owner.pid !== null ||
    !/^[a-f0-9]{40}$/.test(a.nextBuild?.sourceCommit || '') ||
    !/^[a-f0-9]{64}$/.test(a.nextBuild?.sourceHash || '') ||
    a.nextBuild.sourceCommit === policy.buildOnly.sourceCommit ||
    !path.isAbsolute(a.target || '') ||
    path.dirname(a.target) !== root
  )
    refuse('REVIEW_REQUIRED');
  c.readPin(a.entry, 1024 * 1024);
  if (a.entry.path !== a.owner.entry) refuse('OWNER_ENTRY_CHANGED');
  c.readPin(a.adoption, 64);
  if (a.adoption.path !== ledger + '.adopted') refuse('ADOPTION_CHANGED');
  c.readPin(a.python, 64 * 1024 * 1024);
  c.readPin(a.archiveTool, 1024 * 1024);
  if (
    a.archiveTool.path !==
    fs.realpathSync.native(path.join(__dirname, 'build-retirement-archive.py'))
  )
    refuse('ARCHIVE_TOOL_CHANGED');
  const archive = path.join(root, '.retired-' + spec.sha256 + '.tgz');
  const snapshotFile = ledger + '.retirement-' + spec.sha256 + '.json';
  const progressFile = snapshotFile + '.progress';
  const nextFile = path.join(
    directory,
    'retirement-policy-' + spec.sha256 + '.json',
  );
  const resultFile = snapshotFile + '.result';
  const pin = (file) => ({
    path: fs.realpathSync.native(file),
    identity: c.fileIdentity(file),
    sha256: fileSha(file),
  });
  const tool = (action, extra = {}) => {
    c.readPin(a.python, 64 * 1024 * 1024);
    c.readPin(a.archiveTool, 1024 * 1024);
    if (fileSha(process.execPath) !== policy.buildOnly.runtimeSha256)
      refuse('NODE_RUNTIME_CHANGED');
    if (action === 'restore') {
      const measured = c.measure(before.outputs),
        required = progress.verified.logicalBytes;
      const disk = fs.statfsSync(root, { bigint: true });
      if (
        measured.bytes + required > policy.maxBytes ||
        measured.bytes + required - policy.baseline.bytes >
          policy.maxGrowthBytes ||
        disk.bavail * disk.bsize - BigInt(required) < BigInt(4 * 1024 ** 3)
      )
        refuse('RESTORE_PEAK_CAPACITY');
      c.readPin(progress.archive, policy.maxBytes);
    }
    const value = JSON.parse(
      execFileSync(a.python.path, [a.archiveTool.path], {
        input: JSON.stringify({
          action,
          archive,
          node: process.execPath,
          ...extra,
        }),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 180000,
        maxBuffer: 1024 * 1024,
      }),
    );
    if (
      !value.fullContentAndMetadataVerified ||
      value.archiveSha256 !== fileSha(archive)
    )
      refuse('ARCHIVE_NOT_VERIFIED');
    return value;
  };
  let current = c.prior;
  const head = current.buildRetirement;
  if (head?.approvalSha256 === spec.sha256 && !current.claim) {
    const saved = c.readPin(
      {
        path: snapshotFile,
        identity: c.fileIdentity(snapshotFile),
        sha256: head.snapshotSha256,
      },
      4 * 1024 * 1024,
    );
    const journal = JSON.parse(saved);
    if (
      sha(Buffer.from(journal.approvalBase64, 'base64')) !== spec.sha256 ||
      current.configSha !== head.nextPolicySha256 ||
      fs.existsSync(a.target)
    )
      refuse('REPLAY_CHANGED');
    c.readPin(head.archive, policy.maxBytes);
    tool('verify');
    c.guard(a);
    const receipt = JSON.parse(c.readPin(head.result, 1024 * 1024));
    if (
      receipt.nextPolicy.sha256 !== current.configSha ||
      fileSha(receipt.nextPolicy.path) !== current.configSha
    )
      refuse('REPLAY_CHANGED');
    return { ...receipt, alreadyRetired: true };
  }
  let before, snapshot, oldRaw;
  if (current.claim) {
    if (
      current.claim.kind !== 'build-retirement' ||
      current.claim.id !== spec.sha256 ||
      current.claim.snapshotFile !== snapshotFile
    )
      refuse('OTHER_CLAIM');
    snapshot = c.readPin(
      {
        path: snapshotFile,
        identity: c.fileIdentity(snapshotFile),
        sha256: current.claim.snapshotSha256,
      },
      4 * 1024 * 1024,
    );
    const doc = JSON.parse(snapshot);
    if (
      sha(Buffer.from(doc.approvalBase64, 'base64')) !== spec.sha256 ||
      sha(Buffer.from(doc.policyBase64, 'base64')) !== configSha
    )
      refuse('SNAPSHOT_CHANGED');
    oldRaw = Buffer.from(doc.ledgerBase64, 'base64');
    before = JSON.parse(oldRaw).payload;
    if (
      sha(oldRaw) !== a.ledger.sha256 ||
      before.configSha !== configSha ||
      before.claim
    )
      refuse('SNAPSHOT_CHANGED');
  } else {
    oldRaw = c.readPin(a.ledger, 4 * 1024 * 1024);
    if (
      a.ledger.path !== ledger ||
      !same(JSON.parse(oldRaw).payload, current) ||
      current.configSha !== configSha
    )
      refuse('LEDGER_CHANGED');
    c.readPin(a.adoption, 64);
    if (a.adoption.path !== ledger + '.adopted') refuse('ADOPTION_CHANGED');
    const candidate = current.outputs.find((o) => o.path === a.target);
    if (
      !candidate?.complete ||
      !candidate.retainedFailure ||
      !same(candidate, a.output) ||
      current.outputs.some((o) => !o.complete) ||
      policy.protectedIds.includes(path.basename(a.target))
    )
      refuse('ONLY_UNUSED_RETAINED_FAILURE_ALLOWED');
    c.checkFrozen();
    c.guard(a);
    before = structuredClone(current);
    snapshot = Buffer.from(
      JSON.stringify({
        format: 1,
        ledgerBase64: oldRaw.toString('base64'),
        policyBase64: fs.readFileSync(c.file).toString('base64'),
        approvalBase64: raw.toString('base64'),
      }),
    );
    if (fs.existsSync(snapshotFile)) {
      if (!fs.readFileSync(snapshotFile).equals(snapshot))
        refuse('SNAPSHOT_CHANGED');
    } else writeNew(snapshotFile, snapshot);
    current = {
      ...before,
      claim: {
        id: spec.sha256,
        kind: 'build-retirement',
        root,
        snapshotFile,
        snapshotSha256: sha(snapshot),
      },
    };
    c.save(current);
  }
  const row = before.outputs.find((o) => o.path === a.target);
  if (
    before.claim ||
    !row?.complete ||
    !row.retainedFailure ||
    before.outputs.some((o) => !o.complete) ||
    before.outputs.length > 3 ||
    !same(row, a.output) ||
    policy.protectedIds.includes(path.basename(a.target))
  )
    refuse('ONLY_UNUSED_RETAINED_FAILURE_ALLOWED');
  const remaining = before.outputs.filter((o) => o.path !== a.target);
  const verifyOthers = () => {
    c.guard(a);
    for (const o of remaining) {
      const s = c.scan(o);
      if (s.digest !== o.digest || s.metadataDigest !== o.metadataDigest)
        refuse('OTHER_OUTPUT_CHANGED');
    }
  };
  const verifyOriginal = () => {
    if (!fs.existsSync(a.target) || !same(c.identity(a.target), row.identity))
      refuse('OUTPUT_REPLACED');
    const s = c.scan(row);
    if (s.digest !== row.digest || s.metadataDigest !== row.metadataDigest)
      refuse('OUTPUT_CHANGED');
  };
  let progress;
  if (fs.existsSync(progressFile)) {
    if (!current.claim.progress || current.claim.progress.path !== progressFile)
      refuse('UNBOUND_PROGRESS');
    const value = JSON.parse(c.readPin(current.claim.progress, 1024 * 1024));
    if (value.digest !== sha(Buffer.from(JSON.stringify(value.payload))))
      refuse('PROGRESS_CHANGED');
    progress = value.payload;
  }
  const saveProgress = (value, payload = current) => {
    c.atomic(progressFile, value);
    current = {
      ...payload,
      claim: { ...payload.claim, progress: pin(progressFile) },
    };
    c.save(current);
    progress = value;
  };
  if (
    progress &&
    (progress.approvalSha256 !== spec.sha256 ||
      progress.archive.path !== archive)
  )
    refuse('PROGRESS_CHANGED');
  if (!progress) {
    verifyOthers();
    verifyOriginal();
    const measured = c.measure(before.outputs);
    if (
      measured.bytes >= policy.maxBytes ||
      measured.runtimeCopies - policy.baseline.runtimeCopies >
        policy.maxNewRuntimeCopies
    )
      refuse('CAPACITY');
    let verified;
    if (fs.existsSync(archive)) verified = tool('verify', { source: a.target });
    else {
      const disk = fs.statfsSync(root, { bigint: true });
      const free = Number(disk.bavail * disk.bsize - BigInt(4 * 1024 ** 3));
      const maxBytes = Math.min(
        policy.maxBytes - measured.bytes,
        policy.maxGrowthBytes - (measured.bytes - policy.baseline.bytes),
        free,
      );
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) refuse('CAPACITY');
      verified = tool('create', { source: a.target, maxBytes });
    }
    verifyOriginal();
    verifyOthers();
    const measuredWithArchive = c.measure([
      ...before.outputs,
      { path: archive },
    ]);
    if (
      measuredWithArchive.digest !== policy.baseline.digest ||
      measuredWithArchive.metadataDigest !== policy.baseline.metadataDigest ||
      measuredWithArchive.bytes > policy.maxBytes ||
      measuredWithArchive.bytes - policy.baseline.bytes >
        policy.maxGrowthBytes ||
      measuredWithArchive.runtimeCopies - policy.baseline.runtimeCopies >
        policy.maxNewRuntimeCopies
    )
      refuse('ARCHIVE_PEAK_OR_HISTORY_CHANGED');
    progress = {
      approvalSha256: spec.sha256,
      archive: pin(archive),
      verified,
      stage: 'archive-verified',
    };
    saveProgress(progress);
  }
  c.readPin(progress.archive, policy.maxBytes);
  tool('verify');
  verifyOthers();
  if (progress.stage === 'deleting') {
    // A crash may have removed only part of the old directory. Restore missing
    // entries without overwriting any differing/unknown file, then reverify.
    tool('restore', { destination: a.target });
    tool('verify', { source: a.target });
  } else verifyOriginal();
  let deleting = false,
    committed = false;
  try {
    options.onBuildRetirementStep?.('before-delete');
    c.guard(a);
    c.readPin(progress.archive, policy.maxBytes);
    tool('verify', { source: a.target });
    verifyOthers();
    saveProgress({ ...progress, stage: 'deleting' });
    deleting = true;
    fs.rmSync(a.target, { recursive: true });
    options.onBuildRetirementStep?.('after-delete');
    // Rehearse this exact archive on disk within the vacated original slot.
    // There is never a fourth runtime/package copy, and all bytes stay counted.
    const rehearsal = tool('restore', { destination: a.target });
    if (!rehearsal.actualRestoreVerified) refuse('RESTORE_REHEARSAL_FAILED');
    tool('verify', { source: a.target });
    verifyOthers();
    options.onBuildRetirementStep?.('after-restore');
    c.guard(a);
    c.readPin(progress.archive, policy.maxBytes);
    tool('verify', { source: a.target });
    fs.rmSync(a.target, { recursive: true });
    c.guard(a);
    c.readPin(progress.archive, policy.maxBytes);
    verifyOthers();
    const frozen = c.measure([...remaining, { path: archive }]);
    if (
      frozen.digest !== policy.baseline.digest ||
      frozen.metadataDigest !== policy.baseline.metadataDigest
    )
      refuse('FROZEN_HISTORY_CHANGED');
    const scan = c.measure(remaining);
    const next = structuredClone(policy);
    next.buildOnly.sourceCommit = a.nextBuild.sourceCommit;
    next.buildOnly.sourceHash = a.nextBuild.sourceHash;
    next.baseline = {
      ...scan,
      bytes: policy.baseline.bytes + progress.verified.archiveBytes,
      runtimeCopies: policy.baseline.runtimeCopies,
    };
    if (
      scan.bytes > policy.maxBytes ||
      scan.bytes - policy.baseline.bytes > policy.maxGrowthBytes ||
      scan.runtimeCopies - policy.baseline.runtimeCopies >
        policy.maxNewRuntimeCopies
    )
      refuse('FINAL_CAPACITY');
    const nextRaw = Buffer.from(JSON.stringify(next, null, 2) + '\n');
    if (fs.existsSync(nextFile)) {
      if (!fs.readFileSync(nextFile).equals(nextRaw))
        refuse('NEXT_POLICY_CHANGED');
    } else writeNew(nextFile, nextRaw);
    const nextPolicy = pin(nextFile);
    const retired = {
      approvalSha256: spec.sha256,
      snapshotSha256: sha(snapshot),
      archive: progress.archive,
      retiredOutput: row,
      nextPolicySha256: nextPolicy.sha256,
    };
    const after = {
      ...before,
      configSha: nextPolicy.sha256,
      claim: null,
      outputs: remaining,
      buildRetirement: retired,
      retiredBuildOutputs: [...(before.retiredBuildOutputs || []), retired],
    };
    const receipt = {
      format: 1,
      retired: true,
      alreadyRetired: false,
      archive: progress.archive,
      nextPolicy,
      sourceCommit: a.nextBuild.sourceCommit,
      retiredOutput: a.target,
      originalLedgerSnapshot: snapshotFile,
      fullArchiveReadbackVerified: true,
      actualRestoreVerified: true,
      restoreRehearsal: rehearsal,
      productionChanged: false,
      sourceRequests: 0,
    };
    if (fs.existsSync(resultFile)) {
      if (!same(JSON.parse(fs.readFileSync(resultFile)), receipt))
        refuse('RESULT_CHANGED');
    } else writeNew(resultFile, JSON.stringify(receipt, null, 2) + '\n');
    retired.result = pin(resultFile);
    options.onBuildRetirementStep?.('before-commit');
    c.guard(a);
    c.readPin(progress.archive, policy.maxBytes);
    c.readPin(nextPolicy, 1024 * 1024);
    c.readPin(retired.result, 1024 * 1024);
    if (fs.existsSync(a.target)) refuse('OUTPUT_REAPPEARED');
    c.save(after);
    committed = true;
    options.onBuildRetirementStep?.('after-commit');
    return receipt;
  } catch (error) {
    if (deleting && !committed) {
      // Recovery never overwrites an unknown or changed file. An unsuccessful
      // restore leaves the intent claim held and the verified archive intact.
      c.readPin(progress.archive, policy.maxBytes);
      const restored = tool('restore', { destination: a.target });
      if (!restored.actualRestoreVerified) refuse('ROLLBACK_NOT_VERIFIED');
      const inventory = c.scan(row);
      saveProgress(
        { ...progress, stage: 'deleting' },
        {
          ...before,
          outputs: before.outputs.map((o) =>
            o.path === a.target
              ? {
                  ...o,
                  identity: c.identity(a.target),
                  digest: inventory.digest,
                  metadataDigest: inventory.metadataDigest,
                }
              : o,
          ),
          claim: { ...current.claim, rollbackVerified: true },
        },
      );
    }
    throw error;
  }
}
function origin(payload, expected, ledger, readPin, fileIdentity) {
  const head = payload.buildRetirement;
  if (!head || head.nextPolicySha256 !== expected) return null;
  const snapshotFile = ledger + '.retirement-' + head.approvalSha256 + '.json';
  const snapshot = JSON.parse(
    readPin(
      {
        path: snapshotFile,
        identity: fileIdentity(snapshotFile),
        sha256: head.snapshotSha256,
      },
      4 * 1024 * 1024,
    ),
  );
  const raw = Buffer.from(snapshot.ledgerBase64, 'base64');
  const old = JSON.parse(raw),
    oldPolicy = Buffer.from(snapshot.policyBase64, 'base64');
  const approval = Buffer.from(snapshot.approvalBase64, 'base64');
  const review = JSON.parse(approval);
  const nextFile = path.join(
    path.dirname(ledger),
    'retirement-policy-' + head.approvalSha256 + '.json',
  );
  if (
    old.digest !== sha(Buffer.from(JSON.stringify(old.payload))) ||
    sha(oldPolicy) !== old.payload.configSha ||
    sha(approval) !== head.approvalSha256 ||
    review.policySha256 !== old.payload.configSha ||
    fileSha(nextFile) !== expected ||
    !same(review.output, head.retiredOutput)
  )
    refuse('ORIGIN_CHANGED');
  const before = JSON.parse(oldPolicy),
    next = JSON.parse(fs.readFileSync(nextFile));
  if (
    next.buildOnly.sourceCommit !== review.nextBuild.sourceCommit ||
    next.buildOnly.sourceHash !== review.nextBuild.sourceHash
  )
    refuse('ORIGIN_CHANGED');
  delete before.baseline;
  delete next.baseline;
  for (const item of [before, next]) {
    delete item.buildOnly.sourceCommit;
    delete item.buildOnly.sourceHash;
  }
  if (!same(before, next)) refuse('ORIGIN_CHANGED');
  return { payload: old.payload, policySha256: old.payload.configSha };
}
module.exports = { underScope, origin };
