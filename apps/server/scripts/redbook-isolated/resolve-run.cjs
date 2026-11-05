'use strict';
const fs = require('node:fs');
const path = require('node:path');
function isolatedClient() {
  const server = fs.realpathSync(path.resolve(__dirname, '../..'));
  const root = path.join(server, '.redbook-isolated');
  const requested = process.env.REDBOOK_TEST_RUN;
  if (
    !requested ||
    !fs.existsSync(root) ||
    fs.lstatSync(root).isSymbolicLink() ||
    fs.realpathSync(root) !== root
  )
    throw Error('ISOLATED_TEST_RUN_REQUIRED');
  const run = fs.realpathSync(requested);
  if (path.dirname(run) !== root || !path.basename(run).startsWith('run-'))
    throw Error('ISOLATED_TEST_RUN_INVALID');
  const owner = JSON.parse(
    fs.readFileSync(path.join(run, 'fixture-owner.json'), 'utf8'),
  );
  if (owner.server !== server || owner.run !== run)
    throw Error('ISOLATED_TEST_RUN_INVALID');
  const client = path.join(run, 'prisma-client', 'default.js');
  if (fs.realpathSync(client) !== client)
    throw Error('ISOLATED_TEST_RUN_INVALID');
  return client;
}
module.exports = { isolatedClient };
