const test = require('node:test');
const assert = require('node:assert/strict');
const { actualEngineCommit, sqliteRuntimeUrl } = require('./engine-audit.cjs');

test('engine audit reads the loaded native version rather than generated client metadata', () => {
  const actual = '5a9203d0590c951969e85a7d07215503f4672eb9';
  assert.equal(actualEngineCommit('synthetic.node', () => ({ version: () => ({ commit: actual }) })), actual);
  assert.throws(() => actualEngineCommit('synthetic.node', () => ({ version: () => ({ commit: 'unproven' }) })), /invalid/);
});

test('SQLite runtime uses one connection for the entire application without changing disk configuration', () => {
  assert.equal(sqliteRuntimeUrl('C:\\isolated\\fixture.db'), 'file:C:/isolated/fixture.db?connection_limit=1');
});
