# Background Scrobbling (Beta) — Design

**Date:** 2026-07-26
**Status:** Approved, pending implementation plan

## Problem

Last.fm enforces an undocumented daily scrobble limit of roughly 2,800 per user.
Scrobblify paces itself at 2,700/day (`ScrobbleStep.vue:89`) and pauses when it
hits that ceiling. A user importing a 100,000-track Spotify history must
therefore return to the site once a day for about 37 consecutive days.

Save-and-resume (`src/services/StateManager.ts`) makes returning painless, but it
does not make it unnecessary. Most users with large histories never finish.

This design adds an opt-in beta backend that continues a user's import while
their browser is closed.

## Measured baseline (PostHog, 2026-07-09 to 2026-07-26)

All figures filtered to `properties.app = 'scrobblify'`.

| Metric | Value |
| --- | --- |
| People who started scrobbling | 63 |
| People who hit a Last.fm rate limit | 33 |
| Of those, people who completed | 7 |
| Median tracks selected (rate-limited users) | 34,769 |
| Median tracks actually scrobbled | 745 |
| **Median share of import completed** | **2.1%** |

**The preventive pause is not working.** Reactive rate limits outnumber
preventive pauses roughly 9:1 — 2,135 `scrobble_rate_limited` events against 190
`burst_limit` and 40 `daily_limit` pauses.

`BURST_LIMIT` is set too high. The highest `burst_count` ever observed at the
moment of a rate limit is **849**, below the 950 threshold. The median is 187.

**Half of all first rate limits occur at `burst_count = 0`** — before a single
successful scrobble in the session. Last.fm's limit is a rolling window on the
account, while `burstCount` and `dailyCount` are in-memory and reset on every
page load. Users who return after being throttled are immediately throttled
again.

**The 1-minute cooldown almost never clears the limit.** Of 2,135 rate limits,
only 33 produced a `scrobble_rate_limit_recovered`. Where recovery did occur, the
median elapsed time was **130 minutes**. Median actual pause duration is exactly
the configured 60 seconds, so this is not timer throttling — the cooldown is
simply two orders of magnitude too short, and recovery happens by accident when a
user walks away.

Two consequences for this design:

1. The worker must not reuse the client's cooldown or threshold values. It needs
   backoff on the order of hours, and limit counters persisted per user rather
   than per session.
2. **Fixing the client's cooldown and thresholds is a cheaper, higher-value
   change than this feature, and should ship first.** It benefits all users
   immediately and de-risks the backend by establishing real limit values.

## Non-goals

- **Making imports faster.** The 2,700/day per-user limit is imposed by Last.fm
  and applies equally to a backend. A 100k import still takes ~37 days. The
  feature buys *unattendedness*, not speed.
- **User accounts.** The Last.fm username is the only identity.
- **Replacing the client-side flow.** It remains the default for most users.

## Scope

Background mode is offered **only when the number of tracks *remaining* exceeds
`DAILY_LIMIT` (2,700)** — that is, only to users who would otherwise have to
return at least once. Smaller imports finish in one sitting and stay entirely
client-side.

"Remaining" rather than "selected" is deliberate: users already part-way through
an import must be able to hand off what is left. See Backwards compatibility for
the four entry points where the offer appears.

It is an **opt-in beta**. Users must actively choose it, and the UI must label it
as beta.

## Architecture

Three components.

**1. The SPA** (unchanged deployment: FTP to Namecheap via `.github/workflows/cd.yml`)

Parses the Spotify ZIP, deduplicates, and lets the user select tracks — all in
the browser, exactly as today. The Spotify ZIP never leaves the browser under
any circumstance.

**2. API worker** (Cloudflare Worker, HTTP, at `api.savas.ca`)

Handles the Last.fm auth callback, job creation, track-list upload, and status
queries.

**3. Scheduler worker** (Cloudflare Worker, Cron Trigger, every minute)

Selects due jobs, scrobbles a batch for each, commits progress.

**Storage:** D1 for job rows, cursors, and encrypted session keys. R2 for
track-list blobs.

