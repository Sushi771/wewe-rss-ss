'use strict';
// Optional deployed-client pin for the isolated synthetic benchmark child only.
// The benchmark always replaces DATABASE_URL with its own mkdtemp database.
const path = require('node:path');
const Module = require('node:module');
const pinned = process.env.CACHE_BENCHMARK_CLIENT_ENTRY;
if (pinned) {
  if (!path.isAbsolute(pinned))
    throw Error('ABSOLUTE_BENCHMARK_CLIENT_REQUIRED');
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, ...args) {
    return request === '@prisma/client'
      ? pinned
      : original.call(this, request, ...args);
  };
}
