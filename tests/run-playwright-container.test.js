const assert = require('assert');

const {
  dockerArgs,
  imageForVersion,
  run,
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
    '-e',
    'GITHUB_SHA',
    '-e',
    'GITHUB_RUN_NUMBER',
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

const spawnCalls = [];
const loadedPackages = [];
const status = run(['--grep', 'smoke'], {
  spawn(command, args, options) {
    spawnCalls.push({ command, args, options });
    return { status: 0 };
  },
  loadPackage(packageName) {
    loadedPackages.push(packageName);
    return { version: '1.60.2' };
  },
  workspace: '/workspace',
});

assert.strictEqual(status, 0);
assert.deepStrictEqual(loadedPackages, ['@playwright/test/package.json']);
assert.deepStrictEqual(spawnCalls, [{
  command: 'docker',
  args: dockerArgs('1.60.2', ['--grep', 'smoke'], '/workspace'),
  options: { stdio: 'inherit' },
}]);

const launchErrors = [];
assert.strictEqual(
  run([], {
    spawn: () => ({ error: new Error('docker not found') }),
    loadPackage: () => ({ version: '1.59.1' }),
    logError: (message) => launchErrors.push(message),
  }),
  1,
);
assert.deepStrictEqual(
  launchErrors,
  ['Failed to start Docker: docker not found'],
);

const signalErrors = [];
assert.strictEqual(
  run([], {
    spawn: () => ({ signal: 'SIGTERM' }),
    loadPackage: () => ({ version: '1.59.1' }),
    logError: (message) => signalErrors.push(message),
  }),
  1,
);
assert.deepStrictEqual(
  signalErrors,
  ['Docker terminated by signal SIGTERM.'],
);

const nullStatusErrors = [];
assert.strictEqual(
  run([], {
    spawn: () => ({ status: null }),
    loadPackage: () => ({ version: '1.59.1' }),
    logError: (message) => nullStatusErrors.push(message),
  }),
  1,
);
assert.deepStrictEqual(
  nullStatusErrors,
  ['Docker exited without reporting a status.'],
);

assert.strictEqual(
  run([], {
    spawn: () => ({ status: 37 }),
    loadPackage: () => ({ version: '1.59.1' }),
  }),
  37,
);
