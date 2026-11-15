# Scrobblify background worker

Cloudflare Worker that finishes large Last.fm imports unattended, so users with
more than ~2,700 tracks don't have to keep returning to the tab.

Design: [`docs/superpowers/specs/2026-07-26-background-scrobbling-design.md`](../docs/superpowers/specs/2026-07-26-background-scrobbling-design.md)

## Status

Deployed at `https://api.savas.ca`. Pushes to `master` that touch `worker/`,
`src/shared/` or `src/services/` test and redeploy it through
`.github/workflows/worker.yml` (see "Deploying from CI" below).

```powershell
npm test   # typechecks, then runs every suite against a real SQLite schema
```

## Deploying

Everything runs from `worker/`. Steps 0–4 create infrastructure and only need
doing once; after that, CI redeploys on every merge (see "Deploying from CI").
`npx wrangler deploy` by hand still works.

```powershell
cd worker
npm install
npx wrangler login

# 0. Register the worker's own Last.fm application at
#    https://www.last.fm/api/account/create with callback
#    https://api.savas.ca/scrobblify/auth/callback. Keep its key and secret
#    for step 4. Do NOT reuse the browser's key (see "The two Last.fm
#    applications" below).

# 1. D1. Copy the printed database_id into wrangler.toml, replacing
#    "set-me-after-wrangler-d1-create". The id is not a secret; commit it.
npx wrangler d1 create scrobblify

# 2. A second D1 for the uploaded track blobs. Copy its database_id into the
#    BLOB_DB block of wrangler.toml. (See "Why blobs live in D1" below.)
npx wrangler d1 create scrobblify-blobs

# 3. Schema. Applies every file in schema/ and schema-blobs/ (the
#    migrations_dir of each database in wrangler.toml) and records each in
#    that database's d1_migrations table. CI repeats this before every deploy.
npx wrangler d1 migrations apply scrobblify --remote
npx wrangler d1 migrations apply scrobblify-blobs --remote

# 4. Secrets (see below). Each command prompts for its value.
npx wrangler secret put LASTFM_API_KEY
npx wrangler secret put LASTFM_SHARED_SECRET
npx wrangler secret put CREDENTIAL_SECRET
npx wrangler secret put SIGNING_KEY

#    PostHog uses the non-secret ingestion variables already declared in
#    wrangler.toml.
#
# 5. Deploy. `routes` in wrangler.toml makes api.savas.ca a custom domain, so
#    this also creates its DNS record and certificate; the first request can
#    take a few minutes while the certificate is issued.
npx wrangler deploy

# 6. Smoke test. This is a public route, so no session is needed.
curl https://api.savas.ca/scrobblify/capacity
```

A `200` with `{"available":true,...}` proves three things at once: the worker is
routed, all four secrets passed the startup guard in `src/index.ts` (a missing
or short one returns `503 misconfigured` on **every** route), and D1 is reachable
and migrated — the handler reads the control row and counts committed slots.

`503` means secrets; `500` means D1 (usually an unapplied migration from step 3).

Note that `/verify` belongs to the phase-0 feasibility spike (`src/spike.ts`,
deployed only under `wrangler.spike.toml`). The real worker has no such route
and will answer `401` for it, along with every other unknown path.

### 7. Rate-limit the public lookup

`GET /scrobblify/job/live?username=…` answers without a session, by design:
the browsers it exists to stop are exactly the ones that have lost their
storage, and a Last.fm redirect is far too heavy to impose on every user at
every page load just to discover they have no job. It returns a bare boolean
and grants no control, but it does let someone ask whether a given Last.fm
username uses the feature.

Add a Cloudflare rate-limiting rule (Security → WAF → Rate limiting rules;
one rule is included on the free plan):

| Field | Value |
| --- | --- |
| If incoming requests match | `URI Path` equals `/scrobblify/job/live` |
| Characteristics | IP |
| Rate | 5 requests per 10 seconds |
| Action | Block, for 10 seconds |

The free plan only offers a 10-second period and a 10-second block, so the rule
is expressed in those units. Genuine clients call this at most a couple of times
per page load, and a blocked caller gets at most 5 answers per 20 seconds
(about 15 a minute): far above real use, far below useful enumeration.

**Not enforced with a counter in D1**, deliberately: a row written per request
would let an enumerator burn the free tier's daily write quota on our behalf,
which stops the scheduler and strands every running import. That is a worse
outcome than the fact being leaked.

