// Shared Last.fm mock used by both the Playwright test suite (scrobblify.spec.ts)
// and the interactive `npm run dev:mock` script (dev-mock.js).
//
// Intercepts every request to https://ws.audioscrobbler.com/** and returns
// canned responses, so the app can be exercised end-to-end without a real
// Last.fm account.
//
// The library is stateful, because the app reads it back to confirm what was
// stored. Like the real Last.fm, it keeps at most `dailyCap` scrobbles per UTC
// day of the scrobble's timestamp and answers the rest as accepted anyway.

const DEFAULT_DAILY_CAP = 750;
const SECONDS_PER_DAY = 24 * 60 * 60;

function requestParams(request) {
  return new URLSearchParams(
    request.method() === 'POST' ? request.postData() || '' : new URL(request.url()).search,
  );
}

function createLibrary(dailyCap) {
  const plays = [];
  const countOnDay = (uts) => {
    const day = Math.floor(uts / SECONDS_PER_DAY);
    return plays.filter((p) => Math.floor(p.uts / SECONDS_PER_DAY) === day).length;
  };
  return {
    plays,
    dailyCap,
    /** Store a play as Last.fm would: silently not at all once its day is full. */
    add(play) {
      if (countOnDay(play.uts) < this.dailyCap) {
        plays.push(play);
      }
    },
    countOnDay,
  };
}

function recentTracksBody(library, params) {
  const from = Number(params.get('from') || 0);
  const to = Number(params.get('to') || Number.MAX_SAFE_INTEGER);
  const limit = Number(params.get('limit') || 50);
  const page = Number(params.get('page') || 1);
  const inRange = library.plays
    .filter((p) => p.uts >= from && p.uts <= to)
    .sort((a, b) => b.uts - a.uts);
  const slice = inRange.slice((page - 1) * limit, page * limit);
  return {
    recenttracks: {
      track: slice.map((p) => ({
        name: p.track,
        artist: { '#text': p.artist },
        album: { '#text': p.album },
        date: { uts: String(p.uts), '#text': new Date(p.uts * 1000).toUTCString() },
      })),
      '@attr': {
        user: 'testuser',
        page: String(page),
        perPage: String(limit),
        total: String(inRange.length),
        totalPages: String(Math.max(1, Math.ceil(inRange.length / limit))),
      },
    },
  };
}

// Intercept all Last.fm API calls and fulfill them with fake data. Resolves to
// the mock's library, so a test can inspect what was really "stored" or
// pre-fill a day.
async function interceptLastFm(page, { dailyCap = DEFAULT_DAILY_CAP } = {}) {
  const library = createLibrary(dailyCap);

  // Stored from the *response*, so a test that answers track.scrobble with its
  // own route still fills the library whenever its reply says accepted.
  page.on('response', async (response) => {
    const request = response.request();
    if (!request.url().startsWith('https://ws.audioscrobbler.com/') || response.status() !== 200) {
      return;
    }
    const params = requestParams(request);
    if (params.get('method') !== 'track.scrobble') {
      return;
    }
    let body;
    try {
      body = await response.json();
    } catch (e) {
      return;
    }
    const attr = (body && body.scrobbles && body.scrobbles['@attr']) || {};
    if (Number(attr.accepted) >= 1 && Number(attr.ignored || 0) === 0) {
      library.add({
        track: params.get('track[0]') || '',
        artist: params.get('artist[0]') || '',
        album: params.get('album[0]') || '',
        uts: Number(params.get('timestamp[0]')),
      });
    }
  });

  await page.route('https://ws.audioscrobbler.com/**', async (route) => {
    const allParams = requestParams(route.request());
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
        body: JSON.stringify(recentTracksBody(library, allParams)),
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

  return library;
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
