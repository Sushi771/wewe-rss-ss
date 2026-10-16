const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { processIdentity, portOwnersAsync, stopOwned } = require('./switch.cjs');

const windows = { skip: process.platform !== 'win32', timeout: 90000 };

test(
  'pre-stop native identity adapter refuses an owned live controller and confirms its observed exit',
  windows,
  async () => {
    const { execFileSync } = require('node:child_process'),
      fs = require('node:fs'),
      path = require('node:path');
    const shell = fs.realpathSync.native(
      path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
    );
    const child = spawn(
      process.execPath,
      [
        '-e',
        "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))",
      ],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] },
    );
    const closed = once(child, 'close');
    try {
      const controller = JSON.parse(
        execFileSync(
          shell,
          [
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            `$ErrorActionPreference='Stop';$p=[Diagnostics.Process]::GetProcessById(${child.pid});$c=Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}';[ordered]@{pid=$p.Id;startUtc=$p.StartTime.ToUniversalTime().ToString('o');executable=$c.ExecutablePath;commandLine=$c.CommandLine}|ConvertTo-Json -Compress`,
          ],
          { windowsHide: true, encoding: 'utf8', timeout: 15000 },
        ),
      );
      const u = {
        environmentFiles: [],
        python: { path: 'unused-python' },
        schemaEngine: { path: 'unused-engine' },
        powershellSha256: require('./lib.cjs').fileHash(shell),
      };
      const native = require('./once-pair-publication.cjs').nativeOperations(
        { publication: u },
        u,
        'unused-audit',
        () => {},
      );
      assert.throws(
        () => native.identity('ControllerExited', child.pid, controller),
        (e) => String(e.stderr).includes('CONTROLLER_STILL_PRESENT'),
      );
      assert.equal(child.exitCode, null);
      child.stdin.end();
      await closed;
      assert.deepEqual(
        native.identity('ControllerExited', child.pid, controller),
        {
          format: 1,
          pid: child.pid,
          exited: true,
          observation: 'current-pid-absence-only',
        },
      );
      assert.throws(
        () => native.identity('ControllerExited', 0),
        (e) => String(e.stderr).includes('CONTROLLER_PID_REQUIRED'),
      );
    } finally {
      child.stdin.end();
      await closed;
    }
  },
);

// Load the actual module with explicit, inert process boundaries. This makes
// fallback/integrity paths deterministic without a compiler cache or native query.
function isolatedPortQuery({ force, tool, stdout, failure, at }) {
  const fs = require('node:fs'),
    path = require('node:path');
  const calls = [];
  const execFile = () => {
    throw Error('UNEXPECTED_CALLBACK_DISPATCH');
  };
  execFile[require('node:util').promisify.custom] = async (...args) => {
    calls.push('execFile');
    if (at === 'execFile') throw failure;
    return { stdout, stderr: '' };
  };
  const lib = {
    hostEffects: { fs: {}, processes: { execFile } },
    cleanEnvironment: () => ({}),
    run() {
      calls.push('run');
      if (at === 'run') throw failure;
      return stdout;
    },
  };
  const load = require('node:module').createRequire(__filename);
  const mockRequire = (name) => {
    if (name === './lib.cjs') return lib;
    if (name === './identity-tool.cjs')
      return {
        identityTool() {
          calls.push('identityTool');
          if (at === 'identityTool') throw failure;
          return tool;
        },
      };
    if (!name.startsWith('node:')) throw Error('UNEXPECTED_MODULE');
    return load(name);
  };
  const module = { exports: {} };
  const query = new Function(
    'require',
    '__dirname',
    'module',
    'process',
    fs.readFileSync(path.join(__dirname, 'switch.cjs'), 'utf8') +
      '\nreturn module.exports.portOwnersAsync;',
  )(mockRequire, __dirname, module, {
    platform: 'win32',
    env: { LOCAL_RELEASE_FORCE_POWERSHELL: force },
  });
  return { query, calls };
}

for (const [name, options, expected] of [
  ['forced PowerShell', { force: '1', at: 'run' }, ['run']],
  [
    'unavailable compiled helper',
    { at: 'run' },
    ['identityTool', 'identityTool', 'run'],
  ],
  ['compiled helper integrity', { at: 'identityTool' }, ['identityTool']],
  [
    'compiled query failure',
    { tool: 'inert-helper', at: 'execFile' },
    ['identityTool', 'execFile'],
  ],
])
  test('portOwnersAsync preserves rejection contract: ' + name, async () => {
    const failure = Error('OWNED_QUERY_FAILURE'),
      { query, calls } = isolatedPortQuery({ ...options, failure });
    let result;
    assert.doesNotThrow(() => {
      result = query(0);
    });
    assert(result instanceof Promise);
    await assert.rejects(result, (error) => error === failure);
    assert.deepEqual(calls, expected);
  });

