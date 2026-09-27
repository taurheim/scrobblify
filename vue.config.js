const {
  MOCK_LASTFM_API,
  MOCK_LASTFM_AUTH,
  MOCK_WORKER_API,
  MOCK_WORKER_SHIM,
} = require('./tests/mockPaths');

const publicPath = '/scrobblify/';

// `npm run dev:mock` sets these; nothing else should. See tests/dev-mock.js.
const MOCK_MODE = !!process.env.VUE_APP_LASTFM_API_BASE;
const MOCK_BACKGROUND = MOCK_MODE && !!process.env.VUE_APP_BACKGROUND_API;

// A production bundle that talks to a mock is worse than a broken one: it looks
// like it works. The seams in LastFm.ts and AuthenticateStep.vue are dev-server
// affordances, so refuse to build with them set rather than trusting whoever
// exported them to have meant it.
if (process.env.NODE_ENV === 'production' && MOCK_MODE) {
  throw new Error(
    'VUE_APP_LASTFM_API_BASE / VUE_APP_LASTFM_AUTH_BASE are set during a production build.\n'
    + 'They exist only so `npm run dev:mock` can point the app at the dev server\'s mock\n'
    + 'Last.fm. A bundle built with them would send real users to a URL that does not\n'
    + 'exist. Unset them and rebuild.',
  );
}

/** Collect a request body. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, response) {
  const {
    status,
    contentType,
    body,
    headers = {},
  } = response;
  // Writing to `res` is the whole job of a Node handler, so airbnb's
  // no-param-reassign has nothing useful to say here.
  /* eslint-disable-next-line no-param-reassign */
  res.statusCode = status;
  res.setHeader('Content-Type', contentType);
  Object.entries(headers).forEach(([key, value]) => res.setHeader(key, value));
  res.end(body);
}

/**
 * Wraps a handler so a throw becomes a 500 rather than a dead dev server.
 *
 * These are async middlewares, so anything they throw surfaces as an unhandled
 * rejection and takes the whole `vue-cli-service serve` process down with it —
 * losing the mock, the compile and the watch, for one malformed request. The
 * mocks parse request bodies (`JSON.parse` in the worker's `handle`), which is
 * exactly the sort of thing a half-written curl gets wrong.
 */
function guard(name, handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      console.error(`[mock:${name}] ${req.method} ${req.url} failed:`, e.message);
      send(res, {
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'mock middleware failed', detail: e.message }),
      });
    }
  };
}

/**
 * Builds the fake endpoints the app is pointed at in mock mode.
 *
 * The responses come from tests/lastfmMock.js and tests/backgroundMock.js — the
 * same modules the Playwright suite uses — so `dev:mock` and the tests cannot
 * disagree about what Last.fm does. Requiring them here is safe: vue.config.js
 * runs in Node at build time, and nothing under src/ imports a mock.
 *
 * Each entry is mounted with express `use` semantics, so `path` matches by
 * prefix and `req.url` arrives with the mount point already stripped. The
 * auth route therefore has to be listed before the API route it sits under.
 */
function mockMiddlewares() {
  // Required lazily so a plain `npm run serve` never touches tests/.
  /* eslint-disable global-require */
  const { handleLastFm, lastFmAuthRedirect } = require('./tests/lastfmMock');

  const entries = [
    {
      name: 'scrobblify-mock-lastfm-auth',
      path: MOCK_LASTFM_AUTH,
      middleware: guard('lastfm-auth', (req, res) => {
        /* eslint-disable-next-line no-param-reassign */
        res.statusCode = 302;
        res.setHeader('Location', lastFmAuthRedirect(publicPath));
        res.end();
      }),
    },
    {
      name: 'scrobblify-mock-lastfm-api',
      path: MOCK_LASTFM_API,
      middleware: guard('lastfm-api', async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        const params = req.method === 'POST'
          ? new URLSearchParams((await readBody(req)).toString('utf8'))
          : url.searchParams;
        send(res, handleLastFm(params));
      }),
    },
  ];

  if (MOCK_BACKGROUND) {
    const { createMockWorker, shimHtml } = require('./tests/backgroundMock');
    // A relative appOrigin, for the same reason the paths are relative: the
    // authorise URL has to work from whatever host the browser actually used.
    const mock = createMockWorker({ appOrigin: '' });

    entries.push({
      name: 'scrobblify-mock-worker',
      path: MOCK_WORKER_API,
      middleware: guard('worker', async (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        // `req.url` is already relative to the mount point, which leaves
        // exactly the worker's real paths (/scrobblify/...) that `handle`
        // matches on. Chunk uploads are gzipped binary, but `handle` counts
        // them without decoding, so a lossy utf8 body costs nothing.
        const body = (await readBody(req)).toString('utf8');
        send(res, mock.handle(
          req.method,
          url.pathname.replace(/\/+$/, ''),
          url.searchParams,
          body,
        ));
      }),
    });

    entries.push({
      name: 'scrobblify-mock-worker-shim',
      path: MOCK_WORKER_SHIM,
      middleware: guard('worker-shim', (req, res) => {
        const url = new URL(req.url, 'http://localhost');
        send(res, {
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: shimHtml(
            url.searchParams.get('session') || '',
            url.searchParams.get('handoff') || '',
          ),
        });
      }),
    });
  }
  /* eslint-enable global-require */

  return entries;
}

module.exports = {
  publicPath,
  outputDir: 'dist',
  transpileDependencies: [
    'vuetify',
  ],
  devServer: MOCK_MODE
    ? {
      setupMiddlewares: (middlewares) => {
        middlewares.unshift(...mockMiddlewares());
        return middlewares;
      },
    }
    : {},
};
