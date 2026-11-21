import {
  test, expect, Locator, Page, Route,
} from '@playwright/test';
import fs from 'fs';
import path from 'path';
import JSZip from 'jszip';
import LastFm from '../src/api/LastFm';
import Scrobble from '../src/models/Scrobble';
// Shared Last.fm mock, also used by the `npm run dev:mock` interactive script.
import {
  interceptLastFm, mockLastFmAuth, MockLibrary,
} from './lastfmMock';

const FIXTURE_ZIP = path.resolve(__dirname, 'fixtures', 'test-spotify-data.zip');

// public/index.html pulls stylesheets from Google Fonts and jsDelivr, and
// page.goto() waits for `load`, which waits for them. A slow CDN from the CI
// runner then times out whichever test happens to be navigating. No test
// depends on fonts or icons, so serve them empty.
const THIRD_PARTY_ASSETS = /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net)\//;
test.beforeEach(async ({ context }) => {
  await context.route(THIRD_PARTY_ASSETS, (route) => route.fulfill({
    status: 200,
    contentType: 'text/css',
    body: '',
  }));
});

// Opens /scrobble already signed in, at the upload step
async function goToUploadStep(page: Page): Promise<MockLibrary> {
  const library = await interceptLastFm(page);
  // Navigate first to establish origin for localStorage
  await page.goto('/#/scrobble');
  await mockLastFmAuth(page);
  // Reload so init() re-reads from localStorage
  await page.reload();
  // Auth step should auto-complete since we're "authenticated"
  await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
  return library;
}

// Stands in for Last.fm's authorize page: sends the browser straight back to
// the app's callback with a fresh token, which `interceptLastFm` exchanges for
// user `testuser`.
async function routeLastFmSignIn(page: Page) {
  await page.route('https://www.last.fm/api/auth/**', (route) => route.fulfill({
    status: 302,
    // Absolute: a relative location would resolve against www.last.fm.
    headers: {
      location: `${new URL(page.url()).origin}/#/scrobble?token=t-${Math.random().toString(16).slice(2, 10)}`,
    },
  }));
}

// The scrobble button opens a confirmation with a time estimate; starting
// needs the dialog's own button.
async function scrobbleSelection(page: Page) {
  await page.locator('button:has-text("selected tracks")').click();
  await page.locator('.scrobble-confirm button:has-text("Start scrobbling")').click();
}

// Builds a ZIP in-memory so each test can decide exactly what the history
// files hold, without checking another binary fixture into the repo.
async function makeZip(files: Record<string, string>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(`Spotify Extended Streaming History/${name}`, content);
  }
  return zip.generateAsync({ type: 'nodebuffer' });
}

function play(track: string, artist: string, ts: string) {
  return {
    ts,
    master_metadata_track_name: track,
    master_metadata_album_artist_name: artist,
    master_metadata_album_album_name: 'An Album',
    ms_played: 300000,
  };
}

async function uploadZip(page: Page, buffer: Buffer) {
  await page.locator('.drop-zone input[type="file"]').setInputFiles({
    name: 'my_spotify_data.zip',
    mimeType: 'application/zip',
    buffer,
  });
}

type Tracked = { name: string; props: Record<string, unknown> };

// What `trackEvent` would have sent, read from its dev-build console echo:
// nothing is captured from localhost, so this is the only place it shows.
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

// Writes a saved session straight into IndexedDB, which is exactly what
// `StateManager.saveState` produces. Lets the resume path be exercised
// without first having to drive a real pause.
async function seedSavedState(page: Page, state: Record<string, unknown>) {
  await page.evaluate(async (savedState) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('scrobblify', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('scrobbleState')) {
          db.createObjectStore('scrobbleState');
        }
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('scrobbleState', 'readwrite');
        tx.objectStore('scrobbleState').put(savedState, 'current');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      };
      request.onerror = () => reject(request.error);
    });
  }, state);
}

async function readSavedState(page: Page): Promise<Record<string, any> | null> {
  return page.evaluate(() => new Promise<Record<string, any> | null>((resolve, reject) => {
    const request = indexedDB.open('scrobblify', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('scrobbleState')) {
        db.createObjectStore('scrobbleState');
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

test.describe('Home Page', () => {
  test('a first visit offers two equal choices and a way back in', async ({ page }) => {
    const events = captureEvents(page);
    await page.goto('/#/');
    await expect(page.locator('h1')).toHaveText('Retroactively scrobble Spotify plays to last.fm');
    await expect(page.locator('text=Already got your streaming history zip?')).toBeVisible();
    await expect(page.locator("text=Don't have it yet?")).toBeVisible();
    await expect(page.locator('text=Already scrobbling on scrobblify?')).toBeVisible();

    await page.locator('.home-card:has-text("Already got your") button:has-text("Start")').click();
    await expect(page).toHaveURL(/#\/scrobble/);
    await expect.poll(() => events).toContainEqual({ name: 'home_choice', props: { choice: 'have_export' } });
  });

  test('"Show me how" swaps the choices for the steps, and Back brings them back', async ({ page }) => {
    const events = captureEvents(page);
    await page.goto('/#/');
    await page.locator('button:has-text("Show me how")').click();

    await expect(page.locator('h2:has-text("Get your history from Spotify")')).toBeVisible();
    await expect(page.locator('.get-export li')).toHaveCount(3);
    await expect(page.locator('.get-export a[href="https://www.spotify.com/account/privacy/"]')).toBeVisible();
    await expect(page.locator('.home-card')).toHaveCount(0);
    await expect.poll(() => events).toContainEqual({ name: 'home_choice', props: { choice: 'get_export' } });

    await page.locator('.get-export-back').click();
    await expect(page.locator('.home-card')).toHaveCount(2);
  });

  test('"Re-connect to last.fm" signs in and opens the scrobble page', async ({ page }) => {
    const events = captureEvents(page);
    await interceptLastFm(page);
    await routeLastFmSignIn(page);
    await page.goto('/#/');
    await page.locator('button:has-text("Re-connect to last.fm")').click();
    await expect(page.locator('text=Currently authenticated as: testuser')).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(/\/#\/scrobble$/);
    expect(events).toContainEqual({ name: 'home_choice', props: { choice: 'resume' } });
    expect(events).toContainEqual({ name: 'sign_in_started', props: { intent: 'reconnect' } });
  });

  test('"Re-connect to last.fm" when already signed in just opens the scrobble page', async ({ page }) => {
    const events = captureEvents(page);
    await interceptLastFm(page);
    await page.goto('/#/');
    await mockLastFmAuth(page);
    // Nothing saved, so a stored session alone shows the returning card;
    // dismissed for the tab, which keeps the session.
    await page.evaluate(() => sessionStorage.setItem('scrobblify.home.dismissedReturning', '1'));
    await page.reload();
    await page.locator('button:has-text("Re-connect to last.fm")').click();
    await expect(page).toHaveURL(/#\/scrobble/);
    await expect(page.locator('text=Currently authenticated as: testuser')).toBeVisible({ timeout: 10000 });
    expect(events).toContainEqual({ name: 'home_choice', props: { choice: 'resume' } });
    expect(events.filter((e) => e.name === 'sign_in_started')).toEqual([]);
  });

  test('has navigation links', async ({ page }) => {
    await page.goto('/');
    // Should have a link to scrobble
    await expect(page.locator('a[href*="scrobble"]').first()).toBeVisible();
  });

  test('footer exposes the build commit and number on hover', async ({ page }) => {
    await page.goto('/');
    const footer = page.locator('#site-footer');
    await expect(footer).toContainText('built by Niko Savas');
    await expect(footer.locator('span[title]')).toHaveAttribute(
      'title',
      /^([0-9a-f]{7}|dev) · Build (\d+|local)$/,
    );
  });

  test('shows no BETA tag in a build without a worker, even with ?beta=1', async ({ page }) => {
    await page.goto('/?beta=1#/');
    await expect(page.locator('#logo')).toBeVisible();
    await expect(page.locator('#logo .beta-tag')).toHaveCount(0);
  });

  const SAVED = {
    userName: 'testuser',
    totalTracks: 5,
    completedIndices: [0, 1, 2],
    failedIndices: [],
    tracks: [1, 2, 3, 4, 5].map((n) => ({
      track: `Track ${n}`, artist: `Artist ${n}`, album: `Album ${n}`, timestamp: Date.UTC(2024, 0, n),
    })),
    originalTotalTracks: 5,
    originalSucceededCount: 3,
    sendTimestamps: [],
    burstCount: 0,
    dailyCount: 0,
    dailyCountDate: new Date().toISOString().split('T')[0],
    savedAt: new Date().toISOString(),
  };

  test('a visitor with saved progress gets a welcome-back card instead', async ({ page }) => {
    const events = captureEvents(page);
    await page.goto('/#/');
    await page.evaluate(() => localStorage.setItem('scrobblifyLfmUserName', 'testuser'));
    await seedSavedState(page, SAVED);
    await page.reload();

    const card = page.locator('.returning-card');
    await expect(card.locator('.v-card-title')).toHaveText('Scrobbling to testuser');
    await expect(card.locator('.returning-bar')).toContainText('3 / 5 · 60%');
    await expect(card.locator('.returning-links')).toHaveText(/^\s*Not you\?\s+·\s+Start over\s*$/);
    await expect(page.locator('.home-card')).toHaveCount(0);
    await expect.poll(() => events).toContainEqual({ name: 'home_returning_shown', props: { state: 'saved_signed_out' } });
  });

  test('Continue on saved progress while signed out signs in and resumes', async ({ page }) => {
    const events = captureEvents(page);
    await interceptLastFm(page);
    await routeLastFmSignIn(page);
    await page.goto('/#/');
    await page.evaluate(() => localStorage.setItem('scrobblifyLfmUserName', 'testuser'));
    await seedSavedState(page, SAVED);
    await page.reload();

    await page.locator('.returning-card button:has-text("Continue")').click();
    await expect(page.locator('text=Currently authenticated as: testuser')).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(/\/#\/scrobble$/);
    await expect(page.getByRole('button', { name: 'Scrobble', exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=2 tracks ready to scrobble')).toBeVisible();
    await expect(page.locator('text=Resume previous session')).toHaveCount(0);
    expect(events).toContainEqual({ name: 'sign_in_started', props: { intent: 'resume' } });
  });

  test('a signed-in visitor with saved progress is reported as such', async ({ page }) => {
    const events = captureEvents(page);
    await interceptLastFm(page);
    await page.goto('/#/');
    await mockLastFmAuth(page);
    await seedSavedState(page, SAVED);
    await page.reload();
    await expect(page.locator('.returning-card')).toBeVisible();
    await expect.poll(() => events).toContainEqual({ name: 'home_returning_shown', props: { state: 'saved_signed_in' } });

    // Already signed in: straight to the resume prompt, no Last.fm round trip.
    await page.locator('.returning-card button:has-text("Continue")').click();
    await expect(page).toHaveURL(/#\/scrobble/);
    await expect(page.locator('text=Resume previous session')).toBeVisible({ timeout: 10000 });
    expect(events.filter((e) => e.name === 'sign_in_started')).toEqual([]);
  });

  test('"Not you?" on saved progress signs out and shows the first visit, keeping the progress', async ({ page }) => {
    await page.goto('/#/');
    await mockLastFmAuth(page);
    await seedSavedState(page, SAVED);
    await page.reload();
    await page.locator('.returning-card button:has-text("Not you?")').click();
    await expect(page.locator('.home-card')).toHaveCount(2);
    expect(await page.evaluate(() => localStorage.getItem('scrobblifyLfmUserName'))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('scrobblifyLfmAuthKey'))).toBeNull();
    expect(await readSavedState(page)).not.toBeNull();

    // The dismissal lasts for the tab, not just this mount of Home.
    await page.goto('/#/about');
    await expect(page.locator('body')).toContainText('Scrobblify');
    await page.goto('/#/');
    await expect(page.locator('.home-card')).toHaveCount(2);
    await expect(page.locator('.returning-card')).toHaveCount(0);
  });

  test('"Not you?" on someone else\'s saved progress keeps the stored user signed in', async ({ page }) => {
    await page.goto('/#/');
    await mockLastFmAuth(page);
    await seedSavedState(page, { ...SAVED, userName: 'alice' });
    await page.reload();

    const card = page.locator('.returning-card');
    await expect(card.locator('.v-card-title')).toHaveText('Scrobbling to alice');
    await card.locator('button:has-text("Not you?")').click();
    await expect(page.locator('.home-card')).toHaveCount(2);
    expect(await page.evaluate(() => localStorage.getItem('scrobblifyLfmUserName'))).toBe('testuser');
    expect(await page.evaluate(() => localStorage.getItem('scrobblifyLfmAuthKey'))).not.toBeNull();
  });

  test('a remembered username with nothing saved is offered an upload, and "Not you?" forgets it', async ({ page }) => {
    const events = captureEvents(page);
    await page.goto('/#/');
    await page.evaluate(() => localStorage.setItem('scrobblifyLfmUserName', 'testuser'));
    await page.reload();

    const card = page.locator('.returning-card');
    await expect(card.locator('.v-card-title')).toHaveText('Scrobbling to testuser');
    await expect(card.locator('.returning-bar')).toHaveCount(0);
    await expect(card.locator('button:has-text("Upload Spotify zip")')).toBeVisible();
    await expect.poll(() => events).toContainEqual({ name: 'home_returning_shown', props: { state: 'username_only' } });

    await card.locator('button:has-text("Not you?")').click();
    await expect(page.locator('.home-card')).toHaveCount(2);
    expect(await page.evaluate(() => localStorage.getItem('scrobblifyLfmUserName'))).toBeNull();
  });

  test('a fresh Last.fm sign-in brings back a card dismissed with "Not you?"', async ({ page }) => {
    await interceptLastFm(page);
    await page.goto('/#/');
    await page.evaluate(() => localStorage.setItem('scrobblifyLfmUserName', 'testuser'));
    await page.reload();
    await page.locator('.returning-card button:has-text("Not you?")').click();
    await expect(page.locator('.home-card')).toHaveCount(2);

    await page.goto('/#/scrobble?token=fresh-token');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('scrobblifyLfmAuthKey'))).not.toBeNull();
    await expect.poll(() => page.evaluate(() => sessionStorage.getItem('scrobblify.home.dismissedReturning'))).toBeNull();
    await page.goto('/#/');
    await expect(page.locator('.returning-card')).toBeVisible();
  });

  test('"Show me how" on the returning card opens the steps', async ({ page }) => {
    await page.goto('/#/');
    await page.evaluate(() => localStorage.setItem('scrobblifyLfmUserName', 'testuser'));
    await page.reload();
    await page.locator('.returning-card button:has-text("Show me how")').click();
    await expect(page.locator('h2:has-text("Get your history from Spotify")')).toBeVisible();
  });
});

test.describe('About Page', () => {
  test('renders about page', async ({ page }) => {
    await page.goto('/#/about');
    await expect(page.locator('body')).toContainText('Scrobblify');
  });

  test('answers questions in a collapsible FAQ, with ListenBrainz one click away', async ({ page }) => {
    const events = captureEvents(page);
    await page.context().route('https://listenbrainz.org/**', (route) => route.fulfill({ status: 200, body: '' }));
    await page.goto('/#/about');

    await expect(page.locator('.about')).toContainText('buy me a coffee');
    await expect(page.locator('.about-faq .v-expansion-panel')).toHaveCount(4);
    const dates = page.locator('.about-faq .v-expansion-panel:has-text("Why do old plays get today\'s date?")');
    await expect(dates.locator('.v-expansion-panel-text__wrapper')).toBeHidden();
    await dates.locator('.v-expansion-panel-title').click();
    await expect(dates).toContainText('Last.fm only accepts plays from the last two weeks');

    const popup = page.waitForEvent('popup');
    await dates.locator('a:has-text("ListenBrainz")').click();
    await popup;
    await expect.poll(() => events).toContainEqual({ name: 'listenbrainz_clicked', props: { source: 'about' } });

    await expect(page.locator('.about h2:has-text("Who built Scrobblify?")')).toBeVisible();
    await expect(page.locator('.about h2:has-text("Contribute")')).toBeVisible();
    await expect(page.locator('text=Support Scrobblify')).toHaveCount(0);
  });

  // A deleted chunk from an older build: the server answers with HTML (or 404).
  async function failAboutChunk(page: Page, failures: number) {
    const requests = { count: 0 };
    await page.route('**/js/about*.js', (route) => {
      requests.count += 1;
      if (requests.count <= failures) {
        return route.fulfill({ status: 404, contentType: 'text/html', body: '<!DOCTYPE html>' });
      }
      return route.continue();
    });
    return requests;
  }

  test('reloads once when a lazy route chunk fails to load', async ({ page }) => {
    const requests = await failAboutChunk(page, 1);
    await page.goto('/#/');
    await page.evaluate(() => { window.location.hash = '#/about'; });
    await expect(page.locator('.about h1').first()).toHaveText('About', { timeout: 10000 });
    expect(requests.count).toBe(2);
  });

  test('does not reload-loop when the chunk is missing again', async ({ page }) => {
    const requests = await failAboutChunk(page, Infinity);
    await page.goto('/#/');
    await page.evaluate(() => { window.location.hash = '#/about'; });
    await expect.poll(() => requests.count, { timeout: 10000 }).toBe(2);
    await page.waitForTimeout(1500);
    expect(requests.count).toBe(2);
    await expect(page.locator('.about')).toHaveCount(0);
  });
});

test.describe('Scrobble Page - Authentication Step', () => {
  test('a signed-out visitor starts at upload, with no sign-in step', async ({ page }) => {
    await interceptLastFm(page);
    await page.goto('/#/scrobble');
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Authenticate with last.fm')).toHaveCount(0);
    await expect(page.locator('h1:has-text("Authorize")')).toHaveCount(0);
    await expect(page.locator('text=Currently authenticated as')).toHaveCount(0);
  });

  test('a signed-in visitor starts at upload with their name shown', async ({ page }) => {
    await interceptLastFm(page);
    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await page.reload();
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Currently authenticated as: testuser')).toBeVisible();
  });

  test('does not re-exchange a single-use token when the callback URL is revisited', async ({ page }) => {
    // Regression: Last.fm auth tokens are single-use. If the callback URL is
    // re-loaded while it still carries the token (in-flight refresh, browser
    // restoring the tab, duplicate load), the consumed token must NOT be sent to
    // auth.getSession again — Last.fm rejects re-use with error 4 "Unauthorized
    // Token - This token has not been issued".
    let getSessionCount = 0;
    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(new URL(route.request().url()).search);
      if (params.get('method') === 'auth.getSession') {
        getSessionCount++;
      }
      await route.fallback();
    });

    await page.goto('/#/scrobble?token=single-use-token');
    await expect(page.locator('text=Currently authenticated as: testuser')).toBeVisible({ timeout: 10000 });
    expect(getSessionCount).toBe(1);

    // Revisit the callback URL with the same token still present. A real load:
    // a hash-only change would reuse the page and never run init() again.
    await page.goto('about:blank');
    await page.goto('/#/scrobble?token=single-use-token');
    // The header only shows once init() has settled, and a re-exchange would
    // have been sent (and answered) before that.
    await expect(page.locator('text=Currently authenticated as: testuser')).toBeVisible({ timeout: 10000 });
    expect(getSessionCount).toBe(1);
  });

  test('shows a recovery prompt when the auth token is already used or expired', async ({ page }) => {
    // Regression: a single-use token can be consumed before the user (link
    // scanner / preview bot / prefetch) or simply expire. auth.getSession then
    // returns error 4. Instead of a generic failure, the user should get a clear
    // "authorize again" recovery path with a fresh authorize link.
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(new URL(route.request().url()).search);
      if (params.get('method') === 'auth.getSession') {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({
            error: 4,
            message: 'Unauthorized Token - This token has not been issued.',
          }),
        });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
    });

    await page.goto('/#/scrobble?token=dead-token');
    await expect(page.locator('text=/already used or has expired/i')).toBeVisible({ timeout: 10000 });
    // Recovery affordance points back at the Last.fm authorize flow.
    await expect(page.locator('a:has-text("Authorize again")')).toHaveAttribute('href', /last\.fm\/api\/auth/);
  });
});

test.describe('Signing in after choosing', () => {
  // Every `track.scrobble` sent, by track name.
  async function recordScrobbleRequests(page: Page): Promise<string[]> {
    const scrobbles: string[] = [];
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
    return scrobbles;
  }

  async function chooseAll(page: Page): Promise<number> {
    await page.locator('.upload-step button:has-text("Choose which tracks to scrobble")').click({ timeout: 30000 });
    await page.locator('button:has-text("matching")').click();
    const label = await page.locator('button:has-text("selected tracks")').innerText();
    return Number((label.match(/(\d+) selected tracks/i) || [])[1]);
  }

  test('a signed-out visitor chooses tracks, signs in, and lands ready to send', async ({ page }) => {
    await interceptLastFm(page);
    const scrobbles = await recordScrobbleRequests(page);
    // Holds the token exchange back until the test has looked at the moment
    // between landing and being signed in.
    let releaseExchange!: () => void;
    const exchangeGate = new Promise<void>((resolve) => { releaseExchange = resolve; });
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      if (new URL(route.request().url()).searchParams.get('method') === 'auth.getSession') {
        await exchangeGate;
      }
      await route.fallback();
    });
    await routeLastFmSignIn(page);
    await page.goto('/#/scrobble');
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });

    await page.locator('.drop-zone input[type="file"]').setInputFiles(FIXTURE_ZIP);
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();
    const selected = await chooseAll(page);
    expect(selected).toBeGreaterThan(0);
    await scrobbleSelection(page);

    // The selection waiting to be sent is not "a previous session". Looked at
    // once the page has read the saved state and nothing but the hold keeps
    // the resume prompt off it, while the exchange is still held.
    await expect(page.locator('text=Signing in to Last.fm…')).toBeVisible({ timeout: 10000 });
    await expect.poll(() => page.evaluate(() => {
      let inst = (document.querySelector('.auth-handler') as any).__vueParentComponent;
      while (inst && !(inst.data && 'heldForSignIn' in inst.data)) { inst = inst.parent; }
      return inst && inst.data.heldForSignIn && inst.data.hasResumableState && !inst.data.authorityPending;
    }), { timeout: 10000 }).toBe(true);
    await expect(page.locator('text=Resume previous session')).toHaveCount(0);
    releaseExchange();

    await expect(page.locator('text=Currently authenticated as: testuser')).toBeVisible({ timeout: 10000 });
    await expect(page).toHaveURL(/\/#\/scrobble$/);
    const scrobbleButton = page.getByRole('button', { name: 'Scrobble', exact: true });
    await expect(scrobbleButton).toBeVisible({ timeout: 10000 });
    await expect(page.locator(`text=${selected} tracks ready to scrobble`)).toBeVisible();
    await expect(page.locator('text=Resume previous session')).toHaveCount(0);
    const saved = await readSavedState(page);
    expect(saved).not.toBeNull();
    expect(saved!.totalTracks).toBe(selected);
    expect(saved!.completedIndices).toEqual([]);
    expect(scrobbles).toEqual([]);

    await scrobbleButton.click();
    await expect(page.locator('text=Finished scrobbling >> visible=true')).toBeVisible({ timeout: 60000 });
    expect(scrobbles).toHaveLength(selected);
  });

  test('the duplicate check waits for sign-in and then skips plays already on Last.fm', async ({ page }) => {
    const library = await interceptLastFm(page);
    await routeLastFmSignIn(page);
    // Recent plays, so none is re-tagged: the duplicate check skips those.
    const startSec = Math.floor(Date.now() / 1000) - 86400;
    const names = ['Alpha', 'Bravo', 'Charlie', 'Delta'];
    const uts = (i: number) => startSec + i * 600;
    library.add({
      track: 'Alpha', artist: 'Band', album: '', uts: uts(0),
    });
    library.add({
      track: 'Charlie', artist: 'Band', album: '', uts: uts(2),
    });

    await page.goto('/#/scrobble');
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
    await uploadZip(page, await makeZip({
      'Streaming_History_Audio_2024_0.json': JSON.stringify(
        names.map((name, i) => play(name, 'Band', new Date(uts(i) * 1000).toISOString())),
      ),
    }));
    await page.locator('label:has-text("Check for duplicates")').click();
    await page.locator('button:has-text("Find tracks")').click();
    // Nothing to read the history with yet, so no error either.
    await expect(page.locator('text=Duplicates will be checked after you sign in.')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('text=An error occurred while checking for duplicates')).toHaveCount(0);
    expect(await chooseAll(page)).toBe(4);
    await scrobbleSelection(page);

    await expect(page.locator('text=Currently authenticated as: testuser')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Skipped 2 that are already on Last.fm.')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=2 tracks ready to scrobble')).toBeVisible();
    const saved = await readSavedState(page);
    expect(saved!.totalTracks).toBe(2);
    expect(saved!.originalTotalTracks).toBe(2);
    expect(saved!.tracks.map((t: { track: string }) => t.track)).toEqual(['Bravo', 'Delta']);
  });

  // Plays in a fresh ZIP, all recent so none is re-tagged unless asked.
  async function uploadPlays(page: Page, names: string[], uts: (i: number) => number) {
    await uploadZip(page, await makeZip({
      'Streaming_History_Audio_2024_0.json': JSON.stringify(
        names.map((name, i) => play(name, 'Band', new Date(uts(i) * 1000).toISOString())),
      ),
    }));
  }

  test('when every chosen play is already on Last.fm, nothing is restored and the selection is dropped', async ({ page }) => {
    const library = await interceptLastFm(page);
    await routeLastFmSignIn(page);
    const startSec = Math.floor(Date.now() / 1000) - 86400;
    const names = ['Alpha', 'Bravo'];
    const uts = (i: number) => startSec + i * 600;
    names.forEach((track, i) => library.add({
      track, artist: 'Band', album: '', uts: uts(i),
    }));

    await page.goto('/#/scrobble');
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
    await uploadPlays(page, names, uts);
    await page.locator('label:has-text("Check for duplicates")').click();
    await page.locator('button:has-text("Find tracks")').click();
    expect(await chooseAll(page)).toBe(2);
    await scrobbleSelection(page);

    await expect(page.locator('text=Currently authenticated as: testuser')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Skipped 2 that are already on Last.fm.')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.upload-step')).toBeVisible();
    await expect(page.locator('text=tracks ready to scrobble')).toBeHidden();
    await expect(page.locator('text=Resume previous session')).toHaveCount(0);
    expect(await readSavedState(page)).toBeNull();
  });

  test('re-tagged plays are not checked against the history after sign-in', async ({ page }) => {
    const library = await interceptLastFm(page);
    await routeLastFmSignIn(page);
    // Real plays at the very seconds re-tagging is about to give these, which
    // would match if re-tagged plays were checked.
    const nowSec = Math.floor(Date.now() / 1000);
    const names = ['Alpha', 'Bravo', 'Charlie'];
    names.forEach((track, i) => library.add({
      track, artist: 'Band', album: '', uts: nowSec - i,
    }));

    await page.goto('/#/scrobble');
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
    await uploadPlays(page, names, (i) => Date.UTC(2024, 0, i + 1) / 1000);
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('label:has-text("Check for duplicates")').click();
    await page.locator('button:has-text("Find tracks")').click();
    await expect(page.locator('text=Duplicates will be checked after you sign in.')).toBeVisible({ timeout: 30000 });
    expect(await chooseAll(page)).toBe(3);
    await scrobbleSelection(page);

    await expect(page.locator('text=Currently authenticated as: testuser')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=3 tracks ready to scrobble')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.skipped-duplicates')).toHaveCount(0);
    expect((await readSavedState(page))!.totalTracks).toBe(3);
  });

  test('a failed duplicate check after sign-in says so and keeps every play', async ({ page }) => {
    await interceptLastFm(page);
    await routeLastFmSignIn(page);
    const startSec = Math.floor(Date.now() / 1000) - 86400;
    const names = ['Alpha', 'Bravo'];
    const uts = (i: number) => startSec + i * 600;

    await page.goto('/#/scrobble');
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
    await uploadPlays(page, names, uts);
    await page.locator('label:has-text("Check for duplicates")').click();
    await page.locator('button:has-text("Find tracks")').click();
    expect(await chooseAll(page)).toBe(2);
    // Only from here on: the history can't be read once signed in.
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      if (new URL(route.request().url()).searchParams.get('method') === 'user.getrecenttracks') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ error: 8, message: 'Operation failed' }),
        });
        return;
      }
      await route.fallback();
    });
    await scrobbleSelection(page);

    await expect(page.locator('text=An error occurred while checking for duplicates. Proceeding with all tracks.'))
      .toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=2 tracks ready to scrobble')).toBeVisible();
    expect((await readSavedState(page))!.totalTracks).toBe(2);
  });

  test('a sign-in that fails offers the held selection as saved progress', async ({ page }) => {
    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      if (new URL(route.request().url()).searchParams.get('method') === 'auth.getSession') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ error: 4, message: 'Unauthorized Token - This token has not been issued' }),
        });
        return;
      }
      await route.fallback();
    });
    await routeLastFmSignIn(page);
    await page.goto('/#/scrobble');
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
    await page.locator('.drop-zone input[type="file"]').setInputFiles(FIXTURE_ZIP);
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();
    expect(await chooseAll(page)).toBeGreaterThan(0);
    await scrobbleSelection(page);

    await expect(page.locator('text=Your sign-in link was already used or has expired.')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Resume previous session')).toBeVisible({ timeout: 10000 });
  });

  test('a signed-out selection never replaces saved progress it did not ask about', async ({ page }) => {
    await interceptLastFm(page);
    const signInRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith('https://www.last.fm/api/auth')) {
        signInRequests.push(request.url());
      }
    });
    await routeLastFmSignIn(page);
    await page.goto('/#/scrobble');
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
    await page.locator('.drop-zone input[type="file"]').setInputFiles(FIXTURE_ZIP);
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();
    expect(await chooseAll(page)).toBeGreaterThan(0);

    // Another tab saves progress after this one loaded, so this one's
    // confirmation knows nothing about it.
    const other = {
      userName: 'testuser',
      importId: 'other-tab-import',
      totalTracks: 5,
      completedIndices: [0, 1],
      failedIndices: [],
      tracks: Array.from({ length: 5 }, (_, i) => ({
        track: `Track ${i + 1}`, artist: `Artist ${i + 1}`, album: '', timestamp: Date.UTC(2024, 0, i + 1),
      })),
      originalTotalTracks: 5,
      originalSucceededCount: 2,
      sendTimestamps: [],
      burstCount: 0,
      dailyCount: 0,
      dailyCountDate: new Date().toISOString().split('T')[0],
      savedAt: new Date().toISOString(),
    };
    await seedSavedState(page, other);
    await scrobbleSelection(page);

    await expect(page.locator('text=You have saved progress that would be replaced.')).toBeVisible({ timeout: 5000 });
    expect(await readSavedState(page)).toEqual(other);
    expect(signInRequests).toEqual([]);
    await expect(page).toHaveURL(/localhost/);

    // Asked about next time.
    await page.getByRole('button', { name: 'OK', exact: true }).click();
    await page.locator('button:has-text("selected tracks")').click();
    await expect(page.locator('.scrobble-confirm button:has-text("Resume saved progress")')).toBeVisible();
  });
});

