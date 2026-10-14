'use strict';

/** Apply only to the serial worker from an isolated rollback checkout based on
 * the actual deployed commit. Does not read/write a database or durable state. */
function compatibleSerialRefreshWorker(source) {
  const marker = '// Bounded-wave rollback state compatibility.';
  if (source.includes('private async runRefreshWave('))
    throw new Error('ROLLBACK_REQUIRES_SERIAL_BASE');
  if (source.includes(marker)) return source;
  const replace = (before, after) => {
    if (!source.includes(before))
      throw new Error('ROLLBACK_SOURCE_NOT_SUPPORTED');
    source = source.replace(before, after);
  };
  replace(
    '  stopBatch?: boolean;',
    '  stopBatch?: boolean;\n  sharedRestriction?: boolean;',
  );
  replace("  'stopBatch',", "  'stopBatch',\n  'sharedRestriction',");
  replace(
    '(item.submissionUnknown !== undefined &&',
    "(item.sharedRestriction !== undefined && typeof item.sharedRestriction !== 'boolean') ||\n          (item.submissionUnknown !== undefined &&",
  );
  replace(
    "  b.purpose === 'scheduled-refresh' &&\n  !b.cacheOnly &&",
    "  b.purpose === 'scheduled-refresh' &&\n  !b.items.some(item => item.sharedRestriction === true) &&\n  !b.cacheOnly &&",
  );
  replace(
    'const isolatedRefresh = (b: Batch) =>\n  isRefresh(b) &&',
    'const isolatedRefresh = (b: Batch) =>\n  isRefresh(b) && !b.items.some(item => item.sharedRestriction === true) &&',
  );
  const start = source.indexOf('  private async runRefresh(b: Batch)');
  const end = source.indexOf('    // Carrying the 17:30 tail', start);
  if (start < 0 || end < 0) throw new Error('ROLLBACK_SOURCE_NOT_SUPPORTED');
  let block = source.slice(start, end);
  if (
    !block.includes(
      "const unknown = b.items.find((i) => i.state === 'submitting');",
    )
  )
    throw new Error('ROLLBACK_SOURCE_NOT_SUPPORTED');
  block = block.replace(
    "const unknown = b.items.find((i) => i.state === 'submitting');",
    "const unknowns = b.items.filter((i) => i.state === 'submitting');",
  );
  block = block.replace(
    '    if (unknown) {',
    '    if (unknowns.length) {\n      for (const unknown of unknowns) {',
  );
  block = block.replace(
    "      if (b.state !== 'stopped')",
    "      }\n      if (b.state !== 'stopped')",
  );
  return marker + '\n' + source.slice(0, start) + block + source.slice(end);
}

module.exports = { compatibleSerialRefreshWorker };
