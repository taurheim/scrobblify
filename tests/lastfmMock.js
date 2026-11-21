// Shared Last.fm mock used by three callers:
//
//   * the Playwright suite (scrobblify.spec.ts), via `interceptLastFm`;
//   * the dev server's mock middleware (vue.config.js), via `handleLastFm`;
//   * anyone running `npm run dev:mock`, which is the middleware above.
//
// The canned responses live in `handleLastFm`, which knows nothing about
// Playwright or Node HTTP. That split is the point: `dev:mock` and the test
// suite have to agree about what Last.fm returns, and the surest way to make
// them agree is to give them one implementation and two thin transports.
//
// The library is stateful, because the app reads it back to confirm what was
// stored. Like the real Last.fm, it keeps at most `dailyCap` scrobbles per UTC
// day of the scrobble's timestamp and answers the rest as accepted anyway.

/** Username every mocked session authenticates as. */
const MOCK_USER = 'testuser';

/** Session key handed back by auth.getSession. The real API rejects it. */
const MOCK_SESSION_KEY = 'fake-session-key';

const DEFAULT_DAILY_CAP = 750;
const SECONDS_PER_DAY = 24 * 60 * 60;

/** Last.fm's answer to an unsigned read of a profile with hidden recent listening. */
const LOGIN_REQUIRED = { error: 17, message: 'Login: User required to be logged in' };

/**
 * @param {number} dailyCap
 * @param {{ hiddenProfile?: boolean, recentTracksError?: number }} options
 *   `hiddenProfile`: the user hides their recent listening, so an *unsigned*
 *   `user.getrecenttracks` is refused with error 17 and only a request signed
 *   with their session key is answered. `recentTracksError`: every
 *   `user.getrecenttracks`, signed or not, fails with this Last.fm error code.
 */
function createLibrary(dailyCap = DEFAULT_DAILY_CAP, { hiddenProfile = false, recentTracksError = 0 } = {}) {
  const plays = [];
  const countOnDay = (uts) => {
    const day = Math.floor(uts / SECONDS_PER_DAY);
    return plays.filter((p) => Math.floor(p.uts / SECONDS_PER_DAY) === day).length;
  };
  return {
    plays,
    dailyCap,
    hiddenProfile,
    recentTracksError,
    /** Store a play as Last.fm would: silently not at all once its day is full. */
    add(play) {
      if (countOnDay(play.uts) < this.dailyCap) {
        plays.push(play);
      }
    },
    countOnDay,
  };
}

/**
 * Store the play a `track.scrobble` request carried, if its response says
 * Last.fm accepted it. Keyed on the *response* rather than on who produced it,
 * so a test that answers track.scrobble with its own route still fills the
 * library whenever its reply says accepted.
 *
 * @param {ReturnType<typeof createLibrary>} library
 * @param {URLSearchParams} params
 * @param {unknown} body the parsed JSON response
 */
function recordScrobble(library, params, body) {
  if (params.get('method') !== 'track.scrobble') {
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
        user: MOCK_USER,
        page: String(page),
        perPage: String(limit),
        total: String(inRange.length),
        totalPages: String(Math.max(1, Math.ceil(inRange.length / limit))),
      },
    },
  };
}

/**
 * The canned Last.fm API. Transport-free: hand it the request's merged
 * parameters (query string for GET, form body for POST) and the library it
 * reads back from, and it returns a response description that both
 * `route.fulfill` and a Node `ServerResponse` can serve.
 *
 * It does not store scrobbles itself: the transport passes the response it
 * served to `recordScrobble`, which is what lets a Playwright test override
 * track.scrobble and still have accepted plays stored.
 *
 * @param {URLSearchParams} params
 * @param {ReturnType<typeof createLibrary>} library
 * @returns {{ status: number, contentType: string, body: string }}
 */
