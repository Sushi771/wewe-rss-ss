'use strict';
// A fixed invocation may load only its reviewed code closure and Node builtins.
// AsyncLocalStorage keeps independent tests/callers outside this invocation free.
const Module = require('node:module');
const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('node:path');
const { verifyPinnedInput } = require('./prepare-maintenance-binding.cjs');
const context = new AsyncLocalStorage();
const original = Module._load;
Module._load = function (request, parent, isMain) {
  const pins = context.getStore();
  if (pins && !Module.isBuiltin(request)) {
    const resolved = Module._resolveFilename(request, parent, isMain);
    const entry = pins.get(path.resolve(resolved).toLowerCase());
    if (!entry) throw Error('FIXED_TRANSITIVE_CODE_NOT_PINNED');
    verifyPinnedInput(entry);
  }
  return Reflect.apply(original, this, arguments);
};
function withFixedCode(closure, run) {
  return context.run(
    new Map(closure.map((pin) => [path.resolve(pin.path).toLowerCase(), pin])),
    run,
  );
}
module.exports = { withFixedCode };