test.describe('Upload Step - ZIP Drag & Drop', () => {
  test('shows upload zone when authenticated', async ({ page }) => {
    await goToUploadStep(page);
    await expect(page.locator('.drop-zone')).toBeVisible();
    await expect(page.locator('text=Drag')).toBeVisible();
  });

  test('accepts ZIP file via file picker', async ({ page }) => {
    await goToUploadStep(page);
    const fileInput = page.locator('.drop-zone input[type="file"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);
    await expect(page.locator('text=test-spotify-data.zip')).toBeVisible();
  });

  test('Find tracks button is disabled without file', async ({ page }) => {
    await goToUploadStep(page);
    const btn = page.locator('button:has-text("Find tracks")');
    await expect(btn).toBeDisabled();
  });

  test('Find tracks button is enabled after file selection', async ({ page }) => {
    await goToUploadStep(page);
    const fileInput = page.locator('.drop-zone input[type="file"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);
    const btn = page.locator('button:has-text("Find tracks")');
    await expect(btn).toBeEnabled();
  });

  test('parses a BOM-prefixed audio file without a JSON error', async ({ page }) => {
    // Regression: the fixture's first audio file starts with a UTF-8 BOM, which
    // previously caused "JSON Parse error: Unrecognized token ''" in WebKit.
    const pageErrors: string[] = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));

    await goToUploadStep(page);
    const fileInput = page.locator('.drop-zone input[type="file"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);

    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();

    await expect(page.locator('text=5 plays')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=/Failed to parse/i')).toHaveCount(0);
    expect(pageErrors.join('\n')).not.toContain('Unrecognized token');
  });

  test('parses ZIP and shows track count', async ({ page }) => {
    await goToUploadStep(page);
    const fileInput = page.locator('.drop-zone input[type="file"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);

    // Check "scrobble old plays" since our test data is old
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    // Uncheck "follow lfm rules" for speed
    // It's unchecked by default, so we just proceed

    await page.locator('button:has-text("Find tracks")').click();

    // Should show logs about parsing
    await expect(page.locator('text=Found 2 audio history file')).toBeVisible({ timeout: 10000 });
    // 5 entries in file 1 + 1 in file 2, minus 1 podcast = 5 music tracks
    await expect(page.locator('text=5 plays')).toBeVisible({ timeout: 10000 });
  });

  test('filters out podcast entries (null track name)', async ({ page }) => {
    await goToUploadStep(page);
    const fileInput = page.locator('.drop-zone input[type="file"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);

    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();

    // 6 total entries minus 1 podcast = 5 music plays
    await expect(page.locator('text=5 plays')).toBeVisible({ timeout: 10000 });
  });
});

test.describe('Select Step - Track Selection', () => {
  async function goToSelectStep(page: Page) {
    await goToUploadStep(page);
    const fileInput = page.locator('.drop-zone input[type="file"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);

    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();

    // Wait for processing to complete
    await expect(page.locator('.upload-step button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
    await page.locator('.upload-step button:has-text("Choose which tracks to scrobble")').click();

    // Should now be on step 3
    await expect(page.locator('h3:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 5000 });
  }

  test('shows track list with artist and album columns', async ({ page }) => {
    await goToSelectStep(page);
    // Table headers should include Track, Artist, Album
    await expect(page.locator('th:has-text("Track")')).toBeVisible();
    await expect(page.locator('th:has-text("Artist")')).toBeVisible();
    await expect(page.locator('th:has-text("Album")')).toBeVisible();
  });

  test('date filtering reduces matching track count', async ({ page }) => {
    // Go to select step WITHOUT re-tagging old listens so dates remain original
    await goToUploadStep(page);
    const fileInput = page.locator('.drop-zone input[type="file"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);
    // Don't check "Scrobble tracks older than 2 weeks" — keep original dates
    await page.locator('button:has-text("Find tracks")').click();
    await expect(page.locator('.upload-step button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
    await page.locator('.upload-step button:has-text("Choose which tracks to scrobble")').click();
    await expect(page.locator('h3:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 5000 });

    // Without re-tagging, old tracks are filtered out, so we should see 0 tracks
    // (all fixture dates are from 2024, which is >2 weeks ago)
    // Let's test with re-tagging on but verify date range shows
    // Actually, re-do with the checkbox to get tracks, then check filtering
    await goToSelectStep(page);
    // All 5 tracks re-tagged to today — date filter for a future date should filter them
    await expect(page.locator('button:has-text("Add 5 matching")')).toBeVisible();

    // Set from date to tomorrow — should filter out everything
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    await page.locator('input[type="date"]').first().fill(tomorrow);

    await expect(page.locator('button:has-text("Add 0 matching")')).toBeVisible({ timeout: 5000 });
  });

  test('scrobbling asks for confirmation with a time estimate first', async ({ page }) => {
    await goToSelectStep(page);
    await page.locator('button:has-text("matching")').click();
    await page.locator('button:has-text("selected tracks")').click();

    const dialog = page.locator('.scrobble-confirm');
    await expect(dialog).toContainText('Scrobble 5 tracks?');
    await expect(dialog).toContainText('This should take about 5 seconds');

    // Cancelling leaves the selection alone and stays on this step.
    await dialog.locator('button:has-text("Cancel")').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('h3:has-text("Choose which tracks to scrobble")')).toBeVisible();

    await scrobbleSelection(page);
    await expect(page.locator('text=tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
  });

  test('a large backdated import must be acknowledged first, and is told how long it takes', async ({ page }) => {
    const library = await goToUploadStep(page);
    // Last.fm already holds 650 plays for today, leaving 50 of the import's 700.
    const lastSecondToday = Math.floor(Date.now() / 86400000) * 86400 + 86399;
    for (let n = 0; n < 650; n++) {
      library.add({
        track: `Own ${n}`, artist: 'Own', album: '', uts: lastSecondToday,
      });
    }

    // One more than a day's budget, all a year old so every play is re-tagged.
    const count = 701;
    const startMs = Date.now() - 365 * 24 * 60 * 60 * 1000;
    const zip = new JSZip();
    zip.file('Spotify Extended Streaming History/Streaming_History_Audio_2024.json', JSON.stringify(
      Array.from({ length: count }, (_, i) => ({
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
    await expect(page.locator('.upload-step button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });

    // Choosing tracks is blocked until the user has read what a large backdated import means.
    await page.locator('.upload-step button:has-text("Choose which tracks to scrobble")').click();
    const gate = page.locator('.large-history-gate');
    await expect(gate).toContainText('701 of your plays are more than 2 weeks old');
    await expect(gate).toContainText('Scrobbling will take about 2 days');

    // Declining opens ListenBrainz's importer and leaves the user where they were.
    await page.context().route('https://listenbrainz.org/**', (route) => route.fulfill({ status: 200, body: '' }));
    const popup = page.waitForEvent('popup');
    await gate.locator('a:has-text("Use ListenBrainz instead")').click();
    expect((await popup).url()).toBe('https://listenbrainz.org/settings/import/');
    await expect(gate).toBeHidden();
    // The stepper keeps every step in the DOM, so "still here" means hidden, not absent.
    await expect(page.locator('h3:has-text("Choose which tracks to scrobble")')).toBeHidden();
    await expect(page.locator('.upload-step button:has-text("Choose which tracks to scrobble")')).toBeVisible();

    await page.locator('.upload-step button:has-text("Choose which tracks to scrobble")').click();
    await gate.locator('button:has-text("I understand, continue")').click();
    await page.locator('button:has-text("matching")').click();
    await page.locator('button:has-text("selected tracks")').click();

    const dialog = page.locator('.scrobble-confirm');
    // 50 today, then the other 651 at 700 a day: two days, not one.
    await expect(dialog).toContainText('will take 2 days');
    await expect(dialog).toContainText('About 50 go today');

    await dialog.locator('button:has-text("Start scrobbling")').click();
    await expect(page.locator('text=tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Scrobble Step', () => {
  async function goToScrobbleStep(page: Page) {
    await goToUploadStep(page);
    const fileInput = page.locator('.drop-zone input[type="file"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);

    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();

    await expect(page.locator('.upload-step button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
    await page.locator('.upload-step button:has-text("Choose which tracks to scrobble")').click();

    await expect(page.locator('button:has-text("matching")')).toBeVisible({ timeout: 5000 });
    await page.locator('button:has-text("matching")').click();
    await scrobbleSelection(page);

    await expect(page.locator('text=tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
  }

  test('shows track list before scrobbling', async ({ page }) => {
    await goToScrobbleStep(page);
    await expect(page.locator('text=tracks ready to scrobble')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Scrobble', exact: true })).toBeVisible();
  });

  test('scrobbles tracks and shows progress', async ({ page }) => {
    const scrobbleRequests: string[] = [];
    await page.route('https://ws.audioscrobbler.com/**', async (route) => {
      const postData = route.request().postData() || '';
      const allParams = new URLSearchParams(
        route.request().method() === 'POST' ? postData : new URL(route.request().url()).search,
      );
      const apiMethod = allParams.get('method');

      if (apiMethod === 'track.scrobble') {
        scrobbleRequests.push(allParams.get('track%5B0%5D') || allParams.get('track[0]') || '');
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }),
        });
      } else if (apiMethod === 'track.getInfo') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ track: { duration: '240000' } }),
        });
      } else if (apiMethod === 'user.getrecenttracks') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ recenttracks: { track: [] } }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ session: { name: 'testuser', key: 'fake-session-key' } }),
        });
      }
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await page.reload();
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });

    const fileInput = page.locator('.drop-zone input[type="file"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();

    await expect(page.locator('.upload-step button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
    await page.locator('.upload-step button:has-text("Choose which tracks to scrobble")').click();

    await expect(page.locator('button:has-text("matching")')).toBeVisible({ timeout: 5000 });
    await page.locator('button:has-text("matching")').click();
    await scrobbleSelection(page);

    await expect(page.getByRole('button', { name: 'Scrobble', exact: true })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    // Should show scrobbling progress
    await expect(page.locator('text=Scrobbling...')).toBeVisible({ timeout: 10000 });

    // Wait for completion
    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 30000 });

    // Verify scrobble requests were sent
    expect(scrobbleRequests.length).toBeGreaterThan(0);
  });

  test('sends album info in scrobble requests', async ({ page }) => {
    let lastScrobbleBody = '';
    await page.route('https://ws.audioscrobbler.com/**', async (route) => {
      const postData = route.request().postData() || '';
      const allParams = new URLSearchParams(
        route.request().method() === 'POST' ? postData : new URL(route.request().url()).search,
      );
      const apiMethod = allParams.get('method');

      if (apiMethod === 'track.scrobble') {
        lastScrobbleBody = postData;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }),
        });
      } else if (apiMethod === 'track.getInfo') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ track: { duration: '240000' } }),
        });
      } else if (apiMethod === 'user.getrecenttracks') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ recenttracks: { track: [] } }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ session: { name: 'testuser', key: 'fake-session-key' } }),
        });
      }
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await page.reload();
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });

    const fileInput = page.locator('.drop-zone input[type="file"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();

    await expect(page.locator('.upload-step button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
    await page.locator('.upload-step button:has-text("Choose which tracks to scrobble")').click();

    await expect(page.locator('button:has-text("matching")')).toBeVisible({ timeout: 5000 });
    await page.locator('button:has-text("matching")').click();
    await scrobbleSelection(page);

    await expect(page.getByRole('button', { name: 'Scrobble', exact: true })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    // Wait for at least one scrobble
    await expect(page.locator('text=Scrobbling...')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 30000 });

    // Verify album was sent in POST body
    expect(lastScrobbleBody).toContain('album');
  });

  test('scrobbles use POST method with form body', async ({ page }) => {
    let scrobbleMethod = '';
    let scrobbleContentType = '';
    await page.route('https://ws.audioscrobbler.com/**', async (route) => {
      const postData = route.request().postData() || '';
      const allParams = new URLSearchParams(
        route.request().method() === 'POST' ? postData : new URL(route.request().url()).search,
      );
      const apiMethod = allParams.get('method');

      if (apiMethod === 'track.scrobble') {
        scrobbleMethod = route.request().method();
        scrobbleContentType = route.request().headers()['content-type'] || '';
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }),
        });
      } else if (apiMethod === 'track.getInfo') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ track: { duration: '240000' } }),
        });
      } else if (apiMethod === 'user.getrecenttracks') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ recenttracks: { track: [] } }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ session: { name: 'testuser', key: 'fake-session-key' } }),
        });
      }
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await page.reload();
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });

    const fileInput = page.locator('.drop-zone input[type="file"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();

    await expect(page.locator('.upload-step button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
    await page.locator('.upload-step button:has-text("Choose which tracks to scrobble")').click();

    await expect(page.locator('button:has-text("matching")')).toBeVisible({ timeout: 5000 });
    await page.locator('button:has-text("matching")').click();
    await scrobbleSelection(page);

    await expect(page.getByRole('button', { name: 'Scrobble', exact: true })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    /*
      Polled on the captured request rather than gated on page text.

      "Finished scrobbling" lives in the stepper pane for step 5, which Vuetify
      renders up front and merely hides — so `toContainText` against the body
      matches its hidden copy and passes before a single request has left. That
      made this test race the app it was checking: under a full-suite load it
      read `scrobbleMethod` while the loop was still starting up and failed on
      an empty string, which looks exactly like a routing bug and is not one.
    */
    await expect.poll(() => scrobbleMethod, { timeout: 30000 }).toBe('POST');
    expect(scrobbleContentType).toContain('application/x-www-form-urlencoded');
    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 30000 });
  });
});

