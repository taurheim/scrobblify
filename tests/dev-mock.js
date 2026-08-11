// Interactive local run of Scrobblify with Last.fm fully mocked.
//
//   npm run dev:mock                 classic flow only
//   npm run dev:mock -- --background also mocks the background worker
//
// Opens a real (headed) Chromium window pointed at the dev server, intercepts
// every Last.fm API call with canned responses, and pre-seeds the logged-in
// state — so you can click through the whole upload -> select -> scrobble flow
// without a real Last.fm account. Reuses the exact mock the Playwright tests
// use (tests/lastfmMock.js).
//
// With --background it additionally:
//
//   * starts the dev server with VUE_APP_BACKGROUND_API set, which is what
//     switches the background feature on at all — `isBackgroundConfigured()`
//     is false without it, and every handoff screen stays hidden;
//   * intercepts that origin with tests/backgroundMock.js, a fake worker, so
//     no wrangler / D1 / R2 / deployment is involved;
//   * generates and uploads a 3,000-track history, because the offer is gated
//     on 2,700 remaining tracks and the committed fixture has five.
//
// If a dev server is already running on port 8080 it is reused; otherwise this
// script starts `vue-cli-service serve` for you and shuts it down on exit.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('@playwright/test');
const { interceptLastFm, mockLastFmAuth } = require('./lastfmMock');
const { interceptBackgroundWorker, MIN_TRACKS, DEFAULT_API_ORIGIN } = require('./backgroundMock');
const { generateLargeFixture } = require('./fixtures/generate-fixture');

const PORT = 8080;
const BASE_URL = `http://localhost:${PORT}`;
const START_PATH = '/#/scrobble';

const args = process.argv.slice(2);
const BACKGROUND = args.includes('--background');
const TRACK_COUNT = Number(args[args.indexOf('--tracks') + 1]) || MIN_TRACKS + 300;
const LARGE_FIXTURE = path.join(__dirname, 'fixtures', 'test-spotify-data-large.zip');

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
    if (BACKGROUND) {
      // VUE_APP_* is inlined by webpack at compile time, so a server started
      // without it has already baked an empty API base into the bundle and no
      // amount of mocking here can switch the feature on.
      console.log('');
      console.log('  !! That server was not started by this script, so it may not have');
      console.log('     VUE_APP_BACKGROUND_API compiled in. If no background offer appears,');
      console.log('     stop it and re-run this command so it can start its own.');
      console.log('');
    }
  } else {
    console.log(`Starting dev server (vue-cli-service serve) on port ${PORT}...`);
    serverProc = spawn(
      'npx',
      ['vue-cli-service', 'serve', '--port', String(PORT)],
      {
        stdio: 'inherit',
        shell: true,
        env: BACKGROUND
          ? { ...process.env, VUE_APP_BACKGROUND_API: DEFAULT_API_ORIGIN }
          : process.env,
      },
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

  if (BACKGROUND && !fs.existsSync(LARGE_FIXTURE)) {
    console.log(`Generating a ${TRACK_COUNT}-track history fixture...`);
    const r = await generateLargeFixture(TRACK_COUNT, LARGE_FIXTURE);
    console.log(`✓ ${r.path} (${r.bytes} bytes)`);
  }

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();

  // Install the shared Last.fm mock before any navigation.
  await interceptLastFm(page);
  if (BACKGROUND) {
    await interceptBackgroundWorker(page, { appOrigin: BASE_URL });
  }

  // Establish the origin so localStorage is writable, seed auth, then reload so
  // the app's init() picks up the "logged in" session from localStorage.
  await page.goto(BASE_URL + START_PATH);
  await mockLastFmAuth(page);
  await page.reload();

  if (BACKGROUND) {
    // Drop the user straight on the select step. Parsing 3,000 entries by hand
    // through the file picker every run is friction with no upside.
    try {
      await page.locator('.upload-step').waitFor({ timeout: 30000 });
      await page.locator('input[type="file"][accept=".zip"]').setInputFiles(LARGE_FIXTURE);
      console.log('✓ Uploaded the large fixture — pick a date range and continue.');
    } catch (e) {
      console.log(`(Could not auto-upload the fixture: ${e.message}. Upload ${LARGE_FIXTURE} by hand.)`);
    }
  }

  console.log('');
  console.log('==================================================================');
  console.log('  Scrobblify is running with Last.fm MOCKED.');
  console.log(`  URL:  ${BASE_URL}${START_PATH}`);
  console.log('  You are auto-authenticated as "testuser" — no real account used.');
  console.log('  All Last.fm calls return canned data; nothing is really scrobbled.');
  if (BACKGROUND) {
    console.log('');
    console.log(`  Background worker MOCKED at ${DEFAULT_API_ORIGIN} (no wrangler needed).`);
    console.log('  Select every track, press Scrobble, then press "Pause & Save".');
    console.log('  The handoff offer lives on the paused screen — that is by design.');
    console.log('  The Last.fm redirect is replaced by a same-origin shim page.');
    console.log('  The simulated job runs at ~40 tracks/sec so the status card moves.');
  }
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
