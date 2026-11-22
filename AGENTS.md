# Agent notes for scrobblify

## Bugs you find along the way

Any bug you come across, whether from testing, reviewing or reading code, gets a
GitHub issue, even when it's outside the task at hand: `gh issue list --state
all --search "<keywords>"` first, then comment on a match or
`gh issue create --label bug`. Include how to reproduce it, the cause with
`file:line`, a suggested fix and a regression test. Don't fix it in the same
change unless asked. Issues are public, so they carry no user-identifying data
(see "File issues" in the `hunting-posthog-bugs` skill for what that rules out).
Mention the issue numbers when you report back.

## Debugging with PostHog

This app reports usage and errors to PostHog from the browser. The PostHog MCP
server is configured in `.mcp.json` at the repo root, so any MCP-aware agent
picks it up automatically.

To go looking for bugs rather than chase a known one, use the
`hunting-posthog-bugs` skill (`.github/skills/hunting-posthog-bugs/`): a
workflow, journey invariants, and validated HogQL for each check.

### Setup (once per machine)

`.mcp.json` reads the token from an environment variable — **never commit a key**.

1. Create a personal API key with the **MCP Server** preset:
   https://app.posthog.com/settings/user-api-keys?preset=mcp_server
2. Export it as `POSTHOG_MCP_TOKEN` in your shell profile.

Verify with `copilot mcp get posthog`.

No key at all: the server supports OAuth, which clients that implement it
refresh by themselves. In omp, add a user-level entry with **no**
`Authorization` header to `~/.omp/agent/mcp.json` (an explicit header, even the
unresolved `${POSTHOG_MCP_TOKEN}` one in `.mcp.json`, turns OAuth off for that
entry; the user-level entry shadows the project one by name):

```json
{ "mcpServers": { "posthog": { "type": "http", "url": "https://mcp.posthog.com/mcp" } } }
```

Then run `/mcp reauth posthog` once. The credential lives in omp's auth storage
and applies to every worktree.

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

Every event also carries `build_sha` (7-char commit) and `build_number` (the CI
run number), so you can tell which deploy an error came from — e.g. whether it
predates a fix. Events from before 2026-09-27 have neither. Values come from
`src/buildInfo.ts`, injected by `vue.config.js` from `GITHUB_SHA` /
`GITHUB_RUN_NUMBER` (locally: `git rev-parse` / `local`). The same values show
on the site as a hover tooltip on "Scrobblify" in the footer, and the deployed
`/scrobblify/version.json` (written by the CI build job) has the full SHA and
build time.

**Old builds keep running long after a deploy.** Until #136's `.htaccess`
reached the server, `index.html` was served with no `Cache-Control`, so
browsers cached it heuristically, and a stale copy still boots while its chunks
are in the browser's cache. About 5–7% of fresh page
loads ran a superseded build for days after each deploy (one user was on code
two months old), and those users kept hitting already-fixed bugs. **Before
calling a fix ineffective, check `build_sha`**: an occurrence on a build older
than the fix is this, not a regression. Mitigations:

- `public/.htaccess` sets `Cache-Control: no-cache` on `index.html` and
  `version.json`. It shipped in #105 (2026-10-03) but **never reached the
  server until #136** (2026-11): `actions/upload-artifact` drops dotfiles
  unless `include-hidden-files: true`, so the deployed artifact had no
  `.htaccess`. CI and CD now fail if `dist/.htaccess` is missing. Verify after
  a deploy with `curl -I https://savas.ca/scrobblify/`; if no `Cache-Control`
  shows up, the host is ignoring it and the rule belongs in Cloudflare.
- **The FTP deploy deletes the previous build's chunks** (FTP-Deploy-Action
  syncs against `.ftp-deploy-sync-state.json` and removes what dropped out).
  Its `exclude` option can't keep them: excluded files are neither deleted nor
  uploaded. Missing chunks used to get the SPA fallback, `index.html` as
  `200 text/html`, which Cloudflare cached for 4h under the `.js` URL
  (`Unexpected token '<'`). `.htaccess` now answers missing `js/`, `css/`,
  `img/`, `fonts/` and `media/` paths with a 404, and also carries the SPA
  fallback itself, because enabling `RewriteEngine` there replaces any parent
  rewrite rules. A build without `.htaccess` would make the sync delete it and
  break every deep link, which is why `cd.yml` checks for it.
- `src/services/ChunkReload.ts`: when a lazy route's chunk fails to load
  (`router.onError`), the target URL is loaded in full, at most once a minute
  per tab and never while `scrobbleRunActive`. It emits `chunk_load_failed`
  (`reloaded`, `skip_reason`: `recent_reload` / `run_active` / `no_storage`,
  `path`, `message`).
- The app fetches `version.json` (`src/services/BuildCheck.ts`) on load, every
  30 minutes and when a backgrounded tab returns, and if it names a newer build
  than `build_sha` shows a "newer version — Reload" banner. It is hidden while a run
  is actively scrobbling (`scrobbleRunActive` in the store), because a reload
  then drops everything since the last checkpoint. It emits
  `stale_build_detected` (`latest_sha`, `latest_run`, `reloaded_for_latest` —
  true means a reload came back stale anyway, i.e. something is still caching
  `index.html`) and `stale_build_reload_clicked`. Tabs on builds from before
  this shipped can't detect themselves, so they still show up as old
  `build_sha`s until they reload.
- "Newer" means a different sha **and** a higher `run` than the tab's
  `build_number` (#138). Some returning users' browsers kept handing back a
  `version.json` they had fetched days earlier, despite `cache: 'no-store'`, so
  tabs on the current build were told an *older* build was newer, and
  reloading for it didn't help. Every fetch now carries a unique `?t=` query,
  and an answer whose `run` isn't above the tab's own is ignored and reported
  once per sha per page load as `stale_build_older_ignored` (`fetched_sha`,
  `fetched_run`). Local builds (`build_number` `local`) and files without a
  `run` fall back to comparing the sha alone. **`stale_build_detected` with
  `latest_run` below `build_number` before this fix (2026-11-17) is this bug.**
  Playwright numbers its test server's build (`GITHUB_RUN_NUMBER`, default
  `100`, in `playwright.config.ts`) so this comparison runs in tests.

### Errors

Errors arrive two ways: a filterable `scrobblify_error` event (properties:
`context`, `message`, `stack`) and, where supported, a native PostHog exception.
`context` is the grouping key. Current values:

