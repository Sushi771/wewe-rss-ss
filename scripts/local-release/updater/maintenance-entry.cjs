'use strict';
// Fixed installer-plan dispatch. No registry translation or maintenance receipt
// is created here; the existing maintenance driver remains the sole executor.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const read = (file) =>
  JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const hash = (file) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fail = (code) => {
  throw Error(code);
};
function pin(file, expected) {
  if (!path.isAbsolute(file || '') || !/^[a-f0-9]{64}$/.test(expected || ''))
    fail('FIXED_MAINTENANCE_INPUT_REQUIRED');
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    hash(file) !== expected
  )
    fail('FIXED_MAINTENANCE_INPUT_CHANGED');
}
function createMaintenanceEntry({ bindingsFile }) {
  const config = read(bindingsFile);
  if (
    config.format !== 1 ||
    config.mode !== 'maintenance-driver-v1' ||
    !path.isAbsolute(config.releasesRoot || '') ||
    !config.current?.id ||
    !/^[a-f0-9]{64}$/.test(config.current.sha256 || '')
  )
    fail('MAINTENANCE_BINDINGS_REQUIRED');
  const currentRoot = path.join(config.releasesRoot, config.current.id);
  if (path.dirname(currentRoot) !== config.releasesRoot)
    fail('MAINTENANCE_CURRENT_PATH_INVALID');
  return {
    async runMaintenance({ request, recoveryOnly, report = () => {} }) {
      if (recoveryOnly) fail('MAINTENANCE_RECOVERY_OWNER_REQUIRED');
      if (
        !request ||
        !path.isAbsolute(request.path || '') ||
        !/^[a-f0-9]{64}$/.test(request.sha256 || '')
      )
        fail('FIXED_UPDATE_REQUEST_REQUIRED');
      const pointerFile = path.join(config.releasesRoot, 'active.json');
      const before = fs.readFileSync(pointerFile);
      const active = JSON.parse(before.toString('utf8'));
      if (active.format !== 1 || active.id !== config.current.id)
        fail('MAINTENANCE_CURRENT_BINDING_CHANGED');
      if (
        path.resolve(request.path) === path.resolve(currentRoot) &&
        request.sha256 === config.current.sha256
      ) {
        // This branch is entirely read-only. It neither acquires old generic
        // lifecycle locks nor enables a process or opens a SQLite database.
        const { verifyRelease } = require('./installed-host.cjs');
        const verified = verifyRelease(currentRoot, config.current.sha256, {
          role: 'current',
        });
        if (
          verified.id !== config.current.id ||
          !fs.readFileSync(pointerFile).equals(before)
        )
          fail('MAINTENANCE_CURRENT_BINDING_CHANGED');
        report('当前版本已安装，没有待安装的新版本包。');
        return { status: 'already-current', scope: 'read-only-fixed-package' };
      }
      // A future target needs a NEW fixed plan from the maintenance owner.
      // Old process/approval/active-pointer evidence is never auto-refreshed.
      if (!config.plan || !config.driver) fail('NEW_MAINTENANCE_PLAN_REQUIRED');
      pin(config.plan.path, config.plan.sha256);
      const plan = read(config.plan.path);
      if (
        plan.executionMode !== 'final-install' ||
        plan.current?.sha256 !== config.current.sha256 ||
        plan.candidate?.path !== request.path ||
        plan.candidate?.sha256 !== request.sha256 ||
        plan.releasesRoot !== config.releasesRoot
      )
        fail('NEW_MAINTENANCE_PLAN_BINDING_MISMATCH');
      for (const entry of config.driver.closure || [])
        pin(entry.path, entry.sha256);
      if (!config.driver.closure?.length)
        fail('MAINTENANCE_DRIVER_CLOSURE_REQUIRED');
      pin(config.driver.path, config.driver.sha256);
      const driver = require(config.driver.path);
      if (typeof driver.run !== 'function')
        fail('EXISTING_MAINTENANCE_DRIVER_REQUIRED');
      report('正在使用已绑定的安装程序更新。');
      return driver.run(plan, (progress) =>
        report(progress.stage || '正在更新。'),
      );
    },
  };
}
module.exports = { createMaintenanceEntry };
