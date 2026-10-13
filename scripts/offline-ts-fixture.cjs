// Load pure production helpers in offline component fixtures without duplicating them.
const fs = require('node:fs');
const path = require('node:path');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
function loadActualTs(file) {
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loaded = { exports: {} };
  new Function('require', 'exports', 'module', compiled)(
    (name) =>
      require(
        require.resolve(name, {
          paths: [path.resolve('apps/server'), path.resolve('packages/shared')],
        }),
      ),
    loaded.exports,
    loaded,
  );
  return loaded.exports;
}
module.exports = { loadActualTs };
