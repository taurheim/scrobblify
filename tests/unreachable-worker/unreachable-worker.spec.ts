import {
  test, expect, Page, Route,
} from '@playwright/test';
import path from 'path';
import { interceptLastFm, mockLastFmAuth } from '../lastfmMock';

/*
  Runs only under `playwright.unreachable-worker.config.ts`, which compiles in
  a worker URL that cannot resolve.

  The rule under test: an unanswered authority check blocks scrobbling only for
  a browser that has opted in to the beta or holds some local trace of a
  handover. Everyone else waits briefly and then scrobbles as normal.
*/

const FIXTURE_ZIP = path.resolve(__dirname, '..', 'fixtures', 'test-spotify-data.zip');
const WORKER = 'http://background.invalid/**';
const UNREACHABLE = "text=Can't reach the background service";
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

  await expect(page.locator('button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
  await page.locator('button:has-text("Choose which tracks to scrobble")').click();
  await expect(page.locator('button:has-text("matching")')).toBeVisible({ timeout: 5000 });
  await page.locator('button:has-text("matching")').click();
  await page.locator('button:has-text("selected tracks")').click();

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

  test('an opted-in browser is held back', async ({ page }) => {
    const { scrobbles } = await openUploadStep(page, 'refuse', {
      'scrobblify.background.beta': '1',
    });
    await expectHeldBack(page, scrobbles);
  });

  test('a browser holding a handover record is held back even without the opt-in', async ({ page }) => {
    const { scrobbles } = await openUploadStep(page, 'refuse', {
      'scrobblify.background.serverOwns': JSON.stringify({ owner: 'server', id: 'job-1' }),
    });
    await expectHeldBack(page, scrobbles);
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
test.describe('Offering background scrobbling', () => {
  // A worker that would say yes to everything, so only the opt-in stands
  // between a large import and the offer.
  const WILLING_WORKER = {
    '/scrobblify/job/live': { ok: true, live: false },
    '/scrobblify/import/': { ok: true, known: false, live: false },
    '/scrobblify/capacity': {
      available: true, used: 0, capacity: 100, minTracks: 2700, maxTracks: 200000, chunkTracks: 5000,
    },
  };
  const OFFER = 'text=Finish this in the background >> visible=true';

  function largeProgressFile() {
    const count = 3000;
    const tracks = Array.from({ length: count }, (_, i) => ({
      track: `Track ${i}`,
      artist: `Artist ${i % 50}`,
      album: `Album ${i % 50}`,
      timestamp: Date.UTC(2024, 0, 1) + i * 60000,
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
});
