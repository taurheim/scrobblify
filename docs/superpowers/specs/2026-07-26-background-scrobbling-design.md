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

`BURST_LIMIT` never fires in practice. The highest `burst_count` ever observed at
the moment of a rate limit is **849**, below the 950 threshold. The median is 187.

**Half of all first rate limits occur at `burst_count = 0`** — before a single
successful scrobble in the session. Two causes compound here. `burstCount` and
`dailyCount` are in-memory and reset on every page load, so users who return
after being throttled are immediately throttled again. More fundamentally, the
counters measure the wrong quantity: error 29 is an **IP-level** limit (see
Scheduler), which no per-session, per-user counter can predict.

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
2,700** — that is, only to users who would otherwise have to return at least
once. Smaller imports finish in one sitting and stay entirely client-side.

2,700 here is an *eligibility* threshold chosen because it matches the client's
current `DAILY_LIMIT`, so the offer appears exactly when the client would have
forced a second visit. It is deliberately **not** reused as a server-side pacing
constant; see Scheduler for why those constants do not describe reality.

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
suits an unproven feature.

**Scrobbles are sent in batches of 50.** `track.scrobble` accepts up to 50
scrobbles per request via array notation (`artist[i]`, `track[i]`,
`timestamp[i]`). The client sends them one at a time; the worker must not. This
changes the capacity picture by up to fiftyfold, and Cloudflare stops being the
binding constraint.

Signing gotcha: Last.fm requires signature parameters sorted by ASCII, so
`artist[10]` precedes `artist[1]`. JavaScript's default `Array.sort()` already
produces this order, so `LastFm.getMethodSignature` is correct as written — but
it is easy to "fix" into being wrong.

| Constraint | Value |
| --- | --- |
| Cron ticks/day | 1,440 (1/min) |
| Subrequests per invocation (free) | 50, **including D1 and R2 binding calls** |
| Free-tier CPU per invocation | 10ms (wall time awaiting `fetch` does not count) |
| Scrobbles per Last.fm request | 50 |

With batching, the binding constraints become Last.fm's own limits and the D1
write budget rather than subrequest count. The real ceiling must therefore be
derived from a proper model — requests, scrobbles, D1 writes, R2 reads, CPU, and
retries costed separately, at five-minute peaks rather than daily averages —
before a concurrency cap is chosen. **The previously stated "~24 concurrent
users" was computed without batching and is withdrawn.**

Two constraints that do *not* relax:

- **Last.fm's 5 requests/sec per originating IP**, averaged over 5 minutes.
  Batching makes this far easier to satisfy per scrobble, but it must be enforced
  as a global token bucket, not assumed from a daily average. A daily mean says
  nothing about a five-minute peak, and Cloudflare's egress IPs are shared with
  other tenants whose traffic we cannot see.
- **The per-user daily scrobble limit**, which is unchanged by batching.

**Migration trigger:** move to an Oracle Cloud Always Free ARM VM (4 cores, 24GB
RAM, 200GB disk, dedicated IP) when either the D1 write budget or the shared
egress IP becomes the limiting factor.

### Blob storage must be chunked

A single gzipped NDJSON blob cannot be randomly accessed at a cursor. Fetching
and decompressing the whole thing every tick, for every job, will exhaust both
CPU and memory. Store **independently compressed chunks plus a manifest**, sized
so a tick reads exactly the chunk its cursor points into.

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
redirect, not a second login.

#### The handoff is a transaction, and must be written as one

A full-page redirect destroys all in-memory state. The user's selection lives
only in Vuex (`SelectStep.vue:504-511`) and is **not** persisted, so a naive
"redirect, come back, upload" flow loses the very data the job needs. Worse, the
ordering below is easy to get wrong in ways that either strand a credential or
lose an import.

Required protocol:

1. **Persist before leaving.** The SPA writes the selected track list to
   `localStorage`/IndexedDB *before* redirecting, together with a
   `pending_handoff` record holding a nonce, the expected Last.fm username, and a
   SHA-256 digest of the serialised list.
2. **Bind the nonce.** The `cb=` URL carries a worker-signed, single-use,
   short-TTL nonce. The worker rejects any callback whose nonce is unknown,
   expired, or already consumed.
3. **Verify the account.** `auth.getSession` returns a username. If it does not
   match the username bound to the nonce, **abort and discard the session key.**
   Without this check a user logged into a second Last.fm account in another tab
   — or an attacker who lands their own callback — has one account's history
   written into another's. This is the single most damaging failure mode in the
   design.
