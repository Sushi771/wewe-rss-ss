// Complete, deterministic DFS receipts without a whole-tree row/name table.
// Profiles bound both each pass and the sum of all passes in one operation.
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const GiB = 1024 ** 3;
const FORMAT = 'stream-dfs-sha256-v2';
const EMPTY = crypto.createHash('sha256').digest('hex');
const PROFILES = Object.freeze({
  small: Object.freeze({
    scanEntries: 100000,
    operationEntries: 1000000,
    scanReadBytes: GiB,
    operationReadBytes: 2 * GiB,
    durationMs: 30000,
  }),
  'legacy-stream-v1': Object.freeze({
    scanEntries: 1500000,
    operationEntries: 16000000,
    scanReadBytes: 32 * GiB,
    operationReadBytes: 64 * GiB,
    durationMs: 30 * 60 * 1000,
  }),
});
const MEMORY = Object.freeze({
  directoryEntries: 4096,
  pendingNames: 32768,
  pendingNameBytes: 16 * 1024 ** 2,
  depth: 128,
  pathBytes: 65536,
  bufferBytes: 65536,
  segmentEntries: 2048,
});
const hash = (v) =>
  crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const within = (root, file) => {
  const r = path.relative(root, file);
  return (
    r === '' ||
    (!r.startsWith('..' + path.sep) && r !== '..' && !path.isAbsolute(r))
  );
};
function settings(value = {}) {
  const { profile = 'small', checkpointMode = 'full', ...limits } = value,
    ceiling =
      typeof profile === 'string' && Object.hasOwn(PROFILES, profile)
        ? PROFILES[profile]
        : undefined;
  if (
    !ceiling ||
    !['full', 'identity-times-v1'].includes(checkpointMode) ||
    Object.keys(limits).some((k) => !Object.hasOwn(ceiling, k))
  )
    throw new Error('RELEASE_SCOPE_SCAN_BUDGET_INVALID');
  const selected = { ...ceiling, ...limits };
  for (const [key, n] of Object.entries(selected))
    if (!Number.isSafeInteger(n) || n < 1 || n > ceiling[key])
      throw new Error('RELEASE_SCOPE_SCAN_BUDGET_INVALID');
  return { profile, checkpointMode, ...selected };
}
function createVerifier(configuration, options = {}) {
  const limits = settings(configuration),
    io = options.io || fs,
    now = options.now || (() => performance.now()),
    started = now(),
    buffer = Buffer.alloc(MEMORY.bufferBytes);
  const metrics = {
    passes: 0,
    visitedEntries: 0,
    readBytes: 0,
    segments: 0,
    maxPendingNames: 0,
    maxPendingNameBytes: 0,
    maxDepth: 0,
  };
  const canonical = (p) => io.realpathSync.native(p);
  const identity = (s) => [s.dev, s.ino, s.birthtimeNs].map(String);
  function scan(roots, excluded = [], { metadataOnly = false } = {}) {
    let entries = 0,
      bytes = 0,
      runtimeCopies = 0,
      readBytes = 0,
      pendingNames = 0,
      pendingNameBytes = 0,
      segmentRows = 0,
      segments = 0;
    const digest = crypto.createHash('sha256'),
      metadata = crypto.createHash('sha256'),
      segmentRoot = crypto.createHash('sha256');
    let segment = crypto.createHash('sha256');
    metrics.passes++;
    const excludedAt = (p) => excluded.some((r) => within(r, p));
    function budget() {
      if (now() - started > limits.durationMs)
        throw new Error('RELEASE_SCOPE_SCAN_TIME_BUDGET');
      if (
        entries > limits.scanEntries ||
        metrics.visitedEntries > limits.operationEntries
      )
        throw new Error('RELEASE_SCOPE_SCAN_ENTRY_BUDGET');
    }
    function finishSegment() {
      if (!segmentRows) return;
      segmentRoot.update(segment.digest());
      segments++;
      metrics.segments++;
      options.onSegment?.({
        pass: metrics.passes,
        mode: metadataOnly ? 'metadata' : 'full',
        entries,
        readBytes,
        totalReadBytes: metrics.readBytes,
        elapsedMs: Math.floor(now() - started),
      });
      segment = crypto.createHash('sha256');
      segmentRows = 0;
      budget();
    }
    function record(row, content) {
      const line = JSON.stringify(row) + '\n';
      metadata.update(line);
      if (!metadataOnly)
        digest.update(
          JSON.stringify(content === undefined ? row : [...row, content]) +
            '\n',
        );
      segment.update(line);
      if (++segmentRows === MEMORY.segmentEntries) finishSegment();
    }
    function fileDigest(file, size) {
      if (
        readBytes + Number(size) > limits.scanReadBytes ||
        metrics.readBytes + Number(size) > limits.operationReadBytes
      )
        throw new Error('RELEASE_SCOPE_SCAN_READ_BUDGET');
      if (size === 0n) return EMPTY;
      const h = crypto.createHash('sha256');
      const fd = io.openSync(file, 'r');
      let count = 0;
      try {
        while (count < Number(size)) {
          budget();
          const length = Math.min(
            buffer.length,
            Number(size) - count,
            limits.scanReadBytes - readBytes,
            limits.operationReadBytes - metrics.readBytes,
          );
          if (length <= 0) throw new Error('RELEASE_SCOPE_SCAN_READ_BUDGET');
          const n = io.readSync(fd, buffer, 0, length, null);
          if (!n) throw new Error('RELEASE_SCOPE_FILE_CHANGED_DURING_SCAN');
          readBytes += n;
          metrics.readBytes += n;
          count += n;
          h.update(buffer.subarray(0, n));
        }
      } finally {
        io.closeSync(fd);
      }
      if (count !== Number(size))
        throw new Error('RELEASE_SCOPE_FILE_CHANGED_DURING_SCAN');
      return h.digest('hex');
    }
    function visit(root, at, relative, depth) {
      if (depth > MEMORY.depth || Buffer.byteLength(at) > MEMORY.pathBytes)
        throw new Error('RELEASE_SCOPE_SCAN_DEPTH_OR_PATH_BUDGET');
      metrics.maxDepth = Math.max(metrics.maxDepth, depth);
      entries++;
      metrics.visitedEntries++;
      budget();
      const s = io.lstatSync(at, { bigint: true }),
        key = [root.path, relative.replace(/\\/g, '/')];
      if (s.isSymbolicLink()) {
        const target = canonical(at);
        if (!roots.some((r) => within(r.path, target)))
          throw new Error('RELEASE_SCOPE_LINK_ESCAPE');
        if (!excludedAt(at))
          record([
            ...key,
            'link',
            ...identity(s),
            String(s.mtimeNs),
            String(s.ctimeNs),
            target,
          ]);
        return;
      }
      if (s.isDirectory()) {
        if (!excludedAt(at)) record([...key, 'dir', ...identity(s)]);
        const names = [];
        let charged = 0,
          dir;
        try {
          dir = io.opendirSync(at, { bufferSize: 32 });
          let item;
          while ((item = dir.readSync())) {
            const cost = item.name.length * 2 + 64;
            if (
              names.length >= MEMORY.directoryEntries ||
              pendingNames + 1 > MEMORY.pendingNames ||
              pendingNameBytes + cost > MEMORY.pendingNameBytes
            )
              throw new Error('RELEASE_SCOPE_SCAN_NAME_MEMORY_BUDGET');
            names.push(item.name);
            charged += cost;
            pendingNames++;
            pendingNameBytes += cost;
            metrics.maxPendingNames = Math.max(
              metrics.maxPendingNames,
              pendingNames,
            );
            metrics.maxPendingNameBytes = Math.max(
              metrics.maxPendingNameBytes,
              pendingNameBytes,
            );
            budget();
          }
          dir.closeSync();
          dir = undefined;
          const after = io.lstatSync(at, { bigint: true });
          for (const k of ['dev', 'ino', 'birthtimeNs', 'mtimeNs', 'ctimeNs'])
            if (s[k] !== after[k])
              throw new Error('RELEASE_SCOPE_DIRECTORY_CHANGED_DURING_SCAN');
          names.sort();
          for (const name of names)
            visit(
              root,
              path.join(at, name),
              path.join(relative, name),
              depth + 1,
            );
          const final = io.lstatSync(at, { bigint: true });
          for (const k of ['dev', 'ino', 'birthtimeNs', 'mtimeNs', 'ctimeNs'])
            if (s[k] !== final[k])
              throw new Error('RELEASE_SCOPE_DIRECTORY_CHANGED_DURING_SCAN');
        } finally {
          if (dir) dir.closeSync();
          pendingNames -= names.length;
          pendingNameBytes -= charged;
        }
        return;
      }
      if (!s.isFile() || s.nlink > 1n)
        throw new Error('RELEASE_SCOPE_UNSUPPORTED_FILE_OR_HARDLINK');
      bytes += Number(s.size);
      if (!Number.isSafeInteger(bytes))
        throw new Error('RELEASE_SCOPE_BYTES_INVALID');
      if (path.basename(at).toLowerCase() === 'node.exe') runtimeCopies++;
      const control =
        at === path.join(root.path, 'active.json') ||
        at === path.join(root.path, '.build-budget.lock') ||
        at === path.join(root.path, '.release-lifecycle.json');
      if (control && s.size > 65536n)
        throw new Error('RELEASE_SCOPE_CONTROL_FILE_LIMIT');
      if (!control && !excludedAt(at)) {
        const content = metadataOnly ? undefined : fileDigest(at, s.size),
          after = io.lstatSync(at, { bigint: true });
        for (const k of [
          'dev',
          'ino',
          'birthtimeNs',
          'size',
          'mtimeNs',
          'ctimeNs',
        ])
          if (s[k] !== after[k])
            throw new Error('RELEASE_SCOPE_FILE_CHANGED_DURING_SCAN');
        record(
          [
            ...key,
            'file',
            ...[s.dev, s.ino, s.birthtimeNs, s.size, s.mtimeNs, s.ctimeNs].map(
              String,
            ),
          ],
          content,
        );
      }
    }
    // Caller pins/sorts roots. Root/child arrays are bounded independently.
    if (roots.length < 1 || roots.length > 32)
      throw new Error('RELEASE_SCOPE_ROOT_COUNT');
    for (const root of roots) {
      const at = canonical(root.path),
        s = io.lstatSync(at, { bigint: true });
      if (
        at !== root.path ||
        !s.isDirectory() ||
        s.isSymbolicLink() ||
        hash(identity(s)) !== hash(root.identity)
      )
        throw new Error('RELEASE_SCOPE_ROOT_CHANGED');
      visit(root, at, '', 0);
    }
    finishSegment();
    budget();
    return {
      format: FORMAT,
      bytes,
      entries,
      runtimeCopies,
      metadataDigest: metadata.digest('hex'),
      digest: metadataOnly ? undefined : digest.digest('hex'),
      segments,
      segmentRoot: segmentRoot.digest('hex'),
      readBytes,
    };
  }
  return {
    scan,
    limits,
    metrics: () => ({
      ...metrics,
      elapsedMs: Math.floor(now() - started),
      bufferBytes: buffer.length,
    }),
  };
}
module.exports = { createVerifier, settings, PROFILES, MEMORY, FORMAT };
if (require.main === module) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--inspect')
      throw new Error(
        'Usage: node scope-inventory.cjs --inspect <private-request.json>',
      );
    const file = process.argv[3],
      s = fs.lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.size > 65536)
      throw new Error('Invalid read-only inventory request');
    const request = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (
      !Array.isArray(request.roots) ||
      request.roots.length < 1 ||
      request.roots.length > 32 ||
      request.roots.some((r) => typeof r !== 'string' || !path.isAbsolute(r))
    )
      throw new Error('Invalid inventory roots');
    let metrics;
    const receipt = require('./release-scope.cjs').inspect(request.roots, {
      scanBudget: request.scanBudget,
      onMetrics: (v) => (metrics = v),
      onSegment: (v) =>
        process.stderr.write(
          JSON.stringify({ type: 'inventory-progress', ...v }) + '\n',
        ),
    });
    process.stdout.write(
      JSON.stringify({
        ...receipt,
        metrics,
        scanBudget: settings(request.scanBudget),
      }) + '\n',
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
