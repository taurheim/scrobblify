/**
 * Storage layer: a minimal SQL interface plus the fencing primitives every
 * other module builds on.
 *
 * The interface exists so the worker can move off Cloudflare without a rewrite
 * (spec "Portability requirements"). D1's own binding satisfies it, and so does
 * a thin wrapper over `pg` or `better-sqlite3`. Nothing outside this file may
 * import a D1 type.
 */

export interface SqlResult {
  /** Rows changed by the statement. Load-bearing: every CAS checks it. */
  changes: number;
}

export interface Sql {
  all<T>(query: string, params?: unknown[]): Promise<T[]>;
  first<T>(query: string, params?: unknown[]): Promise<T | null>;
  run(query: string, params?: unknown[]): Promise<SqlResult>;
  /**
   * Statements applied together. D1 batches are atomic; a Postgres
   * implementation would use a transaction.
   */
  batch(statements: { query: string; params?: unknown[] }[]): Promise<SqlResult[]>;
}

export type JobState =
  /**
   * Row exists and owns a credential, but the blob is still uploading. Holds a
   * slot and is never scheduled. The credential has to be written in the same
   * statement as the row that owns it, or a crash leaves unreachable garbage
   * holding write access to someone's account — which is why the job row is
   * created here rather than at activation.
   */
  | 'pending'
  | 'active'
  | 'paused'
  /**
   * A take-back is reading the queue out. Not schedulable and not resumable:
   * the export names the tracks after the cursor, and the client cancels once
   * it has them, so anything sent between those two moments is both handed
   * back and already scrobbled. Checking quiescence without claiming it left
   * that window open to any other tab pressing Resume.
   *
   * `locked_until` doubles as the claim deadline, so an abandoned take-back
   * falls back to `paused` instead of stranding the job.
   */
  | 'exporting'
  | 'needs_reauth'
  | 'needs_attention'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * States that consume one of the scarce concurrency slots.
 *
 * Parked states count, because a job sitting in `needs_reauth` still holds a
 * credential. They are released by the inactivity deadline, not by being
 * excluded here.
 */
export const SLOT_CONSUMING_STATES: JobState[] = [
  'pending',
  'active',
  'paused',
  'exporting',
  'needs_reauth',
  'needs_attention',
];