4. **Upload, then finalise.** The job is created in `pending_upload`. The SPA
   uploads the blob; the worker verifies the digest matches the one committed in
   step 1, then transitions the job to `active`.
5. **Clear last.** The SPA clears its own session key and cached list only after
   the worker confirms `active`. Clearing first turns any upload failure into
   total data loss.
6. **Reap abandoned handoffs.** Jobs stuck in `pending_upload`, and unconsumed
   nonces, expire on a timer, deleting any captured credential. A user who closes
   the tab mid-flow must not leave a permanent write credential behind.

### The shared secret stays public

`store.ts:12` hardcodes both the Last.fm API key and shared secret in the client
bundle. Routing *all* authentication through the worker would make the secret
genuinely secret, but it would put Cloudflare on the critical path for the
majority of users who never use background mode.

This design keeps client-side auth as the default, so **the shared secret remains
public**. This is the existing accepted risk and is not made worse. The API key is
public regardless. (See error 26 under Scheduler for the case in favour of a
separate server-only API application.)

### Sessions and identity

**`savas.ca` is a shared origin.** LastWave is served from `savas.ca/lastwave` —
a path, not a subdomain. Any cookie scoped `Domain=savas.ca` is readable by
LastWave's JavaScript, and browser security has no way to distinguish the two
applications. The earlier claim of origin isolation was wrong.

Accordingly:

- **Use a `__Host-` cookie set on `api.savas.ca`.** `__Host-` forbids the
  `Domain` attribute, so the cookie is locked to that exact host and is invisible
  to anything served from `savas.ca`. Attributes: `Secure`, `Path=/`,
  `SameSite=Lax`, `HttpOnly`.
- Because the cookie is host-locked, the SPA cannot rely on ambient credentials
  for cross-site calls; status and control endpoints take an explicit
  **bearer token issued to the SPA**, with CORS restricted to the exact origin.
- **All state-changing endpoints require an anti-CSRF token**, since `SameSite=Lax`
  still permits top-level cross-site GET navigations.
- Longer term, moving Scrobblify to its own origin is the only way to get real
  isolation from LastWave. Flagged as an open question because it affects the
  existing site structure.

**Fallback:** re-authenticate through Last.fm. The username resolves to the job.
Works on any device, from any browser, after any cookie loss.

This exchange necessarily yields *another* session key. It is used only to prove
identity and **must be discarded immediately, never stored**. The job continues to
use the credential captured at handoff. Storing a second credential per user would
widen the blast radius for no benefit.

No email address, no password, no PII beyond the Last.fm username.

### Credential lifecycle

Non-negotiable, because a free-tier account that is suspended or reclaimed would
otherwise strand other people's permanent write credentials on infrastructure we
do not control:

- Encrypt the session key at rest with a key held as a Worker secret, never in
  D1 alongside the ciphertext.
- **Delete it the instant** the job completes, fails permanently, is cancelled,
  or reaches its TTL of 60 days.
- Delete the R2 blob at the same time. Retain summary statistics and the failed-
  track list the completion page promises — nothing else. (An earlier draft said
  "summary statistics only", which contradicted that promise.)
- **Expose no generic Last.fm proxy.** The worker may only scrobble tracks
  already committed to that job's immutable blob.

**Honest statement of stolen-cookie impact.** A stolen session does not merely
leak progress: it can cancel a job, and — depending on which controls exist — pause
or restart one. It cannot scrobble arbitrary tracks, which is the property the
"no generic proxy" rule buys. The `__Host-` cookie plus CSRF tokens above exist
specifically because the shared `savas.ca` origin makes theft plausible.

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

### Two different limits, previously conflated

Last.fm's documentation makes a distinction the client does not:

- **Error 29** is *"Rate limit exceeded — Your **IP** has made too many requests
  in a short period."* It is an IP-level throttle, not a per-user one.
- **The per-user daily scrobble cap** is not an error at all. It arrives as a
  *successful* HTTP response carrying `ignoredMessage` **code 5, "Daily scrobble
  limit exceeded"**.

The client treats error 29 as if it were a per-user scrobble limit, which is why
`BURST_LIMIT`/`DAILY_LIMIT` correlate so poorly with observed throttling and why
half of all first rate limits occur at `burst_count = 0`. An IP-level limit is
not something a per-session counter can predict.

Consequences for the worker:

- A global circuit breaker on error 29 is **correct**, because the limit really
  is shared across every job on that egress IP. Per-job backoff alone would not
  help.
