// Shared Last.fm mock used by both the Playwright test suite (scrobblify.spec.ts)
// and the interactive `npm run dev:mock` script (dev-mock.js).
//
// Intercepts every request to https://ws.audioscrobbler.com/** and returns
// canned responses, so the app can be exercised end-to-end without a real
// Last.fm account.

// Intercept all Last.fm API calls and fulfill them with fake data.
function interceptLastFm(page) {
  return page.route('https://ws.audioscrobbler.com/**', async (route) => {
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

// Seed localStorage so the app believes it's already authenticated with Last.fm.
// Must be called AFTER a page.goto() so we're on the same origin.
async function mockLastFmAuth(page) {
  await page.evaluate(() => {
    localStorage.setItem('scrobblifyLfmAuthToken', 'fake-token');
    localStorage.setItem('scrobblifyLfmAuthKey', 'fake-session-key');
    localStorage.setItem('scrobblifyLfmUserName', 'testuser');
  });
}

module.exports = { interceptLastFm, mockLastFmAuth };