### Why Cloudflare, and when to leave

Cloudflare Workers' free tier costs nothing at idle and requires no ops, which
suits an unproven feature. Its constraints define a hard capacity ceiling:

| Constraint | Value | Consequence |
| --- | --- | --- |
| Cron ticks/day | 1,440 (1/min) | — |
| Subrequests per invocation (free) | 50 | ~45 scrobbles/tick after D1/R2 overhead |
| **Global throughput** | **~65,000 scrobbles/day** | **~24 concurrent users** |

Two things follow. First, ~24 concurrent jobs is the migration trigger: when
capacity is consistently saturated, move the worker to an Oracle Cloud Always
Free ARM VM (4 cores, 24GB RAM, 200GB disk, dedicated IP).

Second, 65,000/day averages **0.75 requests/sec**, so the free tier makes it
impossible to breach Last.fm's documented limit of *5 requests/sec per
originating IP, averaged over 5 minutes*. Compliance holds by construction, which
defuses the main concern with Cloudflare's shared egress IPs.

### Portability requirements

The worker must be movable to a plain VM without a rewrite:

- Plain `fetch` and WebCrypto only in the scrobbling core. Both exist in Workers
  and Node 18+. No `node:` imports, no Workers-only APIs.
- Portable SQL only, so D1's SQLite can be swapped for Postgres.
- R2 access behind a minimal get/put-by-key interface, so it can become S3 or
  the filesystem.
- **No Durable Objects for scheduling.** This is the principal lock-in trap.
  Scheduling stays "SELECT due jobs → process batch → commit", which runs
  identically under Workers Cron, a systemd timer, or pg_cron.

## Authentication

### The constraint

Last.fm issues exactly one credential: the session key returned by
`auth.getSession`. It never expires, it is unscoped write access, and it can only
be revoked by the user at last.fm/settings/applications. There is no scoped or
delegated variant.

The server must therefore hold a permanent write credential. The design cannot
avoid this; it can only minimise how long the credential is held and how much
damage its disclosure would cause.

### Handoff via a second Last.fm round-trip

The wizard authenticates at step 1, before the track count is known
(`Scrobblify.vue:28-36`). By the time we can offer background mode (step 3→4),
the browser already holds a session key.

When the user opts in, the SPA redirects to Last.fm auth again with `cb=`
pointing at **the API worker** rather than the SPA. The worker exchanges the
fresh token for its own independent session key.

**The client's session key is never transmitted anywhere.** Because the user has
already authorised the application, Last.fm does not re-prompt; the user sees a
redirect, not a second login. After successful handoff the SPA clears its own
session key from `localStorage` — the background job now owns the import.

The worker then encrypts the session key, creates the job row, sets an httpOnly
cookie, and redirects back to the SPA, which uploads the selected track list as
gzipped NDJSON to R2.

### The shared secret stays public

`store.ts:12` hardcodes both the Last.fm API key and shared secret in the client
bundle. Routing *all* authentication through the worker would make the secret
genuinely secret, but it would put Cloudflare on the critical path for the
majority of users who never use background mode.

This design keeps client-side auth as the default, so **the shared secret remains
public**. This is the existing accepted risk and is not made worse. The API key is
public regardless.

### Sessions and identity

- **httpOnly cookie**, scoped `Domain=savas.ca; SameSite=Lax; Secure`. Because
  `savas.ca` and `api.savas.ca` share a registrable domain, this is a
  first-party cookie and survives Safari's ITP and Firefox's Total Cookie
  Protection. This is why the API must not live on `*.workers.dev`.
  (`savas.ca` is already served by Cloudflare nameservers, so a Workers custom
  domain is the only setup required.)
- **Fallback:** re-authenticate through Last.fm. The username resolves to the
  job. Works on any device, from any browser, after any cookie loss.

  This exchange necessarily yields *another* session key. It is used only to
  prove identity and **must be discarded immediately, never stored**. The job
  continues to use the credential captured at handoff. Storing a second
  credential per user would widen the blast radius for no benefit.

