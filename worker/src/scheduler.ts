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
  FENCE_PREDICATE,
  acquireJob,
  fencedJobUpdate,
  fencedBatch,
  releaseJob,
  renewLease,
  selectDueJobs,
  selectDrainableJobs,
  acquireJobForDrain,
  readControl,
  canRun,
  tripBreaker,
  haltGlobally,
  unresolvedSeconds,
  REPEATABLE_WINDOW_SECONDS,
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

type EntryState = 'accepted' | 'failed' | 'capped' | 'unknown' | 'bad_timestamp';

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
  // Last.fm returned no entry at this position, so "accepted" is the parser's
  // assumption rather than an observation. Advancing over it would report a
  // never-stored track as scrobbled and skip it permanently.
  if (!outcome.present) {
    return { state: 'unknown' };
  }
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
  // Codes 3 and 4 mean *our* timestamp assignment is wrong, not that the track
  // is unscrobbleable. Recording them as failures would let a broken clock or
  // a defective assignment quietly discard an entire import while reporting it
  // complete, so they are non-terminal: the job stalls and is parked for a
  // human instead.
  if (code === IgnoreCode.TimestampTooOld || code === IgnoreCode.TimestampTooNew) {
    return { state: 'bad_timestamp', code };
  }
  // An unrecognised non-zero code is not evidence of anything. Treat it as
  // unknown rather than inventing a terminal outcome for it.
  return { state: 'unknown', code };
}

/**
 * Hard ceiling on individually-recorded failures per job.
 *
 * D1's free tier allows 100k row writes per day across every job. A malformed
 * 100k-track import that Last.fm rejects wholesale would, at one row per
 * track, exhaust the entire day's budget by itself and stall every other
 * user's job. Past this point the count on the job row is still exact; only
 * the per-track detail list stops growing.
 */
export const MAX_RECORDED_FAILURES_PER_JOB = 2000;

/**
 * Statements recording the tracks Last.fm refused, so the completion page can
 * show them.
 *
 * Deliberately not `INSERT OR REPLACE`: a re-sent track that failed once and
 * succeeded later should keep neither row silently overwritten nor duplicated,
 * and the first recorded reason is the more informative one.
 *
 * Returned rather than executed so the caller can commit them in the same
 * transaction as the cursor they belong to.
 */
function failureStatements(
  lease: JobLease,
  entries: { index: number; track: JobTrack; reason: string; code?: number }[],
  nowSec: number,
): { query: string; params: unknown[] }[] {
  const room = MAX_RECORDED_FAILURES_PER_JOB - (lease.job.failed_count ?? 0);
  if (room <= 0) {
    return [];
  }
  return entries.slice(0, room).map((e) => ({
    query: `INSERT OR IGNORE INTO failures
              (job_id, track_index, artist, track, album, reason, ignore_code, created_at)
            SELECT ?, ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM jobs
                WHERE id = ? AND generation = ?
                  AND state NOT IN ('completed', 'failed', 'cancelled')
             )`,
    params: [
      lease.job.id,
      e.index,
      e.track.artist,
      e.track.track,
      e.track.album ?? null,
      e.reason,
      e.code ?? null,
      nowSec,
      lease.job.id,
      lease.generation,
    ],
  }));
}

/**
 * How long after a send we wait before believing Last.fm's recent-tracks feed.
 *
 * A scrobble that was accepted milliseconds before the tick died may not be
 * queryable yet. Reconciling too early sees nothing, concludes the batch was
 * lost, and re-sends all 50 — the exact duplicate storm reconciliation exists
 * to prevent.
 */
export const RECONCILE_GRACE_SECONDS = 120;

/** Reconciliations attempted per job per tick, to bound subrequest use. */
export const MAX_RECONCILES_PER_TICK = 3;

/** Pages of `user.getRecentTracks` fetched for one reconciliation window. */
export const MAX_RECONCILE_PAGES = 3;

/**
 * Resolves batches left in `sending` by a tick that died mid-flight.
 *
 * Runs before anything is sent, because the cursor is untrustworthy until it
 * does: the batch may have been stored by Last.fm, in which case re-sending it
 * blind duplicates up to 50 plays.
 *
 * The lookup key is the set of timestamps *we* assigned, matched together with
 * artist and track. Timestamps alone are not a key: a preserved original can
 * repeat across batches, and an unrelated scrobble the user made by hand can
 * land on a second we also used.
 */
