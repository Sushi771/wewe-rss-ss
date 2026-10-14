'use strict';

const restrictionMethods = `
  private restrictionCheck?: () => Promise<boolean>;
  attachRestrictionCheck(check: () => Promise<boolean>) { this.restrictionCheck = check; }
  private async releaseSharedRestriction(b: Batch, explicit = false) {
    let restricted = b.items.filter(i => i.sharedRestriction === true);
    if (!restricted.length || !this.restrictionCheck || this.now() < b.nextSubmissionAt ||
        (!explicit && restricted.some(i => i.restrictionKind !== 'rate-limit')) ||
        b.instance !== hash(this.instance()) || b.state === 'stopped' ||
        (b.purpose === 'scheduled-refresh' && (!activeRefreshScheduleEnabled(process.env) || !automaticSubmissionAllowed(this.now())))) return false;
    let clear = false;
    try { clear = await this.restrictionCheck(); } catch { /* remain restricted */ }
    const latest = await this.read(b.batchId);
    if (this.stopped || !latest || this.now() < latest.nextSubmissionAt || latest.state === 'stopped' || latest.instance !== hash(this.instance()) ||
        (!explicit && latest.items.some(i => i.sharedRestriction === true && i.restrictionKind !== 'rate-limit'))) return false;
    Object.assign(b, latest);
    restricted = b.items.filter(i => i.sharedRestriction === true);

    if (!clear) {
      if (!explicit) { b.nextSubmissionAt = this.now() + 120000; await this.write(b); }
      return false;
    }
    for (const item of restricted) {
      item.sharedRestriction = false; item.stopBatch = false;
      if (item.state === 'blocked' && !item.accepted && !item.submissionUnknown) {
        item.state = 'queued'; item.retryable = true;
      }
    }
    b.state = b.items.some(i => ['queued','waiting','submitting'].includes(i.state)) ? 'running' : 'completed';
    return this.write(b, true);
  }
`;

/** Apply only to the serial worker from an isolated rollback checkout based on
 * the actual deployed commit. Does not read/write a database or durable state. */
