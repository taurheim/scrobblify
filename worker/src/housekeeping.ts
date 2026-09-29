/**
 * The hourly pass that lets go of what nobody is coming back for.
 *
 * Nothing used to read `inactivity_deadline` or `purge_after`. A user who
 * paused a job and never returned held one of the 50 concurrency slots, a key
 * that can scrobble as them, and their listening history, indefinitely. Once
 * the slots filled that way, the feature was closed to everyone.
 *
 * Four steps, in this order:
 *
 *   1. A job parked (`paused`, `needs_reauth`, `needs_attention`) for
 *      `DORMANT_AFTER_SECONDS` goes `dormant`: its key is deleted and its slot
 *      freed, but its tracks are kept so the user can still take them back or
 *      reconnect.
 *   2. A job dormant for `EXPIRE_AFTER_SECONDS` is cancelled.
 *   3. Finished jobs' uploaded tracks are swept (`sweepTerminalJobBlobs`).
 *   4. `PURGE_AFTER_SECONDS` after a job ends, its failure list and batch
 *      records go too. The job row is kept: see `purgeFinishedJobs`.
 *
 * The deadlines are set by the `jobs_inactivity_deadline` trigger in
 * `schema/005_dormancy.sql`, whose constants must match the ones here.
 *
 * Every step is set-based and bounded, because Workers Free allows 50 D1
 * queries per invocation and this shares its cron with nothing that can wait.
 */
import { Sql } from './store';
import { BlobStore, sweepTerminalJobBlobs } from './chunks';
import { randomId } from './crypto';

/** How long a job may sit parked before it gives up its key and slot. */
export const DORMANT_AFTER_SECONDS = 14 * 86400;

/** How long a dormant job keeps its tracks before it is cancelled. */
export const EXPIRE_AFTER_SECONDS = 30 * 86400;

/** How long a finished job keeps its failure list for the completion page. */
export const PURGE_AFTER_SECONDS = 30 * 86400;

/**
 * Jobs one step moves per pass. Sixteen audit rows of six parameters fit in a
 * single INSERT under D1's 100-parameter limit.
 */
export const HOUSEKEEPING_STEP_LIMIT = 16;

/** Jobs one pass purges. Each id is bound twice, once per table. */
export const PURGE_JOB_LIMIT = 20;

const PARKED_STATES_SQL = "('paused', 'needs_reauth', 'needs_attention')";
const TERMINAL_STATES_SQL = "('completed', 'failed', 'cancelled')";

export interface HousekeepingReport {
  dormant: number;
  expired: number;
  swept: number;
  purged: number;
}

async function auditJobs(
  sql: Sql,
  jobs: { id: string; generation: number }[],
  event: string,
  nowSec: number,
): Promise<void> {
  if (jobs.length === 0) {
    return;
  }
  await sql.run(
    `INSERT INTO audit (id, job_id, generation, event, detail, created_at)
     VALUES ${jobs.map(() => '(?, ?, ?, ?, NULL, ?)').join(', ')}`,
    jobs.flatMap((j) => [randomId(), j.id, j.generation, event, nowSec]),
  );
}

/**
 * Parked jobs past their deadline become `dormant`.
 *
 * `locked_until` is respected so a drain or a take-back holding the job is
 * never pulled out from under. The generation is bumped so a superseded tick
 * still holding an old lease cannot write over the new state.
 *
 * Counts come from `RETURNING`, not `changes`: D1 includes rows the trigger
 * touched, so every job here would be counted twice.
 */
export async function markDormant(sql: Sql, nowSec: number): Promise<number> {
  const moved = await sql.all<{ id: string; generation: number }>(
    `UPDATE jobs
        SET state = 'dormant',
            state_reason = 'Not touched for 14 days, so its Last.fm key was deleted',
            generation = generation + 1,
            session_key_ct = NULL, session_key_iv = NULL, live_username = NULL,
            locked_until = 0, updated_at = ?
      WHERE id IN (
        SELECT id FROM jobs
         WHERE state IN ${PARKED_STATES_SQL}
           AND locked_until <= ?
           AND COALESCE(inactivity_deadline, updated_at + ?) <= ?
         ORDER BY COALESCE(inactivity_deadline, updated_at + ?)
         LIMIT ?
      )
      RETURNING id, generation`,
    [
      nowSec, nowSec, DORMANT_AFTER_SECONDS, nowSec, DORMANT_AFTER_SECONDS,
      HOUSEKEEPING_STEP_LIMIT,
    ],
  );
  await auditJobs(sql, moved, 'job_dormant', nowSec);
  return moved.length;
}