test.describe('LastFm API client', () => {
  test('uses integer timestamps and redacts secrets in Last.fm API errors', async () => {
    const api = new LastFm('test-api-key', 'test-shared-secret');
    (api as any).userAuthKey = 'fake-session-key';

    const originalFetch = globalThis.fetch;
    let requestBody = '';

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = String(init?.body || '');
      return new Response(JSON.stringify({ error: 11, message: 'Invalid timestamp' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    try {
      let thrownError: Error | null = null;

      try {
        await api.scrobblePlay(new Scrobble(
          'Viva La Vida',
          'Coldplay',
          new Date('2026-07-09T14:29:13.948Z'),
          'Viva La Vida or Death and All His Friends',
        ));
      } catch (error) {
        thrownError = error as Error;
      }

      expect(thrownError).not.toBeNull();
      expect(thrownError!.message).toContain('Last.fm API error 11');
      expect(thrownError!.message).toContain('Invalid timestamp');
      expect(thrownError!.message).toContain('"api_key":"[redacted]"');
      expect(thrownError!.message).toContain('"sk":"[redacted]"');
      expect(thrownError!.message).toContain('"api_sig":"[redacted]"');
      expect(thrownError!.message).toContain('"timestamp[0]":"1783607353"');
      expect(thrownError!.message).not.toContain('test-api-key');
      expect(thrownError!.message).not.toContain('fake-session-key');

      const sentParams = new URLSearchParams(requestBody);
      expect(sentParams.get('timestamp[0]')).toBe('1783607353');
      expect(sentParams.get('album[0]')).toBe('Viva La Vida or Death and All His Friends');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test.describe('Session Resume', () => {
  function buildState(overrides: Record<string, unknown> = {}) {
    const tracks = [1, 2, 3, 4, 5].map((n) => ({
      track: `Track ${n}`,
      artist: `Artist ${n}`,
      album: `Album ${n}`,
      timestamp: Date.UTC(2024, 0, n),
    }));
    return {
      userName: 'testuser',
      totalTracks: 5,
      completedIndices: [0, 1, 2],
      failedIndices: [],
      tracks,
      originalTotalTracks: 5,
      originalSucceededCount: 3,
      sendTimestamps: [],
      burstCount: 0,
      dailyCount: 0,
      dailyCountDate: new Date().toISOString().split('T')[0],
      savedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  test('resuming scrobbles only the remaining tracks', async ({ page }) => {
    const scrobbled: string[] = [];
    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(
        route.request().method() === 'POST'
          ? route.request().postData() || ''
          : new URL(route.request().url()).search,
      );
      if (params.get('method') === 'track.scrobble') {
        scrobbled.push(params.get('track[0]') || '');
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSavedState(page, buildState());
    await page.reload();

    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();

    // Only the 2 not-yet-completed tracks should be queued...
    await expect(page.locator('text=2 tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
    // ...but progress must still be reported against the original import size,
    // not against the shrunken remainder.
    await expect(page.locator('.overall-progress')).toContainText('3 of 5');

    // Let the sign-in handler settle before interacting.
    await expect(page.locator('text=Currently authenticated as')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();
    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 30000 });

    expect(scrobbled).toEqual(['Track 4', 'Track 5']);
  });

  test('resuming immediately is not undone by the sign-in authority check', async ({ page }) => {
    // Regression: AuthenticateStep used to emit `complete` on a 2s setTimeout,
    // and resuming inside that window jumped to the scrobble step and then got
    // dragged back to the upload step, losing the resumed session. The emit is
    // immediate now, and `onAuthenticated` runs the authority check once the
    // mount settles, but it must still never move the stepper.
    await interceptLastFm(page);
    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSavedState(page, buildState());
    await page.reload();

    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.locator('text=2 tracks ready to scrobble')).toBeVisible({ timeout: 5000 });

    // Give the sign-in handler's check time to land, then confirm we're still on the scrobble step.
    await page.waitForTimeout(4000);
    await expect(page.locator('text=2 tracks ready to scrobble')).toBeVisible();
    await expect(page.locator('.upload-step')).toBeHidden();
  });

  // Regression for #102: re-uploading the export and scrobbling from scratch
  // replaced the saved progress on the first save, so the next resume re-sent
  // everything before it.
  async function selectFreshImportOverSavedState(page: Page) {
    await interceptLastFm(page);
    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSavedState(page, buildState());
    await page.reload();
    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });

    await page.locator('.drop-zone input[type="file"]').setInputFiles(FIXTURE_ZIP);
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();
    await page.locator('.upload-step button:has-text("Choose which tracks to scrobble")').click({ timeout: 30000 });
    await page.locator('button:has-text("matching")').click();
    await page.locator('button:has-text("selected tracks")').click();
  }

  test('a fresh import asks before replacing saved progress, and offers to resume it', async ({ page }) => {
    await selectFreshImportOverSavedState(page);

    const dialog = page.locator('.scrobble-confirm');
    await expect(dialog).toContainText('You have saved progress');
    await expect(dialog).toContainText('3 of 5 tracks');
    await expect(dialog.locator('button:has-text("Start scrobbling")')).toHaveCount(0);

    await dialog.locator('button:has-text("Resume saved progress")').click();
    await expect(page.locator('text=2 tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.overall-progress')).toContainText('3 of 5');
    expect((await readSavedState(page))?.completedIndices).toEqual([0, 1, 2]);
  });

  test('a fresh import can still start over once the user chooses to', async ({ page }) => {
    await selectFreshImportOverSavedState(page);

    const dialog = page.locator('.scrobble-confirm');
    await dialog.locator('button:has-text("Start over")').click();
    await expect(page.locator('text=5 tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
  });

  test('a second Last.fm refuses is only re-timed when this browser chose it', async ({ page }) => {
    const sent: number[] = [];
    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(
        route.request().method() === 'POST'
          ? route.request().postData() || ''
          : new URL(route.request().url()).search,
      );
      if (params.get('method') === 'track.scrobble') {
        sent.push(Number(params.get('timestamp[0]') || '0'));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            scrobbles: {
              '@attr': { accepted: 0, ignored: 1 },
              scrobble: { ignoredMessage: { code: '3', '#text': 'Timestamp too old' } },
            },
          }),
        });
        return;
      }
      await route.fallback();
    });

    /*
      A pinned second carried over from a send whose outcome nobody saw — the
      shape a worker take-back produces. Track 4 is the head of the remaining
      queue, so the pin belongs to it.
    */
    const pinSec = Math.floor(Date.now() / 1000) - 13 * 24 * 60 * 60;
    const reTagged = [1, 2, 3, 4, 5].map((n) => ({
      track: `Track ${n}`,
      artist: `Artist ${n}`,
      album: `Album ${n}`,
      timestamp: Date.UTC(2024, 0, n),
      reTagged: true,
    }));

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSavedState(page, buildState({
      tracks: reTagged,
      pendingReTagTimestampSec: pinSec,
    }));
    await page.reload();

    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.locator('text=2 tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    /*
      Three sends, and no more. The pin goes out once and is *not* replaced:
      Last.fm refusing it means the tuple can no longer be stored, not that it
      never was, so a fresh second could put a duplicate on a public profile.
      Track 5's second was chosen here and stored nothing, so it is replaced
      once — and a second refusal stops the run rather than spending the queue
      one track at a time on what is really a wrong clock.
    */
    await expect.poll(() => sent.length, { timeout: 30000 }).toBe(3);
    await page.waitForTimeout(2000);
    expect(sent.length).toBe(3);
    expect(sent[0]).toBe(pinSec);
    expect(sent.filter((s) => s === pinSec)).toHaveLength(1);
    expect(sent[2]).not.toBe(sent[1]);
  });

  test('a second that has already been spent is not handed to the next track', async ({ page }) => {
    const sent: number[] = [];
    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(
        route.request().method() === 'POST'
          ? route.request().postData() || ''
          : new URL(route.request().url()).search,
      );
      if (params.get('method') === 'track.scrobble') {
        sent.push(Number(params.get('timestamp[0]') || '0'));
        // The second send is refused for the day, which stops the run and
        // saves. That is the shortest route to a *second* entry into the send
        // loop, which is the only place the leak was observable.
        const body = sent.length === 2
          ? {
            scrobbles: {
              '@attr': { accepted: 0, ignored: 1 },
              scrobble: { ignoredMessage: { code: '5', '#text': 'Daily scrobble limit exceeded' } },
            },
          }
          : { scrobbles: { '@attr': { accepted: 1, ignored: 0 } } };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
        return;
      }
      await route.fallback();
    });

    const pinSec = Math.floor(Date.now() / 1000) - 13 * 24 * 60 * 60;
    const reTagged = [1, 2, 3, 4, 5].map((n) => ({
      track: `Track ${n}`,
      artist: `Artist ${n}`,
      album: `Album ${n}`,
      timestamp: Date.UTC(2024, 0, n),
      reTagged: true,
    }));

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSavedState(page, buildState({
      tracks: reTagged,
      pendingReTagTimestampSec: pinSec,
    }));
    await page.reload();

    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.locator('text=2 tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    await expect(page.locator('text=daily scrobble limit')).toBeVisible({ timeout: 30000 });
    await expect.poll(() => sent.length, { timeout: 10000 }).toBe(2);

    await page.locator('button:has-text("Try Again Now")').click();
    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 30000 });

    /*
      Track 4 was stored under the restored pin and is done with. The store
      kept that second anyway — and the store is what the next entry into the
      loop reads back, so the second a play was already stored under was
      handed to whichever track was at the head on resume.

      Last.fm keys a scrobble on (user, artist, track, timestamp), so a
      repeated second is only harmless while the two tracks differ. These
      histories are mostly repeats of the same songs, which is the entire
      reason substitute seconds are allocated one at a time in the first place.
    */
    expect(sent.length).toBeGreaterThan(2);
    expect(sent).toContain(pinSec);
    expect(sent.filter((s) => s === pinSec)).toHaveLength(1);
    expect(new Set(sent).size).toBe(sent.length);
  });

  test('a queue saved before identities existed is given one before it sends', async ({ page }) => {
    const journals: (string | null)[] = [];
    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(
        route.request().method() === 'POST'
          ? route.request().postData() || ''
          : new URL(route.request().url()).search,
      );
      if (params.get('method') === 'track.scrobble') {
        // Read while the request is in flight: the record is cleared the
        // moment its track is done with.
        journals.push(await page.evaluate(
          () => window.localStorage.getItem('scrobblify.background.inflightSecond'),
        ));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }),
        });
        return;
      }
      await route.fallback();
    });

    const reTagged = [1, 2, 3, 4, 5].map((n) => ({
      track: `Track ${n}`,
      artist: `Artist ${n}`,
      album: `Album ${n}`,
      timestamp: Date.UTC(2024, 0, n),
      reTagged: true,
    }));

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    // No `importId`: exactly what a progress file written before queue
    // identities existed looks like on disk.
    await seedSavedState(page, buildState({ tracks: reTagged }));
    await page.reload();

    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();
    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 30000 });

    /*
      The journal binds a second to the queue that chose it, and an empty
      identity matches every other empty one — so two id-less queues whose
      heads happened to share a track could trade seconds, which is not a
      missed deduplication but an invented collision. Minting one here is safe
      for the same reason it is safe at handover: a queue with no identity
      cannot have been handed over, so a fresh name takes nothing away.
    */
    expect(journals.length).toBeGreaterThan(0);
    const record = JSON.parse(journals[0] as string)[0];
    expect(record.importId).toBeTruthy();
    expect(record.importId.length).toBeGreaterThanOrEqual(16);
  });

  test('an identity that could not be written to disk is not sent under', async ({ page }) => {
    const sent: number[] = [];
    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(
        route.request().method() === 'POST'
          ? route.request().postData() || ''
          : new URL(route.request().url()).search,
      );
      if (params.get('method') === 'track.scrobble') {
        sent.push(Number(params.get('timestamp[0]') || '0'));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }),
        });
        return;
      }
      await route.fallback();
    });

    const reTagged = [1, 2, 3, 4, 5].map((n) => ({
      track: `Track ${n}`,
      artist: `Artist ${n}`,
      album: `Album ${n}`,
      timestamp: Date.UTC(2024, 0, n),
      reTagged: true,
    }));

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSavedState(page, buildState({ tracks: reTagged }));
    await page.reload();

    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForTimeout(2500);
    // Broken only after the state has been read back, so the queue itself
    // still resumes and only the write fails.
    await page.evaluate(() => {
      // eslint-disable-next-line func-names
      IDBObjectStore.prototype.put = function () { throw new Error('disk full'); };
    });
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    /*
      Minting an identity in memory is not minting one. Every journalled second
      is bound to it, so if the disk never learns the name, the reloaded queue
      cannot claim any of the records written under it: a crash mid-send leaves
      a play at Last.fm whose second is recorded against an import that, as far
      as the disk is concerned, never existed. The resume picks a fresh second
      and duplicates it.

      `autoSave` swallows a failed write — nothing is normally waiting on one —
      so this has to go through the awaitable channel and refuse on failure.
    */
    await expect(page.locator("text=couldn't store data in this browser >> visible=true")).toBeVisible({ timeout: 15000 });
    expect(sent).toHaveLength(0);

    /*
      And the name it could not write is not kept in memory to be trusted next
      time. A retry that finds a non-empty identity accepts it without ever
      attempting the write again, and every second journalled under it names an
      import the disk has never heard of — so a crash mid-send leaves a play at
      Last.fm that the reloaded queue cannot claim, and re-sends it under a
      fresh second. A name only this tab knows is worse than no name at all,
      because no name at least stops the run.
    */
    await page.getByRole('button', { name: /Try Again/ }).first().click();
    await page.waitForTimeout(3000);
    expect(sent).toHaveLength(0);
  });

  test('naming the queue does not erase the second it is already sending under', async ({ page }) => {
    const pinSec = Math.floor(Date.now() / 1000) - 13 * 24 * 60 * 60;
    const diskDuringFirstSend: number[] = [];
    const readDiskPin = () => page.evaluate(async () => new Promise<number>((resolve) => {
      const request = indexedDB.open('scrobblify', 1);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction('scrobbleState', 'readonly')
          .objectStore('scrobbleState').get('current');
        read.onsuccess = () => {
          db.close();
          resolve((read.result && read.result.pendingReTagTimestampSec) || 0);
        };
        read.onerror = () => { db.close(); resolve(-1); };
      };
      request.onerror = () => resolve(-1);
    }));

    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(
        route.request().method() === 'POST'
          ? route.request().postData() || ''
          : new URL(route.request().url()).search,
      );
      if (params.get('method') === 'track.scrobble') {
        if (diskDuringFirstSend.length === 0) {
          diskDuringFirstSend.push(await readDiskPin());
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }),
        });
        return;
      }
      await route.fallback();
    });

    const reTagged = [1, 2, 3, 4, 5].map((n) => ({
      track: `Track ${n}`,
      artist: `Artist ${n}`,
      album: `Album ${n}`,
      timestamp: Date.UTC(2024, 0, n),
      reTagged: true,
    }));

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    // No identity, but a second already in flight: a progress file written
    // before identities existed, saved while a send was outstanding.
    await seedSavedState(page, buildState({
      tracks: reTagged,
      pendingReTagTimestampSec: pinSec,
    }));
    await page.reload();

    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();
    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 30000 });

    /*
      Minting an identity persists the queue, and the snapshot it persists is
      built from the component's own fields — which at that moment did not yet
      carry the second the saved state arrived with. Naming the queue would
      therefore quietly erase the durable record of a second a request may
      already be riding on, leaving only the journal, which a later eviction or
      a failed write can take away too.
    */
    expect(diskDuringFirstSend[0]).toBe(pinSec);
  });

  test('a resumed session reports overall progress, not just the remaining chunk', async ({ page }) => {
    await interceptLastFm(page);
    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    // A third session: 5 of 10 already done, only 2 tracks left in this chunk.
    await seedSavedState(page, buildState({
      totalTracks: 5,
      completedIndices: [0, 1, 2],
      originalTotalTracks: 10,
      originalSucceededCount: 5,
    }));
    await page.reload();

    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();

    await expect(page.locator('.overall-progress')).toContainText('5 of 10');
  });

  test('legacy progress files without lineage fields still resume', async ({ page }) => {
    await interceptLastFm(page);
    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    const legacy = buildState();
    delete (legacy as Record<string, unknown>).originalTotalTracks;
    delete (legacy as Record<string, unknown>).originalSucceededCount;
    delete (legacy as Record<string, unknown>).sendTimestamps;
    await seedSavedState(page, legacy);
    await page.reload();

    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();

    await expect(page.locator('text=2 tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
    // Falls back to this file's own totals rather than reporting nothing.
    await expect(page.locator('.overall-progress')).toContainText('3 of 5');
  });

  test('a progress file can be imported on a device with no saved session', async ({ page }) => {
    // Regression: "Import from file" lived only in the resume banner, which is
    // shown only when this browser already has saved state. On a new PC it
    // never appears, and the upload zone rejected the .json outright.
    await goToUploadStep(page);
    await expect(page.locator('text=Resume previous session?')).toBeHidden();
    let alerted = false;
    page.on('dialog', async (dialog) => { alerted = true; await dialog.dismiss(); });

    await page.locator('.drop-zone input[type="file"]').setInputFiles({
      name: 'scrobblify-progress-2026-09-07.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(buildState())),
    });

    await expect(page.locator('text=2 tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.overall-progress')).toContainText('3 of 5');
    expect(alerted).toBe(false);
  });

  test('a Spotify history .json dropped on the upload zone is identified, not called an invalid progress file', async ({ page }) => {
    // Regression: every .json was assumed to be a progress file, so a history
    // file dragged out of an opened ZIP failed with 'missing required field
    // "totalTracks"'.
    await goToUploadStep(page);
    await page.locator('.drop-zone input[type="file"]').setInputFiles({
      name: 'Streaming_History_Audio_2024_0.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify([{
        ts: '2024-01-15T10:30:00Z',
        master_metadata_track_name: 'Bohemian Rhapsody',
        master_metadata_album_artist_name: 'Queen',
        master_metadata_album_album_name: 'A Night at the Opera',
        ms_played: 300000,
      }])),
    });

    const dialog = page.locator('.v-dialog.v-overlay--active');
    await expect(dialog).toContainText('Upload the whole .zip', { timeout: 5000 });
    await expect(dialog).not.toContainText('not a valid Scrobblify progress file');
    await expect(dialog).not.toContainText('totalTracks');
  });

  test('an account-data history .json is identified as the wrong Spotify export', async ({ page }) => {
    await goToUploadStep(page);
    await page.locator('.drop-zone input[type="file"]').setInputFiles({
      name: 'StreamingHistory_music_0.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify([{
        endTime: '2024-01-15 10:30', artistName: 'Queen', trackName: 'Bohemian Rhapsody', msPlayed: 300000,
      }])),
    });

    const dialog = page.locator('.v-dialog.v-overlay--active');
    await expect(dialog).toContainText('"Account data" export', { timeout: 5000 });
    await expect(dialog).not.toContainText('totalTracks');
  });

  test('another JSON object is identified as the wrong file, not an invalid progress file', async ({ page }) => {
    // Regression: only arrays were recognised as the wrong file, so Spotify's
    // own non-history JSON (an object, and this one even has a "tracks" key)
    // still failed with 'missing required field "totalTracks"'.
    await goToUploadStep(page);
    await page.locator('.drop-zone input[type="file"]').setInputFiles({
      name: 'YourLibrary.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify({
        tracks: [{
          artist: 'Queen', album: 'A Night at the Opera', track: 'Bohemian Rhapsody', uri: 'spotify:track:x',
        }],
        albums: [],
        artists: [],
      })),
    });

    const dialog = page.locator('.v-dialog.v-overlay--active');
    await expect(dialog).toContainText('scrobblify-progress-', { timeout: 5000 });
    await expect(dialog).not.toContainText('not a valid Scrobblify progress file');
    await expect(dialog).not.toContainText('totalTracks');
  });

  test('a damaged progress file is still reported as invalid', async ({ page }) => {
    await goToUploadStep(page);
    const damaged: Record<string, unknown> = { ...buildState() };
    delete damaged.tracks;
    await page.locator('.drop-zone input[type="file"]').setInputFiles({
      name: 'scrobblify-progress-2026-09-07.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(damaged)),
    });

    const dialog = page.locator('.v-dialog.v-overlay--active');
    await expect(dialog).toContainText('not a valid Scrobblify progress file', { timeout: 5000 });
    await expect(dialog).not.toContainText('Progress files are named like');
  });

  test('a ZIP holding only a progress file resumes as soon as it is chosen', async ({ page }) => {
    // What the reporter did once the .json was refused: zipped it together
    // with their (account-data) Spotify export and uploaded that.
    await goToUploadStep(page);
    const zip = new JSZip();
    zip.file('Spotify Account Data/StreamingHistory_music_0.json', '[]');
    zip.file('scrobblify-progress-2026-09-07.json', JSON.stringify(buildState()));
    await page.locator('.drop-zone input[type="file"]').setInputFiles({
      name: 'my_spotify_data (2).zip',
      mimeType: 'application/zip',
      buffer: await zip.generateAsync({ type: 'nodebuffer' }),
    });

    // No "Find tracks" click: the ZIP is recognised on selection.
    await expect(page.locator('text=2 tracks ready to scrobble')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('.overall-progress')).toContainText('3 of 5');
  });

  test('a history ZIP that also holds a progress file offers the resume, without forcing it', async ({ page }) => {
    await goToUploadStep(page);
    const zip = new JSZip();
    zip.file('Spotify Extended Streaming History/Streaming_History_Audio_2024.json', JSON.stringify([{
      ts: '2024-01-15T10:30:00Z',
      master_metadata_track_name: 'Bohemian Rhapsody',
      master_metadata_album_artist_name: 'Queen',
      master_metadata_album_album_name: 'A Night at the Opera',
      ms_played: 300000,
    }]));
    zip.file('scrobblify-progress-2026-09-07.json', JSON.stringify(buildState()));
    await page.locator('.drop-zone input[type="file"]').setInputFiles({
      name: 'my_spotify_data.zip',
      mimeType: 'application/zip',
      buffer: await zip.generateAsync({ type: 'nodebuffer' }),
    });

    await expect(page.locator('text=1 audio history file(s)')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button:has-text("Find tracks")')).toBeEnabled();
    await page.locator('text=Resume from it instead').click();
    await expect(page.locator('text=2 tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
  });

  test('preventive pacing keeps scrobbling, it does not pause per track', async ({ page }) => {
    // Regression: `msUntilBurstSafe()` frees exactly one slot at a time, so once
    // the rolling window is full *every* remaining track waits a fraction of a
    // second. Those waits went through `pauseWithCountdown`, which flipped the
    // whole view into the paused panel and emitted a `scrobble_paused` event —
    // once per track, for the rest of the import.
    test.setTimeout(120000);
    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(
        route.request().method() === 'POST'
          ? route.request().postData() || ''
          : new URL(route.request().url()).search,
      );
      if (params.get('method') === 'track.scrobble') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);

    // A burst window filled to exactly the default limit, spaced at the rate
    // that limit implies (500 sends / 10 minutes = one per 1.2s), so slots free
    // up one at a time and every track waits a fraction of a second — the shape
    // seen in production.
    //
    // Anchored slightly in the future because the window keeps draining while
    // the resume UI is driven: whatever time that takes just frees that many
    // slots. The lead has to stay under PACING_COUNTDOWN_THRESHOLD_MS (10s) so
    // that even an instant start pauses below the countdown threshold, and the
    // track count has to exceed the slots a slow start can free.
    const SETUP_LEAD_MS = 8000;
    const anchor = Date.now() + SETUP_LEAD_MS;
    const sendTimestamps = Array.from({ length: 500 }, (_, k) => anchor - (499 - k) * 1200);
    const tracks = Array.from({ length: 24 }, (_, n) => ({
      track: `Track ${n + 1}`,
      artist: `Artist ${n + 1}`,
      album: '',
      timestamp: Date.UTC(2024, 0, n + 1),
    }));
    await seedSavedState(page, buildState({
      totalTracks: 24,
      completedIndices: [],
      tracks,
      originalTotalTracks: 24,
      originalSucceededCount: 0,
      sendTimestamps,
    }));
    await page.reload();

    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.locator('text=24 tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    // Pacing must announce itself...
    await expect(page.locator('text=Pacing to stay under')).toBeVisible({ timeout: 20000 });

    // ...without ever handing the run over to the paused panel. Sampled
    // repeatedly because the bug was a flicker — one flip per track — which a
    // single instantaneous check could land between.
    let sawPausedPanel = false;
    let finished = false;
    for (let i = 0; i < 600 && !finished; i++) {
      // eslint-disable-next-line no-await-in-loop
      await page.waitForTimeout(100);
      // eslint-disable-next-line no-await-in-loop
      if (await page.locator('text=Auto-resuming in').isVisible()) {
        sawPausedPanel = true;
      }
      // eslint-disable-next-line no-await-in-loop
      finished = await page.locator('text=Finished scrobbling').isVisible();
    }

    expect(sawPausedPanel).toBe(false);
    expect(finished).toBe(true);
  });

  test('a throttled stretch is continuous, it does not restart on every freed slot', async ({ page }) => {
    // Regression: the stretch ended the moment `msUntilBurstSafe()` returned 0.
    // But a saturated window frees exactly one slot, which the very next track
    // consumes — so the state flapped once per track, and what should have been
    // a single pacing stretch became one begin/end pair per scrobble. Telemetry
    // showed a median `paced_tracks` of 1 with waits of 4-40ms.
    test.setTimeout(120000);
    await interceptLastFm(page);
    // Every reply takes the same time, so the reproduction does not hinge on
    // browser overhead landing inside some window. The alternation comes from
    // the seeded history instead (see below), which the app cannot outrun.
    const REPLY_MS = 600;
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(
        route.request().method() === 'POST'
          ? route.request().postData() || ''
          : new URL(route.request().url()).search,
      );
      if (params.get('method') === 'track.scrobble') {
        await new Promise((resolve) => { setTimeout(resolve, REPLY_MS); });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);

    // A full window, seeded so that slots free in *pairs*: two sends share an
    // expiry, then nothing for SLOT_PAIR_GAP_MS. That makes the alternation
    // structural rather than a race — the first track of each pair always waits
    // and the second always finds a slot already free, whatever the machine is
    // doing. Real histories produce the same alternation through network jitter
    // around the steady-state spacing, just less predictably.
    //
    // The pairs are spread to just under the full 10 minute window so the oldest
    // is about to expire; bunching them tighter would leave the window blocked
    // for minutes before the first slot appeared.
    const SLOT_PAIR_GAP_MS = 2400;
    const SETUP_LEAD_MS = 8000;
    const anchor = Date.now() + SETUP_LEAD_MS;
    const sendTimestamps = Array.from({ length: 500 }, (_, k) => {
      const pair = Math.floor(k / 2);
      // The +1 keeps the array strictly ascending without meaningfully
      // separating the two halves of a pair.
      return anchor - (249 - pair) * SLOT_PAIR_GAP_MS + (k % 2);
    });
    const tracks = Array.from({ length: 24 }, (_, n) => ({
      track: `Track ${n + 1}`,
      artist: `Artist ${n + 1}`,
      album: '',
      timestamp: Date.UTC(2024, 0, n + 1),
    }));
    await seedSavedState(page, buildState({
      totalTracks: 24,
      completedIndices: [],
      tracks,
      originalTotalTracks: 24,
      originalSucceededCount: 0,
      sendTimestamps,
    }));
    await page.reload();

    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.locator('text=24 tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    const notice = page.locator('text=Pacing to stay under');
    await expect(notice).toBeVisible({ timeout: 20000 });

    // Count how often the notice comes *back* after going away. Counting
    // reappearances rather than disappearances deliberately ignores the last
    // one, which is the stretch legitimately ending as the queue drains.
    let everVisible = false;
    let hiddenSinceVisible = false;
    let reappearances = 0;
    let finished = false;
    for (let i = 0; i < 1200 && !finished; i++) {
      // eslint-disable-next-line no-await-in-loop
      await page.waitForTimeout(50);
      // eslint-disable-next-line no-await-in-loop
      const visible = await notice.isVisible();
      if (visible) {
        if (hiddenSinceVisible) {
          reappearances += 1;
          hiddenSinceVisible = false;
        }
        everVisible = true;
      } else if (everVisible) {
        hiddenSinceVisible = true;
      }
      // eslint-disable-next-line no-await-in-loop
      finished = await page.locator('text=Finished scrobbling').isVisible();
    }

    expect(finished).toBe(true);
    // The window stays saturated for the whole run, so there is exactly one
    // stretch and it should never have restarted.
    expect(reappearances).toBe(0);
  });

  test('a manual pause saves, offers a way back, and does not re-send the in-flight track', async ({ page }) => {
    // Regression: "Pause & Save" set `paused` but not `stopped`, so the paused
    // panel rendered a *disabled* "Wait Here" button and waited forever for an
    // auto-resume the loop had already returned from — a dead end. It also
    // never actually saved, despite the label.
    test.setTimeout(90000);

    const scrobbled: string[] = [];
    const tracks = Array.from({ length: 12 }, (_, n) => ({
      track: `Track ${n + 1}`,
      artist: `Artist ${n + 1}`,
      album: `Album ${n + 1}`,
      timestamp: Date.UTC(2024, 0, n + 1),
    }));

    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(
        route.request().method() === 'POST'
          ? route.request().postData() || ''
          : new URL(route.request().url()).search,
      );
      if (params.get('method') === 'track.scrobble') {
        scrobbled.push(params.get('track[0]') || '');
        // Slow enough that the pause lands mid-run rather than after the queue
        // has already drained.
        await new Promise((resolve) => { setTimeout(resolve, 700); });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSavedState(page, buildState({
      totalTracks: 12,
      completedIndices: [0, 1],
      tracks,
      originalTotalTracks: 12,
      originalSucceededCount: 2,
    }));
    await page.reload();

    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    // Let a couple of tracks go out, then ask to stop.
    await expect.poll(() => scrobbled.length, { timeout: 20000 }).toBeGreaterThanOrEqual(2);
    await page.getByRole('button', { name: 'Pause & Save' }).click();

    // The user must be offered a way back in, not a disabled button.
    const resume = page.getByRole('button', { name: 'Resume Now' });
    await expect(resume).toBeVisible({ timeout: 10000 });
    await expect(resume).toBeEnabled();
    await expect(page.locator('text=Wait Here')).toHaveCount(0);
    // And the label's promise must have been kept.
    await expect(page.locator('text=Your progress has been saved automatically'))
      .toBeVisible();

    // The loop really stopped rather than quietly draining the queue.
    const atPause = scrobbled.length;
    await page.waitForTimeout(2000);
    expect(scrobbled.length).toBe(atPause);
    expect(atPause).toBeLessThan(10);

    await resume.click();
    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 40000 });

    // The save is taken between tracks, so the track that was in flight when
    // the user clicked must not be sent twice. A re-send of a re-tagged play
    // would be allocated a fresh timestamp and become a phantom scrobble.
    expect(scrobbled).toEqual(tracks.slice(2).map((t) => t.track));
  });

  test('Resume Now pressed while the pause is still landing finishes the run, sending each track once', async ({ page }) => {
    // Regression for #123: Resume Now was enabled the moment Pause was
    // clicked, while the loop was still waiting on Last.fm. That click started
    // a second loop (before the re-entry guard) or did nothing (after it).
    test.setTimeout(90000);
    const scrobbled: string[] = [];
    const tracks = Array.from({ length: 6 }, (_, n) => ({
      track: `Track ${n + 1}`,
      artist: `Artist ${n + 1}`,
      album: '',
      timestamp: Date.UTC(2024, 0, n + 1),
    }));

    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(route.request().postData() || '');
      if (params.get('method') === 'track.scrobble') {
        scrobbled.push(params.get('track[0]') || '');
        await new Promise((resolve) => { setTimeout(resolve, 2000); });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSavedState(page, buildState({
      totalTracks: 6, completedIndices: [], tracks, originalTotalTracks: 6, originalSucceededCount: 0,
    }));
    await page.reload();
    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    await expect.poll(() => scrobbled.length, { timeout: 20000 }).toBe(1);
    await page.getByRole('button', { name: 'Pause & Save' }).click();
    await expect(page.getByRole('button', { name: 'Pausing…' })).toBeDisabled();
    await page.getByRole('button', { name: 'Resume Now' }).click();

    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 40000 });
    expect(scrobbled).toEqual(tracks.map((t) => t.track));
  });

  test('a pause pressed during a send that then fails takes effect without waiting out the retry', async ({ page }) => {
    // The failed send starts a 30s network-error countdown, whose expiry used
    // to clear `paused` and carry on scrobbling: the pause was thrown away.
    test.setTimeout(90000);
    const scrobbled: string[] = [];
    const tracks = Array.from({ length: 4 }, (_, n) => ({
      track: `Track ${n + 1}`,
      artist: `Artist ${n + 1}`,
      album: '',
      timestamp: Date.UTC(2024, 0, n + 1),
    }));

    let unreachable = true;
    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(route.request().postData() || '');
      if (params.get('method') === 'track.scrobble') {
        scrobbled.push(params.get('track[0]') || '');
        if (unreachable) {
          await route.abort('connectionfailed');
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSavedState(page, buildState({
      totalTracks: 4, completedIndices: [], tracks, originalTotalTracks: 4, originalSucceededCount: 0,
    }));
    await page.reload();
    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    await expect.poll(() => scrobbled.length, { timeout: 20000 }).toBeGreaterThanOrEqual(1);
    await page.getByRole('button', { name: 'Pause & Save' }).click();
    // LastFm's own retries take ~15s; the 30s network countdown must not follow.
    await expect(page.getByRole('button', { name: 'Resume Now' })).toBeEnabled({ timeout: 25000 });
    const sentWhilePausing = scrobbled.length;
    await page.waitForTimeout(1000);
    expect(scrobbled).toHaveLength(sentWhilePausing);
    expect(new Set(scrobbled)).toEqual(new Set(['Track 1']));

    unreachable = false;
    await page.getByRole('button', { name: 'Resume Now' }).click();
    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 30000 });
    expect(scrobbled.slice(sentWhilePausing)).toEqual(tracks.map((t) => t.track));
  });

  test('a stopped run offers an up-to-date progress file, named with the time', async ({ page }) => {
    // #124: only "Save Progress & Leave" downloaded a file, so the newest file
    // a user had was routinely behind the browser.
    test.setTimeout(90000);
    const scrobbled: string[] = [];
    const tracks = Array.from({ length: 12 }, (_, n) => ({
      track: `Track ${n + 1}`,
      artist: `Artist ${n + 1}`,
      album: '',
      timestamp: Date.UTC(2024, 0, n + 1),
    }));
    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(route.request().postData() || '');
      if (params.get('method') === 'track.scrobble') {
        scrobbled.push(params.get('track[0]') || '');
        await new Promise((resolve) => { setTimeout(resolve, 500); });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }),
        });
        return;
      }
      await route.fallback();
    });
    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSavedState(page, buildState({
      totalTracks: 12, completedIndices: [], tracks, originalTotalTracks: 12, originalSucceededCount: 0,
    }));
    await page.reload();
    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();
    await expect.poll(() => scrobbled.length, { timeout: 20000 }).toBeGreaterThanOrEqual(2);
    await page.getByRole('button', { name: 'Pause & Save' }).click();
    await expect(page.getByRole('button', { name: 'Resume Now' })).toBeEnabled({ timeout: 10000 });

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download progress file' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^scrobblify-progress-\d{4}-\d{2}-\d{2}-\d{4}\.json$/);
    const saved = JSON.parse(fs.readFileSync(await file.path(), 'utf8'));
    // Sent plays are in the completed range (as pending verification until the
    // next read-back), so a resume from this file won't send them again.
    expect(saved.completedIndices).toHaveLength(scrobbled.length);
    // Downloading is not leaving: the run can still be resumed from here.
    await expect(page.getByRole('button', { name: 'Resume Now' })).toBeVisible();
  });

  /*
    #124: importing a progress file replaced newer saved progress, and
    re-imported finished ones, so the resume re-sent everything in between.
  */
  async function importProgressOver(page: Page, saved: Record<string, unknown> | null, file: Record<string, unknown>) {
    await interceptLastFm(page);
    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    if (saved) {
      await seedSavedState(page, saved);
    }
    await page.reload();
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
    if (saved) {
      await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    }
    await page.locator('.drop-zone input[type="file"]').setInputFiles({
      name: 'scrobblify-progress-2026-09-07.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(file)),
    });
  }
  const olderFile = (overrides: Record<string, unknown> = {}) => buildState({
    completedIndices: [0], originalSucceededCount: 1, ...overrides,
  });

  test('importing an older progress file asks before replacing newer saved progress', async ({ page }) => {
    await importProgressOver(page, buildState(), olderFile());

    const dialog = page.locator('.progress-file-conflict');
    await expect(dialog).toContainText('This browser has newer progress for this import');
    await expect(dialog).toContainText('3 of 5');
    await expect(dialog).toContainText('1 of 5');
    await dialog.locator('button:has-text("Keep newer progress")').click();
    await expect(page.locator('text=2 tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.overall-progress')).toContainText('3 of 5');
  });

  test('an older progress file can still be used once the user insists', async ({ page }) => {
    await importProgressOver(page, buildState(), olderFile());
    await page.locator('.progress-file-conflict button:has-text("Use this file anyway")').click();
    await expect(page.locator('text=4 tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
  });

  test('a progress file ahead of the saved progress imports without asking', async ({ page }) => {
    await importProgressOver(page, olderFile(), buildState());
    await expect(page.locator('text=2 tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.progress-file-conflict')).toHaveCount(0);
  });

  test('importing a progress file for a different import warns that it replaces the saved one', async ({ page }) => {
    await importProgressOver(
      page,
      buildState({ importId: 'aaaaaaaaaaaaaaaaaaaaaaaa' }),
      buildState({ importId: 'bbbbbbbbbbbbbbbbbbbbbbbb', completedIndices: [0, 1, 2, 3], originalSucceededCount: 4 }),
    );
    const dialog = page.locator('.progress-file-conflict');
    await expect(dialog).toContainText('saved progress for a different import');
    await dialog.locator('button:has-text("Use this file anyway")').click();
    await expect(page.locator('text=1 tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
  });

  test('re-importing a progress file for a finished import warns first', async ({ page }) => {
    test.setTimeout(60000);
    const importId = 'cccccccccccccccccccccccc';
    await interceptLastFm(page);
    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSavedState(page, buildState({ importId }));
    await page.reload();
    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();
    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 30000 });

    await page.reload();
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
    await page.locator('.drop-zone input[type="file"]').setInputFiles({
      name: 'scrobblify-progress-2026-09-07.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(olderFile({ importId }))),
    });

    const dialog = page.locator('.progress-file-conflict');
    await expect(dialog).toContainText('already finished this import');
    await dialog.locator('button:has-text("Cancel")').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.upload-step')).toBeVisible();
    await expect(page.locator('text=tracks ready to scrobble')).toBeHidden();
  });

  test('a finished import still warns when other saved progress is in the way', async ({ page }) => {
    const importId = 'dddddddddddddddddddddddd';
    await interceptLastFm(page);
    await page.goto('/#/scrobble');
    await page.evaluate((id) => localStorage.setItem('scrobblify.completedImports', JSON.stringify([{
      importId: id, originalTotalTracks: 5, userName: 'testuser', completedAt: new Date().toISOString(),
    }])), importId);
    // A different import's queue, saved before anything was sent, has no
    // progress to lose, which used to let the finished import straight in.
    await importProgressOver(
      page,
      buildState({ importId: 'eeeeeeeeeeeeeeeeeeeeeeee', completedIndices: [], originalSucceededCount: 0 }),
      olderFile({ importId }),
    );
    await expect(page.locator('.progress-file-conflict')).toContainText('already finished this import');
  });

  test('a resumed import keeps the identity it was saved with', async ({ page }) => {
    /*
      The queue's id is what lets the server be asked whether *this* import was
      ever handed to the background service. Minting a fresh one on resume
      would make a queue that had been handed over look untouched, and the
      browser would then re-send every track the worker already sent — which
      Last.fm accepts and silently discards, so it fails invisibly.
    */
    test.setTimeout(90000);
    const importId = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const scrobbled: string[] = [];
    const tracks = Array.from({ length: 12 }, (_, n) => ({
      track: `Track ${n + 1}`,
      artist: `Artist ${n + 1}`,
      album: `Album ${n + 1}`,
      timestamp: Date.UTC(2024, 0, n + 1),
    }));

    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(
        route.request().method() === 'POST'
          ? route.request().postData() || ''
          : new URL(route.request().url()).search,
      );
      if (params.get('method') === 'track.scrobble') {
        scrobbled.push(params.get('track[0]') || '');
        await new Promise((resolve) => { setTimeout(resolve, 700); });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSavedState(page, buildState({
      totalTracks: 12,
      completedIndices: [0, 1],
      tracks,
      originalTotalTracks: 12,
      originalSucceededCount: 2,
      importId,
    }));
    await page.reload();

    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    // Read the save the pause takes, rather than the fixture: a completed run
    // clears the record entirely, so the pause is the only moment the written
    // state can be observed.
    await expect.poll(() => scrobbled.length, { timeout: 20000 }).toBeGreaterThanOrEqual(2);
    await page.getByRole('button', { name: 'Pause & Save' }).click();
    await expect(page.getByRole('button', { name: 'Resume Now' })).toBeVisible({ timeout: 10000 });

    const saved = await readSavedState(page);
    expect(saved).not.toBeNull();
    expect(saved!.importId).toBe(importId);
  });

  test('a fresh selection mints an identity the server will accept', async ({ page }) => {
    // The worker requires `[\w-]{16,128}`, and rejects anything shorter as an
    // enumerable id — the route that answers questions about a queue is public
    // precisely because knowing the id is the proof of ownership.
    test.setTimeout(90000);
    const scrobbled: string[] = [];

    // Registered *after* the navigation helper installs the shared Last.fm
    // mock: Playwright gives the most recently added handler first refusal, so
    // routing before it would leave the mock answering `track.scrobble` and
    // nothing would ever reach this counter.
    await goToUploadStep(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(
        route.request().method() === 'POST'
          ? route.request().postData() || ''
          : new URL(route.request().url()).search,
      );
      if (params.get('method') === 'track.scrobble') {
        scrobbled.push(params.get('track[0]') || '');
        await new Promise((resolve) => { setTimeout(resolve, 2000); });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }),
        });
        return;
      }
      await route.fallback();
    });

    await page.locator('.drop-zone input[type="file"]').setInputFiles(FIXTURE_ZIP);
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();
    await expect(page.locator('.upload-step button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
    await page.locator('.upload-step button:has-text("Choose which tracks to scrobble")').click();
    await page.locator('button:has-text("matching")').click();
    await scrobbleSelection(page);
    await expect(page.locator('text=tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    await expect.poll(() => scrobbled.length, { timeout: 20000 }).toBeGreaterThanOrEqual(1);
    await page.getByRole('button', { name: 'Pause & Save' }).click();
    await expect(page.locator('text=Your progress has been saved automatically'))
      .toBeVisible({ timeout: 10000 });

    const saved = await readSavedState(page);
    expect(saved).not.toBeNull();
    expect(String(saved!.importId)).toMatch(/^[\w-]{16,128}$/);
  });

  test('"Save Progress & Leave" during a countdown really stops scrobbling', async ({ page }) => {
    test.setTimeout(90000);
    const scrobbled: string[] = [];
    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(
        route.request().method() === 'POST'
          ? route.request().postData() || ''
          : new URL(route.request().url()).search,
      );
      if (params.get('method') === 'track.scrobble') {
        scrobbled.push(params.get('track[0]') || '');
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    const WINDOW_FREES_IN_MS = 20000;
    const freesAt = Date.now() + WINDOW_FREES_IN_MS;
    const sendTimestamps = Array.from({ length: 500 }, () => freesAt - 10 * 60 * 1000);
    const tracks = Array.from({ length: 30 }, (_, n) => ({
      track: `Track ${n + 1}`,
      artist: `Artist ${n + 1}`,
      album: '',
      timestamp: Date.UTC(2024, 0, n + 1),
    }));
    await seedSavedState(page, buildState({
      totalTracks: 30,
      completedIndices: [],
      tracks,
      originalTotalTracks: 30,
      originalSucceededCount: 0,
      sendTimestamps,
    }));
    await page.reload();

    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();
    await expect(page.locator('text=Auto-resuming in')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Save Progress & Leave' }).click();
    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 10000 });

    await page.waitForTimeout(Math.max(0, freesAt - Date.now()) + 5000);
    expect(scrobbled).toEqual([]);
  });

  test('progress survives closing the tab mid-run', async ({ page }) => {
    test.setTimeout(90000);
    const scrobbled: string[] = [];
    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(
        route.request().method() === 'POST'
          ? route.request().postData() || ''
          : new URL(route.request().url()).search,
      );
      if (params.get('method') === 'track.scrobble') {
        scrobbled.push(params.get('track[0]') || '');
        await new Promise((resolve) => { setTimeout(resolve, 150); });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    const tracks = Array.from({ length: 40 }, (_, n) => ({
      track: `Track ${n + 1}`,
      artist: `Artist ${n + 1}`,
      album: '',
      timestamp: Date.UTC(2024, 0, n + 1),
    }));
    await seedSavedState(page, buildState({
      totalTracks: 40,
      completedIndices: [],
      tracks,
      originalTotalTracks: 40,
      originalSucceededCount: 0,
    }));
    await page.reload();

    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();
    await expect.poll(() => scrobbled.length, { timeout: 30000 }).toBeGreaterThanOrEqual(30);
    await page.reload();

    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    const ready = page.locator('text=/\\d+ tracks ready to scrobble/');
    await expect(ready).toBeVisible({ timeout: 5000 });
    const remaining = Number(((await ready.textContent()) || '').match(/(\d+) tracks ready/)?.[1]);
    expect(remaining).toBeLessThanOrEqual(15);

    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();
    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 30000 });
    expect(scrobbled.filter((t) => t === 'Track 1')).toHaveLength(1);
    expect(new Set(scrobbled).size).toBe(40);

    await page.reload();
    await page.waitForTimeout(2000);
    await expect(page.locator('text=Resume previous session?')).toBeHidden();
  });

  // Re-tagged plays (the path ~78% of imports take), so they all land on
  // today's UTC day.
  function reTaggedState(count: number) {
    const tracks = Array.from({ length: count }, (_, n) => ({
      track: `Track ${n + 1}`,
      artist: `Artist ${n + 1}`,
      album: '',
      timestamp: Date.UTC(2024, 0, n + 1),
      reTagged: true,
    }));
    return buildState({
      totalTracks: count,
      completedIndices: [],
      tracks,
      originalTotalTracks: count,
      originalSucceededCount: 0,
    });
  }

  // The user's own listening today, on a second no re-tagged play can use.
  function fillToday(library: MockLibrary, plays: number) {
    const lastSecondToday = Math.floor(Date.now() / 86400000) * 86400 + 86399;
    for (let n = 0; n < plays; n++) {
      library.add({
        track: `Own ${n}`, artist: 'Own', album: '', uts: lastSecondToday,
      });
    }
  }

  test('plays Last.fm accepted but did not keep are not counted, and stay queued', async ({ page }) => {
    // Regression for #106: Last.fm stores at most 750 scrobbles per UTC day and
    // answers the rest as accepted. Every accepted reply was counted as
    // scrobbled and saved as done, so a week of "10k scrobbled" left ~4k in the
    // user's library and the rest could never be resumed.
    test.setTimeout(60000);
    const library = await interceptLastFm(page);
    const scrobbled: string[] = [];
    page.on('request', (request) => {
      if (new URLSearchParams(request.postData() || '').get('method') === 'track.scrobble') {
        scrobbled.push(new URLSearchParams(request.postData() || '').get('track[0]') || '');
      }
    });
    // Room for 10 when the run starts; then the user's own scrobbler fills the
    // day while it is running, so everything the import sends is dropped.
    fillToday(library, 690);
    let filled = false;
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (!filled && url.searchParams.get('method') === 'user.getrecenttracks'
        && url.searchParams.get('limit') === '1') {
        filled = true;
        fillToday(library, 60);
      }
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSavedState(page, reTaggedState(10));
    await page.reload();
    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    await expect(page.locator('text=Last.fm stopped keeping today\'s scrobbles')).toBeVisible({ timeout: 30000 });
    expect(scrobbled).toHaveLength(10);
    expect(library.plays.filter((p) => p.artist !== 'Own')).toHaveLength(0);
    // Nothing reached the library, so nothing is reported as scrobbled...
    await expect(page.locator('.overall-progress')).toContainText('0 of 10');
    // ...and every dropped play is still owed a send on the next resume.
    await expect.poll(async () => (await readSavedState(page))?.tracks.length, { timeout: 10000 }).toBe(20);
    const saved = await readSavedState(page);
    expect(saved?.completedIndices).toHaveLength(10);
    expect(saved?.originalSucceededCount).toBe(0);
  });

  test('stops at Last.fm\'s daily cap instead of sending plays it will throw away', async ({ page }) => {
    test.setTimeout(60000);
    const library = await interceptLastFm(page);
    const scrobbled: string[] = [];
    page.on('request', (request) => {
      if (new URLSearchParams(request.postData() || '').get('method') === 'track.scrobble') {
        scrobbled.push(new URLSearchParams(request.postData() || '').get('track[0]') || '');
      }
    });
    // 695 already today: 5 more fit under the cap with 50 left for the user.
    fillToday(library, 695);

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSavedState(page, reTaggedState(10));
    await page.reload();
    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    await expect(page.locator('text=Last.fm keeps at most 750 scrobbles a day')).toBeVisible({ timeout: 30000 });
    expect(scrobbled).toEqual(['Track 1', 'Track 2', 'Track 3', 'Track 4', 'Track 5']);
    await expect(page.locator('.overall-progress')).toContainText('5 of 10');
  });

  test('plays from a profile with hidden recent listening are still confirmed', async ({ page }) => {
    // Regression for #137: the read-back was unsigned, and Last.fm refuses an
    // unsigned read of a hidden profile with error 17. Nothing was ever
    // confirmed: "0 scrobbled", every play "sent, couldn't confirm".
    test.setTimeout(60000);
    const library = await interceptLastFm(page, { hiddenProfile: true });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSavedState(page, reTaggedState(5));
    await page.reload();
    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 30000 });
    expect(library.plays).toHaveLength(5);
    await expect(page.locator('text=We scrobbled 5 tracks')).toBeVisible();
    await expect(page.locator('text=couldn\'t be read to confirm')).toHaveCount(0);
  });

  test('a library Last.fm will not let us read is not reported as "being checked"', async ({ page }) => {
    // Even signed, a read can be refused for good (#137). Promising the plays
    // will be checked "when you resume" was untrue for the rest of the import.
    test.setTimeout(60000);
    const events = captureEvents(page);
    await interceptLastFm(page, { recentTracksError: 17 });
    const scrobbled: string[] = [];
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(route.request().postData() || '');
      if (params.get('method') === 'track.scrobble') {
        scrobbled.push(params.get('track[0]') || '');
        // Slow enough that the pause lands mid-run.
        await new Promise((resolve) => { setTimeout(resolve, 700); });
      }
      await route.fallback();
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSavedState(page, reTaggedState(10));
    await page.reload();
    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    await expect.poll(() => scrobbled.length, { timeout: 20000 }).toBeGreaterThanOrEqual(2);
    await page.getByRole('button', { name: 'Pause & Save' }).click();
    await expect(page.getByRole('button', { name: 'Resume Now' })).toBeVisible({ timeout: 10000 });

    await expect(page.locator('text=checked on Last.fm when you resume')).toHaveCount(0);
    await expect(page.locator('text=won\'t let Scrobblify read your recent listening')).toBeVisible();
    await expect.poll(() => events.find((e) => e.name === 'scrobble_stopped')?.props).toMatchObject({
      reason: 'manual',
      library_unreadable: true,
    });
  });
});

