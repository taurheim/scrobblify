/**
 * The scheduler tick.
 *
 * Runs on cron. Everything here assumes it may be killed at any instant and
 * restarted by a tick that overlaps it, so the ordering of writes matters more
 * than their content:
 *
 *   1. persist the batch's index -> timestamp mapping   (durable, fenced)
 *   2. send it to Last.fm                               (not undoable)
 *   3. record outcomes and advance the cursor           (durable, fenced)
 *
 * A crash between 1 and 3 leaves a batch whose fate is unknown. That is the
 * irreducible ambiguity window: no cursor granularity closes it, because
 * Last.fm accepting a scrobble and D1 recording that it did are two separate
 * machines. We resolve it by reconciling against the timestamps *we* chose,
 * and where reconciliation is inconclusive we re-send. At-least-once is a
 * deliberate choice: a duplicate is visible and removable, a dropped track is
 * neither.
 */
import {
  Sql,
  JobRow,
  JobLease,
  FencedError,
  acquireJob,
  fencedJobUpdate,
  releaseJob,
  renewLease,
  selectDueJobs,
  readControl,
  canRun,
  tripBreaker,
  haltGlobally,
} from './store';
import { BlobStore, JobTrack, readChunkFor } from './chunks';
import { LastFmClient } from './lastfm';
import { decryptCredential, randomId } from './crypto';
import {
  assignTimestamps,
  reconciliationWindow,
  normalizeForMatch,
  AssignedTrack,
} from './timestamps';
import {
  MAX_SCROBBLES_PER_BATCH,
  IgnoreCode,
  isPermanentIgnore,
  isRateLimitError,
  isInvalidSessionKeyError,
  isSuspendedApiKeyError,
  isNetworkError,
  type ScrobbleOutcome,
} from '../../src/shared/lastfm/protocol';
import { ALGORITHM_VERSION } from './handoff';

/**
 * How long a tick may hold a job.
 *
 * Comfortably longer than the work, because expiring a live lease is how two
 * ticks end up sending the same batch. Fencing means the loser's *writes* are
 * rejected, but nothing can recall a request already in flight to Last.fm.
 */
export const LEASE_SECONDS = 180;

/** Jobs considered per tick. Bounded by the subrequest budget, not by CPU. */
export const MAX_JOBS_PER_TICK = 8;

/**
 * Batches sent per job per tick. Round-robin fairness is worthless if the
 * first job drains the whole tick, so each gets a slice.
 */
export const MAX_BATCHES_PER_JOB_PER_TICK = 4;

/** Consecutive failures before a job is parked for a human. */
export const MAX_CONSECUTIVE_FAILURES = 10;

/** Base backoff when the shared egress IP is throttled (error 29). */
export const BREAKER_BASE_BACKOFF_SECONDS = 300;
export const BREAKER_MAX_BACKOFF_SECONDS = 3600;

/**
 * Backoff after the per-user daily cap (ignore code 5).
 *
 * Conservative on purpose. We do not know whether Last.fm's cap resets on a
 * wall clock or a rolling window, and "resume at midnight" would wake every
 * job simultaneously and re-hit both the cap and the shared IP limit. 24 hours
 * from the cap, then a single small probe before resuming full rate.
 */
export const DAILY_CAP_BACKOFF_SECONDS = 24 * 3600;
export const PROBE_BATCH_SIZE = 5;

/** Spacing between batches of the same job, to stay clear of the IP throttle. */
export const INTER_BATCH_DELAY_SECONDS = 60;

export interface SchedulerEnv {
  sql: Sql;
  blobs: BlobStore;
  lastfm: LastFmClient;
  /** Worker secret used to decrypt stored session keys. Never stored in D1. */
  credentialSecret: string;
}

export interface TickReport {
  skipped?: string;
  jobsConsidered: number;
  jobsRun: number;
  batchesSent: number;
  scrobbled: number;
  failed: number;
  errors: string[];
}

