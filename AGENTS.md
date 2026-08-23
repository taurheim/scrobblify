# Agent notes for scrobblify

## Debugging with PostHog

This app reports usage and errors to PostHog from the browser. The PostHog MCP
server is configured in `.mcp.json` at the repo root, so any MCP-aware agent
picks it up automatically.

### Setup (once per machine)

`.mcp.json` reads the token from an environment variable — **never commit a key**.

1. Create a personal API key with the **MCP Server** preset:
   https://app.posthog.com/settings/user-api-keys?preset=mcp_server
2. Export it as `POSTHOG_MCP_TOKEN` in your shell profile.

Verify with `copilot mcp get posthog`.

### Project layout

The PostHog project is **shared with LastWave**. Every scrobblify event is tagged
with `app` (see `APP_NAME` in `src/services/Analytics.ts`); LastWave's events
carry no `app` property at all, so **always filter `properties.app = 'scrobblify'`**
or you will be reading another app's data.

Nothing is captured from `localhost` / `127.0.0.1`, `autocapture` and
`capture_pageview` are disabled, and all analytics failures are swallowed
silently. Absence of events is not evidence that a code path did not run.

Users are identified by their Last.fm username (`lastfm_username`), so a bug
report from a named user can be traced to their session.

### Errors

Errors arrive two ways: a filterable `scrobblify_error` event (properties:
`context`, `message`, `stack`) and, where supported, a native PostHog exception.
`context` is the grouping key. Current values:

| Area | `context` values |
| --- | --- |
| Upload / parsing | `upload.loadZip`, `upload.extractFile`, `upload.parseJson`, `upload.removeInvalidListens`, `upload.filterDuplicates` |
| Auth | `auth.init`, `auth.strip_token_url` |
| Scrobbling | `scrobble.repeatedFailures` |
| Session state | `scrobblify.resumeFromSaved`, `scrobblify.onImportFile`, `scrobblify.onSaveAndExit` |
| Uncaught | `vue.errorHandler`, `window.onerror`, `unhandledrejection` |

Last.fm failures are normalized to `Last.fm API error <code> (HTTP <status>)`
so they group cleanly, and credentials (`token`, `sk`, `api_sig`, `api_key`) are
replaced with `[redacted]`. **Never widen an error message to include raw request
params** — an early version leaked a user's Last.fm session key into analytics.

### Funnel events

`step_viewed` → `auth_success` / `auth_failed` / `auth_token_invalid` →
`upload_parse_started` / `upload_parse_completed` / `upload_no_matching_files` →
`tracks_selected` → `scrobble_started` / `scrobble_resumed` / `scrobble_paused` /
`scrobble_stopped` / `scrobble_completed`, plus `session_saved`,
`session_resumed`, and `user_logged_out`.

Rate limiting has its own events: `scrobble_rate_limited`,
`scrobble_rate_limit_cooldown_complete`, `scrobble_rate_limit_recovered`,
`scrobble_rate_limit_gave_up` (the escalating backoff was exhausted and progress
was auto-saved), and `scrobble_burst_limit_lowered` / `scrobble_burst_limit_raised`
from the adaptive limit in `RateLimitTracker`. Network failures emit
`scrobble_network_error`. `scrobble_ignored` fires when Last.fm accepts the
request but discards the play (see below).

**`scrobble_paused` and `scrobble_stopped` are deliberately separate events**, so
"how often does a run end early, and why" is answerable without knowing which
reasons happen to be terminal. Every terminal case used to be a `scrobble_paused`
reason too, and two of them (`repeated_rejections`, `repeated_failures`) emitted
nothing at all.

- `scrobble_paused` — transient; the loop resumes by itself. Reasons:
  `burst_limit`, `rate_limit`, `network_error`. This is Last.fm throttling, not
  a bug: treat it as normal operation rather than signal.
- `scrobble_stopped` — terminal; the run is over until the user comes back.
  Reasons: `daily_limit`, `lastfm_daily_limit`, `rate_limit_exhausted`,
  `repeated_rejections`, `repeated_failures`, `manual`. Only `manual` is a user
  action. Every one carries `auto_saved`, which is the difference between an
  interruption and lost work — all six now save, so `auto_saved: false` in the
  data means the save itself failed and is worth investigating.

