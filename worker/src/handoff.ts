/**
 * The auth handoff.
 *
 * A full-page redirect to Last.fm destroys all in-memory state, so this is a
 * durable transaction rather than a function call. The ordering below is load
 * bearing: get it wrong and you either strand a permanent write credential with
 * no job to use it, or clear the client's state before the server can accept
 * the data.
 *
 *   preflight -> issued
 *   callback  -> exchanging -> pending_upload   (job row + credential created)
 *   finalize  -> finalizing -> active
 *
 * Every transition is a compare-and-set from the expected prior state, because
 * duplicate callbacks are routine: link scanners, prefetchers and a user's
 * second tab all replay the URL.
 */
import {
  Sql,
  HandoffState,
  isTerminalHandoffState,
  readControl,
  reserveSlot,
  transitionHandoff,
} from './store';
import { LastFmClient } from './lastfm';
import {
  encryptCredential,
  normalizeUsername,
  randomId,
  signHandoffState,
  verifyHandoffState,
} from './crypto';

/** How long a user has to complete the Last.fm round trip and upload. */
export const HANDOFF_TTL_SECONDS = 60 * 60;

/** Bounded retries for a stalled auth.getSession before giving up. */
const MAX_EXCHANGE_ATTEMPTS = 3;

/**
 * Pinned into every job created by this code. A worker that no longer
 * implements these semantics must refuse such a job rather than reinterpret it:
 * immutable bytes are not immutable behaviour.
 */
export const ALGORITHM_VERSION = 1;

/** 60-day credential TTL; admission control refuses jobs that cannot finish. */
export const CREDENTIAL_TTL_SECONDS = 60 * 86400;

