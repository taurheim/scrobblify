/**
 * HTTP surface.
 *
 * Routing only: every endpoint delegates to `handoff.ts`, `chunks.ts` or
 * `store.ts`. The rule that keeps this safe is that the worker exposes **no
 * generic Last.fm proxy** — nothing here can scrobble an arbitrary track. The
 * only tracks that ever reach Last.fm are the ones already committed to a
 * job's write-once blob.
 */
import { Sql, JobRow, readControl, countCommittedSlots } from './store';
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
} from './handoff';
import { issueSession, authenticate } from './session';
import { normalizeUsername, randomId } from './crypto';

/** Remaining tracks below which background mode is not worth the trade-offs. */
export const MIN_TRACKS_FOR_BACKGROUND = 2700;

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

  // ---- step 2/3: Last.fm returns the user here ----
  if (path === '/scrobblify/auth/callback' && request.method === 'GET') {
    const result = await handleCallback(
      env.sql,
      env.lastfm,
      { state: url.searchParams.get('state') ?? '', token: url.searchParams.get('token') ?? '' },
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
    // The client resumes locally only if this says the job is not active. A
    // lost finalise response must never be read as failure — that is how both
    // the tab and the worker end up scrobbling the same tracks.
    return json(env, {
      ok: true,
      state: handoff.state,
      jobId: handoff.job_id,
      active: handoff.state === 'active',
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

    if (action === 'export' && request.method === 'GET') {
      return exportJob(env, job, nowSec);
    }
    if (request.method !== 'POST') {
      return json(env, { ok: false, reason: 'method_not_allowed' }, 405);
    }

    if (action === 'cancel') {
      // Order matters: the export is built from the blob, so the blob is only
      // deleted after the caller has had the chance to take it. Deleting first
      // strands the user's progress permanently.
      await env.sql.run(
        `UPDATE jobs
            SET state = 'cancelled', state_reason = 'Cancelled by the user',
                session_key_ct = NULL, session_key_iv = NULL, live_username = NULL,
                locked_until = 0, completed_at = ?, purge_after = ?, updated_at = ?
          WHERE id = ? AND state NOT IN ('completed', 'failed', 'cancelled')`,
        [nowSec, nowSec + 30 * 86400, nowSec, job.id],
      );
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
    await env.sql.run(
      `UPDATE jobs SET state = 'active', state_reason = NULL, consecutive_failures = 0,
              next_eligible_at = ?, updated_at = ?
        WHERE id = ? AND state IN ('paused', 'needs_attention')`,
      [nowSec, nowSec, job.id],
    );
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
async function exportJob(env: ApiEnv, job: JobRow, nowSec: number): Promise<Response> {
  const failures = await env.sql.all<any>(
    'SELECT track_index, artist, track, album, reason, ignore_code FROM failures WHERE job_id = ? ORDER BY track_index',
    [job.id],
  );
  const failedIndex = new Set<number>(failures.map((f) => f.track_index));

  const chunks = await env.sql.all<any>(
    'SELECT * FROM chunks WHERE job_id = ? AND end_index > ? ORDER BY chunk_index',
    [job.id, job.cursor],
  );

  const tracks: unknown[] = [];
  for (const chunk of chunks) {
    // eslint-disable-next-line no-await-in-loop
    const found = await readChunkFor(env.sql, env.blobs, job.id, Math.max(chunk.start_index, job.cursor));
    if (!found) {
      // eslint-disable-next-line no-continue
      continue;
    }
    const from = Math.max(0, job.cursor - chunk.start_index);
    found.tracks.slice(from).forEach((t, i) => {
      const absolute = chunk.start_index + from + i;
      if (failedIndex.has(absolute)) {
        // Permanently rejected by Last.fm. Re-sending them client-side would
        // fail identically; they are reported separately instead.
        return;
      }
      tracks.push({
        artist: t.artist,
        track: t.track,
        album: t.album ?? '',
        timestamp: t.originalTimestampSec * 1000,
        reTagged: false,
      });
    });
  }

  return json(env, {
    ok: true,
    exportedAt: nowSec,
    scrobbledByServer: job.scrobbled_count,
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