All terminal paths go through the `trackStopped()` helper rather than emitting
inline, so a new one cannot silently skip the event.

Every terminal path must also leave the user a way back in. The paused panel's
resume button is gated on the `canResume` computed (`stopped || manuallyPaused`),
not on `stopped` alone: a manual pause is terminal but is *not* an error, so it
sets `manuallyPaused` and gets `info` styling via `pauseAlertType` instead of a
red `error` banner. Setting only `paused` renders a **disabled** "Wait Here"
button waiting on an auto-resume the loop has already returned from — a dead end
that stranded manual pauses, `repeated_rejections` and `repeated_failures`.

`manualPause()` deliberately does **not** save. It only raises the flags; the
save and the `scrobble_stopped` event happen in the scrobble loop's pause check,
which runs *between* tracks. Saving on the click would snapshot a
`scrobbledTracks` that omits the in-flight track, so the resume would re-send it
— and for a re-tagged play that means a freshly allocated timestamp and a
phantom duplicate scrobble.

`burst_limit` is **preventive pacing, not a stoppage**, and it is emitted once
per *stretch* of throttled sends — paired with a `scrobble_pacing_ended` event
carrying `paced_tracks`, `paced_wait_ms` and `pacing_duration_ms`. Do not read
it as one event per pause-and-resume of a track.

That pairing exists because `msUntilBurstSafe()` frees exactly one slot at a
time, so once the rolling window is saturated *every* remaining track waits a
fraction of a second. Emitting per track made `scrobble_paused` a per-scrobble
heartbeat: it went from ~15/day to 734/day and briefly became the
highest-count event after `step_viewed`. **Events from 2026-07-27 to 2026-07-29
are inflated this way and are not comparable with later data**, and before
2026-07-29 `scrobble_paused` also carried the terminal reasons.

Pacing waits under `PACING_COUNTDOWN_THRESHOLD_MS` (10s) are a plain sleep that
leaves the scrobbling UI up; only longer waits show the paused panel and
countdown.

### Measuring completion

Do **not** build completion percentages from `scrobbled_tracks / total_tracks`.
Those are session-scoped: a resume restores only the *remaining* tracks, so
`total_tracks` shrinks on every resume and the ratio measures progress through
the current chunk, not the import. Real examples: 81,313 → 573, 9,924 → 40.

Every scrobble event carries resume-stable fields instead — use these:
`original_total_tracks`, `total_succeeded`, `completion_pct`, `is_resumed`,
`previously_scrobbled`. Note these only exist on events emitted after the
telemetry fix, so older events cannot be compared against them.

`total_succeeded` is still an **upper bound**: Last.fm silently discards a
scrobble duplicating an existing (artist, track, timestamp) while reporting it
as accepted, so re-scrobbling history a user already has inflates the count with
no way to detect it from the API.

### Adding instrumentation

Use the helpers in `src/services/Analytics.ts` (`trackEvent`, `trackError`,
`identifyUser`) rather than calling `posthog` directly. Analytics must never
break the app: every call is wrapped in try/catch and ignored on failure.

That invariant covers *deriving* the payload, not just sending it. `trackError`
receives arbitrary values — the global handlers hand it whatever a third party
threw — so coercion goes through `toError()`, which guards `String(value)`
(that throws for Symbols and for objects with a throwing `toString`), and
`normalizeErrorForTracking` is called inside the try. Doing either before the
guard loses the report *and* throws a fresh error out of a `catch` block or a
global handler, which is exactly where it does the most damage.

## Scrobble timestamps

Last.fm keys a scrobble on **(user, artist, track, timestamp)** and silently
drops any repeat of that tuple — it still returns `accepted=1, ignored=0`, so
the loss is **undetectable from the response**. This was verified experimentally
against the live API; Last.fm does not document it and there is no
`ignoredMessage` code for it. Uniqueness therefore has to be guaranteed
client-side.

