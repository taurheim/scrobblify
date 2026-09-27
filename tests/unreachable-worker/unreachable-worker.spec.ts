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

type WorkerBehaviour = 'refuse' | 'hang';

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
    }
    // 'hang': never answered, so the client's own timeout is what ends it.
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
  await page.locator('input[type="file"][accept=".zip"]').setInputFiles(FIXTURE_ZIP);
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
