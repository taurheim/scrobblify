/**
 * Bundles and runs every `worker/test/*.test.ts`.
 *
 * esbuild rather than ts-node so the tests execute the same way the worker is
 * built, and so a TypeScript-only construct that esbuild cannot handle fails
 * here rather than at deploy time. `node:*` stays external because the worker
 * bundle must never contain Node built-ins, but the tests may use them.
 */
import { readdirSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, '.test-build');
const esbuild = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const tests = readdirSync(join(root, 'test')).filter((f) => f.endsWith('.test.ts'));
if (tests.length === 0) {
  console.error('No tests found.');
  process.exit(1);
}

let failed = 0;
for (const test of tests) {
  const out = join(outDir, test.replace(/\.ts$/, '.cjs'));
  const build = spawnSync(esbuild, [
    join(root, 'test', test),
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--external:node:*',
    `--outfile=${out}`,
  ], { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });

  if (build.status !== 0) {
    console.error(`\n${test}: build failed`);
    failed += 1;
    continue;
  }

  console.log(`\n=== ${test} ===`);
  const run = spawnSync(process.execPath, ['--no-warnings', out], { stdio: 'inherit' });
  if (run.status !== 0) {
    failed += 1;
  }
}

process.exit(failed === 0 ? 0 : 1);
