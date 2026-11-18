'use strict';
// Current-role composition of the original native maintenance and update kernel.
// Import is inert. No candidate code supplies trust or installation authority.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  verifyFixedProfile,
  fixedProfile,
} = require('./fixed-driver-profile.cjs');
const { verifyPinnedInput: pin } = require('./prepare-maintenance-binding.cjs');
const { createUpdater } = require('./installer/update-engine.cjs');
const { createNativePrimitives } = require('./installed-native-primitives.cjs');
const {
  createFixedReuseOwner,
  withAuthorizedReusedPointer,
} = require('./fixed-reuse-owner.cjs');
const { withFixedCode } = require('./fixed-code-loader.cjs');
const prewrite = require('./install-binding/role-aware/switch-prewrite.cjs');
const fail = (code) => {
  throw Error(code);
};
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
function atomic(file, value) {
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
}
const {
  quiet,
  environment: modeEnvironment,
} = require('../managed-runtime-mode.cjs');

async function runFixedProfile(
  { path: profileFile, sha256 },
  report = () => {},
) {
  const token = verifyFixedProfile(profileFile, sha256),
    data = fixedProfile(token),
    p = data.profile;
  return withFixedCode(p.closure, () => runProfileInner(token, report));
}
async function runProfileInner(token, report) {
  const data = fixedProfile(token),
    p = data.profile;
  const api = Object.fromEntries(
    Object.entries(p.modules).map(([name, value]) => [
      name,
      require(value.path),
    ]),
  );
  if (typeof api.toolkit.createPinnedToolkit === 'function')
    api.toolkit = api.toolkit.createPinnedToolkit(p.nativeTool);
  for (const [name, methods] of Object.entries({
    scope: ['inspectPlan', 'createInstallerContext'],
    toolkit: ['processIdentity', 'sameIdentity', 'observeProjectWriters'],
    writerGate: ['acquireMaintenance', 'binding'],
    lockSession: ['acquire'],
    tasks: ['control', 'assertSnapshot', 'begin', 'restore'],
    restart: ['commandLine'],
    stopRetire: ['create'],
  }))
    for (const method of methods)
      if (typeof api[name]?.[method] !== 'function')
        fail('FIXED_EXISTING_ENTRY_MISSING_' + name + '_' + method);
  const pointer = path.join(p.releasesRoot, 'active.json');
  const registryFile = p.journalFile + '.native-processes',
    controlFile = p.journalFile + '.control';
  const lockFile = p.journalFile + '.startup-lock',
    permitFile = p.journalFile + '.permit';
  const sessions = [];
  let startupToken,
    maintenance,
    continuation,
    scopeLease,
    native,
    taskBefore,
    taskPaused = false,
    previousCompletion;
  const own = () => {
    sessions.forEach((session) => session.assertOwned());
    if (scopeLease) scopeLease.check(true);
    if (startupToken && read(lockFile).token !== startupToken)
      fail('FIXED_STARTUP_LOCK_LOST');
  };
  const record = (value) => {
    own();
    const record = read(controlFile);
    if (record.events.length >= 256) fail('FIXED_CONTROL_EVENT_LIMIT');
    record.events.push({ ...value, at: new Date().toISOString() });
    atomic(controlFile, record);
    try {
      report({ stage: value.stage });
    } catch {}
  };
  const fixed = (role) => ({
    id: p[role].id,
    path: p[role].path,
    sha256: p[role].sha256,
    database: p.database,
  });
  const current = fixed('current'),
    next = fixed('candidate');
  const registered = () => read(registryFile);
  const journalStage = (ctx, stage) => {
    own();
    const j = read(p.journalFile);
    if (
      j.transactionId !== ctx.transactionId ||
      j.stage !== stage ||
      j.package.sha256 !== next.sha256 ||
      j.old.sha256 !== current.sha256
    )
      fail('FIXED_JOURNAL_STAGE_CHANGED');
    return j;
  };
  async function health(ctx, release) {
    own();
    const entry = registered().processes.find(
      (item) =>
        item.transactionId === ctx.transactionId &&
        item.releaseId === release.id,
    );
    if (!entry) fail('REGISTERED_TRANSACTION_PROCESS_REQUIRED');
    const observed = await native.processIdentity(
      'OwnedSnapshot',
      entry.identity.pid,
      p.port || 4000,
      entry.identity,
    );
    if (
      api.toolkit.sameIdentity(observed, entry.identity) === false ||
      observed?.stopped
    )
      fail('FIXED_HEALTH_PROCESS_CHANGED');
    const proof = await native.readUpdateHealth({ ...ctx, release });
    if (p.runtimeMode && release.id === next.id) {
      modeEnvironment(p.runtimeMode, p.database, { initial: true });
      if (
        proof.managedRuntime?.mode !== p.runtimeMode.kind ||
        proof.managedRuntime.recoveryHeld !== false ||
        proof.managedRuntime.xhsLive !== true ||
        proof.managedRuntime.automaticDisabled !== true ||
        proof.managedRuntime.localMode !== true
      )
        fail('FIXED_MANAGED_MODE_HEALTH_UNPROVEN');
    }
    const after = await native.processIdentity(
      'OwnedSnapshot',
      entry.identity.pid,
      p.port || 4000,
      entry.identity,
    );
    if (
      api.toolkit.sameIdentity(after, entry.identity) === false ||
      JSON.stringify(after.localAddresses) !== JSON.stringify(['127.0.0.1'])
    )
      fail('FIXED_HEALTH_LISTENER_UNPROVEN');
    own();
    return true;
  }
  async function stop(ctx, release) {
    own();
    for (const entry of registered().processes.filter(
      (item) => item.releaseId === release.id,
    )) {
      const observed = await native.processIdentity(
        'OwnedSnapshot',
        entry.identity.pid,
        p.port || 4000,
        entry.identity,
      );
      if (observed?.stopped) continue;
      if (api.toolkit.sameIdentity(observed, entry.identity) === false)
        fail('FIXED_STOP_IDENTITY_CHANGED');
      const receipt = await scopeLease.stopExact(entry.identity, release.id);
      if (receipt?.stopped !== true) fail('FIXED_STOP_UNPROVEN');
      const inventory = registered();
      if (oldProcess && entry.identity.pid === oldProcess.pid)
        inventory.oldStopReceipt = receipt;
      inventory.processes = inventory.processes.filter(
        (item) => item.identity.pid !== entry.identity.pid,
      );
      atomic(registryFile, inventory);
    }
    // An interrupted native CreateProcess is never inferred to have failed.
    const intent =
      registryFile + '.launch-' + ctx.transactionId + '-' + release.id;
    if (fs.existsSync(intent) && read(intent).phase !== 'registered')
      fail('FIXED_LAUNCH_OUTCOME_UNKNOWN');
  }
  async function acquireMaintenance(ctx) {
    if (maintenance) return;
    own();
    const inventory = registered();
    if (
      (!cold && !inventory.oldStopReceipt?.stopped) ||
      scopeLease.observeProjectWriters().active.length
    )
      fail('FIXED_ALL_WRITER_STOP_REQUIRED');
    const checkpoint = cold
      ? { coldProof: scopeLease.coldMaintenanceProof(), scopeLease }
      : {
          identity: oldProcess,
          stopReceipt: inventory.oldStopReceipt,
          scopeLease,
        };
    maintenance = createFixedReuseOwner({
      profileToken: token,
      scopeLease,
      writerGate: api.writerGate,
      checkpoint,
      native,
      record,
      continuation,
    });
    await maintenance.acquire(ctx);
    continuation = undefined;
  }
  async function start(ctx, release) {
    own();
    if (maintenance) {
      continuation = await maintenance.close();
      maintenance = undefined;
    }
    const prior = registered().processes.find(
      (item) =>
        item.transactionId === ctx.transactionId &&
        item.releaseId === release.id,
    );
    if (prior) {
      const observed = await native.processIdentity(
        'OwnedSnapshot',
        prior.identity.pid,
        p.port || 4000,
        prior.identity,
      );
      if (
        !observed?.stopped &&
        api.toolkit.sameIdentity(observed, prior.identity) !== false
      )
        return;
      if (!observed?.stopped) fail('FIXED_PRIOR_LAUNCH_UNKNOWN');
    }
    await native.launchRegistered({
      node: path.join(release.path, 'runtime/node.exe'),
      args: [
        path.join(release.path, 'runtime.cjs'),
        'start',
        '--database',
        p.database,
        '--port',
        String(p.port || 4000),
        '--production',
      ],
      registryFile,
      transactionId: ctx.transactionId,
      releaseId: release.id,
      env: {
        ...(release.id === next.id
          ? modeEnvironment(p.runtimeMode, p.database, { initial: true })
          : quiet),
        LOCAL_RELEASE_CONTROLLED_START: release.id,
        WEWE_UPDATE_TRANSACTION: ctx.transactionId,
        WEWE_UPDATE_LEASE: startupToken,
        WEWE_UPDATE_JOURNAL: p.journalFile,
        WEWE_UPDATE_READ_ONLY: '1',
        SQLITE_BACKUP_PYTHON: p.python,
        SQLITE_PRODUCTION_BACKUP_ROOT: p.backupDataRoot,
        LOCAL_RELEASE_STARTUP_AUDIT_ROOT: path.join(
          path.dirname(p.database),
          '.update-startup-audits',
          ctx.transactionId + '-' + release.id,
        ),
      },
    });
    own();
  }
  async function publish(ctx, release, stage) {
    journalStage(ctx, stage);
    const before = fs.readFileSync(pointer);
    if (read(pointer).id === release.id) return;
    const temporary = path.join(
      p.releasesRoot,
      'active-' + crypto.randomUUID() + '.tmp',
    );
    fs.writeFileSync(
      temporary,
      JSON.stringify({ format: 1, id: release.id }) + '\n',
      { flag: 'wx' },
    );
    await withAuthorizedReusedPointer(
      release.id === next.id ? continuation : maintenance,
      {
        transactionId: ctx.transactionId,
        temporary,
        destination: pointer,
        id: release.id,
        journalFile: p.journalFile,
      },
      () => health(ctx, next),
      async () => {
        own();
        if (!fs.readFileSync(pointer).equals(before))
          fail('FIXED_ACTIVE_POINTER_CHANGED');
        fs.renameSync(temporary, pointer);
        own();
      },
    );
  }
  const cold = p.startMode === 'cold-empty';
  const oldProcess = cold
    ? undefined
    : JSON.parse(fs.readFileSync(pin(p.oldProcess).path, 'utf8'));
  try {
    sessions.push(
      api.lockSession.acquire(path.join(p.releasesRoot, '.build-budget.lock')),
    );
    sessions.push(
      api.lockSession.acquire(path.join(p.projectRoot, '.active-release.lock')),
    );
    // Exact committed evidence permits a read-only repeat, with no PID reuse,
    // task changes, backend launch, database open or source request.
    if (read(pointer).id === next.id && fs.existsSync(p.journalFile)) {
      const j = read(p.journalFile);
      const permit = fs.existsSync(permitFile) && read(permitFile);
      if (p.previousCompletion) {
        const preserved = read(controlFile).previousCompletionArchive;
        if (!preserved) fail('FIXED_PREVIOUS_COMPLETION_ARCHIVE_MISSING');
        pin(preserved);
        const saved = read(preserved.path);
        if (
          saved.kind !== 'preserved-completed-fixed-install-v1' ||
          !/^[a-f0-9-]{36}$/.test(saved.transactionId) ||
          preserved.path !==
            p.journalFile + '.completed-' + saved.transactionId + '.json'
        )
          fail('FIXED_PREVIOUS_COMPLETION_ARCHIVE_CHANGED');
        for (const [key, input] of Object.entries(p.previousCompletion)) {
          const item = saved.records?.[key];
          if (
            item?.sha256 !== input.sha256 ||
            crypto
              .createHash('sha256')
              .update(Buffer.from(item.raw || '', 'base64'))
              .digest('hex') !== input.sha256
          )
            fail('FIXED_PREVIOUS_COMPLETION_ARCHIVE_CHANGED');
        }
      }
      if (
        j.stage === 'completed' &&
        JSON.stringify(j.runtimeMode) !== JSON.stringify(p.runtimeMode)
      )
        fail('FIXED_CURRENT_MODE_REQUIRES_REVIEW');
      if (
        j.stage === 'completed' &&
        j.package?.sha256 === next.sha256 &&
        j.old?.sha256 === current.sha256 &&
        j.backup?.path === p.backup.path &&
        j.backup?.sha256 === p.backup.sha256 &&
        j.backup?.reused === true &&
        !fs.existsSync(lockFile) &&
        permit?.transactionId === j.transactionId &&
        permit.sha256 === next.sha256 &&
        permit.stage === 'completed'
      )
        return { status: 'already-current', scope: 'fixed-profile-read-only' };
      fail('FIXED_CURRENT_OUTCOME_REQUIRES_REVIEW');
    }
    if (fs.existsSync(lockFile) || read(pointer).id !== current.id)
      fail('FIXED_PRIOR_CONTROL_REQUIRES_REVIEW');
    const priorPresent = [registryFile, p.journalFile, controlFile].some(
      fs.existsSync,
    );
    if (priorPresent && !p.previousCompletion)
      fail('FIXED_PRIOR_CONTROL_REQUIRES_REVIEW');
    if (!priorPresent && p.previousCompletion)
      fail('FIXED_PREVIOUS_COMPLETION_MISSING');
    pin({ path: pointer, sha256: p.activePointerSha256 });
    pin(p.scopePolicy);
    const fresh = cold
      ? undefined
      : await api.toolkit.processIdentity(
          'OwnedSnapshot',
          oldProcess.pid,
          p.port || 4000,
          oldProcess,
        );
    if (
      !cold &&
      (fresh?.stopped ||
        api.toolkit.sameIdentity(fresh, oldProcess) === false ||
        JSON.stringify(fresh.localAddresses) !== JSON.stringify(['127.0.0.1']))
    )
      fail('FIXED_FRESH_OLD_IDENTITY_CHANGED');
    if (p.previousCompletion) {
      const records = {};
      let bytes = 0;
      for (const [key, input] of Object.entries(p.previousCompletion)) {
        pin(input);
        const raw = fs.readFileSync(input.path);
        bytes += raw.length;
        records[key] = {
          sha256: input.sha256,
          raw: raw.toString('base64'),
          value: JSON.parse(raw),
        };
      }
      if (bytes > 32768) fail('FIXED_PREVIOUS_COMPLETION_LIMIT');
      const j = records.journal.value,
        permit = records.permit.value,
        r = records.registry.value,
        c = records.control.value;
      if (
        j.format !== 1 ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
          j.transactionId,
        ) ||
        j.stage !== 'completed' ||
        j.package?.id !== current.id ||
        j.package?.sha256 !== current.sha256 ||
        j.package?.path !== current.path ||
        j.package?.database !== p.database ||
        permit.stage !== 'completed' ||
        permit.transactionId !== j.transactionId ||
        permit.id !== current.id ||
        permit.sha256 !== current.sha256 ||
        r.database !== p.database ||
        r.processes?.length !== 1 ||
        r.processes[0].releaseId !== current.id ||
        r.processes[0].transactionId !== j.transactionId ||
        c.format !== 1 ||
        c.taskBefore?.definitionSha256 !== p.taskDefinitionSha256 ||
        !/^[a-f0-9]{64}$/.test(c.profileSha256)
      )
        fail('FIXED_PREVIOUS_COMPLETION_UNPROVEN');
      api.toolkit.sameIdentity(fresh, r.processes[0].identity);
      previousCompletion = { transactionId: j.transactionId, records };
    }
    taskBefore = api.tasks.control('Snapshot');
    api.tasks.assertSnapshot(taskBefore, p.taskDefinitionSha256);
    modeEnvironment(p.runtimeMode, p.database, { initial: true });
    const prepared = {
      api,
      old: data.current,
      next: data.candidate,
      oldProcess,
    };
    api.scope.inspectPlan(p, prepared);
    scopeLease = cold
      ? require('./fixed-cold-start.cjs').createColdScope({
          profileToken: token,
          prepared,
          sessions,
          assertTaskSuspended: () => {
            if (!taskPaused) fail('COLD_TASK_NOT_SUSPENDED');
            const snapshot = api.tasks.control('Snapshot');
            api.tasks.assertSnapshot(snapshot, p.taskDefinitionSha256);
            if (
              snapshot.enabled ||
              snapshot.lastRunUtc !== taskBefore.lastRunUtc
            )
              fail('COLD_TASK_NOT_SUSPENDED');
          },
        })
      : api.scope.createInstallerContext(p, prepared, sessions);
    if (cold) {
      if (scopeLease.observeProjectWriters().active.length)
        fail('COLD_PROJECT_WRITERS_REMAIN');
      // Quiescence cannot retire a prior writer lease. Reject it before making
      // a startup barrier, pausing the task or creating an update transaction.
      // acquireColdMaintenance repeats this check under its live cold proof.
      if (fs.existsSync(api.writerGate.binding(p.database).file))
        fail('COLD_PROJECT_WRITER_LEASE_REQUIRES_REVIEW');
    } else scopeLease.legacyMaintenanceRoots(oldProcess);
    native = createNativePrimitives({
      scopeLease,
      toolkit: api.toolkit,
      publication: {
        pointer,
        writeActiveRelease: () => fail('FIXED_POINTER_OWNER_REQUIRED'),
      },
      releasesRoot: p.releasesRoot,
      database: p.database,
      port: p.port || 4000,
    });
    const adapter = {
      async acquireLock() {
        own();
        let previousCompletionArchive;
        if (previousCompletion) {
          for (const input of Object.values(p.previousCompletion)) pin(input);
          const file =
            p.journalFile +
            '.completed-' +
            previousCompletion.transactionId +
            '.json';
          const bytes =
            JSON.stringify({
              kind: 'preserved-completed-fixed-install-v1',
              transactionId: previousCompletion.transactionId,
              records: Object.fromEntries(
                Object.entries(previousCompletion.records).map(
                  ([key, item]) => [
                    key,
                    { sha256: item.sha256, raw: item.raw },
                  ],
                ),
              ),
            }) + '\n';
          if (fs.existsSync(file)) {
            if (fs.readFileSync(file, 'utf8') !== bytes)
              fail('FIXED_PREVIOUS_COMPLETION_ARCHIVE_CHANGED');
          } else {
            const fd = fs.openSync(file, 'wx', 0o600);
            try {
              fs.writeFileSync(fd, bytes);
              fs.fsyncSync(fd);
            } finally {
              fs.closeSync(fd);
            }
          }
          previousCompletionArchive = {
            path: file,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
          };
        }
        startupToken = crypto.randomUUID();
        const fd = fs.openSync(lockFile, 'wx', 0o600);
        try {
          fs.writeFileSync(
            fd,
            JSON.stringify({
              format: 1,
              pid: process.pid,
              token: startupToken,
            }),
          );
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        atomic(registryFile, {
          format: 1,
          database: p.database,
          classification: cold
            ? 'proved empty cold start; no old PID or stop receipt'
            : 'actual native identities; no legacy protocol adoption',
          processes: cold ? [] : [{ releaseId: current.id, identity: fresh }],
        });
        atomic(controlFile, {
          format: 1,
          profileSha256: data.fixed.sha256,
          ...(previousCompletionArchive ? { previousCompletionArchive } : {}),
          taskBefore,
          events: [],
        });
        api.tasks.begin(
          api.tasks.control,
          p.taskDefinitionSha256,
          (stage, details) => record({ stage, ...details }),
          taskBefore,
        );
        taskPaused = true;
        if (cold) record({ stage: 'cold-task-suspended-without-old-instance' });
        return async () => {
          const j = fs.existsSync(p.journalFile) && read(p.journalFile);
          const enabled =
            j?.stage !== 'completed' ||
            (fs.existsSync(permitFile) &&
              read(permitFile).transactionId === j.transactionId &&
              read(permitFile).sha256 === next.sha256 &&
              read(permitFile).stage === 'completed');
          if (!j || !['completed', 'recovered'].includes(j.stage) || !enabled) {
            record({ stage: 'startup-and-task-barrier-retained' });
            return;
          }
          if (maintenance) {
            continuation = await maintenance.close();
            maintenance = undefined;
          }
          if (j.stage === 'recovered')
            atomic(permitFile, {
              format: 1,
              transactionId: j.transactionId,
              id: current.id,
              sha256: current.sha256,
              stage: 'recovered',
            });
          api.tasks.restore(
            api.tasks.control,
            taskBefore,
            true,
            (stage, details) => record({ stage, ...details }),
            taskPaused,
          );
          own();
          fs.unlinkSync(lockFile);
          startupToken = undefined;
        };
      },
      verifyPackage: async (request) => {
        own();
        if (request.path !== next.path || request.sha256 !== next.sha256)
          fail('FIXED_REQUEST_CHANGED');
        return next;
      },
      currentInstallation: async () => {
        own();
        const id = read(pointer).id;
        if (![current.id, next.id].includes(id))
          fail('FIXED_ACTIVE_ID_CHANGED');
        return id === current.id ? current : next;
      },
      async stopOld(ctx) {
        await stop(ctx, current);
        await acquireMaintenance(ctx);
      },
      stopNew: (ctx) => stop(ctx, next),
      backup: (ctx) => maintenance.admit(ctx),
      async migrate(ctx) {
        journalStage(ctx, 'migrating');
        await maintenance.assertProof(ctx);
        const before = prewrite.inspectSwitchDatabase({
          database: p.database,
          roles: data.roles,
          stage: 'before-migration',
          operationId: ctx.transactionId,
        });
        // This fixed current-role profile admits application-only updates.
        // There is deliberately no migrate deploy or database write here.
        prewrite.assertSwitchDatabaseUnchanged(
          {
            database: p.database,
            roles: data.roles,
            stage: 'before-migration',
            operationId: ctx.transactionId,
          },
          before,
        );
        const after = prewrite.inspectSwitchDatabase({
          database: p.database,
          roles: data.roles,
          stage: 'after-migration',
          operationId: ctx.transactionId,
        });
        prewrite.assertSwitchTransition(before, after);
        await maintenance.assertProof(ctx);
      },
      restoreDatabase: (ctx) => maintenance.restoreAlreadyEqual(ctx),
      startNew: (ctx) => start(ctx, next),
      health: (ctx) => health(ctx, next),
      activateNew: (ctx) => publish(ctx, next, 'activating'),
      activateOld: (ctx) => publish(ctx, current, 'recovering'),
      startOld: (ctx) => start(ctx, current),
      oldHealth: (ctx) => health(ctx, current),
      async enableNew(ctx) {
        // The kernel rechecks a prior completed installation before beginning a
        // new update. This proves that existing commit; it does not replay it.
        if (
          previousCompletion &&
          ctx.transactionId === previousCompletion.transactionId &&
          ctx.package.id === current.id &&
          ctx.package.sha256 === current.sha256
        ) {
          own();
          pin(p.previousCompletion.journal);
          pin(p.previousCompletion.permit);
          api.toolkit.sameIdentity(
            await native.processIdentity(
              'OwnedSnapshot',
              oldProcess.pid,
              p.port || 4000,
              oldProcess,
            ),
            oldProcess,
          );
          return;
        }

        const completed = journalStage(ctx, 'completed');
        if (p.runtimeMode) {
          modeEnvironment(p.runtimeMode, p.database, { initial: true });
          atomic(p.journalFile, { ...completed, runtimeMode: p.runtimeMode });
        }
        atomic(permitFile, {
          format: 1,
          transactionId: ctx.transactionId,
          id: next.id,
          sha256: next.sha256,
          stage: 'completed',
        });
      },
    };
    return await createUpdater({
      journalFile: p.journalFile,
      adapter,
      onProgress: report,
    }).update({ path: next.path, sha256: next.sha256 });
  } catch (error) {
    if (maintenance) {
      try {
        await maintenance.closeFailed();
      } catch (closeError) {
        throw new AggregateError(
          [error, closeError],
          'FIXED_INSTALL_HELD_AND_CLOSE_UNCERTAIN',
          { cause: error },
        );
      }
    }
    throw error;
  } finally {
    for (const session of sessions.reverse()) session.release();
  }
}
async function run(plan, report = () => {}) {
  if (
    plan?.kind !== 'fixed-profile-maintenance-dispatch-v1' ||
    plan.executionMode !== 'final-install' ||
    !plan.profile
  )
    fail('FIXED_DISPATCH_PLAN_REQUIRED');
  const token = verifyFixedProfile(plan.profile.path, plan.profile.sha256),
    p = fixedProfile(token).profile;
  for (const key of [
    'projectRoot',
    'releasesRoot',
    'database',
    'backupDataRoot',
    'journalFile',
    'current',
    'candidate',
    'runtimeMode',
    'previousCompletion',
  ])
    if (JSON.stringify(plan[key]) !== JSON.stringify(p[key]))
      fail('FIXED_DISPATCH_PROFILE_CHANGED');
  return withFixedCode(p.closure, () => runProfileInner(token, report));
}
module.exports = { runFixedProfile, run, quiet };