function handleLastFm(params, library) {
  const apiMethod = params.get('method');

  const json = (payload) => ({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  });

  if (apiMethod === 'auth.getSession') {
    return json({
      session: { name: MOCK_USER, key: MOCK_SESSION_KEY, subscriber: 0 },
    });
  }

  if (apiMethod === 'track.getInfo') {
    return json({
      track: {
        duration: '240000',
        name: params.get('track'),
        artist: { name: params.get('artist') },
      },
    });
  }

  if (apiMethod === 'user.getrecenttracks') {
    if (library.recentTracksError) {
      return { ...json({ error: library.recentTracksError, message: 'Mocked failure' }), status: 403 };
    }
    if (library.hiddenProfile && !(params.get('sk') && params.get('api_sig'))) {
      return { ...json(LOGIN_REQUIRED), status: 403 };
    }
    return json(recentTracksBody(library, params));
  }

  if (apiMethod === 'track.scrobble') {
    return json({ scrobbles: { '@attr': { accepted: 1, ignored: 0 } } });
  }

  return json({});
}

/**
 * Where a mocked `last.fm/api/auth` sends the browser back to.
 *
 * Handing back a *token* rather than pre-seeding localStorage is deliberate: it
 * makes the authenticate step run for real. The app receives a token exactly as
 * it would from Last.fm, exchanges it against the mocked `auth.getSession`, and
 * ends up authenticated through the ordinary code path instead of around it.
 *
 * The token is fresh on every call because `LastFm.init` records the token it
 * has begun exchanging in sessionStorage and refuses to re-submit it — real
 * Last.fm tokens are single-use. A constant here would make every authorisation
 * after the first silently do nothing.
 *
 * It rides in the query *after* the fragment because `router.ts` runs in hash
 * mode outside production, so the fragment is the route and `$route.query`
 * reads what follows it.
 *
 * @param {string} basePath where the dev server serves the app — `publicPath`
 *   from vue.config.js. Passed in rather than assumed to be `/`, because
 *   webpack only reliably serves the app at its publicPath.
 */
function lastFmAuthRedirect(basePath = '/') {
  const token = `mock-token-${Math.random().toString(16).slice(2, 10)}`;
  const base = basePath.endsWith('/') ? basePath : `${basePath}/`;
  return `${base}#/scrobble?token=${token}`;
}

function requestParams(request) {
  return new URLSearchParams(
    request.method() === 'POST' ? request.postData() || '' : new URL(request.url()).search,
  );
}

// Intercept all Last.fm API calls and fulfill them with fake data. Resolves to
// the mock's library, so a test can inspect what was really "stored" or
// pre-fill a day.
async function interceptLastFm(page, { dailyCap = DEFAULT_DAILY_CAP, ...options } = {}) {
  const library = createLibrary(dailyCap, options);

  page.on('response', async (response) => {
    const request = response.request();
    if (!request.url().startsWith('https://ws.audioscrobbler.com/') || response.status() !== 200) {
      return;
    }
    let body;
    try {
      body = await response.json();
    } catch (e) {
      return;
    }
    recordScrobble(library, requestParams(request), body);
  });

  await page.route('https://ws.audioscrobbler.com/**', async (route) => {
    await route.fulfill(handleLastFm(requestParams(route.request()), library));
  });

  return library;
}

// Seed localStorage so the app believes it's already authenticated with Last.fm.
// Must be called AFTER a page.goto() so we're on the same origin.
async function mockLastFmAuth(page) {
  await page.evaluate(([user, key]) => {
    localStorage.setItem('scrobblifyLfmAuthToken', 'fake-token');
    localStorage.setItem('scrobblifyLfmAuthKey', key);
    localStorage.setItem('scrobblifyLfmUserName', user);
  }, [MOCK_USER, MOCK_SESSION_KEY]);
}

// Stands in for Last.fm's authorize page: sends the browser straight back to
// the app's callback with a fresh token, which `interceptLastFm` exchanges for
// MOCK_USER. Fresh per request, because the app refuses to resubmit a token.
async function routeLastFmSignIn(page) {
  await page.route('https://www.last.fm/api/auth/**', (route) => route.fulfill({
    status: 302,
    // Absolute: a relative location would resolve against www.last.fm.
    headers: {
      location: `${new URL(page.url()).origin}/#/scrobble?token=t-${Math.random().toString(16).slice(2, 10)}`,
    },
  }));
}

module.exports = {
  interceptLastFm,
  mockLastFmAuth,
  routeLastFmSignIn,
  handleLastFm,
  createLibrary,
  recordScrobble,
  lastFmAuthRedirect,
  MOCK_USER,
  MOCK_SESSION_KEY,
};
