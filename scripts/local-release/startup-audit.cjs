// One transient worker per runtime. HTTP and cached reads stay responsive while
// the original pinned-snapshot backup/field verification runs off the main thread.
const path = require('node:path');
const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require('node:worker_threads');

function createStartupAudit(options, WorkerClass = Worker) {
  const startedAt = Date.now();
  let worker;
  let settled = false;
  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const state = {
    status: 'verifying',
    startedAt,
    finishedAt: null,
    ready,
    start() {
      if (worker || settled) return;
      let timeout;
      const finish = (status) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        state.status = status;
        state.finishedAt = Date.now();
        resolveReady(status === 'ready');
        console.log(
          JSON.stringify({
            event: 'startup-audit-' + status,
            elapsedMs: state.finishedAt - startedAt,
          }),
        );
      };
      try {
        worker = new WorkerClass(__filename, { workerData: options });
        timeout = setTimeout(
          () => {
            console.error('Startup audit exceeded the 15 minute deadline');
            finish('failed');
            void worker.terminate();
          },
          15 * 60 * 1000,
        );
        worker.on('message', (message) => {
          if (message?.status === 'ready') finish('ready');
          else if (message?.status === 'failed') finish('failed');
        });
        worker.on('error', (error) => {
          console.error('Startup audit worker:', error);
          finish('failed');
        });
        worker.on('exit', () => {
          finish('failed');
        });
      } catch (error) {
        console.error('Startup audit worker:', error);
        finish('failed');
      }
    },
  };
  return state;
}

if (!isMainThread) {
  (async () => {
    const {
      prepareStart,
      UnsupportedBaselineValue,
    } = require('./startup-sqlite.cjs');
    const { database, migrations, auditRoot } = workerData;
    try {
      const baseline = path.join(auditRoot, 'background-baseline.json');
      try {
        await prepareStart(
          database,
          migrations,
          path.join(auditRoot, 'background-backup'),
          baseline,
        );
      } catch (error) {
        if (!(error instanceof UnsupportedBaselineValue)) throw error;
        require('./lib.cjs').run(process.env.SQLITE_BACKUP_PYTHON || 'python', [
          path.join(__dirname, 'prepare-start.py'),
          '--database',
          database,
          '--migrations',
          migrations,
          '--backup-root',
          path.join(auditRoot, 'background-backup'),
          '--baseline',
          baseline,
        ]);
      }
      parentPort.postMessage({ status: 'ready' });
    } catch (error) {
      // Detailed diagnostics remain in the private service log; UI has a short
      // message and never exposes paths, records, credentials or raw evidence.
      console.error('Startup database audit failed:', error);
      parentPort.postMessage({ status: 'failed' });
    }
  })();
}
module.exports = { createStartupAudit };