An early version gave every play the *same* `Date` when the user ticked
"Scrobble tracks older than 2 weeks" (~78% of imports), which collapsed all
repeat listens of a track into a single scrobble.

Plays that must be moved into Last.fm's 14-day window are flagged
`reTagged` (`SpotifyListen` → `Scrobble` → `SerializedScrobble`). Their
timestamps are **allocated at send time**, not at parse time, from a cursor in
`ScrobbleStep`:

```
reTagCursorSec = min(nowSec, max(reTagCursorSec + 1, nowSec - RETAG_BACKFILL_SECONDS))
```

This matters because absolute timestamps baked in at parse time expire: a queue
saved today and resumed three weeks later would be rejected wholesale with
ignore code 3. The cursor is persisted as a high-water mark
(`lastReTagTimestampSec`) so a resumed run can never reuse seconds an earlier
run already sent.

`scrobblePlay` returns a `ScrobbleResult`; a 200 does **not** mean the play was
stored. Check `ignored` and `ignoredMessage.code` (1 artist ignored, 2 track
ignored, 3 timestamp too old, 4 timestamp too new, 5 daily limit). Parsing
deliberately defaults to *accepted* on an unrecognised shape so a surprise can
never invent failures.

Two consequences worth knowing before touching this code:

- **A retry must re-send the identical timestamp.** It is allocated once per
  track and held across attempts. If the original request reached Last.fm and
  only the response was lost, an identical resend is deduplicated away; a fresh
  second would become a phantom play.
- **`filterDuplicates` skips `reTagged` listens.** Their timestamps are
  provisional, so matching them against real history compares fiction against
  fact and would silently drop import rows. Their true dates survive on
  `originalListenDate`, but checking those would mean fetching the user's whole
  Last.fm history back to the start of the export.

## Import robustness

A Spotify export is split across many `Streaming_History_Audio_*.json` files and
real ones do arrive damaged — truncated downloads, and large exports that read
back corrupted on memory-constrained mobile browsers. **A file that can't be
read or parsed is skipped, not fatal**; the import proceeds with what survived
and warns the user in the log. Only a ZIP where *every* history file fails is an
error. Don't "simplify" this back into an early return.

The file matcher is anchored to the **basename** (`/^Streaming_History_Audio_.*\.json$/`
tested against `name.split('/').pop()`), and that anchoring is load-bearing.
Testing the unanchored pattern against the full ZIP path also matched
`__MACOSX/._Streaming_History_Audio_*.json` — the AppleDouble sidecar macOS
writes for every entry when an archive is created or re-zipped on a Mac. There
is exactly one per real file, so the count doubled, every sidecar failed
`JSON.parse`, and the user was warned that half their history was missing when
none of it was. In telemetry this looked exactly like corruption: the giveaway
was that `skipped_count` was always precisely half of `total_files`, every
affected user was on macOS, and all the failures landed within ~400ms of the
parse starting (far too fast for the memory-exhaustion case this path exists
for). The sidecars are also why some parse errors quote `"    Ma"` — that's the
`Mac OS X` marker inside the AppleDouble header, not export data.

Two Last.fm quirks the validation path has to absorb:

- `track.getInfo` returns tracks with a **missing, empty or non-numeric
  duration**. `getTrackTimeMs` normalises those to `0`, meaning "unknown", and
  `removeInvalidListens` treats unknown as a generous 2 minutes. Returning `NaN`
  instead silently discarded the play, because every comparison against `NaN` is
  false — so it slipped past the fallback *and* the minimum-length check before
  failing the final test.
- Durations are cached per `(artist, track)` on the `LastFm` instance, including
  permanent "track not found" answers. A listening history is mostly repeat
  plays, so looking a track up once per *play* multiplied every validation run
  by the user's average play count, at 250ms of enforced rate buffer each. Rate
  limits and network errors are deliberately **not** cached.

Timestamps sent to Last.fm are always integer seconds — `from`/`to` window ends
round outwards so a duplicate-check window can only widen, never miss.

## Running locally with mocks