export function isTerminalJobState(state: JobState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

export type HandoffState =
  | 'issued'
  | 'exchanging'
  | 'pending_upload'
  | 'finalizing'
  | 'active'
  | 'failed'
  | 'reaped';

export function isTerminalHandoffState(state: HandoffState): boolean {
  return state === 'active' || state === 'failed' || state === 'reaped';
}

export interface JobRow {
  id: string;
  username: string;
  /**
   * Nullable mirror of `username`, NULLed on terminal states. A UNIQUE index
   * on it is what makes "one live job per user" a database guarantee rather
   * than a code convention — two tabs genuinely race here.
   */
  live_username: string | null;
  state: JobState;
  state_reason: string | null;
  generation: number;
  locked_until: number;
  session_key_ct: string | null;
  session_key_iv: string | null;
  algorithm_version: number;
  schema_version: number;
  manifest_key: string | null;
  total_tracks: number;
  cursor: number;
  scrobbled_count: number;
  failed_count: number;
  last_run_at: number;
  next_eligible_at: number;
  consecutive_failures: number;
  daily_window_start: number | null;
  daily_window_count: number;
  probing: number;
  /** Lowest synthetic scrobble second used so far. See `002_synthetic_floor.sql`. */
  synthetic_floor: number;
  created_at: number;
  updated_at: number;
  credential_expires_at: number;
  inactivity_deadline: number | null;
  completed_at: number | null;
  purge_after: number | null;
}

/**
 * A claim on a job. Holding one is *not* a guarantee of exclusivity — see
 * `acquireJob` — it is a token that makes this tick's writes rejectable once a
 * later tick has taken over.
 */
export interface JobLease {
  job: JobRow;
  generation: number;
}

/**
 * Thrown when a write is rejected because another tick has taken the job.
 * Callers should abandon the tick rather than retry: the job is someone else's
 * now, and retrying is exactly the interleaving fencing exists to prevent.
 */
export class FencedError extends Error {
  constructor(public readonly jobId: string, public readonly generation: number) {
    super(`Job ${jobId} is no longer held at generation ${generation}`);
    this.name = 'FencedError';
  }
}

/**
 * Atomically claims a job and bumps its fencing token.
 *
 * The CAS is what matters. A lease timestamp alone does not provide mutual
 * exclusion: a tick that stalls past `locked_until` keeps running, and its
 * in-flight writes can land after a second tick has claimed the job. By
 * bumping `generation` in the same statement that takes the lease, and
 * conditioning every subsequent write on that generation, a superseded tick's
 * writes are rejected instead of silently interleaving.
 *
 * `UPDATE ... RETURNING` keeps this to a single round trip and, more
 * importantly, to a single statement — reading then writing would reintroduce
 * the race this is meant to close.
 *
 * Returns null when another tick won the race.
 */
export async function acquireJob(
  sql: Sql,
  jobId: string,
  nowSec: number,
  leaseSeconds: number,
): Promise<JobLease | null> {
  const rows = await sql.all<JobRow>(
    `UPDATE jobs
        SET generation = generation + 1,
            locked_until = ?,
            updated_at = ?
      WHERE id = ?
        AND locked_until < ?
        AND state = 'active'
      RETURNING *`,
    [nowSec + leaseSeconds, nowSec, jobId, nowSec],
  );
  if (rows.length === 0) {
    return null;
  }
  const job = rows[0];
  return { job, generation: job.generation };
}

/**
 * Claims a *paused* job so its unsettled batches can be reconciled.
 *
 * Pausing is not the same as being finished. A tick that lost its Last.fm
 * response leaves a batch in `sending`, and only reconciliation can decide
 * whether those scrobbles landed. But `acquireJob` requires `active`, and
 * `selectDueJobs` only returns `active`, so a job paused with a batch in that
 * state would never be looked at again — and `exportJob` refuses to export
 * while one exists, which would make "take my progress back" permanently
 * impossible without first resuming the very job the user is trying to stop.
 *
 * Fencing is identical to the normal path: the generation is bumped, so any
 * write from a superseded tick is rejected.
 */
export async function acquireJobForDrain(
  sql: Sql,
  jobId: string,
  nowSec: number,
  leaseSeconds: number,
): Promise<JobLease | null> {
  const rows = await sql.all<JobRow>(
    `UPDATE jobs
        SET generation = generation + 1,
            locked_until = ?,
            updated_at = ?
      WHERE id = ?
        AND locked_until < ?
        AND state = 'paused'
      RETURNING *`,
    [nowSec + leaseSeconds, nowSec, jobId, nowSec],
  );
  if (rows.length === 0) {
    return null;
  }
  const job = rows[0];
  return { job, generation: job.generation };
}

/**
 * Paused jobs holding a batch old enough to be worth reconciling.
 *
 * The grace period is the caller's, so this stays honest about the fact that
 * "still sending" and "response lost" are indistinguishable until enough time
 * has passed.
 */
export async function selectDrainableJobs(
  sql: Sql,
  nowSec: number,
  staleBefore: number,
  limit: number,
): Promise<JobRow[]> {
  return sql.all<JobRow>(
    `SELECT j.* FROM jobs j
      WHERE j.state = 'paused'
        AND j.locked_until < ?
        AND EXISTS (
          SELECT 1 FROM batches b
           WHERE b.job_id = j.id AND b.state = 'sending' AND b.sent_at <= ?
        )
      ORDER BY j.updated_at ASC
      LIMIT ?`,
    [nowSec, staleBefore, limit],
  );
}

/**
 * Runs an UPDATE against `jobs` conditioned on the lease still being current.
 *
 * Every write a tick makes must go through here (or carry the same
 * `AND generation = ?` predicate), or fencing is decorative.
 *
 * Terminal states are additionally protected. Fencing alone does not save
 * them: cancelling a job does *not* bump the generation, so a tick still
 * holding a valid lease would happily overwrite `cancelled` with `completed`
 * — telling the user their import finished when they had stopped it.
 */
export async function fencedJobUpdate(
  sql: Sql,
  lease: JobLease,
  setClause: string,
  params: unknown[],
): Promise<void> {
  const result = await sql.run(
    `UPDATE jobs SET ${setClause}
      WHERE id = ? AND generation = ?
        AND state NOT IN ('completed', 'failed', 'cancelled')`,
    [...params, lease.job.id, lease.generation],
  );
  if (result.changes === 0) {
    throw new FencedError(lease.job.id, lease.generation);
  }
}

/**
 * A statement guarded by the same predicate as `fencedJobUpdate`, for use
 * inside a `batch`.
 *
 * Writes to `batches`, `failures` and the cursor must commit together or not
 * at all. Issuing them as separate statements leaves a window in which the
 * batch is recorded as settled while the cursor still points at its start —
 * and the next tick then re-sends all 50 entries, every tick, forever.
 */
export function fencedStatement(
  lease: JobLease,
  query: string,
  params: unknown[],
): { query: string; params: unknown[] } {
  return { query, params: [...params, lease.job.id, lease.generation] };
}

/**
 * The guard clause dependent tables use to inherit the job's fence.
 *
 * A row in `batches` or `failures` belongs to a job, so conditioning its write
 * on that job's generation is what stops a superseded tick's delayed write
 * from resurrecting a batch a newer tick has already reconciled.
 */
export const FENCE_PREDICATE = `job_id IN (
  SELECT id FROM jobs
   WHERE id = ? AND generation = ?
     AND state NOT IN ('completed', 'failed', 'cancelled')
)`;

/**
 * Applies statements atomically, failing loudly if the lease was lost.
 *
 * The sentinel is what makes fencing detectable: `batch` reports rows changed
 * per statement, so a sentinel that changed nothing means the fence predicate
 * did not hold, and because D1 batches are transactional none of the other
 * statements took effect either.
 */
export async function fencedBatch(
  sql: Sql,
  lease: JobLease,
  nowSec: number,
  statements: { query: string; params?: unknown[] }[],
): Promise<void> {
  const sentinel = {
    query: `UPDATE jobs SET updated_at = ?
             WHERE id = ? AND generation = ?
               AND state NOT IN ('completed', 'failed', 'cancelled')`,
    params: [nowSec, lease.job.id, lease.generation],
  };
  const results = await sql.batch([...statements, sentinel]);
  if (results.length === 0 || results[results.length - 1].changes === 0) {
    throw new FencedError(lease.job.id, lease.generation);
  }
}

/**
 * Extends a lease mid-tick. A long batch must not let its lease lapse while it
 * is still making progress, because that invites a second tick to take over and
 * duplicate work that is about to succeed.
 */
export async function renewLease(
  sql: Sql,
  lease: JobLease,
  nowSec: number,
  leaseSeconds: number,
): Promise<void> {
  await fencedJobUpdate(sql, lease, 'locked_until = ?, updated_at = ?', [
    nowSec + leaseSeconds,
    nowSec,
  ]);
}

/**
 * Releases a lease so the job is immediately eligible again, without bumping
 * the generation — this tick is done, but it was never superseded.
 */
export async function releaseJob(
  sql: Sql,
  lease: JobLease,
  nowSec: number,
  nextEligibleAt: number,
): Promise<void> {
  await fencedJobUpdate(
    sql,
    lease,
    'locked_until = 0, last_run_at = ?, next_eligible_at = ?, updated_at = ?',
    [nowSec, nextEligibleAt, nowSec],
  );
}

/**
 * Selects due jobs in round-robin order.
 *
 * Ordering by `last_run_at` ascending rather than by creation is deliberate:
 * FIFO would let a single 100k import starve every job behind it for a month.
 *
 * This deliberately returns candidates rather than claiming them. Claiming is
 * `acquireJob`, one at a time, so that losing a race costs one job rather than
 * the whole tick.
 */
export async function selectDueJobs(
  sql: Sql,
  nowSec: number,
  limit: number,
): Promise<JobRow[]> {
  return sql.all<JobRow>(
    `SELECT * FROM jobs
      WHERE state = 'active'
        AND next_eligible_at <= ?
        AND locked_until < ?
      ORDER BY last_run_at ASC
      LIMIT ?`,
    [nowSec, nowSec, limit],
  );
}

export interface Control {
  paused: number;
  paused_reason: string | null;
  halted: number;
  halted_reason: string | null;
  breaker_open_until: number;
  breaker_trip_count: number;
  max_concurrent_jobs: number;
}

export async function readControl(sql: Sql): Promise<Control> {
  const row = await sql.first<Control>('SELECT * FROM control WHERE id = 1');
  if (!row) {
    throw new Error('control row missing; schema not initialised');
  }
  return row;
}

/**
 * Whether any work may run at all. Checked first on every tick so that flipping
 * the kill switch freezes jobs mid-flight rather than tearing them down.
 */
export function canRun(control: Control, nowSec: number): boolean {
  return !control.paused && !control.halted && control.breaker_open_until <= nowSec;
}

/**
 * Opens the global circuit breaker.
 *
 * Global, not per-job, because error 29 is documented as an *IP* limit and
 * every job shares one egress IP. Backing off a single job would leave the
 * others hammering the limit that is actually shared.
 *
 * `MAX(breaker_open_until, ?)` so a concurrent tick observing a worse rate
 * limit cannot have its longer backoff shortened by this one.
 */
export async function tripBreaker(
  sql: Sql,
  nowSec: number,
  backoffSeconds: number,
): Promise<void> {
  await sql.run(
    `UPDATE control
        SET breaker_open_until = MAX(breaker_open_until, ?),
            breaker_trip_count = breaker_trip_count + 1,
            breaker_last_tripped_at = ?,
            updated_at = ?
      WHERE id = 1`,
    [nowSec + backoffSeconds, nowSec, nowSec],
  );
}

/**
 * Halts every job. Reserved for error 26 (suspended API key), where retrying
 * makes the suspension worse and no job can succeed until a human intervenes.
 */
export async function haltGlobally(sql: Sql, nowSec: number, reason: string): Promise<void> {
  await sql.run(
    'UPDATE control SET halted = 1, halted_reason = ?, updated_at = ? WHERE id = 1',
    [reason, nowSec],
  );
}

/**
 * Counts jobs occupying a concurrency slot.
 *
 * Parked states count, because a job sitting in `needs_reauth` still holds a
 * credential and a slot. They are released by the inactivity deadline, not by
 * being ignored here.
 */
export async function countActiveSlots(sql: Sql): Promise<number> {
  const placeholders = SLOT_CONSUMING_STATES.map(() => '?').join(', ');
  const row = await sql.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM jobs WHERE state IN (${placeholders})`,
    SLOT_CONSUMING_STATES,
  );
  return row ? Number(row.n) : 0;
}

/**
 * Total slots committed: live jobs, plus handoffs that have not yet produced a
 * job row.
 *
 * The `job_id IS NULL` predicate is what stops a handoff being counted twice.
 * Once the exchange succeeds the handoff owns a `pending` job, which
 * `countActiveSlots` already counts; counting both would halve real capacity.
 */
export async function countCommittedSlots(sql: Sql): Promise<number> {
  const used = await countActiveSlots(sql);
  const pending = await sql.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM handoffs
      WHERE state IN ('issued','exchanging','pending_upload','finalizing')
        AND job_id IS NULL`,
  );
  return used + (pending ? Number(pending.n) : 0);
}

