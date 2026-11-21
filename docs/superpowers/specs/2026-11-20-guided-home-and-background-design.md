# Guided home and first-party background scrobbling

Date: 2026-11-20
Status: draft for review

Companion files:

- `2026-11-20-guided-home-strings.md`: every user-facing string. **Authoritative
  for copy.**
- `2026-11-20-guided-home-mockups.html`: every screen and state. Layout only;
  its copy is placeholder and predates the strings file.

## Goal

Make Scrobblify easy to follow with much less text, and make background
scrobbling feel like a built-in part of the product for beta users instead of a
banner and a pop-up.

There is **no visual rebrand**. The Vuetify theme, colours and header stay as
they are; the change is structure and copy.

## Summary of changes

1. **Home** becomes a short landing page with two equal choices, plus a
   returning-visitor card. The long explanations move to an FAQ on About.
2. **Sign-in moves** from the first step to after the user has chosen how to
   send, and asks only for the Last.fm connection that path needs.
3. **The server choice** lives in the existing "Scrobble N tracks?" dialog for
   beta users with large imports, with the server as the default.
4. **A status page** replaces the background job banner and job card.
5. **Server changes**: a larger per-job limit, automatic resume after signing in
   again, and a recorded cause when a job goes on hold.

## 1. Header

- Unchanged, except a static **BETA** tag next to the wordmark for beta
  browsers (`isBackgroundEnabled()`). No popover.
- The "Background scrobbling (beta) is switched on for this browser" banner is
  removed. `?beta=0` still opts out.

## 2. Home (`src/views/Home.vue`, rewritten)

### First visit

Title, then two equal cards side by side (stacked on mobile):

| Card | Action | Event |
| --- | --- | --- |
| Already got your streaming history zip? | → `/scrobble` (upload step) | `home_choice` `choice: have_export` |
| Don't have it yet? | Swaps the cards for the three "get your history" steps, in place, with ← Back | `home_choice` `choice: get_export` |

Below the cards: "Already scrobbling on scrobblify? Re-connect to last.fm" → the
"already used" sign-in path (section 4.4), `home_choice` `choice: resume`.

### Returning visitor

Shown instead of the first-visit content when this browser has a stored Last.fm
username or saved progress (`StateManager`). One card:

