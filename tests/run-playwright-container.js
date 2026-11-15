const { spawnSync } = require('child_process');
const {
  version: installedPlaywrightVersion,
} = require('@playwright/test/package.json');

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

function main() {
  const result = spawnSync(
    'docker',
    dockerArgs(installedPlaywrightVersion, process.argv.slice(2), process.cwd()),
    { stdio: 'inherit' },
  );

  if (result.error) {
    console.error(`Failed to start Docker: ${result.error.message}`);
    return 1;
  }

  if (result.signal) {
    console.error(`Docker terminated by signal ${result.signal}.`);
    return 1;
  }

  if (result.status === null) {
    console.error('Docker exited without reporting a status.');
    return 1;
  }

  return result.status;
}

module.exports = {
  dockerArgs,
  imageForVersion,
};

if (require.main === module) {
  process.exitCode = main();
}
