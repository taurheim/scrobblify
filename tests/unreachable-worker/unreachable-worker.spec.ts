import {
  test, expect, Page, Route,
} from '@playwright/test';
import path from 'path';
import JSZip from 'jszip';
import {
  interceptLastFm, mockLastFmAuth, routeLastFmSignIn, MOCK_SESSION_KEY,
} from '../lastfmMock';
import {
  interceptBackgroundWorker, MockWorker, MAX_TRACKS,
} from '../backgroundMock';
import { DAY_FULL_REASON } from '../../src/shared/lastfm/dailyCap';

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

type Tracked = { name: string; props: Record<string, unknown> };

// What `trackEvent` would have sent, read from its dev-build console echo.
function captureEvents(page: Page): Tracked[] {
  const events: Tracked[] = [];
  page.on('console', (msg) => {
    const match = msg.text().match(/^\[scrobblify:event\] (\S+) ([\s\S]*)$/);
    if (!match) return;
    try {
      events.push({ name: match[1], props: JSON.parse(match[2]) });
    } catch {
      // Not ours.
    }
  });
  return events;
}

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

/*
  #157: a handoff return is accepted only for the handoff this browser
  preflighted. Anyone can preflight a handoff and send its Last.fm link to
  someone else; the return then lands in the victim's browser.

  In dev the router runs in hash mode, so a real return's `#session=…`
  fragment would be taken for the route and never reach the Scrobble page.
  The URL is rewritten in place instead, and the handler the page runs on
  mount is called directly.
*/
async function returnWith(page: Page, fragment: string) {
  return page.evaluate(async (hash) => {
    window.history.replaceState(null, '', `${window.location.pathname}?handoff=ok&job=j-1#${hash}`);
    let inst = (document.querySelector('.upload-step') as any).__vueParentComponent;
    while (inst && !(inst.proxy && typeof inst.proxy.resumeHandoffIfReturning === 'function')) {
      inst = inst.parent;
    }
    await inst.proxy.resumeHandoffIfReturning();
    return {
      href: window.location.href,
      session: localStorage.getItem('scrobblify.background.session'),
      pending: localStorage.getItem('scrobblify.background.handoff'),
      preflighted: localStorage.getItem('scrobblify.background.preflighted'),
    };
  }, fragment);
}

