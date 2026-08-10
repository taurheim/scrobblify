/**
 * HTTP surface.
 *
 * Routing only: every endpoint delegates to `handoff.ts`, `chunks.ts` or
 * `store.ts`. The rule that keeps this safe is that the worker exposes **no
 * generic Last.fm proxy** — nothing here can scrobble an arbitrary track. The
 * only tracks that ever reach Last.fm are the ones already committed to a
 * job's write-once blob.
 */
import { Sql, JobRow, readControl, countCommittedSlots, abandonedSeconds } from './store';
import {
  BlobStore, uploadChunk, deleteJobBlobs, readChunkFor, CHUNK_TRACKS,
} from './chunks';
import { LastFmClient } from './lastfm';
import {
  preflight,
  handleCallback,
  finalize,
  reapExpiredHandoffs,
  HandoffRow,
  MAX_TRACKS_PER_JOB,
  CREDENTIAL_TTL_SECONDS,
} from './handoff';
import { issueSession, authenticate } from './session';
import { drainJobOnDemand } from './scheduler';
import {
  normalizeUsername, randomId, signHandoffState, verifyHandoffState, encryptCredential,
} from './crypto';

/** Remaining tracks below which background mode is not worth the trade-offs. */
export const MIN_TRACKS_FOR_BACKGROUND = 2700;

/**
 * Lifetime of a re-authentication state. Short: it exists only to survive one
 * round trip through Last.fm, and it is not tied to a row that could expire it.
 */
const SIGNIN_TTL_SECONDS = 900;

/**
 * Shortest import id `/scrobblify/import/:id` will answer about.
 *
 * The route is public because the id itself is the capability, which only
 * holds while the id is unguessable. The client mints 128 bits; this floor
 * exists so a client that gets that wrong — or a hand-typed probe — is refused
 * rather than turning a capability lookup into an enumeration endpoint.
 */
const MIN_IMPORT_ID_LENGTH = 16;

/**
 * How long a take-back holds a job in `exporting` before it reverts to
 * `paused`. Long enough for a client to read a large export and cancel;
 * short enough that an abandoned take-back does not park a job for hours.
 */
const EXPORT_CLAIM_SECONDS = 600;

/**
 * How many used-timestamp ranges an export will carry.
 *
 * The descending allocator produces dense runs, so this is generous in
 * practice. Exceeding it is reported rather than hidden, because a client that
 * believes an incomplete list is complete will allocate straight into a gap it
 * was never told about.
 */
const MAX_EXPORTED_RANGES = 512;

/**
 * Collapses unix seconds into inclusive ranges.
 *
 * Returns `truncated` when the ranges did not fit, in which case the caller
 * must treat the list as a lower bound on what was used.
 */
export function collapseToRanges(
  seconds: number[],
  limit: number,
): { ranges: { from: number; to: number }[]; truncated: boolean } {
  if (seconds.length === 0) {
    return { ranges: [], truncated: false };
  }
  const sorted = Array.from(new Set(seconds)).sort((a, b) => a - b);
  const ranges: { from: number; to: number }[] = [];
  let from = sorted[0];
  let to = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === to + 1) {
      to = sorted[i];
    } else {
      ranges.push({ from, to });
      from = sorted[i];
      to = sorted[i];
    }
  }
  ranges.push({ from, to });
  if (ranges.length <= limit) {
    return { ranges, truncated: false };
  }
  /*
    Truncated from the *bottom*, keeping the highest ranges.

    This was the other way round, justified by the client reserving below
    everything it knew about — true of the allocator that existed when this was
    written, which only ever needed the single lowest bound. The client now
    searches for a free gap walking *down* from the present, so the ranges it
    collides with first are the highest ones, and dropping those handed it a
    list whose most relevant entries were missing.

    Keeping the top also makes truncation recoverable rather than fatal. Every
    discarded range now lies strictly below the lowest one kept, so the region
    above that is completely described: a client can bound its search there and
    still be certain, instead of abandoning the reservation entirely. The
    lowest kept `from` is returned as `usedRangesFloorSec` for exactly that.
  */
  return { ranges: ranges.slice(ranges.length - limit), truncated: true };
}

export interface ApiEnv {
  sql: Sql;
  blobs: BlobStore;
  lastfm: LastFmClient;
  signingKey: string;
  credentialSecret: string;
  /** Where the Last.fm callback lands, e.g. https://api.savas.ca/scrobblify/auth/callback */
  callbackUrl: string;
  /** Where the user is sent back to, e.g. https://savas.ca/scrobble */
  appUrl: string;
  /** The worker's own Last.fm API key, for building authorise URLs. */
  lastfmApiKey: string;
  now(): number;
}

/**
 * CORS. The SPA is on a different origin, so this is required rather than
 * optional. `Authorization` is allow-listed because sessions are bearer
 * tokens; `Access-Control-Allow-Credentials` is deliberately absent, since
 * nothing here relies on cookies.
 */
function corsHeaders(env: ApiEnv): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': new URL(env.appUrl).origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Chunk-Digest',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(env: ApiEnv, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(env),
    },
  });
}

/**
 * The Last.fm authorise URL for the *worker's* application.
 *
 * `cb` must be URL-encoded. An unencoded `&` lets our signed state bind to
 * Last.fm's own URL parameters and vanish, and the callback then arrives with
 * no state at all.
 */
function authoriseUrl(env: ApiEnv, state: string): string {
  const cb = `${env.callbackUrl}?state=${encodeURIComponent(state)}`;
  return `https://www.last.fm/api/auth/?api_key=${encodeURIComponent(env.lastfmApiKey)}`
    + `&cb=${encodeURIComponent(cb)}`;
}

/**
 * Gives a job parked in `needs_reauth` a working write credential again.
 *
 * The only path in the system that can. `needs_reauth` is entered when the
 * stored key is gone or has been revoked, and it clears `live_username`, so
 * the job cannot send and is not resumable — the user's alternatives are a
 * take-back (which abandons any batch still in flight, risking duplicates) or
 * a cancel (which discards the queue). The status card has always told them to
 * reconnect Last.fm; this is what makes that true.
 *
 * Best effort, and silent. Signing in must succeed even when the re-attach
 * cannot: this is a bonus on a flow whose actual job is to prove identity, and
 * failing the sign-in would strand the user worse than the parked job does.
 *
 * Restored to `paused` rather than `active` so continuing stays the user's
 * explicit choice, and because `paused` is what the status card offers a
 * Resume button for.
 */
