// In-browser mock of the background scrobbling worker.
//
// Companion to lastfmMock.js. Where that one fakes Last.fm, this one fakes
// `worker/` — every `/scrobblify/*` endpoint the SPA calls — so the whole
// handoff UI (offer, redirect, upload, status card, pause/resume, take-back,
// cancel) can be clicked through without wrangler, D1, R2 or a deployment.
//
// It is a *UI* mock, not a second implementation of the worker. It keeps just
// enough state to make the screens move: one job, its progress, and the
// handoff that produced it. Anything the client only reads for display is
// invented; anything the client makes a safety decision on is answered the way
// the real worker would.
//
// Two things are deliberately simplified:
//
//   * Uploaded chunks are counted, never decoded. `encodeChunk` produces
//     gzipped binary, and reimplementing `parseChunk` here would be a second
//     copy of a format that has already changed twice. The export therefore
//     hands back synthetic tracks rather than the ones that went up.
//   * The Last.fm redirect is replaced by a same-origin shim page. The real
//     flow returns a token in the URL fragment, which the dev server cannot
//     use: `router.ts` runs in *hash* mode outside production, so the fragment
//     is the route. The shim writes the same localStorage keys the fragment
//     handler would and navigates back.

const { MOCK_USER } = require('./lastfmMock');

const DEFAULT_API_ORIGIN = 'http://localhost:8787';
const DEFAULT_APP_ORIGIN = 'http://localhost:8080';

// Must match `MIN_TRACKS_FOR_BACKGROUND` in worker/src/api.ts and
// ScrobbleStep.vue: below it the client never offers the handoff and the
// worker rejects the preflight outright.
const MIN_TRACKS = 750;
const CHUNK_TRACKS = 1000;

// The rate the *real* worker paces at (`importBudget(0)` in
// src/shared/lastfm/dailyCap.ts: Last.fm's 750 a day less 50 for the user's own
// listening), and the only thing the completion estimate may be derived from.
// The simulation deliberately runs far faster than this so the progress bar
// visibly moves, but reusing that speed for the ETA made a 28-day job report
// "Should finish within a day" — the status card would contradict the offer
// dialog the user had just read.
const WORKER_TRACKS_PER_DAY = 700;
// `MAX_TRACKS_PER_JOB` in worker/src/handoff.ts (700 a day for 60 days). A test
// can raise it with the `maxTracks` option.
const MAX_TRACKS = 42000;

const CORS = {
  // Safe as a wildcard: the session travels in an Authorization header, not a
  // cookie, so nothing here is a credentialed request.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Chunk-Digest',
  'Access-Control-Max-Age': '86400',
};

/** States in which the worker has definitively stopped sending. */
const TERMINAL = ['completed', 'failed', 'cancelled'];
/** Handoff states that may still produce a job (`HandoffState` in worker/src/store.ts). */
const IN_FLIGHT_HANDOFF = ['issued', 'exchanging'];
/** States waiting on the user, which carry an inactivity deadline. */
const PARKED = ['paused', 'needs_reauth', 'needs_attention', 'dormant'];
/** States whose Last.fm key is gone, so only a reconnect can revive them. */
const KEYLESS = ['needs_reauth', 'dormant'];
const DORMANT_AFTER_SEC = 14 * 86400;
const EXPIRE_AFTER_SEC = 30 * 86400;

/**
 * Changes a job's state the way the worker's `jobs_inactivity_deadline`
 * trigger sees it: entering a parked state starts a 14-day clock, entering
 * `dormant` a 30-day one, and anything else clears it. Going dormant from a
 * parked state remembers it in `dormantFrom`, as `markDormant` does.
 */
function setState(job, state, nowMs) {
  const nowSec = Math.floor(nowMs / 1000);
  /* eslint-disable no-param-reassign */
  if (state !== job.state) {
    if (state === 'dormant') {
      job.inactivityDeadlineSec = nowSec + EXPIRE_AFTER_SEC;
      if (PARKED.includes(job.state)) {
        job.dormantFrom = job.state;
      } else if (job.state !== 'exporting') {
        job.dormantFrom = null;
      }
    } else if (PARKED.includes(state)) {
      job.inactivityDeadlineSec = nowSec + DORMANT_AFTER_SEC;
    } else {
      job.inactivityDeadlineSec = null;
    }
  }
  if (state === 'active') {
    job.lastTickMs = nowMs;
  }
  if (TERMINAL.includes(state) && !job.completedAtMs) {
    job.completedAtMs = nowMs;
  }
  job.state = state;
  /* eslint-enable no-param-reassign */
}

