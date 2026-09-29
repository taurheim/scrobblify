/**
 * Housekeeping: stalled jobs give their slot back, and finished jobs give
 * their track data back.
 *
 * Before this, nothing ever read `inactivity_deadline` or `purge_after`. A user
 * who paused and never came back held a concurrency slot, a key that can
 * scrobble as them, and their listening history, indefinitely.
 */
import { DatabaseSync } from 'node:sqlite';
import { schemaSql, blobSchemaSql } from './schema';
import {
  Sql, SqlResult, JobRow, countCommittedSlots, selectDrainableJobs,
} from '../src/store';
import { gzip, uploadChunk, BLOB_SWEEP_JOB_LIMIT } from '../src/chunks';
import { SqlBlobs } from '../src/blobs';
import { encryptCredential, sha256Hex, randomId } from '../src/crypto';
import {
  markDormant,
  expireDormant,
  purgeFinishedJobs,
  runHousekeeping,
  DORMANT_AFTER_SECONDS,
  EXPIRE_AFTER_SECONDS,
  PURGE_AFTER_SECONDS,
  HOUSEKEEPING_STEP_LIMIT,
  PURGE_JOB_LIMIT,
} from '../src/housekeeping';

const NOW = 1_800_000_000;
const DAY = 86400;
const CRED = 'credential-secret-for-tests-01234';

/**
 * node:sqlite behind `Sql`, reporting `changes` the way D1 does.
 *
 * SQLite's own `changes()` leaves out rows a trigger touched. D1's
 * `meta.changes` does not — measured against Miniflare: a one-row UPDATE that
 * fires `jobs_inactivity_deadline` reports 2. A test adapter that disagreed
 * with production here would pass code that counts with `changes`.
 */
class D1FaithfulSql implements Sql {
  public statements = 0;

  constructor(private db: DatabaseSync) {}

  private total(): number {
    return Number((this.db.prepare('SELECT total_changes() AS n').get() as any).n);
  }

  private count(query: string, params: unknown[]) {
    if (params.length > 100) {
      throw new Error(`too many SQL variables: ${params.length}`);
    }
    this.statements += 1;
  }

  async all<T>(query: string, params: unknown[] = []): Promise<T[]> {
    this.count(query, params);
    return this.db.prepare(query).all(...(params as any[])) as T[];
  }

  async first<T>(query: string, params: unknown[] = []): Promise<T | null> {
    this.count(query, params);
    return (this.db.prepare(query).get(...(params as any[])) ?? null) as T | null;
  }

  async run(query: string, params: unknown[] = []): Promise<SqlResult> {
    this.count(query, params);
    const before = this.total();
    this.db.prepare(query).run(...(params as any[]));
    return { changes: this.total() - before };
  }

  async batch(statements: { query: string; params?: unknown[] }[]): Promise<SqlResult[]> {
    const out: SqlResult[] = [];
    for (const s of statements) {
      // eslint-disable-next-line no-await-in-loop
      out.push(await this.run(s.query, s.params ?? []));
    }
    return out;
  }
}

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

function freshSql(): D1FaithfulSql {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql());
  return new D1FaithfulSql(db);
}

function freshBlobs(): SqlBlobs {
  const db = new DatabaseSync(':memory:');
  db.exec(blobSchemaSql());
  return new SqlBlobs(new D1FaithfulSql(db));
}

/**
 * Seeds an `active` job and moves it into `state` at `parkedAt` through a real
 * state change, so the trigger sets the deadline exactly as production does.
 */