| Area | `context` values |
| --- | --- |
| Upload / parsing | `upload.loadZip`, `upload.extractFile`, `upload.parseJson`, `upload.removeInvalidListens`, `upload.filterDuplicates` |
| Auth | `auth.init`, `auth.strip_token_url` |
| Scrobbling | `scrobble.repeatedFailures` |
| Session state | `scrobblify.resumeFromSaved`, `scrobblify.onImportFile`, `scrobblify.onSaveAndExit`, `scrobblify.onAutoSave`, `scrobblify.onCheckpoint` (reported once per page load), `scrobblify.onDownloadProgress`, `scrobblify.saveBeforeSignIn` (a signed-out selection couldn't be saved before the Last.fm redirect) |
| Sign-in | `scrobblify.deferredDuplicates` (the duplicate check deferred to after sign-in failed, and the queue is sent unfiltered; or saving its result failed, and the filtered queue is sent from memory) |
| Uncaught | `vue.errorHandler`, `window.onerror`, `unhandledrejection` |

Last.fm failures are normalized to `Last.fm API error <code> (HTTP <status>)`
so they group cleanly, and credentials (`token`, `sk`, `api_sig`, `api_key`) are
replaced with `[redacted]`. **Never widen an error message to include raw request
params** — an early version leaked a user's Last.fm session key into analytics.

### Funnel events

`step_viewed` →
`upload_parse_started` / `upload_parse_completed` / `upload_no_matching_files` →
`tracks_selected` → `sign_in_started` → `auth_success` / `auth_failed` /
`auth_token_invalid` → `selection_resumed_after_sign_in` →
`scrobble_started` / `scrobble_resumed` / `scrobble_paused` /
`scrobble_stopped` / `scrobble_completed`, plus `session_saved`,
`session_resumed`, `session_resume_blocked`, and `user_logged_out`.
`stale_build_detected` / `stale_build_reload_clicked` /
`stale_build_older_ignored` / `chunk_load_failed` are outside the funnel (see
"Old builds keep running" above).

Since 2026-11-21 signing in comes *after* choosing (see "Signing in after
choosing" below). `/scrobble` opens on Upload, so `step_viewed` starts at step
2 and **no longer reports step 1**; the stepper keeps its old numbers (2
Upload, 3 Choose, 4 Send, 5 Done) so later steps stay comparable. Before that
date the order was `step_viewed` (step 1) → `auth_*` → `upload_*`. A browser
with a stored session still emits `auth_success` (`returning: true`) on every
`/scrobble` load and skips `sign_in_started` and
`selection_resumed_after_sign_in`. `sign_in_started` carries `intent` (`send`,
`resume` or `reconnect`); `selection_resumed_after_sign_in` carries
`track_count` and `duplicates_skipped`, and replaces `session_resumed` for a
selection coming back from Last.fm, which is not a resume.
`upload_parse_completed` carries `duplicates_deferred` (true when "Check for
duplicates" was ticked while signed out, so the check runs after sign-in).

The server path (see "The server choice" under "Background scrobbling beta
gate") skips the browser sign-in: `background_offer_shown` (`entry_point:
confirm`) → `tracks_selected` (`path: server`) → `background_handoff_*`, with
no `sign_in_started` or `auth_success`. Home's "Re-connect to last.fm" with a worker configured emits
`worker_lookup_started` and, back on `/scrobble`, `worker_lookup_result`
(`result`: `job`, `saved`, `nothing` or `failed`; see "Signing in after
choosing"). Since 2026-11-21 too: `background_handoff_return_rejected` (a
handoff return for a handoff this browser didn't preflight, #157),
`background_freeze_released` gains `reason: handoff_not_taken`, and
`background_handoff_failed` gains the worker's `already_live`, `replay` and
`abandoned` reasons (see "Handing over without signing in").

Home emits `home_choice` (`choice`: `have_export`, `get_export` or `resume`;
`resume` is the "Already scrobbling on scrobblify?" link) on first visits
(`get_export` also from the welcome-back card's "Show me how"), and
`home_returning_shown` (`state`: `saved_signed_in`, `saved_signed_out`,
`server_job` or `username_only`) when it shows the welcome-back card instead
(`src/services/ReturningVisitor.ts`). The card appears when this browser has a
remembered username, saved progress (welcomed under the progress's own
`userName`), or a live job it handed over. "Not you?" on the card signs out
(`user_logged_out`) only when the card was about the stored user, never deletes
saved progress, and hides the card for the rest of the tab (`sessionStorage`
`scrobblify.home.dismissedReturning`; a fresh Last.fm sign-in, one that
exchanged a token, clears it). Start, Start over and Upload Spotify zip open
`/scrobble`. **Continue** resumes the saved progress without a second click:
signed in as the progress's owner, it records an in-app `resume` intent
(`setSignInIntent`) and opens `/scrobble`, which resumes on mount; otherwise
it starts a `resume` sign-in through Last.fm (`startSignIn`) that resumes on
the way back. **Re-connect to last.fm** when signed out signs in to the
*worker* if one is configured (see "Signing in after choosing"), else starts a
`reconnect` sign-in (landing on `/scrobble`, where the job or resume banner
takes over); signed in, it just opens `/scrobble`. Home reads
the stored user itself (`LastFm.loadStoredUser()`), since only `/scrobble`'s
sign-in handler (`AuthenticateStep`) runs `init()`.

Since 2026-11-15 `tracks_selected` fires when the user confirms the "Scrobble N
tracks?" dialog, not on the select step's button. That dialog estimates the
run time (`src/services/ScrobbleEstimate.ts`): re-tagged plays get today's
import budget (read from the library, as the loop does), then 700 per UTC day;
see "Last.fm's daily cap". Cancelling it emits nothing. Since 2026-11-21 it
carries `path`: `tab` (sent from this browser: "Start scrobbling", "Start
over" without the server choice, or "scrobble locally") or `server` ("Let
Scrobblify scrobble for me (beta)"; see "The server choice").

**A fresh run never replaces saved progress unasked** (#102). There is one
saved-progress slot, and a fresh run's first save (checkpoint or stop)
overwrites it, so re-uploading the export and pressing Scrobble used to throw
the saved count away and make the next resume re-send it. When this browser has
saved progress (`hasResumableState`), the confirmation dialog warns with its
count and offers **Resume saved progress** (primary) or **Start over** instead
of "Start scrobbling". It emits `saved_progress_prompt_shown` and
`saved_progress_choice` (`choice`: `resume` / `start_over`), both carrying
`saved_total_succeeded`, `saved_original_total_tracks` and `selected_count`.
Shown minus choices is cancels. Since 2026-11-16; earlier `scrobble_started`
at `total_succeeded = 0` after higher progress for the same
`original_total_tracks` is this bug. A signed-out send saves the selection
*before* its first send (to survive the Last.fm redirect), so it also checks
the disk: it refuses while sending is withheld, and refuses saved progress the
dialog didn't ask about (withheld prompt, another tab) with "Go back and choose
Resume or Start over". Importing an *older progress file* over
newer saved progress is the next paragraph (#124).

**An imported progress file never silently loses or repeats progress** (#124).
Before restoring a file, `askAboutProgressFile` (`src/services/ProgressFileConflict.ts`)
compares it with the saved progress and opens a dialog when:

| `reason` | When | Buttons |
| --- | --- | --- |
| `saved_newer` | same import, saved `originalSucceededCount` higher | **Keep newer progress** (resumes saved) / Use this file anyway |
| `other_import` | different import, saved progress has > 0 scrobbled | **Cancel** / Use this file anyway |
| `completed` | saved progress (if any) is a different import, and this browser finished the file's import | **Cancel** / Import anyway |

`completed` outranks `other_import` (its dialog mentions the replacement too),
because duplicates can't be undone. "Same import" is equal `importId`; files without one fall back to equal
`originalTotalTracks` for the same (or an unknown) user. Finishing an import
clears the saved state, so `onScrobbleComplete` records it in localStorage
(`scrobblify.completedImports`, last 20). Without ids on both sides, only a file
saved before the import finished counts. It emits `progress_file_conflict_shown`
and `progress_file_conflict_choice` (`choice`: `use_file` / `keep_saved` /
`cancel`), both carrying `reason`, `source`, `file_succeeded`,
`file_total_tracks`, `saved_succeeded`, `saved_total_tracks`. Before 2026-11-16
a `session_resumed` with `source` `file`/`zip` at lower `completion_pct` than
the user's previous event is this bug. Background-worker completions are not
recorded, and a device with no local state has nothing to compare against.
To keep files fresh, progress files are named `scrobblify-progress-YYYY-MM-DD-HHMM.json`
(local time), and a stopped run's paused panel has a **Download progress file**
button (`progress_file_downloaded`, same properties as `session_saved`) that
doesn't leave the page.

Before that, a fresh import that re-tags more than one day's budget (700
plays) hits a blocking `LargeHistoryGate` on "Choose which tracks to scrobble":
wrong dates, days of returning, no bulk undo, and a "Use ListenBrainz instead"
link to ListenBrainz's own Spotify importer, which keeps the real dates. Only
"I understand, continue" proceeds. Resumes and progress files skip it.

Copy that tells users to "come back each day" has a background variant on every
surface, so beta users aren't told to return when the server could finish for
them. The gate and the confirmation use `backgroundCanFinish` (fed by
`backgroundTrackLimit`, the capacity probe's `maxTracks`, 0 when the offer is
off or a server job is listed), and point at the stop screen's "Scrobble the
rest for me". The stop reasons and the paused panel use `canOfferBackground`, since the
offer sits right under them. The Complete step uses `backgroundTrackLimit > 0`.
Home's welcome-back card shows a live server job ("Scrobbling remotely, it's
safe to close this tab.") to any browser that handed it over, whatever its beta status,
and the header shows the BETA tag while it does (`showingServerJob` in the
store), besides the opt-in and flag. Otherwise Home and About have no
background-specific copy (About's "Where does my data go?" answer mentions the
background service to everyone).

Gate telemetry, since 2026-11-16: `large_history_gate_shown` and
`large_history_gate_accepted` carry `re_tagged_count`, `estimated_days` and
`background_available`. `listenbrainz_clicked` carries `source`: `gate_button`
(which also closes the gate), `gate_text` (the inline link) or `about` (the
About page's FAQ; no other properties). `home` was the old Home page's link,
removed in the guided-home release. A click only means the link was opened, not that
the user imported anything there. Shown minus accepted is not "went to
ListenBrainz": closing the tab looks the same.

`upload_no_matching_files` carries `detected`: `progress_file` (a Scrobblify
progress file was zipped up and is imported instead), `account_data` (Spotify's
default "Account data" export, `StreamingHistory_music_*.json`, rather than the
extended one) or `unknown`. Before 2026-09-27 it carried no properties.
A loose `.json` that turns out not to be a progress file (see "Import
robustness") emits it too, with `file_type: 'json'`, a `source` and `detected`
of `extended_history`, `account_data` or `unknown` — not a
`scrobblify.onImportFile` error.
`session_resumed.source` is `saved`, `file`, or `zip`. `session_resume_blocked`
(same `source`, plus `reason: not_authenticated`) fires instead of
`session_resumed` when a resume is attempted with no session key; it exists
since 2026-09-27.

Rate limiting has its own events: `scrobble_rate_limited`,
`scrobble_rate_limit_cooldown_complete`, `scrobble_rate_limit_recovered`,
`scrobble_rate_limit_gave_up` (the escalating backoff was exhausted and progress
was auto-saved), and `scrobble_burst_limit_lowered` / `scrobble_burst_limit_raised`
from the adaptive limit in `RateLimitTracker`. Network failures emit
`scrobble_network_error`. `scrobble_ignored` fires when Last.fm accepts the
request but discards the play (see below). `scrobble_not_stored` (`not_stored`,
`re_tagged_not_stored`, `checked`) fires when plays Last.fm answered as
accepted are missing from the user's library on a day at the cap, and
`scrobble_verify_failed` (once per run, `message`) when the library couldn't be
read back at all — see "Last.fm's daily cap". Its `message` no longer carries
the request echo (`. Request: {…}`, which included the username and split one
cause into a group per user) since #137.

**`scrobble_paused` and `scrobble_stopped` are deliberately separate events**, so
"how often does a run end early, and why" is answerable without knowing which
reasons happen to be terminal. Every terminal case used to be a `scrobble_paused`
reason too, and two of them (`repeated_rejections`, `repeated_failures`) emitted
nothing at all.

- `scrobble_paused` — transient; the loop resumes by itself. Reasons:
  `burst_limit`, `rate_limit`, `network_error`. This is Last.fm throttling, not
  a bug: treat it as normal operation rather than signal.
- `scrobble_stopped` — terminal; the run is over until the user comes back.
  Reasons: `daily_limit`, `not_stored`, `lastfm_daily_limit`, `rate_limit_exhausted`,
  `repeated_rejections`, `repeated_failures`, `session_invalid`,
  `not_authenticated`, `manual`, `save_and_exit`, and
  the backdating guards `retag_blocked`, `retag_no_second`,
  `retag_second_refused`, `retag_identity_unavailable`,
  `retag_journal_unavailable`. Only `manual` and `save_and_exit` are user
  actions. Every one carries `auto_saved`, which is the difference between an
  interruption and lost work. `save_and_exit` exists since 2026-09-27 and only
  fires when "Save Progress & Leave" is clicked during a *transient* countdown
  (after a terminal stop the loop has already returned and reported).

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
resume button is gated on the `canResume` computed (`stopped || manuallyPaused
|| leaving`), not on `stopped` alone: a manual pause is terminal but is *not* an error, so it
sets `manuallyPaused` and gets `info` styling via `pauseAlertType` instead of a
red `error` banner. Setting only `paused` renders a **disabled** "Wait Here"
button waiting on an auto-resume the loop has already returned from — a dead end
that stranded manual pauses, `repeated_rejections` and `repeated_failures`.

A stop isn't immediate: the loop finishes the send it is waiting on first, and
`scrobble()`'s `loopActive` re-entry guard ignores clicks until then. So while
`canResume && loopActive` the button is a disabled **Pausing…** (or
**Stopping…**), not Resume Now (#123). An enabled button there swallowed the
click and left the run paused; before the guard (2026-11-15) the same click
started a second loop and double-sent. If the in-flight send then fails (network
error, rate limit), `pauseWithCountdown` returns at once while `manuallyPaused`
is set rather than waiting out the backoff: its expiry clears `paused`, so the
run used to carry on scrobbling after a 30-second to 30-minute "Pausing…".

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

**A cleared key must never be resumed past.** `clearSessionKey()` keeps the
username, and the resume used to check only that, so "Save Progress & Leave" →
sign-in step (as it was then) → **Resume** jumped to the scrobble step with no key. Every send
threw `Not authenticated.` in ~100ms, it stopped as `repeated_failures`, and the
nine tracks those failures consumed were saved as completed and never sent
(seen in production right after the error-9 fix shipped, with no `auth_success`
in between). Two guards now, since 2026-09-27:

- `restoreFromState()` (saved-state and file resumes) refuses when
  `!api.isAuthenticated()`: it stays where it is (there is no sign-in step
  since 2026-11-21), writes nothing, and shows a "Sign in to Last.fm first"
  banner. Its **Sign in to Last.fm** button (`signInToResume`) starts a
  `resume` sign-in when the refused resume was this browser's *saved*
  progress, and on the way back that progress resumes by itself once the
  server-authority check has answered (it lands on Send; the user still
  presses Scrobble). After a refused progress *file* it starts a `reconnect`
  sign-in instead, so the other saved import isn't resumed in its place
  (#153); the file has to be imported again. It emits
  `session_resume_blocked`, not `session_resumed`.
- `scrobblePlay` throws a typed `NotAuthenticatedError`
  (`LastFm.isNotAuthenticatedError`) when there is no key, and the loop treats
  it like error 9 — first occurrence, track unconsumed, saved, sign-in link —
  but stops as `not_authenticated`. That reason should stay at zero; any
  occurrence means some other route into the loop skips signing in.

`init()` exchanges a callback `?token=` **even when a key is already stored**.
It used to skip the exchange whenever one was, which silently discarded the
fresh token and kept the dead key — re-authorizing could never help (visible in
the data as `auth_success` `returning: false` followed within a minute by error
9). If that exchange fails while a key is stored, the stored key is kept rather
than logging the user out; if it is dead too, the first scrobble says so.
`auth.getSession` is never sent with (or signed over) the old `sk`.

**Signing in after choosing** (since 2026-11-21). Signing in is no longer a
step. `AuthenticateStep` is a headless handler above the stepper: on mount it
runs `init()` (exchanging any callback `?token=`), shows "Signing in to
Last.fm…" only while exchanging a token, plus the expired-token prompt or an
error, and emits `complete` (`fresh`: the load arrived with a callback
`?token=`, i.e. came back from Last.fm, whether or not the exchange worked) or
`failed`. There is no 2-second delay any more. Sign-in starts wherever a
Last.fm session is first needed, through `startSignIn` in
`src/services/SignInIntent.ts`, which records *why* in sessionStorage
(`scrobblify.signInIntent`; Last.fm returns to the same tab, and nothing in
memory survives the trip), emits `sign_in_started` and redirects. A page
reached in-app by a user who is already signed in records an intent with
`setSignInIntent` instead (no redirect, no `sign_in_started`). The kinds:

| `intent` | Started by | On the way back |
| --- | --- | --- |
| `send` (`importId`, `checkDuplicates`) | Confirming "Scrobble N tracks?" while signed out, on the tab path ("Start scrobbling", "scrobble locally") | The saved selection is restored onto Send |
| `resume` | Home's Continue: through Last.fm when not signed in as the progress's owner, in-app when signed in; the sign-in banner's button after a refused *saved* resume | `resumeFromSaved`, which refuses by itself while sending is withheld |
| `reconnect` | Home's "Re-connect to last.fm" while signed out, only when no worker is configured or its sign-in couldn't start; the sign-in banner's button after a refused progress file (#153) | Nothing; the job or resume banner takes over |

The server path records no intent and never signs in to the browser
application: it goes to Last.fm through the handoff (the worker's
application) instead; see "The server choice".

**"Already scrobbling on scrobblify?" signs in to the worker** (since
2026-11-21) when the build has one (`isBackgroundConfigured()`): Home's
"Re-connect to last.fm" sets `scrobblify.background.lookup` (sessionStorage),
calls `startReauth('')` (an anonymous worker sign-in, see "Handing over
without signing in"), emits `worker_lookup_started` and redirects, disabled
meanwhile. If no sign-in link comes back (worker unreachable) it clears the
flag and falls back to the `reconnect` browser sign-in. Home clears a leftover
flag on mount and on a bfcache restore (Back from Last.fm). On the return,
`/scrobble` remembers the worker's name for the account (`rememberWorkerUser`)
before the authority check asks by name, and once the job and saved state
have settled `reportWorkerLookup` takes the flag and emits
`worker_lookup_result`: `job` (the job banner shows), `saved` (the resume
prompt), `nothing`, or `failed` (refused, or no worker session; the "didn't
work" notice is up). `nothing` opens a dialog (`.nothing-to-resume`): "We
weren't able to find an active scrobblify session for you." with a single
**OK** that closes it and leaves the user on Upload.

**An intent only steers the sign-in it was recorded for.** Each carries
`inApp` (true from `setSignInIntent`, false from `startSignIn`) and `createdAt`
(ms). `continueSignInIntent` takes it (it is gone either way) and ignores it
unless a Last.fm intent meets a `fresh` completion or an in-app one a
completion without a token, and ignores anything older than 60 minutes (Last.fm
tokens expire in about an hour). Otherwise an abandoned trip (Back from
Last.fm, a closed tab) left its intent behind, and the next visit with a stored
session, or an "Authorize again" return that wrote none, acted on it.
`holdSelectionAwaitingSignIn` applies the same rule. Being in sessionStorage,
an untaken intent never outlives the tab.
Work still awaiting after the page has unmounted (`_unmounted`) stops without
acting, and doesn't consume an intent it hasn't taken yet.

`onAuthenticated` waits for `mounted` to settle (`_mountSettled`; the child
mounts and can emit first, while the mount is still finishing a handoff return
and the job status), raises `authorityPending`, awaits
`enforceServerAuthority`, and only then runs `continueSignInIntent`, which
reads the intent once (`takeSignInIntent`). So nothing carried over from before
the round trip can restore or send ahead of the authority check, and a live
job (or no answer) leaves the selection saved for the resume prompt to offer
later. Nothing auto-starts: the user lands on Send and presses **Scrobble**, as
after any resume. A `send` intent only acts on a saved state that is still the
unsent selection it names (`isUnsentSelection`: same `importId`, nothing
completed or pending), and only while the user is still on Upload. While coming
back, `heldForSignIn` keeps the resume prompt off that selection; a failed
exchange (`failed`, `signInFailed`) releases it as ordinary saved progress.

A return from Last.fm for a `send` or `resume` intent hides the stepper
(`settlingSignIn`, set before the first render) behind one "Signing in to
Last.fm…" line (then "Checking for plays already on Last.fm…" if asked) until
`continueSignInIntent` has moved on, so an empty Upload step never flashes
first. If the exchange fails on such a return, `AuthenticateStep` stays quiet
(`quietFailure`: no expired-link prompt, no error dialog) and the page shows
one `retry` banner, "Sign-in didn't work." with **Sign in again**, which starts
the same intent over (a `send` only while its selection is still unsent,
otherwise `reconnect`). It outranks the resume prompt, which would offer the
same saved progress. A return with no such intent keeps the old prompts.

A signed-out send saves the selection to IndexedDB as an **ordinary
`ScrobbleState` with 0 completed** before redirecting (a failed save reports
`scrobblify.saveBeforeSignIn`, shows "Couldn't save your selection before
signing in." and doesn't redirect). So **an abandoned sign-in (Back from
Last.fm, a closed tab) leaves the selection as ordinary saved progress**, and
the next visit offers it through the resume prompt and Home's card; a
`session_resumed` (`source: saved`) at 0 progress can be this. Because that
save replaces whatever is saved, it applies #102 itself: it refuses while
`sendingBlocked` (the "Hold on…" notice), and when the confirmation didn't know
of saved progress (`savedProgress` null: the resume prompt was withheld, or
another tab saved since) it reads the disk and refuses any saved state for a
different import (or with no id) with "You have saved progress that would be
replaced. Go back and choose Resume or Start over.", re-exposing it so the next
Scrobble asks. The saved selection carries no `userName` while signed out
(`buildState` stamps one only when signed in, or for a queue already on Send),
so a username `clearSessionKey()` left behind doesn't make a sign-in as someone
else look like the wrong user. The server path saves the selection the same
way, through the same checks (`saveSelectionBeforeLeaving`).

**The duplicate check waits for the username.** With "Check for duplicates"
ticked while signed out, the upload step skips it ("Duplicates will be checked
after you sign in.", `duplicates_deferred: true`, store
`deferredDuplicateCheck`), and the `send` intent carries `checkDuplicates`.
After sign-in, `dropQueuedDuplicates` runs `Scrobblify.filterQueuedDuplicates`
(the same filter, on the chosen queue, keeping its order) while showing
"Checking for plays already on Last.fm…", then "Skipped N that are already on
Last.fm." until the run starts. Its writes are **compare-and-set**, since
another tab may have moved on meanwhile: it re-reads the disk (`stillOurs`)
before writing, saves the filtered queue with `saveStateIfAhead` (which refuses
a different import or one further along), and clears an all-duplicates queue
with `clearStateIfMatching`. It gives up if the user has left Upload. If the
check fails, the queue is sent unfiltered with the upload step's error dialog;
if only the write fails, the filtered queue is sent from memory and checkpoints
save it. Both report `scrobblify.deferredDuplicates`. A signed-in user's check
still runs during upload, as before. **The server path never runs the deferred
check**: a signed-out user who chooses "Let Scrobblify scrobble for me (beta)" hands
over the queue unfiltered, because it is committed at preflight (its digest
and count), before the worker's callback says who the user is. Re-dated plays,
the bulk of a server-sized import, are exempt from the check anyway (see
"Scrobble timestamps").

`manualPause()` deliberately does **not** save. It only raises the flags; the
save and the `scrobble_stopped` event happen in the scrobble loop's pause check,
which runs *between* tracks. Saving on the click would snapshot a
`scrobbledTracks` that omits the in-flight track, so the resume would re-send it
— and for a re-tagged play that means a freshly allocated timestamp and a
phantom duplicate scrobble.

**Progress is checkpointed mid-run**, silently (no `session_saved`): every
`CHECKPOINT_EVERY_TRACKS` (25) tracks, between tracks, and at the start of every
countdown wait. Before 2026-09-27 a save only happened on a terminal stop or a
save button, so closing the tab mid-run lost everything since. Separately, "Save
Progress & Leave" during a transient countdown saved and navigated away but did
**not** stop the loop — it carried on scrobbling unseen behind the Complete step
once the countdown ended. Both made the next resume replay already-sent tracks:
42% of resuming users had a resume with *lower* `completion_pct` than their
previous event, replaying a median of ~340 tracks (143k in total over 60 days).
**Session-over-session drops in `completion_pct` before 2026-09-27 are this bug**,
and those replays also inflate `total_succeeded` and burn daily budget.
`saveAndExit()` now sets `leaving` and cancels the countdown so the loop returns.

All writes to the saved session go through `persist()` in `Scrobblify.vue`,
which serializes them. Each save opens its own IndexedDB connection, so without
the queue a checkpoint issued just before completion could land after the
completion's clear and resurrect a finished import as resumable.

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

**`total_succeeded` counts only plays read back from the user's library**, from
the daily-cap fix (2026-11) on. Before it, it counted every `accepted` reply,
and since Last.fm's cap dropped to 750 on 2026-06-24 that overstates heavy
users by up to ~1,950 per day each: **`total_succeeded` and `completion_pct`
from 2026-06-24 until the fix are inflated** wherever a user sent more than ~750
in a UTC day. Events now also carry `unconfirmed_tracks` (sent, not yet read
back) and `not_stored_tracks` (accepted, then missing on a full day), and since
#137 `library_unreadable` (Last.fm refused the read-back this run, so
`unconfirmed_tracks` will not be confirmed; see "Last.fm's daily cap").

**Hidden-profile users confirmed nothing from build 50 (#125) until #137.** The
read-back was unsigned, which Last.fm refuses with error 17 for a user who
hides their recent listening, so their `total_succeeded` stayed flat while
`unconfirmed_tracks` grew to the import size. In that window, a user with
`scrobble_verify_failed` `Last.fm API error 17` has plays that were sent and
almost certainly stored, not lost.

Even now it is an **upper bound** for real-dated plays: Last.fm silently
discards a scrobble duplicating an existing (artist, track, timestamp) while
reporting it as accepted, and the read-back matches on timestamp, so the
existing play confirms the duplicate.

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
reTagCursorSec = max(reTagCursorSec + 1, nowSec - RETAG_BACKFILL_SECONDS, todayUtcMidnightSec)
```

If that is ahead of the clock (a run just after UTC midnight), the loop waits
for the clock rather than send a future timestamp (ignore code 4). The midnight
floor keeps a whole run on the one UTC day whose cap it checked; see below.

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

## Last.fm's daily cap

Last.fm stores at most **750 scrobbles per UTC calendar day of the scrobble's
timestamp** (`LASTFM_DAILY_CAP` in `src/shared/lastfm/dailyCap.ts`, shared with the worker), the user's own
listening included. Everything past it is answered exactly like a stored play —
`accepted=1, ignored=0`, no `ignoredMessage` — and thrown away. Undocumented;
measured in 2026-11 by comparing PostHog against `user.getrecenttracks` for ~40
heavy user-days: every one stored exactly 750, and one run whose re-tagged
timestamps straddled UTC midnight stored 750 on each side (so it is keyed on the
timestamp's day, not on send time or a rolling 24h). Last.fm announced a lower
cap on 2026-06-24 without a number. Before the fix the app paced to 2,700 per
rolling 24h and counted every accepted reply, so heavy users were told ~2,700 a
day were scrobbled while ~750 were kept (#106: "10k scrobbled", ~4k on Last.fm).
Those losses are not recoverable from saved progress, which recorded the
dropped plays as done.

Because the reply can't be trusted, `ScrobbleStep` treats Last.fm's library as
the source of truth:

- **Budget.** Before sending a play, it reads how many scrobbles that UTC day
  already holds (`LastFm.countStoredScrobbles`, `limit=1`, reads `@attr.total`)
  and stops at `LASTFM_DAILY_CAP - OWN_LISTENING_HEADROOM` (50, left for the
  user's own scrobbler, which would otherwise lose the rest of that day's real
  plays). For today it stops as `daily_limit` and says when midnight UTC is in
  local time; a play keeping its real date on a past full day is recorded as
  failed, since that day never resets. Re-tagged seconds never go back past
  today's UTC midnight, so a run stays on the one day it checked; just after
  midnight the cursor can overtake the clock by a few seconds and waits it out
  (up to `RETAG_CLOCK_WAIT_MAX_SECONDS`). A *reserved* range after a background
  take-back can reach into past days: full ones are skipped, and running out
  falls back to the normal window. A pinned second always goes through
  unchecked. The count is re-read at every checkpoint. `RateLimitTracker` no
  longer has a daily limit; its `dailyCount` is telemetry only.
- **Verify.** An accepted play goes into `pending`, not the count. At every
  checkpoint, at the start of every run (including resumes) and at the end,
  pending plays are read back. Not before most stops: the stop is already on
  screen, and a "Try Again" during a slow read would hit the loop's re-entry
  guard and do nothing. `daily_limit` is the exception, verified before its stop
  is shown. Reads are one `user.getrecenttracks` range per UTC day, matched on **timestamp
  alone**: Last.fm may autocorrect artist/track names, so a name match would
  call a stored play lost and re-send it as a duplicate.
- **Lost only on a full day.** A pending play missing from the library is
  re-checked after 5s, and then only counted as lost if its day now holds
  ≥ 750. Otherwise it may just be listing lag, and re-sending a re-tagged play
  (with a fresh second) that *was* stored would duplicate it, so it stays
  pending. Lost re-tagged plays are appended to the queue (`requeueScrobble`;
  everything before them stays index-addressed, so save/resume is unchanged);
  lost real-dated plays are failed. A loss on today stops the run as
  `not_stored`.
- **Persisted.** Pending plays are saved as `pendingVerification` (with the
  timestamp they were *sent* with) inside the completed range, so a resume
  re-checks them instead of re-sending. If the library can't be read (network,
  private profile) they stay pending, the run carries on, and the Complete step
  reports them as "sent, couldn't confirm" rather than counting them.
- **Signed reads.** Every `user.getrecenttracks` (budget, verify, the upload
  duplicate check and a background take-back's repeat check) goes through
  `LastFm.readRecentTracks`, which signs it with the session key (`sk` +
  `api_sig`) when there is one, as the worker always has. Last.fm refuses an
  *unsigned* read of a profile with hidden recent listening (error 17,
  "User required to be logged in") but answers its owner (#137). A key it
  rejects (error 9) is retried unsigned, as every read was before: the
  scrobble loop's `session_invalid` stop handles the dead key, and a public
  profile's history stays readable meanwhile. Credentials in a failed read's
  error message are redacted like any other request's.
- **Refused for good.** If a read still fails with error 17, the run sets
  `libraryUnreadable`: no more reads until the next run (each run asks again,
  in case the setting changed), the budget falls back to this browser's own
  sends, and the scrobbling and paused panels say Last.fm won't let Scrobblify
  read the listening rather than "being checked" / "checked when you resume".
  Every scrobble event carries it as `library_unreadable`.

The Last.fm mock (`tests/lastfmMock.js`) models this, for Playwright and
`dev:mock` alike: its library is stateful, enforces the cap per UTC day and
fills itself (`recordScrobble`) from any `track.scrobble` response that says
accepted, including ones a test answers with its own route. `hiddenProfile`
(`interceptLastFm(page, { hiddenProfile: true })`, or `npm run dev:mock --
--hidden-profile`) refuses unsigned `user.getrecenttracks` with error 17, and
`recentTracksError` fails every one, signed or not, with the given code.

**The background worker budgets the same way, but does not verify.** Before
each batch the scheduler reads the day's count (`LastFmClient.countScrobbles`,
once per UTC day per run, then advanced by what it sends) and sends only what
fits under `importBudget`. Re-tagged seconds stay on today (`assignTimestamps`'
`dayFloorSec`); once today is full the job waits until
`DAY_RESUME_OFFSET_SECONDS` (20 min) past the next UTC midnight, with
`DAY_FULL_REASON` on the job card. The offset exists because the worker's
allocator marches *down* from the present and never below midnight, so at
00:01 it would have a minute of seconds to spend. A real-dated play on a full
day is failed without being sent (`DAY_FULL_FAILURE`); repeats (pinned retries,
reused seconds) go through unchecked; a count that can't be read sends nothing
and counts as a failed attempt. Estimates (`describeJob`, `ServerChoice`)
use `importBudget(0)`, 700 a day. What it still lacks is the read-back:
`scrobbled_count` counts accepted replies, so the user's own scrobbler landing
between the count and the send can still tip a day over, and pending browser
plays handed over in a handoff are never verified. **Jobs before 2026-11-15
paced to 2,700 a day: everything past ~750 on a day was lost and counted as
scrobbled.**

## Import robustness

A Spotify export is split across many `Streaming_History_Audio_*.json` files and
real ones do arrive damaged — truncated downloads, and large exports that read
back corrupted on memory-constrained mobile browsers. **A file that can't be
read or parsed is skipped, not fatal**; the import proceeds with what survived
and warns the user in the log. Only a ZIP where *every* history file fails is an
error. Don't "simplify" this back into an early return.

The same goes for **rows**: `parseSpotifyJson` skips a play whose track or
artist isn't text (finite numbers are coerced, so an artist named `1975`
survives) or whose `ts` isn't a date, and counts it. The log says
"Skipped N plays…" and `upload_parse_completed` carries `skipped_rows`. One
non-string artist used to throw `t.split is not a function` and skip the whole
file (#122), so `upload.parseJson` errors with that message Before 2026-11-16
are this, not corruption.

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

- `.json` → imported as a progress file — *unless its content is a Spotify
  history file* (`StateManager.assertIsProgressFile`, which also guards the
  banner's "Import from file"). Users drag a `Streaming_History_Audio_*.json`
  out of an opened ZIP, or pick one from the "Account data" export, and those
  used to fail as `Invalid state file: missing required field "totalTracks"`,
  reported under `scrobblify.onImportFile`. They now get a
  `NotAProgressFileError` whose message tells them what to upload instead, so
  **`totalTracks` errors before 2026-09-27 are mostly this wrong-file mistake,
  not corrupted progress files.** Any other JSON *object* (Spotify's
  `YourLibrary.json`, `Userdata.json`, …) is refused the same way, as
  `detected: unknown`. A file only counts as a progress file if it has at least
  one of the Scrobblify-only counters `totalTracks` / `completedIndices` /
  `failedIndices`, and `tracks` alone doesn't count, because `YourLibrary.json`
  has one. So a `missing required field` error now means a genuinely damaged
  progress file.
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

`npm run dev:mock` starts a dev server on **port 8090 by default** (or `$PORT`
when set) whose Last.fm is served by mock middleware in `vue.config.js`.
`npm run dev:mock:bg` adds a fake
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
sign-in handler (`AuthenticateStep`) runs for real: the app exchanges the token against the mocked
`auth.getSession` exactly as it would in production. The token must be fresh per
click, because `LastFm.init` records the token it has begun exchanging in
sessionStorage and refuses to resubmit it.

**dev:mock never reuses a server and defaults to 8090 rather than 8080.** Both
halves matter.
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

The handoff offer is rolled out two ways: visit any page with `?beta=1` to opt a
browser in, or `?beta=0` to opt it out (stored as `'0'`, which also overrides
the flag). Otherwise the PostHog flag **`scrobblify-background-scrobbling`**
decides: `test_scrobblify` gets 100%, and you ramp it up by raising the 0%
"everyone" condition. The flag is honoured **before sign-in too** (since
2026-11-21, because the server choice is moving ahead of sign-in):
`isFeatureEnabled` no longer requires identification. Before `identifyUser`,
PostHog buckets on its random per-browser distinct id; once `identifyUser` has
made the Last.fm username the distinct id (`$user_state` `identified`,
`isIdentified()`), the username decides, so a user's bucket is the same on
every browser and survives a raised percentage (PostHog's hash is stable; only
lowering it removes people). The two buckets can disagree for a brand-new
user's first offer; recovery paths don't read the flag, so a job already handed
over is unaffected. When PostHog is blocked or on localhost, it reads false.
`Scrobblify.vue` listens through
`onFeatureFlags` (flag reloads and `identifyUser`) and re-probes capacity, or
withdraws the offer, as it changes.
Locally, `localStorage['scrobblify.flags'] = '{"scrobblify-background-scrobbling":true}'`
forces it (non-production builds only). `background_offer_shown` carries
`offer_source` (`opt_in` / `flag` / `flag_anonymous`; `flag_anonymous` is the
flag answering for a browser PostHog hasn't identified yet, from 2026-11-21)
and `entry_point` (`scrobble_step`, `resume`, `sign_in` for a selection
restored after signing in, or `confirm` for the confirm dialog's server
choice, both from 2026-11-21), which its decline and opt-in events repeat.
`background_offer_declined` from `confirm` always carries `all_re_tagged:
false` (#163), so split decline rates by it only for the other entry points.

`App.vue` applies `?beta=` once per page load (`consumeBetaParam`, in
`created()`), so an invite link works on any page (in dev's hash mode, editing
only the hash doesn't reload, so it applies on the next load), and shows a
**BETA** tag in the header whenever `isBackgroundEnabled()` (re-read on
`onFeatureFlags`), or while Home shows this user's live server job
(`showingServerJob`). Whenever `isBackgroundEnabled()`, every page also shows
the beta banner (`#beta-banner`, back since 2026-11-21): "You're trying the
scrobblify beta. Something not working, or have a suggestion? Email
niko@savas.ca." and a **Switch it off** link, `betaOffHref`, which reloads the
current page with `?beta=0` added to the real query string (built from
`location`, since dev's hash router doesn't own it). Only the explicit opt-in counts in
`mayScrobbleWithoutAuthority`'s outage rule, so it doesn't depend on flag-load
timing. All of this is independent of `VUE_APP_BACKGROUND_API`, which
only says whether the build *can* reach a worker.

`scrobblify.background.handedOverImport` (localStorage) holds JSON
`{ importId, username, originalTotal? }` for the queue this browser last handed
over (`originalTotal` is the import's `originalTotalTracks`). It is written in
`completeHandoff` when a handover goes live, under the queue's `userName` or,
for a selection saved signed out, the account the worker named in the return,
and cleared after a confirmed
take-back; when a handover has no import id or user (so it never names an
older one); when `completeHandoff` finds no local state while the handoff is
active (its import id can't be known); and when Home sees the job ended or
unknown to the worker.
Home uses it, only for the same Last.fm user (case-insensitive) and only while
the job is live, to show progress through the public `/scrobblify/import/:id`
route; a signed-out or on-hold job gets the plain card. That route counts only
the tracks the worker was handed, so `overallProgress`
(`src/services/ReturningVisitor.ts`) shows the whole import as
`originalTotal - (totalTracks - scrobbledCount)` of `originalTotal`; plays this
browser gave up on before the handover count as done there. A record without
`originalTotal` (older ones) falls back to the server's own numbers. It is display-only and
deliberately **not** handover evidence.

Two functions in `src/services/BackgroundScrobbling.ts`, and the split is
load-bearing:

- `isBackgroundEnabled()` — configured **and** (opted in, or flagged and not
  opted out); see `backgroundOfferSource()`. Guards the *offer*
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

**A blocked browser can choose to carry on.** The "We can't reach the
background scrobble worker" banner offers "Continue in this browser anyway"
next to "Try again", warning of double scrobbles if the worker is also
scrobbling
(`continueWithoutAuthority`). Without it, an opted-in browser, or one with a
trace of a handover, was blocked for as long as the worker was unreachable.
The choice lasts for the page load only. It lifts only the no-answer gate: a
later `live: true` answer still blocks, and it is **never offered over a
local ownership record** (`queueOwner()`), whose queue is known to be on the
server. It also lets a progress file through `importedQueueMaySend` on no
answer. It emits `background_authority_overridden` (`opted_in`,
`handover_evidence`), and `handover_evidence: true` is the case where
duplicates are actually possible.

**The page shows one banner at a time**, picked by the `banner` computed in
`Scrobblify.vue`: outage, then a server job, then the Last.fm sign-in prompt,
then the sign-in `retry`, then the resume
prompt, then a `backgroundNotice` on its own. A
`backgroundNotice` that isn't the banner shows as the winning
banner's first line. While the worker is unreachable, notices that need the
worker to act on (`NEEDS_WORKER_NOTICES`, the expired-connection "Fix now")
are dropped entirely, and so is the scrobble step's "Checking…" text.

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

**The server choice** (since 2026-11-21). Beta users choose the server in the
"Scrobble N tracks?" dialog itself, before any sign-in.
`ScrobbleConfirmDialog` picks a `stage` when it opens, so a capacity answer
arriving meanwhile doesn't swap it: `saved` when there is saved progress
(#102's prompt comes first, unchanged), else `choice` when
`backgroundCanFinish(trackCount, backgroundTrackLimit)` holds (beta, the
server has room, no job listed, the browser can compress, at least 750 plays
and no more than the worker's `maxTracks`), else `plain`, the old dialog.
**Start over** goes on to `choice` when it would show. `choice` is titled
"Scrobble {n} tracks?", like the plain dialog, and holds `ServerChoice` (`src/components/ServerChoice.vue`): the days
at 700 a day, the "will not have the correct date" note when some selected
plays are re-dated, the over-60-days warning, **Let Scrobblify scrobble for
me (beta)**, **Details** and "or scrobble locally". Entering it emits
`background_offer_shown` (`entry_point: confirm`); "scrobble locally" emits
`background_offer_declined` and carries on as the `tab` path (a Last.fm
sign-in first when signed out). The server button emits `tracks_selected`
`path: server`, and `onSelectionComplete('server')` saves the selection
(`saveSelectionBeforeLeaving`, nothing sent), sets `pendingEntryPoint`
`confirm` and runs `startBackgroundHandoff` with whatever username this
browser knows, possibly none (see "Handing over without signing in"). If the
handover doesn't happen, the saved selection is offered again (see "A handoff
that never reaches the worker unfreezes this browser").

`BackgroundOffer` is now a small dialog around the same `ServerChoice`, for
the mid-run (`scrobble_step`) and `resume` entry points; its consent copy
("What you're agreeing to", "Not now") is gone, with the data and beta notes
behind Details. The scrobble step's "Don't want to keep coming back? / Finish
this in the background" alert is now a text button, **Scrobble the rest for
me →**, and a stopped, auto-saved panel reads "Stopped. You can resume at any
time, or have scrobblify scrobble the rest for you." with the offer as a link.
Both follow `ScrobbleStep.canOfferBackground`, which takes the parent's
`backgroundTrackLimit` (0 while a server job is listed) and needs the
remaining plays between 750 and that limit, matching the parent's
`canOfferBackground` (`remaining <= backgroundMaxTracks`). Before, the button
showed while a job was listed and did nothing (#149), and a queue over the
limit got the offer and a trip to Last.fm before the worker refused it as
`too_large`. Its `role="button"` links answer Enter and Space.

**The job limit stays at 60 days.** `MAX_TRACKS_PER_JOB` is
`TRACKS_PER_DAY * 60` (42,000), the capacity probe's `maxTracks`.
`worker/test/jobsize.test.ts` measures the worst-case upload (every play
distinct, seeded 24/40/40-character names, all re-tagged) at about 80 KB per
1,000 plays, so 89,000 would fit `MAX_JOB_COMPRESSED_BYTES` (8 MB) with 10%
headroom, and briefly was the limit. It went back because other costs grow
with job size and aren't bounded yet: a take-back's export exceeds Workers
Free's 50 D1 queries past ~21,000 tracks left (#158), and settled batch rows
can fill the main database (#159). Raise it once both are fixed.
`ServerChoice` already warns ("That's more than 60 days of scrobbling…") when
the count needs more than 60 days at 700 a day, which today's limit never
allows (42,000 is exactly 60 days). The mock worker's `MAX_TRACKS` matches;
its `maxTracks` option raises it for a test.

**Handing over without signing in** (since 2026-11-21). The worker takes a
handoff and a sign-in with no username and adopts the Last.fm account that
authorises, at its callback:

- `POST /scrobblify/handoff/preflight` takes `username` absent or empty (a
  non-string is still `bad_request`); the client leaves it out when empty.
  `reserveSlot` reserves a capacity slot as usual but skips the per-user check
  and stores `username = ''`, `live_username = NULL`, so anonymous preflights
  don't clash. `handleCallback` runs the per-user check there instead, on
  `auth.getSession`'s normalised name and before the key is kept: if a job or
  another handoff holds that `live_username`, the handoff fails as
  `already_live` and the key is discarded, as on a mismatch. It then adopts
  the name (`UPDATE … WHERE username = ''`; a unique-index clash is
  `already_live` too) and checks jobs once more, since a sign-in could have
  re-attached a parked job in between. A named handoff keeps its
  `username_mismatch` check.
- `POST /scrobblify/auth/signin` likewise takes no username (`u: ''` in the
  signed state). Its callback signs in whoever authorised and
  `reattachCredential`s only their own job; the nonce still ties the return to
  the browser that asked. A named sign-in keeps its check.
- Both success fragments add `user=` (Last.fm's spelling):
  `#session=…&handoff=…&user=…` and `#session=…&nonce=…&user=…`.
  `consumeRedirectFragment` returns `{ session, handoffId, user }` and
  `consumeReauthFragment` `{ user } | null` (it was a boolean); `user` is
  empty from older workers.
- The browser remembers that name **without a session key**
  (`rememberWorkerUser`: `setUserName` and `identifyUser`, only when it knew
  no one), so Home can welcome them and the authority check can ask by name,
  while the browser stays signed out of its own Last.fm application, as
  `clearSessionKey()` leaves it. Always on a handoff return; on a worker
  sign-in only for Home's lookup ("Signing in after choosing").
- `?handoff=failed&reason=already_live` shows "You already have an import
  running on Scrobblify." with the sign-in button relabelled **Sign in to see
  it** (`reauthLabelText`). `reauthenticate` no longer needs a username (the
  "Sign in to Last.fm first, then try again." notice is gone): an anonymous
  worker sign-in shows the job.
- **A replayed callback gets a session only with the same token** (#157).
  Duplicate callbacks are routine (scanners, a second tab), so one for an
  exchanged handoff answers with the winner's outcome, which the API turns
  into a worker session. But the `state` is in the authorise URL, so whoever
  preflighted holds it: anyone who got a victim to approve their link could
  replay the callback with any token and get a session for the victim's
  account, and an anonymous link works on whoever approves it.
  `handleCallback` stores the SHA-256 of the token that claimed the exchange
  (`exchange_token_hash`, migration `006`), and a replay succeeds only with
  the same token; any other gets `?handoff=failed&reason=replay` and no
  session. Rows claimed before the migration have no hash and fail closed.

The mock worker adopts `testuser` (`MOCK_USER`, or its `username` option) for
an anonymous preflight or sign-in and names it in the shim URL (`user=`, which
the shim writes to `scrobblifyLfmUserName`). An anonymous preflight while a
job is live gets a shim URL with `fail=already_live`, returning
`?handoff=failed&reason=already_live` as the real callback would.

**A confirmed handover lands on Home** (since 2026-11-22). The real worker
redirects to `APP_URL` (`worker/wrangler.toml`,
`https://savas.ca/scrobblify/scrobble`) as
`?handoff=ok&job=…#session=…&handoff=…&user=…`; the production router (history
mode, base `/scrobblify/`) routes that to `/scrobble`, whose `mounted` runs
`resumeHandoffIfReturning` before anything else. The mock worker's shim
returns to `/?handoff=<id>#/scrobble` with the session in localStorage
instead (see `tests/backgroundMock.js`). Once `completeHandoff` answers
`active` (the point that records the `server` queue owner and
`handedOverImport`) and that record names the user this browser knows (the
worker's name when it knew no one), the page `$router.replace`s to Home, whose
welcome-back card shows "Scrobbling to {user}" / "Scrobbling remotely, it's
safe to close this tab." `stripQuery` has already removed the query and
fragment; dev's hash router keeps the load's query in its base but writes
hash-only URLs, so it doesn't come back. Everything else stays on `/scrobble`
as before: failures, `already_live`, an unresolved or unknown outcome, a
take-back, and a handover recorded for someone other than the known user (or
not recorded, e.g. no import id), where Home's card would be about the wrong
thing. `/scrobble` afterwards still shows the job banner (Pause, Take my
progress back).

**A handoff return is accepted only for a handoff this browser preflighted**
(#157). `preflight` records the id in localStorage
(`scrobblify.background.preflighted`) before the redirect, and
`consumeRedirectFragment` strips a `#session=…&handoff=…` fragment naming any
other id, stores nothing and emits `background_handoff_return_rejected`; a
match consumes the record. Anyone can preflight a handoff and send its Last.fm
link to someone else, so without this the victim's browser stored the
stranger's session and uploaded its own queue into their handoff. A return is
also accepted when the queue-owner record is the `freezing` one naming that
handoff: builds before the server choice wrote only that, and a handoff
started in a tab on one returns (a fresh load) to the current build, which
used to strip it, store no session and leave the queue frozen. That fallback
can go once those builds are gone (roughly 2027-01). The dev
shim (`/mock-auth`) writes localStorage directly and never goes through the
fragment, so `tests/unreachable-worker/` exercises the check by rewriting the
URL and calling `resumeHandoffIfReturning`.

**A handoff that never reaches the worker unfreezes this browser.** Handing
over writes a `freezing` queue-owner record naming the preflighted handoff, and
a worker session only comes with a *successful* callback, so a browser that
came back any other way could never ask about it and stayed blocked ("A
handover is starting in another tab…", then "…on hold", for good):

- Any `?handoff=failed` return (denied, `exchange_failed`, `already_live`, …)
  withdraws this browser's preflighted handoff at the worker (below, in case
  the refusal left it waiting) and then calls `releaseAbandonedHandoff()`,
  which lifts only a freeze naming that handoff, and forgets the preflight
  (#160), whatever the withdrawal answers.
- Back from Last.fm without approving (a reload, or a bfcache restore), with no
  worker session: `ownHandoffWasTaken` asks `/scrobblify/import/:id` about the
  saved queue. `known: false`, or `known: true, pending: true` (the worker
  still holds this very handoff, unapproved), withdraws and releases it
  (`abandonOwnHandoff`) and offers the saved selection again (on a reload,
  `background_freeze_released` `reason: handoff_not_taken`); any other `known: true`
  blocks as a handed-over queue, with the worker sign-in; no answer changes
  nothing. Only in the tab that preflighted it (`isThisTabsHandoffFreeze`:
  `preflight` keeps a sessionStorage copy of the id, which survives the
  same-tab round trip and Back), and before the 3-minute freshness rule, since
  that tab is the one that came back. The localStorage record is every tab's,
  so without that a tab loading while another waited at Last.fm abandoned its
  handoff, and the approval then failed; other tabs get the freshness rules
  until it expires (next bullet).
  Released only when the withdrawal is confirmed (`abandoned: true`) or
  unanswered: `abandoned: false` means the handoff got past waiting (approved
  since the queue was asked, say), so both records stay and the queue is asked
  again (`releaseOwnHandoff`): a job blocks, nothing on its way (failed or
  reaped while away) releases, still on its way holds. Forgetting the preflight is what makes this safe even if the
  withdrawal goes unanswered: approving that handoff later gets a return this
  browser refuses, so the queue is never uploaded.
- Another tab's freeze (its tab closed at Last.fm, say) is settled by the
  queue too once it can't be approved any more (#168): its attempt token is
  older than the worker's handoff TTL plus 5 minutes (`freezeHandoffHasExpired`;
  the client's `HANDOFF_TTL_SECONDS` mirrors the worker's). Then `known: false`
  releases (`background_freeze_released` `reason: handoff_not_taken`), a job
  blocks, and `pending` (not yet reaped) or no answer keeps "…on hold… Please
  refresh in a few minutes." Nothing is withdrawn from such a tab. Before the
  hour is up, a tab that can't ask (no worker session) says the handover
  "expires within the hour: refresh then", since an earlier refresh changes
  nothing unless the other tab finishes. Before this, those tabs stayed on hold
  for good.
- A handover from the confirm dialog that fails before leaving (full,
  preflight failed, a halt or freeze failing: `startBackgroundHandoff`
  resolves false) offers the saved selection again, so the next Scrobble
  asks Resume / Start over instead of refusing to replace "saved progress"
  that is the same selection with a fresh import id (#102's check).

**A browser withdraws a handoff nobody approved** (#164, #165).
`POST /scrobblify/handoff/:id/abandon` (`abandonHandoff` in
`worker/src/handoff.ts`) moves a handoff from `issued` to `failed` with
`failure_reason` `abandoned`, a compare-and-set from `issued` only, so an
approved one (`exchanging` and later, the only states with a job or a
credential) is never touched. It answers `{ ok: true, abandoned }`, `false`
for any other state *and* for an unknown id (200, not 404, so it reveals no
ids). It needs no session, since the browser coming back without approving
never got one; the 128-bit random handoff id is the capability, and an
`issued` handoff has nothing to steal, so the worst a holder of the id can do
is cancel a pending approval. Failing it clears `live_username` (so
`/job/live` stops answering live, and the capacity slot frees) and drops it
from `/import/:id`; `handleCallback` refuses a failed handoff, so approving
its Last.fm page later redirects `?handoff=failed&reason=abandoned` with no
job and no stored credential (`background_handoff_failed` `reason:
abandoned` counts these late approvals). Before this, an unapproved handoff stayed
`issued` until reaped (`HANDOFF_TTL_SECONDS`, an hour): a named one kept its
user live, so a signed-in browser coming Back was blocked as "still running
on the server" (#164), and a late approval made a job that marked the queue
handed over for good (#165). The client (`abandonOwnHandoff` →
`abandonHandoff`, 3s timeout, best effort) only ever sends this browser's own
preflighted id, and is awaited before the page-load authority check.

**`/import/:id` counts a handoff only while it can still become a job**
(#162). Jobless handoffs that ended (`failed`, `reaped`: Back or a denial on
Last.fm, a failed exchange, the reaper) are left out, since chunks are only
accepted once the callback has made a job. A jobless one still in flight
(`issued`, `exchanging`) answers `known: true` with `pending: true` (not when a
job row carries the id too). `importStatus` exposes it, and every check but one
treats it like any other `known: true` (a handover may be on its way from
another tab or device): Home's welcome-back card (`detectReturning`, which only
reads `live` and `state`), the page-load authority check and the progress-file
check (both through `queueWasHandedOver`). The exception is the queue whose own
pending handoff this browser abandoned *without the worker confirming the
withdrawal* (no answer, or a worker without the route): releasing that freeze
then records the import id (`scrobblify.background.abandonedImport`, cleared
by the next preflight), and `queueWasHandedOver` waives `pending` answers for
it, so signing in to Last.fm after coming back doesn't block the selection
anyway. A confirmed withdrawal records nothing, since the handoff no longer
counts. Before #162, every never-approved handoff blocked its queue for good.
The mock worker records handoffs at preflight (`pending`), fails them on a
shim `fail` return (`authoriseFail` option, and the anonymous `already_live`
refusal) or a withdrawal, refuses a shim approval of a failed one, counts a
named in-flight handoff as live in `/job/live` as the real worker does, and
gives them a job at finalize. An unanswered withdrawal still leaves the old
behaviour: the user live in `/job/live` until reaped, and a late approval's
job marking the queue `known` for good.

### The job card refreshes itself

The scheduler only runs every five minutes (`TICK_INTERVAL_SECONDS`, which must
match the cron in `worker/wrangler.toml`), so a count that sits still looks like
a stall. `/scrobblify/job` therefore carries `nextRunAt` for active jobs: the
next cron boundary at or after `next_eligible_at`, or now while a tick holds the
lease. The card shows it ("Next batch around 4:25 PM (in 3 minutes)", then
"Sending a batch now") with "Last checked", and re-fetches the job
`JOB_POLL_AFTER_RUN_SECONDS` (45s) after each `nextRunAt`, clamped to 15s–10min.
It only polls while the job is `active` and the tab is visible, and checks at
once when the tab is shown again, so expect one `/scrobblify/job` request per open
tab per tick. A failed check keeps the last card rather than clearing it: a
null `backgroundJob` would bring back the Resume prompt for a queue the server
still holds. A poll that resolves after a pause, resume or take-back is
discarded.

`dev:mock:bg` ticks every 20s (`tickSeconds` in `createMockWorker`) in steps
like the real worker, so the countdown and refresh can be watched.

## Linting

`npm run lint` auto-fixes; `npm run lint:check` (`--no-fix`) is what CI runs, so
use that to see what CI will see. The config is ESLint + `@vue/airbnb` +
`@vue/typescript`.

Several airbnb rules are switched off in `.eslintrc.js` because they fight
patterns this codebase uses on purpose — each has a comment explaining why.
The load-bearing one: **`no-underscore-dangle` is off because large or
deliberately non-reactive state lives in `_`-prefixed properties assigned
straight onto the component instance, outside `data()`** — that is how
`SelectStep` holds large track arrays cheaply (`ScrobbleStep` and `Scrobblify`
do the same for the rate-limit tracker and the save queue). Vue never makes
those reactive, and Vue 3 refuses to proxy `_`-prefixed `data()` keys at all, so
moving them into `data()` would either break them or make every element
reactive and tank performance on big histories.

Warnings (mostly `no-explicit-any`) do not fail the build; only errors do.

## Local servers and ports

Several worktrees of this repo are often checked out and running at once, so
**never start a local server on the default port 8080**. Pick a free port for
your worktree and pass it through the `PORT` environment variable, which
everything here honours — `vue-cli-service serve` (so `npm run serve`),
`playwright.config.ts` (both the server it starts and `baseURL`), and
`npm run dev:mock`:

```powershell
$port = Get-Random -Minimum 8100 -Maximum 9000
while (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $port++ }
$env:PORT = $port
npx playwright test   # or: npm run serve / npm run dev:mock
```

Set `PORT` in the **same command** that starts the server or runs the tests —
agent shells don't keep environment variables between calls, and a run that
loses it falls back to 8080 (or 8090 for `dev:mock`) without complaint. Reuse
the same port for the rest of the session so later runs find your server instead
of starting another, and stop any server you started when you're done.

`vue-cli-service` quietly moves to the next free port if the one requested is
taken, so read the URL it prints rather than assuming.

## Running the tests

Playwright is the only test framework here — there are no unit tests. Analytics
is disabled on `localhost`, so **a test can never observe a PostHog event**;
assert on the UI instead.

`playwright.config.ts` sets `reuseExistingServer: true` on `$PORT` (default
8080). If a `vue-cli-service serve` is already running there **from another
checkout or worktree, Playwright will happily test that checkout's code instead
of yours** and say nothing. This has already produced three "verified" results
that were really the other tree's build — the main reason for the per-worktree
port above. Before trusting a local run — especially one verifying a fix —
confirm what owns the port:

```powershell
Get-CimInstance Win32_Process -Filter "ProcessId = $((Get-NetTCPConnection -LocalPort $env:PORT -State Listen).OwningProcess)" |
  Select-Object -ExpandProperty CommandLine
```

CI is unaffected, since it starts from nothing and uses the default.

Verify a regression test actually catches its bug with
`git stash push -- <source file>`, re-run, `git stash pop`. A test that passes
both ways is testing nothing.

To compare against an older build (before/after screenshots, say), check it out
with `git worktree add --detach <dir> <sha>` and serve it on its own port. If you
link `node_modules` into it with a junction instead of installing, **delete the
junction first** (`Remove-Item <dir>\node_modules`, which removes only the link)
before `git worktree remove`: removing the worktree follows the junction and
empties the real `node_modules`. `npm ci` restores it.
