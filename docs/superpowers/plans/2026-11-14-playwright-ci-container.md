# Playwright CI Container Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run E2E tests in the official Playwright container matching the installed package version, so GitHub runner OS upgrades cannot break browser setup.

**Architecture:** A focused Node helper reads `@playwright/test`'s installed version, builds the matching `mcr.microsoft.com/playwright:v<version>-noble` image name, and invokes Docker without a shell. PR and master workflows use the same helper for both browser suites, while Dependabot keeps the npm dependency current.

**Tech Stack:** Node.js, Docker, Playwright, GitHub Actions, Dependabot

---

### Task 1: Add the Playwright container runner

**Files:**
- Create: `tests/run-playwright-container.js`
- Create: `tests/run-playwright-container.test.js`
- Modify: `package.json`

- [ ] **Step 1: Write the failing helper test**

Create `tests/run-playwright-container.test.js`:

```js
const assert = require('assert');
const {
  imageForVersion,
  dockerArgs,
} = require('./run-playwright-container');

assert.strictEqual(
  imageForVersion('1.59.1'),
  'mcr.microsoft.com/playwright:v1.59.1-noble',
);
assert.throws(
  () => imageForVersion('latest'),
  /stable semantic version/,
);
assert.deepStrictEqual(
  dockerArgs('1.59.1', ['--config=playwright.unreachable-worker.config.ts'], '/repo'),
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

console.log('Playwright container helper tests passed');
```

- [ ] **Step 2: Run the helper test and verify it fails**

Run:

```powershell
node tests\run-playwright-container.test.js
```

Expected: FAIL with `Cannot find module './run-playwright-container'`.

- [ ] **Step 3: Implement the container runner**

Create `tests/run-playwright-container.js`:

```js
const { spawnSync } = require('child_process');

const STABLE_VERSION = /^\d+\.\d+\.\d+$/;

function imageForVersion(version) {
  if (!STABLE_VERSION.test(version)) {
    throw new Error(
      `Playwright version "${version}" is not a stable semantic version`,
    );
  }
  return `mcr.microsoft.com/playwright:v${version}-noble`;
}

function dockerArgs(version, playwrightArgs, workspace = process.cwd()) {
  return [
    'run',
    '--rm',
    '--init',
    '--ipc=host',
    '-e',
    'CI=true',
    '-v',
    `${workspace}:/work`,
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
  const { version } = require('@playwright/test/package.json');
  const result = spawnSync(
    'docker',
    dockerArgs(version, process.argv.slice(2)),
    { stdio: 'inherit' },
  );

  if (result.error) {
    console.error(`Failed to start Docker: ${result.error.message}`);
    return 1;
  }
  if (result.signal) {
    console.error(`Playwright container stopped by signal ${result.signal}`);
    return 1;
  }
  return result.status === null ? 1 : result.status;
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = {
  imageForVersion,
  dockerArgs,
};
```

- [ ] **Step 4: Add package scripts**

Add these entries to `package.json` under `scripts`:

```json
"test:e2e:container": "node tests/run-playwright-container.js",
"test:e2e:container:check": "node tests/run-playwright-container.test.js"
```

- [ ] **Step 5: Run the helper test and lint**

Run:

```powershell
npm run test:e2e:container:check
npm run lint:check
```

Expected: helper prints `Playwright container helper tests passed`; lint exits
zero with only the repository's existing warnings.

- [ ] **Step 6: Commit the helper**

```powershell
git add package.json tests\run-playwright-container.js tests\run-playwright-container.test.js
git commit -m "Run Playwright through its matching container" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Move both E2E workflows into the container

**Files:**
- Modify: `.github/workflows/pr.yml`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Replace the PR E2E setup**

In `.github/workflows/pr.yml`, replace:

```yaml
      - run: npx playwright install --with-deps
      - run: npx playwright test
      - run: npx playwright test -c playwright.unreachable-worker.config.ts
```

with:

```yaml
      - run: npm run test:e2e:container:check
      - run: npm run test:e2e:container
      - run: npm run test:e2e:container -- --config=playwright.unreachable-worker.config.ts
```

- [ ] **Step 2: Replace the master E2E setup**

Make the identical replacement in `.github/workflows/ci.yml`.

- [ ] **Step 3: Verify workflow commands and removed installer**

Run:

```powershell
rg "playwright install --with-deps|test:e2e:container" .github\workflows
```

Expected: no `playwright install --with-deps` matches and six
`test:e2e:container` command matches across the two workflows.

- [ ] **Step 4: Smoke-test the Docker runner**

Run:

```powershell
npm run test:e2e:container -- tests/scrobblify.spec.ts --grep "renders home page with instructions" --reporter=line
npm run test:e2e:container -- --config=playwright.unreachable-worker.config.ts --grep "a large import is not offered background scrobbling without the beta flag" --reporter=line
```

Expected: one standard test and one unreachable-worker test pass inside the
official Playwright image matching the installed package.

- [ ] **Step 5: Commit the workflow change**

```powershell
git add .github\workflows\pr.yml .github\workflows\ci.yml
git commit -m "Isolate E2E from GitHub runner upgrades" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Automate Playwright dependency updates

**Files:**
- Create: `.github/dependabot.yml`

- [ ] **Step 1: Add weekly Playwright updates**

Create `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
    allow:
      - dependency-name: "@playwright/test"
    groups:
      playwright:
        patterns:
          - "@playwright/*"
```

- [ ] **Step 2: Verify the update configuration**

Run:

```powershell
Get-Content .github\dependabot.yml
git diff --check
```

Expected: valid indentation, npm updates rooted at `/`, restricted to
`@playwright/test`, weekly schedule, and no whitespace errors.

- [ ] **Step 3: Commit dependency automation**

```powershell
git add .github\dependabot.yml
git commit -m "Keep Playwright dependencies current" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Verify the complete CI change

**Files:**
- Verify: `tests/run-playwright-container.js`
- Verify: `.github/workflows/pr.yml`
- Verify: `.github/workflows/ci.yml`
- Verify: `.github/dependabot.yml`

- [ ] **Step 1: Run static and build validation**

Run:

```powershell
npm run test:e2e:container:check
npm run lint:check
npm run build
```

Expected: all commands exit zero; existing lint and bundle-size warnings are
non-fatal.

- [ ] **Step 2: Run worker validation**

Run:

```powershell
npm --prefix worker test
```

Expected: worker typechecks and all worker test modules report `ALL PASSED`.

- [ ] **Step 3: Run both complete browser suites through Docker**

Run:

```powershell
npm run test:e2e:container
npm run test:e2e:container -- --config=playwright.unreachable-worker.config.ts
```

Expected: the standard browser suite and all 10 unreachable-worker tests pass.

- [ ] **Step 4: Inspect the final diff**

Run:

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors and only the intended CI helper, workflow, and
Dependabot changes.

- [ ] **Step 5: Push and verify GitHub CI**

Run:

```powershell
git push origin feat/background-scrobbling
gh pr checks 85 --repo taurheim/scrobblify --watch
```

Expected: Lint, Build, and E2E Tests all complete successfully; E2E no longer
runs `playwright install --with-deps`.