The SPA reads its API base from `VUE_APP_BACKGROUND_API` in `.env.production`.
Setting it does not switch the feature on by itself: the client asks
`/scrobblify/capacity` on load and stays silent unless the worker answers, so
deploying the SPA before the worker degrades to the old behaviour rather than
offering a handoff that cannot complete.

### Deploying from CI

`.github/workflows/worker.yml` runs `npm test` on every PR that can affect the
worker. On a push to `master` it then applies D1 migrations, runs
`npx wrangler deploy` and the step 6 smoke test. It can be started by hand
from the Actions tab (`workflow_dispatch`). It needs two repository secrets:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | the account id (`npx wrangler whoami`, or the dashboard's Workers overview) |
| `CLOUDFLARE_API_TOKEN` | an account API token with **Workers → Editor** on all Workers, **D1 → Edit**, and **Zone → Workers Routes → Edit** on `savas.ca` |

Scope Workers to the whole account, not to the `scrobblify` worker: custom
domains do not support per-Worker roles yet, and a token without account-level
Workers access fails wrangler's first call with `No access to the specified
service`. The zone permission is what lets the deploy keep the `api.savas.ca`
custom domain. D1 → Edit is for the migration step.

The deploy installs only `worker/`'s dependencies. `src/shared/` lives outside
`worker/`, so `wrangler.toml` aliases `blueimp-md5` (its one package import) to
`worker/node_modules`, and `tsconfig.json` maps its types the same way; without
that, the bundle only built when the SPA was installed too. The test job does
install the SPA, because the `client-*` suites typecheck `src/services/`.

### Schema changes

A schema change is a new file in `schema/` (or `schema-blobs/`) named with the
next number, e.g. `006_whatever.sql`. Merging it is enough: the deploy job runs
`wrangler d1 migrations apply` on both databases before `wrangler deploy`,
which applies every file not yet listed in that database's `d1_migrations`
table, in filename order. Each file and its `d1_migrations` row go in one
request, and a failure stops the job before anything is deployed.
`test/schema.ts` loads the same files in the same order, so the suite runs
against exactly what production gets.

Three rules:

- **A migration must work with the worker that is already running.** That
  version serves requests while the migration runs, and keeps serving if the
  deploy after it fails. Add tables, nullable or defaulted columns, indexes
  and triggers freely. To drop or rename something, first ship code that no
  longer uses it, then remove it in a later PR.
- **Never edit or rename a merged file.** Files are tracked by name: an edited
  one is skipped silently and a renamed one runs a second time. Fix a mistake
  with a new migration.
- **Don't run schema SQL against production by hand** with `d1 execute`. A file
  applied that way isn't recorded, so the next deploy runs it again, and an
  `ALTER TABLE … ADD COLUMN` fails the second time.

A migration that ran but did damage is undone with D1 Time Travel
(`npx wrangler d1 time-travel restore <db> --timestamp=<before the deploy>`),
followed by redeploying the previous worker version.

Production predates this: `001`–`005` and `001_blobs.sql` were applied by hand
with `d1 execute`, so on 2026-11-15 their names were inserted into a hand-made
`d1_migrations` table (same layout wrangler creates), after checking that each
file's columns, indexes and trigger were present.

### Why blobs live in D1, and what this costs

Nothing, provided the account stays on **Workers Free** and **R2 is never
enabled**. Every Free-plan limit is a refusal, not a bill: past its daily
quota D1 errors, and so does the worker past its request quota. R2 is the
exception, because it charges for anything past its free tier and has no
spending cap, which is why the uploaded chunks moved out of it.

The blobs get their own database so a full one refuses only new uploads (the
client falls back to scrobbling locally) and never touches the scheduler's
data. Storage is bounded by construction: each compressed chunk is capped at
1 MB (D1 rows max out at 2 MB), each job at 8 MB, and at most 50 jobs hold a
slot, so 400 MB against D1's 500 MB. A second cron (`17 * * * *`) deletes the
chunks of completed, failed and cancelled jobs within the hour.

That cron also handles stalled jobs. A job left paused (or waiting for a
reconnect) for 14 days goes `dormant`: its Last.fm key is deleted and its place
freed, but its chunks stay so the user can reconnect or take them back. After
30 more days it is cancelled and its chunks are swept. Because dormant jobs
keep chunks without a place, the 400 MB figure is no longer a hard bound; a
full blob database refuses new uploads and costs nothing.

### 8. Try it

The worker and the SPA can be deployed in either order. The SPA ships through
the normal CD on merge to master. Nobody is offered the feature without opting
in: open `https://savas.ca/scrobblify/?beta=1` (sticky; `?beta=0` turns it
off), start an import with at least 2,700 tracks left, and press
Pause & Save to see the offer. `npx wrangler tail` streams the worker's logs.

