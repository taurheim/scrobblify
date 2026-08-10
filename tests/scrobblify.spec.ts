import {
  test, expect, Page, Route,
} from '@playwright/test';
import path from 'path';
import JSZip from 'jszip';
import LastFm from '../src/api/LastFm';
import Scrobble from '../src/models/Scrobble';
// Shared Last.fm mock, also used by the `npm run dev:mock` interactive script.
import { interceptLastFm, mockLastFmAuth } from './lastfmMock';

const FIXTURE_ZIP = path.resolve(__dirname, 'fixtures', 'test-spotify-data.zip');

// Navigate past auth (step 1 -> step 2) with mocked auth
async function goToUploadStep(page: Page) {
  await interceptLastFm(page);
  // Navigate first to establish origin for localStorage
  await page.goto('/#/scrobble');
  await mockLastFmAuth(page);
  // Reload so init() re-reads from localStorage
  await page.reload();
  // Auth step should auto-complete since we're "authenticated"
  await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
}

test.describe('Home Page', () => {
  test('renders home page with instructions', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('body')).toContainText('Scrobblify');
  });

  test('has navigation links', async ({ page }) => {
    await page.goto('/');
    // Should have a link to scrobble
    await expect(page.locator('a[href*="scrobble"]').first()).toBeVisible();
  });
});

test.describe('About Page', () => {
  test('renders about page', async ({ page }) => {
    await page.goto('/#/about');
    await expect(page.locator('body')).toContainText('Scrobblify');
  });
});

