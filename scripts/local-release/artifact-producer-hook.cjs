// Loaded only by the exact pinned compiler invocation. Emission intents cross
// an inherited pipe; no disk receipt or observed output tree authorizes files.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const {
  mutationEvents,
  createArtifacts,
  fileDigest,
} = require('./artifact-intents.cjs');
const fd = Number(process.env.WEWE_ARTIFACT_FD);
const root = process.env.WEWE_ARTIFACT_ROOT;
if (!Number.isInteger(fd) || fd < 3 || !path.isAbsolute(root || ''))
  throw Error('RELEASE_ARTIFACT_PIPE_REQUIRED');
const write = fs.writeSync.bind(fs);
const known = new Map();
const tracker = createArtifacts(root);
function verifyBeforeMutation(name, args) {
  if (
    ['unlink', 'rm', 'rmdir', 'rename'].includes(name) &&
    fs.existsSync(args[0])
  )
    tracker.verify(path.resolve(args[0]));
}
const send = (events) => {
  for (const event of events) {
    const relative = path.relative(root, event.path);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw Error('RELEASE_ARTIFACT_COMPILER_WRITE_OUTSIDE_OUTPUT');
    write(fd, JSON.stringify(event) + '\n');
    if (event.kind === 'remove') {
      for (const key of known.keys())
        if (key === event.path || key.startsWith(event.path + path.sep))
          known.delete(key);
    } else known.set(event.path, event);
  }
  tracker.apply(events);
};
write(fd, JSON.stringify({ producer: process.pid }) + '\n');
for (const name of [
  'writeFile',
  'copyFile',
  'mkdir',
  'unlink',
  'rm',
  'rmdir',
  'rename',
  'chmod',
  'utimes',
]) {
  const sync = fs[name + 'Sync'];
  if (sync)
    fs[name + 'Sync'] = function (...args) {
      verifyBeforeMutation(name, args);
      const events = mutationEvents(name, args, known);
      for (const event of events) {
        const relative = path.relative(root, event.path);
        if (relative.startsWith('..') || path.isAbsolute(relative))
          throw Error('RELEASE_ARTIFACT_COMPILER_WRITE_OUTSIDE_OUTPUT');
      }
      const result = sync.apply(this, args);
      send(events);
      return result;
    };
  const promise = fs.promises[name];
  if (promise)
    fs.promises[name] = async function (...args) {
      verifyBeforeMutation(name, args);
      const events = mutationEvents(name, args, known);
      for (const event of events) {
        const relative = path.relative(root, event.path);
        if (relative.startsWith('..') || path.isAbsolute(relative))
          throw Error('RELEASE_ARTIFACT_COMPILER_WRITE_OUTSIDE_OUTPUT');
      }
      const result = await promise.apply(this, args);
      send(events);
      return result;
    };
  const callback = fs[name];
  if (callback)
    fs[name] = function (...args) {
      verifyBeforeMutation(name, args);
      const done = args.pop(),
        events = mutationEvents(name, args, known);
      for (const event of events) {
        const relative = path.relative(root, event.path);
        if (relative.startsWith('..') || path.isAbsolute(relative))
          throw Error('RELEASE_ARTIFACT_COMPILER_WRITE_OUTSIDE_OUTPUT');
      }
      return callback.call(this, ...args, (error, ...values) => {
        if (!error) send(events);
        done(error, ...values);
      });
    };
}
function verifyRead(file) {
  if (typeof file !== 'string') return;
  const expected = known.get(path.resolve(file));
  if (expected?.kind === 'file' && fileDigest(file) !== expected.sha256)
    throw Error('RELEASE_ARTIFACT_COMPILER_INPUT_CHANGED');
}
for (const name of ['readFile', 'createReadStream']) {
  if (fs[name + 'Sync']) {
    const original = fs[name + 'Sync'];
    fs[name + 'Sync'] = function (...args) {
      verifyRead(args[0]);
      return original.apply(this, args);
    };
  }
  const original = fs[name];
  fs[name] = function (...args) {
    verifyRead(args[0]);
    return original.apply(this, args);
  };
  if (fs.promises[name]) {
    const originalPromise = fs.promises[name];
    fs.promises[name] = async function (...args) {
      verifyRead(args[0]);
      return originalPromise.apply(this, args);
    };
  }
}
// Preserve generator JSON-RPC stdout and IPC while forwarding the intent pipe.
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = cp[name];
  cp[name] = function (executable, argv = [], options = {}, ...rest) {
    if (!Array.isArray(argv) || !options || typeof options !== 'object')
      throw Error('RELEASE_ARTIFACT_CHILD_OPTIONS_REQUIRED');
    if (
      options.shell &&
      executable === process.env.WEWE_PRISMA_GENERATOR_COMMAND
    ) {
      const generator = process.env.WEWE_PRISMA_GENERATOR_ENTRY;
      if (
        !generator ||
        !path.isAbsolute(generator) ||
        !/^[a-f0-9]{64}$/.test(
          process.env.WEWE_PRISMA_GENERATOR_SHA256 || '',
        ) ||
        fileDigest(generator) !== process.env.WEWE_PRISMA_GENERATOR_SHA256 ||
        argv.length ||
        name !== 'spawn'
      )
        throw Error('RELEASE_ARTIFACT_PRISMA_GENERATOR_BINDING_REQUIRED');
      executable = process.execPath;
      argv = [generator];
      options = { ...options, shell: false };
    }
    const stdio = Array.isArray(options.stdio)
      ? [...options.stdio]
      : Array(3).fill(options.stdio || 'pipe');
    while (stdio.length < 3) stdio.push('pipe');
    const childFd = stdio.length;
    stdio.push(fd);
    return original.call(
      this,
      executable,
      argv,
      {
        ...options,
        stdio,
        env: {
          ...(options.env || process.env),
          NODE_DISABLE_COMPILE_CACHE: '1',
          NODE_OPTIONS: process.env.NODE_OPTIONS,
          WEWE_ARTIFACT_ROOT: root,
          WEWE_ARTIFACT_FD: String(childFd),
          WEWE_PRISMA_GENERATOR_ENTRY: process.env.WEWE_PRISMA_GENERATOR_ENTRY,
          WEWE_PRISMA_GENERATOR_SHA256:
            process.env.WEWE_PRISMA_GENERATOR_SHA256,
          WEWE_PRISMA_GENERATOR_COMMAND:
            process.env.WEWE_PRISMA_GENERATOR_COMMAND,
        },
      },
      ...rest,
    );
  };
}
require('node:module').syncBuiltinESMExports();