export interface HandoffRow {
  id: string;
  state: HandoffState;
  username: string;
  live_username: string | null;
  payload_digest: string;
  track_count: number;
  chunk_count: number;
  declared_bytes: number;
  algorithm_version: number;
  job_id: string | null;
  exchange_attempts: number;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export interface PreflightRequest {
  username: string;
  payloadDigest: string;
  trackCount: number;
  chunkCount: number;
  declaredBytes: number;
}

export type PreflightResult =
  | { ok: true; handoffId: string; state: string; callbackUrl: string }
  | { ok: false; reason: 'at_capacity' | 'already_live' | 'too_large' | 'paused' };

/**
 * At roughly 2,700 scrobbles/day, a job that cannot finish inside the
 * credential's 60-day life is guaranteed to be abandoned half-done. Refusing it
 * up front is kinder than accepting it — and this assumes no outages, no global
 * pauses and no daily-limit backoff, so it is already optimistic.
 */
export const MAX_TRACKS_PER_JOB = 2700 * 60;

/**
 * Step 0: commit what we expect *before* redirecting.
 *
 * The signed state returned here is the only thing that makes later
 * verification possible. It is produced server-side because a value the browser
 * generates proves nothing about what the browser promised.
 *
 * The slot is reserved now rather than at activation, so capacity cannot fill
 * between a user authorising with Last.fm and their job going active — which
 * would leave a captured credential with nowhere to run.
 */
export async function preflight(
  sql: Sql,
  req: PreflightRequest,
  signingKey: string,
  callbackBase: string,
  nowSec: number,
): Promise<PreflightResult> {
  const control = await readControl(sql);
  if (control.paused || control.halted) {
    return { ok: false, reason: 'paused' };
  }
  if (req.trackCount <= 0 || req.trackCount > MAX_TRACKS_PER_JOB) {
    return { ok: false, reason: 'too_large' };
  }

  const username = normalizeUsername(req.username);
  const id = randomId();
  const reserved = await reserveSlot(
    sql,
    {
      id,
      username,
      payloadDigest: req.payloadDigest,
      trackCount: req.trackCount,
      chunkCount: req.chunkCount,
      declaredBytes: req.declaredBytes,
      algorithmVersion: ALGORITHM_VERSION,
    },
    nowSec,
    HANDOFF_TTL_SECONDS,
    control.max_concurrent_jobs,
  );
  if (!reserved.ok) {
    return { ok: false, reason: reserved.reason };
  }

  const state = await signHandoffState(
    { h: id, exp: nowSec + HANDOFF_TTL_SECONDS },
    signingKey,
  );

  // The `cb` value Last.fm receives must be URL-encoded as a whole. Last.fm
  // appends `?token=` or `&token=` to it, and an unencoded `&` here would let
  // our own state parameter bind to Last.fm's URL instead of ours and silently
  // disappear.
  const callbackUrl = `${callbackBase}?state=${encodeURIComponent(state)}`;
  return { ok: true, handoffId: id, state, callbackUrl };
}

export type CallbackResult =
  | { ok: true; handoffId: string; jobId: string; alreadyDone: boolean }
  | {
    ok: false;
    reason: 'bad_state' | 'unknown' | 'expired' | 'username_mismatch' | 'exchange_failed';
  };

/**
 * Step 2-3: consume the Last.fm token and create the job.
 *
 * Two things here are the most dangerous in the whole design.
 *
 * **The username check.** `auth.getSession` tells us which account the
 * credential controls. If it disagrees with the username recorded at preflight
 * — a user logged into a second account in another tab, or an attacker landing
 * their own callback — we would write one person's listening history into
 * someone else's account. The key is discarded and the handoff failed.
 *
 * **Credential and owner are written together.** The encrypted session key is
 * inserted in the same batch as the job row that owns it. Writing the
 * credential first and failing before the row exists leaves unreachable
 * ciphertext holding permanent write access to a stranger's account.
 */
export async function handleCallback(
  sql: Sql,
  client: LastFmClient,
  params: { state: string; token: string },
  signingKey: string,
  credentialKey: string,
  nowSec: number,
): Promise<CallbackResult> {
  const verified = await verifyHandoffState(params.state, signingKey, nowSec);
  if (!verified || !params.token) {
    return { ok: false, reason: 'bad_state' };
  }

  const handoff = await sql.first<HandoffRow>('SELECT * FROM handoffs WHERE id = ?', [
    verified.h,
  ]);
  if (!handoff) {
    return { ok: false, reason: 'unknown' };
  }

  // A replayed callback must return the winner's outcome rather than calling
  // auth.getSession a second time: the token is single-use and the second call
  // would fail, turning a successful handoff into a reported error.
  if (handoff.state !== 'issued') {
    if (handoff.job_id) {
      return { ok: true, handoffId: handoff.id, jobId: handoff.job_id, alreadyDone: true };
    }
    return { ok: false, reason: handoff.state === 'failed' ? 'exchange_failed' : 'bad_state' };
  }
  if (handoff.expires_at <= nowSec) {
    await failHandoff(sql, handoff.id, 'expired', nowSec);
    return { ok: false, reason: 'expired' };
  }

  // Claim the exchange. The loser of this CAS must not proceed.
  const claimed = await transitionHandoff(
    sql,
    handoff.id,
    'issued',
    'exchanging',
    nowSec,
    'exchange_attempts = exchange_attempts + 1',
  );
  if (!claimed) {
    const current = await sql.first<HandoffRow>('SELECT * FROM handoffs WHERE id = ?', [
      handoff.id,
    ]);
    if (current && current.job_id) {
      return { ok: true, handoffId: current.id, jobId: current.job_id, alreadyDone: true };
    }
    return { ok: false, reason: 'bad_state' };
  }

  let session: { sessionKey: string; username: string };
  try {
    session = await client.getSession(params.token);
  } catch (e) {
    // Leaving the row in `exchanging` would strand it, so decide now: a token
    // that cannot be exchanged is never exchangeable again.
    const attempts = handoff.exchange_attempts + 1;
    const reason = attempts >= MAX_EXCHANGE_ATTEMPTS ? 'exchange_failed' : 'exchange_error';
    await failHandoff(sql, handoff.id, reason, nowSec);
    return { ok: false, reason: 'exchange_failed' };
  }

  if (normalizeUsername(session.username) !== normalizeUsername(handoff.username)) {
    // Discard the key. It is a working credential for an account that did not
    // ask for this, and it must not be persisted even momentarily.
    await failHandoff(sql, handoff.id, 'username_mismatch', nowSec);
    return { ok: false, reason: 'username_mismatch' };
  }

  const jobId = randomId();
  const encrypted = await encryptCredential(session.sessionKey, credentialKey, jobId);

  await sql.batch([
    {
      query: `INSERT INTO jobs (
                id, username, live_username, state, generation, locked_until,
                session_key_ct, session_key_iv, algorithm_version, schema_version,
                total_tracks, cursor, scrobbled_count, failed_count,
                last_run_at, next_eligible_at, consecutive_failures,
                daily_window_count, probing, created_at, updated_at,
                credential_expires_at
              ) VALUES (?, ?, ?, 'pending', 0, 0, ?, ?, ?, 1, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?, ?)`,
      params: [
        jobId,
        handoff.username,
        handoff.username,
        encrypted.ciphertext,
        encrypted.iv,
        handoff.algorithm_version,
        handoff.track_count,
        nowSec,
        nowSec,
        nowSec + CREDENTIAL_TTL_SECONDS,
      ],
    },
    {
      query: `UPDATE handoffs
                 SET state = 'pending_upload', job_id = ?, updated_at = ?
               WHERE id = ? AND state = 'exchanging'`,
      params: [jobId, nowSec, handoff.id],
    },
  ]);

  return { ok: true, handoffId: handoff.id, jobId, alreadyDone: false };
}

/**
 * Terminates a handoff and releases its slot.
 *
 * Guarded against clobbering a terminal row: a reaper firing while a finalize
 * is committing must not turn a live job's handoff back into a failure. Any job
 * row already created is cancelled and its credential nulled in the same batch,
 * because a failed handoff must never leave a usable key behind.
 */
export async function failHandoff(
  sql: Sql,
  handoffId: string,
  reason: string,
  nowSec: number,
): Promise<void> {
  const handoff = await sql.first<HandoffRow>('SELECT * FROM handoffs WHERE id = ?', [handoffId]);
  if (!handoff || isTerminalHandoffState(handoff.state)) {
    return;
  }
  const statements: { query: string; params: unknown[] }[] = [
    {
      query: `UPDATE handoffs
                 SET state = 'failed', live_username = NULL, failure_reason = ?, updated_at = ?
               WHERE id = ? AND state NOT IN ('active', 'failed', 'reaped')`,
      params: [reason, nowSec, handoffId],
    },
  ];
  if (handoff.job_id) {
    statements.push({
      query: `UPDATE jobs
                 SET state = 'cancelled', live_username = NULL, state_reason = ?,
                     session_key_ct = NULL, session_key_iv = NULL, updated_at = ?
               WHERE id = ? AND state = 'pending'`,
      params: [reason, nowSec, handoff.job_id],
    });
  }
  await sql.batch(statements);
}

export type FinalizeResult =
  | { ok: true; jobId: string; alreadyActive: boolean }
  | { ok: false; reason: 'unknown' | 'bad_state' | 'incomplete_upload' | 'digest_mismatch' };

/**
 * Step 4: publish the manifest and activate.
 *
 * The `active` transition is conditional on every chunk being present,
 * hash-verified, contiguous and non-overlapping — checked from the chunk rows
 * alone, so a missing, duplicated or reordered chunk is detectable without
 * reading R2.
 *
 * The client clears its own state only after this returns success. If the
 * response is lost, the client must ask the server rather than assume failure:
 * resuming locally while a live job exists is the single most likely source of
 * duplicates in the design.
 */
export async function finalize(
  sql: Sql,
  handoffId: string,
  manifestKey: string,
  manifestDigest: string,
  nowSec: number,
): Promise<FinalizeResult> {
  const handoff = await sql.first<HandoffRow>('SELECT * FROM handoffs WHERE id = ?', [handoffId]);
  if (!handoff || !handoff.job_id) {
    return { ok: false, reason: 'unknown' };
  }
  if (handoff.state === 'active') {
    return { ok: true, jobId: handoff.job_id, alreadyActive: true };
  }
  if (handoff.state !== 'pending_upload') {
    return { ok: false, reason: 'bad_state' };
  }

  const chunks = await sql.all<{
    chunk_index: number;
    start_index: number;
    end_index: number;
    verified: number;
  }>(
    'SELECT chunk_index, start_index, end_index, verified FROM chunks WHERE job_id = ? ORDER BY chunk_index ASC',
    [handoff.job_id],
  );

  if (chunks.length !== handoff.chunk_count) {
    return { ok: false, reason: 'incomplete_upload' };
  }

  let expectedStart = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    if (chunk.chunk_index !== i || !chunk.verified) {
      return { ok: false, reason: 'incomplete_upload' };
    }
    // Contiguity is what makes gaps and overlaps impossible: a chunk that does
    // not begin exactly where the previous ended means tracks are missing or
    // duplicated, and neither is detectable later.
    if (chunk.start_index !== expectedStart || chunk.end_index <= chunk.start_index) {
      return { ok: false, reason: 'incomplete_upload' };
    }
    expectedStart = chunk.end_index;
  }
  if (expectedStart !== handoff.track_count) {
    return { ok: false, reason: 'incomplete_upload' };
  }

