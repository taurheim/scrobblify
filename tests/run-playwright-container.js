const { spawnSync } = require('child_process');

function defaultLoadPackage() {
  // Load at execution time so tests and callers can replace package resolution.
  // eslint-disable-next-line global-require
  return require('@playwright/test/package.json');
}

function defaultLogError(message) {
  console.error(message);
}

function imageForVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Playwright version must be a stable semantic version, received: ${version}`);
  }

  return `mcr.microsoft.com/playwright:v${version}-noble`;
}

function dockerArgs(version, playwrightArgs, repositoryPath) {
  return [
    'run',
    '--rm',
    '--init',
    '--ipc=host',
    '-e',
    'CI=true',
    // Forward build identity because linked worktree git metadata is unavailable in Linux.
    '-e',
    'GITHUB_SHA',
    '-e',
    'GITHUB_RUN_NUMBER',
    '-v',
    `${repositoryPath}:/work`,
    '-w',
    '/work',
    imageForVersion(version),
    'npx',
    'playwright',
    'test',
    ...playwrightArgs,
  ];
}

function run(playwrightArgs, options = {}) {
  const {
    spawn = spawnSync,
    loadPackage = defaultLoadPackage,
    workspace = process.cwd(),
    logError = defaultLogError,
  } = options;
  const { version } = loadPackage('@playwright/test/package.json');
  const result = spawn(
    'docker',
    dockerArgs(version, playwrightArgs, workspace),
    { stdio: 'inherit' },
  );

  if (result.error) {
    logError(`Failed to start Docker: ${result.error.message}`);
    return 1;
  }

  if (result.signal) {
    logError(`Docker terminated by signal ${result.signal}.`);
    return 1;
  }

  if (result.status === null) {
    logError('Docker exited without reporting a status.');
    return 1;
  }

  return result.status;
}

module.exports = {
  dockerArgs,
  imageForVersion,
  run,
};

if (require.main === module) {
  process.exitCode = run(process.argv.slice(2));
}
