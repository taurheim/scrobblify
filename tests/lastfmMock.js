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

/** Username every mocked session authenticates as. */
const MOCK_USER = 'testuser';

/** Session key handed back by auth.getSession. The real API rejects it. */
const MOCK_SESSION_KEY = 'fake-session-key';

/**
 * The canned Last.fm API. Transport-free: hand it the request's merged
 * parameters (query string for GET, form body for POST) and it returns a
 * response description that both `route.fulfill` and a Node `ServerResponse`
 * can serve.
 *
 * @param {URLSearchParams} params
 * @returns {{ status: number, contentType: string, body: string }}
 */
function handleLastFm(params) {
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
    return json({ recenttracks: { track: [] } });
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

// Intercept all Last.fm API calls and fulfill them with fake data.
function interceptLastFm(page) {
  return page.route('https://ws.audioscrobbler.com/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const postData = request.postData() || '';

    const params = new URLSearchParams(
      method === 'POST' ? postData : new URL(request.url()).search,
    );

    await route.fulfill(handleLastFm(params));
  });
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

module.exports = {
  interceptLastFm,
  mockLastFmAuth,
  handleLastFm,
  lastFmAuthRedirect,
  MOCK_USER,
  MOCK_SESSION_KEY,
};