test.describe('Rate limit handling', () => {
  // Always rate-limited. Also short-circuits LastFm's own internal retry
  // budget so the component-level backoff is what's under test.
  async function alwaysRateLimited(page: Page) {
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(
        route.request().method() === 'POST'
          ? route.request().postData() || ''
          : new URL(route.request().url()).search,
      );
      const apiMethod = params.get('method');
      if (apiMethod === 'track.scrobble') {
        await route.fulfill({
          status: 429,
          contentType: 'application/json',
          body: JSON.stringify({ error: 29, message: 'Rate limit exceeded' }),
        });
        return;
      }
      if (apiMethod === 'auth.getSession') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ session: { name: 'testuser', key: 'fake-session-key' } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ recenttracks: { track: [] } }),
      });
    });
  }

  async function seedSelection(page: Page) {
    await page.evaluate(async () => {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('scrobblify', 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('scrobbleState')) {
            db.createObjectStore('scrobbleState');
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('scrobbleState', 'readwrite');
          tx.objectStore('scrobbleState').put({
            userName: 'testuser',
            totalTracks: 2,
            completedIndices: [],
            failedIndices: [],
            tracks: [1, 2].map((n) => ({
              track: `Track ${n}`, artist: `Artist ${n}`, album: '', timestamp: Date.UTC(2024, 0, n),
            })),
            originalTotalTracks: 2,
            originalSucceededCount: 0,
            sendTimestamps: [],
            burstCount: 0,
            dailyCount: 0,
            dailyCountDate: new Date().toISOString().split('T')[0],
            savedAt: new Date().toISOString(),
          }, 'current');
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => { db.close(); reject(tx.error); };
        };
        request.onerror = () => reject(request.error);
      });
    });
  }

  test('gives up and saves instead of retrying a rate limit forever', async ({ page }) => {
    /*
      Needs more than the default 30s budget. Not because anything is slow, but
      because of what the test does: it drives ~50 minutes of simulated time
      through the backoff ladder in 30-second steps, and every step costs a
      real round-trip to the page. That is upwards of 150 round-trips, which
      lands just over 30s of wall clock — so the default made this a coin flip
      that had nothing to do with the behaviour under test.
    */
    test.setTimeout(180000);
    // Regression: the old handler paused a flat 60s and retried the same track
    // indefinitely. Two production users sat through 200+ consecutive retries.
    //
    // The backoff ladder spans ~50 minutes, so time is faked and driven forward
    // while polling — including through the API client's own retry backoff.
    await page.clock.install();
    await alwaysRateLimited(page);
    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSelection(page);
    await page.reload();

    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Scrobble', exact: true })).toBeVisible();
    await page.clock.runFor(3000);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    // Jump simulated time forward until `locator` appears.
    //
    // fastForward, not runFor: runFor replays every 1s countdown tick (each a
    // re-render), which over ~50 simulated minutes cost more than the whole
    // test budget on slower machines (#79). fastForward fires each due timer
    // at most once, which is enough because the countdown resolves off a
    // wall-clock deadline rather than by counting ticks.
    //
    // Each jump fires at most one of the API client's chained retry timers, so
    // this takes a step per retry. The short real-time wait lets route
    // handlers answer and the page re-render; it returns as soon as the target
    // shows, so it only costs anything on steps that don't reach it.
    async function advanceUntilVisible(locator: Locator, stepMs: number) {
      for (let step = 0; step < 40; step++) {
        // eslint-disable-next-line no-await-in-loop
        if (await locator.isVisible()) return true;
        // eslint-disable-next-line no-await-in-loop
        await page.clock.fastForward(stepMs);
        // eslint-disable-next-line no-await-in-loop
        await locator.waitFor({ timeout: 100 }).catch(() => undefined);
      }
      return locator.isVisible();
    }

    // The user is told how long we'll wait, instead of a bare 1-minute countdown.
    // The step must stay well under the 5-minute first backoff, or a single
    // jump could carry the loop straight past the state being checked for.
    const sawFirstBackoff = await advanceUntilVisible(
      page.locator('text=attempt 1 of 3'),
      60 * 1000,
    );
    expect(sawFirstBackoff).toBe(true);

    // Giving up is terminal, so overshooting it is harmless: take big steps.
    const gaveUp = await advanceUntilVisible(
      page.locator('text=still rate limiting your account'),
      30 * 60 * 1000,
    );
    // The loop must terminate with an actionable message, not keep spinning.
    expect(gaveUp).toBe(true);
    await expect(page.getByRole('button', { name: 'Try Again Now' })).toBeVisible();
    // ...and progress must have been saved automatically so the user can leave.
    await expect(page.locator('text=saved automatically')).toBeVisible();
  });
});