/**
 * Dormant jobs past their deadline are cancelled.
 *
 * Their tracks are then swept by the next step of the same pass. The job is
 * still reported by `GET /scrobblify/job` until the purge date, so a user who
 * comes back late is told what happened rather than shown nothing.
 */
export async function expireDormant(sql: Sql, nowSec: number): Promise<number> {
  const expired = await sql.all<{ id: string; generation: number }>(
    `UPDATE jobs
        SET state = 'cancelled',
            state_reason = 'Not touched for 44 days, so it was cancelled',
            generation = generation + 1,
            session_key_ct = NULL, session_key_iv = NULL, live_username = NULL,
            locked_until = 0, completed_at = ?, purge_after = ?, updated_at = ?
      WHERE id IN (
        SELECT id FROM jobs
         WHERE state = 'dormant'
           AND locked_until <= ?
           AND COALESCE(inactivity_deadline, updated_at + ?) <= ?
         ORDER BY COALESCE(inactivity_deadline, updated_at + ?)
         LIMIT ?
      )
      RETURNING id, generation`,
    [
      nowSec, nowSec + PURGE_AFTER_SECONDS, nowSec,
      nowSec, EXPIRE_AFTER_SECONDS, nowSec, EXPIRE_AFTER_SECONDS,
      HOUSEKEEPING_STEP_LIMIT,
    ],
  );
  await auditJobs(sql, expired, 'job_expired', nowSec);
  return expired.length;
}

/**
 * Deletes a finished job's failure list and batch records after its purge
 * date.
 *
 * **The job row is kept.** Its `import_id` is what `GET /scrobblify/import/:id`
 * answers from, and `known: true` is what stops a stale browser copy of a
 * handed-over queue from sending it all again. Deleting the row would lift
 * that block a month after the job ended and turn every track the server sent
 * into a duplicate. The row itself names no tracks.
 *
 * Only jobs whose chunks are gone qualify, so a job the blob sweep has not
 * reached yet is left for a later pass rather than orphaning its blobs.
 * `purge_after` is not set on every terminal path, so the end date stands in.
 */
export async function purgeFinishedJobs(sql: Sql, nowSec: number): Promise<number> {
  const due = await sql.all<{ id: string }>(
    `SELECT j.id AS id FROM jobs j
      WHERE j.state IN ${TERMINAL_STATES_SQL}
        AND COALESCE(j.purge_after, j.completed_at + ?, j.updated_at + ?) <= ?
        AND NOT EXISTS (SELECT 1 FROM chunks c WHERE c.job_id = j.id)
        AND (EXISTS (SELECT 1 FROM failures f WHERE f.job_id = j.id)
             OR EXISTS (SELECT 1 FROM batches b WHERE b.job_id = j.id))
      LIMIT ?`,
    [PURGE_AFTER_SECONDS, PURGE_AFTER_SECONDS, nowSec, PURGE_JOB_LIMIT],
  );
  if (due.length === 0) {
    return 0;
  }
  const ids = due.map((d) => d.id);
  const placeholders = ids.map(() => '?').join(', ');
  await sql.batch([
    { query: `DELETE FROM failures WHERE job_id IN (${placeholders})`, params: ids },
    { query: `DELETE FROM batches WHERE job_id IN (${placeholders})`, params: ids },
  ]);
  await sql.run(
    'INSERT INTO audit (id, job_id, generation, event, detail, created_at) VALUES (?, NULL, NULL, ?, ?, ?)',
    [randomId(), 'jobs_purged', JSON.stringify({ jobs: ids.length }), nowSec],
  );
  return ids.length;
}

export async function runHousekeeping(
  sql: Sql,
  blobs: BlobStore,
  nowSec: number,
): Promise<HousekeepingReport> {
  const dormant = await markDormant(sql, nowSec);
  const expired = await expireDormant(sql, nowSec);
  const swept = await sweepTerminalJobBlobs(sql, blobs);
  const purged = await purgeFinishedJobs(sql, nowSec);
  return {
    dormant, expired, swept, purged,
  };
}