- Per-user pacing must be driven by `ignoredMessage` code 5, not by error 29.
- **Do not port `BURST_LIMIT = 950` or `DAILY_LIMIT = 2,700` to the worker.**
  Measured data shows they do not describe reality. Share
  `LastFm.isRateLimitError`, `isNetworkError`, and the ignore-code taxonomy via a
  `shared/` module; derive pacing from observed responses instead of guessed
  constants.

### A 200 response does not mean the scrobble was stored

`track.scrobble` reports per-track rejections in `ignoredMessage` while returning
HTTP success. Parsing it is a **correctness invariant**, not an optimisation: the
cursor may only advance for entries Last.fm actually accepted.

The relevant codes are 1 (artist ignored), 2 (track ignored), 3 (timestamp too
old), 4 (timestamp too new), and 5 (daily limit). Code 3 and 4 indicate the
worker's own timestamp assignment is wrong and should be treated as a bug signal,
not a per-track failure. Code 5 means stop scrobbling for that user today.

Last.fm may also **correct** artist/album/track names, flagged by `corrected`.
Reconciliation must compare against corrected names or it will not find its own
writes.

### Error handling

| Condition | Response |
| --- | --- |
| Error 29 (IP rate limit) | Trip the **global** circuit breaker; back off all jobs. Log with timestamp and active-job count. |
| `ignoredMessage` code 5 | Per-user daily cap reached. Stop that job until tomorrow; do not treat as failure. |
| `ignoredMessage` code 3/4 | Worker timestamp assignment is wrong. Alert; do not silently drop. |
| `ignoredMessage` code 1/2 | Last.fm rejected the artist/track. Record as permanently failed; never retry. |
| **Error 9 (invalid session key)** | Credential revoked. Delete it, mark `needs_reauth`, stop. **Never retry.** |
| **Error 26 (suspended API key)** | Every job is dead until resolved. Halt globally and alert; retrying makes it worse. |
| Network error | Backoff and retry; nothing was consumed. |
| 10 consecutive failures | Pause the job, mark `needs_attention`, surface on the status page. |

Error 9 is not exclusive to long-running jobs — the client persists session keys
in `localStorage` indefinitely and can hit revocation too — but the worker must
handle it without a user present to re-authenticate.

Error 26 is a single point of failure worth stating plainly: the API key is
shared with the public client bundle, so anyone can abuse it and get it
suspended, killing every background job at once. A **separate, server-only
Last.fm API application** would isolate that risk, at the cost of an honest
second authorisation prompt.

## Correctness under change

Jobs run for weeks, so bugs **will** be fixed while jobs are in flight. The
design must make that safe.

### Timestamp reassignment rewrites history — say so plainly

This is a product decision, not an implementation detail, and it deserves an
honest statement rather than a reassuring one.

Two facts make client-assigned timestamps unusable for a long-running job.

**Re-tagged listens all share one timestamp.** `UploadStep.vue:173` creates a
single `reTagDate`, and `scrobblify.ts:263-270` assigns that same `Date` instance
to every listen. Users with more than two weeks of history — the overwhelming
majority, and the only users offered background mode — therefore submit tens of
thousands of scrobbles carrying an identical millisecond timestamp. (A fix for
this is in flight client-side; the worker must not depend on either version.)

**A 37-day job outlives Last.fm's 14-day window.** Any timestamp fixed at job
creation is rejected from roughly day 15 onward.

Therefore the job blob stores artist, track, and album, plus the original listen
date only as metadata. **The worker assigns the actual scrobble timestamp at send
time.** Tracks whose original timestamp still falls inside the 14-day window at
send time keep it; everything else is stamped near the present, spread so that
every timestamp in a batch is unique.

**What this costs the user.** Their Last.fm history will show these plays at the
time the import ran, not when they listened. Play counts and top-artist charts
are correct; the listening *timeline* is fiction. Anyone who values that timeline
should not use background mode — the foreground path has the same problem for
re-tagged listens, but over hours rather than weeks.

**Ordering is a genuine trade-off, and must be chosen explicitly:**

| Order | Effect |
| --- | --- |
| Oldest-first | Preserves relative chronology, but tracks near the start of the queue age out of the 14-day window and get restamped anyway. |
| Recent-first | Maximises the number of tracks keeping their true timestamp; reverses chronology for everything else. |

**Decision: recent-first**, because it preserves the most genuine data, and
because the alternative's chronology is itself an artefact of restamping. This
must be stated in the opt-in copy, not buried.

### Duplicate scrobbles: at-least-once, with a narrow reconciliation

**The ambiguity window is irreducible.** Even committing the cursor after every
single track, the worker can crash between Last.fm accepting a scrobble and D1
recording it. No cursor granularity eliminates this. **This design does not
achieve exactly-once**, and should not claim to.