async function seedJob(sql: Sql, opts: {
  username?: string; state?: string; parkedAt?: number; withChunk?: SqlBlobs;
} = {}): Promise<string> {
  const id = randomId();
  const username = opts.username ?? `user-${id.slice(0, 8)}`;
  const cred = await encryptCredential('sk', CRED, id);
  await sql.run(
    `INSERT INTO jobs (id, username, live_username, state, algorithm_version, total_tracks,
        session_key_ct, session_key_iv, created_at, updated_at, credential_expires_at)
     VALUES (?, ?, ?, 'active', 1, 10, ?, ?, ?, ?, ?)`,
    [id, username, username, cred.ciphertext, cred.iv, NOW - 90 * DAY, NOW - 90 * DAY, NOW + 60 * DAY],
  );
  if (opts.withChunk) {
    const gz = await gzip(new TextEncoder().encode('{"artist":"A","track":"T","album":"","originalTimestampSec":1}'));
    await uploadChunk(sql, opts.withChunk, {
      jobId: id,
      chunkIndex: 0,
      startIndex: 0,
      digest: await sha256Hex(gz),
      entryCount: 1,
      compressed: gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) as ArrayBuffer,
    }, NOW - 90 * DAY);
  }
  if (opts.state && opts.state !== 'active') {
    await sql.run(
      'UPDATE jobs SET state = ?, updated_at = ? WHERE id = ?',
      [opts.state, opts.parkedAt ?? NOW, id],
    );
  }
  return id;
}

async function job(sql: Sql, id: string): Promise<JobRow> {
  return (await sql.first<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]))!;
}

async function auditCount(sql: Sql, id: string | null, event: string): Promise<number> {
  const row = await sql.first<{ n: number }>(
    id === null
      ? 'SELECT COUNT(*) AS n FROM audit WHERE event = ?'
      : 'SELECT COUNT(*) AS n FROM audit WHERE job_id = ? AND event = ?',
    id === null ? [event] : [id, event],
  );
  return Number(row!.n);
}

async function addTrackRows(sql: Sql, id: string) {
  await sql.run(
    `INSERT INTO batches (id, job_id, generation, start_index, entry_count, state,
        assigned_timestamps, sent_at, created_at)
     VALUES (?, ?, 0, 0, 1, 'settled', ?, ?, ?)`,
    [randomId(), id, JSON.stringify([{ index: 0, artist: 'A', track: 'T', timestampSec: 1 }]), NOW, NOW],
  );
  await sql.run(
    `INSERT INTO failures (job_id, track_index, artist, track, album, reason, created_at)
     VALUES (?, 0, 'A', 'T', '', 'rejected', ?)`,
    [id, NOW],
  );
}

