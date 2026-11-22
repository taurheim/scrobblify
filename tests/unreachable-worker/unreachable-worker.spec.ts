import {
  test, expect, Page, Route,
} from '@playwright/test';
import path from 'path';
import JSZip from 'jszip';
import { interceptLastFm, mockLastFmAuth, routeLastFmSignIn } from '../lastfmMock';
import {
  interceptBackgroundWorker, MockWorker, MAX_TRACKS,
} from '../backgroundMock';

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
  const OFFER = 'text=Let Scrobblify scrobble for me >> visible=true';

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
    await expect(dialog.locator('.v-card-title')).toHaveText('3,000 plays');
    await expect(dialog).toContainText('This will take 5 days to scrobble.');
    await expect(dialog).toContainText('will not have the correct date');
    await expect(dialog.locator('button:has-text("Let Scrobblify scrobble for me")')).toBeVisible();
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
    await expect(dialog.locator('.v-card-title')).toHaveText('42,001 plays');
    await expect(dialog).toContainText('This will take 61 days to scrobble.');
    await expect(dialog.locator('.choice-over60')).toContainText('more than 60 days of scrobbling');
  });

  test('a resume of under 60 days has no such warning', async ({ page }) => {
    const { workerCalls } = await openUploadStep(page, WILLING_WORKER, { 'scrobblify.background.beta': '1' });
    await expect.poll(() => workerCalls.includes('/scrobblify/capacity')).toBe(true);
    await page.locator('.drop-zone input[type="file"]').setInputFiles(largeProgressFile(false, 41000));

    const dialog = page.locator('.background-offer');
    await expect(dialog).toBeVisible({ timeout: 30000 });
    await expect(dialog.locator('.v-card-title')).toHaveText('41,000 plays');
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
    }, { 'scrobblify.background.beta': '1', 'scrobblify.background.session': 's-1' });
    await expect.poll(() => workerCalls.includes('/scrobblify/capacity')).toBe(true);
    await expect(page.locator('text=Your background import has finished')).toBeVisible({ timeout: 15000 });
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

