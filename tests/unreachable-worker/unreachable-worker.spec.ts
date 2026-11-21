import {
  test, expect, Page, Route,
} from '@playwright/test';
import path from 'path';
import JSZip from 'jszip';
import { interceptLastFm, mockLastFmAuth } from '../lastfmMock';

/*
  Runs only under `playwright.unreachable-worker.config.ts`, which compiles in
  a worker URL that cannot resolve.

  The rule under test: an unanswered authority check blocks scrobbling only for
  a browser that has opted in to the beta or holds some local trace of a
  handover. Everyone else waits briefly and then scrobbles as normal. A blocked
  browser can choose to carry on anyway, unless it holds an ownership record.
*/

const FIXTURE_ZIP = path.resolve(__dirname, '..', 'fixtures', 'test-spotify-data.zip');
const WORKER = 'http://background.invalid/**';
const UNREACHABLE = "text=We can't reach the background scrobble worker";
const CONTINUE_ANYWAY = 'button:has-text("Continue in this browser anyway")';
// Vuetify renders every stepper pane up front, so an unfiltered text match
// finds the hidden copy of this heading before anything has been sent.
const FINISHED = 'text=Finished scrobbling >> visible=true';

// 'refuse' and 'hang' are the two ways a worker goes missing; an object maps
// a path prefix to the JSON the worker answers it with.
type WorkerBehaviour = 'refuse' | 'hang' | Record<string, unknown>;

async function openUploadStep(
  page: Page,
  worker: WorkerBehaviour,
  seed: Record<string, string> = {},
): Promise<{ scrobbles: string[]; workerCalls: string[] }> {
  const scrobbles: string[] = [];
  const workerCalls: string[] = [];
  await interceptLastFm(page);
  await page.route(WORKER, async (route: Route) => {
    workerCalls.push(new URL(route.request().url()).pathname);
    if (worker === 'refuse') {
      await route.abort('internetdisconnected');
      return;
    }
    if (worker === 'hang') {
      // Never answered, so the client's own timeout is what ends it.
      return;
    }
    const { pathname } = new URL(route.request().url());
    const match = Object.keys(worker).find((prefix) => pathname.startsWith(prefix));
    if (!match) {
      await route.abort('internetdisconnected');
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(worker[match]),
    });
  });
  // Registered after `interceptLastFm`: later routes get first refusal.
  await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
    const params = new URLSearchParams(
      route.request().method() === 'POST'
        ? route.request().postData() || ''
        : new URL(route.request().url()).search,
    );
    if (params.get('method') === 'track.scrobble') {
      scrobbles.push(params.get('track[0]') || '');
    }
    await route.fallback();
  });

  await page.goto('/#/scrobble');
  await mockLastFmAuth(page);
  await page.evaluate((entries) => {
    Object.entries(entries).forEach(([key, value]) => window.localStorage.setItem(key, value));
  }, seed);
  await page.reload();
  await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
  return { scrobbles, workerCalls };
}

