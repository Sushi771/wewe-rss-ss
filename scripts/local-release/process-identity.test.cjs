const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { processIdentity, stopOwned } = require('./switch.cjs');

const windows = { skip: process.platform !== 'win32', timeout: 90000 };

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
