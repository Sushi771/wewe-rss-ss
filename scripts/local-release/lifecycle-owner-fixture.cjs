// Only spawned by bounded regression tests; has no runtime service children.
const path = require('node:path');
const run = require('./test-artifacts.cjs').begin({
  migrations: path.resolve(__dirname, '../../apps/server/prisma/migrations'),
});
process.send({ audit: run.audit, database: run.database });
setInterval(() => {}, 1000);
