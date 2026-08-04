# Scrobblify background worker

Cloudflare Worker that finishes large Last.fm imports unattended, so users with
more than ~2,700 tracks don't have to keep returning to the tab.

Design: [`docs/superpowers/specs/2026-07-26-background-scrobbling-design.md`](../docs/superpowers/specs/2026-07-26-background-scrobbling-design.md)

## Status

Feasibility spike only (`src/spike.ts`). Not deployed.

## Secrets

**Never commit these, and never paste them into a chat or issue.** The client's
Last.fm key is public because a browser can't hold a secret; the worker's is the
first genuinely secret credential in this project, and it stays that way.

Local development:

```powershell
Copy-Item .dev.vars.example .dev.vars
# fill in the four values, then:
npx wrangler dev --local
```

Production, once `api.savas.ca` exists:

```powershell
npx wrangler secret put LASTFM_API_KEY
npx wrangler secret put LASTFM_SHARED_SECRET
npx wrangler secret put CREDENTIAL_ENC_KEY
npx wrangler secret put HANDOFF_SIGNING_KEY
```

`wrangler secret put` prompts for the value on stdin rather than taking it as an
argument, which keeps it out of shell history.

### Generating the two random keys

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`CREDENTIAL_ENC_KEY` encrypts stored Last.fm session keys, so a D1 dump alone
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
