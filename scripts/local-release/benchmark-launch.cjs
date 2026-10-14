// Bounded offline cold-start measurements; no database or release-tree cloning.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { parseArgs } = require('node:util');
const { controlledRestart } = require('./restart.cjs');
const budget = require('./space-budget.cjs');
async function benchmark({
  release,
  database,
  outputRoot,
  realCopy = false,
  keepTestDatabases = false,
  resumeReport,
  baselineRef,
}) {
  if (resumeReport || (baselineRef && baselineRef !== 'HEAD'))
    throw new Error(
      'Historical controllers and resumable database copies require a separate reviewed budget; use the guarded current benchmark',
    );
  const root = budget.canonical(
    outputRoot ||
      process.env.WEWE_TEST_OUTPUT_ROOT ||
      path.join(os.tmpdir(), 'wewe-rss-tests'),
  );
  const measurements = [];
  for (let index = 0; index < 2; index++) {
    const started = performance.now();
    const result = await controlledRestart({
      release,
      database,
      mode: 'start',
      rehearsal: true,
      production: false,
      outputRoot: root,
      realCopy,
      keepTestDatabases,
      reuseVerified: index > 0,
    });
    measurements.push({
      label: index
        ? 'verified-reuse-cold-start'
        : 'full-verification-cold-start',
      ms: Math.round(performance.now() - started),
      audit: result.audit,
      passed: result.passed,
    });
  }
  const report = path.join(root, 'benchmark-' + crypto.randomUUID() + '.json');
  fs.writeFileSync(
    report,
    JSON.stringify(
      { measurements, synthetic: !database, release, report },
      null,
      2,
    ),
  );
  return { measurements, report };
}
if (require.main === module) {
  const { values } = parseArgs({
    options: {
      release: { type: 'string' },
      database: { type: 'string' },
      'output-root': { type: 'string' },
      'real-copy': { type: 'boolean', default: false },
      'keep-test-databases': { type: 'boolean', default: false },
      'resume-report': { type: 'string' },
      'baseline-ref': { type: 'string' },
    },
  });
  benchmark({
    ...values,
    outputRoot: values['output-root'],
    realCopy: values['real-copy'],
    keepTestDatabases: values['keep-test-databases'],
    resumeReport: values['resume-report'],
    baselineRef: values['baseline-ref'],
  })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
module.exports = { benchmark };
