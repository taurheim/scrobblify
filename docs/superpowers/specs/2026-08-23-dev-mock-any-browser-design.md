# `dev:mock` in an ordinary browser

## Problem

`npm run dev:mock` mocks nothing at the server or network level. It launches its
own headed Chromium through Playwright and installs
`page.route('https://ws.audioscrobbler.com/**')` on that **one page**
(`tests/lastfmMock.js`, wired at `tests/dev-mock.js`). The dev server it starts
is a plain `vue-cli-service serve`.

So the mock covers exactly one tab. Anything else reaches the real Last.fm:

- opening `localhost:8080` in your normal browser,
- a second tab or a popup inside the Playwright window, because the route is
  installed on `page` rather than on `context`.

The script's banner says "All Last.fm calls return canned data; nothing is really
scrobbled", which is true of the window it opened and false of every other one.
A developer who reaches for their usual browser gets no signal at all — the app
looks identical and silently writes to whatever Last.fm session that profile
holds.

## Goal

Running `dev:mock` mocks Last.fm for **any** browser pointed at the dev server,
and says so on screen. The authenticate step is exercisable end to end rather
than bypassed.

## Approach

Mock at the **dev server**, not in the browser.

The client talks to three endpoints. Make each one an env-var seam with the real
value as the fallback, then have the dev server serve fakes when the seam is
set. No `fetch` monkey-patching, no mock code in `src/`, and the mock reaches any
browser on the machine — including a phone on the LAN.

The alternative considered was an in-app `fetch` patch in `src/dev/`, aliased to
a stub for production builds. Rejected: it cannot intercept the authenticate
step, which is a top-level *navigation* to `last.fm/api/auth`, so it would still
need a served shim page — and it puts mock logic inside `src/`, where the only
thing standing between it and production is a minifier pass.

## Design

### Env-var seams in production code

Three edits, each `process.env.VUE_APP_* || <real default>`. Webpack inlines
`VUE_APP_*` as `undefined` in a production build, so the shipped bundle is
behaviourally identical to today.

| File | Change |
| --- | --- |
| `src/api/LastFm.ts` | `API_BASE_URL = process.env.VUE_APP_LASTFM_API_BASE \|\| 'https://ws.audioscrobbler.com/2.0/'` |
| `src/components/AuthenticateStep.vue` | auth base ← `process.env.VUE_APP_LASTFM_AUTH_BASE \|\| 'https://www.last.fm/api/auth/'` |
| `src/App.vue` | mock banner, rendered when `VUE_APP_LASTFM_API_BASE` is set |

The banner keys off the API base rather than a dedicated flag, so there is no
way to be mocked without being told, and no fourth knob to keep in sync.

`VUE_APP_BACKGROUND_API` already exists and needs no change; `dev:mock
--background` simply points it at the dev server.

### Dev-server middleware

`vue.config.js` gains `devServer.setupMiddlewares`, installed only when
`VUE_APP_LASTFM_API_BASE` is set:

| Route | Serves |
| --- | --- |
| `/mock/lastfm` | the Last.fm 2.0 API (`auth.getSession`, `track.getInfo`, `user.getrecenttracks`, `track.scrobble`) |
| `/mock/lastfm/auth` | ignores `cb`, 302s to `<publicPath>#/scrobble?token=<random>` |
| `/mock/worker/*` | the background worker (`--background` only) |
| `/mock-auth` | the worker's authorisation shim page (`--background` only) |

`/mock/lastfm/auth` returning a token rather than pre-seeding `localStorage` is
what makes the authenticate step real: the app receives a token exactly as it
would from Last.fm, exchanges it against the mocked `auth.getSession`, and lands
authenticated as `testuser` through the ordinary code path. The token is random
per click so `LastFm.init`'s single-use `sessionStorage` guard behaves as it does
in production.

The redirect target must respect `publicPath: '/scrobblify/'` and the router's
dev-mode `hash` history, so the token rides in the query *after* the fragment.

### Shared mock cores

The point of `tests/lastfmMock.js` is that the interactive script and the test
suite exercise the same canned responses. Serving a second copy from
`vue.config.js` would reintroduce exactly the divergence that file exists to
prevent. So each mock gets a transport-free core:

