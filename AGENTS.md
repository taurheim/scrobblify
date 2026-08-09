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