function compatibleSerialRefreshWorker(source) {
  const marker = '// Bounded-wave rollback state compatibility v4.';
  if (
    source.includes('// Bounded-wave rollback state compatibility.') ||
    source.includes('// Bounded-wave rollback state compatibility v2.') ||
    source.includes('// Bounded-wave rollback state compatibility v3.')
  )
    throw new Error('ROLLBACK_REBUILD_REQUIRED');
  if (source.includes('private async runRefreshWave('))
    throw new Error('ROLLBACK_REQUIRES_SERIAL_BASE');
  if (source.includes(marker)) return source;
  const replace = (before, after) => {
    if (!source.includes(before))
      throw new Error('ROLLBACK_SOURCE_NOT_SUPPORTED');
    source = source.replace(before, after);
  };
  replace(
    '  private async write(b: Batch) {',
    "  private readonly batchWrites = new Map<string, Promise<boolean>>();\n  /** All existing-state writes honor stop at their serialized persistence boundary.\n   * Only creation, explicit stop, and a single genuine receipt have special modes. */\n  private async write(\n    b: Batch,\n    mode: boolean | 'receipt' | 'stop' = true,\n    receiptIndex?: number,\n  ) {\n    const persisted = JSON.parse(JSON.stringify(b)) as Batch;\n    const previous = this.batchWrites.get(b.batchId) || Promise.resolve(true);\n    const pending = previous\n      .catch(() => false)\n      .then(async () => {\n        const latest = mode === false ? undefined : await this.read(b.batchId);\n        if (mode !== false && !latest) return false;\n        if (mode === 'stop') {\n          Object.assign(persisted, latest);\n          persisted.state = 'stopped';\n          for (const item of persisted.items)\n            if (item.state === 'queued') {\n              item.state = 'cancelled';\n              item.message = '剩余任务已停止，未发送。';\n            }\n        } else if (latest?.state === 'stopped') {\n          if (mode !== 'receipt') {\n            Object.assign(b, latest);\n            return false;\n          }\n          const receipt = persisted.items[receiptIndex!];\n          if (!receipt || !latest.items[receiptIndex!]) return false;\n          latest.items[receiptIndex!] = { ...receipt };\n          if (\n            receipt.state === 'queued' &&\n            !receipt.accepted &&\n            !receipt.submissionUnknown\n          )\n            latest.items[receiptIndex!].state = 'cancelled';\n          latest.nextSubmissionAt = Math.max(\n            latest.nextSubmissionAt,\n            persisted.nextSubmissionAt,\n          );\n          Object.assign(persisted, latest);\n        }\n        await this.persistWrite(persisted);\n        if (mode === 'stop' || (mode === 'receipt' && latest?.state === 'stopped'))\n          Object.assign(b, persisted);\n        else b.updatedAt = persisted.updatedAt;\n        return true;\n      });\n    this.batchWrites.set(b.batchId, pending);\n    try {\n      return await pending;\n    } finally {\n      if (this.batchWrites.get(b.batchId) === pending)\n        this.batchWrites.delete(b.batchId);\n    }\n  }\n  private async persistWrite(b: Batch) {\n",
  );
  const recoveryStart = source.indexOf('  private async recoverPreparation(');
  const recoveryEnd = source.indexOf('  async runDue(', recoveryStart);
  if (recoveryStart < 0 || recoveryEnd < 0)
    throw new Error('ROLLBACK_SOURCE_NOT_SUPPORTED');
  source =
    source.slice(0, recoveryStart) +
    source
      .slice(recoveryStart, recoveryEnd)
      .replaceAll('await this.write(b);', 'await this.write(b, true);') +
    source.slice(recoveryEnd);
  // The default persistence mode protects every automatic recovery/coverage write.
  replace(
    '      await this.write(b);\n      this.schedule();\n      return view(b);',
    '      await this.write(b, false);\n      this.schedule();\n      return view(b);',
  );
  replace(
    '      await this.write(b);\n      this.schedule();\n      return { ...view(b), reused: false };',
    '      await this.write(b, false);\n      this.schedule();\n      return { ...view(b), reused: false };',
  );
  replace('await this.write(joined);', 'await this.write(joined, false);');
  const stopStart = source.indexOf('  async stop('),
    stopEnd = source.indexOf('  async resume(', stopStart);
  source =
    source.slice(0, stopStart) +
    source
      .slice(stopStart, stopEnd)
      .replace('await this.write(b);', "await this.write(b, 'stop');") +
    source.slice(stopEnd);
  source = source.replaceAll(
    'await this.write(current);',
    "await this.write(current, 'receipt', item.index);",
  );
  replace(
    'await this.write(b); // Includes',
    'if (!(await this.write(b))) return; // Includes',
  );
  replace(
    'await this.write(b); // Reserve exactly once',
    'if (!(await this.write(b))) return true; // Reserve exactly once',
  );
  replace(
    '  stopBatch?: boolean;',
    "  stopBatch?: boolean;\n  sharedRestriction?: boolean;\n  restrictionKind?: 'account' | 'rate-limit';",
  );
  replace(
    "  'stopBatch',",
    "  'stopBatch',\n  'sharedRestriction',\n  'restrictionKind',",
  );
  replace(
    '(item.submissionUnknown !== undefined &&',
    "(item.sharedRestriction !== undefined && typeof item.sharedRestriction !== 'boolean') ||\n          (item.restrictionKind !== undefined && !['account','rate-limit'].includes(item.restrictionKind)) ||\n          (item.submissionUnknown !== undefined &&",
  );
  replace(
    '  private reconcile?: (',
    restrictionMethods + '\n  private reconcile?: (',
  );
  replace(
    '      await this.coverPreparation(pending);',
    '      for (const record of pending) await this.releaseSharedRestriction(record);\n      const latestRecords = await this.records();\n      await this.coverPreparation(latestRecords);',
  );
  replace(
    '      for (const record of pending) await this.recoverPreparation(record);',
    '      for (const record of latestRecords) await this.recoverPreparation(record);',
  );
  replace(
    "                item.state === 'queued' &&\n                !record.items.some(",
    "                item.state === 'queued' &&\n                !record.items.some(i => i.sharedRestriction === true) &&\n                !record.items.some(",
  );
  replace(
    '    const maySubmit =\n      !b.cacheOnly &&',
    '    const maySubmit =\n      !b.items.some(i => i.sharedRestriction === true) &&\n      !b.cacheOnly &&',
  );
  replace(
    '    if (isRefresh(b)) {\n      // Never turn',
    '    if (isRefresh(b)) {\n      if (b.items.some(i => i.sharedRestriction === true) && !(await this.releaseSharedRestriction(b, true))) return view(b);\n      // Never turn',
  );
  replace(
    '\n            automaticRecovery(b) ||',
    "\n            automaticRecovery(b) ||\n            (this.restrictionCheck && b.items.some(i => i.sharedRestriction === true && i.restrictionKind === 'rate-limit')) ||",
  );
  replace(
    '\n          automaticRecovery(b) ||',
    "\n          automaticRecovery(b) ||\n          (this.restrictionCheck && b.items.some(i => i.sharedRestriction === true && i.restrictionKind === 'rate-limit')) ||",
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
  block = block.replace(
    '  private async runRefresh(b: Batch) {',
    '  private async runRefresh(b: Batch) {\n    if (this.stopped) return false;',
  );
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
  block = block.replace(
    "    const unknowns = b.items.filter((i) => i.state === 'submitting');\n",
    "    const unknowns = b.items.filter((i) => i.state === 'submitting');\n" +
      "    // Interrupted claims may be recorded as unknown after stop, never resumed.\n    if (b.state === 'stopped' && unknowns.length) {\n      for (const interrupted of unknowns) {\n        const latest = await this.read(b.batchId);\n        if (!latest) return true;\n        const target = latest.items[interrupted.index];\n        if (target.state !== 'submitting') continue;\n        target.state = target.accepted === true ? 'waiting' : 'blocked';\n        target.submissionUnknown = target.accepted !== true;\n        target.message = '中断提交回执未知；保持停止，不重新提交。';\n        await this.write(latest, 'receipt', target.index);\n        Object.assign(b, latest);\n      }\n      return true;\n    }\n",
  );
  return marker + '\n' + source.slice(0, start) + block + source.slice(end);
}

function compatibleSerialRefreshService(source) {
  if (source.includes('this.subscriptionBatches.attachRestrictionCheck('))
    return source;
  const anchor = '    this.subscriptionBatches.attachReconciliation(';
  if (!source.includes(anchor))
    throw new Error('ROLLBACK_SERVICE_NOT_SUPPORTED');
  return source.replace(
    anchor,
    `    this.subscriptionBatches.attachRestrictionCheck(async () => {
      const account = await wechat2RssProvider().checkAccountStatus();
      return account.available && !account.challenged;
    });
` + anchor,
  );
}
module.exports = {
  compatibleSerialRefreshWorker,
  compatibleSerialRefreshService,
  restrictionMethods,
};
