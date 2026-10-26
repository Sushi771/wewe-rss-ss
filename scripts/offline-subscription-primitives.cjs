// Render real shared list controls in the existing lightweight JSX fixtures.
// NextUI controls stay inert; this imports the production options/selection markup.
const fs = require('node:fs'),
  vm = require('node:vm'),
  path = require('node:path');
const ts = require(
  require.resolve('typescript', { paths: [path.resolve('apps/web')] }),
);
module.exports = function (jsx, react) {
  const module = { exports: {} };
  const code = ts.transpileModule(
    fs.readFileSync(
      'apps/web/src/components/SubscriptionPrimitives.tsx',
      'utf8',
    ),
    {
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  vm.runInNewContext(code, {
    module,
    exports: module.exports,
    require(name) {
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx };
      if (
        name === '@nextui-org/react' ||
        name === '@web/components/AppOverlays'
      )
        return new Proxy({}, { get: (_, key) => key });
      throw Error('Unexpected primitive dependency ' + name);
    },
  });
  return module.exports;
};
