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
`scrobble_completed`, plus `session_saved`, `session_resumed`, and
`user_logged_out`.

Rate limiting has its own events: `scrobble_rate_limited`,
`scrobble_rate_limit_cooldown_complete`, `scrobble_rate_limit_recovered`,
`scrobble_rate_limit_gave_up` (the escalating backoff was exhausted and progress
was auto-saved), and `scrobble_burst_limit_lowered` / `scrobble_burst_limit_raised`
from the adaptive limit in `RateLimitTracker`. Network failures emit
`scrobble_network_error`. `scrobble_ignored` fires when Last.fm accepts the
request but discards the play (see below).

`scrobble_paused` carries a `reason` of `burst_limit`, `daily_limit`,
`rate_limit`, `rate_limit_exhausted`, `network_error`, `lastfm_daily_limit`, or
`manual` — only `manual` is a user action; the rest are Last.fm throttling, not
bugs. These dominate by volume (`scrobble_paused` and `scrobble_rate_limited`
are the highest-count events after `step_viewed`), so treat them as normal
operation, not signal.

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
