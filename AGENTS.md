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

`upload_no_matching_files` carries `detected`: `progress_file` (a Scrobblify
progress file was zipped up and is imported instead), `account_data` (Spotify's
default "Account data" export, `StreamingHistory_music_*.json`, rather than the
extended one) or `unknown`. Before 2026-09-27 it carried no properties.
`session_resumed.source` is `saved`, `file`, or `zip`.

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
  `repeated_rejections`, `repeated_failures`, `session_invalid`, `manual`, and
  the backdating guards `retag_blocked`, `retag_no_second`,
  `retag_second_refused`, `retag_identity_unavailable`,
  `retag_journal_unavailable`. Only `manual` is a user action. Every one
  carries `auto_saved`, which is the difference between an interruption and
  lost work.

`auto_saved: true` means the progress write to IndexedDB **resolved** before the
event was emitted — every stop path awaits its save first, and a failed write
sets it `false`. So `false` means the save itself failed and is worth
investigating. **Events from before this was fixed (2026-09) set it before the
write started, so in older data it only means "a save was attempted"**: a
failed save still reported `true`, and nothing distinguished the two.

The two storage stops (`retag_identity_unavailable`, `retag_journal_unavailable`)
also carry `storage_failure`, saying *why* this browser couldn't store data:

| Value | Meaning |
| --- | --- |
| `QuotaExceededError`, `SecurityError`, … | the `DOMException` name the write threw. `SecurityError` is storage blocked outright (private browsing, strict cookie settings); `QuotaExceededError` is full or zero-quota storage |
| `not_persisted` | the journal write didn't throw but read back as something else — private modes have done this |
| `invalid_record` | the journal refused the record itself (e.g. an empty import id) |
| `no_random_source` | no `crypto.getRandomValues`, so no import identity could be minted |
| `no_persist_channel` | the scrobble step had no awaitable save to confirm the identity with |
| `unknown` | something without a `.name` was thrown |

These stops only affect **backdated** ("older than 2 weeks") plays; an import
of recent listens never touches the journal. Both leave the whole queue in
place. When the save also fails, the paused panel says so (`.save-failed`)
instead of claiming progress is saved, and "Save Progress & Leave" still
downloads the progress file. It no longer skips the download when the browser
save fails. `session_saved.saved_in_browser` records which happened; `false`
means the user left with only the file.

All terminal paths go through the `trackStopped()` helper rather than emitting
inline, so a new one cannot silently skip the event.

Every terminal path must also leave the user a way back in. The paused panel's
resume button is gated on the `canResume` computed (`stopped || manuallyPaused`),
not on `stopped` alone: a manual pause is terminal but is *not* an error, so it
sets `manuallyPaused` and gets `info` styling via `pauseAlertType` instead of a
red `error` banner. Setting only `paused` renders a **disabled** "Wait Here"
button waiting on an auto-resume the loop has already returned from — a dead end
that stranded manual pauses, `repeated_rejections` and `repeated_failures`.

`session_invalid` is the one terminal path whose way back is *not* a retry.
Last.fm error 9 ("Invalid session key") means the stored key has been
invalidated while the user was away — in the data, mostly people who had since
signed in on another device or browser. Nothing about the track is wrong, so the
loop stops on the **first** error 9 without consuming the track, saves, clears
the key (`clearSessionKey()`, which keeps the username that saved progress and
the rate-limit window are keyed by) and replaces the retry button with a "Sign
in to Last.fm again" link. It used to be ten per-track failures, then a retry
with the same key, and the key stayed in localStorage, so every later visit
failed identically: the top `scrobble.repeatedFailures` cause, with one user
stuck for 8 days. Error 9 no longer reaches `scrobble.repeatedFailures`, so that
context's volume drops from this fix on.

`init()` exchanges a callback `?token=` **even when a key is already stored**.
It used to skip the exchange whenever one was, which silently discarded the
fresh token and kept the dead key — re-authorizing could never help (visible in
the data as `auth_success` `returning: false` followed within a minute by error
9). If that exchange fails while a key is stored, the stored key is kept rather
than logging the user out; if it is dead too, the first scrobble says so.
`auth.getSession` is never sent with (or signed over) the old `sk`.

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

A stretch does **not** end at the first track that needs no wait. One free slot
is just the slot that track is about to consume, after which the window is full
again, so `msUntilBurstSafe()` alternates between a small positive wait and zero
from one track to the next. Exiting on the first zero therefore replaced "one
event per track" with "one begin/end *pair* per track" — a 34% reduction where
~100x was intended. `PACING_EXIT_CLEAR_TRACKS` (3) requires a streak of
genuinely unimpeded tracks instead, which saturation cannot produce. **The
`paced_tracks` and `scrobble_pacing_ended` data from 2026-08-04 to 2026-08-10 is
flap-inflated** — median `paced_tracks` of 1 and ~55% single-track stretches are
the bug, not user behaviour, and are not comparable with later data.

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

