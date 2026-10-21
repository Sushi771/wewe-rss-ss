'use strict';
const fs = require('./lib.cjs').hostEffects.fs;
const path = require('node:path'),
  crypto = require('node:crypto'),
  assert = require('node:assert/strict');
const digest = (v) =>
  crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const contexts = new WeakMap();
const identity = (s) => [s.dev, s.ino, s.birthtimeNs].map(String);
const metadata = (s) =>
  [...identity(s), s.size, s.mtimeNs, s.ctimeNs].map(String);
const LIMITS = Object.freeze({
  entries: 1500000,
  segmentEntries: 2048,
  segmentMs: 60000,
  segments: 2048,
  memoryBytes: 256 * 1024 ** 2,
});
function observe(root, relative, excluded) {
  const at = path.join(root, relative),
    stat = fs.lstatSync(at, { bigint: true });
  if (stat.isSymbolicLink()) {
    const target = fs.realpathSync.native(at),
      r = path.relative(root, target);
    assert(
      !r.startsWith('..') && !path.isAbsolute(r),
      'FRONTEND_HISTORY_LINK_ESCAPE',
    );
    return { relative, kind: 'link', identity: identity(stat), target };
  }
  if (stat.isDirectory()) {
    const names = fs
      .readdirSync(at)
      .filter((n) => relative || !excluded.includes(n))
      .sort();
    assert(names.length <= 32768, 'FRONTEND_INVENTORY_DIRECTORY_MEMORY');
    return { relative, kind: 'directory', identity: identity(stat), names };
  }
  assert(stat.isFile(), 'FRONTEND_INVENTORY_UNSUPPORTED');
  return {
    relative,
    kind: 'file',
    metadata: metadata(stat),
    bytes: Number(stat.size),
  };
}
function begin(root, excluded = [], limits = {}) {
  root = fs.realpathSync.native(root);
  const handle = Object.freeze({});
  for (const [key, value] of Object.entries(limits))
    assert(
      Object.hasOwn(LIMITS, key) &&
        value > 0 &&
        Number.isSafeInteger(value) &&
        value <= LIMITS[key],
      'FRONTEND_INVENTORY_LIMIT_INVALID',
    );
  const state = {
    root,
    rootIdentity: identity(fs.lstatSync(root, { bigint: true })),
    excluded: [...excluded].sort(),
    pending: [''],
    rows: [],
    index: new Map(),
    events: new Set(),
    bytes: 0,
    slots: 0,
    memory: 0,
    phase: 'scan',
    verifyIndex: 0,
    segments: 0,
    totalElapsedMs: 0,
    dirty: false,
  };
  state.watcher = fs.watch(root, { recursive: true }, (_event, name) => {
    const relative = String(name || '').replace(/\\/g, '/'),
      first = relative.split('/')[0];
    if (!name) state.dirty = true;
    else if (!state.excluded.includes(first)) {
      state.events.add(relative);
      if (state.events.size > 2048) state.dirty = true;
    }
  });
  state.watcher.on('error', () => {
    state.dirty = true;
  });
  state.watcher.unref();
  state.limits = { ...LIMITS, ...limits };
  contexts.set(handle, state);
  return handle;
}
function progress(s, elapsedMs = 0) {
  return {
    phase: s.phase,
    entries: s.rows.length,
    bytes: s.bytes,
    slots: s.slots,
    cursor: s.phase === 'scan' ? s.pending.at(-1) : s.verifyIndex,
    segments: s.segments,
    elapsedMs,
    totalElapsedMs: s.totalElapsedMs + elapsedMs,
  };
}
function fail(code, s, start, now) {
  const error = Error(code);
  error.inventory = progress(s, now() - start);
  return error;
}
function drainEvents(s) {
  assert(!s.dirty, 'FRONTEND_INVENTORY_SCANNED_METADATA_CHANGED');
  for (const relative of s.events) {
    const row = s.index.get(relative),
      parent = s.index.get(
        relative.includes('/')
          ? relative.slice(0, relative.lastIndexOf('/'))
          : '',
      );
    for (const known of [row, parent].filter(Boolean))
      assert.deepEqual(
        observe(s.root, known.relative, s.excluded),
        known,
        'FRONTEND_INVENTORY_SCANNED_METADATA_CHANGED',
      );
  }
  s.events.clear();
}
function advance(
  handle,
  { now = Date.now, entries = 2048, durationMs = 1000 } = {},
) {
  const s = contexts.get(handle);
  assert(s, 'FRONTEND_INVENTORY_UNTRUSTED_CHECKPOINT');
  assert(
    entries > 0 &&
      entries <= LIMITS.segmentEntries &&
      durationMs > 0 &&
      durationMs <= LIMITS.segmentMs,
  );
  const start = now();
  drainEvents(s);
  assert.deepEqual(
    identity(fs.lstatSync(s.root, { bigint: true })),
    s.rootIdentity,
    'FRONTEND_INVENTORY_ROOT_CHANGED',
  );
  if (++s.segments > s.limits.segments)
    throw fail('FRONTEND_INVENTORY_SEGMENT_BUDGET', s, start, now);
  let processed = 0;
  while (processed < entries && now() - start < durationMs) {
    if (s.phase === 'scan') {
      if (!s.pending.length) {
        s.phase = 'verify';
        continue;
      }
      if (s.rows.length >= s.limits.entries)
        throw fail('FRONTEND_INVENTORY_ENTRY_BUDGET', s, start, now);
      const relative = s.pending.pop(),
        row = observe(s.root, relative, s.excluded);
      s.memory += Buffer.byteLength(JSON.stringify(row));
      if (s.memory > s.limits.memoryBytes)
        throw fail('FRONTEND_INVENTORY_MEMORY_BUDGET', s, start, now);
      s.rows.push(row);
      s.index.set(relative, row);
      if (row.kind === 'directory') {
        for (const name of [...row.names].reverse())
          s.pending.push(relative ? relative + '/' + name : name);
        if (relative && !relative.includes('/')) s.slots++;
      } else if (row.kind === 'file') s.bytes += row.bytes;
    } else if (s.phase === 'verify') {
      if (s.verifyIndex === s.rows.length) {
        s.phase = 'complete';
        break;
      }
      const row = s.rows[s.verifyIndex++];
      assert.deepEqual(
        observe(s.root, row.relative, s.excluded),
        row,
        'FRONTEND_INVENTORY_SCANNED_METADATA_CHANGED',
      );
    } else {
      assert.equal(s.phase, 'complete');
      break;
    }
    processed++;
  }
  const elapsed = now() - start;
  if (!processed && s.phase !== 'complete')
    throw fail('FRONTEND_INVENTORY_TIME_BUDGET', s, start, now);
  s.totalElapsedMs += elapsed;
  return {
    complete: s.phase === 'complete',
    progress: progress(s),
    receipt:
      s.phase === 'complete'
        ? {
            bytes: s.bytes,
            slots: s.slots,
            entries: s.rows.length,
            digest: digest(s.rows),
          }
        : null,
  };
}
function cancel(handle) {
  const s = contexts.get(handle);
  s?.watcher.close();
  contexts.delete(handle);
}
function segment(handle, options = {}) {
  try {
    return advance(handle, options);
  } catch (error) {
    const s = contexts.get(handle);
    if (s) error.inventory ??= progress(s);
    cancel(handle);
    throw error;
  }
}
// Resume only this controller's opaque handle, never serialized caller data.
// Saved progress is diagnostic, not a substitute for file/directory validation.
async function inventory(root, excluded = [], options = {}) {
  const handle = options.handle || begin(root, excluded, options.limits);
  const s = contexts.get(handle);
  assert(s, 'FRONTEND_INVENTORY_UNTRUSTED_CHECKPOINT');
  assert.equal(s.root, fs.realpathSync.native(root));
  assert.deepEqual(s.excluded, [...excluded].sort());
  do {
    const result = segment(handle, options);
    await options.onProgress?.(result.progress);
    if (result.complete) {
      try {
        await new Promise((resolve) => setImmediate(resolve));
        drainEvents(s);
        return result.receipt;
      } finally {
        cancel(handle);
      }
    }
    if (options.singleSegment)
      return { pending: true, handle, progress: result.progress };
    await new Promise((resolve) => setImmediate(resolve));
  } while (true); // At most 2048 bounded segments; never restart completed work.
}
module.exports = { begin, segment, inventory, cancel, LIMITS };
