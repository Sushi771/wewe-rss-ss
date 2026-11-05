'use strict';
// Explicit test-only deny: never let a missing engine trigger a download.
const net = require('node:net');
net.Socket.prototype.connect = function () { throw new Error('NETWORK_FORBIDDEN'); };
for (const name of ['node:http', 'node:https']) {
  const module = require(name);
  module.request = module.get = () => { throw new Error('NETWORK_FORBIDDEN'); };
}
