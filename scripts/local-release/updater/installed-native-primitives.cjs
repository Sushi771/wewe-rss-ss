'use strict';
// Concrete primitives over existing identity/publication APIs; no effects on import.
const fs = require('node:fs'),
  path = require('node:path'),
  cp = require('node:child_process');
const fail = (code) => {
  throw Error(code);
};
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
function write(file, value) {
  const temp = file + '.' + require('node:crypto').randomUUID() + '.tmp',
    fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}
function createNativePrimitives(
  {
    scopeLease,
    toolkit,
    publication,
    releasesRoot,
    database,
    port = 4000,
    healthPath = '/_local/update-health',
  },
  effects = {},
) {
  if (
    typeof scopeLease?.check !== 'function' ||
    typeof scopeLease?.assertWritable !== 'function'
  )
    fail('REAL_NATIVE_SCOPE_REQUIRED');
  for (const method of [
    'processIdentity',
    'sameIdentity',
    'observeProjectWriters',
    'waitReady',
  ])
    if (typeof toolkit?.[method] !== 'function')
      fail('PINNED_IDENTITY_TOOLKIT_REQUIRED');
  const pointer = path.join(releasesRoot, 'active.json');
  if (
    path.resolve(publication?.pointer || '') !== path.resolve(pointer) ||
    typeof publication?.writeActiveRelease !== 'function'
  )
    fail('EXISTING_PUBLICATION_TARGET_REQUIRED');
  const check = () => {
    scopeLease.assertWritable(['restart', 'switch', 'activate']);
    scopeLease.check(true);
  };
  const spawn = effects.spawn || cp.spawn,
    request = effects.fetch || fetch;
  return {
    ...toolkit,
    spawn,
    execute: require('node:util').promisify(cp.execFile),
    async processIdentity(action, pid, selectedPort, expected) {
      const receipt = await toolkit.processIdentity(
        action,
        pid,
        selectedPort,
        expected,
      );
      if (
        action === 'OwnedStop' &&
        expected &&
        typeof scopeLease.confirmPreservingProcessExit === 'function'
      ) {
        const packageId = path.basename(
          path.dirname(path.dirname(expected.executable)),
        );
        scopeLease.confirmPreservingProcessExit(pid, receipt, {
          identity: expected,
          packageId,
          commandLine: expected.commandLine,
        });
      }
      return receipt;
    },
    async launchRegistered({
      node,
      args,
      env,
      registryFile,
      transactionId,
      releaseId,
    }) {
      check();
      if (
        !/^[A-Za-z0-9_-]{16,100}$/.test(transactionId) ||
        !/^[A-Za-z0-9][A-Za-z0-9T.Z-]{0,159}$/.test(releaseId)
      )
        fail('REGISTERED_LAUNCH_BINDING_INVALID');
      const release = path.dirname(path.dirname(node));
      if (
        path.resolve(release) !== path.resolve(releasesRoot, releaseId) ||
        path.basename(node).toLowerCase() !== 'node.exe' ||
        args[0] !== path.join(release, 'runtime.cjs')
      )
        fail('REGISTERED_LAUNCH_RUNTIME_CHANGED');
      const registry = read(registryFile);
      if (
        registry.format !== 1 ||
        registry.database !== database ||
        !Array.isArray(registry.processes)
      )
        fail('WRITER_REGISTRY_INVALID');
      const intent =
        registryFile + '.launch-' + transactionId + '-' + releaseId;
      // Persist before CreateProcess. Any uncertain prior attempt blocks a duplicate.
      const fd = fs.openSync(intent, 'wx', 0o600);
      try {
        fs.writeFileSync(
          fd,
          JSON.stringify({
            format: 1,
            transactionId,
            releaseId,
            node,
            args,
            launcherPid: process.pid,
            phase: 'launch-intent',
          }),
        );
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      check();
      const environment = { ...process.env, ...env };
      delete environment.NODE_OPTIONS;
      delete environment.NODE_PATH;
      const child = spawn(node, args, {
        env: environment,
        cwd: release,
        windowsHide: true,
        detached: true,
        stdio: 'ignore',
      });
      child.on('error', () => {});
      if (!child.pid) fail('REGISTERED_LAUNCH_OUTCOME_UNKNOWN');
      let identity;
      const identityDeadline = Date.now() + 30000;
      while (Date.now() < identityDeadline) {
        if (child.exitCode !== null && child.exitCode !== undefined)
          fail('REGISTERED_LAUNCH_EXITED_BEFORE_IDENTITY');
        try {
          identity = await toolkit.processIdentity('Snapshot', child.pid, port);
          break;
        } catch (error) {
          if (effects.spawn) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (!identity) fail('REGISTERED_LAUNCH_IDENTITY_TIMEOUT');
      if (
        identity.pid !== child.pid ||
        identity.executable.toLowerCase() !== node.toLowerCase()
      )
        fail('REGISTERED_LAUNCH_IDENTITY_CHANGED');
      const again = await toolkit.processIdentity(
        'OwnedSnapshot',
        child.pid,
        port,
        identity,
      );
      if (toolkit.sameIdentity(identity, again) === false)
        fail('REGISTERED_LAUNCH_IDENTITY_CHANGED');
      if (typeof scopeLease.bindPreservingChild === 'function')
        scopeLease.bindPreservingChild(
          identity,
          releaseId,
          identity.commandLine,
        );
      check();
      const current = read(registryFile);
      if (JSON.stringify(current) !== JSON.stringify(registry))
        fail('WRITER_REGISTRY_CHANGED');
      current.processes.push({ transactionId, releaseId, identity });
      write(registryFile, current);
      write(intent, {
        format: 1,
        transactionId,
        releaseId,
        identity,
        phase: 'registered',
      });
      child.unref();
      return identity;
    },
    async readUpdateHealth(ctx) {
      check();
      let response;
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        try {
          response = await request('http://127.0.0.1:' + port + healthPath, {
            redirect: 'error',
            signal: AbortSignal.timeout(5000),
          });
          if (response.status !== 503) break;
          await response.body?.cancel();
        } catch (error) {
          if (error.message === 'UPDATE_HEALTH_BINDING_CHANGED') throw error;
        }
        check();
        await new Promise((resolve) => setTimeout(resolve, 200));
        response = undefined;
      }
      if (!response) fail('UPDATE_HEALTH_START_TIMEOUT');
      if (response.status !== 200 || !response.body)
        fail('UPDATE_HEALTH_HTTP_FAILED');
      let bytes = 0;
      const parts = [];
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 16384) fail('UPDATE_HEALTH_TOO_LARGE');
        parts.push(Buffer.from(chunk));
      }
      check();
      const result = JSON.parse(Buffer.concat(parts).toString('utf8'));
      if (
        result.transactionId !== ctx.transactionId ||
        result.id !== ctx.release.id ||
        result.sha256 !== ctx.release.sha256 ||
        result.database !== database ||
        result.readOnly !== true ||
        result.databaseReadable !== true ||
        result.httpReady !== true
      )
        fail('UPDATE_HEALTH_BINDING_CHANGED');
      return result;
    },
    publishActive(release) {
      check();
      return publication.writeActiveRelease(release.path, {
        scope: scopeLease,
      });
    },
  };
}
function createUpdateHealthHandler({ gate, inspectDatabase }) {
  if (
    typeof gate?.health !== 'function' ||
    typeof inspectDatabase !== 'function'
  )
    fail('REAL_UPDATE_HEALTH_INSPECTOR_REQUIRED');
  return async (req, res, next) => {
    if (req.url !== '/_local/update-health') return next();
    if (
      req.method !== 'GET' ||
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(
        req.socket?.remoteAddress,
      )
    ) {
      res.statusCode = 403;
      return res.end();
    }
    try {
      await inspectDatabase();
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(gate.health(true)));
    } catch {
      res.statusCode = 503;
      res.end();
    }
  };
}
module.exports = { createNativePrimitives, createUpdateHealthHandler };
