import {
  test, expect, Page, Route,
} from '@playwright/test';
import path from 'path';
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

    await expect(page.locator('body')).toContainText('Finished scrobbling', { timeout: 30000 });

    // Verify scrobble used POST with form body
    expect(scrobbleMethod).toBe('POST');
    expect(scrobbleContentType).toContain('application/x-www-form-urlencoded');
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
    scrobbleResponse: object | ((attempt: number) => object | 'abort'),
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
          ? scrobbleResponse(scrobbleAttempts)
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
    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 30000 });

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

  test('a scrobble Last.fm ignored is reported as failed, not scrobbled', async ({ page }) => {
    const timestamps = await runReTaggedImport(page, {
      scrobbles: {
        '@attr': { accepted: 0, ignored: 1 },
        scrobble: { ignoredMessage: { code: '3', '#text': 'Timestamp too old' } },
      },
    });

    expect(timestamps.length).toBeGreaterThan(0);
    // The scrobble step is still mounted but hidden once the stepper advances,
    // so assert on text content rather than visibility.
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