async function reattachCredential(
  env: ApiEnv,
  username: string,
  sessionKey: string,
  nowSec: number,
): Promise<void> {
  try {
    const job = await env.sql.first<JobRow>(
      `SELECT * FROM jobs WHERE username = ? AND state = 'needs_reauth'
        ORDER BY created_at DESC LIMIT 1`,
      [username],
    );
    if (!job) { return; }
    /*
      `live_username` carries a unique index, so a job started since this one
      was parked already owns the slot. Taking it would fail the write; racing
      it would give one user two sending jobs over the same account. The parked
      job stays parked and its tracks stay recoverable by take-back.
    */
    const slotHeld = await env.sql.first<{ n: number }>(
      `SELECT 1 AS n FROM jobs WHERE live_username = ?
        UNION ALL
       SELECT 1 AS n FROM handoffs WHERE live_username = ?
        LIMIT 1`,
      [username, username],
    );
    if (slotHeld) { return; }
    const credential = await encryptCredential(sessionKey, env.credentialSecret, job.id);
    /*
      Conditioned on the state it was read in. A tick may have moved this job
      between the read and here — to `cancelled`, or to `exporting` for a
      take-back that is reading the queue out — and attaching a live credential
      to either would resurrect a job the user has finished with.

      Refused outright while a lease is held. A drain acquired for a take-back
      is running against the snapshot it read, and its batch writes are not
      fenced; clearing `locked_until` under it would let a job it is still
      abandoning batches for be resumed by another tab. The user can press
      Reconnect again a moment later, which is a far smaller problem.

      The lifetime is renewed, not inherited. The commonest way into
      `needs_reauth` is the 60-day deadline passing, and a fresh key under an
      expired deadline is re-parked by the very next tick — the user reconnects,
      resumes, and is parked again before a single track is sent, forever. The
      key really is new, so the clock really does start again.
    */
    const updated = await env.sql.run(
      `UPDATE jobs
          SET session_key_ct = ?, session_key_iv = ?, live_username = ?,
              state = 'paused', state_reason = NULL, consecutive_failures = 0,
              credential_expires_at = ?,
              next_eligible_at = ?, locked_until = 0, updated_at = ?
        WHERE id = ? AND state = 'needs_reauth' AND locked_until <= ?`,
      [
        credential.ciphertext,
        credential.iv,
        username,
        nowSec + CREDENTIAL_TTL_SECONDS,
        nowSec,
        nowSec,
        job.id,
        nowSec,
      ],
    );
    if (updated.changes > 0) {
      await env.sql.run(
        'INSERT INTO audit (id, job_id, generation, event, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [randomId(), job.id, job.generation, 'credential_reattached', null, nowSec],
      );
    }
  } catch {
    // Never at the cost of the sign-in itself; see above.
  }
}

async function liveJobFor(sql: Sql, username: string): Promise<JobRow | null> {
  return sql.first<JobRow>(
    'SELECT * FROM jobs WHERE live_username = ? LIMIT 1',
    [normalizeUsername(username)],
  );
}

/**
 * The user-facing view of a job.
 *
 * The completion estimate is not decoration. Without "expect to finish around
 * 1 September", a user watching a 37-day job concludes it is broken and
 * re-imports — which is the duplicate-generating behaviour this whole feature
 * exists to prevent.
 */
function describeJob(job: JobRow, nowSec: number) {
  const remaining = Math.max(0, job.total_tracks - job.cursor);
  const perDay = 2700;
  const daysLeft = remaining / perDay;
  return {
    id: job.id,
    state: job.state,
    reason: (job as any).state_reason ?? null,
    totalTracks: job.total_tracks,
    scrobbled: job.scrobbled_count,
    failed: job.failed_count,
    remaining,
    waitingUntil: job.next_eligible_at > nowSec ? job.next_eligible_at : null,
    estimatedCompletionSec: job.state === 'completed'
      ? job.completed_at
      : nowSec + Math.ceil(daysLeft * 86400),
    createdAt: job.created_at,
    completedAt: job.completed_at,
    credentialExpiresAt: job.credential_expires_at,
  };
}