- **`tests/lastfmMock.js`** — extract `handleLastFm(method, params)` returning
  `{ status, contentType, body }`. `interceptLastFm(page)` stays a thin
  Playwright wrapper with an unchanged signature, so the 20+ call sites in
  `tests/scrobblify.spec.ts` are untouched. Add `handleLastFmAuth()` for the 302.
- **`tests/backgroundMock.js`** — already exposes
  `createMockWorker().handle(method, path, params, body)`, which is Playwright-free.
  The middleware calls it directly. `interceptBackgroundWorker` is **kept**: it
  costs nothing, and the background feature is under active development where a
  Playwright spec would want it.

Only `vue.config.js` — Node, build time — requires from `tests/`. Nothing in
`src/` imports a mock. The path constants and the env they imply live in
`tests/mockPaths.js`, shared by the middleware and `dev-mock.js` so the two
cannot drift. Every value is relative; an absolute origin would bake in
localhost and break when the server is opened from another device.

### Middleware robustness

Each mock middleware is wrapped in a `guard()` that turns a throw into a 500.
They are async, so an uncaught throw surfaces as an unhandled rejection and
takes the entire `vue-cli-service serve` process down — losing the mock, the
compile and the watch because one request had a malformed body. The worker mock
calls `JSON.parse` on request bodies, which is exactly the sort of thing a
half-written `curl` gets wrong.

### `dev:mock`

Drops Playwright entirely: it starts the dev server with the mock env vars and
prints the URL.

It moves to **port 8090** and always starts its own server. Two bugs die with
that decision:

- Today the script *reuses* a server already on 8080. That server was compiled
  without the env vars, so nothing would be mocked and the banner could not
  appear — the original footgun, in a new form.
- `playwright.config.ts` sets `reuseExistingServer: true` on 8080. A mock-mode
  server left running would be silently adopted by a later `npx playwright test`,
  whose specs route `ws.audioscrobbler.com` — a URL the app would no longer call.
  Separate ports make that impossible.

`--background` still generates the 3,000-track fixture and prints its path, but
no longer auto-uploads it; that was a Playwright convenience and is the one
accepted regression.

### Production safety

`vue.config.js` throws at build time if `NODE_ENV === 'production'` and any mock
var is set. Combined with the `||` fallbacks and the compile-time-false banner
`v-if`, the shipped bundle contains no mock code and no mock string.

## Verification

1. `npm run lint:check` — 0 errors (baseline: 0 errors, 135 warnings).
2. `npx playwright test` — pass count identical to the pre-change baseline of
   56, demonstrating the real code path is unchanged.
3. `npm run build` with a mock var set fails with the guard message; a clean
   build succeeds and `dist/` contains no `mock/lastfm`, `mock-banner`,
   `MOCK MODE`, `mock/worker` or `mock-auth`, while the real Last.fm API and
   auth URLs are still present.
4. End to end: a Playwright browser with **no** route interception anywhere,
   pointed at the mock dev server, sees the banner, follows the authorize link
   through the real auth code path to `testuser`, reaches the upload step, and
   issues zero requests to `audioscrobbler.com` or `last.fm`.

## Defects found while verifying

Both were exposed by the change rather than introduced by it, and both are
fixed here:

- **A malformed request body killed the dev server.** The middlewares are
  async, so a throw from `handle` became an unhandled rejection and took
  `vue-cli-service serve` with it. Now wrapped in `guard()`.
- **`createMockWorker` read `appOrigin` with `||`.** The middleware passes an
  empty string to mean "relative", which `||` treats as unset — so the handoff
  authorise URL came back as `http://localhost:8080/mock-auth`, pointing at the
  port the Playwright suite runs on. Now an explicit `=== undefined` check.

## Follow-up not taken

A permanent regression test for "an unmocked browser is still mocked" would need
a second Playwright project with its own `webServer` on the mock port and its own
env. That is a real addition to CI time and config, and the bug it guards against
is in dev tooling rather than shipped code, so it is left out deliberately. The
end-to-end check above was run as a throwaway script.

## Out of scope

- Mocking Last.fm for a **production** build. The seams are dev-server-only by
  construction and the build guard enforces it.
- Restoring fixture auto-upload for `--background`.
