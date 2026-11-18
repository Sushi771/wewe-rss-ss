'use strict';
// Test-only fixture. It owns fresh temporary processes, DBs and pointers; the
// scheduled-task controller is explicitly simulated and cannot touch Windows tasks.
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  crypto = require('node:crypto'),
  cp = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const {
  freezeControlSources,
  freezeFixedProfile,
} = require('./fixed-driver-profile.cjs');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const pin = (file) => ({ path: file, sha256: sha(fs.readFileSync(file)) });
const write = (file, bytes) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return pin(file);
};
const normalized = (file) =>
  fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const repository = path.resolve(__dirname, '../../..');
async function fixture(run, options = {}) {
  const temp = fs.realpathSync.native(os.tmpdir());
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(temp, 'fixed-native-fixture-')),
  );
  const projectRoot = path.join(root, 'project'),
    control = path.join(root, 'control'),
    releasesRoot = path.join(projectRoot, '.local-releases');
  const database = path.join(projectRoot, 'apps/server/data/wewe-rss.db'),
    backupDataRoot = path.join(root, 'backups');
  fs.mkdirSync(path.dirname(database), { recursive: true });
  fs.mkdirSync(control);
  fs.mkdirSync(backupDataRoot);
  const originals = process.env.WEWE_FORMAL_NATIVE_SOURCE;
  const originalLocks = process.env.WEWE_FORMAL_LOCK_SOURCE;
  if (
    !path.isAbsolute(originals || '') ||
    !path.isAbsolute(originalLocks || '') ||
    !path.isAbsolute(process.env.WEWE_TEST_PYTHON || '')
  )
    throw Error('EXPLICIT_NATIVE_FIXTURE_MATERIALS_REQUIRED');
  for (const name of [
    'installer-private-context.cjs',
    'install-stop-retire.cjs',
    'writer-tree-lineage-isolated.cjs',
    'retired-observation.cjs',
    'process-identity.exe',
  ])
    fs.copyFileSync(path.join(originals, name), path.join(control, name));
  if (
    pin(path.join(control, 'process-identity.exe')).sha256 !==
    'a916cb1618fdc91daec9285f14800fbfc4616d77ba67cfddad0980bfcdb7b620'
  )
    throw Error('REVIEWED_NATIVE_SOURCE_CHANGED');
  for (const name of [
    'lock-session.cjs',
    'task-lifecycle.cjs',
    'safe-env.cjs',
    'installation-instance.cjs',
  ])
    fs.copyFileSync(path.join(originalLocks, name), path.join(control, name));
  // Only task I/O is synthetic; original begin/restore validations are reused.
  write(
    path.join(control, 'fixture-tasks.cjs'),
    `const fs=require('node:fs'); const base=require('./task-lifecycle.cjs'); const file=__filename+'.state';
const identity=require('./installation-instance.cjs').taskIdentity;
module.exports={...base,control(action){let s=JSON.parse(fs.readFileSync(file)); if(action==='Disable'){if(${options.taskPauseFails === true})throw Error('SYNTHETIC_TASK_PAUSE_DENIED');s.enabled=false;s.state='Disabled';}else if(action==='Restore'){s.enabled=true;s.state='Ready';}else if(action!=='Snapshot')throw Error('FIXTURE_TASK_ACTION');fs.writeFileSync(file,JSON.stringify(s));return s;}};
`,
  );
  const taskDefinitionSha256 = sha('explicit synthetic task definition');
  write(
    path.join(control, 'fixture-tasks.cjs.state'),
    JSON.stringify({
      identity: require(path.join(control, 'installation-instance.cjs'))
        .taskIdentity,
      identityMatches: true,
      definitionSha256: taskDefinitionSha256,
      instances: 0,
      enabled: true,
      state: 'Ready',
      lastRunUtc: '2026-11-01T00:00:00Z',
    }),
  );
  const net = require('node:net'),
    probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const runtime = `const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const at=n=>process.argv[process.argv.indexOf(n)+1], database=at('--database'),port=Number(at('--port'));
const release=__dirname,manifest=JSON.parse(fs.readFileSync(path.join(release,'release.json'))),crypto=require('node:crypto');
Object.assign(process.env,require('./managed-runtime-mode.cjs').committed({journalFile:path.join(path.dirname(database),'.wewe-update.json'),releaseId:manifest.id,manifestSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(release,'release.json'))).digest('hex'),database}));
const gate=require('./installed-startup-gate.cjs').install({release,manifest,database});
const writer=gate.holdWriterGate(require('./project-writer-gate.cjs'));writer.acquireWriter(database);
if(process.env.WEWE_UPDATE_TRANSACTION)gate.waitUntilPermitted().then(ok=>{if(ok)gate.markDatabaseWritable();});
const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(database,{readOnly:true});db.exec('PRAGMA query_only=ON');
const server=http.createServer((req,res)=>{if(req.url==='/startup-status'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({status:gate.writesAllowed()?'ready':'verifying',writesAllowed:gate.writesAllowed(),databaseRecovery:'ready'}));}
if(req.url!=='/_local/update-health'){res.statusCode=503;return res.end();}
if(manifest.fixtureHealthBad){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({id:'wrong'}));}
db.prepare('SELECT count(*) FROM feeds').get();res.setHeader('Content-Type','application/json');res.end(JSON.stringify(gate.health(true)));});
server.listen(port,'127.0.0.1');
`;
  const catalog = JSON.parse(
    fs.readFileSync(
      path.join(
        __dirname,
        'install-binding/role-aware/switch-schema-contract.json',
      ),
    ),
  ).profiles.canonical35;
  const roles = {};
  for (const [role, id, char] of [
    ['current', 'fixture-old', 'a'],
    ['candidate', 'fixture-new', 'b'],
  ]) {
    const folder = path.join(releasesRoot, id),
      files = {};
    const add = (name, content) => {
      files[name] = write(path.join(folder, name), content).sha256;
    };
    fs.mkdirSync(path.join(folder, 'runtime'), { recursive: true });
    fs.copyFileSync(process.execPath, path.join(folder, 'runtime/node.exe'));
    files['runtime/node.exe'] = pin(
      path.join(folder, 'runtime/node.exe'),
    ).sha256;
    add('runtime.cjs', runtime);
    add(
      'project-writer-gate.cjs',
      normalized(
        path.join(repository, 'scripts/local-release/project-writer-gate.cjs'),
      ),
    );
    add(
      'managed-runtime-mode.cjs',
      normalized(
        path.join(repository, 'scripts/local-release/managed-runtime-mode.cjs'),
      ),
    );
    add(
      'installed-startup-gate.cjs',
      normalized(
        path.join(
          repository,
          'scripts/local-release/installed-startup-gate.cjs',
        ),
      ),
    );
    add(
      'server/prisma/schema.prisma',
      fs.readFileSync(
        path.join(repository, 'apps/server/prisma/schema.prisma'),
      ),
    );
    for (const m of catalog.migrations) {
      const input = fs.readFileSync(
        path.join(
          repository,
          'apps/server/prisma/migrations',
          m.name,
          'migration.sql',
        ),
      );
      const bytes =
        sha(input) === m.sha256
          ? input
          : Buffer.from(input.toString('utf8').replace(/\r\n/g, '\n'));
      if (sha(bytes) !== m.sha256)
        throw Error('FIXTURE_TRUSTED_MIGRATION_CHANGED');
      add('server/prisma/migrations/' + m.name + '/migration.sql', bytes);
    }
    for (const n of [
      'lib.cjs',
      'switch-contract.cjs',
      'switch-prewrite.cjs',
      'task-document-preflight.cjs',
      'switch-schema-contract.json',
    ])
      add(n, normalized(path.join(__dirname, 'install-binding/role-aware', n)));
    add('engine.node', 'synthetic engine bytes never executed');
    const manifest = {
      format: 1,
      id,
      platform: process.platform,
      arch: process.arch,
      sourceCommit: char.repeat(40),
      sourceHash: char.repeat(64),
      schemaCompatibility: 'current',
      desktopHelperIncluded: false,
      files,
      links: {},
      installedLifecycle: {
        format: 1,
        protocol: 'wewe-installed-lifecycle-v1',
        journalBasename: '.wewe-update.json',
        writeHoldProtocol: 'project-writer-prisma-query-only-v1',
      },
      prisma: {
        clientVersion: '5.22.0',
        cliVersion: '5.22.0',
        engineCommit: 'c'.repeat(40),
        engineSha256: files['engine.node'],
      },
      prewriteSchemaContract: {
        format: 1,
        file: 'switch-schema-contract.json',
        sha256: files['switch-schema-contract.json'],
        gateSha256: files['switch-prewrite.cjs'],
      },
    };
    if (role === 'candidate' && options.candidateHealthBad)
      manifest.fixtureHealthBad = true;
    const m = write(
      path.join(folder, 'release.json'),
      JSON.stringify(manifest),
    );
    roles[role] = {
      id,
      path: folder,
      sha256: m.sha256,
      sourceCommit: manifest.sourceCommit,
    };
  }
  const db = new DatabaseSync(database);
  db.exec(
    catalog.objects.find(
      (o) => o.name === '_prisma_migrations' && o.type === 'table',
    ).sql,
  );
  for (const migration of catalog.migrations) {
    db.exec(
      fs.readFileSync(
        path.join(
          roles.current.path,
          'server/prisma/migrations',
          migration.name,
          'migration.sql',
        ),
        'utf8',
      ),
    );
    db.prepare(
      'INSERT INTO _prisma_migrations(id,checksum,finished_at,migration_name,started_at,applied_steps_count) VALUES(?,?,?,?,?,1)',
    ).run(
      crypto.randomUUID(),
      migration.receiptSha256,
      '2026-11-01T00:00:00Z',
      migration.name,
      '2026-11-01T00:00:00Z',
    );
  }
  let retainedQueue;
  if (options.coldStart) {
    db.prepare(
      'INSERT INTO refresh_submission_claims(id,mp_id,state,reserved_at,previous_at,updated_at_ms) VALUES(?,?,?,?,?,?)',
    ).run('d'.repeat(64), 'MP_WXS_1234567890', 'unknown', 1, 0, 1);
    db.prepare(
      'INSERT INTO xhs_unbound_owner_reviews VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      'synthetic-retained-review',
      'e'.repeat(64),
      '{}',
      'unknown',
      '[]',
      '[]',
      '{}',
      '{}',
      '{}',
      'f'.repeat(64),
      1,
    );
    for (let i = 0; i < 3; i++)
      db.prepare(
        'INSERT INTO xhs_unbound_owner_requests(operation_id,review_id,task_id,creator_id,phase,logical_target,outcome) VALUES(?,?,?,?,?,?,?)',
      ).run(
        'synthetic-unknown-' + i,
        'synthetic-retained-review',
        'synthetic-old-task',
        'synthetic-creator',
        'detail',
        'synthetic-note-' + i,
        'unknown',
      );
    retainedQueue = path.join(
      path.dirname(database),
      '.wechat2rss-subscription-batches',
      '11111111-1111-4111-8111-111111111111.json',
    );
    write(
      retainedQueue,
      JSON.stringify({
        version: 1,
        batchId: path.basename(retainedQueue, '.json'),
        purpose: 'scheduled-refresh',
        instance: sha('synthetic-instance'),
        signature: sha('synthetic-round'),
        state: 'running',
        createdAt: 1,
        updatedAt: 1,
        nextSubmissionAt: 0,
        items: Array.from({ length: 8 }, (_, index) => ({
          index,
          state: 'queued',
          feedId: 'MP_WXS_' + (1234567890 + index),
          message: 'retained-unsent',
        })),
      }),
    );
  }
  db.close();
  const python = fs.realpathSync.native(process.env.WEWE_TEST_PYTHON),
    helper = path.join(repository, 'apps/server/scripts/backup-sqlite.py');
  const report = JSON.parse(
    cp.execFileSync(
      python,
      ['-B', helper, '--database', database, '--backup-root', backupDataRoot],
      {
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      },
    ),
  );
  const inventoryCode = `import importlib.util,json;from pathlib import Path;s=importlib.util.spec_from_file_location('owner',${JSON.stringify(path.join(__dirname, 'reuse-owner-backend.py'))});m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps(m.inventory(Path(${JSON.stringify(backupDataRoot)}))))`;
  const inventory = JSON.parse(
    cp.execFileSync(python, ['-B', '-c', inventoryCode], {
      encoding: 'utf8',
      windowsHide: true,
    }),
  );
  const pointer = write(
    path.join(releasesRoot, 'active.json'),
    JSON.stringify({ format: 1, id: roles.current.id }) + '\n',
  );
  const toolkit = require('./pinned-native-toolkit.cjs').createPinnedToolkit(
    pin(path.join(control, 'process-identity.exe')),
  );
  let child, oldProcess, oldPin;
  if (!options.coldStart) {
    child = cp.spawn(
      path.join(roles.current.path, 'runtime/node.exe'),
      [
        path.join(roles.current.path, 'runtime.cjs'),
        'start',
        '--database',
        database,
        '--port',
        String(port),
        '--production',
      ],
      {
        windowsHide: true,
        stdio: 'ignore',
        env: { ...process.env, WEWE_UPDATE_READ_ONLY: '0' },
      },
    );
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw Error('FIXTURE_OLD_CHILD_EXITED');
      try {
        oldProcess = toolkit.processIdentity('Snapshot', child.pid, port);
        if (oldProcess.localAddresses?.includes('127.0.0.1')) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!oldProcess?.localAddresses?.includes('127.0.0.1'))
      throw Error('FIXTURE_NATIVE_LISTENER_UNPROVEN');
    oldPin = write(
      path.join(control, 'old-process.json'),
      JSON.stringify(oldProcess),
    );
  }
  const scope = require(path.join(control, 'installer-private-context.cjs'));
  const asRelease = (role) => ({
    ...roles[role],
    manifest: JSON.parse(
      fs.readFileSync(path.join(roles[role].path, 'release.json')),
    ),
  });
  const currentBytes = scope.measureRole(asRelease('current')),
    candidateBytes = scope.measureRole(asRelease('candidate')),
    reserveBytes = 1024 * 1024;
  const policy = write(
    path.join(control, 'owner-plan.json'),
    JSON.stringify({
      kind: 'installer-private-maintenance-plan-v1',
      current: roles.current,
      candidate: roles.candidate,
      database,
      releasesRoot,
      activePointerSha256: pointer.sha256,
      rootRoles: {
        current: {
          path: roles.current.path,
          manifestSha256: roles.current.sha256,
        },
        candidateDestination: roles.candidate.path,
      },
      budget: {
        currentBytes,
        candidateBytes,
        reserveBytes,
        maxGrowthBytes: candidateBytes + 1024 * 1024,
        maxManagedBytes: currentBytes + candidateBytes + 1024 * 1024,
        minFreeBytes: 4 * 1024 ** 3,
      },
    }),
  );
  const modules = {
    scope: pin(path.join(control, 'installer-private-context.cjs')),
    stopRetire: pin(path.join(control, 'install-stop-retire.cjs')),
    toolkit: pin(path.join(__dirname, 'pinned-native-toolkit.cjs')),
    writerGate: pin(
      path.join(repository, 'scripts/local-release/project-writer-gate.cjs'),
    ),
    lockSession: pin(path.join(control, 'lock-session.cjs')),
    tasks: pin(path.join(control, 'fixture-tasks.cjs')),
    restart: pin(path.join(repository, 'scripts/local-release/restart.cjs')),
  };
  const controls = [
    'preserving-contract.cjs',
    'reference-diagnostics.cjs',
    'release-scope.cjs',
    'restart.cjs',
  ].map((name) => ({
    ...pin(path.join(repository, 'scripts/local-release', name)),
    relative: 'scripts/local-release/' + name,
  }));
  // The test owner supplies the reviewed Git preimage explicitly. Formatting or
  // changing a control file requires a fresh freeze; never adopt candidate hashes.
  const controlCommit = process.env.WEWE_TEST_CONTROL_COMMIT;
  if (!/^[a-f0-9]{40}$/.test(controlCommit || ''))
    throw Error('EXPLICIT_REVIEWED_CONTROL_COMMIT_REQUIRED');
  const trustedControlSource = freezeControlSources({
    repository,
    commit: controlCommit,
    files: controls,
  });
  const closure = new Map();
  function addFiles(folder) {
    for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'evidence') continue;
      const f = path.join(folder, e.name);
      if (e.isDirectory()) addFiles(f);
      else if (e.isFile() && /\.(?:cjs|json|py|exe|ps1)$/.test(e.name))
        closure.set(f, pin(f));
    }
  }
  addFiles(path.join(repository, 'scripts/local-release'));
  addFiles(control);
  closure.set(python, pin(python));
  closure.set(helper, pin(helper));
  const currentGate = path.join(roles.current.path, 'project-writer-gate.cjs');
  closure.set(currentGate, pin(currentGate));
  // Python's Windows inode/volume representation differs from Node's. Pin the
  // identity in the same runtime that owns the full-snapshot OS lock.
  const sourceIdentity = JSON.parse(
    cp.execFileSync(
      python,
      [
        '-B',
        '-c',
        `import os,json;s=os.stat(${JSON.stringify(database)});print(json.dumps([str(s.st_dev),str(s.st_ino)]))`,
      ],
      { encoding: 'utf8', windowsHide: true },
    ),
  );
  let runtimeMode;
  if (options.manualMode || options.scheduledDualMode) {
    const archives = {};
    for (const channel of ['wechat', 'xiaohongshu']) {
      const folder = path.join(
        path.dirname(database),
        '.collection-channel-control',
        channel,
      );
      const archived = [
        {
          kind: channel === 'wechat' ? 'wechat-batch' : 'xhs-task',
          id: 'retained',
          digest: sha('synthetic retained evidence'),
        },
      ];
      write(
        path.join(folder, 'state.json'),
        JSON.stringify({
          version: 1,
          revision: 1,
          paused: true,
          archived,
          receipts: [
            {
              digest: sha('synthetic archive'),
              backupSha256: report.sha256,
              at: Date.now(),
            },
          ],
        }),
      );
      archives[channel] = require('../managed-runtime-mode.cjs').digest(
        archived,
      );
    }
    runtimeMode = {
      kind: options.scheduledDualMode ? 'scheduled-dual-v1' : 'manual-xhs-v1',
      channelArchives: archives,
    };
  }
  let previousCompletion;
  if (options.previousCompletion) {
    if (!oldProcess) throw Error('FIXTURE_PREVIOUS_LIVE_PROCESS_REQUIRED');
    const transactionId = crypto.randomUUID(),
      journal = path.join(path.dirname(database), '.wewe-update.json');
    const values = {
      journal: {
        format: 1,
        transactionId,
        stage: options.previousCompletionStage || 'completed',
        package: { ...roles.current, database },
        old: { id: 'synthetic-ancestor', sha256: 'f'.repeat(64) },
      },
      permit: {
        format: 1,
        transactionId,
        stage: 'completed',
        id: roles.current.id,
        sha256: roles.current.sha256,
      },
      registry: {
        format: 1,
        database,
        processes: [
          { transactionId, releaseId: roles.current.id, identity: oldProcess },
        ],
      },
      control: {
        format: 1,
        profileSha256: 'e'.repeat(64),
        taskBefore: { definitionSha256: taskDefinitionSha256 },
        events: [],
      },
    };
    previousCompletion = {};
    for (const [key, suffix] of Object.entries({
      journal: '',
      control: '.control',
      registry: '.native-processes',
      permit: '.permit',
    }))
      previousCompletion[key] = write(
        journal + suffix,
        JSON.stringify(values[key]),
      );
  }
  const rawProfile = {
    ...(runtimeMode ? { runtimeMode } : {}),
    ...(previousCompletion ? { previousCompletion } : {}),
    kind: 'fixed-held-same-schema-maintenance-v1',
    executionMode: 'final-install',
    projectRoot,
    releasesRoot,
    database,
    backupDataRoot,
    journalFile: path.join(path.dirname(database), '.wewe-update.json'),
    python,
    pythonSha256: pin(python).sha256,
    port,
    reserveBytes,
    ...roles,
    ...(options.coldStart
      ? {
          startMode: 'cold-empty',
          coldObservation: pin(
            path.join(__dirname, 'cold-project-observation.ps1'),
          ),
        }
      : { oldProcess: oldPin }),
    scopePolicy: policy,
    taskDefinitionSha256,
    activePointerSha256: pointer.sha256,
    modules,
    nativeTool: pin(path.join(control, 'process-identity.exe')),
    closure: [...closure.values()],
    backup: {
      mode: 'exact-protected-reuse-v1',
      path: report.backup,
      sha256: report.sha256,
      sourceIdentity,
      helper: pin(helper),
      inventory,
      limits: [16 * 1024 ** 3, 9, 4 * 1024 ** 3],
    },
  };
  const proposal = freezeFixedProfile({
    profile: rawProfile,
    controlSource: {
      repository,
      commit: trustedControlSource.commit,
      files: controls,
    },
    expected: {
      ...roles,
      controlCommit: trustedControlSource.commit,
      ...(runtimeMode ? { runtimeMode } : {}),
      ...(previousCompletion ? { previousCompletion } : {}),
    },
  });
  const profile = proposal.profile;
  const profilePin = write(
    path.join(control, 'fixed-profile.json'),
    proposal.text,
  );
  const refresh = () => write(profilePin.path, JSON.stringify(profile));
  const before = fs.readFileSync(database);
  const extraIdentities = [];
  try {
    await run({
      root,
      control,
      profile,
      profilePin,
      roles,
      oldProcess,
      toolkit,
      child,
      before,
      database,
      refresh,
      write,
      pin,
      scope,
      modules,
      retainedQueue,
      trackCleanup: (value) => extraIdentities.push(value),
    });
  } finally {
    // Stop only actual fixture-owned matching native identities, never PID alone.
    const identities = [oldProcess, ...extraIdentities].filter(Boolean);
    const registry = profile.journalFile + '.native-processes';
    if (fs.existsSync(registry))
      identities.push(
        ...JSON.parse(fs.readFileSync(registry)).processes.map(
          (p) => p.identity,
        ),
      );
    for (const expected of identities) {
      const metadata = toolkit.processIdentity(
        'TreeMetadata',
        expected.pid,
        port,
      );
      const same = (row) =>
        row.pid === expected.pid &&
        row.executable?.toLowerCase() === expected.executable.toLowerCase() &&
        row.commandLine === expected.commandLine &&
        Math.abs(Date.parse(row.startUtc) - Date.parse(expected.startUtc)) <
          1000;
      if (metadata.complete !== true || !Array.isArray(metadata.active))
        throw Error('FIXTURE_EXIT_OBSERVATION_INCOMPLETE');
      if (metadata.active.some(same))
        toolkit.processIdentity('OwnedStop', expected.pid, port, expected);
      const after = toolkit.processIdentity('TreeMetadata', expected.pid, port);
      if (after.complete !== true || after.active.some(same))
        throw Error('FIXTURE_EXIT_UNPROVEN');
    }
    if (
      path.dirname(root) !== temp ||
      !path.basename(root).startsWith('fixed-native-fixture-')
    )
      throw Error('FIXTURE_CLEANUP_PATH_CHANGED');
    fs.rmSync(root, { recursive: true, force: true });
  }
}
module.exports = { fixture, pin, write };