type EntryState = 'accepted' | 'failed' | 'capped' | 'unknown';

interface EntryOutcome {
  /** Index in the job's blob. */
  i: number;
  s: EntryState;
  /** Last.fm ignore code, when there was one. */
  c?: number;
  t: number;
}

async function audit(
  sql: Sql,
  jobId: string | null,
  generation: number | null,
  event: string,
  detail: unknown,
  nowSec: number,
): Promise<void> {
  await sql.run(
    'INSERT INTO audit (id, job_id, generation, event, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [randomId(), jobId, generation, event, detail === undefined ? null : JSON.stringify(detail), nowSec],
  );
}

/**
 * A terminal entry is one we will never send again: Last.fm either stored it
 * or refused it permanently. Only terminal entries let the cursor move.
 */
function isTerminal(state: EntryState): boolean {
  return state === 'accepted' || state === 'failed';
}

/**
 * How far the cursor may advance: the contiguous run of terminal entries from
 * the batch's start.
 *
 * Contiguity matters even though the common cases are already suffixes —
 * Last.fm processes entries in submitted order, so the daily cap produces a
 * clean tail. It is the uncommon case this guards: stopping at the first
 * non-terminal entry means a track whose fate is unknown is retried rather
 * than stepped over, and stepping over one is unrecoverable.
 */
function terminalPrefixLength(outcomes: EntryOutcome[]): number {
  let n = 0;
  while (n < outcomes.length && isTerminal(outcomes[n].s)) {
    n += 1;
  }
  return n;
}

function classifyOutcome(outcome: ScrobbleOutcome): { state: EntryState; code?: number } {
  if (outcome.accepted) {
    return { state: 'accepted' };
  }
  const code = outcome.ignoredCode;
  if (code === IgnoreCode.DailyLimitReached) {
    return { state: 'capped', code };
  }
  if (typeof code === 'number' && isPermanentIgnore(code)) {
    return { state: 'failed', code };
  }
  // Codes 3 and 4 mean our own timestamp assignment is wrong. They are recorded
  // as failures so the job makes progress, but they are a bug signal, not a
  // property of the user's data, and the audit entry is what surfaces them.
  return { state: 'failed', code };
}

/**
 * Records the tracks Last.fm refused, so the completion page can show them.
 *
 * Deliberately not `INSERT OR REPLACE`: a re-sent track that failed once and
 * succeeded later should keep neither row silently overwritten nor duplicated,
 * and the first recorded reason is the more informative one.
 */