## Secrets

**Never commit these, and never paste them into a chat or issue.** The client's
Last.fm key is public because a browser can't hold a secret; the worker's is the
first genuinely secret credential in this project, and it stays that way.

Local development:

```powershell
Copy-Item .dev.vars.example .dev.vars
# fill in the four values, then apply the schema to the local D1:
npx wrangler d1 migrations apply scrobblify --local
npx wrangler d1 migrations apply scrobblify-blobs --local
npx wrangler dev --local
```

`--local` keeps its own D1 in `.wrangler/state`, separate from production.
Re-run the two `migrations apply` lines after pulling a new migration. Skipping
them leaves every route answering `500`, because the tables the handlers read
do not exist yet. A local D1 set up before 2026-11-15 with `d1 execute` has no
`d1_migrations` table, so `migrations apply` would re-run every file and fail;
delete `.wrangler/state` and apply from scratch.

Smoke test the same way as production:

```powershell
curl "http://127.0.0.1:8787/scrobblify/capacity"
```

Production:

```powershell
npx wrangler secret put LASTFM_API_KEY
npx wrangler secret put LASTFM_SHARED_SECRET
npx wrangler secret put CREDENTIAL_SECRET
npx wrangler secret put SIGNING_KEY
```

These four names are the ones `src/index.ts` reads. `src/spike.ts` predates the
worker and reads `CREDENTIAL_ENC_KEY` / `HANDOFF_SIGNING_KEY` for the same two
keys; it is not deployed, so ignore those unless you are running the spike.

`wrangler secret put` prompts for the value on stdin rather than taking it as an
argument, which keeps it out of shell history. It also writes to the *deployed*
environment only — setting a secret locally does not set it in production, or
vice versa.

## PostHog telemetry

Scheduled background scrobbling sends best-effort lifecycle and aggregate
progress events through PostHog's HTTP capture endpoint. `POSTHOG_TOKEN` and
`POSTHOG_HOST` are explicit `[vars]` in `wrangler.toml`; the token is the same
public project ingestion token used by the browser, **not** a personal API key
or secret. Every event is tagged `app=scrobblify`, uses the Last.fm username as
`distinct_id`, and contains aggregate counts only. Analytics delivery failures
are ignored and cannot change scheduler state or retries.

For local development, `.dev.vars.example` repeats those two non-secret values
so they can be changed without editing deployment configuration. Do not replace
`POSTHOG_TOKEN` with a personal API key.

### Generating the two random keys

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`CREDENTIAL_SECRET` encrypts stored Last.fm session keys, so a D1 dump alone
yields no usable credentials. **Rotating it strands every existing job** — the
stored keys become undecryptable and affected users must re-authorise. Treat it
as append-only until there is a re-encryption path.

## The two Last.fm applications

|  | Application | Secret | Callback |
| --- | --- | --- | --- |
| Browser | existing (`2bf354b7…`) | public, in the bundle | `https://savas.ca/scrobblify/scrobble` |
| Worker | server-only | secret | `https://api.savas.ca/scrobblify/auth/callback` |

Two gotchas from Last.fm's [web auth flow](https://www.last.fm/api/webauth):

- The `cb` parameter may differ from the registered callback, and Last.fm does
  not appear to constrain it. The registered URL is a default, not a
  restriction — so the signed single-use `state` and the `auth.getSession`
  username check are what actually secure the handoff.
- **`cb` must be URL-encoded.** `AuthenticateStep.vue:54` interpolates it raw,
  which is safe only while the callback carries no query string. Adding
  `?state=…` unencoded would bind the `&` to Last.fm's own URL and silently drop
  the state.

## Running the spike

```powershell
npx wrangler dev --local --port 8788
curl "http://127.0.0.1:8788/spike"          # one full tick: subrequests, D1 cost
curl "http://127.0.0.1:8788/spike?bench=1"  # amortised CPU microbenchmarks
```

Use `?bench=1` for any CPU claim. Workers coarsen `performance.now()` to ~1 ms,
so a single pass cannot resolve this work — the unamortised path reports ~6 ms
for a batch that actually costs ~0.30 ms.