for (const tool of [undefined, 'inert-helper'])
  test(
    'portOwnersAsync resolves a verified empty result: ' +
      (tool ? 'compiled' : 'fallback'),
    async () => {
      const { query } = isolatedPortQuery({ tool, stdout: '[]' });
      const result = query(4000);
      assert(result instanceof Promise);
      assert.deepEqual(await result, []);
    },
  );

test('portOwnersAsync rejects malformed output instead of reporting a free port', async () => {
  const { query } = isolatedPortQuery({
    tool: 'inert-helper',
    stdout: 'not-json',
  });
  await assert.rejects(query(4000), SyntaxError);
});

test(
  'exact auxiliary identity waits for owned stdin EOF without terminating a different identity',
  windows,
  async () => {
    const { execFile, execFileSync } = require('node:child_process');
    const { promisify } = require('node:util');
    const path = require('node:path');
    const shell = path.join(
      process.env.SystemRoot || 'C:\\Windows',
      'System32/WindowsPowerShell/v1.0/powershell.exe',
    );
    const helper = path.join(__dirname, 'process-identity.ps1');
    const start = () =>
      spawn(
        process.execPath,
        [
          '-e',
          "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))",
        ],
        { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] },
      );
    const children = [start(), start()];
    const closed = Promise.all(children.map((child) => once(child, 'close')));
    try {
      const pins = children.map((child) =>
        JSON.parse(
          execFileSync(
            shell,
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `$ErrorActionPreference='Stop';$p=[Diagnostics.Process]::GetProcessById(${child.pid});$c=Get-CimInstance Win32_Process -Filter 'ProcessId=${child.pid}';[ordered]@{pid=$p.Id;parentPid=[int]$c.ParentProcessId;startUtc=$p.StartTime.ToUniversalTime().ToString('o');executable=$c.ExecutablePath;commandLine=$c.CommandLine}|ConvertTo-Json -Compress`,
            ],
            { windowsHide: true, encoding: 'utf8', timeout: 15000 },
          ),
        ),
      );
      assert(pins.every((pin) => pin.parentPid === process.pid));
      const args = (action, values = pins) => [
        '-NoProfile',
        '-NonInteractive',
        '-File',
        helper,
        '-Action',
        action,
        '-Port',
        '4000',
        '-ExpectedAuxiliaryJson',
        JSON.stringify(values),
      ];
      assert.throws(
        () =>
          execFileSync(
            shell,
            args('AuxiliarySnapshot', [
              {
                ...pins[0],
                startUtc: '2000-01-01T00:00:00.0000000Z',
              },
            ]),
            { windowsHide: true, stdio: 'pipe', timeout: 15000 },
          ),
        (error) =>
          String(error.stderr).includes('EXACT_AUXILIARY_IDENTITY_CHANGED'),
      );
      assert(children.every((child) => child.exitCode === null));
      const snapshot = JSON.parse(
        execFileSync(shell, args('AuxiliarySnapshot'), {
          windowsHide: true,
          encoding: 'utf8',
          timeout: 15000,
        }),
      );
      assert.equal(snapshot.verifiedCount, 2);
      assert.equal(snapshot.exited, false);
      const waiting = promisify(execFile)(shell, args('WaitAuxiliary'), {
        windowsHide: true,
        encoding: 'utf8',
        timeout: 65000,
      });
      const endInput = setTimeout(
        () => children.forEach((child) => child.stdin.end()),
        2000,
      );
      let result;
      try {
        result = JSON.parse((await waiting).stdout);
      } finally {
        clearTimeout(endInput);
      }
      assert.equal(result.verifiedCount, 2);
      assert.equal(result.exited, true);
      assert.deepEqual(result.remainingPids, []);
      assert((await closed).every(([code]) => code === 0));
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
    }
  },
);