function hex(n) {
  let out = '';
  for (let i = 0; i < n; i += 1) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

/**
 * A synthetic queue for the take-back path.
 *
 * See the header: the chunks that went up are not decoded, so what comes back
 * is invented. `reTagged` is true because an import large enough to qualify
 * for the handoff at all is overwhelmingly re-tagged in practice, and that is
 * the branch worth looking at.
 */
function syntheticTracks(count) {
  const nowMs = Date.now();
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      artist: `Mock Artist ${(i % 40) + 1}`,
      track: `Mock Track ${i + 1}`,
      album: `Mock Album ${(i % 12) + 1}`,
      // Cosmetic: a re-tagged track's date is invented at send time anyway.
      timestamp: nowMs,
      reTagged: true,
    });
  }
  return out;
}

/**
 * The page the redirect lands on instead of Last.fm.
 *
 * Served on the *app* origin so it can write the app's localStorage — the
 * whole point of it. Two details are load-bearing:
 *
 *   * `?handoff=<id>` in the *query*. `resumeHandoffIfReturning` reads
 *     `window.location.search` and returns immediately without it, so the
 *     upload never starts.
 *   * the session and handoff id go into localStorage rather than the URL
 *     fragment the real worker uses, because in dev the fragment *is* the
 *     route. `consumeRedirectFragment` finds nothing there and falls back to
 *     `getPendingHandoff()`, which is what these writes satisfy.
 *
 * `location.replace` keeps it out of the back stack, so the user cannot reload
 * their way into re-authorising a handoff that is already done.
 *
 * `user` is the Last.fm account the real worker names in its fragment when
 * the handoff or sign-in named none. It is remembered the way the app
 * remembers a signed-out user (a name with no session key, as
 * `LastFm.clearSessionKey` leaves it). `fail` stands in for a callback the
 * real worker refuses: nothing is written and the app gets
 * `?handoff=failed&reason=<fail>`.
 */