async function recordFailures(
  sql: Sql,
  jobId: string,
  entries: { index: number; track: JobTrack; reason: string; code?: number }[],
  nowSec: number,
): Promise<void> {
  if (entries.length === 0) {
    return;
  }
  await sql.batch(entries.map((e) => ({
    query: `INSERT OR IGNORE INTO failures
              (job_id, track_index, artist, track, album, reason, ignore_code, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [
      jobId,
      e.index,
      e.track.artist,
      e.track.track,
      e.track.album ?? null,
      e.reason,
      e.code ?? null,
      nowSec,
    ],
  })));
}

/**
 * Resolves batches left in `sending` by a tick that died mid-flight.
 *
 * Runs before anything is sent, because the cursor is untrustworthy until it
 * does: the batch may have been stored by Last.fm, in which case re-sending it
 * blind duplicates up to 50 plays.
 *
 * The lookup key is the set of timestamps *we* assigned. They are unique by
 * construction, which is exactly why the worker assigns them — the user's own
 * timestamps are frequently all identical and could never identify a batch.
 */
async function reconcile(
  env: SchedulerEnv,
  lease: JobLease,
  sessionKey: string,
  nowSec: number,
): Promise<void> {
  const stale = await env.sql.all<any>(
    "SELECT * FROM batches WHERE job_id = ? AND state = 'sending' ORDER BY start_index ASC",
    [lease.job.id],
  );
  if (stale.length === 0) {
    return;
  }

  for (const batch of stale) {
    const assigned: AssignedTrack[] = JSON.parse(batch.assigned_timestamps);
    const window = reconciliationWindow(assigned.map((a) => a.timestampSec));
    if (!window) {
      // eslint-disable-next-line no-await-in-loop
      await env.sql.run("UPDATE batches SET state = 'abandoned', settled_at = ? WHERE id = ?", [nowSec, batch.id]);
      // eslint-disable-next-line no-continue
      continue;
    }

    let seen: { artist: string; track: string; timestampSec: number }[] = [];
    let lookupFailed = false;
    try {
      // eslint-disable-next-line no-await-in-loop
      seen = await env.lastfm.getRecentTracks(
        lease.job.username,
        window.fromSec,
        window.toSec,
        sessionKey,
      );
    } catch (e) {
      // An inconclusive lookup must not be read as "nothing was stored".
      // Leaving the batch in `sending` costs another reconciliation next tick;
      // treating it as lost costs the user 50 duplicate scrobbles.
      lookupFailed = true;
    }
    if (lookupFailed) {
      // eslint-disable-next-line no-continue
      continue;
    }

    const byTimestamp = new Map<number, { artist: string; track: string }>();
    seen.forEach((s) => byTimestamp.set(s.timestampSec, s));

    const outcomes: EntryOutcome[] = assigned.map((a) => {
      const hit = byTimestamp.get(a.timestampSec);
      if (!hit) {
        return { i: a.index, s: 'unknown' as EntryState, t: a.timestampSec };
      }
      // Last.fm rewrites what it stores, so this comparison is loose on
      // purpose. A false match drops one scrobble from a batch already known
      // to be ambiguous; a false miss duplicates the whole batch.
      const sameTrack = normalizeForMatch(hit.track) === normalizeForMatch(a.track);
      return {
        i: a.index,
        s: sameTrack ? ('accepted' as EntryState) : ('unknown' as EntryState),
        t: a.timestampSec,
      };
    });

    const accepted = outcomes.filter((o) => o.s === 'accepted').length;
    const advance = terminalPrefixLength(outcomes);

    // eslint-disable-next-line no-await-in-loop
    await env.sql.run(
      `UPDATE batches
          SET state = 'reconciled', outcomes = ?, accepted_count = ?, settled_at = ?
        WHERE id = ? AND state = 'sending'`,
      [JSON.stringify(outcomes), accepted, nowSec, batch.id],
    );

    if (advance > 0) {
      // eslint-disable-next-line no-await-in-loop
      await fencedJobUpdate(
        env.sql,
        lease,
        'cursor = ?, scrobbled_count = scrobbled_count + ?, updated_at = ?',
        [batch.start_index + advance, accepted, nowSec],
      );
      lease.job.cursor = batch.start_index + advance;
      lease.job.scrobbled_count += accepted;
    }

    // eslint-disable-next-line no-await-in-loop
    await audit(env.sql, lease.job.id, lease.generation, 'reconciled', {
      batch: batch.id,
      recovered: accepted,
      unresolved: outcomes.length - accepted,
    }, nowSec);
  }
}

interface BatchResult {
  sent: number;
  accepted: number;
  failed: number;
  /** Set when the job must stop for a reason of its own. */
  stop?: { state: string; reason: string; nextEligibleAt?: number };
  /** Set when every job must stop. */
  global?: { kind: 'breaker' | 'halt'; reason: string };
}

/**
 * Sends one batch and records what happened to every entry in it.
 */
async function sendBatch(
  env: SchedulerEnv,
  lease: JobLease,
  sessionKey: string,
  tracks: JobTrack[],
  startIndex: number,
  nowSec: number,
): Promise<BatchResult> {
  const job = lease.job;
  const assignment = assignTimestamps(
    tracks.map((t) => ({
      artist: t.artist,
      track: t.track,
      album: t.album,
      originalTimestampSec: t.originalTimestampSec,
    })),
    nowSec,
    job.synthetic_floor ?? 0,
  );

  // Rebase the in-batch indices onto the job's blob so outcomes survive
  // independently of where the batch started.
  const assigned = assignment.assigned.map((a) => ({ ...a, index: startIndex + a.index }));
  const batchId = randomId();

  // Step 1: the mapping is durable *before* the send. This row is the only
  // thing that can identify these scrobbles after a crash.
  await env.sql.run(
    `INSERT INTO batches
       (id, job_id, generation, start_index, entry_count, state, assigned_timestamps, sent_at, created_at)
     VALUES (?, ?, ?, ?, ?, 'sending', ?, ?, ?)`,
    [batchId, job.id, lease.generation, startIndex, assigned.length, JSON.stringify(assigned), nowSec, nowSec],
  );
  await fencedJobUpdate(env.sql, lease, 'synthetic_floor = ?, updated_at = ?', [
    assignment.syntheticFloor,
    nowSec,
  ]);
  lease.job.synthetic_floor = assignment.syntheticFloor;

  // Step 2: send.
  let result;
  try {
    result = await env.lastfm.scrobbleBatch(
      assigned.map((a) => ({
        artist: a.artist,
        track: a.track,
        album: a.album,
        timestampSec: a.timestampSec,
      })),
      sessionKey,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await env.sql.run(
      "UPDATE batches SET state = ?, error_message = ?, settled_at = ? WHERE id = ?",
      [isNetworkError(error) ? 'sending' : 'errored', message, nowSec, batchId],
    );

    if (isSuspendedApiKeyError(error)) {
      return { sent: 0, accepted: 0, failed: 0, global: { kind: 'halt', reason: message } };
    }
    if (isRateLimitError(error)) {
      // Error 29 is an *IP* throttle, shared by every job on this worker.
      // Backing off one job would leave the others hammering the same limit.
      return { sent: 0, accepted: 0, failed: 0, global: { kind: 'breaker', reason: message } };
    }
    if (isInvalidSessionKeyError(error)) {
      return {
        sent: 0,
        accepted: 0,
        failed: 0,
        stop: { state: 'needs_reauth', reason: 'Last.fm session key was revoked' },
      };
    }
    // A network error consumed nothing, but the batch stays in `sending`: we
    // cannot tell a request that never arrived from a response that never came
    // back, and only reconciliation can.
    return { sent: 0, accepted: 0, failed: 0, stop: { state: 'retry', reason: message } };
  }

  // Step 3: record outcomes.
  const outcomes: EntryOutcome[] = result.outcomes.map((o, i) => {
    const c = classifyOutcome(o);
    return { i: assigned[i].index, s: c.state, c: c.code, t: assigned[i].timestampSec };
  });

  const accepted = outcomes.filter((o) => o.s === 'accepted').length;
  const failedEntries = outcomes
    .map((o, i) => ({ o, i }))
    .filter((x) => x.o.s === 'failed');
  const capped = outcomes.some((o) => o.s === 'capped');
  const advance = terminalPrefixLength(outcomes);

  await env.sql.run(
    `UPDATE batches
        SET state = 'settled', outcomes = ?, accepted_count = ?, ignored_count = ?, settled_at = ?
      WHERE id = ?`,
    [JSON.stringify(outcomes), accepted, outcomes.length - accepted, nowSec, batchId],
  );

  await recordFailures(
    env.sql,
    job.id,
    failedEntries.map((x) => ({
      index: outcomes[x.i].i,
      track: tracks[x.i],
      reason: result.outcomes[x.i].ignoredMessage || 'Rejected by Last.fm',
      code: outcomes[x.i].c,
    })),
    nowSec,
  );

  if (advance > 0) {
    await fencedJobUpdate(
      env.sql,
      lease,
      `cursor = ?, scrobbled_count = scrobbled_count + ?, failed_count = failed_count + ?,
       consecutive_failures = 0, updated_at = ?`,
      [startIndex + advance, accepted, failedEntries.length, nowSec],
    );
    lease.job.cursor = startIndex + advance;
    lease.job.scrobbled_count += accepted;
    lease.job.failed_count += failedEntries.length;
  }

  // A timestamp Last.fm calls too old or too new is our bug, not the user's
  // data. Surfacing it is the only way it ever gets found.
  const badTimestamps = outcomes.filter(
    (o) => o.c === IgnoreCode.TimestampTooOld || o.c === IgnoreCode.TimestampTooNew,
  );
  if (badTimestamps.length > 0) {
    await audit(env.sql, job.id, lease.generation, 'timestamp_rejected', {
      count: badTimestamps.length,
      sample: badTimestamps.slice(0, 3),
    }, nowSec);
  }

  if (capped) {
    return {
      sent: assigned.length,
      accepted,
      failed: failedEntries.length,
      stop: {
        state: 'daily_cap',
        reason: 'Last.fm daily scrobble limit reached',
        nextEligibleAt: nowSec + DAILY_CAP_BACKOFF_SECONDS,
      },
    };
  }

  return { sent: assigned.length, accepted, failed: failedEntries.length };
}

interface JobOutcome {
  batchesSent: number;
  scrobbled: number;
  failed: number;
  global?: { kind: 'breaker' | 'halt'; reason: string };
}

async function runJob(
  env: SchedulerEnv,
  job: JobRow,
  nowSec: number,
): Promise<JobOutcome | null> {
  const lease = await acquireJob(env.sql, job.id, nowSec, LEASE_SECONDS);
  if (!lease) {
    // Another tick has it. Losing this race costs one job, not the tick.
    return null;
  }

  const empty: JobOutcome = { batchesSent: 0, scrobbled: 0, failed: 0 };

  // A job pinned to semantics this worker no longer implements must be refused,
  // not reinterpreted. Bytes being immutable does not make behaviour immutable.
  if (lease.job.algorithm_version !== ALGORITHM_VERSION) {
    await fencedJobUpdate(
      env.sql,
      lease,
      "state = 'needs_attention', state_reason = ?, locked_until = 0, updated_at = ?",
      [`Pinned to algorithm version ${lease.job.algorithm_version}`, nowSec],
    );
    return empty;
  }

  if (lease.job.credential_expires_at <= nowSec) {
    await fencedJobUpdate(
      env.sql,
      lease,
      `state = 'needs_reauth', state_reason = ?, session_key_ct = NULL, session_key_iv = NULL,
       live_username = NULL, locked_until = 0, updated_at = ?`,
      ['Stored credential reached its 60-day lifetime', nowSec],
    );
    return empty;
  }

  if (!lease.job.session_key_ct || !lease.job.session_key_iv) {
    await fencedJobUpdate(
      env.sql,
      lease,
      "state = 'needs_reauth', state_reason = ?, live_username = NULL, locked_until = 0, updated_at = ?",
      ['No stored credential', nowSec],
    );
    return empty;
  }

  const sessionKey = await decryptCredential(
    { ciphertext: lease.job.session_key_ct, iv: lease.job.session_key_iv },
    env.credentialSecret,
    lease.job.id,
  );
  if (!sessionKey) {
    // The job id is the AAD, so a decrypt failure means either the secret was
    // rotated or the row was tampered with. Both need a human; neither is
    // fixed by retrying.
    await fencedJobUpdate(
      env.sql,
      lease,
      "state = 'needs_attention', state_reason = ?, locked_until = 0, updated_at = ?",
      ['Stored credential could not be decrypted', nowSec],
    );
    await audit(env.sql, lease.job.id, lease.generation, 'credential_undecryptable', null, nowSec);
    return empty;
  }

  await reconcile(env, lease, sessionKey, nowSec);

  let batchesSent = 0;
  let scrobbled = 0;
  let failed = 0;
  const budget = lease.job.probing ? 1 : MAX_BATCHES_PER_JOB_PER_TICK;
  const batchSize = lease.job.probing ? PROBE_BATCH_SIZE : MAX_SCROBBLES_PER_BATCH;

  for (let n = 0; n < budget; n += 1) {
    if (lease.job.cursor >= lease.job.total_tracks) {
      break;
    }

    // eslint-disable-next-line no-await-in-loop
    const chunk = await readChunkFor(env.sql, env.blobs, lease.job.id, lease.job.cursor);
    if (!chunk) {
      // eslint-disable-next-line no-await-in-loop
      await fencedJobUpdate(
        env.sql,
        lease,
        "state = 'needs_attention', state_reason = ?, locked_until = 0, updated_at = ?",
        [`No chunk covers index ${lease.job.cursor}`, nowSec],
      );
      return { batchesSent, scrobbled, failed };
    }

    const offset = lease.job.cursor - chunk.chunk.start_index;
    const slice = chunk.tracks.slice(offset, offset + batchSize);
    if (slice.length === 0) {
      break;
    }

    // eslint-disable-next-line no-await-in-loop
    const result = await sendBatch(env, lease, sessionKey, slice, lease.job.cursor, nowSec);
    batchesSent += result.sent > 0 ? 1 : 0;
    scrobbled += result.accepted;
    failed += result.failed;

    if (result.global) {
      return { batchesSent, scrobbled, failed, global: result.global };
    }

    if (result.stop) {
      const { state, reason, nextEligibleAt } = result.stop;
      if (state === 'needs_reauth') {
        // eslint-disable-next-line no-await-in-loop
        await fencedJobUpdate(
          env.sql,
          lease,
          `state = 'needs_reauth', state_reason = ?, session_key_ct = NULL, session_key_iv = NULL,
           live_username = NULL, locked_until = 0, updated_at = ?`,
          [reason, nowSec],
        );
      } else if (state === 'daily_cap') {
        // eslint-disable-next-line no-await-in-loop
        await fencedJobUpdate(
          env.sql,
          lease,
          `locked_until = 0, last_run_at = ?, next_eligible_at = ?, state_reason = ?,
           probing = 1, consecutive_failures = 0, daily_window_start = ?, updated_at = ?`,
          [nowSec, nextEligibleAt ?? nowSec + DAILY_CAP_BACKOFF_SECONDS, reason, nowSec, nowSec],
        );
      } else {
        // eslint-disable-next-line no-await-in-loop
        await failJobAttempt(env.sql, lease, reason, nowSec);
      }
      return { batchesSent, scrobbled, failed };
    }

    // A successful send clears the probe flag: the cap has demonstrably lifted.
    if (lease.job.probing) {
      // eslint-disable-next-line no-await-in-loop
      await fencedJobUpdate(env.sql, lease, 'probing = 0, state_reason = NULL, updated_at = ?', [nowSec]);
      lease.job.probing = 0;
    }

    // eslint-disable-next-line no-await-in-loop
    await renewLease(env.sql, lease, nowSec, LEASE_SECONDS);
  }

  if (lease.job.cursor >= lease.job.total_tracks) {
    // Completion deletes the credential and the blob immediately. Holding
    // permanent write access to someone's account after the work is done is
    // the single largest thing that could go wrong with this feature.
    await fencedJobUpdate(
      env.sql,
      lease,
      `state = 'completed', session_key_ct = NULL, session_key_iv = NULL, live_username = NULL,
       locked_until = 0, completed_at = ?, purge_after = ?, updated_at = ?`,
      [nowSec, nowSec + 30 * 86400, nowSec],
    );
    await audit(env.sql, lease.job.id, lease.generation, 'completed', {
      scrobbled: lease.job.scrobbled_count,
      failed: lease.job.failed_count,
    }, nowSec);
  } else {
    await releaseJob(env.sql, lease, nowSec, nowSec + INTER_BATCH_DELAY_SECONDS);
  }

  return { batchesSent, scrobbled, failed };
}

/**
 * Counts a failed attempt and parks the job once it has failed enough times
 * that something is clearly wrong rather than merely flaky.
 */
async function failJobAttempt(
  sql: Sql,
  lease: JobLease,
  reason: string,
  nowSec: number,
): Promise<void> {
  const failures = lease.job.consecutive_failures + 1;
  if (failures >= MAX_CONSECUTIVE_FAILURES) {
    await fencedJobUpdate(
      sql,
      lease,
      `state = 'needs_attention', state_reason = ?, consecutive_failures = ?,
       locked_until = 0, updated_at = ?`,
      [reason, failures, nowSec],
    );
    return;
  }
  // Exponential, capped: 1, 2, 4 ... minutes.
  const backoff = Math.min(60 * 2 ** (failures - 1), 3600);
  await fencedJobUpdate(
    sql,
    lease,
    `consecutive_failures = ?, state_reason = ?, locked_until = 0, last_run_at = ?,
     next_eligible_at = ?, updated_at = ?`,
    [failures, reason, nowSec, nowSec + backoff, nowSec],
  );
}

/**
 * One cron tick.
 */
export async function runTick(env: SchedulerEnv, nowSec: number): Promise<TickReport> {
  const report: TickReport = {
    jobsConsidered: 0, jobsRun: 0, batchesSent: 0, scrobbled: 0, failed: 0, errors: [],
  };

  const control = await readControl(env.sql);
  if (!canRun(control, nowSec)) {
    report.skipped = control.halted
      ? `halted: ${control.halted_reason ?? 'unknown'}`
      : (control.paused ? `paused: ${control.paused_reason ?? 'unknown'}` : 'circuit breaker open');
    return report;
  }

  const due = await selectDueJobs(env.sql, nowSec, MAX_JOBS_PER_TICK);
  report.jobsConsidered = due.length;

  for (const job of due) {
    let outcome: JobOutcome | null = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      outcome = await runJob(env, job, nowSec);
    } catch (error) {
      if (error instanceof FencedError) {
        // Superseded. Abandoning is the correct response — retrying is exactly
        // the interleaving fencing exists to prevent.
        // eslint-disable-next-line no-continue
        continue;
      }
      report.errors.push(error instanceof Error ? error.message : String(error));
      // eslint-disable-next-line no-await-in-loop
      await audit(env.sql, job.id, null, 'tick_error', {
        message: error instanceof Error ? error.message : String(error),
      }, nowSec);
      // eslint-disable-next-line no-continue
      continue;
    }

    if (!outcome) {
      // eslint-disable-next-line no-continue
      continue;
    }
    report.jobsRun += 1;
    report.batchesSent += outcome.batchesSent;
    report.scrobbled += outcome.scrobbled;
    report.failed += outcome.failed;

    if (outcome.global) {
      if (outcome.global.kind === 'halt') {
        // eslint-disable-next-line no-await-in-loop
        await haltGlobally(env.sql, nowSec, outcome.global.reason);
      } else {
        const backoff = Math.min(
          BREAKER_BASE_BACKOFF_SECONDS * 2 ** control.breaker_trip_count,
          BREAKER_MAX_BACKOFF_SECONDS,
        );
        // eslint-disable-next-line no-await-in-loop
        await tripBreaker(env.sql, nowSec, backoff);
        // The active-job count is logged because it is the only way to learn
        // what concurrency actually triggers the IP limit.
        // eslint-disable-next-line no-await-in-loop
        await audit(env.sql, null, null, 'breaker_tripped', {
          reason: outcome.global.reason,
          activeJobs: due.length,
          backoff,
        }, nowSec);
      }
      report.skipped = `stopped early: ${outcome.global.kind}`;
      break;
    }
  }

  return report;
}
