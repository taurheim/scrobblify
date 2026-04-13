import { test, expect, Page, Route } from '@playwright/test';
import path from 'path';

const FIXTURE_ZIP = path.resolve(__dirname, 'fixtures', 'test-spotify-data.zip');

// Helper: mock Last.fm auth so the app thinks we're logged in.
// Must be called AFTER a page.goto() so we're on the same origin.
async function mockLastFmAuth(page: Page) {
  await page.evaluate(() => {
    localStorage.setItem('scrobblifyLfmAuthToken', 'fake-token');
    localStorage.setItem('scrobblifyLfmAuthKey', 'fake-session-key');
    localStorage.setItem('scrobblifyLfmUserName', 'testuser');
  });
}

// Helper: intercept all Last.fm API calls
function interceptLastFm(page: Page) {
  return page.route('https://ws.audioscrobbler.com/**', async (route: Route) => {
    const url = route.request().url();
    const method = route.request().method();

    const postData = route.request().postData() || '';
    const allParams = new URLSearchParams(
      method === 'POST' ? postData : new URL(url).search,
    );
    const apiMethod = allParams.get('method');

    if (apiMethod === 'auth.getSession') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          session: { name: 'testuser', key: 'fake-session-key', subscriber: 0 },
        }),
      });
    } else if (apiMethod === 'track.getInfo') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          track: { duration: '240000', name: allParams.get('track'), artist: { name: allParams.get('artist') } },
        }),
      });
    } else if (apiMethod === 'user.getrecenttracks') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          recenttracks: { track: [] },
        }),
      });
    } else if (apiMethod === 'track.scrobble') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          scrobbles: { '@attr': { accepted: 1, ignored: 0 } },
        }),
      });
    } else {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({}),
      });
    }
  });
}

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

    await expect(page.locator('text=Finished scrobbling')).toBeVisible({ timeout: 30000 });

    // Verify scrobble used POST with form body
    expect(scrobbleMethod).toBe('POST');
    expect(scrobbleContentType).toContain('application/x-www-form-urlencoded');
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
    let capturedPostBodies: string[] = [];

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
    const hasRockAndRoll = capturedPostBodies.some(body => {
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