async function importAndPressScrobble(page: Page) {
  await page.locator('.drop-zone input[type="file"]').setInputFiles(FIXTURE_ZIP);
  await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
  await page.locator('button:has-text("Find tracks")').click();

  await expect(page.locator('.upload-step button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
  await page.locator('.upload-step button:has-text("Choose which tracks to scrobble")').click();
  await expect(page.locator('button:has-text("matching")')).toBeVisible({ timeout: 5000 });
  await page.locator('button:has-text("matching")').click();
  await page.locator('button:has-text("selected tracks")').click();
  await page.locator('.scrobble-confirm button:has-text("Start scrobbling")').click();

  await expect(page.getByRole('button', { name: 'Scrobble', exact: true })).toBeVisible({ timeout: 5000 });
  await page.getByRole('button', { name: 'Scrobble', exact: true }).click();
}

async function expectHeldBack(page: Page, scrobbles: string[]) {
  await expect(page.locator(UNREACHABLE)).toBeVisible({ timeout: 15000 });
  await importAndPressScrobble(page);
  // Long enough for a send that was going to happen to have happened.
  await page.waitForTimeout(3000);
  expect(scrobbles).toEqual([]);
  await expect(page.locator(UNREACHABLE)).toBeVisible();
  // One banner, ever: not a sign-in prompt beside it.
  await expect(page.locator('.scrobblify > .v-alert')).toHaveCount(1);
  // The banner explains the block; the scrobble step must not claim to be
  // still checking underneath it.
  await expect(page.locator('text=Checking whether your import is running')).toHaveCount(0);
  await expect(page.locator('text=Getting ready')).toHaveCount(0);
}

test.describe('Background worker unreachable', () => {
  test('a browser that never opted in still scrobbles when the worker refuses connections', async ({ page }) => {
    const { scrobbles, workerCalls } = await openUploadStep(page, 'refuse');
    await importAndPressScrobble(page);

    await expect(page.locator(FINISHED)).toBeVisible({ timeout: 30000 });
    expect(scrobbles.length).toBeGreaterThan(0);
    // The check still ran; only the missing answer was forgiven.
    expect(workerCalls).toContain('/scrobblify/job/live');
    await expect(page.locator(UNREACHABLE)).toHaveCount(0);
  });

  test('a browser that never opted in still scrobbles when the worker hangs', async ({ page }) => {
    const { scrobbles, workerCalls } = await openUploadStep(page, 'hang');
    await importAndPressScrobble(page);

    await expect(page.locator(FINISHED)).toBeVisible({ timeout: 30000 });
    expect(scrobbles.length).toBeGreaterThan(0);
    expect(workerCalls).toContain('/scrobblify/job/live');
  });

  test('an opted-in browser is held back until it chooses to carry on', async ({ page }) => {
    const { scrobbles } = await openUploadStep(page, 'refuse', {
      'scrobblify.background.beta': '1',
    });
    await expectHeldBack(page, scrobbles);

    await page.locator(CONTINUE_ANYWAY).click();
    // The attempt held back above picks itself up; no second press needed.
    await expect(page.locator(FINISHED)).toBeVisible({ timeout: 30000 });
    expect(scrobbles.length).toBeGreaterThan(0);
    await expect(page.locator(UNREACHABLE)).toHaveCount(0);
  });

  test('a browser holding a handover record is held back even without the opt-in', async ({ page }) => {
    const { scrobbles } = await openUploadStep(page, 'refuse', {
      'scrobblify.background.serverOwns': JSON.stringify({ owner: 'server', id: 'job-1' }),
    });
    await expectHeldBack(page, scrobbles);
    // The server is known to have this queue, not merely possibly.
    await expect(page.locator(CONTINUE_ANYWAY)).toHaveCount(0);
    // Refreshing the worker connection needs the worker, so the unreachable
    // banner is the only one shown.
    await expect(page.locator('text=You need to refresh your connection')).toHaveCount(0);
    await expect(page.locator('button:has-text("Fix now")')).toHaveCount(0);
  });
});

test.describe('Importing a progress file', () => {
  const IMPORT_ID = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';
  const IDLE = { ok: true, live: false };

  function progressFile(count = 5, completed = [0, 1, 2]) {
    const tracks = Array.from({ length: count }, (_, i) => i + 1).map((n) => ({
      track: `Track ${n}`,
      artist: `Artist ${n}`,
      album: `Album ${n}`,
      timestamp: Date.UTC(2024, 0, 1) + n * 60000,
    }));
    const state = {
      userName: 'testuser',
      totalTracks: count,
      completedIndices: completed,
      failedIndices: [],
      tracks,
      originalTotalTracks: count,
      originalSucceededCount: completed.length,
      importId: IMPORT_ID,
      savedAt: new Date().toISOString(),
    };
    return {
      name: 'scrobblify-progress.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(state)),
    };
  }

  test('a file for a handed-over import is refused', async ({ page }) => {
    const { workerCalls } = await openUploadStep(page, {
      '/scrobblify/job/live': IDLE,
      '/scrobblify/import/': {
        ok: true, known: true, live: false, state: 'completed', scrobbledCount: 2, totalTracks: 2,
      },
    });
    await page.locator('.drop-zone input[type="file"]').setInputFiles(progressFile());

    await expect(page.getByText('was handed over to the background service')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=2 tracks ready to scrobble')).toBeHidden();
    expect(workerCalls).toContain(`/scrobblify/import/${IMPORT_ID}`);
  });

  test('a file the worker has never seen resumes', async ({ page }) => {
    const { workerCalls } = await openUploadStep(page, {
      '/scrobblify/job/live': IDLE,
      '/scrobblify/import/': { ok: true, known: false, live: false },
    });
    await page.locator('.drop-zone input[type="file"]').setInputFiles(progressFile());

    await expect(page.locator('text=2 tracks ready to scrobble')).toBeVisible({ timeout: 10000 });
    expect(workerCalls).toContain(`/scrobblify/import/${IMPORT_ID}`);
  });

  test('with the worker unreachable, a browser that never opted in still resumes the file', async ({ page }) => {
    await openUploadStep(page, 'refuse');
    await page.locator('.drop-zone input[type="file"]').setInputFiles(progressFile());

    await expect(page.locator('text=2 tracks ready to scrobble')).toBeVisible({ timeout: 10000 });
  });

  test('with the worker unreachable, an opted-in browser does not resume the file', async ({ page }) => {
    await openUploadStep(page, 'refuse', { 'scrobblify.background.beta': '1' });
    await page.locator('.drop-zone input[type="file"]').setInputFiles(progressFile());

    await expect(page.getByText("Can't reach the background service to check")).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=2 tracks ready to scrobble')).toBeHidden();
  });
});

test.describe('Signing in while the page mounts', () => {
  // Writes saved progress straight into IndexedDB, as `StateManager.saveState` would.
  async function seedSavedState(page: Page, state: Record<string, unknown>) {
    await page.evaluate((saved) => new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('scrobblify', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('scrobbleState')) {
          request.result.createObjectStore('scrobbleState');
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('scrobbleState', 'readwrite');
        tx.objectStore('scrobbleState').put(saved, 'current');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
      request.onerror = () => reject(request.error);
    }), state);
  }

  /*
    A stored session makes the sign-in handler emit before this page's own
    `mounted` has finished, and its authority check used to run alongside the
    mount's. The first answer ("nothing running") lowered `authorityPending`
    while the second question was still out, so Resume was live for the whole
    of a request whose answer was "a job is running". The checks now run one
    after the other, each with Resume held back.
  */
  test('Resume stays held back while the second authority check is out', async ({ page }) => {
    const scrobbles: string[] = [];
    let liveCalls = 0;
    let secondCallArrived = (): void => undefined;
    const secondCall = new Promise<void>((resolve) => { secondCallArrived = resolve; });
    let releaseSecondCall = (): void => undefined;
    const released = new Promise<void>((resolve) => { releaseSecondCall = resolve; });

    await interceptLastFm(page);
    await page.route(WORKER, async (route: Route) => {
      const { pathname } = new URL(route.request().url());
      const reply = (body: unknown) => route.fulfill({
        status: 200, contentType: 'application/json', body: JSON.stringify(body),
      });
      if (pathname === '/scrobblify/job/live') {
        liveCalls += 1;
        if (liveCalls === 1) {
          await reply({ ok: true, live: false });
          return;
        }
        secondCallArrived();
        // Answered well inside the client's fall-through timeout.
        await released;
        await reply({ ok: true, live: true });
        return;
      }
      if (pathname.startsWith('/scrobblify/import/')) {
        await reply({ ok: true, known: false, live: false });
        return;
      }
      await route.abort('internetdisconnected');
    });
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(
        route.request().method() === 'POST'
          ? route.request().postData() || ''
          : new URL(route.request().url()).search,
      );
      if (params.get('method') === 'track.scrobble') {
        scrobbles.push(params.get('track[0]') || '');
      }
      await route.fallback();
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSavedState(page, {
      userName: 'testuser',
      totalTracks: 5,
      completedIndices: [0, 1, 2],
      failedIndices: [],
      tracks: [1, 2, 3, 4, 5].map((n) => ({
        track: `Track ${n}`, artist: `Artist ${n}`, album: `Album ${n}`, timestamp: Date.UTC(2024, 0, n),
      })),
      originalTotalTracks: 5,
      originalSucceededCount: 3,
      importId: 'b1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
      savedAt: new Date().toISOString(),
    });
    await page.reload();

    await secondCall;
    // Long enough for a render that was going to show Resume to have shown it.
    await page.waitForTimeout(500);
    expect(await page.locator('text=Resume previous session?').count()).toBe(0);
    releaseSecondCall();

    await expect(page.locator('text=Your import is still running on the server')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Resume previous session?')).toHaveCount(0);
    expect(scrobbles).toEqual([]);
  });
});
test.describe('Offering background scrobbling', () => {
  // A worker that would say yes to everything, so only the opt-in stands
  // between a large import and the offer.
  const WILLING_WORKER = {
    '/scrobblify/job/live': { ok: true, live: false },
    '/scrobblify/import/': { ok: true, known: false, live: false },
    '/scrobblify/capacity': {
      available: true, used: 0, capacity: 100, minTracks: 750, maxTracks: 200000, chunkTracks: 5000,
    },
  };
  const OFFER = 'text=Finish this in the background >> visible=true';

  function largeProgressFile(reTagged = false) {
    const count = 3000;
    const tracks = Array.from({ length: count }, (_, i) => ({
      track: `Track ${i}`,
      artist: `Artist ${i % 50}`,
      album: `Album ${i % 50}`,
      timestamp: Date.UTC(2024, 0, 1) + i * 60000,
      reTagged,
    }));
    return {
      name: 'scrobblify-progress.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        userName: 'testuser',
        totalTracks: count,
        completedIndices: [],
        failedIndices: [],
        tracks,
        originalTotalTracks: count,
        originalSucceededCount: 0,
        importId: 'b1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
        savedAt: new Date().toISOString(),
      })),
    };
  }

  test('a large import is not offered background scrobbling without the beta flag', async ({ page }) => {
    const { workerCalls } = await openUploadStep(page, WILLING_WORKER);
    await page.locator('.drop-zone input[type="file"]').setInputFiles(largeProgressFile());

    await expect(page.getByRole('button', { name: 'Scrobble', exact: true })).toBeVisible({ timeout: 15000 });
    // The offer opens straight after the restore; give it time to have done so.
    await page.waitForTimeout(2000);
    await expect(page.locator(OFFER)).toHaveCount(0);
    // Not even asked: without the flag the offer path makes no request at all.
    expect(workerCalls).not.toContain('/scrobblify/capacity');
  });

  test('the same import is offered it with the beta flag', async ({ page }) => {
    const { workerCalls } = await openUploadStep(page, WILLING_WORKER, { 'scrobblify.background.beta': '1' });
    await expect.poll(() => workerCalls.includes('/scrobblify/capacity')).toBe(true);
    await page.locator('.drop-zone input[type="file"]').setInputFiles(largeProgressFile());

    await expect(page.locator(OFFER)).toBeVisible({ timeout: 15000 });
  });

  const FLAG_ON = { 'scrobblify.flags': JSON.stringify({ 'scrobblify-background-scrobbling': true }) };

  test('the rollout flag offers it without the opt-in', async ({ page }) => {
    const { workerCalls } = await openUploadStep(page, WILLING_WORKER, FLAG_ON);
    await expect.poll(() => workerCalls.includes('/scrobblify/capacity')).toBe(true);
    await page.locator('.drop-zone input[type="file"]').setInputFiles(largeProgressFile());

    await expect(page.locator(OFFER)).toBeVisible({ timeout: 15000 });
  });

  test('?beta=0 keeps it off even when the rollout flag is on', async ({ page }) => {
    const { workerCalls } = await openUploadStep(page, WILLING_WORKER, FLAG_ON);
    await page.goto('/?beta=0#/scrobble');
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
    workerCalls.length = 0;
    await page.locator('.drop-zone input[type="file"]').setInputFiles(largeProgressFile());

    await expect(page.getByRole('button', { name: 'Scrobble', exact: true })).toBeVisible({ timeout: 15000 });
    await page.waitForTimeout(2000);
    await expect(page.locator(OFFER)).toHaveCount(0);
    expect(workerCalls).not.toContain('/scrobblify/capacity');
  });

  // 1,600 plays from a year ago: after the first day's 700, 900 are left,
  // which is enough for the offer on the stop screen.
  async function openLargeHistoryGate(page: Page) {
    const startMs = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const zip = new JSZip();
    zip.file('Spotify Extended Streaming History/Streaming_History_Audio_2024.json', JSON.stringify(
      Array.from({ length: 1600 }, (_, i) => ({
        ts: new Date(startMs + i * 60000).toISOString(),
        master_metadata_track_name: `Track ${i}`,
        master_metadata_album_artist_name: 'Queen',
        master_metadata_album_album_name: 'An Album',
        ms_played: 300000,
      })),
    ));
    await page.locator('.drop-zone input[type="file"]').setInputFiles({
      name: 'my_spotify_data.zip',
      mimeType: 'application/zip',
      buffer: await zip.generateAsync({ type: 'nodebuffer' }),
    });
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();
    await page.locator('.upload-step button:has-text("Choose which tracks to scrobble")').click({ timeout: 30000 });
    const gate = page.locator('.large-history-gate');
    await expect(gate).toBeVisible();
    return gate;
  }

  test('a large import the server could finish is not told to come back every day', async ({ page }) => {
    const { workerCalls } = await openUploadStep(page, WILLING_WORKER, { 'scrobblify.background.beta': '1' });
    await expect.poll(() => workerCalls.includes('/scrobblify/capacity')).toBe(true);
    const gate = await openLargeHistoryGate(page);

    await expect(gate).toContainText('Finish this in the background');
    await expect(gate).not.toContainText("You'll need to come back each day");
  });

  test('without the beta flag the same import is told it has to come back', async ({ page }) => {
    await openUploadStep(page, WILLING_WORKER);
    const gate = await openLargeHistoryGate(page);

    await expect(gate).toContainText("You'll need to come back each day");
    await expect(gate).not.toContainText('Finish this in the background');
  });

  test('the daily stop points to the background offer, not only "come back"', async ({ page }) => {
    const { workerCalls } = await openUploadStep(page, WILLING_WORKER, { 'scrobblify.background.beta': '1' });
    await expect.poll(() => workerCalls.includes('/scrobblify/capacity')).toBe(true);
    // Today's UTC day already holds 700 plays, so the first re-tagged send stops for the day.
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(new URL(route.request().url()).search);
      if (params.get('method') !== 'user.getrecenttracks') {
        await route.fallback();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ recenttracks: { '@attr': { total: '700' }, track: [] } }),
      });
    });
    await page.locator('.drop-zone input[type="file"]').setInputFiles(largeProgressFile(true));
    await page.locator('button:has-text("Not now") >> visible=true').click({ timeout: 15000 });
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    await expect(page.locator("text=hand the rest to Scrobblify's server below >> visible=true"))
      .toBeVisible({ timeout: 30000 });
  });
});

