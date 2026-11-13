const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the actual restart entry point without filesystem/process/network effects.
for (const finishCase of [
  'success',
  'error',
  null,
  undefined,
  'primitive',
  0,
]) {
  const failFinish = finishCase !== 'success';
  test(`restart preserves setup failure through artifact finish: ${String(finishCase)}`, async () => {
    const primary = new Error('synthetic-setup');
    const cleanup =
      finishCase === 'error'
        ? new Error('synthetic-artifact-finish')
        : finishCase;
    let finished = 0;
    const lib = {
      hostEffects: { fs: { realpathSync: (p) => p }, processes: {} },
      verifyReleaseAsync: async () => ({
        schemaCompatibility: 'current',
        desktopHelperIncluded: false,
      }),
      cleanEnvironment: () => {
        throw primary;
      },
    };
    const localRequire = (name) => {
      if (name === './lib.cjs') return lib;
      if (name === './release-scope.cjs')
        return { assertWritableSession() {}, session: () => undefined };
      if (name === './test-artifacts.cjs')
        return {
          begin: () => ({
            database: 'synthetic-db',
            audit: 'synthetic-audit',
            finish(error) {
              finished++;
              assert.equal(error, primary);
              if (failFinish) throw cleanup;
            },
          }),
        };
      if (
        [
          './startup-acceptance.cjs',
          './switch.cjs',
          './active-release.cjs',
          './legacy-maintenance-loader.cjs',
        ].includes(name)
      )
        return {};
      if (name.startsWith('node:')) return require(name);
      throw Error('UNEXPECTED_DEPENDENCY:' + name);
    };
    const module = { exports: {} };
    vm.runInThisContext(
      '(function(require,module,exports,__dirname,process){' +
        fs.readFileSync(path.join(__dirname, 'restart.cjs'), 'utf8') +
        '\n})',
    )(localRequire, module, module.exports, __dirname, {
      platform: 'win32',
      env: {},
    });
    await assert.rejects(
      module.exports.controlledRestart({
        rehearsal: true,
        production: false,
        mode: 'start',
        release: 'synthetic-release',
      }),
      (error) => {
        if (failFinish) {
          assert(error instanceof AggregateError);
          assert.deepEqual(error.errors, [primary, cleanup]);
          assert.equal(error.cause, primary);
        } else assert.equal(error, primary);
        return true;
      },
    );
    assert.equal(finished, 1);
  });
}
