// The server tsconfig excludes scripts; keep this new diagnostic tool checked.
const path = require('node:path');
const server = path.resolve(__dirname, '../apps/server');
const ts = require(require.resolve('typescript', { paths: [server] }));
const loaded = ts.readConfigFile(
  path.join(server, 'tsconfig.json'),
  ts.sys.readFile,
);
if (loaded.error)
  throw Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
const config = ts.parseJsonConfigFileContent(loaded.config, ts.sys, server);
const program = ts.createProgram(
  [path.join(server, 'scripts/benchmark-reading-first.ts')],
  {
    ...config.options,
    noEmit: true,
    incremental: false,
  },
);
const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)];
if (diagnostics.length) {
  process.stderr.write(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCurrentDirectory: ts.sys.getCurrentDirectory,
      getCanonicalFileName: (file) => file,
      getNewLine: () => '\n',
    }),
  );
  process.exitCode = 1;
}
