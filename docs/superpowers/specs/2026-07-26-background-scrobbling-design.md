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

**Storage:** D1 for job rows, cursors, and encrypted session keys. Track-list blobs in a second D1 database
(`BLOB_DB`). They were in R2 until deployment; R2 bills past its free tier with no
spending cap, where every D1 Free-plan limit is a refusal. Chunks are capped at
1 MB (D1's row limit is 2 MB) and jobs at 8 MB, so 50 slots fit in one 500 MB
database.

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
| Subrequests per invocation (free) | 50, **including D1 binding calls** |
| Free-tier CPU per invocation | 10ms (wall time awaiting `fetch` does not count) |
| D1 rows written/day (free) | **100,000**, including index write amplification |
| D1 rows read/day (free) | 5,000,000 |
| Scrobbles per Last.fm request | 50 |

### Measured: the feasibility spike

Run 2026-07-26 against local D1 and R2 (`worker/src/spike.ts`). Workers coarsen
`performance.now()` to ~1ms, so a single pass cannot resolve this work at all —
the first attempt reported a misleading "6ms per tick". These are amortised over
thousands of iterations:

| Operation | Cost |
| --- | --- |
| Build + MD5-sign a 50-track batch | **0.25 ms** |
| Parse a 50-scrobble response | 0.03 ms |
| Decompress a 1,000-track chunk | 0.14 ms |
| JSON-parse a 1,000-track chunk | 0.30 ms |
| **Total CPU per 50-track batch** | **≈0.30 ms** |

**CPU is not the constraint.** At 0.3ms per batch, a tick could sign and process
~33 batches before approaching the 10ms limit. The earlier concern was
unfounded — but only measurably so, and note that **Last.fm signs with MD5,
which WebCrypto does not implement**. There is no platform primitive to fall
back on; the hash is pure JS on the CPU budget, and it is the single largest
compute cost in a tick. Any move to per-track signing would multiply it by 50.

**Subrequests bind first.** A job costs ~5 per tick (blob chunk read, CAS acquire,
mapping insert, the Last.fm call, one batched commit), plus one shared
job-selection query. That allows **~9 jobs per tick**.

### The correctness fix and the D1 budget are in direct tension

Storing one row per scrobble — the obvious way to satisfy the per-entry outcome
requirement above — costs 50 inserts plus 50 updates per batch, before index
amplification. At 54 batches per user per day that is ~16,000 row writes per
user, and the 100,000/day budget is exhausted by **six users**.

Packing the per-entry timestamps and outcomes into JSON columns on a single
per-batch row costs ~3 row writes per batch, or ~160 per user per day. Same
correctness, ~50× cheaper.

**Decision: one row per batch, with per-entry timestamps and outcomes stored as
packed arrays.** Per-entry granularity is a correctness requirement; per-entry
*rows* are not.

### Resulting capacity

| Constraint | Implied concurrent jobs |
| --- | --- |
| Subrequests (~5/job/tick) | ~240 |
| D1 writes (packed representation) | ~370 |
| D1 writes (row-per-scrobble) | ~6 — rejected |
| CPU | Not binding |
| Last.fm 5 req/sec per IP | Not binding (~0.15 req/sec at 240 jobs) |

Each user needs 54 job-ticks to consume a 2,700 daily allowance, against ~12,900
job-ticks available per day.

**Initial cap: 50 concurrent jobs**, roughly a quarter of the measured ceiling.
The headroom absorbs retries, reconciliation reads, audit writes, and status
polling, none of which are in the measured path. Raise it on evidence, not
optimism.

The free tier is therefore viable — which was genuinely uncertain before
measuring, and is only true because of the packing decision above.

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

Chunking solves random access and introduces its own requirements. An
authenticated user uploads arbitrary compressed bytes, so:

- **Bound both compressed and uncompressed chunk size**, and enforce field length
  and per-chunk entry count limits. Otherwise a small compression bomb exhausts
  Worker memory at *scheduling* time, taking down every job on that tick rather
  than just the attacker's.
- **Hash every chunk** and validate on upload; write chunks with write-once
  semantics so a chunk cannot be swapped after validation.
- **Publish the manifest last**, and make the `active` transition conditional on
  every chunk being present, hash-valid, and non-overlapping. Missing, duplicated,
  or reordered chunks must be detectable from the manifest alone.

### Listening history is personal data

An earlier framing treated "no email, no password" as meaning there is no PII
here. That is wrong as a threat model. A user's complete listening history,
bound to their Last.fm username, is personal data — and the retained failed-track
list is a subset of it. It should be minimised, deleted on the same schedule as
the credential, and never logged into analytics.

### Portability requirements

The worker must be movable to a plain VM without a rewrite:

- Plain `fetch` and WebCrypto only in the scrobbling core. Both exist in Workers
  and Node 18+. No `node:` imports, no Workers-only APIs.
- Portable SQL only, so D1's SQLite can be swapped for Postgres.
- Blob access behind a minimal get/put-by-key interface (`BlobStore`), so it
  can become R2, S3 or the filesystem.
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

Required protocol. Note step 0 — an earlier draft had the SPA commit the digest
only to `localStorage`, then had the worker "verify against the digest committed
in step 1", which it had never been told. The nonce has the same problem: a
worker-signed value cannot originate on the client.

0. **Server preflight.** Before redirecting, the SPA calls the worker with the
   expected Last.fm username, the payload's SHA-256 digest, the track count, and
   the chunk manifest bounds. The worker durably records a `handoff` row in state
   `issued` and returns a signed, single-use, short-TTL opaque state value. This
   is what makes later verification possible at all.
1. **Persist before leaving.** *Then* the SPA writes the selected track list to
   IndexedDB, because a full-page redirect destroys Vuex.
2. **Bind the callback.** The `cb=` URL carries the signed state from step 0. The
   worker rejects any callback whose state is unknown, expired, already consumed,
   or whose signature fails.
3. **Verify the account.** `auth.getSession` returns a username. If it does not
   match the username recorded in step 0, **abort and discard the session key.**
   Without this check a user logged into a second Last.fm account in another tab
   — or an attacker who lands their own callback — has one account's history
   written into another's. This is the single most damaging failure mode in the
   design.
4. **Upload, then finalise.** The job sits in `pending_upload`. The SPA uploads
   chunks; the worker validates each chunk's hash, publishes the manifest last,
   and only then transitions to `active`.
5. **Clear last.** The SPA clears its own session key and cached list only after
   the worker confirms `active`. Clearing first turns any upload failure into
   total data loss.

#### States, because the happy path is the easy part

The transitions are `issued → exchanging → pending_upload → finalizing → active`,
every one an atomic compare-and-set from the expected prior state. Callback and
finalise must be **idempotent**, because these cases are all reachable:

| Situation | Required behaviour |
| --- | --- |
| Duplicate callbacks race for one Last.fm token | CAS `issued → exchanging`; the loser returns the winner's outcome, never a second `auth.getSession` |
| State claimed, then `auth.getSession` times out | Bounded retry from `exchanging`; on give-up, fail the handoff and discard any key |
| Session obtained, job row creation fails | The credential must be written in the same transaction as the row that owns it, or it is unreachable garbage holding write access |
| Finalise commits `active`, response lost | **Most dangerous case.** The client must not assume failure; it queries handoff status and resumes locally only if the server says the job is not active |
| Reaper fires during an active upload | Reaping is a CAS from the expected state with a freshness check, never an unconditional delete |
| Two tabs start handoffs for one username | One live handoff per username; the second is refused with a pointer to the first |
| Capacity fills between authorisation and activation | Reserve the slot at step 0, not at activation, and release it if the handoff is reaped |

The general rule: **on any uncertain outcome the client stays disabled and asks
the server**, rather than resuming a local scrobble run that may now be racing a
live background job.
6. **Reap abandoned handoffs.** Jobs stuck in `pending_upload`, and unconsumed
   nonces, expire on a timer, deleting any captured credential. A user who closes
   the tab mid-flow must not leave a permanent write credential behind.

### Two API applications, split by trust

**Decided: the worker gets its own Last.fm API application**, separate from the
one in the client bundle.

| | Application | Secret | Callback |
| --- | --- | --- | --- |
| Browser | existing (`2bf354b7…`) | public, in the bundle | `https://savas.ca/scrobblify/scrobble` |
| Worker | **new, server-only** | **genuinely secret** (Worker secret) | `https://api.savas.ca/scrobblify/auth/callback` |

`AuthenticateStep.vue:38-39` hardcodes the client's API key, and `store.ts` its
shared secret, because a browser cannot keep a secret. That stays true and is
unchanged — client-side auth remains the default path so Cloudflare is not on the
critical path for users who never opt in.

What the split buys:

- **Error 26 stops being a shared fate.** The client key is public and therefore
  abusable by anyone into a suspension. Previously that would have killed every
  background job; now it only affects the browser path, and vice versa.
- The worker's shared secret is never published, so its signatures cannot be
  forged. This is the first genuinely secret credential in the system.
- Revocation and rate-limit accounting are separable between the two paths.

The cost is honest and small: users opting into background mode see a second
Last.fm authorisation screen naming a different application. Since the whole
handoff already requires a second round-trip (below), this adds a consent prompt
rather than a redirect.

#### Callback URL mechanics

Last.fm's web auth flow (§2.1, §3) has three details that matter here:

- A `cb` parameter may differ from the application's registered callback, so the
  registered URL is a **default, not a restriction**. Last.fm does not appear to
  constrain `cb` to the registered origin — which means an attacker can route
  users through our API key to a callback they control. The single-use signed
  state and the `auth.getSession` username check are what actually defend the
  handoff; they are not belt-and-braces.
- Last.fm appends the token to the callback, **correctly handling a callback that
  already carries a query string**. The per-handoff signed state can therefore
  live in `cb`'s query string.
- **`cb` must be URL-encoded.** `AuthenticateStep.vue:54` interpolates it raw,
  which is safe only while the callback has no query string. Adding `?state=…`
  unencoded would let the `&` bind to Last.fm's own URL and the state would
  silently disappear.

`api.savas.ca` requires a Workers custom domain. DNS is already on Cloudflare
nameservers, so this is a route, not a nameserver change.

### The client's shared secret stays public

`store.ts:12` hardcodes both the client's Last.fm API key and its shared secret in
the bundle, because a browser cannot hold a secret. That remains true and is not
made worse by this design — client-side auth stays the default so Cloudflare is
not on the critical path for users who never opt in.

What changes is the blast radius: with a separate server-only application (above),
a compromise or suspension of the public client credentials no longer reaches the
background jobs.

### Sessions and identity

**`savas.ca` is a shared origin, and no credential scheme can change that.**
LastWave is served from `savas.ca/lastwave` — a path, not a subdomain. Scrobblify
and LastWave are the *same web origin*, so the browser has no mechanism that
distinguishes them.

A previous draft tried to engineer around this with a `__Host-` cookie plus an
SPA-held bearer token. That does not work, and stating why matters more than the
mitigation did:

- A `__Host-` cookie on `api.savas.ca` cannot be *read* by `savas.ca` scripts —
  but cookies are attached by request **destination**, not by initiator. Since
  `savas.ca` and `api.savas.ca` are same-site, a credentialed `fetch` from
  LastWave's JavaScript to the API carries the cookie anyway.
- A bearer token the SPA can read is, by definition, one LastWave can read: same
  origin, same `localStorage`.
- CORS restricted "to the exact origin" admits both applications, because it *is*
  the same origin.
- Anti-CSRF tokens defend against *cross-site* requests. LastWave is not
  cross-site.

So the honest choice is binary:

| Option | Consequence |
| --- | --- |
| **Dedicated origin** for Scrobblify | Real isolation. `__Host-` cookie on `api.savas.ca` then works as intended. Requires restructuring the existing site. |
| **Accept a shared trust boundary** | Every script served from `savas.ca` — including LastWave and anything it loads — is inside Scrobblify's security perimeter. An XSS in LastWave is an XSS in Scrobblify. |

**Interim decision: accept the shared trust boundary, and document it.** Both
applications are written and deployed by the same author, so this is a defensible
position rather than a third-party exposure — but it must be a *stated* position,
not an accident, and it means no third-party scripts may be added to `savas.ca`
without reconsidering it.

Even under that acceptance, keep the mechanisms that defend against everything
*outside* the origin: `__Host-` cookie on `api.savas.ca` (`Secure`, `Path=/`,
`SameSite=Lax`, `HttpOnly`), exact-origin CORS, and CSRF tokens on state-changing
endpoints. They are worth having; they are simply not isolation from LastWave.

Moving to a dedicated origin remains the recommended long-term fix and is a
blocking open question.

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
- Delete the blob too: cancel deletes it inline, and an hourly cron sweeps the
  chunks of every completed, failed or cancelled job. Retain summary statistics and the failed-
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

### Stalled jobs: dormant, then cancelled, then purged

A parked job (`paused`, `needs_reauth`, `needs_attention`) waits on a person,
and some people never come back. Without a limit it would hold a Last.fm key
and one of the 50 places for ever. The hourly housekeeping cron
(`worker/src/housekeeping.ts`) enforces three deadlines:

| After | What happens | Reversible? |
| --- | --- | --- |
| 14 days parked | `dormant`: key and `live_username` deleted, place freed, tracks kept | Yes: reconnect, if a place is free |
| 30 more days dormant | `cancelled`; its chunks are swept within the hour | No |
| 30 days after any job ends | its `failures` rows are deleted | No |

- **The clock is a column, not `updated_at`.** Migration 005 adds a trigger
  that sets `inactivity_deadline` when a job *enters* a parked or dormant state
  and clears it on the way out. `updated_at` moves every time the sweep drains
  a lease, so a job parked for a month could look fresh. The migration also
  backfills jobs already parked when it runs.
- **Dormant is not terminal.** It holds the queue, so `/import/:id` still
  answers `known: true` and a stale browser copy stays blocked. `/job/live`
  answers `false`, because nothing can send. Take-back and cancel both work
  from it. Resume does not; the job has no key.
- **Reconnecting is the only way back.** The sign-in callback re-attaches the
  credential and returns the job to `paused`, but only if a place is free,
  checked inside the same `UPDATE`. A `needs_reauth` job never gave its place
  up, so it is exempt. `GET /job` reports `reconnectAvailable` for keyless jobs
  so the client can say "full" rather than offer a button that does nothing.
- **The job row is never purged.** Its `import_id` is what keeps `/import/:id`
  answering `known: true`; deleting it would let a browser that kept its copy
  replay the whole queue. It holds no key and no tracks.
- **Batches go with the chunks**, when a job ends. They hold the seconds the
  worker assigned, which only matter while the job can still send or export.
- **Accepted:** a `needs_attention` job that stalled through our own fault
  goes dormant on the same clock. Take-back still returns the queue.
- **Storage bound, weakened.** A dormant job keeps its chunks without holding a
  place, so "50 places × 8 MB" no longer bounds the blob database. If it fills,
  new uploads are refused and the browser keeps scrobbling locally. That is a
  refusal, not a bill.

Every housekeeping pass stays under the Free plan's 50 D1 queries per
invocation: dormancy and expiry are one `UPDATE … RETURNING` plus one audit
insert each, and the blob sweep handles at most 8 jobs.

**D1 counts trigger writes in `meta.changes`.** A one-row state change reports
2 once the trigger fires. Compare `changes` only with zero and use `RETURNING`
to count rows. Verified with Miniflare.

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

### A batch of 50 has 50 outcomes, and a cursor has one

Batching breaks the assumption that progress is a single monotonic index. One
response can simultaneously contain accepted entries, permanent code 1/2
rejections, code 5 entries that must be retried later, and — if the response is
lost — entries whose fate is unknown. Code 5 can begin part-way through a batch,
so the failures are not even a suffix.

A single `cursor` integer cannot represent that, and advancing it past a mixed
batch silently drops tracks.

**Therefore:** persist a per-entry outcome for every in-flight batch. The cursor
advances only across a **contiguous prefix** of entries that are terminal —
accepted or permanently failed. Unknown and code-5 entries stay behind and are
retried or reconciled individually. Progress counts and the audit log are derived
from the per-entry outcomes, not from the cursor.

Per-entry granularity, **not** per-entry rows: the timestamps and outcomes are
packed into JSON columns on one row per batch. The measured spike shows a
row-per-scrobble schema exhausts D1's free write budget at six concurrent users.

### Error handling

| Condition | Response |
| --- | --- |
| Error 29 (IP rate limit) | Trip the **global** circuit breaker; back off all jobs. Log with timestamp and active-job count. |
| `ignoredMessage` code 5 | Per-user daily cap reached. Stop that job and back off (see below); do not treat as failure. |
| `ignoredMessage` code 3/4 | Worker timestamp assignment is wrong. Alert; do not silently drop. |
| `ignoredMessage` code 1/2 | Last.fm rejected the artist/track. Record as permanently failed; never retry. |
| **Error 9 (invalid session key)** | Credential revoked. Delete it, mark `needs_reauth`, stop. **Never retry.** |
| **Error 26 (suspended API key)** | Every job is dead until resolved. Halt globally and alert; retrying makes it worse. |
| Network error | Backoff and retry; nothing was consumed. |
| 10 consecutive failures | Pause the job, mark `needs_attention`, surface on the status page. |

Error 9 is not exclusive to long-running jobs — the client persists session keys
in `localStorage` indefinitely and can hit revocation too — but the worker must
handle it without a user present to re-authenticate.

Error 26 is now contained rather than fatal. The worker uses its **own,
server-only API application** (see Authentication), so the public client key —
which anyone can abuse into a suspension — is no longer shared fate with the
background jobs. A suspension of the worker's key still halts every job at once,
but that key is never published, so the only way to earn it is our own
misbehaviour.

### "Wait until tomorrow" is an assumption, not a fact

Code 5 proves the daily cap was reached. It says nothing about *when* it resets:
whether at midnight in some timezone, or on a rolling 24-hour window. Encoding
"resume at midnight" into the scheduler risks waking every job at once and
immediately re-hitting the cap — while also making the thundering herd worse for
the shared egress IP.

**Until measured:** record the timestamps of accepted sends, wait a conservative
24 hours from the *first* accepted send of the capped period, and probe with a
single small batch before resuming full rate. Back off exponentially if the probe
also returns code 5. The observed reset behaviour is a metric worth capturing in
the beta precisely because it is currently unknown.

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
time the import ran, not when they listened. **Lifetime play counts stay correct**
(modulo the duplicates at-least-once permits), but *time-bounded* charts —
weekly, monthly, yearly — are badly distorted, because the entire import lands in
whatever weeks the job happened to run. The listening timeline is fiction. Anyone
who values that timeline should not use background mode; the foreground path has
the same problem for re-tagged listens, but over hours rather than weeks.

**Ordering: send by earliest expiry deadline, not by recency.**

An earlier draft chose recent-first "to maximise preserved timestamps". That is
backwards. A track played today has ~14 days of slack before its timestamp
becomes unscrobbleable; a track played 13 days ago has one day. Sending recent
tracks first spends the slack of the tracks that need it least and lets the
nearly-expired ones expire. This is ordinary earliest-deadline-first scheduling,
and recency is the wrong key.

Two queues, re-evaluated at send time because deadlines move as the job runs:

| Queue | Order | Rationale |
| --- | --- | --- |
| Still inside the 14-day window | Earliest expiry first (≈ oldest valid first) | Maximises the number of tracks that keep their true timestamp |
| Already outside the window | Chronological, so relative order survives | Nothing left to preserve; only ordering is a choice |

**Decision: deadline-first.** For the users this feature targets — large,
re-tagged, multi-year histories — nearly every track is already outside the
window at job creation, so the first queue is usually small. That does not make
the policy unimportant: it is exactly the users with *some* recent listening who
would notice their genuine timestamps being thrown away needlessly.

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

- **Immutable job payload — but bytes are not behaviour.** The blob chunks are
  written once at job creation and never mutated. That prevents the *data* from
  changing; it does **not** prevent new code from parsing, normalising, ordering,
  or timestamping the same bytes differently. Immutability alone is not a
  deploy-safety guarantee.

  Each job therefore pins an **algorithm version** alongside its manifest
  version, covering parsing, ordering policy, and timestamp assignment. A worker
  that encounters a job pinned to semantics it no longer implements must refuse
  it and flag it, not reinterpret it.
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

  **Fencing protects D1, not Last.fm.** A superseded tick's *external* request
  cannot be revoked: worker A sends a batch, its lease expires in flight, worker
  B takes over and reconciles before A's scrobbles are visible, B resends, then
  A's request lands too. Fencing rejects A's database writes but not its
  scrobbles. Mitigate by having a taking-over tick wait at least the maximum
  outbound request timeout plus a read-visibility grace period before
  reconciling — and accept that this is exactly the duplicate window the
  at-least-once decision already acknowledges. It is a reason that decision has to
  be explicit rather than a claim to have eliminated duplicates.
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
- **Concurrency cap.** Background mode admits a bounded number of concurrent
  jobs, **initially 50** — roughly a quarter of the ~240 ceiling the feasibility
  spike measured, leaving headroom for retries, reconciliation reads, audit
  writes and status polling. When full, the UI offers the normal client-side flow
  and reports that background mode is at capacity.

  Define explicitly *which states consume a slot*. A job that is `needs_reauth`,
  `needs_attention`, or paused must not squat a scarce slot for 60 days: attach an
  inactivity deadline after which it is cancelled, its credential deleted, and the
  user told.

- **Admission control on job size.** At ~2,700 scrobbles/day, the 60-day
  credential TTL caps a completable job at roughly **162,000 tracks** — and that
  assumes no outages, no global pauses, and no code-5 backoff. Reject jobs whose
  conservative completion estimate exceeds the TTL rather than accepting an import
  that is guaranteed to be abandoned half-finished. The measured median selection
  is 34,769, so this affects few users, but those users are precisely the ones
  most motivated to opt in.

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
deleting the blob**, or the data needed to build it is already gone.

### Conflict rules

- A live background job and local saved state must never both be active for one
  user. On detecting both, the UI presents the background job as authoritative
  and offers to discard the local state.
- The client-side scrobble loop must refuse to start while a live background job
  exists for the authenticated user.

## Beta framing

- Opt-in only, offered at any of the four entry points above when the remaining
  selection exceeds 2,700 tracks.
- **Invite-only via `?beta=1`.** Even with `VUE_APP_BACKGROUND_API` set, the
  offer is hidden unless the browser has visited a URL with `?beta=1`. The
  opt-in is sticky (`scrobblify.background.beta` in localStorage) because the
  query string does not survive the handoff: `stripQuery` drops it on return
  and the Last.fm callback never carried it. `?beta=0` clears it, and an
  opted-in browser shows a banner with a switch-off link.
- **The gate covers the offer only, never recovery.** `isBackgroundEnabled`
  (configured *and* opted in) guards `probeBackgroundAvailability` and
  `preflight`. The live-job authority check, finishing a handoff on return,
  and rendering an existing job use `isBackgroundConfigured` alone, so a browser
  that has lost its storage — and with it the opt-in — still learns it has a
  job running and is blocked from scrobbling underneath it.
- **An unanswered authority check falls through for non-beta browsers.** A
  `live: true` answer blocks everyone, but when the worker cannot be reached a
  browser that has not opted in and holds no local handover evidence waits
  3s and scrobbles normally. Opted-in browsers, and any browser with an
  ownership, unresolved or stale-snapshot record, a pending handoff or a known
  job, stay blocked. Otherwise a worker outage would stop every user of the
  site. Accepted gap: lost localStorage plus a leftover handed-over queue in
  IndexedDB plus an unreachable worker.
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

**Blocking — none remaining.** All three are now decided:

- ~~**Free-tier feasibility.**~~ Measured 2026-07-26 (`worker/src/spike.ts`). CPU
  is not the constraint (0.30 ms per 50-track batch against a 10 ms limit);
  subrequests bind at ~240 concurrent jobs; D1 writes are affordable only with
  packed per-batch rows. Initial cap 50. See Architecture.
- ~~**Should Scrobblify move to its own origin?**~~ **Accepted the shared trust
  boundary** for the beta, explicitly and documented. No third-party scripts on
  `savas.ca`. Revisit if the feature graduates.
- ~~**A separate, server-only Last.fm API application?**~~ **Yes.** Callback
  `https://api.savas.ca/scrobblify/auth/callback`. The browser keeps the existing
  key and callback unchanged. See Authentication.

**Non-blocking:**

- **Whether Last.fm's daily cap resets on a clock or a rolling window**, which
  determines the resume schedule after code 5. Measure during the beta.
- **Whether Last.fm silently deduplicates identical `(artist, track, timestamp)`
  submissions.** Because `reTagOldListens` historically assigned one identical
  timestamp to every listen, a user who played the same track fifty times may
  have been credited with a single scrobble. If confirmed, this is a pre-existing
  client data-loss bug independent of this feature, and the fix — unique
  timestamps — is the same mechanism this design already requires.
- Concurrent scrobbling from Spotify or another scrobbler consumes the same
  account budget invisibly. The conflict rules cover Scrobblify's own clients
  only; nothing can see the rest.

## Review status

Reviewed adversarially over two rounds on 2026-07-26.

**Round one** produced: batched scrobbling, the error-29-vs-ignore-code-5
distinction, the shared-origin cookie flaw, the handoff transaction protocol with
username binding, fencing tokens, chunked blob storage, withdrawal of the
exactly-once and capacity claims, and honest framing of timestamp reassignment.

**Round two** corrected the round-one fixes, several of which were wrong:

- Recent-first ordering was **backwards**; it spends slack on the tracks that
  need it least. Now earliest-deadline-first.
- The `__Host-` cookie plus bearer token did **not** isolate LastWave — cookies
  attach by destination, and a token the SPA can read LastWave can read. Replaced
  with an explicit, documented trust-boundary decision.
- The handoff had no server-side commit of the digest it later claimed to verify.
  Added a preflight step and a CAS state machine covering seven ambiguous states.
- A single cursor cannot represent a 50-entry batch's mixed outcomes.
- Fencing protects D1 but cannot revoke an in-flight Last.fm request.
- "Immutable payload" does not make behaviour immutable; jobs now pin an
  algorithm version.
- The concurrency cap still referenced the withdrawn ceiling; it is now blocked
  on a feasibility spike.

Claims verified against Last.fm's published API documentation rather than
assumed: the 50-scrobble batch limit, the 200-item `getRecentTracks` cap, the
ASCII signature ordering rule, and the wording of error codes 9, 26, and 29.

**Known unresolved**, carried deliberately rather than papered over: free-tier
feasibility is unproven pending the spike; the shared origin is a product
decision; export-before-deletion cannot guarantee delivery; and duplicates remain
possible by design under at-least-once.