async function readJson(request: Request): Promise<any | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function handleRequest(env: ApiEnv, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '');
  const nowSec = env.now();

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }

  // ---- capacity, so the SPA can decide whether to offer the option at all ----
  if (path === '/scrobblify/capacity' && request.method === 'GET') {
    const control = await readControl(env.sql);
    const used = await countCommittedSlots(env.sql);
    return json(env, {
      available: !control.paused && !control.halted && used < control.max_concurrent_jobs,
      used,
      capacity: control.max_concurrent_jobs,
      minTracks: MIN_TRACKS_FOR_BACKGROUND,
      maxTracks: MAX_TRACKS_PER_JOB,
      chunkTracks: CHUNK_TRACKS,
    });
  }

  // ---- step 0: preflight, before the redirect ----
  if (path === '/scrobblify/handoff/preflight' && request.method === 'POST') {
    const body = await readJson(request);
    if (!body || typeof body.username !== 'string' || typeof body.payloadDigest !== 'string') {
      return json(env, { ok: false, reason: 'bad_request' }, 400);
    }
    if (Number(body.trackCount) < MIN_TRACKS_FOR_BACKGROUND) {
      return json(env, { ok: false, reason: 'too_small' }, 400);
    }
    const result = await preflight(
      env.sql,
      {
        username: body.username,
        payloadDigest: body.payloadDigest,
        trackCount: Number(body.trackCount),
        chunkCount: Number(body.chunkCount),
        declaredBytes: Number(body.declaredBytes),
        // Validated rather than trusted: it is echoed back by a public route,
        // and the same character class the route's path pattern accepts is the
        // only thing that can round-trip through it.
        importId: typeof body.importId === 'string'
          && /^[\w-]{16,128}$/.test(body.importId)
          ? body.importId
          : null,
      },
      env.signingKey,
      env.callbackUrl,
      nowSec,
    );
    if (!result.ok) {
      return json(env, result, result.reason === 'at_capacity' ? 503 : 409);
    }
    return json(env, {
      ok: true,
      handoffId: result.handoffId,
      authoriseUrl: authoriseUrl(env, result.state),
    });
  }

  // ---- re-authentication, for a browser session that has expired ----
  //
  // Without this a user whose bearer token aged out cannot ask whether a job
  // is running, and the client — which refuses to resume on an unanswered
  // ownership question — leaves them permanently unable to scrobble anywhere.
  //
  // It reserves no slot and creates no job. The Last.fm session key its
  // callback receives is discarded, not stored: proving who you are is all
  // this flow needs.
  if (path === '/scrobblify/auth/signin' && request.method === 'POST') {
    const body = await readJson(request);
    if (!body || typeof body.username !== 'string' || !body.username.trim()) {
      return json(env, { ok: false, reason: 'bad_request' }, 400);
    }
    // The nonce binds the return to the browser that started it. Without it
    // the callback URL is a bearer credential usable anywhere, so an attacker
    // could sign in as themselves and hand the finished link to a victim.
    if (typeof body.nonce !== 'string' || body.nonce.length < 16) {
      return json(env, { ok: false, reason: 'bad_request' }, 400);
    }
    const state = await signHandoffState(
      {
        h: '',
        exp: nowSec + SIGNIN_TTL_SECONDS,
        k: 'signin',
        u: normalizeUsername(body.username),
        n: body.nonce,
      },
      env.signingKey,
    );
    return json(env, { ok: true, authoriseUrl: authoriseUrl(env, state) });
  }

  // ---- step 2/3: Last.fm returns the user here ----
  if (path === '/scrobblify/auth/callback' && request.method === 'GET') {
    const stateParam = url.searchParams.get('state') ?? '';
    const tokenParam = url.searchParams.get('token') ?? '';

    // Signin states are handled before `handleCallback`, which assumes every
    // state owns a handoff row.
    const signinState = await verifyHandoffState(stateParam, env.signingKey, nowSec);
    if (signinState && signinState.k === 'signin') {
      const target = new URL(env.appUrl);
      if (!tokenParam) {
        target.searchParams.set('signin', 'failed');
        return Response.redirect(target.toString(), 302);
      }
      let identity: { sessionKey: string; username: string };
      try {
        identity = await env.lastfm.getSession(tokenParam);
      } catch {
        target.searchParams.set('signin', 'failed');
        return Response.redirect(target.toString(), 302);
      }
      // The username is checked even though nothing is written: issuing a
      // session for whoever happened to authorise would hand one account
      // read access to another's job status.
      if (!signinState.u || normalizeUsername(identity.username) !== signinState.u) {
        target.searchParams.set('signin', 'failed');
        return Response.redirect(target.toString(), 302);
      }
      const session = await issueSession(normalizeUsername(identity.username), env.signingKey, nowSec);
      /*
        A job parked for re-authentication gets its write credential back here.

        This flow otherwise discards the session key on purpose, and that is
        still the rule for every other case: proving who you are needs no
        ability to write. But `needs_reauth` exists precisely because the
        stored key is gone or revoked, and nothing else in the system can
        supply a new one — so without this the UI's "reconnect Last.fm"
        promised a recovery that did not exist. The job could then only be
        taken back, which abandons any batch still in flight and risks
        duplicating it, or cancelled, which discards the queue.

        Narrow by construction: the username on the state has already been
        checked against what `auth.getSession` returned, so the key can only
        ever be attached to its own owner's job.
      */
      await reattachCredential(env, normalizeUsername(identity.username), identity.sessionKey, nowSec);
      target.searchParams.set('signin', 'ok');
      // The nonce is echoed back so the initiating browser can prove this
      // return is its own. It travels in the fragment with the token, so it
      // never reaches a server log.
      target.hash = `session=${encodeURIComponent(session)}&nonce=${encodeURIComponent(signinState.n ?? '')}`;
      return Response.redirect(target.toString(), 302);
    }

    const result = await handleCallback(
      env.sql,
      env.lastfm,
      { state: stateParam, token: tokenParam },
      env.signingKey,
      env.credentialSecret,
      nowSec,
    );

    const target = new URL(env.appUrl);
    if (!result.ok) {
      target.searchParams.set('handoff', 'failed');
      target.searchParams.set('reason', result.reason);
      return Response.redirect(target.toString(), 302);
    }

    // The session is issued for the username on the handoff row, which
    // `handleCallback` has already checked against what `auth.getSession`
    // returned. Trusting anything else here would hand one account a session
    // for another's job.
    const row = await env.sql.first<HandoffRow>(
      'SELECT * FROM handoffs WHERE id = ?', [result.handoffId],
    );
    if (!row) {
      target.searchParams.set('handoff', 'failed');
      target.searchParams.set('reason', 'unknown');
      return Response.redirect(target.toString(), 302);
    }

    // The token goes in the fragment, not the query string. Fragments are not
    // sent to servers, not written to access logs, and not leaked in
    // `Referer` — which matters because this one authorises reading a
    // complete listening history.
    const session = await issueSession(row.username, env.signingKey, nowSec);
    target.searchParams.set('handoff', 'ok');
    target.searchParams.set('job', result.jobId);
    target.hash = `session=${encodeURIComponent(session)}&handoff=${encodeURIComponent(result.handoffId)}`;
    return Response.redirect(target.toString(), 302);
  }

  /*
    ---- "is anything running for this user?", without a session ----

    The one question the client must be able to answer before it scrobbles
    anything, and the only one it cannot answer from local storage. A browser
    that has cleared its storage, or a second device, or a different profile,
    holds no record of a handover but can still reach a saved import — and
    sending it while the worker is sending the same queue duplicates plays
    silently, for as long as the job runs. Local records are a cache; this is
    the truth.

    It therefore cannot require a session, because losing the session is one
    of the cases it exists to catch. `/auth/signin` re-establishes one, but
    that is a Last.fm redirect: far too heavy to impose on every user at every
    page load merely to discover that they have no job. So the client asks
    this first, and only signs in when the answer is yes.

    A boolean and nothing else. No job id, no counts, no dates, no state — it
    confers no control and no detail, so answering it without a session grants
    nothing that a session would have gated.

    What it does leak is whether a given Last.fm username uses this feature.
    That is accepted deliberately: the client's own Last.fm API secret ships
    inside the browser bundle, so any "proof" of account ownership layered on
    top of this would be checkable by the same attacker who would be
    enumerating, and would buy nothing.

    Enumeration is bounded by a Cloudflare rate-limiting rule at the edge
    (see worker/README.md), *not* by a counter in D1. Writing a row per
    request would let an enumerator exhaust the free tier's daily write quota
    on our behalf, which stops the scheduler and is a considerably worse
    outcome than the fact being leaked.
  */
  if (path === '/scrobblify/job/live' && request.method === 'GET') {
    const lookup = (url.searchParams.get('username') ?? '').trim();
    if (!lookup) {
      return json(env, { ok: false, reason: 'bad_request' }, 400);
    }
    /*
      One statement, not two.

      Ownership *migrates* between these tables: a handoff holds it from the
      moment a slot is reserved, the job row takes it over at the exchange, and
      the handoff drops it at finalise. Two separate reads can therefore
      straddle that migration — see no job, then have finalise complete, then
      see a handoff that has just been cleared — and report idle while the
      worker is live. A single statement observes both tables in one snapshot,
      which is the only way the question has a consistent answer at all.

      `live_username` rather than a state list: it is NULL exactly while a job
      cannot send — terminal states clear it, and so does `needs_reauth`, which
      is entered only when the stored credential is gone or expired. `paused`
      and `needs_attention` keep it, correctly, because the user can resume
      them. Both columns carry unique indexes, so this stays two point lookups.
    */
    const name = normalizeUsername(lookup);
    const live = await env.sql.first<{ live: number }>(
      `SELECT 1 AS live FROM jobs WHERE live_username = ?
       UNION ALL
       SELECT 1 AS live FROM handoffs WHERE live_username = ?
       LIMIT 1`,
      [name, name],
    );
    return json(env, { ok: true, live: live !== null });
  }

  /*
    ---- "has this exact queue been handed over?", without a session ----

    `/job/live` answers a question about a *user*, and that is not quite the
    question the client has to answer. `live:false` means nothing is sending
    right now; it does not mean a saved local queue is safe. A worker can
    scrobble 20,000 tracks and then complete, or hit `needs_reauth`, and a
    browser that still holds the same import then sees "not live" and replays
    all 20,000. Last.fm discards a repeat of (artist, track, timestamp)
    silently while reporting it accepted, so nobody finds out.

    `importId` is minted by the browser when the user makes a selection and
    travels with the handoff onto the job (migration 004), so this stays
    answerable from any device, after the session is gone, and after the job
    has finished.

    Public, like `/job/live`, but for a different reason. That route is public
    because losing the session is one of the cases it exists to catch; this one
    is public because the id *is* the credential. It is high-entropy and held
    only by a browser that already has the queue, so requiring a session would
    gate the answer on something strictly weaker than what the caller already
    demonstrated by knowing the id.

    Which is also why the minimum length below is a real check and not
    politeness: a short or empty id would turn a capability into an
    enumeration.

    `cursor` is the contiguous terminal prefix — the only figure the client can
    safely skip past. `scrobbledCount` is for display and is deliberately not
    the same number: a batch can contain accepted and permanently failed
    entries at once, so progress is not a prefix.
  */
  const importMatch = path.match(/^\/scrobblify\/import\/([\w-]+)$/);
  if (importMatch && request.method === 'GET') {
    const importId = importMatch[1];
    if (importId.length < MIN_IMPORT_ID_LENGTH) {
      return json(env, { ok: false, reason: 'bad_request' }, 400);
    }
    /*
      One statement, for the same reason `/job/live` is one: ownership migrates
      from the handoff row to the job row, and two reads can straddle that.

      Handoffs that already produced a job are excluded — the job row carries
      the same id and better numbers, and counting both would let the older,
      emptier handoff row win the ordering.

      Ordering prefers a live row, then the most recent. Re-handing a queue
      back and forth creates one row per attempt, and it is the current one
      that decides whether the browser may send.
    */
    const row = await env.sql.first<{
      state: string; is_live: number; cursor: number;
      scrobbled_count: number; total_tracks: number; created_at: number;
    }>(
      `SELECT state AS state,
              CASE WHEN live_username IS NULL THEN 0 ELSE 1 END AS is_live,
              cursor AS cursor, scrobbled_count AS scrobbled_count,
              total_tracks AS total_tracks, created_at AS created_at
         FROM jobs WHERE import_id = ?
       UNION ALL
       SELECT state,
              CASE WHEN live_username IS NULL THEN 0 ELSE 1 END,
              0, 0, track_count, created_at
         FROM handoffs WHERE import_id = ? AND job_id IS NULL
       ORDER BY is_live DESC, created_at DESC
       LIMIT 1`,
      [importId, importId],
    );
    if (!row) {
      return json(env, { ok: true, known: false, live: false });
    }
    return json(env, {
      ok: true,
      known: true,
      live: row.is_live === 1,
      state: row.state,
      cursor: Number(row.cursor),
      scrobbledCount: Number(row.scrobbled_count),
      totalTracks: Number(row.total_tracks),
    });
  }

  // Everything below needs a session.
  const username = await authenticate(request, env.signingKey, nowSec);
  if (!username) {
    return json(env, { ok: false, reason: 'unauthenticated' }, 401);
  }

  // ---- step 4: upload chunks ----
  const chunkMatch = path.match(/^\/scrobblify\/handoff\/([\w-]+)\/chunk\/(\d+)$/);
  if (chunkMatch && request.method === 'PUT') {
    const handoff = await env.sql.first<HandoffRow>(
      'SELECT * FROM handoffs WHERE id = ?', [chunkMatch[1]],
    );
    // Authorising on the handoff's username rather than the URL is what stops
    // one authenticated user uploading into another user's job.
    if (!handoff || handoff.username !== username) {
      return json(env, { ok: false, reason: 'unknown' }, 404);
    }
    if (handoff.state !== 'pending_upload' || !handoff.job_id) {
      return json(env, { ok: false, reason: 'bad_state', state: handoff.state }, 409);
    }
    const digest = request.headers.get('X-Chunk-Digest');
    if (!digest) {
      return json(env, { ok: false, reason: 'missing_digest' }, 400);
    }
    const chunkIndex = Number(chunkMatch[2]);
    const result = await uploadChunk(env.sql, env.blobs, {
      jobId: handoff.job_id,
      chunkIndex,
      startIndex: chunkIndex * CHUNK_TRACKS,
      digest,
      entryCount: Number(url.searchParams.get('count') ?? CHUNK_TRACKS),
      compressed: await request.arrayBuffer(),
    }, nowSec);
    return json(env, result, result.ok ? 200 : 400);
  }

  // ---- step 4: finalise ----
  const finalizeMatch = path.match(/^\/scrobblify\/handoff\/([\w-]+)\/finalize$/);
  if (finalizeMatch && request.method === 'POST') {
    const handoff = await env.sql.first<HandoffRow>(
      'SELECT * FROM handoffs WHERE id = ?', [finalizeMatch[1]],
    );
    if (!handoff || handoff.username !== username) {
      return json(env, { ok: false, reason: 'unknown' }, 404);
    }
    const result = await finalize(
      env.sql, handoff.id, `jobs/${handoff.job_id}/manifest`, handoff.payload_digest, nowSec,
    );
    return json(env, result, result.ok ? 200 : 409);
  }

  // ---- handoff status, for the "response lost" case ----
  const statusMatch = path.match(/^\/scrobblify\/handoff\/([\w-]+)$/);
  if (statusMatch && request.method === 'GET') {
    const handoff = await env.sql.first<HandoffRow>(
      'SELECT * FROM handoffs WHERE id = ?', [statusMatch[1]],
    );
    if (!handoff || handoff.username !== username) {
      return json(env, { ok: false, reason: 'unknown' }, 404);
    }
    /*
      Tri-state, deliberately. The client resumes locally only on a definitive
      "no", so anything still in flight has to be reported as unknown rather
      than as inactive.

      `finalizing` is the case that matters: `finalizeHandoff` moves
      pending_upload -> finalizing -> active, so a finalise whose response was
      lost sits in `finalizing` for the moment it takes to activate. Reporting
      that as inactive is precisely how the tab and the worker end up
      scrobbling the same tracks.

      Nobody is stranded by this: the reaper turns every in-flight state
      terminal once `expires_at` passes, so an abandoned handoff resolves to a
      definitive "no" on its own.
    */
    const TERMINAL_INACTIVE = ['failed', 'expired', 'reaped', 'cancelled'];
    return json(env, {
      ok: true,
      state: handoff.state,
      jobId: handoff.job_id,
      active: handoff.state === 'active',
      resolved: handoff.state === 'active' || TERMINAL_INACTIVE.includes(handoff.state),
    });
  }

  // ---- job status ----
  if (path === '/scrobblify/job' && request.method === 'GET') {
    const job = await liveJobFor(env.sql, username);
    if (!job) {
      const recent = await env.sql.first<JobRow>(
        `SELECT * FROM jobs WHERE username = ? AND state IN ('completed', 'failed', 'cancelled')
          ORDER BY updated_at DESC LIMIT 1`,
        [normalizeUsername(username)],
      );
      // A finished job is reported for 30 days rather than 404ing, so a
      // returning user sees "done - 94,203 scrobbled" instead of "no job".
      return json(env, { ok: true, job: recent ? describeJob(recent, nowSec) : null });
    }
    return json(env, { ok: true, job: describeJob(job, nowSec) });
  }

  const jobActionMatch = path.match(/^\/scrobblify\/job\/([\w-]+)\/(pause|resume|cancel|export)$/);
  if (jobActionMatch) {
    const job = await env.sql.first<JobRow>('SELECT * FROM jobs WHERE id = ?', [jobActionMatch[1]]);
    if (!job || normalizeUsername(job.username) !== username) {
      return json(env, { ok: false, reason: 'unknown' }, 404);
    }
    const action = jobActionMatch[2];

    if (request.method !== 'POST') {
      return json(env, { ok: false, reason: 'method_not_allowed' }, 405);
    }

    if (action === 'export') {
      // POST rather than GET: it carries a claim token in the body, and it is
      // not idempotent — it moves the job into `exporting`.
      let exportBody: any = null;
      try {
        exportBody = await request.json();
      } catch {
        exportBody = null;
      }
      return exportJob(env, job, nowSec, exportBody);
    }
    if (action === 'cancel') {
      /*
        A cancel during an active export must present that export's claim.

        Cancelling deletes the blobs, and the export reads them. The normal UI
        only cancels after its export has returned, so this is not reachable by
        ordinary interaction — but the session is a bearer token, and a second
        authorised caller cancelling mid-read would delete the queue out from
        under a client that is about to save it. That is the one irreversible
        outcome in this whole flow: the tracks exist nowhere else at that
        moment.

        The check lives in the UPDATE rather than in an `if` above it. `job`
        was read at the top of this handler, and a request that read `paused`
        can be descheduled, have another request claim the export, and then
        resume and act on a snapshot that is no longer true — skipping the
        guard entirely and deleting the blobs the live export is reading.
        Making the claim part of the write means the database decides, at the
        moment of the write, on the row as it actually is.

        A missing claim is passed as NULL, which no comparison matches, so
        "no claim offered" cannot cancel a claimed export.
      */
      let cancelBody: any = null;
      try {
        cancelBody = await request.json();
      } catch {
        cancelBody = null;
      }
      const offeredClaim = cancelBody && typeof cancelBody.claim === 'string'
        ? cancelBody.claim
        : null;

      // Order matters: the export is built from the blob, so the blob is only
      // deleted after the caller has had the chance to take it. Deleting first
      // strands the user's progress permanently.
      const cancelled = await env.sql.run(
        `UPDATE jobs
            SET state = 'cancelled', state_reason = 'Cancelled by the user',
                session_key_ct = NULL, session_key_iv = NULL, live_username = NULL,
                locked_until = 0, completed_at = ?, purge_after = ?, updated_at = ?
          WHERE id = ? AND state NOT IN ('completed', 'failed', 'cancelled')
            AND (state <> 'exporting' OR export_claim IS NULL OR export_claim = ?)`,
        [nowSec, nowSec + 30 * 86400, nowSec, job.id, offeredClaim],
      );

      if (cancelled.changes === 0) {
        /*
          The write was refused. Only two things can refuse it: the job was
          already terminal, or an export holds it under a different claim.

          Re-reading and asking "is it *still* exporting?" was wrong, because
          a claim can lapse and revert the row to `paused` in between — and
          then a cancel that never happened would be reported as success, and
          the caller would go on to treat the queue as its own while the job
          sat resumable on the server. So the re-read only ever confirms the
          benign case: anything not terminal is a refusal, whatever it looks
          like now.
        */
        const current = await env.sql.first<JobRow>(
          'SELECT state FROM jobs WHERE id = ?', [job.id],
        );
        if (!current) {
          // Already purged. Nothing to cancel, and nothing left to clean up.
          return json(env, { ok: true });
        }
        if (current.state === 'cancelled') {
          /*
            A previous cancel updated the row and then died before it deleted
            the blobs — the one ordering this handler deliberately allows. The
            retry is what finishes the job, so the cleanup is repeated rather
            than skipped. Deleting an already-deleted blob is a no-op.
          */
          await deleteJobBlobs(env.sql, env.blobs, job.id);
          return json(env, { ok: true });
        }
        if (current.state === 'completed' || current.state === 'failed') {
          // Terminal, so the caller got what it asked for. The blobs belong to
          // those states' own lifecycle and are not this handler's to remove.
          return json(env, { ok: true });
        }
        return json(env, { error: 'export_in_progress' }, 409);
      }

      await deleteJobBlobs(env.sql, env.blobs, job.id);
      return json(env, { ok: true });
    }

    if (action === 'pause') {
      await env.sql.run(
        "UPDATE jobs SET state = 'paused', state_reason = 'Paused by the user', updated_at = ? WHERE id = ? AND state = 'active'",
        [nowSec, job.id],
      );
      return json(env, { ok: true });
    }

    // Resume clears the failure counter as well as the state: a user who has
    // fixed whatever was wrong should not inherit nine strikes.
    //
    // `exporting` is deliberately not resumable — a take-back is reading the
    // queue out, and restarting underneath it produces the duplicates the
    // claim exists to prevent. The refusal is reported rather than swallowed,
    // or the UI would show "resumed" for a job that did not move.
    const resumed = await env.sql.run(
      `UPDATE jobs SET state = 'active', state_reason = NULL, consecutive_failures = 0,
              next_eligible_at = ?, updated_at = ?
        WHERE id = ? AND state IN ('paused', 'needs_attention')`,
      [nowSec, nowSec, job.id],
    );
    if (resumed.changes === 0) {
      const current = await env.sql.first<JobRow>('SELECT state FROM jobs WHERE id = ?', [job.id]);
      return json(env, {
        ok: false,
        reason: current && current.state === 'exporting' ? 'exporting' : 'bad_state',
        state: current ? current.state : null,
      }, 409);
    }
    return json(env, { ok: true });
  }

  return json(env, { ok: false, reason: 'not_found' }, 404);
}