async function rowCount(sql: Sql, table: string, id: string): Promise<number> {
  const row = await sql.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE job_id = ?`, [id]);
  return Number(row!.n);
}

async function main() {
  console.log('\n-- the trigger starts the clock on entering a parked state --');
  {
    const sql = freshSql();
    const id = await seedJob(sql, { state: 'paused', parkedAt: NOW });
    check('pausing sets the dormancy deadline',
      (await job(sql, id)).inactivity_deadline === NOW + DORMANT_AFTER_SECONDS,
      (await job(sql, id)).inactivity_deadline);

    // What the background drain does to a parked job every five minutes.
    await sql.run('UPDATE jobs SET updated_at = ?, locked_until = 0 WHERE id = ?', [NOW + 5 * DAY, id]);
    check('a write that does not change the state leaves it alone',
      (await job(sql, id)).inactivity_deadline === NOW + DORMANT_AFTER_SECONDS);

    // Re-asserting the same state is not activity either.
    await sql.run("UPDATE jobs SET state = 'paused', updated_at = ? WHERE id = ?", [NOW + 6 * DAY, id]);
    check('nor does setting the state it already has',
      (await job(sql, id)).inactivity_deadline === NOW + DORMANT_AFTER_SECONDS);

    await sql.run("UPDATE jobs SET state = 'needs_attention', updated_at = ? WHERE id = ?", [NOW + 7 * DAY, id]);
    check('moving to another parked state restarts it',
      (await job(sql, id)).inactivity_deadline === NOW + 7 * DAY + DORMANT_AFTER_SECONDS);

    await sql.run("UPDATE jobs SET state = 'dormant', updated_at = ? WHERE id = ?", [NOW + 8 * DAY, id]);
    check('going dormant sets the expiry deadline instead',
      (await job(sql, id)).inactivity_deadline === NOW + 8 * DAY + EXPIRE_AFTER_SECONDS);

    const r = await sql.run("UPDATE jobs SET state = 'paused', updated_at = ? WHERE id = ?", [NOW + 9 * DAY, id]);
    check('the adapter counts trigger rows the way D1 does', r.changes === 2, r.changes);
  }

  console.log('\n-- a job left parked goes dormant --');
  {
    const sql = freshSql();
    const due = await seedJob(sql, { state: 'paused', parkedAt: NOW - DORMANT_AFTER_SECONDS });
    const early = await seedJob(sql, { state: 'paused', parkedAt: NOW - DORMANT_AFTER_SECONDS + 1 });
    const reauth = await seedJob(sql, { state: 'needs_reauth', parkedAt: NOW - 20 * DAY });
    const attention = await seedJob(sql, { state: 'needs_attention', parkedAt: NOW - 20 * DAY });
    const running = await seedJob(sql);
    const leased = await seedJob(sql, { state: 'paused', parkedAt: NOW - 20 * DAY });
    await sql.run('UPDATE jobs SET locked_until = ? WHERE id = ?', [NOW + 60, leased]);
    const before = (await job(sql, due)).generation;

    const moved = await markDormant(sql, NOW);
    check('reports how many jobs it moved, not how many rows D1 says changed',
      moved === 3, moved);

    const d = await job(sql, due);
    check('a job at its deadline goes dormant', d.state === 'dormant', d.state);
    check('its key is deleted', d.session_key_ct === null && d.session_key_iv === null);
    check('it releases the account', d.live_username === null, d.live_username);
    check('the generation is bumped, so a stale tick cannot write over it',
      d.generation === before + 1, d.generation);
    check('the expiry clock starts', d.inactivity_deadline === NOW + EXPIRE_AFTER_SECONDS,
      d.inactivity_deadline);
    check('and it is recorded', await auditCount(sql, due, 'job_dormant') === 1);

    check('one second early is left alone', (await job(sql, early)).state === 'paused');
    check('needs_reauth goes dormant too', (await job(sql, reauth)).state === 'dormant');
    check('needs_attention goes dormant too', (await job(sql, attention)).state === 'dormant');
    check('a running job is never touched, however old', (await job(sql, running)).state === 'active');
    check('a job under a lease is skipped', (await job(sql, leased)).state === 'paused');
  }

  console.log('\n-- a job parked before the migration still expires --');
  {
    // Rows parked before 005 have no deadline; `updated_at` stands in for it.
    const sql = freshSql();
    const id = await seedJob(sql, { state: 'paused', parkedAt: NOW - 20 * DAY });
    await sql.run('UPDATE jobs SET inactivity_deadline = NULL WHERE id = ?', [id]);
    await markDormant(sql, NOW);
    check('falls back to updated_at', (await job(sql, id)).state === 'dormant');
  }

  console.log('\n-- dormancy is bounded per pass --');
  {
    const sql = freshSql();
    for (let i = 0; i < HOUSEKEEPING_STEP_LIMIT + 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await seedJob(sql, { state: 'paused', parkedAt: NOW - 20 * DAY });
    }
    const first = await markDormant(sql, NOW);
    check('one pass moves at most the step limit', first === HOUSEKEEPING_STEP_LIMIT, first);
    const second = await markDormant(sql, NOW);
    check('the next pass takes the rest', second === 3, second);
  }

  console.log('\n-- a dormant job does not hold a slot --');
  {
    const sql = freshSql();
    await seedJob(sql, { state: 'paused', parkedAt: NOW - 20 * DAY });
    check('a parked job holds one', await countCommittedSlots(sql) === 1);
    await markDormant(sql, NOW);
    check('a dormant one does not', await countCommittedSlots(sql) === 0);
  }

  console.log('\n-- the background drain leaves dormant jobs alone --');
  {
    /*
      A dormant job has no key, so the sweep could never reconcile its batch —
      it would lease the job every five minutes, forever. Only a take-back,
      which may abandon the batch, has a reason to drain it.
    */
    const sql = freshSql();
    const id = await seedJob(sql, { state: 'dormant', parkedAt: NOW - DAY });
    await sql.run(
      `INSERT INTO batches (id, job_id, generation, start_index, entry_count, state,
          assigned_timestamps, sent_at, created_at)
       VALUES (?, ?, 0, 0, 1, 'sending', '[]', ?, ?)`,
      [randomId(), id, NOW - DAY, NOW - DAY],
    );
    const swept = await selectDrainableJobs(sql, NOW, NOW - 120, 10);
    check('the sweep does not select it', !swept.some((j) => j.id === id));
    const onDemand = await selectDrainableJobs(sql, NOW, NOW - 120, 10, true);
    check('a take-back can', onDemand.some((j) => j.id === id));
  }

  console.log('\n-- a dormant job is eventually cancelled --');
  {
    const sql = freshSql();
    const due = await seedJob(sql, { state: 'dormant', parkedAt: NOW - EXPIRE_AFTER_SECONDS });
    const early = await seedJob(sql, { state: 'dormant', parkedAt: NOW - EXPIRE_AFTER_SECONDS + 1 });
    const expired = await expireDormant(sql, NOW);
    check('counts jobs, not rows', expired === 1, expired);
    const d = await job(sql, due);
    check('cancelled at its deadline', d.state === 'cancelled', d.state);
    check('with a purge date', d.purge_after === NOW + PURGE_AFTER_SECONDS, d.purge_after);
    check('and an end date', d.completed_at === NOW, d.completed_at);
    check('recorded', await auditCount(sql, due, 'job_expired') === 1);
    check('one second early is left alone', (await job(sql, early)).state === 'dormant');
  }

  console.log('\n-- purge removes track data and keeps the job row --');
  {
    /*
      The row stays. Its `import_id` is what `/import/:id` answers from, and
      that answer is what keeps a stale browser copy of a handed-over queue
      from sending it all again. The row names no tracks.
    */
    const sql = freshSql();
    const due = await seedJob(sql, { state: 'cancelled', parkedAt: NOW - 40 * DAY });
    await sql.run('UPDATE jobs SET purge_after = ?, import_id = ? WHERE id = ?', [NOW, 'import-id-0123456789', due]);
    await addTrackRows(sql, due);
    const early = await seedJob(sql, { state: 'completed', parkedAt: NOW - DAY });
    await sql.run('UPDATE jobs SET purge_after = ? WHERE id = ?', [NOW + 1, early]);
    await addTrackRows(sql, early);
    const legacy = await seedJob(sql, { state: 'failed', parkedAt: NOW - PURGE_AFTER_SECONDS });
    await addTrackRows(sql, legacy);
    const live = await seedJob(sql, { state: 'paused', parkedAt: NOW - 40 * DAY });
    await sql.run('UPDATE jobs SET purge_after = ? WHERE id = ?', [NOW - DAY, live]);
    await addTrackRows(sql, live);
    await sql.run(
      "INSERT INTO audit (id, job_id, generation, event, detail, created_at) VALUES (?, ?, 0, 'x', NULL, ?)",
      [randomId(), due, NOW],
    );

    const purged = await purgeFinishedJobs(sql, NOW);
    check('reports the jobs purged', purged === 2, purged);
    check('failures are gone', await rowCount(sql, 'failures', due) === 0);
    check('batches are gone', await rowCount(sql, 'batches', due) === 0);
    const kept = await job(sql, due);
    check('the job row is kept', !!kept);
    check('with its import id', kept.import_id === 'import-id-0123456789', kept.import_id);
    check('the audit trail is kept', await rowCount(sql, 'audit', due) >= 1);
    check('recorded', await auditCount(sql, null, 'jobs_purged') === 1);

    check('a job before its purge date is left alone', await rowCount(sql, 'failures', early) === 1);
    check('a job without a purge date uses its end + 30 days',
      await rowCount(sql, 'failures', legacy) === 0);
    check('a job that has not finished is never purged', await rowCount(sql, 'failures', live) === 1);

    check('a second pass finds nothing left to do', await purgeFinishedJobs(sql, NOW) === 0);
  }

  console.log('\n-- purge waits for the blob sweep --');
  {
    const sql = freshSql();
    const blobs = freshBlobs();
    const id = await seedJob(sql, { state: 'cancelled', parkedAt: NOW - 40 * DAY, withChunk: blobs });
    await sql.run('UPDATE jobs SET purge_after = ? WHERE id = ?', [NOW - DAY, id]);
    await addTrackRows(sql, id);
    check('not while it still has chunks', await purgeFinishedJobs(sql, NOW) === 0);
  }

  console.log('\n-- the hourly pass does all of it, in order, inside the budget --');
  {
    const sql = freshSql();
    const blobs = freshBlobs();
    const stale = await seedJob(sql, {
      state: 'paused', parkedAt: NOW - 50 * DAY, withChunk: blobs,
    });
    await addTrackRows(sql, stale);
    const report = await runHousekeeping(sql, blobs, NOW);
    check('went dormant', report.dormant === 1, report);
    let j = await job(sql, stale);
    check('dormant, not straight to cancelled', j.state === 'dormant', j.state);
    check('its tracks are kept for take-back', await rowCount(sql, 'chunks', stale) === 1);

    await runHousekeeping(sql, blobs, NOW + EXPIRE_AFTER_SECONDS);
    j = await job(sql, stale);
    check('cancelled once the expiry passes', j.state === 'cancelled', j.state);
    check('and its uploaded tracks are swept in the same pass',
      await rowCount(sql, 'chunks', stale) === 0);
    check('including the batches that name them', await rowCount(sql, 'batches', stale) === 0);
    check('failures stay for the completion page', await rowCount(sql, 'failures', stale) === 1);

    await runHousekeeping(sql, blobs, NOW + EXPIRE_AFTER_SECONDS + PURGE_AFTER_SECONDS);
    check('and go at the purge date', await rowCount(sql, 'failures', stale) === 0);
    check('the job row survives it all', !!(await job(sql, stale)));
  }

  console.log('\n-- the pass stays inside the Free plan\'s 50 queries --');
  {
    /*
      Workers Free allows 50 D1 queries per invocation, and a batch counts
      each statement. Every step is filled to its limit here.
    */
    const sql = freshSql();
    const blobs = freshBlobs();
    for (let i = 0; i < HOUSEKEEPING_STEP_LIMIT; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await seedJob(sql, { state: 'paused', parkedAt: NOW - 20 * DAY });
      // eslint-disable-next-line no-await-in-loop
      await seedJob(sql, { state: 'dormant', parkedAt: NOW - 40 * DAY });
    }
    for (let i = 0; i < BLOB_SWEEP_JOB_LIMIT + 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await seedJob(sql, { state: 'completed', parkedAt: NOW - DAY, withChunk: blobs });
    }
    for (let i = 0; i < PURGE_JOB_LIMIT + 2; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const id = await seedJob(sql, { state: 'cancelled', parkedAt: NOW - 40 * DAY });
      // eslint-disable-next-line no-await-in-loop
      await sql.run('UPDATE jobs SET purge_after = ? WHERE id = ?', [NOW - DAY, id]);
      // eslint-disable-next-line no-await-in-loop
      await addTrackRows(sql, id);
    }
    const blobSql = (blobs as any).sql as D1FaithfulSql;
    sql.statements = 0;
    blobSql.statements = 0;
    const report = await runHousekeeping(sql, blobs, NOW);
    const used = sql.statements + blobSql.statements;
    check('every step did work', report.dormant > 0 && report.expired > 0
      && report.swept > 0 && report.purged > 0, report);
    check('at most 50 queries', used <= 50, used);
  }

  if (failures > 0) {
    console.log(`\n${failures} FAILED`);
    process.exit(1);
  }
  console.log('\nALL PASSED');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