test.describe('Scrobble Page - Authentication Step', () => {
  test('shows authentication step by default', async ({ page }) => {
    await page.goto('/#/scrobble');
    await expect(page.locator('h1:has-text("Authorize")')).toBeVisible({ timeout: 5000 });
  });

  test('shows Last.fm auth link', async ({ page }) => {
    await page.goto('/#/scrobble');
    await expect(page.locator('a[href*="last.fm/api/auth"]')).toBeVisible({ timeout: 5000 });
  });

  test('auto-advances when already authenticated', async ({ page }) => {
    await interceptLastFm(page);
    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await page.reload();
    // Should auto-advance past step 1 to the upload step
    await expect(page.locator('.upload-step')).toBeVisible({ timeout: 10000 });
  });

  test('does not re-exchange a single-use token when the callback URL is revisited', async ({ page }) => {
    // Regression: Last.fm auth tokens are single-use. If the callback URL is
    // re-loaded while it still carries the token (in-flight refresh, browser
    // restoring the tab, duplicate load), the consumed token must NOT be sent to
    // auth.getSession again — Last.fm rejects re-use with error 4 "Unauthorized
    // Token - This token has not been issued".
    let getSessionCount = 0;
    await page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
      const params = new URLSearchParams(new URL(route.request().url()).search);
      if (params.get('method') === 'auth.getSession') {
        getSessionCount++;
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

    await page.goto('/#/scrobble?token=single-use-token');
    await expect.poll(() => getSessionCount, { timeout: 10000 }).toBe(1);

    // Revisit the callback URL with the same token still present.
    await page.goto('/#/scrobble?token=single-use-token');
    // Wait for init() to settle (the "checking auth" spinner clears once the
    // token exchange is skipped) rather than an arbitrary delay.
    await expect(page.locator('text=Checking for authentication')).toBeHidden({ timeout: 10000 });
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

test.describe('Upload Step - ZIP Drag & Drop', () => {
  test('shows upload zone when authenticated', async ({ page }) => {
    await goToUploadStep(page);
    await expect(page.locator('.drop-zone')).toBeVisible();
    await expect(page.locator('text=Drag')).toBeVisible();
  });

  test('accepts ZIP file via file picker', async ({ page }) => {
    await goToUploadStep(page);
    const fileInput = page.locator('input[type="file"][accept=".zip"]');
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
    const fileInput = page.locator('input[type="file"][accept=".zip"]');
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
    const fileInput = page.locator('input[type="file"][accept=".zip"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);

    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();

    await expect(page.locator('text=5 plays')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('text=/Failed to parse/i')).toHaveCount(0);
    expect(pageErrors.join('\n')).not.toContain('Unrecognized token');
  });

  test('parses ZIP and shows track count', async ({ page }) => {
    await goToUploadStep(page);
    const fileInput = page.locator('input[type="file"][accept=".zip"]');
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
    const fileInput = page.locator('input[type="file"][accept=".zip"]');
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
    const fileInput = page.locator('input[type="file"][accept=".zip"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);

    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();

    // Wait for processing to complete
    await expect(page.locator('button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
    await page.locator('button:has-text("Choose which tracks to scrobble")').click();

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
    const fileInput = page.locator('input[type="file"][accept=".zip"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);
    // Don't check "Scrobble tracks older than 2 weeks" — keep original dates
    await page.locator('button:has-text("Find tracks")').click();
    await expect(page.locator('button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
    await page.locator('button:has-text("Choose which tracks to scrobble")').click();
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

  test('add matching + scrobble advances to scrobble step', async ({ page }) => {
    await goToSelectStep(page);
    await page.locator('button:has-text("matching")').click();
    await page.locator('button:has-text("selected tracks")').click();
    // Should advance to step 4 - the scrobble step
    await expect(page.locator('text=tracks ready to scrobble')).toBeVisible({ timeout: 5000 });
  });
});

test.describe('Scrobble Step', () => {
  async function goToScrobbleStep(page: Page) {
    await goToUploadStep(page);
    const fileInput = page.locator('input[type="file"][accept=".zip"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);

    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();

    await expect(page.locator('button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
    await page.locator('button:has-text("Choose which tracks to scrobble")').click();

    await expect(page.locator('button:has-text("matching")')).toBeVisible({ timeout: 5000 });
    await page.locator('button:has-text("matching")').click();
    await page.locator('button:has-text("selected tracks")').click();

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

    const fileInput = page.locator('input[type="file"][accept=".zip"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();

    await expect(page.locator('button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
    await page.locator('button:has-text("Choose which tracks to scrobble")').click();

    await expect(page.locator('button:has-text("matching")')).toBeVisible({ timeout: 5000 });
    await page.locator('button:has-text("matching")').click();
    await page.locator('button:has-text("selected tracks")').click();

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

    const fileInput = page.locator('input[type="file"][accept=".zip"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();

    await expect(page.locator('button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
    await page.locator('button:has-text("Choose which tracks to scrobble")').click();

    await expect(page.locator('button:has-text("matching")')).toBeVisible({ timeout: 5000 });
    await page.locator('button:has-text("matching")').click();
    await page.locator('button:has-text("selected tracks")').click();

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

    const fileInput = page.locator('input[type="file"][accept=".zip"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();

    await expect(page.locator('button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
    await page.locator('button:has-text("Choose which tracks to scrobble")').click();

    await expect(page.locator('button:has-text("matching")')).toBeVisible({ timeout: 5000 });
    await page.locator('button:has-text("matching")').click();
    await page.locator('button:has-text("selected tracks")').click();

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

    // Outlast AuthenticateStep's delayed `complete` emit before interacting, so
    // the click can't race the stepper transition it used to trigger.
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Scrobble', exact: true }).click();
    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 30000 });

    expect(scrobbled).toEqual(['Track 4', 'Track 5']);
  });

  test('resuming immediately is not undone by the delayed auth redirect', async ({ page }) => {
    // Regression: AuthenticateStep emits `complete` on a 2s setTimeout. Resuming
    // inside that window used to jump to the scrobble step and then get dragged
    // back to the upload step, silently losing the resumed session.
    await interceptLastFm(page);
    await page.goto('/#/scrobble');
    await mockLastFmAuth(page);
    await seedSavedState(page, buildState());
    await page.reload();

    await expect(page.locator('text=Resume previous session?')).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(page.locator('text=2 tracks ready to scrobble')).toBeVisible({ timeout: 5000 });

    // Outlast the delayed auth emit, then confirm we're still on the scrobble step.
    await page.waitForTimeout(4000);
    await expect(page.locator('text=2 tracks ready to scrobble')).toBeVisible();
    await expect(page.locator('.upload-step')).toBeHidden();
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
    await expect(page.locator('text=risk duplicating them')).toBeVisible({ timeout: 15000 });
    expect(sent).toHaveLength(0);
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

  // Reads whatever `StateManager` last wrote, so these assert the real save
  // path rather than a hand-built fixture.
  async function readSavedState(page: Page): Promise<Record<string, any> | null> {
    return page.evaluate(async () => new Promise<any>((resolve, reject) => {
      const request = indexedDB.open('scrobblify', 1);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('scrobbleState', 'readonly');
        const get = tx.objectStore('scrobbleState').get('current');
        get.onsuccess = () => { db.close(); resolve(get.result ?? null); };
        get.onerror = () => { db.close(); reject(get.error); };
      };
      request.onerror = () => reject(request.error);
    }));
  }

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

    await page.locator('input[type="file"][accept=".zip"]').setInputFiles(FIXTURE_ZIP);
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();
    await expect(page.locator('button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
    await page.locator('button:has-text("Choose which tracks to scrobble")').click();
    await page.locator('button:has-text("matching")').click();
    await page.locator('button:has-text("selected tracks")').click();
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
    // The backoff ladder spans ~50 minutes, so time is faked. With the clock
    // frozen nothing advances on its own — including the API client's own retry
    // backoff — so the clock has to be driven forward while polling.
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

    // Advance simulated time until the loop reaches a terminal state, recording
    // whether the escalating backoff was surfaced along the way.
    let sawFirstBackoff = false;
    let gaveUp = false;
    for (let i = 0; i < 250 && !gaveUp; i++) {
      // eslint-disable-next-line no-await-in-loop
      await page.clock.runFor(30 * 1000);
      // eslint-disable-next-line no-await-in-loop
      await page.waitForTimeout(50);
      if (!sawFirstBackoff) {
        // eslint-disable-next-line no-await-in-loop
        sawFirstBackoff = await page.locator('text=attempt 1 of 3').isVisible();
      }
      // eslint-disable-next-line no-await-in-loop
      gaveUp = await page.locator('text=still rate limiting your account').isVisible();
    }

    // The user is told how long we'll wait, instead of a bare 1-minute countdown.
    expect(sawFirstBackoff).toBe(true);
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

    const fileInput = page.locator('input[type="file"][accept=".zip"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();

    await expect(page.locator('button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
    await page.locator('button:has-text("Choose which tracks to scrobble")').click();

    await expect(page.locator('button:has-text("matching")')).toBeVisible({ timeout: 5000 });
    await page.locator('button:has-text("matching")').click();
    await page.locator('button:has-text("selected tracks")').click();

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

    // Should go back to step 1 (auth step)
    await expect(page.locator('h1:has-text("Authorize")')).toBeVisible({ timeout: 5000 });

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

    const fileInput = page.locator('input[type="file"][accept=".zip"]');
    await fileInput.setInputFiles(FIXTURE_ZIP);
    await page.locator('label:has-text("Scrobble tracks older than 2 weeks")').click();
    await page.locator('button:has-text("Find tracks")').click();

    await expect(page.locator('button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });
    await page.locator('button:has-text("Choose which tracks to scrobble")').click();

    await expect(page.locator('button:has-text("matching")')).toBeVisible({ timeout: 5000 });
    await page.locator('button:has-text("matching")').click();
    await page.locator('button:has-text("selected tracks")').click();

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
      'risk duplicating them',
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

    // Planted before anything runs: an earlier import that crashed between
    // choosing a second and hearing whether Last.fm stored the play.
    await page.addInitScript(([id, key]) => {
      window.localStorage.setItem('scrobblify.background.inflightSecond', JSON.stringify([
        {
          importId: id, trackKey: key, sec: 1700000000, at: Date.now(),
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
    await expect(page.locator('.v-expansion-panel-header')).toContainText(`${timestamps.length} failed track(s)`);
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
  // Builds a ZIP in-memory so each test can decide exactly how the history
  // files are damaged, without checking another binary fixture into the repo.
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
    await page.locator('input[type="file"][accept=".zip"]').setInputFiles({
      name: 'my_spotify_data.zip',
      mimeType: 'application/zip',
      buffer,
    });
  }

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
    await expect(page.locator('button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 15000 });
  });

  test('a ZIP where every history file is unreadable still reports an error', async ({ page }) => {
    await goToUploadStep(page);

    await uploadZip(page, await makeZip({
      'Streaming_History_Audio_2024_0.json': 'not json at all',
    }));

    await page.locator('button:has-text("Find tracks")').click();
    await expect(page.locator('text=None of the 1 history file(s) in this ZIP could be read')).toBeVisible({ timeout: 15000 });
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
    await expect(page.locator('button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 15000 });
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
    await expect(page.locator('button:has-text("Choose which tracks to scrobble")')).toBeVisible({ timeout: 30000 });

    expect(ranges.length).toBeGreaterThan(0);
    for (const range of ranges) {
      // Last.fm documents UNIX timestamps; "1784563202.848" is not one.
      expect(range.from).toMatch(/^\d+$/);
      expect(range.to).toMatch(/^\d+$/);
    }
  });
});
