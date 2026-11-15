const assert = require('assert');

const {
  dockerArgs,
  imageForVersion,
} = require('./run-playwright-container');

assert.strictEqual(
  imageForVersion('1.59.1'),
  'mcr.microsoft.com/playwright:v1.59.1-noble',
);

assert.throws(
  () => imageForVersion('latest'),
  /stable semantic version/i,
);

assert.deepStrictEqual(
  dockerArgs(
    '1.59.1',
    ['--config=playwright.unreachable-worker.config.ts'],
    '/repo',
  ),
  [
    'run',
    '--rm',
    '--init',
    '--ipc=host',
    '-e',
    'CI=true',
    '-v',
    '/repo:/work',
    '-w',
    '/work',
    'mcr.microsoft.com/playwright:v1.59.1-noble',
    'npx',
    'playwright',
    'test',
    '--config=playwright.unreachable-worker.config.ts',
  ],
);