No email address, no password, no PII beyond the Last.fm username.

### Credential lifecycle

Non-negotiable, because a free-tier account that is suspended or reclaimed would
otherwise strand other people's permanent write credentials on infrastructure we
do not control:

- Encrypt the session key at rest with a key held as a Worker secret, never in
  D1 alongside the ciphertext.
- **Delete it the instant** the job completes, fails permanently, is cancelled,
  or reaches its TTL of 60 days.
- Delete the R2 blob at the same time. Retain only summary statistics.
- **Expose no generic Last.fm proxy.** The worker may only scrobble tracks
  already committed to that job's immutable blob. A stolen cookie therefore
  grants nothing beyond reading progress.

## Progress and status

`Scrobblify.vue` already checks `hasSavedState()` on mount and renders a "Resume
previous session?" alert. Background jobs reuse that pattern: a parallel
`GET /api/job` renders a banner for a live job, opening a status view in place of
step 4's local scrobbler.

The status view shows completed/total, current state (running, waiting on the
daily limit, rate-limited, needs re-auth, failed), failed-track count, and an
**estimated completion date**. The estimate is essential: without "expect to
finish around 1 September", a user watching a 37-day job will conclude it is
broken and re-import.

Controls: pause, cancel-and-delete-my-data, export progress (see Escape hatches),
and a link to last.fm/settings/applications.

Polling is a fetch on load plus a 60-second poll while the tab is visible. The
100,000/day invocation budget is shared with the scheduler, and a job advancing
at 2,700/day does not warrant more.

Completed job rows are retained (without the session key) for 30 days so a
returning user sees "done — 94,203 scrobbled, 112 failed" with a downloadable
failure list, rather than "no job found".

## Scheduler

**Fairness is round-robin, not FIFO.** Due jobs are selected ordered by
`last_run_at` ascending and each gets a slice of the tick's budget. FIFO would
let a single 100k import starve every job behind it for a month.

**Per-user limits reuse the existing constants.** `BURST_LIMIT` (950, 10-minute
cooldown) and `DAILY_LIMIT` (2,700) currently live in `ScrobbleStep.vue:88-89`,
and `LastFm.isRateLimitError` / `isNetworkError` in `src/api/LastFm.ts`. These
move into a `shared/` module imported by both the SPA and the worker. Divergence
between client and server pacing would be a slow-to-surface bug.

### Error handling

| Condition | Response |
| --- | --- |
| Error 29 (rate limit) | Exponential backoff for the job **and** trip a global circuit breaker — on shared egress, a 29 may mean the whole IP is throttled. Log every occurrence with timestamp and active-job count. |
| **Error 9 (invalid session key)** | The user revoked access. Delete the credential immediately, mark the job `needs_reauth`, stop. **Never retry.** |
| Network error | Backoff and retry; the track was not consumed. |
| Per-track failure | Record and continue, matching current client behaviour. |
| 10 consecutive failures | Pause the job, mark `needs_attention`, surface on the status page. |

Error 9 is new. The client never encounters it because its session key is created
seconds before use; a job running for weeks certainly will.

The error-29 log is also the dataset that answers whether Last.fm's binding limit
is per-API-key or per-IP — currently unknown, and the deciding factor in whether
migrating to a dedicated IP would help at all.

## Correctness under change

Jobs run for weeks, so bugs **will** be fixed while jobs are in flight. The
design must make that safe.

### Timestamps are assigned by the worker, not the client

Two facts make client-assigned timestamps unusable for a long-running job.

**Re-tagged listens all share one timestamp.** `UploadStep.vue:173` creates a
single `reTagDate`, and `scrobblify.ts:263-270` assigns that same `Date` instance
to every listen. Users with more than two weeks of history — the overwhelming
majority, and the only users offered background mode — therefore submit tens of
thousands of scrobbles carrying an identical millisecond timestamp.

**A 37-day job outlives Last.fm's 14-day window.** Any timestamp fixed at job
creation is rejected from roughly day 15 onward.