  const moved = await transitionHandoff(sql, handoffId, 'pending_upload', 'finalizing', nowSec);
  if (!moved) {
    return { ok: false, reason: 'bad_state' };
  }

  await sql.batch([
    {
      query: `UPDATE jobs
                 SET state = 'active', manifest_key = ?, manifest_digest = ?,
                     next_eligible_at = ?, updated_at = ?
               WHERE id = ? AND state = 'pending'`,
      params: [manifestKey, manifestDigest, nowSec, nowSec, handoff.job_id],
    },
    {
      query: `UPDATE handoffs
                 SET state = 'active', live_username = NULL, updated_at = ?
               WHERE id = ? AND state = 'finalizing'`,
      params: [nowSec, handoffId],
    },
  ]);

  return { ok: true, jobId: handoff.job_id, alreadyActive: false };
}

/**
 * Reaps abandoned handoffs.
 *
 * A user who closes the tab mid-flow must not leave a permanent write
 * credential behind. Reaping is a conditional update with a freshness check,
 * never an unconditional delete, so it cannot race an upload that is still
 * making progress.
 */
export async function reapExpiredHandoffs(sql: Sql, nowSec: number): Promise<number> {
  const stale = await sql.all<HandoffRow>(
    `SELECT * FROM handoffs
      WHERE state IN ('issued','exchanging','pending_upload','finalizing')
        AND expires_at <= ?`,
    [nowSec],
  );
  for (const handoff of stale) {
    // eslint-disable-next-line no-await-in-loop
    await failHandoff(sql, handoff.id, 'reaped', nowSec);
  }
  return stale.length;
}