`npm run dev:mock` starts a dev server on **port 8090** whose Last.fm is served
by mock middleware in `vue.config.js`. `npm run dev:mock:bg` adds a fake
background worker. Open the printed URL in **any** browser — the mocking lives
in the server, so every tab and every device on the LAN is covered. The app
shows a hazard-striped **MOCK MODE** banner; if it isn't there, you aren't
mocked.

This used to work very differently, and the difference is the point. `dev:mock`
drove a headed Playwright window and installed `page.route()` on that single
page. Exactly one tab was mocked. Opening the same dev server in your ordinary
browser reached the *real* Last.fm and scrobbled to whatever account that
profile held — while the script's console banner said "nothing is really
scrobbled". Anything that reintroduces per-page interception reintroduces that.

Three build-time seams make it work, each `process.env.VUE_APP_* || <real
default>` so a production bundle is unchanged:

| Var | Points at | Default |
| --- | --- | --- |
| `VUE_APP_LASTFM_API_BASE` | `/mock/lastfm` | `https://ws.audioscrobbler.com/2.0/` |
| `VUE_APP_LASTFM_AUTH_BASE` | `/mock/lastfm/auth` | `https://www.last.fm/api/auth/` |
| `VUE_APP_BACKGROUND_API` | `/mock/worker` | unset (feature hidden) |

The values are **relative on purpose**; an absolute origin would bake in
localhost and break the moment you opened the server from a phone. The banner
keys off `VUE_APP_LASTFM_API_BASE` rather than a separate flag, so there is no
way to be mocked without being told. `vue.config.js` throws if a *production*
build is attempted with any of them set.

`/mock/lastfm/auth` hands back a random single-use token and redirects to
`<publicPath>#/scrobble?token=…` rather than pre-seeding localStorage, so the
authenticate step runs for real: the app exchanges the token against the mocked
`auth.getSession` exactly as it would in production. The token must be fresh per
click, because `LastFm.init` records the token it has begun exchanging in
sessionStorage and refuses to resubmit it.

**dev:mock never reuses a server and never uses port 8080.** Both halves matter.
`VUE_APP_*` is inlined by webpack at compile time, so adopting a server started
without the mock env would mock nothing while announcing the opposite. And
`playwright.config.ts` sets `reuseExistingServer` on 8080, so a mock server left
there would be silently adopted by the next `npx playwright test` — whose specs
intercept `ws.audioscrobbler.com`, a URL the mocked app no longer calls.

The canned responses live in transport-free cores — `handleLastFm()` in
`tests/lastfmMock.js` and `createMockWorker().handle()` in
`tests/backgroundMock.js` — consumed by both the dev middleware and the
Playwright suite. Keep it that way: two copies of "what Last.fm returns" is how
the tests and the interactive run start quietly disagreeing. `interceptLastFm`
remains a thin `page.route` wrapper so the suite's 20+ call sites are unaffected.

Only `vue.config.js` (Node, build time) requires from `tests/`. Nothing under
`src/` imports a mock.

Two traps already paid for:

- Mock middlewares are wrapped in `guard()`. They are async, so an uncaught
  throw becomes an unhandled rejection and kills the whole `vue-cli-service
  serve` process — losing the compile and the watch because one request had
  malformed JSON.
- `createMockWorker` reads `appOrigin` with an explicit `=== undefined` check,
  not `||`. An empty string is a deliberate *relative* origin; `||` treated it
  as unset and handed back `localhost:8080`, pointing the handoff at the
  Playwright port.

## Linting

`npm run lint` auto-fixes; `npm run lint:check` (`--no-fix`) is what CI runs, so
use that to see what CI will see. The config is ESLint + `@vue/airbnb` +
`@vue/typescript`.

Several airbnb rules are switched off in `.eslintrc.js` because they fight
patterns this codebase uses on purpose — each has a comment explaining why.
The load-bearing one: **`no-underscore-dangle` is off because Vue 2 skips
reactivity for keys starting with `_`**, which is how `SelectStep` holds large
track arrays cheaply. Renaming those fields would silently make them reactive
and tank performance on big histories.

Warnings (mostly `no-explicit-any`) do not fail the build; only errors do.