| Situation | Card |
| --- | --- |
| Saved progress | Title, labelled progress bar, **Continue** |
| Last known server job (from this browser's handover record) | Title, bar, "Scrobbling in the background!". No button |
| Username only | Title, **Upload Spotify zip**, "Not you?", "Show me how" |

**Continue** resumes the saved progress through the resume entry point of the
server choice (section 5) *before* any sign-in, then signs in to whichever
Last.fm application the chosen path needs (skipped if this browser already has
it). This is how a user who started scrobbling locally and has since joined the
beta is offered the server for the rest.

"Not you?" clears the stored username (existing `clearToken` behaviour).
"Start over" (saved-progress states) goes to the upload step; the existing
saved-progress prompt (#102) still guards the replacement.

Emits `home_returning_shown` with `state` (`saved_signed_in`,
`saved_signed_out`, `server_job`, `username_only`).

### About (`src/views/About.vue`)

- New lede (with the coffee link).
- Keeps **Who built Scrobblify?** and **Contribute**. Drops **Support
  Scrobblify**.
- Old FAQ replaced by collapsible questions (`v-expansion-panels`): dates,
  why it takes long, duplicates, where data goes. Blank strings in the strings
  file are dropped, not rendered.
- `listenbrainz_clicked` gains `source: about`. The `home` source disappears
  from this release on; `gate_button` / `gate_text` are unchanged.

## 3. Steps

The stepper becomes **Upload · Choose · Send · Done**. The authenticate step no
longer leads the flow; it becomes a sign-in that runs at the point a Last.fm
connection is first needed (section 4).

The large-history gate (`LargeHistoryGate`) is unchanged, so the ListenBrainz
off-ramp for big re-dated imports stays exactly where it is.

Restyling the upload, choose, send and done steps, and cutting their text, is a
**later design**. This spec only moves sign-in and replaces the background
surfaces.

## 4. Sign-in, after choosing

### 4.1 Why two sign-ins can't be merged

The browser and the worker are separate Last.fm API applications by design
(background spec, "Two API applications, split by trust"). One approval yields
a session for one application. So instead of merging sign-ins, each path asks
for **only the one it needs**.

| Path | Sign-in |
| --- | --- |
| Server (beta, big import, server chosen) | Worker application only |
| Tab (small import, not beta, or "scrobble locally") | Browser application only; skipped if already signed in |
| "Already scrobbling on scrobblify?" | Worker first; see 4.4 |
| Scrobble the rest locally (move back) | Browser application, only if this browser has none; see 6.3 |

### 4.2 Surviving the redirect

The Last.fm redirect reloads the page. Before redirecting, the selected queue
is saved to IndexedDB (the same `ScrobbleState` the save/resume path uses, with
the chosen path recorded), and restored on return. The handover already
persists a queue before its redirect; the tab path gains the same.

### 4.3 Duplicate check moves after sign-in

`filterDuplicates` needs the Last.fm username, so it runs after sign-in and
before sending. If plays were skipped, a short screen says how many
(`signin.dupes.*`); otherwise it goes straight on.

On the server path the browser has no Last.fm key of its own, so the check reads
**unsigned**. A user who hides their recent listening (error 17) gets no
duplicate check on that path; the read fails soft, as today, and the import
proceeds with everything.

### 4.4 "Already scrobbling on scrobblify?"

1. Sign in to the **worker** application.
2. Live or parked server job for this user → status page.
3. Otherwise → "Nothing to resume", **Upload Spotify zip**, and a link to
   import a progress file.

The link only shows on the first-visit page, so this browser never has saved
progress here (a browser with saved progress gets the returning-visitor card).
A local-progress branch would be unreachable and is deliberately absent.

All the existing resume guards stay: `restoreFromState` still refuses without a
browser session key, and `scrobblePlay` still throws `NotAuthenticatedError`.

## 5. The server choice

### When it shows

Beta browser **and** the server has room **and** at least 750 plays remain
**and** the remaining count is within the server's limit
(`backgroundCanFinish`). Otherwise the existing "Scrobble N tracks?" dialog
shows unchanged and the tab path runs.

### Where

In the existing confirmation dialog (`ScrobbleConfirmDialog`), whose content
becomes the server choice. `BackgroundOffer.vue` is rewritten to this simple
form and also serves the two other entry points:

| Entry point | Trigger | `entry_point` |
| --- | --- | --- |
| Confirm | "Scrobble N selected tracks" | `confirm` (new) |
| Mid-run | "Scrobble the rest for me →" on the scrobble step's stopped panel | `scrobble_step` |
| Resume | Resuming saved progress | `resume` |

The saved-progress prompt ("Resume saved progress / Start over", #102) still
comes first; the server choice follows it.

### The beta flag before sign-in

The choice now comes before sign-in, but `isFeatureEnabled`
(`src/services/Analytics.ts`) only honours the rollout flag once PostHog has
identified the user by Last.fm username (#147). Without a change, a flag-only
beta user would never see the server choice on a first import.

So the flag is also honoured for an **anonymous** browser (PostHog's per-browser
distinct id). Once the user signs in and is identified, the username decides, as
today. A browser that has signed in before is already identified on load
(PostHog keeps the identity), so this only changes behaviour for browsers that
have never signed in.

Consequences, accepted:

- A brand-new user is bucketed per browser for their first offer; after sign-in
  the username's bucket applies. The two can disagree, which affects only
  whether the *offer* shows. A job already handed over is unaffected: recovery
  paths use `isBackgroundConfigured()`, not the flag.
- `background_offer_shown` `offer_source` gains `flag_anonymous`, so offers made
  before identification can be told apart from `flag` and `opt_in`.

`?beta=1` / `?beta=0` and the local `scrobblify.flags` override are unchanged.
`AGENTS.md`'s beta-gate section is updated to match.

### Content

Title and lede (`choice.*`), **Let Scrobblify scrobble for me**, "You'll need
to sign in" with **Details** expanding the data and beta notes, and "or scrobble
locally". The date warning in the lede shows only when the "Scrobble tracks
older than 2 weeks" box was ticked.

### More than 60 days

If the remaining plays need more than 60 days at 700 a day, `choice.over60`
warns that the user must come back after 60 days and sign in again. Server
limits (section 7.1) decide whether the choice is offered at all.

### Telemetry

Existing `background_offer_shown` / `background_offer_declined` /
`background_handoff_*` events stay. "Scrobble locally" counts as declined.

## 6. Status page

### 6.1 Layout

New component `BackgroundStatus.vue`. While this user has a server job,
`/scrobble` renders it **instead of** the stepper. It replaces the job banner,
the job card and the job-related notices.

- A labelled progress bar: `{done} / {total} · {pct}%`.
- **Pause** to the right of the bar (**Resume** when paused).
- One status line.
- **Scrobble the rest locally** and **Cancel** as buttons below. Cancel opens a
  confirmation (`status.cancel.confirm.*`) that warns the remaining tracks will
  be deleted from the server.

### 6.2 States

| Job state | Line | Main action |
| --- | --- | --- |
| `active` | This will finish around {date} | Pause |
| `active`, today's share sent | Can't upload any more due to last.fm rules. Will continue at {time} | Pause |
| `paused` | Paused | Resume |
| `needs_reauth` | Last.fm signed us out | Sign in again |
| `needs_attention` | Scrobblify stopped after repeated errors (server reason in a tooltip) | Try again |
| `dormant`, cause `paused` or unknown | `status.dormant` | Reconnect |
| `dormant`, cause `needs_reauth` | `status.dormant.signedOut` | Reconnect |
| `dormant`, cause `needs_attention` | `status.dormant.errors` | Reconnect |
| `dormant`, server full | `status.dormant.full` | Reconnect (disabled) |
| `exporting` | Downloading progress from scrobblify servers... | none |
| `completed` | Done (· {n} rejected by Last.fm, when any) | Check it out! (profile), plus "Start a new import" |
| `failed` | Scrobbling stopped (reason in a tooltip) | "Start a new import" |

"Today's share sent" is detected from the existing `DAY_FULL_REASON` on an
active job. "Start a new import" (`status.newImport`) dismisses the finished
job for this browser and returns to the upload step; without it, a finished job
would keep the stepper hidden.

### 6.3 Signing in on the status page

Pause, resume, move back and cancel need the worker's bearer session
(14 days). Without one:

- If this browser handed the import over (it knows the import id), the bar comes
  from the public `/scrobblify/import/:id` lookup, with "Scrobblify is
  scrobbling for you, expecting to finish around {date}" and **Sign in**.
- Otherwise there are no numbers: `status.noSession.otherDevice` and **Sign
  in**. (`/job/live` only answers yes or no.)

**Scrobble the rest locally** when this browser has no browser-application
session first shows the explainer (`moveBack.explain.*`) about the two Last.fm
connections, then signs in, then runs the existing take-back. The pending
take-back is recorded (job id, in sessionStorage) before the redirect and
resumed on return, so the user doesn't have to press the button twice. With a
session it runs straight away. Emits `move_back_explainer_shown` and
`move_back_explainer_choice` (`continue` / `cancel`).

### 6.4 Refreshing

Unchanged: the card re-fetches around `nextRunAt` while active and visible, and
keeps the last card on a failed check.

New: a `dormant` job with `reconnectAvailable: false` is re-checked every 5
minutes while visible, and when the tab becomes visible, so **Reconnect**
enables itself when a place frees up. Previously nothing re-checked it.

### 6.5 Server unreachable

Stays a separate warning above the page, now one line (`outage.*`), with **Try
again** and **Continue locally anyway**. The second button keeps its existing
rules: page-load only, never over a local ownership record,
`background_authority_overridden`.

### 6.6 Notices

The `backgroundNotice` messages keep their triggers and their single-alert
behaviour (`banner` precedence), with the shortened `notice.*` copy.

## 7. Server changes (`worker/`)

### 7.1 Larger jobs

`MAX_TRACKS_PER_JOB` (today `TRACKS_PER_DAY * 60` = 42,000) is raised to the
largest import that fits `MAX_JOB_COMPRESSED_BYTES` (8 MB), measured with a
worst-case queue (every play distinct, long names) rather than estimated. The
measurement for 42,000 was about 5 MB, so this should land near 65,000. The
50-slot × 8 MB bound against D1's 500 MB is unchanged.

The 60-day credential life is unchanged; jobs past it go to `needs_reauth` as
today, and the client shows `choice.over60` up front.

### 7.2 Reconnect resumes the job

`reattachCredential` (`worker/src/api.ts`) restores a job to `paused`. It
restores it to `active` instead, so signing in again is the only step. A job the
user had explicitly paused before going dormant is the exception: it returns to
`paused` (its `dormant_from`, below, is `paused`).

### 7.3 Recording why a job went on hold

`markDormant` (`worker/src/housekeeping.ts`) overwrites both `state` and
`state_reason`, so the cause is lost. A new nullable column `dormant_from`
(migration in `worker/schema/`) is set to the state the job left (`paused`,
`needs_reauth`, `needs_attention`) in the same update, and returned by the job
status API as `dormantFrom`. Rows made dormant before the migration have it
null and use the default copy.

## 8. Telemetry and docs

New events: `home_choice`, `home_returning_shown`, `move_back_explainer_shown`,
`move_back_explainer_choice`. New values: `background_offer_shown`
`entry_point: confirm`; `listenbrainz_clicked` `source: about`.

`AGENTS.md` is updated with these, the new step order (sign-in after choose,
so `auth_success` now follows `tracks_selected`), and the removal of the
`home` ListenBrainz source.

## 9. Testing

Playwright (`tests/scrobblify.spec.ts`), using `tests/lastfmMock.js` and
`tests/backgroundMock.js`:

- **Home:** first visit shows both cards; "Don't have it yet?" swaps and Back
  restores; each returning state renders its card and action.
- **About:** questions expand; ListenBrainz link emits `source: about`.
- **Sign-in after choose:** upload and choose work signed out; the tab path
  signs in to the browser app and resumes the selection after the redirect;
  the duplicate check runs after sign-in and shows the skipped count.
- **Server choice:** shown for beta + room + ≥750; not shown for small, non-beta
  or full; shown before sign-in for a flagged browser that has never signed in
  (via the local flag override); the over-60 warning appears above 60 days;
  "scrobble locally" runs the tab path; the saved-progress prompt still comes
  first.
- **Status page:** every row of 6.2 renders its line and action against the mock
  worker, including each `dormantFrom`; no-session with and without a known
  import id; dormant + full re-checks and enables Reconnect.
- **Move back:** explainer appears only without a browser session.
- **Unreachable worker** config still passes, including "Continue locally
  anyway".

Worker tests (`worker/test/`): `dormant_from` set by `markDormant` for each
parked state; reconnect restores `active` except from `paused`; the raised
limit accepts its maximum and rejects one more.

## 10. Delivery

Separate PRs, in order:

1. BETA tag, About FAQ.
2. Home (first visit, get-your-history, returning card).
3. Sign-in after choosing (section 4), and the anonymous beta-flag check. The
   riskiest change: it touches the resume guards.
4. Server choice dialog, over-60 warning, raised job limit.
5. Status page, move-back explainer, `dormant_from`, reconnect-resumes,
   dormant re-check.

Background surfaces show only to beta browsers, as today.

## Out of scope

- Restyling the upload, choose, send and done steps (later design).
- A waiting list for on-hold jobs when the server is full.
- #148 (take-back blocks its own tab), fixed separately.