async function reconcile(
  env: SchedulerEnv,
  lease: JobLease,
  sessionKey: string,
  nowSec: number,
): Promise<void> {
  const stale = await env.sql.all<any>(
    `SELECT * FROM batches
      WHERE job_id = ? AND state = 'sending' AND sent_at <= ?
      ORDER BY start_index ASC
      LIMIT ?`,
    [lease.job.id, nowSec - RECONCILE_GRACE_SECONDS, MAX_RECONCILES_PER_TICK],
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
      seen = await fetchWindow(env, lease.job.username, window, sessionKey);
    } catch (e) {
      /*
        A revoked key is not an inconclusive lookup, and must not be retried
        as one.

        Every other failure here is transient: the batch stays in `sending`,
        nothing is sent on top of it, and the next tick asks again. A dead
        credential never answers, so that loop has no exit — the job would
        back off to `needs_attention` (the wrong state, since the user needs
        the reconnect flow, not a maintainer) and take-back would be refused
        forever by the drain, which cannot abandon a batch while a decryptable
        credential is still present. Raising it lets the caller park the job
        for re-auth, after which the same window can actually be queried.
      */
      if (isInvalidSessionKeyError(e)) {
        throw e;
      }
      // An inconclusive lookup must not be read as "nothing was stored".
      // Leaving the batch in `sending` costs another reconciliation next tick;
      // treating it as lost costs the user 50 duplicate scrobbles.
      lookupFailed = true;
    }
    if (lookupFailed) {
      // eslint-disable-next-line no-continue
      continue;
    }

    const outcomes = matchOutcomes(assigned, seen);
    const advance = terminalPrefixLength(outcomes);
    const committed = outcomes.slice(0, advance);
    const accepted = committed.filter((o) => o.s === 'accepted').length;

    // eslint-disable-next-line no-await-in-loop
    await commitBatch(env, lease, nowSec, {
      batchId: batch.id,
      batchState: 'reconciled',
      outcomes,
      acceptedInBatch: outcomes.filter((o) => o.s === 'accepted').length,
      ignoredInBatch: outcomes.filter((o) => o.s !== 'accepted').length,
      startIndex: batch.start_index,
      advance,
      accepted,
      failed: 0,
      failureRows: [],
    });

    // eslint-disable-next-line no-await-in-loop
    await audit(env.sql, lease.job.id, lease.generation, 'reconciled', {
      batch: batch.id,
      recovered: accepted,
      unresolved: outcomes.length - accepted,
    }, nowSec);
  }
}

/**
 * Fetches a reconciliation window, paginating.
 *
 * `user.getRecentTracks` returns at most 200 entries per page. A batch mixing
 * a nearly-expired preserved timestamp with near-present synthetic ones spans
 * most of the 13-day window, and an active listener has far more than 200
 * scrobbles in that span — so a single page silently omits exactly the entries
 * we are trying to confirm, and every unconfirmed entry gets re-sent.
 */
async function fetchWindow(
  env: SchedulerEnv,
  username: string,
  window: { fromSec: number; toSec: number },
  sessionKey: string,
): Promise<{ artist: string; track: string; timestampSec: number }[]> {
  const all: { artist: string; track: string; timestampSec: number }[] = [];
  let to = window.toSec;
  for (let page = 0; page < MAX_RECONCILE_PAGES; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await env.lastfm.getRecentTracks(username, window.fromSec, to, sessionKey);
    all.push(...rows);
    if (rows.length < 200) {
      break;
    }
    // Walk backwards through the window. `to` is exclusive, so using the oldest
    // timestamp seen (rather than one below it) would re-fetch the same page.
    const oldest = Math.min(...rows.map((r) => r.timestampSec));
    if (oldest <= window.fromSec + 1) {
      break;
    }
    to = oldest;
  }
  return all;
}

/**
 * Decides, per entry, whether Last.fm already has it.
 *
 * Matching is on (timestamp, artist, track) as a *multiset*, because none of
 * the three is a key on its own:
 *
 *  - a timestamp can repeat across batches, since a preserved original is only
 *    deduplicated within the batch that preserved it;
 *  - the user's own listening lands in the same window;
 *  - Last.fm rewrites names, so exact comparison finds nothing.
 *
 * Consuming a match removes it, so two entries cannot both claim one stored
 * scrobble — which is how a genuinely unsent track used to be skipped.
 */