The choice is between at-least-once (risk duplicates) and at-most-once (risk
silently dropped tracks). **Choose at-least-once**: a duplicate is visible and
removable by the user; a missing track is invisible and unrecoverable.

Reconciliation narrows the window but does not close it. Reconciling against the
*user's* timestamps cannot work at all, for the reasons above. Reconciling against
*ours* can:

1. Before sending a batch, durably write its index→assigned-timestamp mapping to
   D1.
2. Send the batch.
3. Commit the cursor.

Because the worker chose those timestamps and they are unique by construction,
the mapping is a stable idempotency key that survives a crash. On recovery, the
next tick fetches the narrow window covering the uncommitted mapping via
`getAllScrobblesInRange` and looks for those exact tuples.

Known limits of that check, which is why the guarantee is at-least-once:

- Last.fm **normalises and corrects** artist/track names, so comparison must be
  fuzzy or must use the `corrected` names returned by the scrobble call itself.
- `from`/`to` on `user.getRecentTracks` are strictly exclusive; the window must be
  widened by a second on each side.
- There is **no read-after-write guarantee**; a scrobble accepted moments ago may
  not yet appear.
- `user.getRecentTracks` caps `limit` at **200**. Note `LastFm.ts:168` currently
  sets `PAGE_SIZE = 1000`, which is invalid — a pre-existing bug to fix if this
  code is shared.

An **unclean tick** is precisely: a job whose lease expired without the tick
having committed a final cursor. The next tick to pick up that job reconciles
before scrobbling anything.

Because the reconciliation window is one batch wide — under a minute — this costs
a single API call, not a paginated crawl of the user's history.

### Safe-deploy mechanics

- **Immutable job payload.** The R2 blob is written once at job creation and
  never mutated. No code change can alter what an existing job will scrobble.
- **Fencing tokens, not just leases.** A `locked_until` timestamp alone does
  **not** prevent concurrent execution: a tick that stalls past its lease keeps
  running, and its in-flight writes can land after a second tick has claimed the
  job. Leases are a liveness hint, not mutual exclusion.

  Each job therefore carries a monotonically increasing `generation`. Acquiring a
  job is a single atomic compare-and-set that bumps it
  (`UPDATE ... SET generation = generation + 1, locked_until = ? WHERE id = ? AND
  locked_until < now`). Every subsequent write by that tick — timestamp mapping,
  cursor commit, audit row — carries its generation and is conditioned on it still
  being current. A superseded tick's writes are rejected rather than silently
  interleaved.

  This is also what makes a deploy safe mid-batch: the killed tick's lease
  expires, the next tick bumps the generation, and any zombie writes are fenced
  out.
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

**Blocking — these change the design:**

- **Should Scrobblify move to its own origin?** LastWave shares
  `https://savas.ca`, so cookie-level isolation between the two is impossible.
  `__Host-` cookies on `api.savas.ca` mitigate this; a dedicated origin fixes it.
  Affects existing site structure, so it is the user's call.
- **A separate, server-only Last.fm API application?** The public API key can be
  abused by anyone into an error-26 suspension that kills every background job.
  Isolating it costs an extra, honestly-explained authorisation prompt.
- **D1 write budget on the free tier.** The whole scheduler design assumes cheap
  per-batch writes (mapping + cursor + audit row, fenced by generation). Measure
  the actual quota before committing to a tick cadence; if writes are the scarce
  resource, batch size and audit granularity must be tuned to it, not to
  subrequest count.

**Non-blocking:**

- Wall-clock and the 10ms CPU limit for scheduled Workers on the free tier, which
  bound how much pacing and decompression a single tick may do.
- **Whether Last.fm silently deduplicates identical `(artist, track, timestamp)`
  submissions.** Because `reTagOldListens` historically assigned one identical
  timestamp to every listen, a user who played the same track fifty times may
  have been credited with a single scrobble. If confirmed, this is a pre-existing
  client data-loss bug independent of this feature, and the fix — unique
  timestamps — is the same mechanism this design already requires.

## Review status

Reviewed adversarially on 2026-07-26. Findings incorporated: batched scrobbling,
the error-29-vs-ignore-code-5 distinction, the shared-origin cookie flaw, the
handoff transaction protocol with username binding, fencing tokens, chunked blob
storage, the withdrawal of the exactly-once and capacity claims, and honest
framing of timestamp reassignment.

Claims verified against Last.fm's published API documentation rather than
assumed: the 50-scrobble batch limit, the 200-item `getRecentTracks` cap, the
ASCII signature ordering rule, and the wording of error codes 9, 26, and 29.