test.describe('Complete Step', () => {
  test('shows completion message after full scrobble', async ({ page }) => {
    await interceptLastFm(page);
    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await page.reload();
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });

    const fileInput = page.locator('.drop-zone input[type="file"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();

    await expect(page.locator('.upload-step button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
    await page.locator('.upload-step button:has-text("Choose which tracks to scrobble")').click();

    await expect(page.locator('button:has-text("matching")')).toBeVisible({ timeout: 5000 });
    await page.locator('button:has-text("matching")').click();
    await scrobbleSelection(page);

    await expect(page.getByRole('button', { name: 'Scrobble', exact: true })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    // Wait for completion step
    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('text=LastWave')).toBeVisible();
  });
});

test.describe('Authentication - clearUser', () => {
  test('clearing user actually logs out', async ({ page }) => {
    await interceptLastFm(page);
    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await page.reload();

    // Wait for auto-advance (proves auth worked)
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });

    // Now click "Not you?" to log out
    await page.locator('text=Not you?').click();

    // Signed out: the name goes, and the page stays on upload (there is no
    // sign-in step to go back to).
    await expect(page.locator('text=Currently authenticated as')).toHaveCount(0, { timeout: 5000 });
    await expect(page.locator('.upload-step')).toBeVisible();

    // Verify localStorage was cleared
    const authKey = await page.evaluate(() => localStorage.getItem('scrobblifyLfmAuthKey'));
    expect(authKey).toBeNull();
  });
});

