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

## Non-goals

- **Making imports faster.** The 2,700/day per-user limit is imposed by Last.fm
  and applies equally to a backend. A 100k import still takes ~37 days. The
  feature buys *unattendedness*, not speed.
- **User accounts.** The Last.fm username is the only identity.
- **Replacing the client-side flow.** It remains the default for most users.

## Scope

Background mode is offered **only when the selected track count exceeds
`DAILY_LIMIT` (2,700)** — that is, only to users who would otherwise have to
return at least once. Smaller imports finish in one sitting and stay entirely
client-side.

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

### Duplicate scrobbles: reconcile, don't prevent

**The ambiguity window is irreducible.** Even committing the cursor after every
single track, the worker can crash between Last.fm accepting a scrobble and D1
recording it. No cursor granularity eliminates this.

Therefore the worker **reconciles against Last.fm** using the existing
`getAllScrobblesInRange`, fetching the user's actual recent scrobbles and
skipping any already present. The duplicate-detection logic in the upload step
already performs this comparison.

An **unclean tick** is precisely: a job whose `locked_until` lease expired
without the tick having committed a final cursor. The next tick to pick up that
job reconciles before scrobbling anything.

The **reconciliation range** runs from the timestamp of the earliest track in the
uncommitted cursor range to the present. Tracks found already on the user's
profile are marked complete and skipped; the cursor advances past them.

Once reconciliation exists, batch size is purely a throughput tuning knob rather
than a safety mechanism. Last.fm's own deduplication is not relied upon.

Re-tagged listens carry today's timestamp, so they fall inside the reconciliation
window like any other recent scrobble.

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

## Beta framing

- Opt-in only, presented at step 3→4 when the selection exceeds 2,700 tracks.
- Labelled clearly as beta in the UI.
- The opt-in must state plainly: the selected track list is uploaded to
  Scrobblify's server; a Last.fm credential is stored until the import finishes;
  access can be revoked at any time at last.fm/settings/applications.

## Analytics

Follow the conventions in `AGENTS.md` — use the helpers in
`src/services/Analytics.ts`, never `posthog` directly, and never widen an error
message to include raw request parameters.

New events: `background_offered`, `background_opted_in`, `background_declined`,
`background_handoff_failed`, `background_job_created`,
`background_job_completed`, `background_job_cancelled`, `background_reauth_needed`,
`background_capacity_full`.

New error contexts: `background.handoff`, `background.upload`,
`background.status`, `worker.scrobbleBatch`, `worker.reconcile`.

## Open questions for implementation

- Whether D1 and R2 binding calls count against the 50-subrequest limit. This
  determines the achievable batch size and therefore the exact capacity ceiling.
  It does not affect correctness, because reconciliation is required regardless.
- Wall-clock limits for scheduled Workers on the free tier, which bound how long
  a single tick may pace its batch.