/**
 * Exports the *remaining* work as a file `StateManager.importFromFile` accepts,
 * so a user whose job is cancelled — or whose beta access ends — can always
 * finish client-side.
 *
 * The tracks are included, not just a progress envelope: an export without
 * them cannot be resumed from, which would defeat the entire escape hatch.
 * Emits only the four fields `importFromFile` requires, since everything else
 * it defaults, and adding fields would produce a file older cached clients
 * choke on.
 *
 * Note `completedIndices` is an array of indices, not a count. It is emitted
 * empty because the exported track list *already* excludes everything sent —
 * the tracks are re-indexed from zero. Emitting `[0..cursor]` alongside a
 * cursor-relative list would make the client skip that many of the tracks it
 * still needs.
 */
async function exportJob(
  env: ApiEnv,
  job: JobRow,
  nowSec: number,
  body: any,
): Promise<Response> {
  /*
    Quiescence is decided here, by the only party that can decide it.

    A take-back exports the tracks after `job.cursor` and then cancels. If a
    tick is midway through a batch at that moment, the batch's tracks are still
    after the cursor — it only advances once the batch settles — so they are
    exported *and* being sent. Last.fm accepts them, the browser resumes them,
    and the user gets duplicates.

    The client cannot detect this. It was previously inferred from the progress
    counter holding still across a few polls, which proves nothing: a Last.fm
    request can take fifteen seconds, during which the counter is legitimately
    frozen and a batch is very much in flight.

    Two conditions settle it, and both are server-side facts:
      - no lease is held, so no tick is running or about to write; and
      - no batch is in `sending`, so nothing is awaiting Last.fm or waiting to
        be reconciled after a lost response.

    Refusing is safe and cheap — the client retries — whereas exporting one
    second early is an irreversible duplicate.
  */
  if (job.locked_until > nowSec && job.state !== 'exporting') {
    // `exporting` is the exception: that deadline is this take-back's own
    // claim, not a tick's lease, so refusing on it would make the export
    // dead-end on its own first success.
    return json(env, { ok: false, reason: 'not_quiescent', detail: 'lease_held' }, 409);
  }
  const inFlight = await env.sql.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM batches WHERE job_id = ? AND state = 'sending'",
    [job.id],
  );
  if (inFlight && inFlight.n > 0) {
    // Asked for directly rather than waited for. The sweep runs every five
    // minutes, and a take-back that has to sit through one is a spinner no
    // user will stay for. The drain honours the same grace period, so this
    // only settles batches that are genuinely stale.
    await drainJobOnDemand(env, job.id, nowSec);
    const stillInFlight = await env.sql.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM batches WHERE job_id = ? AND state = 'sending'",
      [job.id],
    );
    if (stillInFlight && stillInFlight.n > 0) {
      return json(env, { ok: false, reason: 'not_quiescent', detail: 'batch_in_flight' }, 409);
    }
  }

  /*
    Quiescence is *claimed*, not merely observed.

    Checking and then reading was a time-of-check/time-of-use hole: a second
    tab pressing "Resume on the server" between the check and the read makes
    the job active again, a tick sends a batch, and the export the first tab
    saves still lists those tracks as pending. It then cancels, the browser
    resumes them, and they are scrobbled twice.

    The CAS closes it by moving the job into `exporting`, which `resume`
    refuses and the scheduler never selects.

    The claim is *identified*, not merely held. Allowing any request to
    re-claim from `exporting` — which is what "the client retries, so let it
    back in" originally bought — let two tabs read concurrently. One could then
    save and cancel, deleting the blobs, while the other was still reading
    chunks; the reader skips what it cannot find and returns a silently partial
    queue that overwrites the complete local save. A retry must present the
    same token, and the client sends one per take-back.

    `export_prev_state` records where to go back to, because reverting an
    abandoned claim to `paused` would clear a `needs_attention` the user still
    has to act on. `locked_until` is the claim expiry so an abandoned take-back
    reverts rather than stranding the job; a retry with the matching token
    ignores it, since it is not a lease held by anything running.
  */
  const claimToken = typeof body?.claim === 'string' && body.claim.length >= 16
    ? body.claim
    : null;
  if (!claimToken) {
    return json(env, { ok: false, reason: 'claim_required' }, 400);
  }
  const claimed = await env.sql.run(
    `UPDATE jobs
        SET state = 'exporting',
            export_claim = ?,
            export_prev_state = CASE WHEN state = 'exporting' THEN export_prev_state ELSE state END,
            locked_until = ?,
            updated_at = ?
      WHERE id = ?
        AND (
          (state IN ('paused', 'needs_attention', 'needs_reauth') AND locked_until <= ?)
          OR (state = 'exporting' AND export_claim = ?)
        )
        AND NOT EXISTS (
          SELECT 1 FROM batches b WHERE b.job_id = jobs.id AND b.state = 'sending'
        )`,
    [claimToken, nowSec + EXPORT_CLAIM_SECONDS, nowSec, job.id, nowSec, claimToken],
  );
  if (claimed.changes === 0) {
    // Running again, gone terminal, or claimed by another take-back. All are
    // answers the client must retry against rather than read a stale queue.
    return json(env, { ok: false, reason: 'not_quiescent', detail: 'not_claimable' }, 409);
  }

  /*
    Re-read after the claim, and use *this* row for everything below.

    `job` was loaded before the on-demand drain, and reconciling a stale batch
    is precisely what advances `cursor`. Exporting from the pre-drain cursor
    hands back tracks the drain just confirmed as scrobbled, which the client
    then cancels and re-sends locally — the exact duplicate the drain existed
    to prevent.
  */
  const fresh = await env.sql.first<JobRow>('SELECT * FROM jobs WHERE id = ?', [job.id]);
  if (!fresh) {
    return json(env, { ok: false, reason: 'not_found' }, 404);
  }
  const claimedJob = fresh;

  const failures = await env.sql.all<any>(
    'SELECT track_index, artist, track, album, reason, ignore_code FROM failures WHERE job_id = ? ORDER BY track_index',
    [claimedJob.id],
  );
  const failedIndex = new Set<number>(failures.map((f) => f.track_index));

  /*
    Tracks whose fate nobody knows, and the exact second each of them rode on.

    A batch row is written *before* the POST, so an abandoned batch is exactly
    the case where the request may have reached Last.fm and the answer was
    lost. Those entries are still after the cursor, so they are handed back and
    will be sent again.

    Sending them again under a *fresh* second is what turns "may already be
    stored" into "is now stored twice", because Last.fm deduplicates on the
    whole (artist, track, timestamp) tuple and a new second is a new tuple.
    Repeating the identical second instead makes the re-send a no-op when the
    original landed and a normal scrobble when it did not — the outcome is
    correct either way, and the user is never asked to choose.

    The same rule is applied by `sendBatch` when a job resumes over its own
    abandoned batch, from this same helper, because a guarantee that holds on
    only one of the two senders is no guarantee at all.
  */
  const { repeatable: repeatableSeconds, stale } = await abandonedSeconds(
    env.sql, claimedJob.id, nowSec,
  );
  /*
    Counted per index rather than per row, and only for indices that actually
    come back in the queue. An index behind the cursor was resolved and is not
    in `tracks`; one already recorded as a permanent failure is reported by
    name instead. Neither can be duplicated by a resume, so neither belongs in
    a warning about duplicates.
  */
  let uncertainCount = 0;
  stale.forEach((idx) => {
    if (idx >= claimedJob.cursor && !failedIndex.has(idx)) { uncertainCount += 1; }
  });

  const chunks = await env.sql.all<any>(
    'SELECT * FROM chunks WHERE job_id = ? AND end_index > ? ORDER BY chunk_index',
    [claimedJob.id, claimedJob.cursor],
  );

  const tracks: unknown[] = [];
  for (const chunk of chunks) {
    // eslint-disable-next-line no-await-in-loop
    const found = await readChunkFor(
      env.sql, env.blobs, claimedJob.id, Math.max(chunk.start_index, claimedJob.cursor),
    );
    if (!found) {
      /*
        A chunk that cannot be read is not a gap to skip over.

        Skipping it silently drops every track it held from the exported
        queue, and the client saves that queue over its own complete state
        before cancelling the job — so the tracks are lost from both sides at
        once. Refusing leaves the job intact and the client retrying.
      */
      return json(env, { ok: false, reason: 'export_incomplete' }, 503);
    }
    const from = Math.max(0, claimedJob.cursor - chunk.start_index);
    found.tracks.slice(from).forEach((t, i) => {
      const absolute = chunk.start_index + from + i;
      if (failedIndex.has(absolute)) {
        // Permanently rejected by Last.fm. Re-sending them client-side would
        // fail identically; they are reported separately instead.
        return;
      }
      /*
        Stated by the client when it knows, inferred only for chunks uploaded
        before the flag existed.

        The inference alone is wrong for exactly one track: a re-tagged play
        the browser may already have sent, whose second it pinned so the
        worker would repeat the identical tuple rather than mint a second,
        phantom play. That pin is non-zero, so a zero test calls it a genuine
        listen — and the browser would then preserve a date that ages out and
        is rejected outright.
      */
      const reTagged = t.reTagged === true || t.originalTimestampSec === 0;
      /*
        A re-tagged track with a real second is not a listen date — it is a
        pinned retry, a second some browser already spent on a send whose
        answer it never saw. Said out loud in the export because after this
        point nothing can reconstruct it: the placeholder below is also
        non-zero, so a client looking only at the timestamp cannot tell a pin
        from a cosmetic stamp, and inventing a fresh second for a play Last.fm
        may already hold is exactly the phantom the pin exists to prevent.
      */
      const pendingRetry = t.reTagged === true && t.originalTimestampSec > 0;
      /*
        A second this job already spent on a send whose answer never came
        back. Handed out as an ordinary listen date rather than as a re-tag,
        which is precisely what makes the browser repeat it verbatim instead
        of minting a new one — see the abandoned-batch scan above. It is
        already in `usedRanges`, so no *other* track can be allocated onto it.
      */
      const repeatSec = repeatableSeconds.get(absolute);
      if (repeatSec !== undefined) {
        /*
          Checked against the name, not trusted on the index alone.

          `AssignedTrack.index` is *batch-relative* when it is minted and is
          rebased onto the blob before the row is written — so this map is
          keyed correctly only for as long as that rebase stays in place. A
          regression there would silently pin every second to the wrong track,
          which is worse than the duplicate this exists to prevent: it would
          write plays the user never had. The batch row carries the names it
          sent, so the alignment is checkable, and a mismatch falls back to the
          old behaviour of a fresh second and an honest count.
        */
        if (repeatSec.artist === t.artist && repeatSec.track === t.track) {
          tracks.push({
            artist: t.artist,
            track: t.track,
            album: t.album ?? '',
            timestamp: repeatSec.sec * 1000,
            reTagged: false,
          });
          return;
        }
        uncertainCount += 1;
      }
      tracks.push({
        artist: t.artist,
        track: t.track,
        album: t.album ?? '',
        /*
          Re-tagged plays never had a real listen date — the client sends 0 to
          ask for send-time assignment. Exporting that as-is would hand back a
          queue stamped 1970, which the client would faithfully preserve
          (`reTagged: false` suppresses its own inference) and Last.fm would
          reject wholesale as too old. The placeholder is cosmetic; the flag is
          what makes the client re-stamp against its own clock.

          A pinned second is the exception worth keeping: it is a real second
          this browser may already have used, and handing it back lets the
          resumed queue repeat the identical tuple instead of inventing a new
          one. Cosmetic for every other re-tagged track.
        */
        timestamp: t.originalTimestampSec > 0
          ? t.originalTimestampSec * 1000
          : nowSec * 1000,
        reTagged,
        ...(pendingRetry ? { pendingRetry: true } : {}),
      });
    });
  }

  /*
    Every second this job actually submitted, not just the synthetic band.

    `synthetic_floor` describes the *current* descending band and says nothing
    about preserved originals, nor about seconds used before a wrap. A client
    allocating a re-tag onto one of those loses the play silently, because
    Last.fm discards a repeat of (artist, track, timestamp) while reporting it
    accepted.

    Collapsed into ranges rather than listed: a job submits up to ~160k
    timestamps, and the descending allocator makes them dense, so a handful of
    ranges usually covers the lot. Capped, and the cap is reported, so a client
    that receives a truncated list can widen its reservation instead of
    trusting an incomplete one.

    *Every* batch row counts, including abandoned ones. The row is written
    before the POST, so an abandoned batch is precisely the case where the
    request may have reached Last.fm and the response was lost — its seconds
    are the ones that most need reserving.
  */
  const submitted = await env.sql.all<{ assigned_timestamps: string }>(
    'SELECT assigned_timestamps FROM batches WHERE job_id = ?',
    [claimedJob.id],
  );
  const usedSeconds: number[] = [];
  let usedIncomplete = false;
  submitted.forEach((row) => {
    try {
      const parsed = JSON.parse(row.assigned_timestamps);
      if (!Array.isArray(parsed)) {
        usedIncomplete = true;
        return;
      }
      parsed.forEach((v) => {
        // Rows hold serialised `AssignedTrack` objects. A bare number is
        // accepted too so that a future shape change cannot quietly turn this
        // into a no-op the way reading the objects as numbers already did.
        const sec = typeof v === 'number' ? v : (v && Number(v.timestampSec));
        if (Number.isFinite(sec) && sec > 0) {
          usedSeconds.push(Number(sec));
        } else {
          usedIncomplete = true;
        }
      });
    } catch {
      // Unreadable. Reported as incomplete rather than silently skipped: a
      // client told the list is complete will allocate into the gap.
      usedIncomplete = true;
    }
  });
  const usedRanges = collapseToRanges(usedSeconds, MAX_EXPORTED_RANGES);

  return json(env, {
    ok: true,
    exportedAt: nowSec,
    /*
      The lowest synthetic second this job used. The client's own re-tag
      allocator runs *upwards* while this one runs downwards, so it needs to
      know where our range starts in order to reserve one below it rather than
      walking through ours. See `stateFromExport`.
    */
    syntheticFloorSec: claimedJob.synthetic_floor ?? 0,
    usedRanges: usedRanges.ranges,
    /*
      Kept as the union of both failure modes so that a cached older bundle,
      which knows only this field, stays conservative and abandons its
      reservation. Newer clients read the two fields below instead, which
      distinguish cases that are not equally bad.
    */
    usedRangesTruncated: usedRanges.truncated || usedIncomplete,
    /*
      Truncation is survivable: everything dropped lies below the lowest range
      still present, so the region above `usedRangesFloorSec` is fully
      described and a gap found there is genuinely free.
    */
    usedRangesFloorSec: usedRanges.ranges.length > 0 && usedRanges.truncated
      ? usedRanges.ranges[0].from
      : 0,
    /*
      Unreadable rows are not. Their seconds could be anywhere in the window,
      including inside a gap that looks free, so there is no region a client
      can trust and the reservation has to be abandoned.
    */
    usedRangesIncomplete: usedIncomplete,
    scrobbledByServer: claimedJob.scrobbled_count,
    /*
      How many of the returned tracks may end up on the account *twice*. Not
      the same as "may already be on the account": an abandoned batch whose
      seconds are still repeatable comes back pinned to them, so re-sending is
      a no-op if the original landed and costs nothing if it did not. Only the
      entries too old to repeat are counted here.
    */
    uncertainCount,
    state: {
      totalTracks: tracks.length,
      completedIndices: [],
      failedIndices: [],
      tracks,
    },
    failures: failures.map((f) => ({
      artist: f.artist, track: f.track, album: f.album, reason: f.reason, code: f.ignore_code,
    })),
  });
}

export { reapExpiredHandoffs, randomId };