test.describe('URL Encoding', () => {
  test('handles special characters in track/artist names', async ({ page }) => {
    // This test verifies that URL encoding works correctly
    const capturedPostBodies: string[] = [];

    await page.route('https://ws.audioscrobbler.com/**', async (route) => {
      const postData = route.request().postData() || '';
      const allParams = new URLSearchParams(
        route.request().method() === 'POST' ? postData : new URL(route.request().url()).search,
      );
      const apiMethod = allParams.get('method');

      if (apiMethod === 'track.scrobble') {
        capturedPostBodies.push(postData);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }),
        });
      } else if (apiMethod === 'track.getInfo') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ track: { duration: '240000' } }),
        });
      } else if (apiMethod === 'user.getrecenttracks') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ recenttracks: { track: [] } }),
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ session: { name: 'testuser', key: 'fake-session-key' } }),
        });
      }
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await page.reload();
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });

    const fileInput = page.locator('.drop-zone input[type="file"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();

    await expect(page.locator('.upload-step button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
    await page.locator('.upload-step button:has-text("Choose which tracks to scrobble")').click();

    await expect(page.locator('button:has-text("matching")')).toBeVisible({ timeout: 5000 });
    await page.locator('button:has-text("matching")').click();
    await scrobbleSelection(page);

    await expect(page.getByRole('button', { name: 'Scrobble', exact: true })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 30000 });

    // At least one scrobble body should contain "Rock" (from "Rock & Roll")
    // The & should be properly encoded in the POST body
    const hasRockAndRoll = capturedPostBodies.some((body) => {
      const params = new URLSearchParams(body);
      const artist = params.get('artist[0]');
      const track = params.get('track[0]');
      return (track === 'Rock & Roll') || (artist?.includes('Led Zeppelin'));
    });
    expect(hasRockAndRoll).toBe(true);
  });
});

test.describe('No JS Errors', () => {
  test('home page loads without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/');
    await page.waitForTimeout(2000);
    expect(errors).toEqual([]);
  });

  test('scrobble page loads without console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await page.goto('/#/scrobble');
    await page.waitForTimeout(2000);
    expect(errors).toEqual([]);
  });
});