Outside production builds, `trackEvent` also logs each event to the console as
`[scrobblify:event] <name> <json>`. Nothing is captured from localhost, so this
is how Playwright asserts on telemetry (see `captureEvents` in the "Browser
storage unavailable" tests). Production bundles don't include it.

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

**Resuming on a new device goes through the upload step.** The resume banner
(and its "Import from file" button) only renders when *this browser* already has
saved state in IndexedDB, so on a new PC or browser it never appears. The drop
zone therefore takes both `.zip` and `.json` and **classifies the file the
moment it's chosen** (`classifyZip`, by entry names only), not on "Find tracks":

- `.json` → imported as a progress file.
- ZIP with `Streaming_History_Audio_*` → ready; if it *also* holds a
  `scrobblify-progress*.json`, a "Resume from it instead" link is offered but
  not forced.
- ZIP with only a `scrobblify-progress*.json` → imported immediately. This case
  is real: a user whose `.json` was refused zipped it up with their Spotify
  export to get it accepted.
- ZIP of `StreamingHistory_music_*.json` → Spotify's default "Account data"
  export, requested separately from (and delivered before) the extended one.
  It gets its own error explaining which export to request.

`upload_no_matching_files` therefore now fires on selection, **without** a
preceding `upload_parse_started`.

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
background worker, and prints a URL carrying `?beta=1` because the handoff
offer is behind that opt-in (see "Background scrobbling beta gate" below).
Open the printed URL in **any** browser — the mocking lives
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

## Background scrobbling beta gate

The handoff offer is invite-only: visit any page with `?beta=1` to opt a
browser in, `?beta=0` to opt out. An opted-in browser shows an info banner
with a switch-off link. It is independent of `VUE_APP_BACKGROUND_API`, which
only says whether the build *can* reach a worker.

Two functions in `src/services/BackgroundScrobbling.ts`, and the split is
load-bearing:

- `isBackgroundEnabled()` — configured **and** opted in. Guards the *offer*
  only: `probeBackgroundAvailability` and `preflight`.
- `isBackgroundConfigured()` — configured. Guards every *recovery* path: the
  live-job authority check, finishing a handoff on return from Last.fm, and
  rendering an existing job.

**Never gate a recovery path on the opt-in.** A browser that clears its
storage loses the opt-in but can still have a job running on the server, and
it is precisely the browser `enforceServerAuthority` exists to block from
scrobbling the same queue underneath it.

**But an unanswered check only blocks a browser with a reason to worry.** The
check runs for everyone and a `live: true` answer blocks everyone. When there
is *no* answer (worker down, not yet deployed, timed out), a browser that has
not opted in and holds no local handover evidence waits
`FALLTHROUGH_TIMEOUT_MS` (3s) and then scrobbles normally — see
`mayScrobbleWithoutAuthority`. Evidence means an ownership record, an
unresolved-ownership or stale-snapshot record, a pending handoff, a known job,
or `sawServerOwnership`. **Not** the handoff lineage: every backdating user
has one, because the re-tag cursor lives there. Without this rule
`.env.production` compiling in the worker URL was enough to stop every user of
the site from scrobbling whenever the worker could not be reached.

The accepted gap: a browser that lost its localStorage but kept a leftover
handed-over queue in IndexedDB, while the worker is unreachable. A successful
handover clears the saved queue, so this needs a stale copy as well.

**An imported progress file is a queue from somewhere else**, so the local
evidence above says nothing about it. `importProgressFile` asks
`/scrobblify/import/:id` about the *file's* `importId` before restoring it
(`importedQueueMaySend`): `known: true` refuses the file, because the worker
was handed that queue and the file is a copy from before. An unanswered check
follows the same fall-through rule. A file with no id cannot be checked. That
is safe only for files that were never handed over, and it is the one gap
here: a file exported before `beginHandoff` minted its id.

`npx playwright test -c playwright.unreachable-worker.config.ts` covers this
against a build whose worker URL cannot resolve; the default config ignores
`tests/unreachable-worker/` because its build has no worker URL at all. CI
runs both. It uses port 8471, because other local worktrees commonly occupy
the 809x range.

The opt-in is sticky (localStorage) rather than read from the URL, because
the query string does not survive the flow: `stripQuery` discards all of it on
a handoff return, and the Last.fm callback never carried it. A per-load flag
would switch itself off exactly when a handoff came back. The parameter is
read from the query string *and* the hash (dev runs the router in hash mode)
and deliberately not stripped — see `consumeBetaParam`.

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

## Running the tests

Playwright is the only test framework here — there are no unit tests. Analytics
is disabled on `localhost`, so **a test can never observe a PostHog event**;
assert on the UI instead.

`playwright.config.ts` sets `reuseExistingServer: true` on port 8080. If a
`vue-cli-service serve` is already running there **from another checkout or
worktree, Playwright will happily test that checkout's code instead of yours**
and say nothing. This has already produced three "verified" results that were
really the other tree's build. Before trusting a local run — especially one
verifying a fix — confirm what owns the port:

```powershell
Get-CimInstance Win32_Process -Filter "ProcessId = $((Get-NetTCPConnection -LocalPort 8080 -State Listen).OwningProcess)" |
  Select-Object -ExpandProperty CommandLine
```

or run against a scratch config on its own port with `reuseExistingServer:
false`. CI is unaffected, since it starts from nothing.

Verify a regression test actually catches its bug with
`git stash push -- <source file>`, re-run, `git stash pop`. A test that passes
both ways is testing nothing.
