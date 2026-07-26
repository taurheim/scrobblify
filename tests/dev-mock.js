// Interactive local run of Scrobblify with Last.fm fully mocked.
//
//   npm run dev:mock
//
// Opens a real (headed) Chromium window pointed at the dev server, intercepts
// every Last.fm API call with canned responses, and pre-seeds the logged-in
// state — so you can click through the whole upload -> select -> scrobble flow
// without a real Last.fm account. Reuses the exact mock the Playwright tests
// use (tests/lastfmMock.js).
//
// If a dev server is already running on port 8080 it is reused; otherwise this
// script starts `vue-cli-service serve` for you and shuts it down on exit.

const http = require('http');
const { spawn } = require('child_process');
const { chromium } = require('@playwright/test');
const { interceptLastFm, mockLastFmAuth } = require('./lastfmMock');

const PORT = 8080;
const BASE_URL = `http://localhost:${PORT}`;
const START_PATH = '/#/scrobble';

function isServerUp() {
  return new Promise((resolve) => {
    const req = http.get(BASE_URL, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    if (await isServerUp()) {
      return true;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function main() {
  let serverProc = null;

  if (await isServerUp()) {
    console.log(`✓ Reusing dev server already running at ${BASE_URL}`);
  } else {
    console.log(`Starting dev server (vue-cli-service serve) on port ${PORT}...`);
    serverProc = spawn(
      'npx',
      ['vue-cli-service', 'serve', '--port', String(PORT)],
      { stdio: 'inherit', shell: true },
    );
    serverProc.on('exit', (code) => {
      if (code && code !== 0) {
        console.error(`Dev server exited with code ${code}`);
        process.exit(code);
      }
    });

    console.log('Waiting for dev server to become ready...');
    const ready = await waitForServer(90000);
    if (!ready) {
      console.error('Dev server did not start within 90s.');
      if (serverProc) {
        serverProc.kill();
      }
      process.exit(1);
    }
    console.log('✓ Dev server is ready.');
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // Install the shared Last.fm mock before any navigation.
  await interceptLastFm(page);

  // Establish the origin so localStorage is writable, seed auth, then reload so
  // the app's init() picks up the "logged in" session from localStorage.
  await page.goto(BASE_URL + START_PATH);
  await mockLastFmAuth(page);
  await page.reload();

  console.log('');
  console.log('==================================================================');
  console.log('  Scrobblify is running with Last.fm MOCKED.');
  console.log(`  URL:  ${BASE_URL}${START_PATH}`);
  console.log('  You are auto-authenticated as "testuser" — no real account used.');
  console.log('  All Last.fm calls return canned data; nothing is really scrobbled.');
  console.log('  Close the browser window (or press Ctrl+C) to stop.');
  console.log('==================================================================');
  console.log('');

  const shutdown = async () => {
    try {
      await browser.close();
    } catch (e) { /* already closed */ }
    if (serverProc) {
      serverProc.kill();
    }
    process.exit(0);
  };

  // Exit when the user closes the browser window.
  browser.on('disconnected', shutdown);
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