Therefore the job blob stores artist, track, and album, plus the original listen
date only as metadata. **The worker assigns the actual scrobble timestamp at send
time**, spreading a batch across the preceding minute so every track in it is
unique. Tracks whose original timestamp still falls inside the 14-day window at
send time keep it; everything else is stamped to the present.

A visible consequence worth stating in the beta copy: a background import spreads
re-tagged listens across the whole run rather than landing them all on one day.
This is more plausible than the current behaviour, not less.

### Duplicate scrobbles: persist the timestamp, then reconcile on it

**The ambiguity window is irreducible.** Even committing the cursor after every
single track, the worker can crash between Last.fm accepting a scrobble and D1
recording it. No cursor granularity eliminates this.

Reconciling against the *user's* timestamps cannot resolve it, for the reasons
above. Reconciling against *ours* can:

1. Before sending a batch, durably write its index→assigned-timestamp mapping to
   D1.
2. Send the batch.
3. Commit the cursor.

Because the worker chose those timestamps and they are unique by construction,
the mapping is a stable idempotency key that survives a crash. On recovery, the
next tick fetches the narrow window covering the uncommitted mapping via
`getAllScrobblesInRange` and checks for those exact `(artist, track, timestamp)`
tuples. Present means done; absent means safe to send. Last.fm's own
deduplication is not relied upon.

An **unclean tick** is precisely: a job whose `locked_until` lease expired without
the tick having committed a final cursor. The next tick to pick up that job
reconciles before scrobbling anything.

Because the reconciliation window is one batch wide — under a minute — this costs
a single API call, not a paginated crawl of the user's history.

### Safe-deploy mechanics

- **Immutable job payload.** The R2 blob is written once at job creation and
  never mutated. No code change can alter what an existing job will scrobble.
- **Lease-based locking.** Each job carries a `locked_until` timestamp. Two ticks
  can never process one job concurrently, and a tick killed mid-batch by a deploy
  simply has its lease expire; the next tick resumes from the last committed
  cursor and reconciles.
- **Additive-only migrations.** Never drop or rename a column a running job
  depends on. Job rows carry a `schema_version` so the worker can handle rows
  created by older code.
- **Global kill switch.** A `paused` flag in D1, checked first on every tick. If
  a bug is spotted, flip it, jobs freeze safely mid-flight, fix, unflip.
- **Batch audit log.** Every batch records job ID, cursor range, timestamp, and
  outcome, so any incident can be diagnosed and its blast radius established.

### Escape hatches

Because this is a beta that may be withdrawn:

- The status page can **export progress in the existing `StateManager` JSON
  format**. A user whose job is cancelled — or whose beta access ends — imports
  that file and resumes client-side through the existing flow. The format and
  both code paths already exist (`StateManager.exportToFile` /
  `importFromFile`), so this costs almost nothing and guarantees progress is
  never stranded server-side.
- **Concurrency cap.** Background mode admits a bounded number of concurrent jobs
  — initially **20**, deliberately below the ~24 capacity ceiling so that status
  polling and retries retain headroom. When full, the UI offers the normal
  client-side flow and reports that background mode is at capacity.

## Backwards compatibility

The feature must not strand anyone already part-way through an import, and must
not break the existing client-side flow in either direction.

### Entry points

Background mode is offered wherever the *remaining* track count exceeds 2,700 —
not only on fresh imports:

1. **New import**, at step 3→4 after selection.
2. **Resume from saved IndexedDB state**, via `restoreFromState`
   (`Scrobblify.vue:154-173`), which already computes the remaining set.
3. **Import of a progress JSON file**, which flows through the same
   `restoreFromState` path.
4. **Mid-scrobble, on the step 4 pause screen** — particularly when paused for
   `daily_limit` or `rate_limit`.

Entry point 4 matters most. Telemetry shows users abandon precisely at those
pauses, so that screen is where "let us finish this for you" belongs. The offer
must be available while paused, not only at the start of a run.

### Handing off partial progress

The job payload is the **remaining** tracks, exactly as `restoreFromState`
already derives them. Already-scrobbled tracks are never re-sent, so the
timestamps the client previously used are irrelevant to the job.