test.describe('Returning from a handoff', () => {
  test('a return for a handoff this browser did not start is ignored', async ({ page }) => {
    await openUploadStep(page, 'refuse', {
      'scrobblify.background.preflighted': 'h-mine',
    });
    const after = await returnWith(page, 'session=s-theirs&handoff=h-theirs&user=someone');
    expect(after.href).not.toContain('session=');
    expect(after.session).toBeNull();
    expect(after.pending).toBeNull();
    // Still waiting for its own return.
    expect(after.preflighted).toBe('h-mine');
  });

  test('a return with no handoff preflighted here is ignored', async ({ page }) => {
    await openUploadStep(page, 'refuse');
    const after = await returnWith(page, 'session=s-theirs&handoff=h-theirs');
    expect(after.href).not.toContain('session=');
    expect(after.session).toBeNull();
    expect(after.pending).toBeNull();
  });

  test('the return for this browser\'s own handoff is accepted, once', async ({ page }) => {
    await openUploadStep(page, 'refuse', {
      'scrobblify.background.preflighted': 'h-mine',
    });
    const after = await returnWith(page, 'session=s-mine&handoff=h-mine&user=testuser');
    expect(after.href).not.toContain('session=');
    expect(after.session).toBe('s-mine');
    expect(after.pending).toBe('h-mine');
    expect(after.preflighted).toBeNull();

    // The same return again, say from history, is no longer this browser's.
    const replayed = await returnWith(page, 'session=s-replayed&handoff=h-mine');
    expect(replayed.session).toBe('s-mine');
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

test.describe('Signing in after choosing', () => {
  async function readSavedState(page: Page): Promise<Record<string, any> | null> {
    return page.evaluate(() => new Promise<Record<string, any> | null>((resolve, reject) => {
      const request = indexedDB.open('scrobblify', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('scrobbleState')) {
          request.result.createObjectStore('scrobbleState');
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const req = db.transaction('scrobbleState', 'readonly').objectStore('scrobbleState').get('current');
        req.onsuccess = () => { db.close(); resolve(req.result || null); };
        req.onerror = () => { db.close(); reject(req.error); };
      };
      request.onerror = () => reject(request.error);
    }));
  }

  /*
    Spec 4.5: someone whose import is running on the server uploads it again
    on a browser that has never seen them. Nothing in it says "handed over",
    and the username only arrives with the sign-in that now comes after
    choosing, so the server's answer to that sign-in is all that stops a
    second copy of the queue going out.
  */
  test('a fresh browser that chooses and signs in while a job is live sends nothing', async ({ page }) => {
    const scrobbles: string[] = [];
    const workerCalls: string[] = [];
    const worker: Record<string, unknown> = {
      '/scrobblify/job/live': { ok: true, live: true },
      '/scrobblify/import/': { ok: true, known: false, live: false },
      '/scrobblify/capacity': {
        available: true, used: 0, capacity: 100, minTracks: 750, maxTracks: 200000, chunkTracks: 5000,
      },
    };
    await interceptLastFm(page);
    await routeLastFmSignIn(page);
    await page.route(WORKER, async (route: Route) => {
      const { pathname } = new URL(route.request().url());
      workerCalls.push(pathname);
      const match = Object.keys(worker).find((prefix) => pathname.startsWith(prefix));
      if (!match) {
        await route.abort('internetdisconnected');
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(worker[match]) });
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
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
    await page.locator('.drop-zone input[type="file"]').setInputFiles(FIXTURE_ZIP);
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();
    await page.locator('.upload-step button:has-text("Choose which tracks to scrobble")').click({ timeout: 30000 });
    await page.locator('button:has-text("matching")').click({ timeout: 5000 });
    await page.locator('button:has-text("selected tracks")').click();
    await page.locator('.scrobble-confirm button:has-text("Start scrobbling")').click();

    await expect(page.locator('text=Currently authenticated as: testuser')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Your import is still running on the server')).toBeVisible({ timeout: 10000 });
    // Long enough for a send that was going to happen to have happened.
    await page.waitForTimeout(3000);
    expect(scrobbles).toEqual([]);
    expect(workerCalls).toContain('/scrobblify/job/live');
    await expect(page.locator('text=Resume previous session?')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Scrobble', exact: true })).toBeHidden();
    // Kept, untouched, for when the server lets go of the import.
    const saved = await readSavedState(page);
    expect(saved).not.toBeNull();
    expect(saved!.completedIndices).toEqual([]);
    expect(saved!.totalTracks).toBeGreaterThan(0);
    expect(saved!.totalTracks).toBe(saved!.originalTotalTracks);
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
  const OFFER = 'text=Let Scrobblify scrobble for me (beta) >> visible=true';

  function largeProgressFile(reTagged: boolean | ((i: number) => boolean) = false, count = 3000) {
    const tracks = Array.from({ length: count }, (_, i) => ({
      track: `Track ${i}`,
      artist: `Artist ${i % 50}`,
      album: `Album ${i % 50}`,
      timestamp: Date.UTC(2024, 0, 1) + i * 60000,
      reTagged: typeof reTagged === 'function' ? reTagged(i) : reTagged,
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

    await expect(gate).toContainText('Scrobble the rest for me');
    await expect(gate).not.toContainText("You'll need to come back each day");
  });

  test('without the beta flag the same import is told it has to come back', async ({ page }) => {
    await openUploadStep(page, WILLING_WORKER);
    const gate = await openLargeHistoryGate(page);

    await expect(gate).toContainText("You'll need to come back each day");
    await expect(gate).not.toContainText('Scrobble the rest for me');
  });

  // Today's UTC day already holds 700 plays, so the first re-tagged send stops for the day.
  async function stopForTheDay(page: Page, declineResumeOffer = true, count = 3000) {
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
    await page.locator('.drop-zone input[type="file"]').setInputFiles(largeProgressFile(true, count));
    if (declineResumeOffer) {
      await page.locator('a:has-text("scrobble locally") >> visible=true').click({ timeout: 15000 });
    }
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click({ timeout: 15000 });
    await expect(page.locator('text=Your progress has been saved automatically >> visible=true')
      .or(page.locator('text=Stopped. You can resume at any time >> visible=true')))
      .toBeVisible({ timeout: 30000 });
  }

  test('the daily stop points to the background offer, not only "come back"', async ({ page }) => {
    const { workerCalls } = await openUploadStep(page, WILLING_WORKER, { 'scrobblify.background.beta': '1' });
    await expect.poll(() => workerCalls.includes('/scrobblify/capacity')).toBe(true);
    await stopForTheDay(page);

    await expect(page.locator("text=hand the rest to Scrobblify's server below >> visible=true"))
      .toBeVisible();
  });

  test('the stop screen offers "Scrobble the rest for me", which opens the choice', async ({ page }) => {
    const { workerCalls } = await openUploadStep(page, WILLING_WORKER, { 'scrobblify.background.beta': '1' });
    await expect.poll(() => workerCalls.includes('/scrobblify/capacity')).toBe(true);
    await stopForTheDay(page);

    await expect(page.locator('text=Stopped. You can resume at any time, or >> visible=true')).toBeVisible();
    await expect(page.locator('a:has-text("have scrobblify scrobble the rest for you") >> visible=true'))
      .toBeVisible();
    await expect(page.locator("text=Don't want to keep coming back?")).toHaveCount(0);
    await page.locator('button:has-text("Scrobble the rest for me") >> visible=true').click();

    const dialog = page.locator('.background-offer');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.v-card-title')).toHaveText('Scrobble 3,000 tracks?');
    await expect(dialog).toContainText('This will take 5 days to scrobble.');
    await expect(dialog).toContainText('will not have the correct date');
    await expect(dialog.locator('button:has-text("Let Scrobblify scrobble for me (beta)")')).toBeVisible();
    await expect(dialog.locator('.choice-over60')).toHaveCount(0);
  });

  test('"Details" expands what the service keeps and how to stop it', async ({ page }) => {
    const { workerCalls } = await openUploadStep(page, WILLING_WORKER, { 'scrobblify.background.beta': '1' });
    await expect.poll(() => workerCalls.includes('/scrobblify/capacity')).toBe(true);
    await stopForTheDay(page);
    await page.locator('a:has-text("have scrobblify scrobble the rest for you") >> visible=true').click();

    const dialog = page.locator('.background-offer');
    await expect(dialog.locator('.choice-details')).toHaveCount(0);
    await dialog.locator('a:has-text("Details")').click();
    const details = dialog.locator('.choice-details p');
    await expect(details).toHaveCount(3);
    await expect(details.nth(0)).toContainText('Only your username and tracks listened to are uploaded');
    await expect(details.nth(1)).toContainText('revoking access');
    await expect(details.nth(2)).toContainText('niko@savas.ca');

    // A role="button" link works from the keyboard like a button: Space too.
    const toggle = dialog.locator('a:has-text("Details")');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await toggle.focus();
    await page.keyboard.press('Space');
    await expect(dialog.locator('.choice-details')).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('"scrobble locally" closes the choice and records the decline', async ({ page }) => {
    const events = captureEvents(page);
    const { workerCalls } = await openUploadStep(page, WILLING_WORKER, { 'scrobblify.background.beta': '1' });
    await expect.poll(() => workerCalls.includes('/scrobblify/capacity')).toBe(true);
    await stopForTheDay(page);
    await page.locator('button:has-text("Scrobble the rest for me") >> visible=true').click();
    const dialog = page.locator('.background-offer');
    await expect(dialog).toBeVisible();

    await dialog.locator('a:has-text("scrobble locally")').click();

    await expect(dialog).toBeHidden();
    await expect.poll(() => events.filter((e) => e.name === 'background_offer_declined')
      .map((e) => e.props.entry_point)).toEqual(['resume', 'scrobble_step']);
    const declined = events.filter((e) => e.name === 'background_offer_declined')[1];
    expect(declined.props).toMatchObject({ track_count: 3000, all_re_tagged: true });
  });

  test('a resume of more than 60 days warns about signing in again', async ({ page }) => {
    const { workerCalls } = await openUploadStep(page, WILLING_WORKER, { 'scrobblify.background.beta': '1' });
    await expect.poll(() => workerCalls.includes('/scrobblify/capacity')).toBe(true);
    await page.locator('.drop-zone input[type="file"]').setInputFiles(largeProgressFile(false, 42001));

    const dialog = page.locator('.background-offer');
    await expect(dialog).toBeVisible({ timeout: 30000 });
    await expect(dialog.locator('.v-card-title')).toHaveText('Scrobble 42,001 tracks?');
    await expect(dialog).toContainText('This will take 61 days to scrobble.');
    await expect(dialog.locator('.choice-over60')).toContainText('more than 60 days of scrobbling');
  });

  test('a resume of under 60 days has no such warning', async ({ page }) => {
    const { workerCalls } = await openUploadStep(page, WILLING_WORKER, { 'scrobblify.background.beta': '1' });
    await expect.poll(() => workerCalls.includes('/scrobblify/capacity')).toBe(true);
    await page.locator('.drop-zone input[type="file"]').setInputFiles(largeProgressFile(false, 41000));

    const dialog = page.locator('.background-offer');
    await expect(dialog).toBeVisible({ timeout: 30000 });
    await expect(dialog.locator('.v-card-title')).toHaveText('Scrobble 41,000 tracks?');
    await expect(dialog).toContainText('This will take 59 days to scrobble.');
    await expect(dialog.locator('.choice-over60')).toHaveCount(0);
  });

  // The date note is for *some* re-dated plays, not only an all-re-dated queue.
  test('a resume where only some plays are re-dated says their dates will change', async ({ page }) => {
    const { workerCalls } = await openUploadStep(page, WILLING_WORKER, { 'scrobblify.background.beta': '1' });
    await expect.poll(() => workerCalls.includes('/scrobblify/capacity')).toBe(true);
    await page.locator('.drop-zone input[type="file"]').setInputFiles(largeProgressFile((i) => i % 2 === 0));

    const dialog = page.locator('.background-offer');
    await expect(dialog).toBeVisible({ timeout: 30000 });
    await expect(dialog.locator('.choice-dates')).toContainText('will not have the correct date');
  });

  test('a resume with no re-dated plays has no date note', async ({ page }) => {
    const { workerCalls } = await openUploadStep(page, WILLING_WORKER, { 'scrobblify.background.beta': '1' });
    await expect.poll(() => workerCalls.includes('/scrobblify/capacity')).toBe(true);
    await page.locator('.drop-zone input[type="file"]').setInputFiles(largeProgressFile(false));

    const dialog = page.locator('.background-offer');
    await expect(dialog).toBeVisible({ timeout: 30000 });
    await expect(dialog.locator('.choice-dates')).toHaveCount(0);
  });

  // The worker refuses a queue over its limit as `too_large`, after the
  // Last.fm sign-in, so neither the resume nor the stop screen may offer it.
  test('a queue over the server\'s job limit is not offered', async ({ page }) => {
    const events = captureEvents(page);
    const { workerCalls } = await openUploadStep(page, {
      ...WILLING_WORKER,
      '/scrobblify/capacity': {
        available: true, used: 0, capacity: 100, minTracks: 750, maxTracks: MAX_TRACKS, chunkTracks: 5000,
      },
    }, { 'scrobblify.background.beta': '1' });
    await expect.poll(() => workerCalls.includes('/scrobblify/capacity')).toBe(true);
    await stopForTheDay(page, false, MAX_TRACKS + 1000);

    await expect(page.locator('text=Your progress has been saved automatically >> visible=true')).toBeVisible();
    await expect(page.locator('.background-offer')).toHaveCount(0);
    await expect(page.locator('text=Scrobble the rest for me >> visible=true')).toHaveCount(0);
    await expect(page.locator('text=have scrobblify scrobble the rest for you >> visible=true')).toHaveCount(0);
    await expect(page.locator("text=hand the rest to Scrobblify's server below >> visible=true")).toHaveCount(0);
    expect(events.filter((e) => e.name === 'background_offer_shown')).toEqual([]);
  });

  // #149: the server refuses a second handover while a job is listed, even a
  // finished one, so the stop screen must not offer one.
  test('the stop screen offers nothing while a job is listed', async ({ page }) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const { '/scrobblify/job/live': live, ...rest } = WILLING_WORKER;
    const { workerCalls } = await openUploadStep(page, {
      // Before '/scrobblify/job', which would otherwise answer it by prefix.
      '/scrobblify/job/live': live,
      '/scrobblify/job': {
        job: {
          id: 'job-done',
          state: 'completed',
          reason: null,
          totalTracks: 2000,
          scrobbled: 2000,
          failed: 0,
          remaining: 0,
          waitingUntil: null,
          nextRunAt: null,
          estimatedCompletionSec: nowSec - 3600,
          createdAt: nowSec - 5 * 86400,
          completedAt: nowSec - 3600,
          credentialExpiresAt: nowSec + 14 * 86400,
        },
      },
      ...rest,
    }, {
      'scrobblify.background.beta': '1',
      'scrobblify.background.session': 's-1',
      // Dismissed, so /scrobble doesn't send it to Home's status page.
      'scrobblify.background.dismissedJob': 'job-done',
    });
    await expect.poll(() => workerCalls.includes('/scrobblify/capacity')).toBe(true);
    await expect.poll(() => workerCalls.includes('/scrobblify/job')).toBe(true);
    await stopForTheDay(page, false);

    await expect(page.locator('text=Your progress has been saved automatically >> visible=true')).toBeVisible();
    await expect(page.locator('text=Scrobble the rest for me >> visible=true')).toHaveCount(0);
    await expect(page.locator('text=have scrobblify scrobble the rest for you >> visible=true')).toHaveCount(0);
    await expect(page.locator("text=hand the rest to Scrobblify's server below >> visible=true")).toHaveCount(0);
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

  test('shows the job\'s progress from the handed-over import id, with a way to sign in', async ({ page }) => {
    await openHome(page, 'testuser', LIVE);
    const card = page.locator('.status-card');
    await expect(card.locator('.v-card-title')).toHaveText('Scrobbling to testuser');
    await expect(card.locator('.status-bar')).toContainText('1,200 / 4,000 · 30%');
    // 2,800 left at 700 a day: 4 days from now.
    const date = await page.evaluate(() => new Date(Date.now() + 4 * 86400 * 1000)
      .toLocaleDateString([], { month: 'long', day: 'numeric' }));
    await expect(card.locator('.status-line')).toHaveText(`Scrobblify is scrobbling for you, expecting to finish around ${date}`);
    await expect(card.locator('.status-sub')).toHaveText('Sign in to manage it');
    await expect(card.locator('button')).toHaveText(['Sign in']);
  });

  test('counts the whole import, not just the server\'s share, when its size was recorded', async ({ page }) => {
    // 1,000 were scrobbled in the browser before 4,000 were handed over.
    await openHome(page, 'testuser', LIVE, 5000);
    await expect(page.locator('.status-card .status-bar')).toContainText('2,200 / 5,000 · 44%');
  });

  test('another user\'s handed-over import is not shown', async ({ page }) => {
    const paths = await openHome(page, 'someoneelse', LIVE);
    await expect(page.locator('.returning-card button:has-text("Upload Spotify zip")')).toBeVisible();
    await expect(page.locator('.status-card')).toHaveCount(0);
    expect(paths.filter((p) => p.startsWith('/scrobblify/import/'))).toEqual([]);
  });

  test('a live job shows the BETA tag to a browser outside the beta', async ({ page }) => {
    await openHome(page, 'testuser', LIVE);
    await expect(page.locator('.status-card')).toBeVisible();
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

test.describe('Home as the status page', () => {
  const IMPORT_ID = 'f1f2f3f4f5f6f7f8f9f0a1a2a3a4a5a6';
  const RECORD_KEY = 'scrobblify.background.handedOverImport';
  const DISMISSED_KEY = 'scrobblify.background.dismissedJob';
  const SESSION_KEY = 'scrobblify.background.session';
  const SAFE = "Scrobbling remotely, it's safe to close this tab.";
  const CARD = '.status-card';
  const MOVE_BACK = 'Scrobble the rest locally';
  const DAY_SEC = 86400;

  type StatusOptions = {
    job?: Record<string, unknown>;
    /** A worker session in this browser. */
    session?: boolean;
    record?: Record<string, unknown> | null;
    username?: string | null;
    worker?: Record<string, unknown>;
    /** Fakes the page's clock, so a test can move time on. */
    clock?: boolean;
    seed?: Record<string, string>;
    /** Routes that override the mock's answers, installed before Home loads. */
    routes?: (page: Page, mock: MockWorker) => Promise<void>;
  };

  /*
    Home with the mock worker holding one job for testuser (8,000 tracks,
    2,000 sent). Its ticks are an hour apart, so nothing moves by itself.
  */
  async function openStatus(page: Page, baseURL: string | undefined, {
    job = {}, session = true, record = null, username = 'testuser', worker = {}, clock = false, seed = {}, routes,
  }: StatusOptions = {}): Promise<MockWorker> {
    if (clock) {
      await page.clock.install();
    }
    await interceptLastFm(page);
    const mock = await interceptBackgroundWorker(page, {
      apiOrigin: 'http://background.invalid',
      appOrigin: new URL(baseURL || 'http://localhost:8471').origin,
      log: false,
      tickSeconds: 3600,
      ...worker,
    });
    const nowMs = Date.now();
    mock.world.job = {
      id: 'j-status',
      username: 'testuser',
      importId: IMPORT_ID,
      state: 'active',
      reason: null,
      totalTracks: 8000,
      scrobbled: 2000,
      failed: 0,
      waitingUntil: null,
      createdAtMs: nowMs,
      lastTickMs: nowMs,
      completedAtMs: null,
      inactivityDeadlineSec: null,
      dormantFrom: null,
      exportClaim: '',
      ...job,
    };
    mock.world.imports.set(IMPORT_ID, { trackCount: mock.world.job.totalTracks, jobId: 'j-status' });
    if (routes) {
      await routes(page, mock);
    }
    const entries: Record<string, string> = { ...seed };
    if (session) {
      entries[SESSION_KEY] = 's-status';
    }
    if (username) {
      entries.scrobblifyLfmUserName = username;
    }
    if (record) {
      entries[RECORD_KEY] = JSON.stringify(record);
    }
    await page.goto('/#/');
    await page.evaluate((values) => {
      Object.entries(values).forEach(([key, value]) => localStorage.setItem(key, value));
    }, entries);
    await page.reload();
    return mock;
  }

  /** The job as the worker describes it right now. */
  function jobView(mock: MockWorker): Record<string, number> {
    return JSON.parse(mock.handle('GET', '/scrobblify/job', new URLSearchParams(), '').body).job;
  }

  function longDate(page: Page, sec: number): Promise<string> {
    return page.evaluate((s) => new Date(s * 1000)
      .toLocaleDateString([], { month: 'long', day: 'numeric' }), sec);
  }

  type Row = {
    name: string;
    job: Record<string, unknown>;
    /** The status line, given the job the worker describes. */
    line: (page: Page, job: Record<string, number>) => Promise<string | RegExp>;
    sub?: string;
    actions: string[];
    /** Links in the status line, by text. */
    links?: Record<string, string>;
  };

  const deadline = () => Math.floor(Date.now() / 1000) + 30 * DAY_SEC;
  const dormantLine = async (page: Page, job: Record<string, number>) => `You paused your scrobbling. We'll delete your progress from our servers after ${await longDate(page, job.inactivityDeadline)} (any tracks you've scrobbled will stay on last.fm)`;

  const ROWS: Row[] = [
    {
      name: 'active',
      job: {},
      line: async (page, job) => `This will finish around ${await longDate(page, job.estimatedCompletionSec)}`,
      sub: SAFE,
      actions: ['Pause', MOVE_BACK, 'Cancel'],
    },
    {
      name: 'active with today\'s share sent',
      job: { reason: DAY_FULL_REASON },
      line: async () => /^Can't upload any more due to last\.fm rules\. Will continue at \d{1,2}:\d{2}\s[AP]M( tomorrow| on \w+day)?$/,
      sub: SAFE,
      actions: ['Pause', MOVE_BACK, 'Cancel'],
      links: { 'last.fm': 'https://www.last.fm' },
    },
    {
      name: 'paused',
      job: { state: 'paused' },
      line: async () => 'Paused',
      actions: ['Resume', MOVE_BACK, 'Cancel'],
    },
    {
      name: 'signed out by Last.fm',
      job: { state: 'needs_reauth' },
      line: async () => 'Last.fm signed us out',
      actions: ['Sign in again', MOVE_BACK, 'Cancel'],
    },
    {
      name: 'stopped by errors',
      job: { state: 'needs_attention', reason: 'Last.fm failed 10 times in a row.' },
      line: async () => 'Scrobblify stopped after repeated errors.',
      actions: ['Try again', MOVE_BACK, 'Cancel'],
    },
    {
      name: 'on hold after a pause',
      job: { state: 'dormant', dormantFrom: 'paused', inactivityDeadlineSec: deadline() },
      line: dormantLine,
      actions: ['Reconnect', MOVE_BACK, 'Cancel'],
    },
    {
      name: 'on hold, reason unknown',
      job: { state: 'dormant', dormantFrom: null, inactivityDeadlineSec: deadline() },
      line: dormantLine,
      actions: ['Reconnect', MOVE_BACK, 'Cancel'],
    },
    {
      name: 'on hold after being signed out',
      job: { state: 'dormant', dormantFrom: 'needs_reauth', inactivityDeadlineSec: deadline() },
      line: async (page, job) => `Your sign-in to scrobblify expired. If you don't sign in before ${await longDate(page, job.inactivityDeadline)} we'll delete your progress from our servers (any tracks already scrobbled will stay on last.fm).`,
      actions: ['Reconnect', MOVE_BACK, 'Cancel'],
    },
    {
      name: 'on hold after errors',
      job: { state: 'dormant', dormantFrom: 'needs_attention', inactivityDeadlineSec: deadline() },
      line: async () => 'Scrobblify stopped after repeated errors. Please let me know at niko@savas.ca',
      actions: ['Reconnect', MOVE_BACK, 'Cancel'],
      links: { 'niko@savas.ca': 'mailto:niko@savas.ca' },
    },
    {
      name: 'handing progress back',
      job: { state: 'exporting' },
      line: async () => 'Downloading progress from scrobblify servers...',
      actions: [],
    },
    {
      name: 'completed with rejections',
      job: {
        state: 'completed', scrobbled: 7997, failed: 3, completedAtMs: Date.now(),
      },
      line: async () => 'Done · 3 rejected by Last.fm (if this is unexpected please email niko@savas.ca)',
      actions: ['Check it out!', 'Start a new import'],
      links: { 'Last.fm': 'https://www.last.fm' },
    },
    {
      name: 'failed',
      job: { state: 'failed', reason: 'The upload was damaged.', completedAtMs: Date.now() },
      line: async () => 'Scrobbling stopped.',
      actions: ['Start a new import'],
    },
  ];

  for (const row of ROWS) {
    test(`a job ${row.name} shows its line and buttons`, async ({ page, baseURL }) => {
      const mock = await openStatus(page, baseURL, { job: row.job });
      const card = page.locator(CARD);
      await expect(card.locator('.v-card-title')).toHaveText('Scrobbling to testuser', { timeout: 15000 });
      await expect(card.locator('.status-line')).toHaveText(await row.line(page, jobView(mock)));
      if (row.sub) {
        await expect(card.locator('.status-sub')).toHaveText(row.sub);
      } else {
        await expect(card.locator('.status-sub')).toHaveCount(0);
      }
      await expect(card.locator('.status-action')).toHaveText(row.actions);
      for (const action of row.actions) {
        await expect(card.locator(`.status-action:has-text("${action}")`)).toBeEnabled();
      }
      const links = Object.entries(row.links || {});
      await expect(card.locator('.status-line a')).toHaveText(links.map(([text]) => text));
      for (const [text, href] of links) {
        const link = card.locator(`.status-line a:text-is("${text}")`);
        await expect(link).toHaveAttribute('href', href);
        await expect(link).toHaveAttribute('target', '_blank');
        await expect(link).toHaveAttribute('rel', 'noopener');
      }
    });
  }

  test('a job Last.fm signed out, with no room to sign it back in, can\'t "Sign in again"', async ({ page, baseURL }) => {
    await openStatus(page, baseURL, {
      job: { state: 'needs_reauth' },
      routes: async (p, mock) => {
        // The mock (like the worker) always has room to re-attach a signed-out job.
        await p.route('http://background.invalid/scrobblify/job', async (route: Route) => {
          if (route.request().method() !== 'GET') {
            await route.fallback();
            return;
          }
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ ok: true, job: { ...jobView(mock), reconnectAvailable: false } }),
          });
        });
      },
    });
    const card = page.locator(CARD);
    await expect(card.locator('.status-line')).toHaveText('Last.fm signed us out', { timeout: 15000 });
    await expect(card.locator('.status-action')).toHaveText(['Sign in again', MOVE_BACK, 'Cancel']);
    await expect(card.locator('.status-action:has-text("Sign in again")')).toBeDisabled();
    await expect(card.locator(`.status-action:has-text("${MOVE_BACK}")`)).toBeEnabled();
  });

  test('a worker session whose job lookup stalls settles quickly, without asking who else is scrobbling', async ({ page, baseURL }) => {
    const livePaths: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/scrobblify/job/live') {
        livePaths.push(request.url());
      }
    });
    await openStatus(page, baseURL, {
      routes: async (p) => {
        // Never answers: the route is left unhandled.
        await p.route('http://background.invalid/scrobblify/job', () => undefined);
      },
    });
    // The page's own 3-second timeout, plus a little. Not the welcome-back
    // card: its buttons open /scrobble, which may find the job and come back.
    const checking = page.locator('.status-checking');
    await expect(checking).toContainText('Checking for active scrobbling...', { timeout: 4500 });
    await expect(page.locator('.returning-card')).toHaveCount(0);
    await expect(page.locator(CARD)).toHaveCount(0);
    expect(livePaths).toEqual([]);

    // It asks again by itself, for longer; once the worker answers, a retry finds the job.
    const retry = checking.locator('button:has-text("Try again")');
    await expect(retry).toBeEnabled({ timeout: 12000 });
    await page.unroute('http://background.invalid/scrobblify/job');
    await retry.click();
    await expect(page.locator(`${CARD} .status-sub`)).toHaveText(SAFE, { timeout: 10000 });
    expect(livePaths).toEqual([]);
  });

  test('a job lookup slower than Home\'s own budget doesn\'t bounce Start back and forth', async ({ page, baseURL }) => {
    const mock = await openStatus(page, baseURL, {
      username: null,
      job: { state: 'cancelled', completedAtMs: Date.now() },
    });
    const start = page.locator('.home-card button:has-text("Start")');
    await expect(start).toBeVisible({ timeout: 15000 });

    // A job appears, and the worker now takes 5 s to describe it: more than
    // Home's 3 s, less than /scrobble's 8 s.
    Object.assign(mock.world.job!, { state: 'active', completedAtMs: null });
    await page.route('http://background.invalid/scrobblify/job', async (route: Route) => {
      if (route.request().method() === 'GET') {
        await new Promise((resolve) => { setTimeout(resolve, 5000); });
      }
      await route.fallback();
    });
    const visited: string[] = [];
    let arrivedAtMs = 0;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) {
        const { hash } = new URL(frame.url());
        visited.push(hash);
        // The router rewrites the current entry before it pushes, so Home's
        // own hash shows up once before /scrobble's.
        if (hash === '#/' && !arrivedAtMs && visited.includes('#/scrobble')) {
          arrivedAtMs = Date.now();
        }
      }
    });
    // Home shows the job /scrobble found rather than asking again.
    const asksAfterArriving: string[] = [];
    page.on('request', (request) => {
      if (arrivedAtMs && request.method() === 'GET' && new URL(request.url()).pathname === '/scrobblify/job') {
        asksAfterArriving.push(request.url());
      }
    });

    await start.click();
    await expect(page.locator(`${CARD} .status-sub`)).toHaveText(SAFE, { timeout: 40000 });
    await expect(page).toHaveURL(/\/#\/$/);
    // Long enough for Home to have asked again and given up, had it done so.
    await page.waitForTimeout(6000);
    await expect(page.locator(`${CARD} .status-sub`)).toHaveText(SAFE);
    await expect(start).toHaveCount(0);
    expect(visited.filter((hash) => hash.startsWith('#/scrobble')).length).toBe(1);
    expect(asksAfterArriving).toEqual([]);
  });

  test('a worker sign-in that fails comes back to the status page and says so', async ({ page, baseURL }) => {
    const { origin } = new URL(baseURL || 'http://localhost:8471');
    await openStatus(page, baseURL, {
      job: { state: 'needs_reauth' },
      routes: async (p) => {
        // The worker's callback sends a refused sign-in to /scrobble?signin=failed.
        await p.route('http://background.invalid/scrobblify/auth/signin', (route: Route) => route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'Access-Control-Allow-Origin': '*' },
          body: JSON.stringify({ ok: true, authoriseUrl: `${origin}/?signin=failed#/scrobble` }),
        }));
      },
    });
    const card = page.locator(CARD);
    await card.locator('.status-action:has-text("Sign in again")').click({ timeout: 15000 });
    await expect(card.locator('.status-notice')).toHaveText('Signing in to the background service didn\'t work. Please try again.', { timeout: 20000 });
    await expect(card.locator('.status-line')).toHaveText('Last.fm signed us out');
    await expect(page).toHaveURL(/\/#\/$/);
    expect(page.url()).not.toContain('signin=failed');

    await page.reload();
    await expect(card.locator('.status-line')).toHaveText('Last.fm signed us out', { timeout: 15000 });
    await expect(card.locator('.status-notice')).toHaveCount(0);
  });

  test('a stopped job handed over here, with no sign-in, doesn\'t claim to be finishing', async ({ page, baseURL }) => {
    await openStatus(page, baseURL, {
      session: false,
      job: { state: 'dormant', dormantFrom: 'paused', inactivityDeadlineSec: deadline() },
      record: { importId: IMPORT_ID, username: 'testuser', originalTotal: 8000 },
    });
    const card = page.locator(CARD);
    await expect(card.locator('.status-line')).toHaveText('Your import is waiting on Scrobblify. Sign in to see why.', { timeout: 15000 });
    await expect(card).not.toContainText('expecting to finish');
    await expect(card.locator('.status-bar')).toContainText('2,000 / 8,000 · 25%');
    await expect(card.locator('.status-action')).toHaveText(['Sign in']);
    await expect(card.locator('.status-action:has-text("Sign in")')).toBeEnabled();
  });

  test('a paused job handed over here, with no sign-in, says it is paused', async ({ page, baseURL }) => {
    await openStatus(page, baseURL, {
      session: false,
      job: { state: 'paused' },
      record: { importId: IMPORT_ID, username: 'testuser', originalTotal: 8000 },
    });
    const card = page.locator(CARD);
    await expect(card.locator('.status-line')).toHaveText('Paused', { timeout: 15000 });
    await expect(card.locator('.status-sub')).toHaveText('Sign in to manage it');
    await expect(card.locator('.status-action')).toHaveText(['Sign in']);
  });

  test('the server\'s reason is in a tooltip', async ({ page, baseURL }) => {
    await openStatus(page, baseURL, {
      job: { state: 'needs_attention', reason: 'Last.fm failed 10 times in a row.' },
    });
    await page.locator(`${CARD} .status-reason`).hover();
    await expect(page.locator('.v-tooltip .v-overlay__content'))
      .toHaveText('Last.fm failed 10 times in a row.');
  });

  test('a job on hold for a full server can\'t reconnect until a place opens up', async ({ page, baseURL }) => {
    const mock = await openStatus(page, baseURL, {
      job: { state: 'dormant', dormantFrom: 'paused', inactivityDeadlineSec: deadline() },
      worker: { capacityAvailable: false },
      clock: true,
    });
    const card = page.locator(CARD);
    await expect(card.locator('.status-line')).toHaveText('Paused by scrobblify. A lot of people are scrobbling! Feel free to buy me a coffee so I can run more servers! You can scrobble locally or try again later.', { timeout: 15000 });
    await expect(card.locator('.status-line a:has-text("buy me a coffee")')).toHaveAttribute('href', 'https://buymeacoffee.com/nikosavas');
    await expect(card.locator('.status-line button:has-text("scrobble locally")')).toBeVisible();
    await expect(card.locator('.status-action')).toHaveText(['Reconnect', MOVE_BACK, 'Cancel']);
    await expect(card.locator('.status-action:has-text("Reconnect")')).toBeDisabled();

    mock.world.capacityAvailable = true;
    await page.clock.fastForward('05:30');
    await expect(card.locator('.status-action:has-text("Reconnect")')).toBeEnabled({ timeout: 10000 });
    await expect(card.locator('.status-line')).toHaveText(await dormantLine(page, jobView(mock)));
  });

  test('an active job refreshes itself after its next batch', async ({ page, baseURL }) => {
    const mock = await openStatus(page, baseURL, { clock: true });
    const bar = page.locator(`${CARD} .status-bar`);
    await expect(bar).toContainText('2,000 / 8,000 · 25%', { timeout: 15000 });
    mock.world.job!.scrobbled = 4000;
    await page.clock.fastForward('10:30');
    await expect(bar).toContainText('4,000 / 8,000 · 50%', { timeout: 10000 });
  });

  // #173: a take-back's claim lapses and the job goes back to where it was.
  test('a job being handed back refreshes itself, and moves on when it goes back to paused', async ({ page, baseURL }) => {
    const mock = await openStatus(page, baseURL, { job: { state: 'exporting' }, clock: true });
    const card = page.locator(CARD);
    await expect(card.locator('.status-line')).toHaveText('Downloading progress from scrobblify servers...', { timeout: 15000 });
    await expect(card.locator('.status-action')).toHaveCount(0);
    mock.world.job!.state = 'paused';
    await page.clock.fastForward('00:45');
    await expect(card.locator('.status-line')).toHaveText('Paused', { timeout: 10000 });
    await expect(card.locator('.status-action')).toHaveText(['Resume', MOVE_BACK, 'Cancel']);
  });

  test('a cancelled job is not shown', async ({ page, baseURL }) => {
    await openStatus(page, baseURL, { job: { state: 'cancelled', completedAtMs: Date.now() } });
    await expect(page.locator('.returning-card button:has-text("Upload Spotify zip")')).toBeVisible({ timeout: 15000 });
    await expect(page.locator(CARD)).toHaveCount(0);
  });

  test('a finished job that was dismissed is not shown', async ({ page, baseURL }) => {
    await openStatus(page, baseURL, {
      job: { state: 'completed', scrobbled: 8000, completedAtMs: Date.now() },
      seed: { [DISMISSED_KEY]: 'j-status' },
    });
    await expect(page.locator('.returning-card button:has-text("Upload Spotify zip")')).toBeVisible({ timeout: 15000 });
    await expect(page.locator(CARD)).toHaveCount(0);
  });

  test('counts the whole import when this browser handed it over', async ({ page, baseURL }) => {
    await openStatus(page, baseURL, {
      job: { totalTracks: 12000, scrobbled: 3710 },
      record: { importId: IMPORT_ID, username: 'testuser', originalTotal: 18523 },
    });
    await expect(page.locator(`${CARD} .status-bar`)).toContainText('10,233 / 18,523 · 55%', { timeout: 15000 });
  });

  test('shows the BETA tag to a browser outside the beta', async ({ page, baseURL }) => {
    await openStatus(page, baseURL);
    await expect(page.locator(CARD)).toBeVisible({ timeout: 15000 });
    await expect(page.locator('#logo .beta-tag')).toHaveText('BETA');
  });

  test('a job on another device, with no sign-in here, offers to sign in', async ({ page, baseURL }) => {
    const signIns: Record<string, unknown>[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/scrobblify/auth/signin')) {
        signIns.push(JSON.parse(request.postData() || '{}'));
      }
    });
    await openStatus(page, baseURL, { session: false });
    const card = page.locator(CARD);
    await expect(card.locator('.status-line')).toHaveText('Scrobblify is scrobbling for you!', { timeout: 15000 });
    await expect(card.locator('.status-sub')).toHaveText('Sign in to manage it');
    await expect(card.locator('.status-bar')).toHaveCount(0);
    await expect(card.locator('.status-action')).toHaveText(['Sign in']);

    await card.locator('.status-action:has-text("Sign in")').click();
    // The sign-in returns to /scrobble, which sends it back here.
    await expect(card.locator('.status-sub')).toHaveText(SAFE, { timeout: 15000 });
    await expect(page).toHaveURL(/\/#\/$/);
    expect(signIns).toEqual([expect.objectContaining({ username: 'testuser' })]);
    expect(await page.evaluate((key) => localStorage.getItem(key), SESSION_KEY)).toBeTruthy();
  });

  test('"Sign in again" reconnects Last.fm and the job carries on', async ({ page, baseURL }) => {
    const mock = await openStatus(page, baseURL, { job: { state: 'needs_reauth' } });
    await page.locator(`${CARD} .status-action:has-text("Sign in again")`).click();
    await expect(page.locator(`${CARD} .status-line`)).toContainText('This will finish around', { timeout: 15000 });
    await expect(page).toHaveURL(/\/#\/$/);
    expect(mock.world.job!.state).toBe('active');
  });

  test('/scrobble with a job on the server goes to the status page', async ({ page, baseURL }) => {
    await openStatus(page, baseURL);
    await expect(page.locator(CARD)).toBeVisible({ timeout: 15000 });
    await page.goto('/#/scrobble');
    await expect(page).toHaveURL(/\/#\/$/, { timeout: 15000 });
    await expect(page.locator(`${CARD} .status-sub`)).toHaveText(SAFE, { timeout: 15000 });
    await expect(page.locator('.upload-step')).toHaveCount(0);
  });

  test('/scrobble with a finished job that was dismissed stays on the upload step', async ({ page, baseURL }) => {
    const jobChecks: string[] = [];
    page.on('response', (response) => {
      if (new URL(response.url()).pathname === '/scrobblify/job') {
        jobChecks.push(response.url());
      }
    });
    await openStatus(page, baseURL, {
      job: { state: 'completed', scrobbled: 8000, completedAtMs: Date.now() },
      seed: { [DISMISSED_KEY]: 'j-status' },
    });
    await expect(page.locator('.returning-card')).toBeVisible({ timeout: 15000 });
    jobChecks.length = 0;
    await page.goto('/#/scrobble');
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
    await expect.poll(() => jobChecks.length).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/#\/scrobble$/);
  });

  // Signed in to Last.fm in this browser as the job's user.
  const SIGNED_IN = { scrobblifyLfmAuthToken: 'fake-token', scrobblifyLfmAuthKey: MOCK_SESSION_KEY };
  const OUT_OF_DATE = 'text=out-of-date copy of your import';

  /*
    Where "Scrobble the rest locally" ends up: back on /scrobble with the
    server's remaining tracks saved here, the job cancelled, and Resume
    offered. Resume must then actually send (#148 left the tab halted).
  */
  async function expectMovedBack(page: Page, mock: MockWorker) {
    await expect(page.locator('text=Your remaining tracks are back in this browser.')).toBeVisible({ timeout: 20000 });
    await expect(page).toHaveURL(/#\/scrobble/);
    const resume = page.locator('.scrobblify > .v-alert button:has-text("Resume")');
    await expect(resume).toBeVisible();
    await expect(page.locator(OUT_OF_DATE)).toHaveCount(0);
    expect(mock.world.job!.state).toBe('cancelled');
    // Nothing sends it back to Home: the job is gone.
    await page.waitForTimeout(500);
    await expect(page).toHaveURL(/#\/scrobble/);
    await expect(page.locator(OUT_OF_DATE)).toHaveCount(0);

    const scrobbles: string[] = [];
    page.on('request', (request) => {
      const params = new URLSearchParams(request.postData() || '');
      if (request.url().startsWith('https://ws.audioscrobbler.com/') && params.get('method') === 'track.scrobble') {
        scrobbles.push(params.get('track[0]') || '');
      }
    });
    await resume.click();
    const scrobble = page.getByRole('button', { name: 'Scrobble', exact: true });
    await expect(scrobble).toBeEnabled({ timeout: 10000 });
    await scrobble.click();
    await expect.poll(() => scrobbles.length, { timeout: 15000 }).toBeGreaterThan(0);
  }

  test('"Scrobble the rest locally", signed in here, brings the tracks back (#148)', async ({ page, baseURL }) => {
    const events = captureEvents(page);
    const mock = await openStatus(page, baseURL, { seed: SIGNED_IN });
    await page.locator(`${CARD} .status-action:has-text("${MOVE_BACK}")`).click({ timeout: 15000 });
    await expectMovedBack(page, mock);
    expect(events.map((e) => e.name)).not.toContain('move_back_explainer_shown');
    expect(events.map((e) => e.name)).not.toContain('background_stale_tab_blocked');
    expect(events.map((e) => e.name)).toContain('background_job_reclaimed');
  });

  // #173: the job is left `exporting` under this tab's claim, so only this tab can retry before it lapses.
  test('a take-back that fails goes back to the status page, which can try it again', async ({ page, baseURL }) => {
    let exports = 0;
    const mock = await openStatus(page, baseURL, {
      seed: SIGNED_IN,
      routes: async (p, m) => {
        await p.route('http://background.invalid/scrobblify/job/*/export', async (route: Route) => {
          exports += 1;
          if (exports > 1) {
            await route.fallback();
            return;
          }
          // The worker claims the export, then the answer comes back unusable.
          const url = new URL(route.request().url());
          m.handle('POST', url.pathname, url.searchParams, route.request().postData() || '');
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify({ ok: true, state: null }),
          });
        });
      },
    });
    const card = page.locator(CARD);
    await card.locator(`.status-action:has-text("${MOVE_BACK}")`).click({ timeout: 15000 });
    const dialog = page.locator('.v-dialog:has-text("Something went wrong")');
    await expect(dialog).toContainText('Couldn\'t bring your progress back.', { timeout: 20000 });
    expect(mock.world.job!.state).toBe('exporting');
    await dialog.locator('button:has-text("OK")').click();

    await expect(page).toHaveURL(/\/#\/$/, { timeout: 15000 });
    await expect(card.locator('.status-line')).toHaveText('Couldn\'t move your progress back. It\'s safe on our server.', { timeout: 15000 });
    await expect(card.locator('.status-action')).toHaveText([MOVE_BACK]);
    await card.locator(`.status-action:has-text("${MOVE_BACK}")`).click();
    await expectMovedBack(page, mock);
    expect(exports).toBe(2);
  });

  test('"Scrobble the rest locally" while signed out explains the second Last.fm approval first', async ({ page, baseURL }) => {
    const events = captureEvents(page);
    await routeLastFmSignIn(page);
    const mock = await openStatus(page, baseURL);
    await page.locator(`${CARD} .status-action:has-text("${MOVE_BACK}")`).click({ timeout: 15000 });

    const dialog = page.locator('.v-dialog .move-back-explainer');
    await expect(dialog.locator('.v-card-title')).toHaveText('Scrobble the rest locally?');
    await expect(dialog.locator('.v-card-text')).toHaveText('Scrobblify talks to Last.fm in two ways, one for its server and one for your browser, so Last.fm will ask you to approve Scrobblify again. You won\'t lose your progress.');
    await expect(dialog.locator('button')).toHaveText(['Cancel', 'Continue to Last.fm']);
    expect(events.map((e) => e.name)).toContain('move_back_explainer_shown');

    await dialog.locator('button:has-text("Continue to Last.fm")').click();
    await expectMovedBack(page, mock);
    expect(events).toContainEqual({ name: 'move_back_explainer_choice', props: { choice: 'continue' } });
    expect(events).toContainEqual({ name: 'sign_in_started', props: { intent: 'takeBack' } });
  });

  test('the explainer\'s Cancel changes nothing', async ({ page, baseURL }) => {
    const events = captureEvents(page);
    const lastFmSignIns: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith('https://www.last.fm/api/auth/')) {
        lastFmSignIns.push(request.url());
      }
    });
    const mock = await openStatus(page, baseURL);
    await page.locator(`${CARD} .status-action:has-text("${MOVE_BACK}")`).click({ timeout: 15000 });
    const dialog = page.locator('.v-dialog .move-back-explainer');
    await dialog.locator('button:has-text("Cancel")').click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/#\/$/);
    await expect(page.locator(`${CARD} .status-sub`)).toHaveText(SAFE);
    expect(mock.world.job!.state).toBe('active');
    expect(lastFmSignIns).toEqual([]);
    expect(events).toContainEqual({ name: 'move_back_explainer_choice', props: { choice: 'cancel' } });
    expect(await page.evaluate(() => sessionStorage.getItem('scrobblify.signInIntent'))).toBeNull();
  });

  // #148: the tab that took the progress back ignores its own release, but a
  // sibling still holding the pre-handover queue in memory must stay blocked.
  test('a sibling tab is still told it is out of date after a take-back (#148)', async ({ page, baseURL }) => {
    const mock = await openStatus(page, baseURL, { seed: SIGNED_IN, session: false });
    const sibling = await page.context().newPage();
    await interceptLastFm(sibling);
    // The same mock worker, so both tabs see one job.
    await sibling.route('http://background.invalid/**', async (route: Route) => {
      const url = new URL(route.request().url());
      await route.fulfill(mock.handle(
        route.request().method(),
        url.pathname.replace(/\/+$/, ''),
        url.searchParams,
        route.request().postData() || '',
      ));
    });
    // No worker session yet, so the sibling can't see the job and stays on
    // /scrobble, blocked by the live answer for its username.
    await sibling.goto('/#/scrobble');
    await expect(sibling.locator('text=Your import is still running on the server')).toBeVisible({ timeout: 15000 });

    await page.evaluate((key) => localStorage.setItem(key, 's-status'), SESSION_KEY);
    await page.reload();
    await page.locator(`${CARD} .status-action:has-text("${MOVE_BACK}")`).click({ timeout: 15000 });
    await expect(page.locator('text=Your remaining tracks are back in this browser.')).toBeVisible({ timeout: 20000 });
    await expect(page.locator(OUT_OF_DATE)).toHaveCount(0);

    await expect(sibling.locator(OUT_OF_DATE)).toBeVisible({ timeout: 10000 });
    await expect(sibling.locator('.scrobblify > .v-alert button:has-text("Resume")')).toHaveCount(0);
    expect(mock.world.job!.state).toBe('cancelled');
  });

  test('a reconnect that can\'t reach the server says so', async ({ page, baseURL }) => {
    await openStatus(page, baseURL, {
      job: { state: 'dormant', dormantFrom: 'paused', inactivityDeadlineSec: deadline() },
    });
    await page.route('http://background.invalid/scrobblify/auth/signin', (route: Route) => route.abort('internetdisconnected'));
    await page.locator(`${CARD} .status-action:has-text("Reconnect")`).click();
    await expect(page.locator(`${CARD} .status-notice`)).toHaveText("Couldn't reach our server. Try again in a few minutes.");
    await expect(page).toHaveURL(/\/#\/$/);
  });

  test('Pause, then Resume', async ({ page, baseURL }) => {
    const mock = await openStatus(page, baseURL);
    const card = page.locator(CARD);
    await card.locator('.status-action:has-text("Pause")').click({ timeout: 15000 });
    await expect(card.locator('.status-line')).toHaveText('Paused');
    expect(mock.world.job!.state).toBe('paused');
    await card.locator('.status-action:has-text("Resume")').click();
    await expect(card.locator('.status-line')).toContainText('This will finish around');
    expect(mock.world.job!.state).toBe('active');
  });

  test('"Try again" restarts a job stopped by errors', async ({ page, baseURL }) => {
    const mock = await openStatus(page, baseURL, { job: { state: 'needs_attention', reason: 'Errors.' } });
    await page.locator(`${CARD} .status-action:has-text("Try again")`).click({ timeout: 15000 });
    await expect(page.locator(`${CARD} .status-line`)).toContainText('This will finish around');
    expect(mock.world.job!.state).toBe('active');
  });

  test('Cancel asks first, then stops the job and goes back to the normal page', async ({ page, baseURL }) => {
    const mock = await openStatus(page, baseURL, {
      record: { importId: IMPORT_ID, username: 'testuser', originalTotal: 8000 },
    });
    const card = page.locator(CARD);
    await card.locator('.status-action:has-text("Cancel")').click({ timeout: 15000 });
    const dialog = page.locator('.v-dialog .status-cancel');
    await expect(dialog.locator('.v-card-title')).toHaveText('Stop scrobbling');
    await expect(dialog.locator('.v-card-text')).toHaveText('Your remaining tracks will be deleted from our servers. The 2,000 already scrobbled to last.fm will stay there.');
    await dialog.locator('button:has-text("Keep scrobbling")').click();
    await expect(dialog).toBeHidden();
    expect(mock.world.job!.state).toBe('active');

    await card.locator('.status-action:has-text("Cancel")').click();
    // Only Home's own clear may forget the record: the lookup of a cancelled
    // import would drop it too, so it doesn't answer from here on.
    await page.route('http://background.invalid/scrobblify/import/**', (route: Route) => route.abort('internetdisconnected'));
    await dialog.locator('button:has-text("Cancel")').click();
    await expect(page.locator('.returning-card button:has-text("Upload Spotify zip")')).toBeVisible();
    await expect(page.locator(CARD)).toHaveCount(0);
    expect(mock.world.job!.state).toBe('cancelled');
    expect(await page.evaluate((key) => localStorage.getItem(key), RECORD_KEY)).toBeNull();
  });

  test('a finished job links to Last.fm, and "Start a new import" dismisses it', async ({ page, baseURL }) => {
    await openStatus(page, baseURL, {
      job: { state: 'completed', scrobbled: 8000, completedAtMs: Date.now() },
    });
    const card = page.locator(CARD);
    const link = card.locator('a.status-action:has-text("Check it out!")');
    await expect(link).toHaveAttribute('href', 'https://www.last.fm/user/testuser', { timeout: 15000 });
    await expect(link).toHaveAttribute('target', '_blank');
    await card.locator('.status-action:has-text("Start a new import")').click();
    await page.waitForURL(/#\/scrobble$/);
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
    expect(await page.evaluate((key) => localStorage.getItem(key), DISMISSED_KEY)).toBe('j-status');
    await page.goto('/#/');
    await expect(page.locator('.returning-card button:has-text("Upload Spotify zip")')).toBeVisible({ timeout: 15000 });
  });
});

test.describe('"Already scrobbling on scrobblify?" with a worker', () => {
  const NOTHING = "text=We weren't able to find an active scrobblify session for you.";

  /*
    A fresh browser, not in the beta, on Home. `lastFmSignIns` counts trips
    to the browser app's own Last.fm sign-in.
  */
  async function openHome(page: Page, baseURL: string | undefined) {
    const lastFmSignIns: string[] = [];
    await interceptLastFm(page);
    await routeLastFmSignIn(page);
    const mock = await interceptBackgroundWorker(page, {
      apiOrigin: 'http://background.invalid',
      appOrigin: new URL(baseURL || 'http://localhost:8471').origin,
      log: false,
    });
    page.on('request', (request) => {
      if (request.url().startsWith('https://www.last.fm/api/auth/')) {
        lastFmSignIns.push(request.url());
      }
    });
    await page.goto('/#/');
    return { mock, lastFmSignIns };
  }

  test('with a live job, signs in to the worker and lands on the job', async ({ page, baseURL }) => {
    const events = captureEvents(page);
    const { mock, lastFmSignIns } = await openHome(page, baseURL);
    const nowMs = Date.now();
    mock.world.job = {
      id: 'j-live',
      username: 'testuser',
      importId: 'd1d2d3d4d5d6d7d8d9d0e1e2e3e4e5e6',
      state: 'active',
      reason: null,
      totalTracks: 5000,
      scrobbled: 0,
      failed: 0,
      waitingUntil: null,
      createdAtMs: nowMs,
      lastTickMs: nowMs,
      completedAtMs: null,
      inactivityDeadlineSec: null,
      exportClaim: '',
    };
    await page.locator('button:has-text("Re-connect to last.fm")').click();

    // Back on /scrobble, which reports the lookup and sends it on to Home.
    await expect.poll(() => events, { timeout: 20000 })
      .toContainEqual({ name: 'worker_lookup_result', props: { result: 'job' } });
    const card = page.locator('.status-card');
    await expect(card.locator('.status-sub')).toHaveText("Scrobbling remotely, it's safe to close this tab.", { timeout: 20000 });
    await expect(card.locator('.v-card-title')).toHaveText('Scrobbling to testuser');
    await expect(page).toHaveURL(/\/#\/$/);
    await expect(page.locator(NOTHING)).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('scrobblifyLfmUserName'))).toBe('testuser');
    expect(lastFmSignIns).toEqual([]);
    expect(events.map((e) => e.name)).toContain('worker_lookup_started');
    expect(await page.evaluate(() => sessionStorage.getItem('scrobblify.background.lookup'))).toBeNull();
  });

  test('with no job and nothing saved, says there is nothing to resume', async ({ page, baseURL }) => {
    const events = captureEvents(page);
    const { lastFmSignIns } = await openHome(page, baseURL);
    await page.locator('button:has-text("Re-connect to last.fm")').click();

    const dialog = page.locator('.v-dialog .nothing-to-resume');
    await expect(dialog).toBeVisible({ timeout: 20000 });
    await expect(dialog.locator('.v-card-text')).toHaveText("We weren't able to find an active scrobblify session for you.");
    await expect(dialog.locator('button')).toHaveCount(1);
    await expect(page.locator('.scrobblify > .v-alert')).toHaveCount(0);
    expect(lastFmSignIns).toEqual([]);
    await expect.poll(() => events).toContainEqual({ name: 'worker_lookup_result', props: { result: 'nothing' } });

    await dialog.locator('button:has-text("OK")').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.upload-step')).toBeVisible();
    await expect(page).toHaveURL(/#\/scrobble/);
  });

  test('a worker that refuses the sign-in falls back to the browser\'s Last.fm sign-in', async ({ page, baseURL }) => {
    const { lastFmSignIns } = await openHome(page, baseURL);
    // Registered after the mock: later routes get first refusal.
    await page.route('http://background.invalid/scrobblify/auth/signin', (route: Route) => route.abort('internetdisconnected'));
    await page.locator('button:has-text("Re-connect to last.fm")').click();

    await expect(page.locator('text=Currently authenticated as: testuser')).toBeVisible({ timeout: 15000 });
    expect(lastFmSignIns.length).toBe(1);
    expect(await page.evaluate(() => sessionStorage.getItem('scrobblify.background.lookup'))).toBeNull();
    await expect(page.locator(NOTHING)).toHaveCount(0);
  });
});

test.describe('Choosing the server in the confirm dialog', () => {
  const HANDED_OVER_KEY = 'scrobblify.background.handedOverImport';

  /*
    Where a confirmed handover lands: Home, with nothing left of the return's
    URL, and the welcome-back card showing the job running.
  */
  async function expectHomeShowsJob(page: Page, user = 'testuser') {
    const card = page.locator('.status-card');
    await expect(card.locator('.status-sub')).toHaveText("Scrobbling remotely, it's safe to close this tab.", { timeout: 20000 });
    await expect(card.locator('.v-card-title')).toHaveText(`Scrobbling to ${user}`);
    await expect(page).toHaveURL(/\/#\/$/);
    await expect(page.locator('.upload-step')).toHaveCount(0);
  }

  type Opened = {
    scrobbles: string[];
    preflights: Record<string, unknown>[];
    mock: MockWorker;
  };

  /*
    The mock worker end to end: preflight, the Last.fm shim, upload and job
    status. `beta` opts in with `?beta=1`, `false` opts out with `?beta=0`.
  */
  async function openWithWorker(
    page: Page,
    baseURL: string | undefined,
    {
      beta = true, signedIn = false, worker = {}, saved = null, seed = {},
    }: {
      beta?: boolean;
      signedIn?: boolean;
      worker?: Record<string, unknown>;
      saved?: Record<string, unknown> | null;
      /** localStorage entries written before the page that is tested loads. */
      seed?: Record<string, string>;
    } = {},
  ): Promise<Opened> {
    const scrobbles: string[] = [];
    const preflights: Record<string, unknown>[] = [];
    let capacityAnswers = 0;
    await interceptLastFm(page);
    await routeLastFmSignIn(page);
    const mock = await interceptBackgroundWorker(page, {
      apiOrigin: 'http://background.invalid',
      appOrigin: new URL(baseURL || 'http://localhost:8471').origin,
      log: false,
      ...worker,
    });
    page.on('response', (response) => {
      if (response.url().endsWith('/scrobblify/capacity')) {
        capacityAnswers += 1;
      }
    });
    page.on('request', (request) => {
      if (request.url().endsWith('/scrobblify/handoff/preflight')) {
        preflights.push(JSON.parse(request.postData() || '{}'));
      }
      const params = new URLSearchParams(request.postData() || '');
      if (request.url().startsWith('https://ws.audioscrobbler.com/') && params.get('method') === 'track.scrobble') {
        scrobbles.push(params.get('track[0]') || '');
      }
    });
    await page.goto('/#/scrobble');
    if (signedIn) {
      await mockLastFmAuth(page);
    }
    if (saved) {
      await page.evaluate(async (state) => {
        await new Promise<void>((resolve, reject) => {
          const request = indexedDB.open('scrobblify', 1);
          request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains('scrobbleState')) {
              request.result.createObjectStore('scrobbleState');
            }
          };
          request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction('scrobbleState', 'readwrite');
            tx.objectStore('scrobbleState').put(state, 'current');
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); reject(tx.error); };
          };
          request.onerror = () => reject(request.error);
        });
      }, saved);
    }
    await page.evaluate((entries) => {
      Object.entries(entries).forEach(([key, value]) => window.localStorage.setItem(key, value));
    }, seed);
    await page.goto(beta ? '/?beta=1#/scrobble' : '/?beta=0#/scrobble');
    capacityAnswers = 0;
    await page.reload();
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
    if (beta) {
      // The capacity probe decides whether the choice is offered at all.
      await expect.poll(() => capacityAnswers, { timeout: 10000 }).toBeGreaterThan(0);
    }
    return { scrobbles, preflights, mock };
  }

  // Recent plays, so none is re-tagged and the large-history gate stays shut.
  // A few distinct tracks, so validation looks up only those. `old`: plays
  // from last year, moved to today ("Scrobble tracks older than 2 weeks").
  async function chooseRecentPlays(page: Page, count: number, { old = false } = {}) {
    const startMs = Date.now() - (old ? 400 : 3) * 86400 * 1000;
    const zip = new JSZip();
    zip.file('Spotify Extended Streaming History/Streaming_History_Audio_2024.json', JSON.stringify(
      Array.from({ length: count }, (_, i) => ({
        ts: new Date(startMs + i * 60000).toISOString(),
        master_metadata_track_name: `Track ${i % 20}`,
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
    if (old) {
      await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    }
    await page.locator('button:has-text("Find tracks")').click();
    await page.locator('.upload-step button:has-text("Choose which tracks to scrobble")').click({ timeout: 30000 });
    if (old) {
      await page.locator('button:has-text("I understand, continue")').click({ timeout: 5000 });
    }
    await page.locator('button:has-text("matching")').click({ timeout: 5000 });
    await page.locator(`button:has-text("Scrobble ${count} selected tracks")`).click();
    const dialog = page.locator('.scrobble-confirm');
    await expect(dialog).toBeVisible({ timeout: 10000 });
    return dialog;
  }

  const SAVED = {
    userName: '',
    totalTracks: 5,
    completedIndices: [0, 1, 2],
    failedIndices: [],
    tracks: [1, 2, 3, 4, 5].map((n) => ({
      track: `Old ${n}`, artist: 'Band', album: '', timestamp: Date.UTC(2024, 0, n),
    })),
    originalTotalTracks: 5,
    originalSucceededCount: 3,
    sendTimestamps: [],
    burstCount: 0,
    dailyCount: 0,
    dailyCountDate: new Date().toISOString().split('T')[0],
    savedAt: new Date().toISOString(),
  };

  test('a signed-out beta user hands a large selection to the server without signing in here', async ({ page, baseURL }) => {
    const events = captureEvents(page);
    const { scrobbles, preflights } = await openWithWorker(page, baseURL);
    const dialog = await chooseRecentPlays(page, 800);

    await expect(dialog.locator('.v-card-title')).toHaveText('Scrobble 800 tracks?');
    await expect(dialog.locator('.scrobble-estimate')).toHaveCount(0);
    await expect(dialog.locator('.choice-dates')).toHaveCount(0);
    await expect(dialog.locator('button:has-text("Start scrobbling")')).toHaveCount(0);
    await expect.poll(() => events.filter((e) => e.name === 'background_offer_shown').map((e) => e.props))
      .toContainEqual(expect.objectContaining({ entry_point: 'confirm', track_count: 800 }));
    await dialog.locator('button:has-text("Let Scrobblify scrobble for me (beta)")').click();

    // Handed over: Home's welcome-back card, under the name the worker gave.
    await expectHomeShowsJob(page);
    expect(preflights).toHaveLength(1);
    expect(preflights[0]).not.toHaveProperty('username');
    const stored = await page.evaluate((key) => ({
      user: localStorage.getItem('scrobblifyLfmUserName'),
      key: localStorage.getItem('scrobblifyLfmAuthKey'),
      handedOver: localStorage.getItem(key),
    }), HANDED_OVER_KEY);
    expect(stored.user).toBe('testuser');
    expect(stored.key).toBeNull();
    expect(JSON.parse(stored.handedOver || '{}')).toMatchObject({ username: 'testuser', originalTotal: 800 });
    expect(scrobbles).toEqual([]);

    // /scrobble sends it back to Home's status page.
    await page.goto('/#/scrobble');
    await expectHomeShowsJob(page);
    expect(scrobbles).toEqual([]);
  });

  test('"scrobble locally" signs in to Last.fm here and lands ready to send', async ({ page, baseURL }) => {
    const events = captureEvents(page);
    const { scrobbles, preflights } = await openWithWorker(page, baseURL);
    const dialog = await chooseRecentPlays(page, 800);
    await expect(dialog.locator('.v-card-title')).toHaveText('Scrobble 800 tracks?');
    await dialog.locator('a:has-text("scrobble locally")').click();

    await expect(page.locator('text=Currently authenticated as: testuser')).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('button', { name: 'Scrobble', exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=800 tracks ready to scrobble')).toBeVisible();
    expect(preflights).toEqual([]);
    expect(scrobbles).toEqual([]);
    const declined = events.filter((e) => e.name === 'background_offer_declined');
    expect(declined.map((e) => e.props)).toEqual([
      { entry_point: 'confirm', track_count: 800, all_re_tagged: false },
    ]);
  });

  test('"scrobble locally" reports a selection whose plays are all moved to today (#163)', async ({ page, baseURL }) => {
    const events = captureEvents(page);
    await openWithWorker(page, baseURL);
    const dialog = await chooseRecentPlays(page, 800, { old: true });
    await expect(dialog.locator('.v-card-title')).toHaveText('Scrobble 800 tracks?');
    await dialog.locator('a:has-text("scrobble locally")').click();

    await expect.poll(() => events.filter((e) => e.name === 'background_offer_declined').map((e) => e.props))
      .toEqual([{ entry_point: 'confirm', track_count: 800, all_re_tagged: true }]);
  });

  test('a selection under a day\'s cap gets the plain dialog', async ({ page, baseURL }) => {
    await openWithWorker(page, baseURL);
    const dialog = await chooseRecentPlays(page, 700);
    await expect(dialog.locator('.v-card-title')).toHaveText('Scrobble 700 tracks?');
    await expect(dialog.locator('button:has-text("Start scrobbling")')).toBeVisible();
    await expect(dialog.locator('text=Let Scrobblify scrobble for me (beta)')).toHaveCount(0);
  });

  test('outside the beta the dialog is the plain one', async ({ page, baseURL }) => {
    await openWithWorker(page, baseURL, { beta: false });
    const dialog = await chooseRecentPlays(page, 800);
    await expect(dialog.locator('.v-card-title')).toHaveText('Scrobble 800 tracks?');
    await expect(dialog.locator('button:has-text("Start scrobbling")')).toBeVisible();
    await expect(dialog.locator('text=Let Scrobblify scrobble for me (beta)')).toHaveCount(0);
  });

  test('a full server gets the plain dialog', async ({ page, baseURL }) => {
    await openWithWorker(page, baseURL, { worker: { capacityAvailable: false } });
    const dialog = await chooseRecentPlays(page, 800);
    await expect(dialog.locator('.v-card-title')).toHaveText('Scrobble 800 tracks?');
    await expect(dialog.locator('text=Let Scrobblify scrobble for me (beta)')).toHaveCount(0);
  });

  test('saved progress is asked about first, and "Start over" goes on to the choice', async ({ page, baseURL }) => {
    await openWithWorker(page, baseURL, { saved: SAVED });
    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    const dialog = await chooseRecentPlays(page, 800);

    await expect(dialog.locator('.saved-progress-warning')).toContainText('3 of 5 tracks scrobbled');
    await expect(dialog.locator('text=Let Scrobblify scrobble for me (beta)')).toHaveCount(0);
    await dialog.locator('button:has-text("Start over")').click();

    await expect(dialog.locator('.v-card-title')).toHaveText('Scrobble 800 tracks?');
    await expect(dialog.locator('.saved-progress-warning')).toHaveCount(0);
    await expect(dialog.locator('button:has-text("Let Scrobblify scrobble for me (beta)")')).toBeVisible();
  });

  test('a signed-in user\'s handoff names them', async ({ page, baseURL }) => {
    const { scrobbles, preflights } = await openWithWorker(page, baseURL, { signedIn: true });
    const dialog = await chooseRecentPlays(page, 800);
    await expect(dialog.locator('.v-card-title')).toHaveText('Scrobble 800 tracks?');
    await dialog.locator('button:has-text("Let Scrobblify scrobble for me (beta)")').click();

    await expectHomeShowsJob(page);
    expect(preflights).toHaveLength(1);
    expect(preflights[0]).toMatchObject({ username: 'testuser', trackCount: 800 });
    expect(scrobbles).toEqual([]);
  });

  test('an anonymous handoff for someone whose job is live comes back to "Sign in to see it"', async ({ page, baseURL }) => {
    const { mock, scrobbles } = await openWithWorker(page, baseURL);
    const nowMs = Date.now();
    mock.world.job = {
      id: 'j-live',
      username: 'testuser',
      importId: 'd1d2d3d4d5d6d7d8d9d0e1e2e3e4e5e6',
      state: 'active',
      reason: null,
      totalTracks: 5000,
      scrobbled: 0,
      failed: 0,
      waitingUntil: null,
      createdAtMs: nowMs,
      lastTickMs: nowMs,
      completedAtMs: null,
      inactivityDeadlineSec: null,
      exportClaim: '',
    };
    // The real worker's capacity counts places, not this user's job.
    await page.route('http://background.invalid/scrobblify/capacity', (route: Route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        available: true, used: 1, capacity: 50, minTracks: 750, maxTracks: 200000, chunkTracks: 5000,
      }),
    }));
    await page.reload();
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
    const dialog = await chooseRecentPlays(page, 800);
    await expect(dialog.locator('.v-card-title')).toHaveText('Scrobble 800 tracks?');
    await dialog.locator('button:has-text("Let Scrobblify scrobble for me (beta)")').click();

    await expect(page.locator('text=You already have an import running on Scrobblify.')).toBeVisible({ timeout: 20000 });
    const signIn = page.locator('button:has-text("Sign in to see it")');
    await expect(signIn).toBeVisible();
    // The selection is kept for later, and nothing is left frozen.
    await expect(page.locator('text=Resume previous session?')).toBeVisible();
    await expect(page.locator('text=A handover')).toHaveCount(0);
    expect(scrobbles).toEqual([]);

    // With no username anywhere, signing in to the worker finds the job.
    await signIn.click();
    await expectHomeShowsJob(page);
  });

  const OWNER_KEY = 'scrobblify.background.serverOwns';
  const PREFLIGHTED_KEY = 'scrobblify.background.preflighted';
  const RESUME_PROMPT = 'text=Resume previous session?';

  async function expectSelectionOffered(page: Page) {
    await expect(page.locator(RESUME_PROMPT)).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=A handover')).toHaveCount(0);
    await expect(page.locator('text=on hold')).toHaveCount(0);
    await expect(page.locator('text=refresh your connection')).toHaveCount(0);
    await expect(page.getByText(/handed over/)).toHaveCount(0);
    expect(await page.evaluate((key) => localStorage.getItem(key), OWNER_KEY)).toBeNull();
  }

  test('the date note shows when the selection has plays moved to today', async ({ page, baseURL }) => {
    await openWithWorker(page, baseURL);
    const dialog = await chooseRecentPlays(page, 800, { old: true });
    await expect(dialog.locator('.v-card-title')).toHaveText('Scrobble 800 tracks?');
    await expect(dialog.locator('.choice-dates')).toBeVisible();
  });

  test('a handover that fails before leaving can be tried again', async ({ page, baseURL }) => {
    const { mock, scrobbles, preflights } = await openWithWorker(page, baseURL);
    let dialog = await chooseRecentPlays(page, 800);
    await expect(dialog.locator('.v-card-title')).toHaveText('Scrobble 800 tracks?');
    // Full between the probe and the click.
    mock.world.capacityAvailable = false;
    await dialog.locator('button:has-text("Let Scrobblify scrobble for me (beta)")').click();
    await expect(page.locator('text=The background service is full right now')).toBeVisible({ timeout: 10000 });
    expect(preflights).toEqual([]);

    mock.world.capacityAvailable = true;
    await page.locator('button:has-text("Scrobble 800 selected tracks")').click();
    dialog = page.locator('.scrobble-confirm');
    await expect(dialog.locator('.saved-progress-warning')).toContainText('0 of 800 tracks scrobbled');
    await dialog.locator('button:has-text("Start over")').click();
    await dialog.locator('button:has-text("Let Scrobblify scrobble for me (beta)")').click();

    await expectHomeShowsJob(page);
    await expect(page.locator('text=would be replaced')).toHaveCount(0);
    expect(preflights).toHaveLength(1);
    expect(scrobbles).toEqual([]);
  });

  /*
    Nobody approved it, so the page withdraws it at the worker on the way back
    (`abandonOwnHandoff`). Before that it stayed on its way (`pending`) until
    reaped an hour later, and a named one kept its user live in `/job/live`,
    which blocked the signed-in page load (#164). Approving the same Last.fm
    page afterwards makes no job (#165).
  */
  for (const signedIn of [false, true]) {
    test(`going back from Last.fm without approving keeps the selection, after a refresh too (${signedIn ? 'signed in' : 'signed out'})`, async ({ page, baseURL }) => {
      const { scrobbles, preflights, mock } = await openWithWorker(page, baseURL, { signedIn });
      const { origin } = new URL(baseURL || 'http://localhost:8471');
      const lastFmPage = (route: Route) => route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><title>Last.fm</title><h1>Allow access?</h1>',
      });
      // Last.fm's page, where the user changes their mind. Registered after the
      // mock: later routes win.
      await page.route(`${origin}/mock-auth*`, lastFmPage);
      const dialog = await chooseRecentPlays(page, 800);
      await dialog.locator('button:has-text("Let Scrobblify scrobble for me (beta)")').click();
      await expect(page.locator('h1:has-text("Allow access?")')).toBeVisible({ timeout: 15000 });
      expect(preflights).toHaveLength(1);
      const importId = String(preflights[0].importId || '');
      const lookup = JSON.parse(mock.handle('GET', `/scrobblify/import/${importId}`, new URLSearchParams(), '').body);
      expect(lookup).toMatchObject({ known: true, pending: true });
      const [handoffId, handoff] = [...mock.world.handoffs.entries()][0];
      const liveQuery = new URLSearchParams({ username: 'testuser' });
      const liveFor = () => JSON.parse(mock.handle('GET', '/scrobblify/job/live', liveQuery, '').body).live;
      expect(liveFor()).toBe(signedIn);

      await page.goBack();
      await expectSelectionOffered(page);
      expect(handoff).toMatchObject({ state: 'failed', failureReason: 'abandoned' });
      expect(liveFor()).toBe(false);
      await page.reload();
      await expectSelectionOffered(page);
      // The abandoned handoff can't come back into this browser.
      expect(await page.evaluate((key) => localStorage.getItem(key), PREFLIGHTED_KEY)).toBeNull();
      expect(await page.evaluate(() => localStorage.getItem('scrobblify.background.abandonedImport'))).toBeNull();
      if (!signedIn) {
        // Signing in afterwards asks about the queue too, and gets the same answer.
        await mockLastFmAuth(page);
        await page.reload();
        await expectSelectionOffered(page);
      }

      // Approving that Last.fm page after all, from an old tab say.
      await page.unroute(`${origin}/mock-auth*`, lastFmPage);
      const adopted = signedIn ? '' : '&user=testuser';
      await page.goto(`${origin}/mock-auth?handoff=${handoffId}&session=${handoff.session}${adopted}`);
      await expect(page.locator('text=Last.fm didn\'t complete the handoff')).toBeVisible({ timeout: 15000 });
      await expectSelectionOffered(page);
      expect(mock.world.job).toBeNull();
      expect(await page.evaluate(() => localStorage.getItem('scrobblify.background.session'))).toBeNull();
      expect(scrobbles).toEqual([]);
    });
  }

  /*
    Leaves for the mock's Last.fm page and stays there: the shim would approve
    and return at once. Returns the handoff it is waiting on, and a way to
    approve it after all.
  */
  async function waitAtLastFm(page: Page, baseURL: string | undefined, mock: MockWorker) {
    const { origin } = new URL(baseURL || 'http://localhost:8471');
    const lastFmPage = (route: Route) => route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: '<!doctype html><title>Last.fm</title><h1>Allow access?</h1>',
    });
    await page.route(`${origin}/mock-auth*`, lastFmPage);
    const dialog = await chooseRecentPlays(page, 800);
    await dialog.locator('button:has-text("Let Scrobblify scrobble for me (beta)")').click();
    await expect(page.locator('h1:has-text("Allow access?")')).toBeVisible({ timeout: 15000 });
    const [handoffId, handoff] = [...mock.world.handoffs.entries()][0];
    const approve = async () => {
      await page.unroute(`${origin}/mock-auth*`, lastFmPage);
      await page.goto(`${origin}/mock-auth?handoff=${handoffId}&session=${handoff.session}&user=testuser`);
    };
    return { handoffId, handoff, approve };
  }

  async function handoffRecords(page: Page) {
    return page.evaluate(([ownerKey, preflightedKey]) => ({
      owner: JSON.parse(localStorage.getItem(ownerKey) || 'null'),
      preflighted: localStorage.getItem(preflightedKey),
    }), [OWNER_KEY, PREFLIGHTED_KEY]);
  }

  /*
    Another tab of the same browser, served by the same mock worker. Counts
    the handoff withdrawals it sends.
  */
  async function openOtherTab(page: Page, mock: MockWorker) {
    const other = await page.context().newPage();
    const opened = { other, withdrawals: 0 };
    await interceptLastFm(other);
    await other.route('http://background.invalid/**', async (route: Route) => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith('/abandon')) {
        opened.withdrawals += 1;
      }
      await route.fulfill(mock.handle(
        route.request().method(),
        url.pathname.replace(/\/+$/, ''),
        url.searchParams,
        route.request().postData() || '',
      ));
    });
    return opened;
  }

  // Backdates the freeze's attempt token, as if the handover began `ageMs` ago.
  async function ageFreeze(page: Page, ageMs: number) {
    await page.evaluate(([ownerKey, age]) => {
      const owner = JSON.parse(localStorage.getItem(ownerKey as string) || 'null');
      owner.attempt = `${Date.now() - (age as number)}.aged`;
      localStorage.setItem(ownerKey as string, JSON.stringify(owner));
    }, [OWNER_KEY, ageMs]);
  }

  /*
    The preflight record is in localStorage, so every tab sees the freeze as
    this browser's own handoff. Only the tab that left for Last.fm may settle
    it by its queue; another tab loading meanwhile abandoned the handoff, and
    the approval then failed.
  */
  test('loading the page in another tab leaves a handover waiting at Last.fm alone', async ({ page, baseURL }) => {
    const { mock, scrobbles } = await openWithWorker(page, baseURL);
    const { handoffId, handoff, approve } = await waitAtLastFm(page, baseURL, mock);

    const { other } = await openOtherTab(page, mock);
    await other.goto('/#/scrobble');
    await expect(other.locator('text=A handover is starting in another tab')).toBeVisible({ timeout: 15000 });
    await expect(other.locator(RESUME_PROMPT)).toHaveCount(0);
    expect(handoff.state).toBe('issued');
    expect(await handoffRecords(other)).toMatchObject({
      owner: { owner: 'freezing', id: handoffId },
      preflighted: handoffId,
    });
    await other.close();

    await approve();
    await expectHomeShowsJob(page);
    expect(mock.world.job).toMatchObject({ importId: handoff.importId });
    expect(scrobbles).toEqual([]);
  });

  /*
    The tab that left for Last.fm was closed there. Once the handoff can no
    longer be approved (the worker's hour, plus a margin), any tab settles the
    freeze by its queue; before that every later tab was on hold for good
    (#168). Nothing is withdrawn: there is nothing left to approve.
  */
  test('another tab releases a handover that expired at Last.fm', async ({ page, baseURL }) => {
    const { mock } = await openWithWorker(page, baseURL);
    const { handoff } = await waitAtLastFm(page, baseURL, mock);
    await ageFreeze(page, 66 * 60 * 1000);
    await page.close();
    handoff.state = 'failed';
    handoff.failureReason = 'reaped';

    const opened = await openOtherTab(page, mock);
    await opened.other.goto('/#/scrobble');
    await expectSelectionOffered(opened.other);
    expect((await handoffRecords(opened.other)).preflighted).toBeNull();
    expect(opened.withdrawals).toBe(0);
  });

  test('another tab still waits on a handover at Last.fm that can still be approved', async ({ page, baseURL }) => {
    const { mock, scrobbles } = await openWithWorker(page, baseURL);
    const { handoffId, handoff, approve } = await waitAtLastFm(page, baseURL, mock);
    // Past the 3-minute freshness rule, well inside the worker's hour.
    await ageFreeze(page, 20 * 60 * 1000);

    const opened = await openOtherTab(page, mock);
    await opened.other.goto('/#/scrobble');
    await expect(opened.other.locator('text=If that tab was closed, the handover expires within the hour'))
      .toBeVisible({ timeout: 15000 });
    await expect(opened.other.locator(RESUME_PROMPT)).toHaveCount(0);
    expect(opened.withdrawals).toBe(0);
    expect(handoff.state).toBe('issued');
    expect(await handoffRecords(opened.other)).toMatchObject({
      owner: { owner: 'freezing', id: handoffId },
      preflighted: handoffId,
    });
    await opened.other.close();

    await approve();
    await expectHomeShowsJob(page);
    expect(scrobbles).toEqual([]);
  });

  /*
    `abandoned: false` means the handoff got past waiting for its approval
    (approved between the queue check and the withdrawal, say), so the freeze
    and the preflight stay until it is known what became of it.
  */
  test('going back from Last.fm keeps the handover the worker says moved on', async ({ page, baseURL }) => {
    const { mock, scrobbles } = await openWithWorker(page, baseURL);
    const { handoffId, handoff, approve } = await waitAtLastFm(page, baseURL, mock);
    let withdrawals = 0;
    await page.route('http://background.invalid/scrobblify/handoff/*/abandon', async (route: Route) => {
      withdrawals += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ ok: true, abandoned: false }),
      });
    });

    await page.goBack();
    await expect.poll(() => withdrawals, { timeout: 15000 }).toBeGreaterThan(0);
    await expect(page.getByText(/A handover is starting in another tab|couldn't check whether the background service took over/))
      .toBeVisible({ timeout: 15000 });
    await expect(page.locator(RESUME_PROMPT)).toHaveCount(0);
    expect(await handoffRecords(page)).toMatchObject({
      owner: { owner: 'freezing', id: handoffId },
      preflighted: handoffId,
    });

    await approve();
    await expectHomeShowsJob(page);
    expect(scrobbles).toEqual([]);
  });

  /*
    A worker session left over from an earlier handoff or sign-in can't ask
    about an unapproved handoff (`GET /handoff/:id` answers "unknown" and
    `/job` sees no job), so the page has to ask about the queue as a browser
    without one does. It used to keep the freeze, and `/job/live` kept the
    signed-in user live, until the handoff was reaped an hour later (#166).
  */
  test('going back from Last.fm without approving keeps the selection with a leftover worker session', async ({ page, baseURL }) => {
    const { scrobbles, mock } = await openWithWorker(page, baseURL, {
      signedIn: true,
      seed: { 'scrobblify.background.session': 's-old' },
    });
    const { handoff } = await waitAtLastFm(page, baseURL, mock);
    const liveFor = () => JSON.parse(mock.handle('GET', '/scrobblify/job/live', new URLSearchParams({ username: 'testuser' }), '').body).live;
    expect(liveFor()).toBe(true);

    await page.goBack();
    await expectSelectionOffered(page);
    expect(handoff).toMatchObject({ state: 'failed', failureReason: 'abandoned' });
    expect(liveFor()).toBe(false);
    await page.reload();
    await expectSelectionOffered(page);
    expect(scrobbles).toEqual([]);
  });

  test('going back from Last.fm after the worker dropped the handover still offers the selection', async ({ page, baseURL }) => {
    const { mock } = await openWithWorker(page, baseURL);
    const { handoff } = await waitAtLastFm(page, baseURL, mock);
    // Reaped while the user was away, so there is nothing left to withdraw.
    handoff.state = 'failed';
    handoff.failureReason = 'reaped';

    await page.goBack();
    await expectSelectionOffered(page);
    expect((await handoffRecords(page)).preflighted).toBeNull();
  });

  test('a page restored from the back-forward cache asks about the queue, not a session', async ({ page, baseURL }) => {
    const importId = 'f1f2f3f4f5f6f7f8f9f0e1e2e3e4e5e6';
    const { mock } = await openWithWorker(page, baseURL, {
      saved: { ...SAVED, importId },
    });
    // Still waiting at the worker for an approval that never came, holding
    // its user live as a named one does (#164).
    const handoff: Record<string, unknown> = {
      state: 'issued',
      named: true,
      username: 'testuser',
      trackCount: 5,
      importId,
      chunksSeen: new Set(),
      session: '',
      jobId: '',
    };
    mock.world.handoffs.set('h-mine', handoff);
    await expect(page.locator(RESUME_PROMPT)).toBeVisible({ timeout: 10000 });
    // The page as it was when it left for Last.fm: frozen for the handoff it
    // preflighted (in this tab), busy, the selection saved but not on offer.
    await page.evaluate(async ([ownerKey, preflightedKey]) => {
      localStorage.setItem(preflightedKey, 'h-mine');
      sessionStorage.setItem(preflightedKey, 'h-mine');
      localStorage.setItem(ownerKey, JSON.stringify({ owner: 'freezing', id: 'h-mine', attempt: `${Date.now()}.t` }));
      let inst = (document.querySelector('.upload-step') as any).__vueParentComponent;
      while (inst && !(inst.proxy && typeof inst.proxy.recoverFromBfcache === 'function')) {
        inst = inst.parent;
      }
      inst.proxy.backgroundBusy = true;
      inst.proxy.pendingEntryPoint = 'confirm';
      inst.proxy.hasResumableState = false;
      await inst.proxy.recoverFromBfcache();
    }, [OWNER_KEY, PREFLIGHTED_KEY]);

    await expectSelectionOffered(page);
    expect(await page.evaluate((key) => localStorage.getItem(key), PREFLIGHTED_KEY)).toBeNull();
    // Withdrawn at the worker, so signing in below isn't blocked as live.
    expect(handoff).toMatchObject({ state: 'failed', failureReason: 'abandoned' });
    await page.reload();
    await expectSelectionOffered(page);
    // Signed in, the load asks about the queue by its user as well.
    await mockLastFmAuth(page);
    await page.reload();
    await expectSelectionOffered(page);
  });

  for (const signedIn of [false, true]) {
    test(`a handover Last.fm refuses leaves nothing frozen and the selection on offer (#160, ${signedIn ? 'signed in' : 'signed out'})`, async ({ page, baseURL }) => {
      const { scrobbles, preflights, mock } = await openWithWorker(page, baseURL, {
        signedIn, worker: { authoriseFail: 'denied' },
      });
      const dialog = await chooseRecentPlays(page, 800);
      await dialog.locator('button:has-text("Let Scrobblify scrobble for me (beta)")').click();

      await expect(page.locator('text=Last.fm didn\'t complete the handoff')).toBeVisible({ timeout: 15000 });
      await expectSelectionOffered(page);
      // The failed handoff never had the queue.
      const importId = String(preflights[0].importId || '');
      const lookup = JSON.parse(mock.handle('GET', `/scrobblify/import/${importId}`, new URLSearchParams(), '').body);
      expect(lookup.known).toBe(false);
      // The return's URL is stripped down to the bare path, which is Home.
      await page.goto('/#/scrobble');
      await page.reload();
      await expectSelectionOffered(page);
      expect(scrobbles).toEqual([]);
    });
  }

  /*
    The real worker names the account that authorised in the return fragment.
    The mock's shim stores it itself, so this drives the fragment directly
    (see "Returning from a handoff").
  */
  test.describe('the Last.fm user a handoff return names', () => {
    const IMPORT_ID = 'c1c2c3c4c5c6c7c8c9c0e1e2e3e4e5e6';

    async function openReturning(page: Page, baseURL: string | undefined, seed: Record<string, string> = {}) {
      const { mock } = await openWithWorker(page, baseURL, {
        saved: { ...SAVED, importId: IMPORT_ID },
        seed: { [PREFLIGHTED_KEY]: 'h-mine', ...seed },
      });
      mock.world.handoffs.set('h-mine', {
        username: 'testuser',
        trackCount: 2,
        importId: IMPORT_ID,
        chunksSeen: new Set(),
        session: 's-mine',
        jobId: '',
      });
      const after = await returnWith(page, 'session=s-mine&handoff=h-mine&user=testuser');
      expect(after.session).toBe('s-mine');
      expect(mock.world.job).toMatchObject({ importId: IMPORT_ID });
      return page.evaluate((key) => ({
        user: localStorage.getItem('scrobblifyLfmUserName'),
        key: localStorage.getItem('scrobblifyLfmAuthKey'),
        handedOver: JSON.parse(localStorage.getItem(key) || '{}'),
      }), HANDED_OVER_KEY);
    }

    // The real worker's return (`?handoff=ok&job=…#session=…`) lands on Home too.
    test('is remembered by a browser that knew nobody', async ({ page, baseURL }) => {
      const stored = await openReturning(page, baseURL);
      await expectHomeShowsJob(page);
      expect(stored.user).toBe('testuser');
      expect(stored.key).toBeNull();
      expect(stored.handedOver).toMatchObject({ importId: IMPORT_ID, username: 'testuser' });
    });

    // Home would welcome the other user, so its status page names no one.
    test('does not replace a different user this browser already knows', async ({ page, baseURL }) => {
      const stored = await openReturning(page, baseURL, { scrobblifyLfmUserName: 'someoneelse' });
      const card = page.locator('.status-card');
      await expect(card.locator('.status-sub')).toHaveText("Scrobbling remotely, it's safe to close this tab.", { timeout: 20000 });
      await expect(card.locator('.v-card-title')).toHaveText('Scrobbling to Last.fm');
      await expect(page).toHaveURL(/\/#\/$/);
      expect(stored.user).toBe('someoneelse');
      // The job is the account's that authorised it.
      expect(stored.handedOver).toMatchObject({ importId: IMPORT_ID, username: 'testuser' });
    });

    /*
      The build before this one recorded only the freeze naming the handoff,
      not `preflighted`, and a return from Last.fm is a fresh page load, so a
      handoff started on it comes back to this build.
    */
    for (const [returning, accepted] of [['h-mine', true], ['h-theirs', false]] as const) {
      test(`a return to a handoff an older build started is ${accepted ? 'accepted by its freeze' : 'still refused for another handoff'}`, async ({ page, baseURL }) => {
        const { mock } = await openWithWorker(page, baseURL, {
          saved: { ...SAVED, importId: IMPORT_ID },
          seed: { [OWNER_KEY]: JSON.stringify({ owner: 'freezing', id: 'h-mine', attempt: `${Date.now()}.t` }) },
        });
        mock.world.handoffs.set(returning, {
          username: 'testuser',
          trackCount: 2,
          importId: IMPORT_ID,
          chunksSeen: new Set(),
          session: `s-${returning}`,
          jobId: '',
        });
        const after = await returnWith(page, `session=s-${returning}&handoff=${returning}&user=testuser`);
        expect(after.href).not.toContain('session=');
        if (!accepted) {
          expect(after.session).toBeNull();
          expect(after.pending).toBeNull();
          expect(mock.world.job).toBeNull();
          return;
        }
        expect(after.session).toBe(`s-${returning}`);
        await expectHomeShowsJob(page);
        expect(mock.world.job).toMatchObject({ importId: IMPORT_ID });
        const stored = await page.evaluate(([ownerKey, handedOverKey]) => ({
          owner: JSON.parse(localStorage.getItem(ownerKey) || 'null'),
          handedOver: JSON.parse(localStorage.getItem(handedOverKey) || '{}'),
        }), [OWNER_KEY, HANDED_OVER_KEY]);
        expect(stored.owner).toMatchObject({ owner: 'server' });
        expect(stored.handedOver).toMatchObject({ importId: IMPORT_ID });
      });
    }
  });
});