/**
 * Reserves a slot by inserting the handoff row.
 *
 * Reserved at preflight rather than at activation so capacity cannot fill
 * between a user authorising with Last.fm and their job going active — which
 * would strand a captured credential with nowhere to run.
 *
 * The uniqueness of `live_username` across *both* tables is what stops two tabs
 * starting two handoffs, and stops a handoff starting while a job already runs.
 * Returns false rather than throwing on contention, because "someone else got
 * there first" is an expected outcome the UI must explain, not an error.
 */
export async function reserveSlot(
  sql: Sql,
  handoff: {
    id: string;
    username: string;
    payloadDigest: string;
    trackCount: number;
    chunkCount: number;
    declaredBytes: number;
    algorithmVersion: number;
  },
  nowSec: number,
  ttlSeconds: number,
  maxConcurrent: number,
): Promise<{ ok: true } | { ok: false; reason: 'at_capacity' | 'already_live' }> {
  const live = await sql.first<{ n: number }>(
    'SELECT COUNT(*) AS n FROM handoffs WHERE live_username = ?',
    [handoff.username],
  );
  const liveJob = await sql.first<{ n: number }>(
    'SELECT COUNT(*) AS n FROM jobs WHERE live_username = ?',
    [handoff.username],
  );
  if ((live && Number(live.n) > 0) || (liveJob && Number(liveJob.n) > 0)) {
    return { ok: false, reason: 'already_live' };
  }

  const used = await countCommittedSlots(sql);
  if (used >= maxConcurrent) {
    return { ok: false, reason: 'at_capacity' };
  }

  try {
    await sql.run(
      `INSERT INTO handoffs (
         id, state, username, live_username, payload_digest, track_count,
         chunk_count, declared_bytes, algorithm_version, exchange_attempts,
         created_at, updated_at, expires_at
       ) VALUES (?, 'issued', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      [
        handoff.id,
        handoff.username,
        handoff.username,
        handoff.payloadDigest,
        handoff.trackCount,
        handoff.chunkCount,
        handoff.declaredBytes,
        handoff.algorithmVersion,
        nowSec,
        nowSec,
        nowSec + ttlSeconds,
      ],
    );
  } catch (e) {
    // The unique index on live_username is the real arbiter; the count above is
    // only an early out. A tab that loses this race gets the same answer.
    return { ok: false, reason: 'already_live' };
  }
  return { ok: true };
}

/**
 * Advances a handoff, but only from the state the caller expects.
 *
 * Duplicate callbacks are routine — link scanners, prefetchers, a user's second
 * tab — so every transition is a CAS. The loser of a race must return the
 * winner's outcome rather than performing a second `auth.getSession`, since the
 * token is single-use and the second call would fail.
 *
 * Terminal states clear `live_username`, releasing the slot and the uniqueness
 * constraint in the same statement that ends the handoff.
 */
export async function transitionHandoff(
  sql: Sql,
  id: string,
  from: HandoffState,
  to: HandoffState,
  nowSec: number,
  extraSet = '',
  extraParams: unknown[] = [],
): Promise<boolean> {
  const clearsSlot = isTerminalHandoffState(to) && to !== 'active';
  const liveClause = clearsSlot || to === 'active' ? ', live_username = NULL' : '';
  const result = await sql.run(
    `UPDATE handoffs
        SET state = ?, updated_at = ?${liveClause}${extraSet ? `, ${extraSet}` : ''}
      WHERE id = ? AND state = ?`,
    [to, nowSec, ...extraParams, id, from],
  );
  return result.changes > 0;
}
