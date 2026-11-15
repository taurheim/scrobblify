// Paths the mock middleware serves, and the values `dev:mock` puts in the
// environment to point the app at them. Shared with tests/dev-mock.js so the
// two can never drift.
//
// All of them are *relative*. An absolute origin would bake in localhost and
// break the moment you opened the dev server from another device on the LAN,
// which is half the reason the mock moved to the server in the first place.

const MOCK_LASTFM_API = '/mock/lastfm';
const MOCK_LASTFM_AUTH = '/mock/lastfm/auth';
const MOCK_WORKER_API = '/mock/worker';
const MOCK_WORKER_SHIM = '/mock-auth';

/** The env every mocked dev server is started with. */
function mockEnv({ background = false } = {}) {
  const env = {
    VUE_APP_LASTFM_API_BASE: MOCK_LASTFM_API,
    VUE_APP_LASTFM_AUTH_BASE: MOCK_LASTFM_AUTH,
  };
  if (background) {
    // Without this `isBackgroundConfigured()` is false and every handoff screen
    // stays hidden, so the feature cannot be exercised at all.
    env.VUE_APP_BACKGROUND_API = MOCK_WORKER_API;
  }
  return env;
}

module.exports = {
  MOCK_LASTFM_API,
  MOCK_LASTFM_AUTH,
  MOCK_WORKER_API,
  MOCK_WORKER_SHIM,
  mockEnv,
};