function shimHtml(session, handoffId, user = '', fail = '') {
  if (fail) {
    const failed = `/?handoff=failed&reason=${encodeURIComponent(fail)}#/scrobble`;
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>Mock Last.fm authorisation</title>
<style>body{font:16px system-ui;margin:4rem auto;max-width:32rem;color:#222}</style></head>
<body>
<h1>Authorising&hellip;</h1>
<p>Mock Last.fm approval failed. Returning to Scrobblify.</p>
<script>
  location.replace(${JSON.stringify(failed)});
</script>
</body></html>`;
  }
  const setHandoff = handoffId
    ? `localStorage.setItem('scrobblify.background.handoff', ${JSON.stringify(handoffId)});`
    : '';
  const setUser = user
    ? `localStorage.setItem('scrobblifyLfmUserName', ${JSON.stringify(user)});`
    : '';
  const back = handoffId
    ? `/?handoff=${encodeURIComponent(handoffId)}#/scrobble`
    : '/#/scrobble';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Mock Last.fm authorisation</title>
<style>body{font:16px system-ui;margin:4rem auto;max-width:32rem;color:#222}</style></head>
<body>
<h1>Authorising&hellip;</h1>
<p>Mock Last.fm approval. Returning to Scrobblify.</p>
<script>
  try {
    localStorage.setItem('scrobblify.background.session', ${JSON.stringify(session)});
    ${setHandoff}
    ${setUser}
  } catch (e) { /* the app reports the failure for us */ }
  location.replace(${JSON.stringify(back)});
</script>
</body></html>`;
}

/**
 * Answers a shim URL the way both callers need, from its query.
 */
function shimFromQuery(searchParams) {
  return shimHtml(
    searchParams.get('session') || '',
    searchParams.get('handoff') || '',
    searchParams.get('user') || '',
    searchParams.get('fail') || '',
  );
}

/**
 * Builds one mock worker.
 *
 * The world lives in this closure rather than being passed around, so no
 * handler mutates something it was handed.
 *
 * `rate` and `tickSeconds` are the knobs that matter in practice. The real
 * worker sends in steps, once per five-minute tick, at most a day's budget (see
 * `WORKER_TRACKS_PER_DAY`); at that speed nothing visibly moves. The mock keeps
 * the steps but shortens them: every `tickSeconds` (default 20) it sends
 * `rate * tickSeconds` tracks, so the card's "next batch" countdown and its
 * auto-refresh can be watched. It drives the progress bar only — the completion
 * estimate uses the real rate, so the card's ETA still matches the one the
 * offer dialog quoted.
 */
function createMockWorker(options = {}) {
  const apiOrigin = options.apiOrigin || DEFAULT_API_ORIGIN;
  // An explicit empty string is a *relative* origin, which is what the dev
  // server's middleware wants so the authorise URL works from whatever host
  // the browser used. `||` would treat it as "unset" and silently hand back
  // localhost:8080 — the port the Playwright suite runs on.
  const appOrigin = options.appOrigin === undefined ? DEFAULT_APP_ORIGIN : options.appOrigin;
  const verbose = options.log !== false;
  // The Last.fm account that "authorises" a handoff or sign-in that named
  // none, as the real worker adopts it at the callback.
  const lastFmUser = options.username || MOCK_USER;

  const world = {
    rate: options.rate || 40,
    tickSeconds: options.tickSeconds || 20,
    capacityAvailable: options.capacityAvailable !== false,
    // A reason makes every handoff's authorisation fail with it, as a denial
    // or a refused callback does (`?handoff=failed&reason=…`).
    authoriseFail: options.authoriseFail || '',
    handoffs: new Map(),
    imports: new Map(),
    job: null,
  };

  /**
   * Advances the simulated job to `nowMs`, one tick at a time.
   *
   * Called at the top of every request rather than on a timer: the client only
   * ever observes the job through these endpoints, so there is nothing a timer
   * could do that a read cannot — and no interval to leak when the page shuts.
   * `lastTickMs` is the last tick the job has had; it resets when the job
   * (re)activates, like a real job becoming due.
   */
  function advance(nowMs) {
    const { job } = world;
    const tickMs = world.tickSeconds * 1000;
    while (job && job.state === 'active' && nowMs - job.lastTickMs >= tickMs) {
      job.lastTickMs += tickMs;
      job.scrobbled = Math.min(job.totalTracks, job.scrobbled + world.rate * world.tickSeconds);
      if (job.scrobbled >= job.totalTracks) {
        job.scrobbled = job.totalTracks;
        job.state = 'completed';
        job.completedAtMs = job.lastTickMs;
      }
    }
  }

  function isLive() {
    return !!world.job && !TERMINAL.includes(world.job.state);
  }

  /**
   * The real worker's `/job/live` reads `live_username`, which is cleared the
   * moment a job loses its key. A keyless job still holds the queue, but it
   * cannot send, so it answers "not live" and `/import/:id` does the blocking.
   */
  function isSending() {
    return isLive() && !KEYLESS.includes(world.job.state);
  }

  /** Mirrors `canReattach`: re-auth always fits, dormant needs a free place. */
  function reconnectAvailable() {
    return world.job.state === 'needs_reauth' || world.capacityAvailable;
  }

  function jobView() {
    const { job } = world;
    if (!job) {
      return null;
    }
    const scrobbled = Math.floor(job.scrobbled);
    const remaining = Math.max(0, job.totalTracks - scrobbled - job.failed);
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      id: job.id,
      state: job.state,
      reason: job.reason,
      totalTracks: job.totalTracks,
      scrobbled,
      failed: job.failed,
      remaining,
      waitingUntil: job.waitingUntil,
      nextRunAt: job.state === 'active'
        ? Math.ceil((job.lastTickMs + world.tickSeconds * 1000) / 1000)
        : null,
      // Anchored to the job's creation and its *original* size, not to
      // `remaining`. The simulation drains the queue about 86,400x faster than
      // the real worker, so anything derived from live progress collapses to
      // "within a day" within seconds of the card appearing — contradicting
      // the estimate the offer dialog quoted a moment earlier. Holding it
      // steady is what a real 28-day job looks like over a demo session.
      estimatedCompletionSec: job.state === 'completed'
        ? Math.floor(job.completedAtMs / 1000)
        : Math.floor(job.createdAtMs / 1000)
          + Math.ceil((job.totalTracks / WORKER_TRACKS_PER_DAY) * 86400),
      createdAt: Math.floor(job.createdAtMs / 1000),
      completedAt: job.completedAtMs ? Math.floor(job.completedAtMs / 1000) : null,
      // Fourteen days out, so the status card never renders its expiry warning
      // by accident.
      credentialExpiresAt: nowSec + 14 * 86400,
      inactivityDeadline: PARKED.includes(job.state) ? job.inactivityDeadlineSec : null,
      dormantFrom: job.state === 'dormant' ? (job.dormantFrom ?? null) : null,
      ...(KEYLESS.includes(job.state) ? { reconnectAvailable: reconnectAvailable() } : {}),
    };
  }

  const json = (body, status = 200) => ({
    status,
    contentType: 'application/json',
    headers: CORS,
    body: JSON.stringify(body),
  });

  function handleCapacity() {
    return json({
      available: world.capacityAvailable && !isLive(),
      used: isLive() ? 1 : 0,
      capacity: 50,
      minTracks: MIN_TRACKS,
      maxTracks: options.maxTracks || MAX_TRACKS,
      chunkTracks: CHUNK_TRACKS,
    });
  }

  function handleImport(importId) {
    const rec = world.imports.get(importId);
    if (!rec) {
      /*
        The real worker also counts a jobless handoff still on its way
        (preflighted, not yet authorised) and says it is only `pending`; one
        that has failed never had the queue (#162). A named one holds the
        user's `live_username`, so it reads as live.
      */
      const inFlight = [...world.handoffs.values()].reverse().find((h) => h.importId === importId
        && !h.jobId && IN_FLIGHT_HANDOFF.includes(h.state || 'issued'));
      if (inFlight) {
        return json({
          ok: true,
          known: true,
          live: !!inFlight.named,
          state: inFlight.state || 'issued',
          cursor: 0,
          scrobbledCount: 0,
          totalTracks: inFlight.trackCount,
          pending: true,
        });
      }
      return json({
        ok: true, known: false, live: false, cursor: 0, scrobbledCount: 0, totalTracks: 0,
      });
    }
    const mine = !!world.job && world.job.importId === importId;
    const scrobbled = mine ? Math.floor(world.job.scrobbled) : rec.trackCount;
    return json({
      ok: true,
      known: true,
      live: mine && isSending(),
      state: mine ? world.job.state : 'completed',
      cursor: scrobbled,
      scrobbledCount: scrobbled,
      totalTracks: rec.trackCount,
    });
  }

  function handlePreflight(body) {
    if (Number(body.trackCount) < MIN_TRACKS) {
      return json({ ok: false, reason: 'too_small' }, 400);
    }
    const named = String(body.username || '');
    if (!named && isLive()) {
      // The real worker only learns who an anonymous handoff belongs to at the
      // callback, so it accepts the preflight and fails the return.
      const refusedId = `h-${hex(16)}`;
      world.handoffs.set(refusedId, {
        state: 'issued',
        named: false,
        username: '',
        trackCount: Number(body.trackCount) || 0,
        importId: String(body.importId || ''),
        chunksSeen: new Set(),
        session: '',
        jobId: '',
      });
      return json({
        ok: true,
        handoffId: refusedId,
        authoriseUrl: `${appOrigin}/mock-auth?fail=already_live&handoff=${refusedId}`,
      });
    }
    if (isLive()) {
      return json({ ok: false, reason: 'already_running' }, 409);
    }
    const handoffId = `h-${hex(16)}`;
    const session = `s-${hex(24)}`;
    world.handoffs.set(handoffId, {
      state: 'issued',
      named: !!named,
      username: named || lastFmUser,
      trackCount: Number(body.trackCount) || 0,
      importId: String(body.importId || ''),
      chunksSeen: new Set(),
      session,
      jobId: '',
    });
    if (verbose) {
      console.log(`[worker-mock] preflight: ${body.trackCount} tracks, handoff ${handoffId}`);
    }
    if (world.authoriseFail) {
      // Last.fm (or the callback) refuses this one: see `authorise`.
      return json({
        ok: true,
        handoffId,
        authoriseUrl: `${appOrigin}/mock-auth?handoff=${handoffId}&fail=${encodeURIComponent(world.authoriseFail)}`,
      });
    }
    // Points at the shim rather than Last.fm. See the header.
    const adopted = named ? '' : `&user=${encodeURIComponent(lastFmUser)}`;
    return json({
      ok: true,
      handoffId,
      authoriseUrl: `${appOrigin}/mock-auth?handoff=${handoffId}&session=${session}${adopted}`,
    });
  }

  function handleFinalize(handoffId, nowMs) {
    const rec = world.handoffs.get(handoffId);
    if (!rec) {
      return json({ ok: false, reason: 'unknown_handoff' }, 404);
    }
    if (!rec.jobId) {
      rec.jobId = `j-${hex(16)}`;
      rec.state = 'active';
      world.job = {
        id: rec.jobId,
        username: rec.username,
        importId: rec.importId,
        state: 'active',
        reason: null,
        totalTracks: rec.trackCount,
        scrobbled: 0,
        failed: 0,
        waitingUntil: null,
        createdAtMs: nowMs,
        lastTickMs: nowMs,
        completedAtMs: null,
        inactivityDeadlineSec: null,
        exportClaim: '',
      };
      if (rec.importId) {
        world.imports.set(rec.importId, { trackCount: rec.trackCount, jobId: rec.jobId });
      }
      if (verbose) {
        console.log(`[worker-mock] job ${rec.jobId} is live with ${rec.trackCount} tracks`);
      }
    }
    return json({ ok: true, jobId: rec.jobId });
  }

  function handleHandoffStatus(handoffId) {
    const rec = world.handoffs.get(handoffId);
    if (!rec) {
      // A handoff the server has never heard of is definitively resolved:
      // nothing was ever taken on, so the browser may resume.
      return json({
        ok: true, active: false, resolved: true, jobId: '',
      });
    }
    return json({
      ok: true,
      active: !!rec.jobId && isLive(),
      resolved: !!rec.jobId && !isLive(),
      jobId: rec.jobId,
    });
  }

  function handleExport(body, nowMs) {
    const { job } = world;
    // As in the worker, an export under way can only be re-entered with its
    // own claim until that claim lapses.
    if (job.state === 'exporting' && job.exportClaim && body.claim !== job.exportClaim) {
      return json({ ok: false, reason: 'not_quiescent', detail: 'not_claimable' }, 409);
    }
    const scrobbled = Math.floor(job.scrobbled);
    const remaining = Math.max(0, job.totalTracks - scrobbled - job.failed);
    setState(job, 'exporting', nowMs);
    job.exportClaim = String(body.claim || '');
    if (verbose) {
      console.log(`[worker-mock] export: ${remaining} back, ${scrobbled} already sent`);
    }
    return json({
      ok: true,
      state: {
        tracks: syntheticTracks(remaining),
        totalTracks: remaining,
        completedIndices: [],
        failedIndices: [],
      },
      scrobbledByServer: scrobbled,
      failures: [],
      repeats: [],
      uncertainCount: 0,
      syntheticFloorSec: Math.floor(nowMs / 1000),
      usedRanges: [],
      usedRangesIncomplete: false,
      usedRangesFloorSec: 0,
    });
  }

  function handleJobAction(jobId, action, body, nowMs) {
    const { job } = world;
    if (!job || job.id !== jobId) {
      return json({ ok: false, reason: 'unknown_job' }, 404);
    }
    if (action === 'pause') {
      // The worker pauses only a job that is sending.
      if (job.state === 'active') {
        setState(job, 'paused', nowMs);
      }
      return json({ ok: true });
    }
    if (action === 'resume') {
      if (job.state === 'paused' || job.state === 'needs_attention') {
        setState(job, 'active', nowMs);
      }
      return json({ ok: true });
    }
    if (action === 'cancel') {
      // The real worker refuses a cancel presented without the claim that made
      // the export snapshot true. Mirrored, because take-back reads a refusal
      // here as "the server still owns the queue".
      if (job.state === 'exporting' && job.exportClaim && body.claim !== job.exportClaim) {
        return json({ ok: false, reason: 'export_in_progress' }, 409);
      }
      setState(job, 'cancelled', nowMs);
      return json({ ok: true });
    }
    return handleExport(body, nowMs);
  }

  function handle(method, path, query, bodyText) {
    const nowMs = Date.now();
    advance(nowMs);

    if (method === 'OPTIONS') {
      return { status: 204, headers: CORS, body: '' };
    }

    if (path === '/scrobblify/capacity' && method === 'GET') {
      return handleCapacity();
    }

    // Public, and deliberately so — this is the one ownership question a
    // browser that has lost its session can still ask. A named handoff on its
    // way holds its user's `live_username` from preflight, as in the real
    // worker, so an unapproved one reads as live until withdrawn (#164).
    if (path === '/scrobblify/job/live' && method === 'GET') {
      const username = (query.get('username') || '').trim().toLowerCase();
      const handoffLive = [...world.handoffs.values()].some((h) => h.named && !h.jobId
        && IN_FLIGHT_HANDOFF.includes(h.state || 'issued')
        && String(h.username).toLowerCase() === username);
      return json({
        ok: true,
        live: (isSending() && String(world.job.username).toLowerCase() === username) || handoffLive,
      });
    }

    // Public: the browser coming back without approving has no session. Only
    // a handoff nobody has approved yet can be withdrawn.
    const abandonMatch = path.match(/^\/scrobblify\/handoff\/([\w-]+)\/abandon$/);
    if (abandonMatch && method === 'POST') {
      const rec = world.handoffs.get(abandonMatch[1]);
      const abandoned = !!rec && !rec.jobId && !rec.approved && (rec.state || 'issued') === 'issued';
      if (abandoned) {
        rec.state = 'failed';
        rec.failureReason = 'abandoned';
      }
      return json({ ok: true, abandoned });
    }

    // Public for the same reason, plus the import id *is* the credential.
    const importMatch = path.match(/^\/scrobblify\/import\/([\w-]+)$/);
    if (importMatch && method === 'GET') {
      return handleImport(importMatch[1]);
    }

    if (path === '/scrobblify/handoff/preflight' && method === 'POST') {
      return handlePreflight(JSON.parse(bodyText || '{}'));
    }

    const chunkMatch = path.match(/^\/scrobblify\/handoff\/([\w-]+)\/chunk\/(\d+)$/);
    if (chunkMatch && method === 'PUT') {
      const rec = world.handoffs.get(chunkMatch[1]);
      if (!rec) {
        return json({ ok: false, reason: 'unknown_handoff' }, 404);
      }
      rec.chunksSeen.add(Number(chunkMatch[2]));
      return json({ ok: true });
    }

    const finalizeMatch = path.match(/^\/scrobblify\/handoff\/([\w-]+)\/finalize$/);
    if (finalizeMatch && method === 'POST') {
      return handleFinalize(finalizeMatch[1], nowMs);
    }

    const statusMatch = path.match(/^\/scrobblify\/handoff\/([\w-]+)$/);
    if (statusMatch && method === 'GET') {
      return handleHandoffStatus(statusMatch[1]);
    }

    if (path === '/scrobblify/job' && method === 'GET') {
      return json({ ok: true, job: jobView() });
    }

    const actionMatch = path.match(/^\/scrobblify\/job\/([\w-]+)\/(pause|resume|cancel|export)$/);
    if (actionMatch && method === 'POST') {
      return handleJobAction(
        actionMatch[1],
        actionMatch[2],
        bodyText ? JSON.parse(bodyText) : {},
        nowMs,
      );
    }

    if (path === '/scrobblify/auth/signin' && method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      const nonce = encodeURIComponent(body.nonce || '');
      // A sign-in that named nobody adopts whoever authorises, and the real
      // worker names them in the return.
      const adopted = body.username ? '' : `&user=${encodeURIComponent(lastFmUser)}`;
      // The real worker re-attaches in the sign-in *callback*; the shim has no
      // server side, so it happens here instead. Same outcome either way: back
      // to sending, or to `paused` for a job the user had paused.
      const { job } = world;
      if (job && KEYLESS.includes(job.state) && reconnectAvailable()) {
        setState(job, job.state === 'dormant' && job.dormantFrom === 'paused' ? 'paused' : 'active', nowMs);
        job.dormantFrom = null;
      }
      return json({
        ok: true,
        authoriseUrl: `${appOrigin}/mock-auth?session=s-${hex(24)}&nonce=${nonce}${adopted}`,
      });
    }

    // Mock only: puts the current job into any state, so every status card
    // can be looked at without waiting 14 days. Not a worker route.
    if (path === '/scrobblify/__mock/job' && method === 'POST') {
      const body = JSON.parse(bodyText || '{}');
      if (!world.job) {
        return json({ ok: false, reason: 'no_job' }, 404);
      }
      if (typeof body.capacityAvailable === 'boolean') {
        world.capacityAvailable = body.capacityAvailable;
      }
      if (body.state) {
        setState(world.job, String(body.state), nowMs);
      }
      if (body.dormantFrom !== undefined) {
        world.job.dormantFrom = body.dormantFrom === null ? null : String(body.dormantFrom);
      }
      return json({ ok: true, job: jobView() });
    }

    return json({ ok: false, reason: 'not_found' }, 404);
  }

  /**
   * The `/mock-auth` shim page for a URL's query, standing in for Last.fm and
   * the worker's callback. A `fail` return fails the handoff it names, as the
   * real callback does, so it no longer counts in `/import/:id`. An approval
   * of a handoff that has already failed (withdrawn, say) is refused the way
   * the real callback refuses it, and makes no job (#165); any other approval
   * puts it past withdrawing.
   */
  function authorise(searchParams) {
    const fail = searchParams.get('fail') || '';
    const rec = world.handoffs.get(searchParams.get('handoff') || '');
    if (!fail && rec && rec.state === 'failed') {
      return shimHtml('', '', '', rec.failureReason === 'abandoned' ? 'abandoned' : 'exchange_failed');
    }
    if (fail && rec && !rec.jobId) {
      rec.state = 'failed';
    } else if (rec) {
      rec.approved = true;
    }
    return shimFromQuery(searchParams);
  }

  return {
    world, handle, authorise, apiOrigin, appOrigin,
  };
}

/**
 * Installs the mock. Call before any navigation, like `interceptLastFm`.
 *
 * Returns the mock so a caller can drive the simulation — flipping
 * `world.capacityAvailable`, changing `world.rate`, or forcing a state with
 * `setState(world.job, 'dormant', Date.now())`. Under `dev:mock:bg` the same is
 * reachable over HTTP: `POST /mock/worker/scrobblify/__mock/job` with
 * `{"state":"dormant","capacityAvailable":false}`.
 */
async function interceptBackgroundWorker(page, options = {}) {
  const mock = createMockWorker(options);

  await page.route(`${mock.apiOrigin}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    let bodyText = '';
    try {
      bodyText = req.postData() || '';
    } catch (e) {
      // A binary chunk upload has no text form. Nothing here reads it.
      bodyText = '';
    }
    await route.fulfill(mock.handle(
      req.method(),
      url.pathname.replace(/\/+$/, ''),
      url.searchParams,
      bodyText,
    ));
  });

  await page.route(`${mock.appOrigin}/mock-auth*`, async (route) => {
    const url = new URL(route.request().url());
    await route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: mock.authorise(url.searchParams),
    });
  });

  return mock;
}

module.exports = {
  interceptBackgroundWorker,
  createMockWorker,
  setState,
  shimHtml,
  shimFromQuery,
  MIN_TRACKS,
  MAX_TRACKS,
  DEFAULT_API_ORIGIN,
  DEFAULT_APP_ORIGIN,
};
