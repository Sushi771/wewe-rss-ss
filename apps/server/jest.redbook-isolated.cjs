const {
  isolatedClient,
} = require('./scripts/redbook-isolated/resolve-run.cjs');
module.exports = {
  rootDir: 'src',
  roots: ['<rootDir>', '<rootDir>/../test/redbook-isolated'],
  testEnvironment: 'node',
  testRegex: '.*\\.(spec|worker)\\.ts$',
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { diagnostics: false, tsconfig: { isolatedModules: true } },
    ],
  },
  moduleNameMapper: {
    '^@server/(.*)$': '<rootDir>/$1',
    '^@wewe-rss/shared$': '<rootDir>/../../../packages/shared/src/index.ts',
    '^@prisma/client$': isolatedClient(),
  },
};