test.describe('Re-tagged old plays', () => {
  // Drives an import with "Scrobble tracks older than 2 weeks" enabled, which is
  // the path ~78% of real imports take, and hands back every timestamp Last.fm
  // was asked to store.
  async function runReTaggedImport(
    page: Page,
    scrobbleResponse: object | ((attempt: number) => Promise<object | 'abort'> | object | 'abort'),
    // Text that marks the end of the run. Not every run ends by finishing:
    // rejections the loop reads as a systemic problem stop it deliberately.
    endsWith = 'Finished scrobbling',
  ) {
    const timestamps: number[] = [];
    let scrobbleAttempts = 0;
    // Everything but track.scrobble falls through to the stateful mock, so the
    // app can read back what an accepted reply stored.
    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route) => {
      const postData = route.request().postData() || '';
      const allParams = new URLSearchParams(
        route.request().method() === 'POST' ? postData : new URL(route.request().url()).search,
      );
      const apiMethod = allParams.get('method');

      if (apiMethod === 'track.scrobble') {
        const raw = allParams.get('timestamp%5B0%5D') || allParams.get('timestamp[0]') || '0';
        timestamps.push(Number(raw));
        scrobbleAttempts++;
        const outcome = typeof scrobbleResponse === 'function'
          ? await scrobbleResponse(scrobbleAttempts)
          : scrobbleResponse;
        if (outcome === 'abort') {
          await route.abort('connectionfailed');
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(outcome),
        });
      } else {
        await route.fallback();
      }
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await page.reload();
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });

    await page.locator('.drop-zone input[type="file"]').setInputFiles(FIXTURE_ZIP);
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();

    await expect(page.locator('.upload-step button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
    await page.locator('.upload-step button:has-text("Choose which tracks to scrobble")').click();
    await expect(page.locator('button:has-text("matching")')).toBeVisible({ timeout: 5000 });
    await page.locator('button:has-text("matching")').click();
    await scrobbleSelection(page);

    await expect(page.getByRole('button', { name: 'Scrobble', exact: true })).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();
    await expect(page.locator(`text=${endsWith}`)).toBeVisible({ timeout: 30000 });

    return timestamps;
  }

  test('gives every re-tagged play its own timestamp so repeats are not collapsed', async ({ page }) => {
    const timestamps = await runReTaggedImport(page, { scrobbles: { '@attr': { accepted: 1, ignored: 0 } } });

    expect(timestamps.length).toBeGreaterThan(1);
    // The bug: every play shared one Date, so Last.fm — which keys a scrobble on
    // (user, artist, track, timestamp) — kept one and silently dropped the rest.
    expect(new Set(timestamps).size).toBe(timestamps.length);

    const sorted = [...timestamps].sort((a, b) => a - b);
    expect(timestamps).toEqual(sorted);

    const nowSec = Math.floor(Date.now() / 1000);
    const fourteenDaysSec = 14 * 24 * 60 * 60;
    for (const ts of timestamps) {
      expect(ts).toBeLessThanOrEqual(nowSec);
      expect(ts).toBeGreaterThan(nowSec - fourteenDaysSec);
    }
  });

  test('two refused seconds in a row stop the run instead of spending the queue', async ({ page }) => {
    const timestamps = await runReTaggedImport(
      page,
      {
        scrobbles: {
          '@attr': { accepted: 0, ignored: 1 },
          scrobble: { ignoredMessage: { code: '3', '#text': 'Timestamp too old' } },
        },
      },
      'Last.fm rejected the substitute times',
    );

    /*
      Code 3 says the *second we chose* was refused, which is a statement about
      our own arithmetic rather than about the track — and the one rejection
      that can be trusted to mean nothing was stored. So the first track is
      re-sent once under a replacement second.

      The second refusal is a different animal. The allocator only ever offers
      seconds inside the window Last.fm accepts, so being refused twice means
      this machine's clock and Last.fm's disagree — a condition every remaining
      track shares. Carrying on would consume the whole queue as failures one
      track at a time, so the run stops with all of it still there.
    */
    expect(timestamps).toHaveLength(2);
    expect(timestamps[1]).not.toBe(timestamps[0]);
    await expect(page.locator('.overall-progress')).toContainText('0 of 5');
  });

  test('a second Last.fm refused for the day is not carried across the pause', async ({ page }) => {
    const ok = { scrobbles: { '@attr': { accepted: 1, ignored: 0 } } };
    const dailyLimit = {
      scrobbles: {
        '@attr': { accepted: 0, ignored: 1 },
        scrobble: { ignoredMessage: { code: '5', '#text': 'Daily scrobble limit exceeded' } },
      },
    };

    const timestamps = await runReTaggedImport(
      page,
      (attempt) => (attempt === 2 ? dailyLimit : ok),
      'daily scrobble limit',
    );
    expect(timestamps).toHaveLength(2);

    // Through the disk, which is the route that matters: the pause can last a
    // day, and the tab is not expected to survive it.
    await page.reload();
    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();
    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 30000 });

    /*
      The refused second used to be saved along with the queue, so the resume
      re-sent the track under it. That is right for a send whose outcome nobody
      saw — an identical re-send is deduplicated where a fresh second would be
      a phantom play — but Last.fm answering "ignored" is not silence. It says
      outright that nothing was stored.

      Keeping it is then actively harmful: the pause runs to the next day, by
      which point the second may have aged out of the window Last.fm accepts,
      and a second read back off the disk cannot be told apart from one that
      may already hold a play. The track would be given up on rather than
      re-timed. So a second known to be unspent is simply forgotten.
    */
    expect(timestamps.length).toBeGreaterThan(2);
    expect(new Set(timestamps).size).toBe(timestamps.length);
  });

  test('the second a send is riding on is durable before the request leaves', async ({ page }) => {
    const journalDuringFirstSend: (string | null)[] = [];

    const timestamps = await runReTaggedImport(page, async (attempt) => {
      if (attempt === 1) {
        // Read while the request is still in flight — this is the whole
        // interval the journal exists to cover.
        journalDuringFirstSend.push(await page.evaluate(
          () => window.localStorage.getItem('scrobblify.background.inflightSecond'),
        ));
      }
      return { scrobbles: { '@attr': { accepted: 1, ignored: 0 } } };
    });

    /*
      The saved queue carries the pending second too, but it only reaches the
      disk on the next save — and the dangerous interval is shorter than that.
      A tab closed between choosing a second and hearing an answer leaves a
      play that Last.fm may well have stored; a reload that knows nothing
      about that second picks a different one, and the re-send lands beside
      the first instead of being deduplicated away.
    */
    const raw = journalDuringFirstSend[0];
    expect(raw).toBeTruthy();
    const [journal] = JSON.parse(raw as string);
    expect(journal.sec).toBe(timestamps[0]);
    expect(journal.importId).toBeTruthy();
    expect(journal.trackKey).toBeTruthy();

    // And it is forgotten once every track is done with, so no later queue can
    // inherit a second that has already been spent.
    const afterRun = await page.evaluate(
      () => window.localStorage.getItem('scrobblify.background.inflightSecond'),
    );
    expect(afterRun).toBeNull();
  });

  test('a second it cannot record is a second it will not send under', async ({ page }) => {
    /*
      Storage that accepts a write and keeps nothing is the failure this
      guards, not storage that throws — private-mode quota has historically
      done both, and the silent one is the one a `try` never sees.
    */
    await page.addInitScript(() => {
      const original = window.localStorage.setItem.bind(window.localStorage);
      window.localStorage.setItem = (key: string, value: string) => {
        if (key === 'scrobblify.background.inflightSecond') { return; }
        original(key, value);
      };
    });

    const timestamps = await runReTaggedImport(
      page,
      { scrobbles: { '@attr': { accepted: 1, ignored: 0 } } },
      "couldn't store data in this browser",
    );

    /*
      The journal is what makes a re-tagged send recoverable, so a send it
      could not record is one that must not happen.

      Without it, a tab closed between choosing a second and hearing an answer
      leaves a play Last.fm may well have stored and no record of the second it
      was stored under; the resume finds none, picks a different one, and puts
      a second copy on a public profile. Stopping holds the queue instead —
      held plays are recoverable, duplicated ones are not.
    */
    expect(timestamps).toHaveLength(0);
    await expect(page.locator('.overall-progress')).toContainText('0 of 5');

    /*
      And nothing was left on the queue pretending to be a second in flight.
      The component and store copies are written before the journal is
      attempted, so saving with them still set would put a pin on the disk that
      no request is riding on — where the resume reads it as *inherited*,
      refuses to re-time it on principle, and reports a play as permanently
      failed that was never even sent.
    */
    const savedPin = await page.evaluate(async () => new Promise<number>((resolve) => {
      const request = indexedDB.open('scrobblify', 1);
      request.onsuccess = () => {
        const db = request.result;
        const read = db.transaction('scrobbleState', 'readonly')
          .objectStore('scrobbleState').get('current');
        read.onsuccess = () => {
          db.close();
          resolve((read.result && read.result.pendingReTagTimestampSec) || 0);
        };
        read.onerror = () => { db.close(); resolve(-1); };
      };
      request.onerror = () => resolve(-1);
    }));
    expect(savedPin).toBe(0);
  });

  test('a journal belonging to another queue is neither erased nor overwritten', async ({ page }) => {
    const foreignId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const foreignKey = 'Some Artist\u0000Some Track\u00001700000000000';
    // An earlier import that crashed between choosing a second and hearing
    // whether Last.fm stored the play.
    // Fifteen days old: past any window Last.fm would still deduplicate on,
    // and therefore past the point where a timer would have been tempted to
    // discard it. A clock that jumps forward is indistinguishable from time
    // passing, so nothing here is allowed to expire on one.
    await page.addInitScript(([id, key]) => {
      window.localStorage.setItem('scrobblify.background.inflightSecond', JSON.stringify([
        {
          importId: id,
          trackKey: key,
          sec: 1700000000,
          at: Date.now() - 15 * 24 * 60 * 60 * 1000,
        },
      ]));
    }, [foreignId, foreignKey]);

    await runReTaggedImport(page, { scrobbles: { '@attr': { accepted: 1, ignored: 0 } } });

    /*
      Each record belongs to one queue, and the queue it belongs to is the only
      one that can resolve it — which is precisely the queue that is not
      running. Clearing or overwriting it leaves that import's play sitting at
      Last.fm under a second nothing remembers, and its resume invents another.

      So this import's five sends must neither displace the record nor delete
      it on their way past.
    */
    const afterRun = await page.evaluate(
      () => window.localStorage.getItem('scrobblify.background.inflightSecond'),
    );
    const records = JSON.parse(afterRun as string);
    expect(records).toEqual([
      expect.objectContaining({ importId: foreignId, trackKey: foreignKey, sec: 1700000000 }),
    ]);
  });

  test('a rejection that is not about the timestamp is not retried', async ({ page }) => {
    const timestamps = await runReTaggedImport(page, {
      scrobbles: {
        '@attr': { accepted: 0, ignored: 1 },
        scrobble: { ignoredMessage: { code: '1', '#text': 'Artist ignored' } },
      },
    });

    /*
      The counterpart to the test above, and the reason that one is not simply
      "retry anything Last.fm ignores". An ignored artist says nothing about
      the second, so re-sending under a different one buys nothing and spends
      another request — and every retry is a request this app has to pay for
      out of a rate limit measured in hours.
    */
    expect(timestamps.length).toBeGreaterThan(0);
    expect(new Set(timestamps).size).toBe(timestamps.length);
    // The scrobble step is still mounted but hidden once the stepper advances,
    // so assert on text content rather than visibility.
    await expect(page.locator('.v-expansion-panel-title')).toContainText(`${timestamps.length} failed track(s)`);
    await expect(page.locator('.overall-progress')).toContainText(`0 of ${timestamps.length}`);
  });

  test('retrying a track re-sends the identical timestamp', async ({ page }) => {
    // The retry waits out a 30s network cooldown before the second attempt.
    test.setTimeout(120000);

    const ok = { scrobbles: { '@attr': { accepted: 1, ignored: 0 } } };
    // Drop the response to the very first attempt, exactly like a connection
    // reset or a suspended tab would.
    const timestamps = await runReTaggedImport(page, (attempt) => (attempt === 1 ? 'abort' : ok));

    expect(timestamps.length).toBeGreaterThan(2);
    // If the retry allocated a fresh second, a request that Last.fm actually
    // received would be stored a second time as a phantom play — an identical
    // resend is silently deduplicated instead.
    expect(timestamps[1]).toBe(timestamps[0]);
    // Every *other* track still gets its own second.
    const afterRetry = timestamps.slice(1);
    expect(new Set(afterRetry).size).toBe(afterRetry.length);
  });
});

test.describe('Import robustness', () => {
  test('one malformed history file does not throw away the whole import', async ({ page }) => {
    await goToUploadStep(page);

    const good = JSON.stringify([
      play('Bohemian Rhapsody', 'Queen', '2024-01-15T10:30:00Z'),
      play('Yesterday', 'The Beatles', '2024-01-15T10:36:00Z'),
    ]);
    // Truncated mid-object, which is what a corrupted or partially-read export
    // looks like. Real users hit this on large exports.
    const broken = '[{"ts": "2024-01-15T10:30:00Z", "master_metadata_tra';

    await uploadZip(page, await makeZip({
      'Streaming_History_Audio_2024_0.json': broken,
      'Streaming_History_Audio_2024_1.json': good,
    }));

    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();

    // The readable file still gets imported...
    await expect(page.locator('text=Found 2 plays')).toBeVisible({ timeout: 15000 });
    // ...and the user is told plainly that part of their history is missing.
    await expect(page.locator('text=skipped 1 of 2 file(s)')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.upload-step button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 15000 });
  });

  test('a history file with a few unusable rows keeps the rest of its plays', async ({ page }) => {
    // Regression for #122: one non-string artist threw "t.split is not a
    // function", and the whole file was skipped as malformed.
    await goToUploadStep(page);

    await uploadZip(page, await makeZip({
      'Streaming_History_Audio_2024_0.json': JSON.stringify([
        play('Bohemian Rhapsody', 'Queen', '2024-01-15T10:30:00Z'),
        { ...play('Numbered', 'x', '2024-01-15T10:33:00Z'), master_metadata_album_artist_name: 1975 },
        { ...play('Object artist', 'x', '2024-01-15T10:34:00Z'), master_metadata_album_artist_name: { name: 'x' } },
        play('No date', 'Queen', 'not a date'),
        play('Yesterday', 'The Beatles', '2024-01-15T10:36:00Z'),
      ]),
    }));

    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();

    await expect(page.locator('text=Found 3 plays')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=Skipped 2 plays')).toBeVisible();
    await expect(page.locator('text=could be read')).toHaveCount(0);
  });

  test('a ZIP where every history file is unreadable still reports an error', async ({ page }) => {
    await goToUploadStep(page);

    await uploadZip(page, await makeZip({
      'Streaming_History_Audio_2024_0.json': 'not json at all',
    }));

    await page.locator('button:has-text("Find tracks")').click();
    await expect(page.locator('text=None of the 1 history file(s) in this ZIP could be read')).toBeVisible({ timeout: 15000 });
  });

  test('Spotify\'s account-data export is identified, not reported as a generic wrong file', async ({ page }) => {
    await goToUploadStep(page);
    const zip = new JSZip();
    zip.file('Spotify Account Data/StreamingHistory_music_0.json', JSON.stringify([
      {
        endTime: '2024-01-15 10:30', artistName: 'Queen', trackName: 'Bohemian Rhapsody', msPlayed: 300000,
      },
    ]));
    zip.file('Spotify Account Data/Playlist1.json', '{}');
    await uploadZip(page, await zip.generateAsync({ type: 'nodebuffer' }));

    // Caught on selection, before the user has clicked anything else.
    await expect(page.locator('text=Account data')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('button:has-text("Find tracks")')).toBeDisabled();
  });

  test('macOS resource-fork sidecars are not mistaken for history files', async ({ page }) => {
    // Regression: the pattern was tested against the whole ZIP path and wasn't
    // anchored, so `__MACOSX/._Streaming_History_Audio_*.json` matched too.
    // macOS writes one of those per entry when a ZIP is created or re-zipped on
    // a Mac, which doubled the file count, failed every sidecar in JSON.parse
    // and warned that half the user's history was missing when none of it was.
    await goToUploadStep(page);

    const zip = new JSZip();
    const names = ['Streaming_History_Audio_2024_0.json', 'Streaming_History_Audio_2024_1.json'];
    zip.file(`Spotify Extended Streaming History/${names[0]}`, JSON.stringify([
      play('Bohemian Rhapsody', 'Queen', '2024-01-15T10:30:00Z'),
    ]));
    zip.file(`Spotify Extended Streaming History/${names[1]}`, JSON.stringify([
      play('Yesterday', 'The Beatles', '2024-01-15T10:36:00Z'),
    ]));
    for (const name of names) {
      // AppleDouble sidecar: binary, and carrying the "Mac OS X" marker that
      // showed up in the real parse errors.
      zip.file(
        `__MACOSX/Spotify Extended Streaming History/._${name}`,
        Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00,
          ...Buffer.from('Mac OS X        \u0000\u0000\u0000\u0000', 'ascii')]),
      );
    }
    await uploadZip(page, await zip.generateAsync({ type: 'nodebuffer' }));

    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();

    // Only the two real files are counted...
    await expect(page.locator('text=Found 2 audio history file(s) in ZIP')).toBeVisible({ timeout: 15000 });
    await expect(page.locator('text=Found 2 plays')).toBeVisible({ timeout: 15000 });
    // ...and nothing is reported as damaged, because nothing was.
    await expect(page.locator('text=skipped')).toHaveCount(0);
    await expect(page.locator('.upload-step button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 15000 });
  });

  test('a repeated track is looked up once, not once per play', async ({ page }) => {
    await interceptLastFm(page);
    const lookups: string[] = [];
    await page.route('https://ws.audioscrobbler.com/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('method') === 'track.getInfo') {
        lookups.push(`${url.searchParams.get('artist')} - ${url.searchParams.get('track')}`);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ track: { duration: '354000' } }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await page.reload();
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });

    // The same track six times — exactly the repeat-heavy shape of a real
    // listening history, and the case the per-play lookup punished hardest.
    const plays = [];
    for (let i = 0; i < 6; i++) {
      plays.push(play('Bohemian Rhapsody', 'Queen', `2024-01-15T10:${10 + i}:00Z`));
    }
    plays.push(play('Yesterday', 'The Beatles', '2024-01-15T11:00:00Z'));

    await uploadZip(page, await makeZip({
      'Streaming_History_Audio_2024_0.json': JSON.stringify(plays),
    }));

    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('label:has-text("Validate track lengths")').click();
    await page.locator('button:has-text("Find tracks")').click();

    await expect(page.locator('text=Found 7 valid scrobbles')).toBeVisible({ timeout: 30000 });
    expect(lookups.length).toBe(2);
    expect(new Set(lookups).size).toBe(2);
  });

  test('a track with no duration on Last.fm is kept, not silently discarded', async ({ page }) => {
    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('method') === 'track.getInfo') {
        // Last.fm really does return tracks with an empty duration.
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ track: { name: 'Obscure B-Side', duration: '' } }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await page.reload();
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });

    await uploadZip(page, await makeZip({
      'Streaming_History_Audio_2024_0.json': JSON.stringify([
        play('Obscure B-Side', 'Some Band', '2024-01-15T10:30:00Z'),
      ]),
    }));

    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('label:has-text("Validate track lengths")').click();
    await page.locator('button:has-text("Find tracks")').click();

    // An unparseable duration used to arrive as NaN and fail every comparison,
    // dropping the play. The documented intent is to give the user the scrobble.
    await expect(page.locator('text=Found 1 valid scrobbles')).toBeVisible({ timeout: 30000 });
  });

  test('duplicate-check requests use integer timestamps', async ({ page }) => {
    await interceptLastFm(page);
    const ranges: Array<{ from: string; to: string }> = [];
    await page.route('https://ws.audioscrobbler.com/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('method') === 'user.getrecenttracks') {
        ranges.push({
          from: url.searchParams.get('from') || '',
          to: url.searchParams.get('to') || '',
        });
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            recenttracks: { '@attr': { totalPages: '1', total: '0' }, track: [] },
          }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await page.reload();
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });

    await uploadZip(page, await makeZip({
      'Streaming_History_Audio_2024_0.json': JSON.stringify([
        // Deliberately *recent* so the play is not re-tagged: re-tagged plays
        // get provisional timestamps and are exempt from the duplicate check,
        // so they would never issue a history request at all.
        play('Bohemian Rhapsody', 'Queen', new Date(Date.now() - 86400000).toISOString()),
      ]),
    }));

    await page.locator('label:has-text("Check for duplicates")').click();
    await page.locator('button:has-text("Find tracks")').click();
    await expect(page.locator('.upload-step button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });

    expect(ranges.length).toBeGreaterThan(0);
    for (const range of ranges) {
      // Last.fm documents UNIX timestamps; "1784563202.848" is not one.
      expect(range.from).toMatch(/^\d+$/);
      expect(range.to).toMatch(/^\d+$/);
    }
  });

  // One play from yesterday, already in the library, run through the
  // duplicate check.
  async function checkDuplicatesOfOnePlay(page: Page, library: MockLibrary) {
    const uts = Math.floor(Date.now() / 1000) - 86400;
    library.add({
      track: 'Bohemian Rhapsody', artist: 'Queen', album: '', uts,
    });
    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await page.reload();
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
    await uploadZip(page, await makeZip({
      'Streaming_History_Audio_2024_0.json': JSON.stringify([
        play('Bohemian Rhapsody', 'Queen', new Date(uts * 1000).toISOString()),
      ]),
    }));
    await page.locator('label:has-text("Check for duplicates")').click();
    await page.locator('button:has-text("Find tracks")').click();
  }

  test('the duplicate check can read a profile with hidden recent listening', async ({ page }) => {
    // #137: the history read was unsigned, which Last.fm refuses with error 17
    // for a hidden profile, so every play was sent again.
    const library = await interceptLastFm(page, { hiddenProfile: true });
    await checkDuplicatesOfOnePlay(page, library);
    await expect(page.locator('text=Found 1 duplicates')).toBeVisible({ timeout: 30000 });
  });

  test('the duplicate check still reads history when the stored session key is dead', async ({ page }) => {
    // Signing a read with a revoked key fails with error 9, where an unsigned
    // read of a public profile works. The scrobble step deals with the dead
    // key; the duplicate check must not lose its answer to it first.
    const library = await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('method') === 'user.getrecenttracks' && url.searchParams.get('sk')) {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 9, message: 'Invalid session key - Please re-authenticate' }),
        });
        return;
      }
      await route.fallback();
    });
    await checkDuplicatesOfOnePlay(page, library);
    await expect(page.locator('text=Found 1 duplicates')).toBeVisible({ timeout: 30000 });
  });
});