test.describe('BETA tag', () => {
  const TAG = '#logo .beta-tag';

  test('an opted-in browser sees the BETA tag on every page', async ({ page }) => {
    await page.goto('/?beta=1#/');
    await expect(page.locator(TAG)).toHaveText('BETA');
    await page.goto('/#/about');
    await expect(page.locator(TAG)).toBeVisible();
  });

  test('the rollout flag shows the tag without the opt-in', async ({ page }) => {
    await page.goto('/#/');
    await page.evaluate(() => window.localStorage.setItem(
      'scrobblify.flags',
      JSON.stringify({ 'scrobblify-background-scrobbling': true }),
    ));
    await page.reload();
    await expect(page.locator(TAG)).toBeVisible();
  });

  test('a browser outside the beta sees no tag or banner; opting in shows both', async ({ page }) => {
    await page.goto('/#/');
    await expect(page.locator('#logo')).toBeVisible();
    await expect(page.locator(TAG)).toHaveCount(0);
    await expect(page.locator('#beta-banner')).toHaveCount(0);
    await page.goto('/?beta=1#/scrobble');
    await expect(page.locator('.scrobblify')).toBeVisible({ timeout: 10000 });
    await expect(page.locator(TAG)).toBeVisible();
    await expect(page.locator('#beta-banner')).toBeVisible();
    await expect(page.locator('#beta-banner')).toContainText('niko@savas.ca');
  });

  test('the beta banner shows on Home and About too, and Switch it off opts out', async ({ page }) => {
    await page.goto('/?beta=1#/');
    await expect(page.locator('#beta-banner')).toBeVisible();
    // v-alert is `flex: 1 1` in v-app's full-height column, so it can stretch or collapse.
    const { height } = (await page.locator('#beta-banner').boundingBox())!;
    expect(height).toBeGreaterThan(40);
    expect(height).toBeLessThan(120);
    await page.locator('#nav a:has-text("About")').click();
    await expect(page).toHaveURL(/#\/about$/);
    await expect(page.locator('#beta-banner')).toBeVisible();
    await page.locator('#beta-banner a:has-text("Switch it off")').click();
    await page.waitForURL(/\?beta=0#\/about$/);
    await expect(page.locator('#logo')).toBeVisible();
    await expect(page.locator('#beta-banner')).toHaveCount(0);
    await expect(page.locator(TAG)).toHaveCount(0);
    expect(await page.evaluate(() => window.localStorage.getItem('scrobblify.background.beta')))
      .toBe('0');
  });

  test('?beta=0 removes the tag again', async ({ page }) => {
    await page.goto('/?beta=1#/');
    await expect(page.locator(TAG)).toBeVisible();
    await page.goto('/?beta=0#/');
    await expect(page.locator('#logo')).toBeVisible();
    await expect(page.locator(TAG)).toHaveCount(0);
  });
});

test.describe('Home with a job on the server', () => {
  const IMPORT_ID = 'c1c2c3c4c5c6c7c8c9c0d1d2d3d4d5d6';
  const RECORD_KEY = 'scrobblify.background.handedOverImport';

  async function openHome(
    page: Page,
    recordUser: string,
    answer: Record<string, unknown> | 'refuse',
    originalTotal?: number,
  ) {
    const paths: string[] = [];
    await page.route(WORKER, async (route: Route) => {
      const { pathname } = new URL(route.request().url());
      paths.push(pathname);
      if (answer !== 'refuse' && pathname === `/scrobblify/import/${IMPORT_ID}`) {
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer) });
        return;
      }
      await route.abort('internetdisconnected');
    });
    await page.goto('/#/');
    const record = originalTotal === undefined
      ? { importId: IMPORT_ID, username: recordUser }
      : { importId: IMPORT_ID, username: recordUser, originalTotal };
    await page.evaluate(([key, value]) => {
      localStorage.setItem('scrobblifyLfmUserName', 'testuser');
      localStorage.setItem(key, value);
    }, [RECORD_KEY, JSON.stringify(record)]);
    await page.reload();
    return paths;
  }

  const LIVE = {
    ok: true, known: true, live: true, state: 'active', cursor: 1200, scrobbledCount: 1200, totalTracks: 4000,
  };

  test('shows the job\'s progress from the handed-over import id', async ({ page }) => {
    await openHome(page, 'testuser', LIVE);
    const card = page.locator('.returning-card');
    await expect(card.locator('.returning-bar')).toContainText('1,200 / 4,000 · 30%');
    await expect(card).toContainText("Scrobbling remotely, it's safe to close this tab.");
    await expect(card.locator('button')).toHaveCount(0);
  });

  test('counts the whole import, not just the server\'s share, when its size was recorded', async ({ page }) => {
    // 1,000 were scrobbled in the browser before 4,000 were handed over.
    await openHome(page, 'testuser', LIVE, 5000);
    await expect(page.locator('.returning-card .returning-bar')).toContainText('2,200 / 5,000 · 44%');
  });

  test('another user\'s handed-over import is not shown', async ({ page }) => {
    const paths = await openHome(page, 'someoneelse', LIVE);
    await expect(page.locator('.returning-card button:has-text("Upload Spotify zip")')).toBeVisible();
    await expect(page.getByText("Scrobbling remotely, it's safe to close this tab.")).toHaveCount(0);
    expect(paths.filter((p) => p.startsWith('/scrobblify/import/'))).toEqual([]);
  });

  test('a live job shows the BETA tag to a browser outside the beta', async ({ page }) => {
    await openHome(page, 'testuser', LIVE);
    await expect(page.locator('.returning-card')).toContainText("Scrobbling remotely, it's safe to close this tab.");
    expect(await page.evaluate(() => localStorage.getItem('scrobblify.background.beta'))).toBeNull();
    await expect(page.locator('#logo .beta-tag')).toHaveText('BETA');
    await page.locator('#nav a:has-text("About")').click();
    await expect(page.locator('#logo .beta-tag')).toHaveCount(0);
  });

  test('a finished job falls back to the plain welcome-back card and forgets the id', async ({ page }) => {
    await openHome(page, 'testuser', {
      ok: true, known: true, live: false, state: 'completed', cursor: 4000, scrobbledCount: 4000, totalTracks: 4000,
    });
    await expect(page.locator('.returning-card button:has-text("Upload Spotify zip")')).toBeVisible();
    await expect(page.locator('#logo .beta-tag')).toHaveCount(0);
    expect(await page.evaluate((key) => localStorage.getItem(key), RECORD_KEY)).toBeNull();
  });

  test('an unreachable worker shows the plain card but keeps the id for next time', async ({ page }) => {
    await openHome(page, 'testuser', 'refuse');
    await expect(page.locator('.returning-card button:has-text("Upload Spotify zip")')).toBeVisible();
    expect(await page.evaluate((key) => localStorage.getItem(key), RECORD_KEY)).not.toBeNull();
  });
});