Two rules make the transition safe:

- **The handoff is atomic from the client's perspective.** Local state is cleared
  only after the server has confirmed both job creation and blob storage. A
  failure at any earlier point leaves local state untouched and the user
  continues client-side, none the wiser.
- **The client must halt its scrobble loop on successful handoff.** If both the
  browser tab and the worker hold the same remaining track list, both will
  scrobble it. This is the single most likely source of duplicates in the whole
  design, and it is entirely self-inflicted.

### Tolerating old and new state files

`StateManager.importFromFile` requires only `totalTracks`, `completedIndices`,
`failedIndices`, and `tracks`, defaulting everything else. Handoff must depend on
nothing beyond that set — in particular it must not require `userName`, which
older files lack. The Last.fm username comes from the auth handoff itself.

Any field this feature adds to `ScrobbleState` **must be optional**, so that old
files still import into new clients and new files still import into older cached
clients.

### Falling back to the client

The export escape hatch must emit exactly the `ScrobbleState` shape
`importFromFile` accepts, so a user can always return to the client-side flow.
Ordering matters on cancellation: **generate and deliver the export before
deleting the R2 blob**, or the data needed to build it is already gone.

### Conflict rules

- A live background job and local saved state must never both be active for one
  user. On detecting both, the UI presents the background job as authoritative
  and offers to discard the local state.
- The client-side scrobble loop must refuse to start while a live background job
  exists for the authenticated user.

## Beta framing

- Opt-in only, offered at any of the four entry points above when the remaining
  selection exceeds 2,700 tracks.
- Labelled clearly as beta in the UI.
- The opt-in must state plainly: the selected track list is uploaded to
  Scrobblify's server; a Last.fm credential is stored until the import finishes;
  access can be revoked at any time at last.fm/settings/applications.

### Reporting bugs

Because this is a beta running unattended for weeks, users need a direct channel
when something looks wrong — there is no support system, and a silently stalled
job is indistinguishable from a slow one.

Both the opt-in dialog and the status view carry a feedback link to
**niko@savas.ca**, following the prefilled-mailto pattern already established in
`ErrorDialog.vue:52-68`: a fixed subject and a body pre-populated with context.

The body should include the **job ID**, so a report is traceable to a specific
job without asking the user to describe their state. The job ID is an opaque
identifier and not personal data; analytics already identifies users by
`lastfm_username` regardless.

The link must remain reachable on a *failed* or *stalled* job, not only a healthy
one. That is the case where it will actually be used.

## Analytics

Follow the conventions in `AGENTS.md` — use the helpers in
`src/services/Analytics.ts`, never `posthog` directly, and never widen an error
message to include raw request parameters.

New events: `background_offered`, `background_opted_in`, `background_declined`,
`background_handoff_failed`, `background_job_created`,
`background_job_completed`, `background_job_cancelled`, `background_reauth_needed`,
`background_capacity_full`.

`background_offered` and `background_opted_in` carry an `entry_point` property
(`new_import`, `resume_saved`, `resume_file`, `paused`) so the four entry points
can be compared. If the paused-screen offer is where users actually convert, that
is worth knowing early.

New error contexts: `background.handoff`, `background.upload`,
`background.status`, `worker.scrobbleBatch`, `worker.reconcile`.

## Open questions for implementation

- Whether D1 and R2 binding calls count against the 50-subrequest limit. This
  determines the achievable batch size and therefore the exact capacity ceiling.
  It does not affect correctness, because reconciliation is required regardless.
- Wall-clock limits for scheduled Workers on the free tier, which bound how long
  a single tick may pace its batch.
- **Whether Last.fm silently deduplicates identical `(artist, track, timestamp)`
  submissions.** Because `reTagOldListens` currently assigns one identical
  timestamp to every listen, a user who played the same track fifty times may be
  credited with a single scrobble today. If confirmed, this is a pre-existing
  data-loss bug in the client, independent of this feature, and the fix — unique
  timestamps — is the same mechanism this design already requires.
