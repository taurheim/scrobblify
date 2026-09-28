# Scrobblify background worker

Cloudflare Worker that finishes large Last.fm imports unattended, so users with
more than ~2,700 tracks don't have to keep returning to the tab.

Design: [`docs/superpowers/specs/2026-07-26-background-scrobbling-design.md`](../docs/superpowers/specs/2026-07-26-background-scrobbling-design.md)

## Status

Implemented and tested, **not yet deployed**. `api.savas.ca` does not resolve,
so the registered Last.fm callback goes nowhere and `wrangler.toml` still has a
placeholder `database_id`.

Verified end to end against `wrangler dev --local`: the startup secret guard
passes with all four names set, and `/scrobblify/capacity` and
`/scrobblify/job/live` answer `200` once the four migrations are applied to the
local D1.

```powershell
npm test   # typechecks, then runs every suite against a real SQLite schema
```

## Deploying

Everything runs from `worker/`. Steps 0–3 create infrastructure and only need
doing once; after that, a redeploy is just `npx wrangler deploy`.

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

# 3. Schema. Every file in schema/, in order, then the blob schema.
npx wrangler d1 execute scrobblify --remote --file schema/001_init.sql
npx wrangler d1 execute scrobblify --remote --file schema/002_synthetic_floor.sql
npx wrangler d1 execute scrobblify --remote --file schema/003_export_claim.sql
npx wrangler d1 execute scrobblify --remote --file schema/004_import_id.sql
npx wrangler d1 execute scrobblify-blobs --remote --file schema-blobs/001_blobs.sql

# 4. Secrets (see below). Each command prompts for its value.
npx wrangler secret put LASTFM_API_KEY
npx wrangler secret put LASTFM_SHARED_SECRET
npx wrangler secret put CREDENTIAL_SECRET
npx wrangler secret put SIGNING_KEY

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
| Rate | 20 requests per 1 minute, per IP |
| Action | Block for 1 minute |

Genuine clients call this at most a couple of times per page load, so 20/min
is far above real use and far below useful enumeration.

**Not enforced with a counter in D1**, deliberately: a row written per request
would let an enumerator burn the free tier's daily write quota on our behalf,
which stops the scheduler and strands every running import. That is a worse
outcome than the fact being leaked.

The SPA reads its API base from `VUE_APP_BACKGROUND_API` in `.env.production`.
Setting it does not switch the feature on by itself: the client asks
`/scrobblify/capacity` on load and stays silent unless the worker answers, so
deploying the SPA before the worker degrades to the old behaviour rather than
offering a handoff that cannot complete.

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
# fill in the four values, then apply the schema to the local D1 once:
npx wrangler d1 execute scrobblify --local --file schema/001_init.sql
npx wrangler d1 execute scrobblify --local --file schema/002_synthetic_floor.sql
npx wrangler d1 execute scrobblify --local --file schema/003_export_claim.sql
npx wrangler d1 execute scrobblify --local --file schema/004_import_id.sql
npx wrangler d1 execute scrobblify-blobs --local --file schema-blobs/001_blobs.sql
npx wrangler dev --local
```

`--local` keeps its own D1 in `.wrangler/state`, separate from production and
unaffected by step 3 of the deploy. Skipping it leaves every route answering
`500`, because the tables the handlers read do not exist yet.

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
