// Interactive local run of Scrobblify with Last.fm fully mocked.
//
//   npm run dev:mock                 classic flow only
//   npm run dev:mock -- --background also mocks the background worker
//
// Starts a dev server whose Last.fm is served by the mock middleware in
// vue.config.js, then prints a URL. Open it in whatever browser you like: the
// mocking lives in the server, so every tab, window and device pointed at it is
// covered, and the app shows a MOCK MODE banner so you can tell at a glance.
//
// This used to drive a headed Playwright window and install `page.route()` on a
// single page. Exactly one tab was mocked. Opening the same dev server in your
// ordinary browser reached the real Last.fm and scrobbled to whatever account
// that profile was signed in to, with no indication that anything was different
// — while this script's own banner said "nothing is really scrobbled".
//
// With --background it additionally:
//
//   * sets VUE_APP_BACKGROUND_API, which is what switches the background
//     feature on at all — `isBackgroundConfigured()` is false without it, and
//     every handoff screen stays hidden;
//   * serves tests/backgroundMock.js, a fake worker, so no wrangler / D1 / R2
//     or deployment is involved;
//   * generates a 3,000-track history, because the offer is gated on 2,700
//     remaining tracks and the committed fixture has five. Upload it by hand;
//     the path is printed below.
//
// The server always starts fresh on its own port, never 8080, and never reuses
// one it finds. Both halves of that matter:
//
//   * VUE_APP_* is inlined by webpack at compile time, so a server started
//     without the mock env has already baked the real Last.fm URL into the
//     bundle. Adopting it would mock nothing while announcing the opposite —
//     the same bug in a new costume.
//   * playwright.config.ts sets `reuseExistingServer` on 8080. A mock server
//     left running there would be silently adopted by the next
//     `npx playwright test`, whose specs intercept ws.audioscrobbler.com — a
//     URL the mocked app no longer calls.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { MIN_TRACKS } = require('./backgroundMock');
const { generateLargeFixture } = require('./fixtures/generate-fixture');
const { mockEnv } = require('./mockPaths');

const PORT = 8090;
const BASE_URL = `http://localhost:${PORT}`;
// Must be the publicPath (see vue.config.js): webpack only serves the app
// there, and `/` is not reliable for a non-browser probe.
const READY_URL = `${BASE_URL}/scrobblify/`;

const args = process.argv.slice(2);
const BACKGROUND = args.includes('--background');
// With --background the URL carries `?beta=1`, because the handoff offer is
// behind that opt-in. It is sticky (localStorage), so it only needs visiting
// once per browser profile; `?beta=0` switches it back off.
const APP_URL = BACKGROUND
  ? `${BASE_URL}/scrobblify/?beta=1#/scrobble`
  : `${BASE_URL}/scrobblify/#/scrobble`;
const TRACK_COUNT = Number(args[args.indexOf('--tracks') + 1]) || MIN_TRACKS + 300;
const LARGE_FIXTURE = path.join(__dirname, 'fixtures', 'test-spotify-data-large.zip');

function isServerUp() {
  return new Promise((resolve) => {
    const req = http.get(READY_URL, (res) => {
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

function isPortTaken() {
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

function banner() {
  const line = '='.repeat(66);
  console.log('');
  console.log(line);
  console.log('  Scrobblify is running with Last.fm MOCKED.');
  console.log('');
  console.log(`  Open:  ${APP_URL}`);
  console.log('');
  console.log('  Any browser works — the mock lives in the dev server, not in a');
  console.log('  remote-controlled window. Look for the MOCK MODE banner; if it');
  console.log('  is not there, you are not mocked.');
  console.log('');
  console.log('  "Click here to authorize" goes to the mock and signs you in as');
  console.log('  "testuser". All Last.fm calls return canned data.');
  if (BACKGROUND) {
    console.log('');
    console.log('  Background worker MOCKED (no wrangler needed).');
    console.log('  The offer is behind ?beta=1, which the URL above already has.');
    console.log(`  Upload this by hand:  ${LARGE_FIXTURE}`);
    console.log('  Then select every track, press Scrobble, then "Pause & Save".');
    console.log('  The handoff offer lives on the paused screen — that is by design.');
    console.log('  The simulated job runs at ~40 tracks/sec so the status card moves.');
  }
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log(line);
  console.log('');
}

async function main() {
  if (await isPortTaken()) {
    console.error(`Port ${PORT} is already in use.`);
    console.error('');
    console.error('This script will not adopt a server it did not start: the mock');
    console.error('endpoints are compiled into the bundle, so a server started');
    console.error('without them would talk to the real Last.fm.');
    console.error('');
    console.error('Stop whatever is on that port and try again.');
    process.exit(1);
  }

  if (BACKGROUND && !fs.existsSync(LARGE_FIXTURE)) {
    console.log(`Generating a ${TRACK_COUNT}-track history fixture...`);
    const r = await generateLargeFixture(TRACK_COUNT, LARGE_FIXTURE);
    console.log(`✓ ${r.path} (${r.bytes} bytes)`);
  }

  console.log(`Starting dev server (vue-cli-service serve) on port ${PORT}...`);
  const serverProc = spawn(
    'npx',
    ['vue-cli-service', 'serve', '--port', String(PORT)],
    {
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, ...mockEnv({ background: BACKGROUND }) },
    },
  );

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    serverProc.kill();
    process.exit(0);
  };

  serverProc.on('exit', (code) => {
    if (!shuttingDown && code && code !== 0) {
      console.error(`Dev server exited with code ${code}`);
      process.exit(code);
    }
  });

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log('Waiting for dev server to become ready...');
  const ready = await waitForServer(180000);
  if (!ready) {
    console.error('Dev server did not start within 180s.');
    serverProc.kill();
    process.exit(1);
  }

  banner();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
