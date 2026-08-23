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

const DEFAULT_API_ORIGIN = 'http://localhost:8787';
const DEFAULT_APP_ORIGIN = 'http://localhost:8080';

// Must match `MIN_TRACKS_FOR_BACKGROUND` in worker/src/api.ts and
// ScrobbleStep.vue: below it the client never offers the handoff and the
// worker rejects the preflight outright.
const MIN_TRACKS = 2700;
const MAX_TRACKS = 2700 * 60;
const CHUNK_TRACKS = 1000;

// The rate the *real* worker paces at, and the only thing the completion
// estimate may be derived from. The simulation deliberately runs ~86,400x
// faster than this so the progress bar visibly moves, but reusing that speed
// for the ETA made a 28-day job report "Should finish within a day" — the
// status card would contradict the offer dialog the user had just read.
const WORKER_TRACKS_PER_DAY = 2700;

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
 */
function shimHtml(session, handoffId) {
  const setHandoff = handoffId
    ? `localStorage.setItem('scrobblify.background.handoff', ${JSON.stringify(handoffId)});`
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
  } catch (e) { /* the app reports the failure for us */ }
  location.replace(${JSON.stringify(back)});
</script>
</body></html>`;
}

/**
 * Builds one mock worker.
 *
 * The world lives in this closure rather than being passed around, so no
 * handler mutates something it was handed.
 *
 * `rate` is the only knob that matters in practice. The real worker manages
 * about 2,700 scrobbles a day; at that speed nothing visibly moves, so this
 * defaults to a few dozen a second and the status card animates. It drives
 * the progress bar only — the completion estimate uses the real rate, so the
 * card's ETA still matches the one the offer dialog quoted.
 */
function createMockWorker(options = {}) {
  const apiOrigin = options.apiOrigin || DEFAULT_API_ORIGIN;
  // An explicit empty string is a *relative* origin, which is what the dev
  // server's middleware wants so the authorise URL works from whatever host
  // the browser used. `||` would treat it as "unset" and silently hand back
  // localhost:8080 — the port the Playwright suite runs on.
  const appOrigin = options.appOrigin === undefined ? DEFAULT_APP_ORIGIN : options.appOrigin;
  const verbose = options.log !== false;

  const world = {
    rate: options.rate || 40,
    capacityAvailable: options.capacityAvailable !== false,
    handoffs: new Map(),
    imports: new Map(),
    job: null,
  };

  /**
   * Advances the simulated job to `nowMs`.
   *
   * Called at the top of every request rather than on a timer: the client only
   * ever observes the job through these endpoints, so there is nothing a timer
   * could do that a read cannot — and no interval to leak when the page shuts.
   */
  function advance(nowMs) {
    const { job } = world;
    if (!job || job.state !== 'active') {
      return;
    }
    const elapsedSec = (nowMs - job.lastTickMs) / 1000;
    job.lastTickMs = nowMs;
    job.scrobbled = Math.min(job.totalTracks, job.scrobbled + elapsedSec * world.rate);
    if (job.scrobbled >= job.totalTracks) {
      job.scrobbled = job.totalTracks;
      job.state = 'completed';
      job.completedAtMs = nowMs;
    }
  }

  function isLive() {
    return !!world.job && !TERMINAL.includes(world.job.state);
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
      maxTracks: MAX_TRACKS,
      chunkTracks: CHUNK_TRACKS,
    });
  }

  function handleImport(importId) {
    const rec = world.imports.get(importId);
    if (!rec) {
      return json({
        ok: true, known: false, live: false, cursor: 0, scrobbledCount: 0, totalTracks: 0,
      });
    }
    const mine = !!world.job && world.job.importId === importId;
    const scrobbled = mine ? Math.floor(world.job.scrobbled) : rec.trackCount;
    return json({
      ok: true,
      known: true,
      live: mine && isLive(),
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
    if (isLive()) {
      return json({ ok: false, reason: 'already_running' }, 409);
    }
    const handoffId = `h-${hex(16)}`;
    const session = `s-${hex(24)}`;
    world.handoffs.set(handoffId, {
      username: String(body.username || ''),
      trackCount: Number(body.trackCount) || 0,
      importId: String(body.importId || ''),
      chunksSeen: new Set(),
      session,
      jobId: '',
    });
    if (verbose) {
      console.log(`[worker-mock] preflight: ${body.trackCount} tracks, handoff ${handoffId}`);
    }
    // Points at the shim rather than Last.fm. See the header.
    return json({
      ok: true,
      handoffId,
      authoriseUrl: `${appOrigin}/mock-auth?handoff=${handoffId}&session=${session}`,
    });
  }

  function handleFinalize(handoffId, nowMs) {
    const rec = world.handoffs.get(handoffId);
    if (!rec) {
      return json({ ok: false, reason: 'unknown_handoff' }, 404);
    }
    if (!rec.jobId) {
      rec.jobId = `j-${hex(16)}`;
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
    const scrobbled = Math.floor(job.scrobbled);
    const remaining = Math.max(0, job.totalTracks - scrobbled - job.failed);
    job.state = 'exporting';
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
      if (!TERMINAL.includes(job.state)) {
        job.state = 'paused';
      }
      return json({ ok: true });
    }
    if (action === 'resume') {
      if (job.state === 'paused' || job.state === 'needs_attention') {
        job.state = 'active';
        job.lastTickMs = nowMs;
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
      job.state = 'cancelled';
      job.completedAtMs = nowMs;
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
    // browser that has lost its session can still ask.
    if (path === '/scrobblify/job/live' && method === 'GET') {
      const username = query.get('username') || '';
      return json({ ok: true, live: isLive() && world.job.username === username });
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
      return json({
        ok: true,
        authoriseUrl: `${appOrigin}/mock-auth?session=s-${hex(24)}&nonce=${nonce}`,
      });
    }

    return json({ ok: false, reason: 'not_found' }, 404);
  }

  return {
    world, handle, apiOrigin, appOrigin,
  };
}

/**
 * Installs the mock. Call before any navigation, like `interceptLastFm`.
 *
 * Returns the mock so a caller can drive the simulation — flipping
 * `world.capacityAvailable`, changing `world.rate`, or forcing
 * `world.job.state` to `needs_reauth` to look at the reconnect card.
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
      body: shimHtml(url.searchParams.get('session') || '', url.searchParams.get('handoff') || ''),
    });
  });

  return mock;
}

module.exports = {
  interceptBackgroundWorker,
  createMockWorker,
  shimHtml,
  MIN_TRACKS,
  DEFAULT_API_ORIGIN,
  DEFAULT_APP_ORIGIN,
};