test.describe('Invalid session key', () => {
  // Last.fm error 9. A stored session key can stop working while the user is
  // away (production data: mostly people who had signed in again on another
  // device or browser). It used to be treated as ten per-track failures, and
  // the dead key was kept, so every later visit failed the same way.
  const INVALID_SESSION = { error: 9, message: 'Invalid session key - Please re-authenticate' };
  const FRESH_KEY = 'fresh-session-key';

  function requestParams(route: Route) {
    return new URLSearchParams(
      route.request().method() === 'POST'
        ? route.request().postData() || ''
        : new URL(route.request().url()).search,
    );
  }

  // A hash-only change is a same-document navigation, which would not remount
  // the app or re-run the token exchange. Leave the page first.
  async function loadFresh(page: Page, url: string) {
    await page.goto('about:blank');
    await page.goto(url);
  }

  function savedQueue(count: number) {
    return {
      userName: 'testuser',
      totalTracks: count,
      completedIndices: [],
      failedIndices: [],
      tracks: Array.from({ length: count }, (_, i) => ({
        track: `Track ${i + 1}`, artist: `Artist ${i + 1}`, album: '', timestamp: Date.UTC(2024, 0, i + 1),
      })),
      originalTotalTracks: count,
      originalSucceededCount: 0,
      sendTimestamps: [],
      burstCount: 0,
      dailyCount: 0,
      dailyCountDate: new Date().toISOString().split('T')[0],
      savedAt: new Date().toISOString(),
    };
  }

  test('a revoked session key stops at once, and signing in again finishes the import', async ({ page }) => {
    test.setTimeout(60000);
    const scrobbleKeys: string[] = [];
    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = requestParams(route);
      const apiMethod = params.get('method');
      if (apiMethod === 'track.scrobble') {
        scrobbleKeys.push(params.get('sk') || '');
        if (params.get('sk') === FRESH_KEY) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }),
          });
        } else {
          await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(INVALID_SESSION) });
        }
        return;
      }
      if (apiMethod === 'auth.getSession') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ session: { name: 'testuser', key: FRESH_KEY, subscriber: 0 } }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSavedState(page, savedQueue(12));
    await page.reload();

    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    const signInAgain = page.getByRole('link', { name: /sign in to last\.fm again/i });
    await expect(signInAgain).toBeVisible({ timeout: 10000 });
    await expect(signInAgain).toHaveAttribute('href', /last\.fm\/api\/auth/);
    // The key is the problem, not the track: one request, not ten, and no
    // track is written off as failed.
    expect(scrobbleKeys).toHaveLength(1);
    await expect(page.locator('text=failed in a row')).toHaveCount(0);
    await expect(page.locator('text=failed track(s)')).toHaveCount(0);
    // Retrying with the same dead key can only fail again.
    await expect(page.getByRole('button', { name: 'Try Again Now' })).toHaveCount(0);
    await expect(page.locator('text=saved automatically')).toBeVisible();
    // ...and it must not be picked up again on the next visit.
    expect(await page.evaluate(() => localStorage.getItem('scrobblifyLfmAuthKey'))).toBeNull();

    // Coming back later lands signed out on upload, with the whole queue still waiting.
    await page.reload();
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Currently authenticated as')).toHaveCount(0);
    await expect(page.locator('text=Resume previous session?')).toBeVisible();

    // Returning from Last.fm's authorize page with a fresh token.
    await loadFresh(page, '/#/scrobble?token=fresh-token');
    // Upload shows at once; the name shows once the token has been exchanged.
    await expect(page.locator('text=Currently authenticated as: testuser')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.locator('text=12 tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();
    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 30000 });
    expect(scrobbleKeys.slice(1)).toEqual(Array(12).fill(FRESH_KEY));
  });

  test('signing in again replaces a stored session key', async ({ page }) => {
    // Regression: init() only exchanged a callback token when no key was
    // stored, so re-authorizing with a dead key threw the fresh token away and
    // kept the dead one. Production users re-authorized a dozen times each.
    const getSessionRequests: URLSearchParams[] = [];
    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = requestParams(route);
      if (params.get('method') === 'auth.getSession') {
        getSessionRequests.push(params);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ session: { name: 'testuser', key: FRESH_KEY, subscriber: 0 } }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await loadFresh(page, '/#/scrobble?token=fresh-token');
    // Upload shows at once; the name shows once the token has been exchanged.
    await expect(page.locator('text=Currently authenticated as: testuser')).toBeVisible({ timeout: 10000 });

    expect(getSessionRequests).toHaveLength(1);
    // The old key must not ride along on (and be signed into) the exchange.
    expect(getSessionRequests[0].get('sk')).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('scrobblifyLfmAuthKey'))).toBe(FRESH_KEY);
  });

  test('a sign-in link that cannot be exchanged does not log out a stored session', async ({ page }) => {
    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      if (requestParams(route).get('method') === 'auth.getSession') {
        await route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: 4, message: 'Unauthorized Token - This token has not been issued.' }),
        });
        return;
      }
      await route.fallback();
    });

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await loadFresh(page, '/#/scrobble?token=already-used-token');
    await expect(page.locator('text=Currently authenticated as: testuser')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=/already used or has expired/i')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('scrobblifyLfmAuthKey'))).toBe('fake-session-key');
  });

  // Records every track.scrobble request and accepts it.
  async function recordScrobbles(page: Page, scrobbled: string[]) {
    await interceptLastFm(page);
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = requestParams(route);
      if (params.get('method') === 'track.scrobble') {
        scrobbled.push(params.get('track[0]') || '');
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } }),
        });
        return;
      }
      await route.fallback();
    });
  }

  test('resuming without a session key asks to sign in and leaves the saved progress alone', async ({ page }) => {
    // Regression: after a rejected key is cleared the username stays behind,
    // which was all the resume checked. It jumped to the scrobble step with no
    // key, every track failed as "Not authenticated." within ~100ms, and the
    // nine consumed by the failures were saved as completed — never sent.
    test.setTimeout(60000);
    const scrobbled: string[] = [];
    await recordScrobbles(page, scrobbled);

    await page.goto('/#/scrobble');
    // What `clearSessionKey()` leaves behind: a username but no key.
    await page.evaluate(() => localStorage.setItem('scrobblifyLfmUserName', 'testuser'));
    const seeded = savedQueue(12);
    await seedSavedState(page, seeded);
    await page.reload();

    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();

    await expect(page.locator('text=Sign in to Last.fm first, then choose Resume.')).toBeVisible({ timeout: 5000 });
    const signIn = page.getByRole('button', { name: 'Sign in to Last.fm', exact: true });
    await expect(signIn).toBeVisible();
    await expect(page.locator('.upload-step')).toBeVisible();
    await expect(page.locator('text=12 tracks ready to scrobble')).toBeHidden();

    await page.waitForTimeout(1000);
    expect(scrobbled).toHaveLength(0);
    expect(await readSavedState(page)).toEqual(seeded);

    // The banner's button goes to Last.fm's authorize page; back from it, the
    // same progress resumes by itself, ready to send.
    await routeLastFmSignIn(page);
    await signIn.click();
    await expect(page.locator('text=Currently authenticated as: testuser')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=12 tracks ready to scrobble')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=Sign in to Last.fm first')).toHaveCount(0);
    expect(scrobbled).toHaveLength(0);
  });

  test('a run with no session key stops on the first track without using it up', async ({ page }) => {
    // Any route into the loop that skips signing in must not burn tracks: the
    // missing key used to be ten ordinary failures, nine of them consumed.
    test.setTimeout(60000);
    const scrobbled: string[] = [];
    await recordScrobbles(page, scrobbled);

    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSavedState(page, savedQueue(12));
    await page.reload();

    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.locator('text=12 tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
    await page.waitForTimeout(2500);
    // Lose the key behind the resume guard's back.
    await page.evaluate(() => {
      (document.querySelector('#app') as any).__vue_app__.config.globalProperties.$store.state.lfmApi.clearSessionKey();
    });
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    const signIn = page.getByRole('link', { name: /sign in to last\.fm again/i });
    await expect(signIn).toBeVisible({ timeout: 10000 });
    await expect(signIn).toHaveAttribute('href', /last\.fm\/api\/auth/);
    await expect(page.locator('text=not signed in to Last.fm')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try Again Now' })).toHaveCount(0);
    await expect(page.locator('text=failed track(s)')).toHaveCount(0);
    await expect(page.locator('text=saved automatically')).toBeVisible();
    expect(scrobbled).toHaveLength(0);

    await expect.poll(async () => {
      const saved = await readSavedState(page);
      return saved && {
        total: saved.totalTracks, completed: saved.completedIndices, failed: saved.failedIndices,
      };
    }).toEqual({ total: 12, completed: [], failed: [] });
  });
});

test.describe('Stale build detection', () => {
  // Matches with or without a query string.
  const VERSION_JSON = (url: URL) => url.pathname.endsWith('/scrobblify/version.json');
  const BUILD_CHECK = '#site-footer span[data-build-check]';

  function serveVersion(page: Page, sha: () => string, run: () => number = () => 999999) {
    return page.route(VERSION_JSON, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sha: sha(), run: run() }),
    }));
  }

  async function runningSha(page: Page): Promise<string> {
    const title = await page.locator('#site-footer span[title]').getAttribute('title');
    return (title || '').split(' ')[0];
  }

  // The footer reads "<sha> · Build <run>"; see buildLabel in App.vue.
  async function runningRun(page: Page): Promise<number> {
    const title = await page.locator('#site-footer span[title]').getAttribute('title');
    const run = (title || '').split(' ').pop() || '';
    expect(run, 'the test server must be a numbered build; see playwright.config.ts').toMatch(/^\d+$/);
    return Number(run);
  }

  test('ignores a version.json from an older build than the running one (#138)', async ({ page }) => {
    const events = captureEvents(page);
    let answer: { sha: string; run: number } | null = null;
    await page.route(VERSION_JSON, (route) => (answer
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer) })
      : route.fulfill({ status: 404, body: 'Not found' })));
    await page.goto('/');
    await expect(page.locator(BUILD_CHECK)).toHaveAttribute('data-build-check', 'unknown');
    const run = await runningRun(page);

    // A browser-cached answer from an earlier deploy: different sha, lower run.
    answer = { sha: '0137860', run: run - 1 };
    await page.reload();
    await expect(page.locator(BUILD_CHECK)).toHaveAttribute('data-build-check', 'unknown');
    await expect(page.locator('#update-available')).toHaveCount(0);
    expect(events.filter((e) => e.name === 'stale_build_detected')).toEqual([]);
    expect(events.filter((e) => e.name === 'stale_build_older_ignored').map((e) => e.props))
      .toEqual([expect.objectContaining({ fetched_sha: '0137860', fetched_run: run - 1 })]);

    answer = { sha: '0000000', run: run + 1 };
    await page.reload();
    await expect(page.locator('#update-available')).toBeVisible({ timeout: 10000 });
    await expect(page.locator(BUILD_CHECK)).toHaveAttribute('data-build-check', 'stale');
  });

  test('asks for version.json at a fresh URL on every check, so no cached answer is reused', async ({ page }) => {
    const urls: string[] = [];
    await page.route(VERSION_JSON, (route) => {
      urls.push(route.request().url());
      return route.fulfill({ status: 404, body: 'Not found' });
    });
    await page.goto('/');
    await expect(page.locator(BUILD_CHECK)).toHaveAttribute('data-build-check', 'unknown');
    await page.reload();
    await expect(page.locator(BUILD_CHECK)).toHaveAttribute('data-build-check', 'unknown');
    await expect.poll(() => urls.length).toBe(2);
    expect(new Set(urls).size).toBe(2);
  });

  test('offers a reload when a newer build is deployed, and clears once current', async ({ page }) => {
    let deployed = '0000000';
    await serveVersion(page, () => deployed);
    await page.goto('/');

    const banner = page.locator('#update-available');
    await expect(banner).toBeVisible({ timeout: 10000 });
    await expect(banner).toContainText('newer version of Scrobblify');
    await expect(page.locator('#site-footer span[data-build-check]')).toHaveAttribute('data-build-check', 'stale');

    deployed = await runningSha(page);
    await Promise.all([
      page.waitForEvent('load'),
      banner.getByRole('button', { name: 'Reload' }).click(),
    ]);
    await expect(page.locator('#site-footer span[data-build-check]')).toHaveAttribute('data-build-check', 'current');
    await expect(banner).toHaveCount(0);
  });

  test('stays quiet when version.json is missing or unreadable', async ({ page }) => {
    await page.route(VERSION_JSON, (route) => route.fulfill({ status: 404, body: 'Not found' }));
    await page.goto('/');
    await expect(page.locator('#site-footer span[data-build-check]')).toHaveAttribute('data-build-check', 'unknown');
    await expect(page.locator('#update-available')).toHaveCount(0);

    await page.unroute(VERSION_JSON);
    await page.route(VERSION_JSON, (route) => route.fulfill({
      status: 200, contentType: 'text/html', body: '<!DOCTYPE html><html></html>',
    }));
    await page.reload();
    await expect(page.locator('#site-footer span[data-build-check]')).toHaveAttribute('data-build-check', 'unknown');
    await expect(page.locator('#update-available')).toHaveCount(0);
  });

  test('hides the reload prompt while a run is scrobbling', async ({ page }) => {
    await serveVersion(page, () => '0000000');
    await goToUploadStep(page);
    const banner = page.locator('#update-available');
    await expect(banner).toBeVisible({ timeout: 10000 });

    // Hold every scrobble until released, so the run is observably in flight.
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    await page.route('https://ws.audioscrobbler.com/**', async (route) => {
      const params = new URLSearchParams(route.request().postData() || '');
      if (params.get('method') === 'track.scrobble') {
        await released;
      }
      await route.fallback();
    });

    await page.locator('.drop-zone input[type="file"]').setInputFiles(FIXTURE_ZIP);
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();
    await page.locator('.upload-step button:has-text("Choose which tracks to scrobble")').click({ timeout: 30000 });
    await page.locator('button:has-text("matching")').click();
    await scrobbleSelection(page);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    await expect(page.locator('text=Scrobbling...')).toBeVisible({ timeout: 10000 });
    await expect(banner).toHaveCount(0);

    release();
    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 30000 });
    await expect(banner).toBeVisible();
  });
});

test.describe('Browser storage unavailable', () => {
  const JOURNAL_KEY = 'scrobblify.background.inflightSecond';
  const STOPPED = "text=couldn't store data in this browser >> visible=true";
  const SAVE_FAILED = "text=couldn't save your progress in this browser >> visible=true";

  // The journal write fails the way a full localStorage does.
  async function blockJournal(page: Page) {
    await page.addInitScript((key) => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItem(this: Storage, k: string, v: string) {
        if (k === key) {
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        }
        return original.call(this, k, v);
      };
    }, JOURNAL_KEY);
  }

  // From here on IndexedDB refuses this site, as Firefox does with storage
  // blocked. Installed after load, so the page gets as far as the scrobble step.
  async function blockIndexedDb(page: Page) {
    await page.evaluate(() => {
      IDBFactory.prototype.open = function open() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      };
    });
  }

  async function countScrobbles(page: Page): Promise<string[]> {
    const scrobbled: string[] = [];
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(
        route.request().method() === 'POST'
          ? route.request().postData() || ''
          : new URL(route.request().url()).search,
      );
      if (params.get('method') === 'track.scrobble') {
        scrobbled.push(params.get('track[0]') || '');
      }
      await route.fallback();
    });
    return scrobbled;
  }

  async function selectBackdatedImport(page: Page) {
    await page.locator('.drop-zone input[type="file"]').setInputFiles(FIXTURE_ZIP);
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();
    await expect(page.locator('.upload-step button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
    await page.locator('.upload-step button:has-text("Choose which tracks to scrobble")').click();
    await page.locator('button:has-text("matching")').click();
    await scrobbleSelection(page);
    await expect(page.locator('text=tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
  }

  function stopEvent(events: Tracked[]) {
    return events.find((e) => e.name === 'scrobble_stopped');
  }

  test('a backdated play the journal cannot record is not sent, and the stop says why', async ({ page }) => {
    test.setTimeout(90000);
    const events = captureEvents(page);
    await blockJournal(page);
    await goToUploadStep(page);
    const scrobbled = await countScrobbles(page);
    await selectBackdatedImport(page);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    await expect(page.locator(STOPPED)).toBeVisible({ timeout: 20000 });
    // IndexedDB still works here, so this one really was saved.
    await expect(page.locator('text=saved automatically')).toBeVisible();
    await expect(page.locator(SAVE_FAILED)).toHaveCount(0);
    expect(scrobbled).toEqual([]);
    await expect.poll(() => stopEvent(events)?.props).toMatchObject({
      reason: 'retag_journal_unavailable',
      storage_failure: 'QuotaExceededError',
      auto_saved: true,
    });
  });

  test('when nothing can be stored, the page says so and still hands over a file', async ({ page }) => {
    test.setTimeout(90000);
    const events = captureEvents(page);
    await blockJournal(page);
    await goToUploadStep(page);
    const scrobbled = await countScrobbles(page);
    await selectBackdatedImport(page);
    await blockIndexedDb(page);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    await expect(page.locator(STOPPED)).toBeVisible({ timeout: 20000 });
    await expect(page.locator(SAVE_FAILED)).toBeVisible();
    await expect(page.locator('text=saved automatically')).toHaveCount(0);
    expect(scrobbled).toEqual([]);
    await expect.poll(() => stopEvent(events)?.props).toMatchObject({
      reason: 'retag_journal_unavailable',
      auto_saved: false,
    });

    // The download must not depend on the browser save that just failed.
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Save Progress & Leave' }).click();
    expect((await download).suggestedFilename()).toMatch(/^scrobblify-progress-.*\.json$/);
    await expect(page.locator('text=downloaded as a file instead >> visible=true')).toBeVisible();
    expect(events.find((e) => e.name === 'session_saved')?.props).toMatchObject({ saved_in_browser: false });
  });

  test('a queue with no identity that cannot be given one is not sent', async ({ page }) => {
    test.setTimeout(90000);
    const events = captureEvents(page);
    await interceptLastFm(page);
    const scrobbled = await countScrobbles(page);
    // A save from before import identities existed: no `importId`.
    const tracks = [1, 2, 3].map((n) => ({
      track: `Track ${n}`,
      artist: `Artist ${n}`,
      album: `Album ${n}`,
      timestamp: Date.UTC(2024, 0, n),
      reTagged: true,
    }));
    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSavedState(page, {
      userName: 'testuser',
      totalTracks: 3,
      completedIndices: [],
      failedIndices: [],
      tracks,
      originalTotalTracks: 3,
      originalSucceededCount: 0,
      sendTimestamps: [],
      burstCount: 0,
      dailyCount: 0,
      dailyCountDate: new Date().toISOString().split('T')[0],
      savedAt: new Date().toISOString(),
    });
    await page.reload();
    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.locator('text=3 tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
    await blockIndexedDb(page);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();

    await expect(page.locator(STOPPED)).toBeVisible({ timeout: 20000 });
    await expect(page.locator(SAVE_FAILED)).toBeVisible();
    expect(scrobbled).toEqual([]);
    await expect.poll(() => stopEvent(events)?.props).toMatchObject({
      reason: 'retag_identity_unavailable',
      storage_failure: 'SecurityError',
      auto_saved: false,
    });
  });
});