export function matchOutcomes(
  assigned: AssignedTrack[],
  seen: { artist: string; track: string; timestampSec: number }[],
): EntryOutcome[] {
  const pool = new Map<number, { artist: string; track: string }[]>();
  seen.forEach((s) => {
    const bucket = pool.get(s.timestampSec);
    if (bucket) {
      bucket.push(s);
    } else {
      pool.set(s.timestampSec, [s]);
    }
  });

  return assigned.map((a) => {
    const bucket = pool.get(a.timestampSec);
    const hit = bucket
      ? bucket.findIndex((s) => normalizeForMatch(s.track) === normalizeForMatch(a.track)
        && normalizeForMatch(s.artist) === normalizeForMatch(a.artist))
      : -1;
    if (!bucket || hit < 0) {
      return { i: a.index, s: 'unknown' as EntryState, t: a.timestampSec };
    }
    bucket.splice(hit, 1);
    return { i: a.index, s: 'accepted' as EntryState, t: a.timestampSec };
  });
}

interface BatchCommit {
  batchId: string;
  batchState: 'settled' | 'reconciled';
  outcomes: EntryOutcome[];
  acceptedInBatch: number;
  ignoredInBatch: number;
  startIndex: number;
  advance: number;
  accepted: number;
  failed: number;
  failureRows: { index: number; track: JobTrack; reason: string; code?: number }[];
}

/**
 * Commits a batch's outcomes, its failure rows and the cursor together.
 *
 * These used to be three separate statements, and the gaps between them were
 * the worst bug in the scheduler: a crash after the batch was marked settled
 * but before the cursor moved left a batch that reconciliation no longer
 * selects (it only looks at `sending`) sitting behind a cursor that still
 * points at its first entry — so the next tick re-sent all 50, and the tick
 * after that did it again.
 *
 * The cursor is committed with `MAX`, never assignment. Reconciliation of an
 * old batch can complete long after later batches have moved the cursor past
 * it, and writing `start_index + advance` there would rewind it and re-send
 * everything in between. Counters are advanced only when the cursor actually
 * moves, in the same statement, so a rewound commit cannot double-count.
 */