test(
  'asynchronous port check rejects invalid ports rather than treating failure as free',
  windows,
  async () => {
    const prior = process.env.LOCAL_RELEASE_FORCE_POWERSHELL;
    try {
      for (const force of [undefined, '1']) {
        if (force === undefined)
          delete process.env.LOCAL_RELEASE_FORCE_POWERSHELL;
        else process.env.LOCAL_RELEASE_FORCE_POWERSHELL = force;
        for (const port of [0, 65536]) {
          let result;
          assert.doesNotThrow(() => {
            result = portOwnersAsync(port);
          });
          assert(result instanceof Promise);
          await assert.rejects(result);
        }
      }
    } finally {
      if (prior === undefined)
        delete process.env.LOCAL_RELEASE_FORCE_POWERSHELL;
      else process.env.LOCAL_RELEASE_FORCE_POWERSHELL = prior;
    }
  },
);

test(
  'native Windows table verifies IPv4 and IPv6 listener ownership and closed ports',
  windows,
  async () => {
    for (const address of ['127.0.0.1', '::1']) {
      const listener = net.createServer();
      listener.listen(0, address);
      await once(listener, 'listening');
      const port = listener.address().port;
      try {
        assert.deepEqual(processIdentity('Port', undefined, port), [
          { LocalAddress: address, OwningProcess: process.pid },
        ]);
        assert.deepEqual(
          await portOwnersAsync(port),
          processIdentity('Port', undefined, port),
        );
        const identity = processIdentity('Snapshot', process.pid, port);
        assert.equal(identity.pid, process.pid);
        assert.equal(identity.port, port);
        assert.deepEqual(identity.localAddresses, [address]);
        assert.equal(
          identity.executable.toLowerCase(),
          process.execPath.toLowerCase(),
        );
        assert.ok(identity.startUtc && identity.commandLine);
        const prior = process.env.LOCAL_RELEASE_FORCE_POWERSHELL;
        try {
          process.env.LOCAL_RELEASE_FORCE_POWERSHELL = '1';
          assert.deepEqual(
            await portOwnersAsync(port),
            processIdentity('Port', undefined, port),
          );
          assert.deepEqual(
            processIdentity('Snapshot', process.pid, port),
            identity,
          );
        } finally {
          if (prior === undefined)
            delete process.env.LOCAL_RELEASE_FORCE_POWERSHELL;
          else process.env.LOCAL_RELEASE_FORCE_POWERSHELL = prior;
        }
        const accepted = once(listener, 'connection');
        const client = net.connect(port, address);
        await once(client, 'connect');
        const [socket] = await accepted;
        try {
          // The native listener table must exclude both established endpoints,
          // even when one shares the listener's local port and owning PID.
          assert.deepEqual(processIdentity('Port', undefined, port), [
            { LocalAddress: address, OwningProcess: process.pid },
          ]);
          assert.deepEqual(
            processIdentity('Port', undefined, client.localPort),
            [],
          );
          assert.throws(() =>
            processIdentity('Snapshot', process.pid, client.localPort),
          );
        } finally {
          client.destroy();
          socket.destroy();
        }
        assert.throws(() =>
          processIdentity('Stop', process.pid, port, {
            ...identity,
            startUtc: '2000-01-01T00:00:00.0000000Z',
          }),
        );
        assert.equal(
          processIdentity('Snapshot', process.pid, port).startUtc,
          identity.startUtc,
        );
      } finally {
        await new Promise((resolve) => listener.close(resolve));
      }
      assert.deepEqual(processIdentity('Port', undefined, port), []);
      assert.deepEqual(await portOwnersAsync(port), []);
      assert.throws(() => processIdentity('Snapshot', process.pid, port));
    }
  },
);

test(
  'foreign PID is refused and Stop kills only the fully matched fixture process',
  windows,
  async () => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>console.log(s.address().port));",
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    try {
      const [chunk] = await once(child.stdout, 'data');
      const port = Number(chunk.toString().trim());
      assert.ok(port > 0);
      assert.throws(() => processIdentity('Snapshot', process.pid, port));
      const identity = processIdentity('Snapshot', child.pid, port);
      for (const field of ['executable', 'commandLine']) {
        assert.throws(() =>
          processIdentity('Stop', child.pid, port, {
            ...identity,
            [field]: identity[field] + '-mismatch',
          }),
        );
        assert.equal(
          processIdentity('Snapshot', child.pid, port).startUtc,
          identity.startUtc,
        );
      }
      assert.equal(
        processIdentity('Stop', child.pid, port, identity).stopped,
        true,
      );
      assert.deepEqual(processIdentity('Port', undefined, port), []);
    } finally {
      await stopOwned(child);
    }
  },
);