test.describe('Choosing the server in the confirm dialog', () => {
  const JOB_BANNER = 'text=Scrobblify is finishing your import in the background.';
  const HANDED_OVER_KEY = 'scrobblify.background.handedOverImport';

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

    await expect(dialog.locator('.v-card-title')).toHaveText('800 plays');
    await expect(dialog.locator('.scrobble-estimate')).toHaveCount(0);
    await expect(dialog.locator('.choice-dates')).toHaveCount(0);
    await expect(dialog.locator('button:has-text("Start scrobbling")')).toHaveCount(0);
    await expect.poll(() => events.filter((e) => e.name === 'background_offer_shown').map((e) => e.props))
      .toContainEqual(expect.objectContaining({ entry_point: 'confirm', track_count: 800 }));
    await dialog.locator('button:has-text("Let Scrobblify scrobble for me")').click();

    await expect(page.locator(JOB_BANNER)).toBeVisible({ timeout: 20000 });
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
    await expect(page.locator('text=Currently authenticated as')).toHaveCount(0);
  });

  test('"scrobble locally" signs in to Last.fm here and lands ready to send', async ({ page, baseURL }) => {
    const events = captureEvents(page);
    const { scrobbles, preflights } = await openWithWorker(page, baseURL);
    const dialog = await chooseRecentPlays(page, 800);
    await expect(dialog.locator('.v-card-title')).toHaveText('800 plays');
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

  test('a selection under a day\'s cap gets the plain dialog', async ({ page, baseURL }) => {
    await openWithWorker(page, baseURL);
    const dialog = await chooseRecentPlays(page, 700);
    await expect(dialog.locator('.v-card-title')).toHaveText('Scrobble 700 tracks?');
    await expect(dialog.locator('button:has-text("Start scrobbling")')).toBeVisible();
    await expect(dialog.locator('text=Let Scrobblify scrobble for me')).toHaveCount(0);
  });

  test('outside the beta the dialog is the plain one', async ({ page, baseURL }) => {
    await openWithWorker(page, baseURL, { beta: false });
    const dialog = await chooseRecentPlays(page, 800);
    await expect(dialog.locator('.v-card-title')).toHaveText('Scrobble 800 tracks?');
    await expect(dialog.locator('button:has-text("Start scrobbling")')).toBeVisible();
    await expect(dialog.locator('text=Let Scrobblify scrobble for me')).toHaveCount(0);
  });

  test('a full server gets the plain dialog', async ({ page, baseURL }) => {
    await openWithWorker(page, baseURL, { worker: { capacityAvailable: false } });
    const dialog = await chooseRecentPlays(page, 800);
    await expect(dialog.locator('.v-card-title')).toHaveText('Scrobble 800 tracks?');
    await expect(dialog.locator('text=Let Scrobblify scrobble for me')).toHaveCount(0);
  });

  test('saved progress is asked about first, and "Start over" goes on to the choice', async ({ page, baseURL }) => {
    await openWithWorker(page, baseURL, { saved: SAVED });
    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    const dialog = await chooseRecentPlays(page, 800);

    await expect(dialog.locator('.saved-progress-warning')).toContainText('3 of 5 tracks scrobbled');
    await expect(dialog.locator('text=Let Scrobblify scrobble for me')).toHaveCount(0);
    await dialog.locator('button:has-text("Start over")').click();

    await expect(dialog.locator('.v-card-title')).toHaveText('800 plays');
    await expect(dialog.locator('.saved-progress-warning')).toHaveCount(0);
    await expect(dialog.locator('button:has-text("Let Scrobblify scrobble for me")')).toBeVisible();
  });

  test('a signed-in user\'s handoff names them', async ({ page, baseURL }) => {
    const { scrobbles, preflights } = await openWithWorker(page, baseURL, { signedIn: true });
    const dialog = await chooseRecentPlays(page, 800);
    await expect(dialog.locator('.v-card-title')).toHaveText('800 plays');
    await dialog.locator('button:has-text("Let Scrobblify scrobble for me")').click();

    await expect(page.locator(JOB_BANNER)).toBeVisible({ timeout: 20000 });
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
    await expect(dialog.locator('.v-card-title')).toHaveText('800 plays');
    await dialog.locator('button:has-text("Let Scrobblify scrobble for me")').click();

    await expect(page.locator('text=You already have an import running on Scrobblify.')).toBeVisible({ timeout: 20000 });
    const signIn = page.locator('button:has-text("Sign in to see it")');
    await expect(signIn).toBeVisible();
    // The selection is kept for later, and nothing is left frozen.
    await expect(page.locator('text=Resume previous session?')).toBeVisible();
    await expect(page.locator('text=A handover')).toHaveCount(0);
    expect(scrobbles).toEqual([]);

    // With no username anywhere, signing in to the worker finds the job.
    await signIn.click();
    await expect(page.locator(JOB_BANNER)).toBeVisible({ timeout: 20000 });
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
    await expect(dialog.locator('.v-card-title')).toHaveText('800 plays');
    await expect(dialog.locator('.choice-dates')).toBeVisible();
  });

  test('a handover that fails before leaving can be tried again', async ({ page, baseURL }) => {
    const { mock, scrobbles, preflights } = await openWithWorker(page, baseURL);
    let dialog = await chooseRecentPlays(page, 800);
    await expect(dialog.locator('.v-card-title')).toHaveText('800 plays');
    // Full between the probe and the click.
    mock.world.capacityAvailable = false;
    await dialog.locator('button:has-text("Let Scrobblify scrobble for me")').click();
    await expect(page.locator('text=The background service is full right now')).toBeVisible({ timeout: 10000 });
    expect(preflights).toEqual([]);

    mock.world.capacityAvailable = true;
    await page.locator('button:has-text("Scrobble 800 selected tracks")').click();
    dialog = page.locator('.scrobble-confirm');
    await expect(dialog.locator('.saved-progress-warning')).toContainText('0 of 800 tracks scrobbled');
    await dialog.locator('button:has-text("Start over")').click();
    await dialog.locator('button:has-text("Let Scrobblify scrobble for me")').click();

    await expect(page.locator(JOB_BANNER)).toBeVisible({ timeout: 20000 });
    await expect(page.locator('text=would be replaced')).toHaveCount(0);
    expect(preflights).toHaveLength(1);
    expect(scrobbles).toEqual([]);
  });

  /*
    Nobody approved it, so the worker still counts the handoff as on its way
    (`pending`) until it is reaped an hour later, as the mock does too (#162).
    Signed in, the page load then also asks about the queue by its user.
  */
  for (const signedIn of [false, true]) {
    test(`going back from Last.fm without approving keeps the selection, after a refresh too (${signedIn ? 'signed in' : 'signed out'})`, async ({ page, baseURL }) => {
      const { scrobbles, preflights, mock } = await openWithWorker(page, baseURL, { signedIn });
      // Last.fm's page, where the user changes their mind. Registered after the
      // mock: later routes win.
      await page.route(`${new URL(baseURL || 'http://localhost:8471').origin}/mock-auth*`, (route: Route) => route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: '<!doctype html><title>Last.fm</title><h1>Allow access?</h1>',
      }));
      const dialog = await chooseRecentPlays(page, 800);
      await dialog.locator('button:has-text("Let Scrobblify scrobble for me")').click();
      await expect(page.locator('h1:has-text("Allow access?")')).toBeVisible({ timeout: 15000 });
      expect(preflights).toHaveLength(1);
      const importId = String(preflights[0].importId || '');
      const lookup = JSON.parse(mock.handle('GET', `/scrobblify/import/${importId}`, new URLSearchParams(), '').body);
      expect(lookup).toMatchObject({ known: true, pending: true });

      await page.goBack();
      await expectSelectionOffered(page);
      await page.reload();
      await expectSelectionOffered(page);
      // The abandoned handoff can't come back into this browser.
      expect(await page.evaluate((key) => localStorage.getItem(key), PREFLIGHTED_KEY)).toBeNull();
      if (!signedIn) {
        // Signing in afterwards asks about the queue too, and gets the same answer.
        await mockLastFmAuth(page);
        await page.reload();
        await expectSelectionOffered(page);
      }
      expect(scrobbles).toEqual([]);
    });
  }

  test('a page restored from the back-forward cache asks about the queue, not a session', async ({ page, baseURL }) => {
    const importId = 'f1f2f3f4f5f6f7f8f9f0e1e2e3e4e5e6';
    const { mock } = await openWithWorker(page, baseURL, {
      saved: { ...SAVED, importId },
    });
    // Still waiting at the worker for an approval that never came.
    mock.world.handoffs.set('h-mine', {
      state: 'issued',
      named: false,
      username: '',
      trackCount: 5,
      importId,
      chunksSeen: new Set(),
      session: '',
      jobId: '',
    });
    await expect(page.locator(RESUME_PROMPT)).toBeVisible({ timeout: 10000 });
    // The page as it was when it left for Last.fm: frozen for the handoff it
    // preflighted, busy, the selection saved but not on offer.
    await page.evaluate(async ([ownerKey, preflightedKey]) => {
      localStorage.setItem(preflightedKey, 'h-mine');
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
      await dialog.locator('button:has-text("Let Scrobblify scrobble for me")').click();

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
      await expect(page.locator(JOB_BANNER)).toBeVisible({ timeout: 20000 });
      return page.evaluate((key) => ({
        user: localStorage.getItem('scrobblifyLfmUserName'),
        key: localStorage.getItem('scrobblifyLfmAuthKey'),
        handedOver: JSON.parse(localStorage.getItem(key) || '{}'),
      }), HANDED_OVER_KEY);
    }

    test('is remembered by a browser that knew nobody', async ({ page, baseURL }) => {
      const stored = await openReturning(page, baseURL);
      expect(stored.user).toBe('testuser');
      expect(stored.key).toBeNull();
      expect(stored.handedOver).toMatchObject({ importId: IMPORT_ID, username: 'testuser' });
    });

    test('does not replace a different user this browser already knows', async ({ page, baseURL }) => {
      const stored = await openReturning(page, baseURL, { scrobblifyLfmUserName: 'someoneelse' });
      expect(stored.user).toBe('someoneelse');
      // The job is the account's that authorised it.
      expect(stored.handedOver).toMatchObject({ importId: IMPORT_ID, username: 'testuser' });
    });
  });
});
