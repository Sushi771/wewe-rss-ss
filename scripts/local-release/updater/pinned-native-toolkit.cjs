'use strict';
// Reuse the original reviewed native identity executable with fresh byte pins.
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');
const { verifyPinnedInput: pin } = require('./prepare-maintenance-binding.cjs');
function createPinnedToolkit(nativeTool) {
  pin(nativeTool);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      [
        'SYSTEMROOT',
        'WINDIR',
        'PATH',
        'PATHEXT',
        'TEMP',
        'TMP',
        'COMSPEC',
        'PROCESSOR_ARCHITECTURE',
        'NUMBER_OF_PROCESSORS',
      ].includes(key.toUpperCase()),
    ),
  );
  const processIdentity = (action, pid, port, expected) => {
    pin(nativeTool);
    const result = JSON.parse(
      cp.execFileSync(
        nativeTool.path,
        [
          action,
          String(pid),
          String(port),
          expected?.startUtc || '',
          expected?.executable || '',
          expected?.commandLine || '',
        ],
        {
          env,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 16000,
          maxBuffer: 262144,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    );
    pin(nativeTool);
    return result;
  };
  return {
    processIdentity,
    sameIdentity(actual, expected) {
      for (const field of ['pid', 'startUtc', 'commandLine', 'port'])
        assert.equal(
          actual[field],
          expected[field],
          'NATIVE_IDENTITY_CHANGED_' + field.toUpperCase(),
        );
      assert.equal(
        path.resolve(actual.executable).toLowerCase(),
        path.resolve(expected.executable).toLowerCase(),
        'NATIVE_IDENTITY_CHANGED_EXECUTABLE',
      );
      return true;
    },
    observeProjectWriters(roots, port) {
      const active = new Map();
      for (const root of roots) {
        const tree = processIdentity('Tree', root, port);
        if (tree?.complete !== true || !Array.isArray(tree.active))
          throw Error('NATIVE_WRITER_OBSERVATION_INCOMPLETE');
        for (const item of tree.active) active.set(item.pid, item);
      }
      return { complete: true, active: [...active.values()] };
    },
    waitReady() {
      throw Error('FIXED_READ_ONLY_INSTALL_USES_BOUND_NATIVE_HEALTH');
    },
  };
}
module.exports = { createPinnedToolkit };