async function commitBatch(
  env: SchedulerEnv,
  lease: JobLease,
  nowSec: number,
  c: BatchCommit,
): Promise<void> {
  const newCursor = c.startIndex + c.advance;
  const statements: { query: string; params?: unknown[] }[] = [
    {
      query: `UPDATE batches
                 SET state = ?, outcomes = ?, accepted_count = ?, ignored_count = ?, settled_at = ?
               WHERE id = ? AND state = 'sending' AND ${FENCE_PREDICATE}`,
      params: [
        c.batchState,
        JSON.stringify(c.outcomes),
        c.acceptedInBatch,
        c.ignoredInBatch,
        nowSec,
        c.batchId,
        lease.job.id,
        lease.generation,
      ],
    },
    ...failureStatements(lease, c.failureRows, nowSec),
  ];

  if (c.advance > 0) {
    statements.push({
      query: `UPDATE jobs
                 SET scrobbled_count = scrobbled_count + (CASE WHEN ? > cursor THEN ? ELSE 0 END),
                     failed_count = failed_count + (CASE WHEN ? > cursor THEN ? ELSE 0 END),
                     consecutive_failures = 0,
                     cursor = MAX(cursor, ?),
                     updated_at = ?
               WHERE id = ? AND generation = ?
                 AND state NOT IN ('completed', 'failed', 'cancelled')`,
      params: [
        newCursor, c.accepted,
        newCursor, c.failed,
        newCursor, nowSec,
        lease.job.id, lease.generation,
      ],
    });
  }

  await fencedBatch(env.sql, lease, nowSec, statements);

  if (c.advance > 0 && newCursor > lease.job.cursor) {
    lease.job.cursor = newCursor;
    lease.job.scrobbled_count += c.accepted;
    lease.job.failed_count += c.failed;
    lease.job.consecutive_failures = 0;
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
      // Carried so `assignTimestamps` can tell a pinned retry from a listen
      // date and hold it for the full collision window.
      reTagged: t.reTagged,
    })),
    nowSec,
    job.synthetic_floor ?? 0,
  );

  // Rebase the in-batch indices onto the job's blob so outcomes survive
  // independently of where the batch started.
  const rebased = assignment.assigned.map((a) => ({ ...a, index: startIndex + a.index }));
  /*
    An index that a previous send already spent a second on keeps that second,
    forever.

    A batch row is written before the POST, so a track whose outcome is not
    terminal may already be on the account — whether the whole batch was
    abandoned without an answer, or Last.fm answered and simply did not echo
    that entry. Those tracks stay after the cursor and are sent again — by this
    loop, if the job resumes rather than being taken back. Sending them under a
    *fresh* second is what turns "may already be stored" into "is now stored
    twice", because Last.fm deduplicates on the whole (artist, track,
    timestamp) tuple.

    Repeating the identical second instead makes the re-send a no-op when the
    original landed and a normal scrobble when it did not. This is the same
    trick the export plays when handing tracks back to the browser, and it has
    to hold on both sides or the guarantee is only as good as which of them
    happens to send next.

    It also makes the *second* abandonment harmless. If a retry could mint a
    new second, an index could accumulate two candidate tuples and no reader
    could tell which one the account holds — repeating either might duplicate.
    Reusing means an index only ever has one, so repeating it is always
    idempotent, however many times the answer is lost.
  */
  const reused = (await unresolvedSeconds(
    env.sql, job.id, nowSec, REPEATABLE_WINDOW_SECONDS,
  )).repeatable;
  const assigned = rebased.map((a) => {
    const prior = reused.get(a.index);
    if (prior === undefined || prior.artist !== a.artist || prior.track !== a.track) {
      return a;
    }
    return { ...a, timestampSec: prior.sec };
  });
  const batchId = randomId();

  // Step 1: the mapping is durable *before* the send, and in the same
  // transaction as the synthetic floor it consumed. Splitting them lets a
  // crash in between hand the same seconds to a later batch, at which point
  // reconciliation can match one batch against another's scrobbles.
  await fencedBatch(env.sql, lease, nowSec, [
    {
      query: `INSERT INTO batches
                (id, job_id, generation, start_index, entry_count, state, assigned_timestamps, sent_at, created_at)
              VALUES (?, ?, ?, ?, ?, 'sending', ?, ?, ?)`,
      params: [batchId, job.id, lease.generation, startIndex, assigned.length,
        JSON.stringify(assigned), nowSec, nowSec],
    },
    {
      query: `UPDATE jobs SET synthetic_floor = ?, updated_at = ?
               WHERE id = ? AND generation = ?
                 AND state NOT IN ('completed', 'failed', 'cancelled')`,
      params: [assignment.syntheticFloor, nowSec, job.id, lease.generation],
    },
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
    /*
      A rejected pin is final, where a rejected assignment of ours is not.

      Codes 3 and 4 are normally evidence that this worker chose badly, so they
      stall the job rather than discarding tracks. A pinned retry is the one
      case where there is nothing to choose: that second is the only one that
      can ever be sent for this track, because any other risks landing beside a
      play the browser may already have stored. Leaving it non-terminal would
      park the job forever on a track no future attempt can change.
    */
    const state: EntryState = (c.state === 'bad_timestamp' && assigned[i].pinnedRetry)
      ? 'failed'
      : c.state;
    return { i: assigned[i].index, s: state, c: c.code, t: assigned[i].timestampSec };
  });

  const capped = outcomes.some((o) => o.s === 'capped');
  const advance = terminalPrefixLength(outcomes);

  // Only the committed prefix is counted. Entries past the first non-terminal
  // one will be sent again, so counting them here makes `scrobbled_count`
  // exceed `total_tracks` and lists tracks as failed that later succeed.
  const committed = outcomes.slice(0, advance);
  const accepted = committed.filter((o) => o.s === 'accepted').length;
  const failedEntries = committed
    .map((o, i) => ({ o, i }))
    .filter((x) => x.o.s === 'failed');

  await commitBatch(env, lease, nowSec, {
    batchId,
    batchState: 'settled',
    outcomes,
    acceptedInBatch: outcomes.filter((o) => o.s === 'accepted').length,
    ignoredInBatch: outcomes.filter((o) => o.s !== 'accepted').length,
    startIndex,
    advance,
    accepted,
    failed: failedEntries.length,
    failureRows: failedEntries.map((x) => ({
      index: outcomes[x.i].i,
      track: tracks[x.i],
      reason: result.outcomes[x.i].ignoredMessage || 'Rejected by Last.fm',
      code: outcomes[x.i].c,
    })),
  });

  // A timestamp Last.fm calls too old or too new is our bug, not the user's
  // data, and it is never terminal — so if a whole batch comes back that way
  // the job would otherwise re-send it forever. Park it for a human instead.
  const badTimestamps = outcomes.filter((o) => o.s === 'bad_timestamp');
  if (badTimestamps.length > 0) {
    await audit(env.sql, job.id, lease.generation, 'timestamp_rejected', {
      count: badTimestamps.length,
      sample: badTimestamps.slice(0, 3),
    }, nowSec);
  }
  /*
    Pinned refusals are deliberately absent from `badTimestamps` above, so they
    neither stall the batch nor park the job. They are still worth seeing: each
    one is a play whose fate is genuinely unknown, reported to the user as a
    failure because the alternative was a possible duplicate.
  */
  const pinnedRefusals = result.outcomes
    .map((o, i) => ({ c: classifyOutcome(o), i }))
    .filter((x) => x.c.state === 'bad_timestamp' && assigned[x.i].pinnedRetry);
  if (pinnedRefusals.length > 0) {
    await audit(env.sql, job.id, lease.generation, 'pinned_retry_refused', {
      count: pinnedRefusals.length,
      sample: pinnedRefusals.slice(0, 3).map((x) => ({
        index: assigned[x.i].index,
        timestampSec: assigned[x.i].timestampSec,
        code: x.c.code,
      })),
    }, nowSec);
  }
  if (advance === 0 && badTimestamps.length > 0) {
    return {
      sent: assigned.length,
      accepted: 0,
      failed: 0,
      stop: {
        state: 'needs_attention',
        reason: 'Last.fm rejected every timestamp in a batch; assignment is wrong',
      },
    };
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
  // Acquisition uses wall time rather than the tick's frozen `nowSec`. Jobs
  // later in the tick are claimed minutes after it started, and a lease
  // computed from the start time can be expired before it is even taken.
  const lease = await acquireJob(
    env.sql, job.id, Math.floor(Date.now() / 1000), LEASE_SECONDS,
  );
  if (!lease) {
    // Another tick has it, or the user paused it between selection and now.
    // Losing this race costs one job, not the tick.
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

  try {
    await reconcile(env, lease, sessionKey, nowSec);
  } catch (error) {
    if (!isInvalidSessionKeyError(error)) {
      throw error;
    }
    /*
      The same parking `sendBatch` does for a revoked key, reached one step
      earlier. The credential is deleted and the slot released so the user is
      offered the reconnect flow; the unresolved batch stays in `sending` and
      is reconciled with the new key once they return.
    */
    await fencedJobUpdate(
      env.sql,
      lease,
      `state = 'needs_reauth', state_reason = ?, session_key_ct = NULL, session_key_iv = NULL,
       live_username = NULL, locked_until = 0, updated_at = ?`,
      ['Last.fm session key was revoked', nowSec],
    );
    await audit(env.sql, lease.job.id, lease.generation, 'reauth_during_reconcile', null, nowSec);
    return empty;
  }

  /*
    Nothing may be sent while a batch's fate is still unknown.

    `reconcile` deliberately leaves an inconclusive batch in `sending` rather
    than reading a failed lookup as "nothing was stored". But the cursor has
    not advanced, so falling through to the send loop rebuilds that same slice
    and `assignTimestamps` gives every re-tagged track in it a *different*
    synthetic second. If the original request did land, that is up to fifty
    duplicated plays — the exact outcome reconciliation exists to prevent, and
    reconciliation's own comment about running "before anything is sent" is
    only true if this gate exists.

    A pinned entry would survive that, because it repeats its second exactly.
    The other forty-nine would not.
  */
  const unresolved = await env.sql.first<{ n: number; oldest: number }>(
    `SELECT COUNT(*) AS n, MIN(sent_at) AS oldest FROM batches
      WHERE job_id = ? AND state = 'sending'`,
    [lease.job.id],
  );
  if (unresolved && unresolved.n > 0) {
    /*
      A missing `sent_at` is treated as long past, never as fresh. Such a row
      is invisible to reconciliation's `sent_at <= ?` predicate, so calling it
      recent would renew the grace deadline every tick and wait on it forever
      without ever counting a failure. Falling through to the failure path
      instead reaches a human.
    */
    const graceEndsAt = (unresolved.oldest || 0) + RECONCILE_GRACE_SECONDS;
    if (graceEndsAt > nowSec) {
      /*
        Not a failure — just too early to ask. A scrobble accepted moments
        before the tick died is not queryable yet, so waiting out the grace
        period is the normal path after a crash and must not spend one of the
        job's ten attempts before it has even been tried once.
      */
      await fencedJobUpdate(
        env.sql,
        lease,
        `locked_until = 0, last_run_at = ?, next_eligible_at = ?, state_reason = ?,
         updated_at = ?`,
        [nowSec, graceEndsAt + 1, 'Waiting to reconcile a batch left in flight', nowSec],
      );
      return empty;
    }
    // Past the grace period and still unknown: the lookup itself is failing.
    // Back off and, after enough attempts, ask a human — rather than guessing.
    await failJobAttempt(
      env.sql,
      lease,
      'A batch is still in flight and could not be reconciled; not sending more',
      nowSec,
    );
    return empty;
  }

  let batchesSent = 0;
  let scrobbled = 0;
  let failed = 0;
  const budget = lease.job.probing ? 1 : MAX_BATCHES_PER_JOB_PER_TICK;
  const batchSize = lease.job.probing ? PROBE_BATCH_SIZE : MAX_SCROBBLES_PER_BATCH;

  for (let n = 0; n < budget; n += 1) {
    if (lease.job.cursor >= lease.job.total_tracks) {
      break;
    }

    // Re-read the user's intent before every send. A pause or cancel arriving
    // mid-tick does not bump the generation, so fencing does not see it, and
    // this loop would otherwise keep scrobbling for up to three more batches
    // after the user pressed stop.
    // eslint-disable-next-line no-await-in-loop
    const current = await env.sql.first<{ state: string }>(
      'SELECT state FROM jobs WHERE id = ?', [lease.job.id],
    );
    if (!current || current.state !== 'active') {
      return { batchesSent, scrobbled, failed };
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

    const cursorBefore = lease.job.cursor;
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
      } else if (state === 'needs_attention') {
        // eslint-disable-next-line no-await-in-loop
        await fencedJobUpdate(
          env.sql,
          lease,
          "state = 'needs_attention', state_reason = ?, locked_until = 0, updated_at = ?",
          [reason, nowSec],
        );
      } else if (state === 'daily_cap') {
        /*
          Recorded so the cap's reset behaviour can actually be measured. The
          worker deliberately does not assume "midnight UTC" — it waits 24h and
          probes — but which of a fixed clock or a rolling window it really is
          determines whether that 24h wait is right or is costing every capped
          user most of a day. Pairing this with the `daily_cap_lifted` record
          below gives both the elapsed time and the wall-clock hour of each.
        */
        // eslint-disable-next-line no-await-in-loop
        await audit(env.sql, lease.job.id, lease.generation, 'daily_cap_hit', {
          scrobbledBeforeCap: lease.job.scrobbled_count,
          sinceWindowStart: lease.job.daily_window_start
            ? nowSec - lease.job.daily_window_start
            : null,
        }, nowSec);
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

    // A send that committed nothing must end the tick for this job. Otherwise
    // the loop reads the same cursor, builds the same batch and sends it
    // again — up to four identical batches per tick, forever. Counting it as
    // a failed attempt gives it backoff and, eventually, a human.
    if (lease.job.cursor <= cursorBefore) {
      // eslint-disable-next-line no-await-in-loop
      await failJobAttempt(
        env.sql,
        lease,
        'Batch produced no terminal outcome; nothing could be committed',
        nowSec,
      );
      return { batchesSent, scrobbled, failed };
    }

    // A successful send clears the probe flag: the cap has demonstrably lifted.
    if (lease.job.probing) {
      // The other half of the cap measurement. `daily_window_start` is the
      // moment the cap was hit, so this is the first observed instant at which
      // scrobbling was possible again — an upper bound on the true reset,
      // bounded below by the probe interval.
      // eslint-disable-next-line no-await-in-loop
      await audit(env.sql, lease.job.id, lease.generation, 'daily_cap_lifted', {
        cappedForSeconds: lease.job.daily_window_start
          ? nowSec - lease.job.daily_window_start
          : null,
      }, nowSec);
      // eslint-disable-next-line no-await-in-loop
      await fencedJobUpdate(env.sql, lease, 'probing = 0, state_reason = NULL, updated_at = ?', [nowSec]);
      lease.job.probing = 0;
    }

    // Renewal uses wall time, not the tick's frozen `nowSec`. Every batch
    // spends real seconds waiting on Last.fm, so writing `tickStart + 180`
    // each time renews nothing: after a few slow requests the lease is already
    // expired in real terms, another tick claims the job, and both send.
    // eslint-disable-next-line no-await-in-loop
    await renewLease(env.sql, lease, Math.floor(Date.now() / 1000), LEASE_SECONDS);
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
 * Backs a job off after an unexpected throw, without a lease.
 *
 * `failJobAttempt` needs a live lease, and by the time an exception reaches
 * `runTick` we may not have one — the throw could have come from acquisition
 * itself. This is deliberately unfenced and matches on the job id alone, but
 * it only ever adds backoff, so the worst a stale caller can do is delay a job
 * by a few minutes.
 */
async function releaseFailedJob(
  sql: Sql,
  jobId: string,
  reason: string,
  nowSec: number,
): Promise<void> {
  await sql.run(
    `UPDATE jobs
        SET consecutive_failures = consecutive_failures + 1,
            state_reason = ?,
            state = CASE WHEN consecutive_failures + 1 >= ? THEN 'needs_attention' ELSE state END,
            locked_until = 0,
            last_run_at = ?,
            next_eligible_at = MAX(next_eligible_at, ?),
            updated_at = ?
      WHERE id = ? AND state = 'active'`,
    [reason, MAX_CONSECUTIVE_FAILURES, nowSec, nowSec + 300, nowSec, jobId],
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
      // An unexpected throw leaves the lease held and no backoff recorded, so
      // the job would come straight back every tick, throw again, and — being
      // the least recently run — crowd out healthy jobs indefinitely. Release
      // it through the normal failure path so it backs off and is eventually
      // parked for a human.
      // eslint-disable-next-line no-await-in-loop
      await releaseFailedJob(
        env.sql,
        job.id,
        error instanceof Error ? error.message : String(error),
        nowSec,
      );
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
      // Returned rather than broken out of. A halt or a tripped breaker is a
      // statement about Last.fm or the API key, and draining also talks to
      // Last.fm — reconciling now would keep issuing exactly the requests the
      // stop condition exists to prevent.
      return report;
    }
  }

  await drainPausedJobs(env, nowSec, report);

  return report;
}

/**
 * Settles batches left in flight on jobs the user has since paused.
 *
 * Pausing stops new sends but cannot un-send a batch whose response was lost.
 * Those sit in `sending` until reconciliation decides their fate — and the
 * normal path can never do it, because both `selectDueJobs` and `acquireJob`
 * require `active`. Without this pass a paused job with one lost response
 * would refuse to export forever, which is the escape hatch the whole feature
 * promises.
 *
 * Nothing is ever *sent* here. The pass only asks Last.fm what it already has.
 */
async function drainPausedJobs(
  env: SchedulerEnv,
  nowSec: number,
  report: TickReport,
): Promise<void> {
  /*
    An abandoned take-back reverts first.

    `exporting` is deliberately neither schedulable nor resumable, so a client
    that closed its tab midway would otherwise park the job permanently. The
    claim deadline lives in `locked_until`, so a lapsed one is exactly a
    lapsed lease.

    It reverts to whatever it was claimed from. Sending it to `paused`
    unconditionally would clear a `needs_attention` or `needs_reauth` the user
    still has to act on, turning a job that is waiting for them into one that
    merely looks idle.
  */
  const reverted = await env.sql.all<{ id: string }>(
    `UPDATE jobs
        SET state = CASE
              WHEN export_prev_state IN ('paused', 'needs_attention', 'needs_reauth', 'dormant')
                THEN export_prev_state
              ELSE 'paused'
            END,
            export_claim = NULL,
            export_prev_state = NULL,
            locked_until = 0,
            updated_at = ?
      WHERE state = 'exporting' AND locked_until <= ?
      RETURNING id`,
    [nowSec, nowSec],
  );
  if (reverted.length > 0) {
    // Counted from RETURNING: D1's `changes` includes the rows the inactivity
    // trigger rewrites, so it would report every job twice.
    await audit(env.sql, null, null, 'export_claim_expired', { jobs: reverted.length }, nowSec);
  }

  const drainable = await selectDrainableJobs(
    env.sql, nowSec, nowSec - RECONCILE_GRACE_SECONDS, MAX_JOBS_PER_TICK,
  );

  for (const job of drainable) {
    // eslint-disable-next-line no-await-in-loop
    await drainOneJob(env, job.id, nowSec, report, false);
  }
}

/**
 * Drains a single paused job on demand.
 *
 * Take-back is interactive, and the cron interval is five minutes. A batch
 * left `sending` moments after a tick would otherwise keep the export at 409
 * for the whole of the next interval — longer than any tolerable spinner —
 * so the endpoint that discovers the problem asks for the fix directly rather
 * than waiting for the sweep to come round.
 *
 * Same rules as the sweep: reconcile only, never send, and release back to
 * `paused`.
 */
export async function drainJobOnDemand(
  env: SchedulerEnv,
  jobId: string,
  nowSec: number,
): Promise<void> {
  const report: TickReport = {
    jobsConsidered: 0, jobsRun: 0, batchesSent: 0, scrobbled: 0, failed: 0, errors: [],
  };
  const control = await readControl(env.sql);
  if (control.halted || control.paused || control.breaker_open_until > nowSec) {
    // Reconciling talks to Last.fm, which is precisely what a halt or a
    // tripped breaker exists to stop.
    return;
  }
  const eligible = await selectDrainableJobs(
    env.sql, nowSec, nowSec - RECONCILE_GRACE_SECONDS, MAX_JOBS_PER_TICK, true,
  );
  if (!eligible.some((j) => j.id === jobId)) {
    // Too new to reconcile safely, already settled, or not drainable at all.
    // The grace period is not negotiable: a batch whose response is merely
    // slow must not be reconciled out from under itself.
    return;
  }
  await drainOneJob(env, jobId, nowSec, report, true);
}

async function drainOneJob(
  env: SchedulerEnv,
  jobId: string,
  nowSec: number,
  report: TickReport,
  /*
    Whether the user has actually asked for their tracks back.

    Abandoning an unresolved batch re-queues tracks whose fate is unknown, so
    it can duplicate up to a batch's worth of plays. That is the right trade
    only when the alternative is worse — a take-back that can never complete.
    The background sweep has no such alternative: a `needs_reauth` job is
    waiting for the user to *reconnect and continue*, and abandoning under it
    hands those tracks straight back to the send loop.
  */
  userRequested: boolean,
): Promise<void> {
  const lease = await acquireJobForDrain(
    env.sql, jobId, Math.floor(Date.now() / 1000), LEASE_SECONDS,
  );
  if (!lease) {
    // Resumed or claimed elsewhere between selection and now.
    return;
  }
  try {
    if (!lease.job.session_key_ct || !lease.job.session_key_iv) {
      // No credential left, so the batches can never be resolved against
      // Last.fm. Abandoning them is what lets the export proceed; their
      // tracks stay after the cursor and are handed back, which risks a
      // duplicate but never a loss — the safe direction for a job the user
      // has already asked to stop. Only for a job they have: see
      // `userRequested`.
      if (userRequested) {
        await env.sql.run(
          `UPDATE batches SET state = 'abandoned', settled_at = ?
            WHERE job_id = ? AND state = 'sending'`,
          [nowSec, lease.job.id],
        );
        await audit(env.sql, lease.job.id, lease.generation, 'drain_abandoned_no_credential', null, nowSec);
      }
    } else {
      const sessionKey = await decryptCredential(
        { ciphertext: lease.job.session_key_ct, iv: lease.job.session_key_iv },
        env.credentialSecret,
        lease.job.id,
      );
      if (sessionKey) {
        try {
          await reconcile(env, lease, sessionKey, nowSec);
        } catch (error) {
          if (!isInvalidSessionKeyError(error)) {
            throw error;
          }
          /*
            A credential that is present but revoked answers nothing, ever, so
            waiting for it blocks the export forever — the user asked to stop
            and would have no way to get their tracks back.

            Treated exactly like the no-credential case above, and gated the
            same way: the batch is abandoned only when the user has actually
            asked for their tracks back, because its tracks then stay after the
            cursor and are handed back, which risks a duplicate but never a
            loss. Under the background sweep there is nothing to unblock, so
            the batch is left for the key the user is expected to reconnect
            with.
          */
          if (userRequested) {
            await env.sql.run(
              `UPDATE batches SET state = 'abandoned', settled_at = ?
                WHERE job_id = ? AND state = 'sending'`,
              [nowSec, lease.job.id],
            );
            await audit(env.sql, lease.job.id, lease.generation, 'drain_abandoned_revoked_credential', null, nowSec);
          }
        }
      }
    }
  } catch (error) {
    if (!(error instanceof FencedError)) {
      report.errors.push(`drain ${jobId}: ${(error as Error).message}`);
    }
  }
  // Only the lease is released; the state is left exactly as acquired.
  // Draining must never restart a job the user stopped, and must not clear a
  // `needs_attention` they still have to act on.
  await env.sql.run(
    `UPDATE jobs SET locked_until = 0, updated_at = ?
      WHERE id = ? AND generation = ?`,
    [nowSec, lease.job.id, lease.generation],
  );
}
