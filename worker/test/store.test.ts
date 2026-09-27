/**
 * Store tests. These run the real schema against SQLite via `node:sqlite`, so
 * the SQL itself is exercised rather than a mock of it.
 *
 * Node built-ins are fine here: this file is a test, never bundled into the
 * worker.
 */
import { DatabaseSync } from 'node:sqlite';
import { schemaSql } from './schema';
import {
  Sql,
  SqlResult,
  acquireJob,
  fencedJobUpdate,
  renewLease,
  releaseJob,
  selectDueJobs,
  readControl,
  canRun,
  tripBreaker,
  haltGlobally,
  countCommittedSlots,
  reserveSlot,
  transitionHandoff,
  FencedError,
} from '../src/store';


class NodeSql implements Sql {
  constructor(private db: DatabaseSync) {}

  async all<T>(query: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(query).all(...(params as any[])) as T[];
  }

  async first<T>(query: string, params: unknown[] = []): Promise<T | null> {
    const row = this.db.prepare(query).get(...(params as any[]));
    return (row ?? null) as T | null;
  }

  async run(query: string, params: unknown[] = []): Promise<SqlResult> {
    const r = this.db.prepare(query).run(...(params as any[]));
    return { changes: Number(r.changes) };
  }

  async batch(statements: { query: string; params?: unknown[] }[]): Promise<SqlResult[]> {
    const out: SqlResult[] = [];
    this.db.exec('BEGIN');
    try {
      for (const s of statements) {
        // eslint-disable-next-line no-await-in-loop
        out.push(await this.run(s.query, s.params ?? []));
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
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

function freshDb(): Sql {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql());
  return new NodeSql(db);
}

const NOW = 1_800_000_000;

async function insertJob(sql: Sql, id: string, over: Record<string, any> = {}) {
  const row = {
    username: `user_${id}`,
    live_username: `user_${id}`,
    state: 'active',
    total_tracks: 1000,
    next_eligible_at: 0,
    last_run_at: 0,
    locked_until: 0,
    ...over,
  };
  await sql.run(
    `INSERT INTO jobs (
       id, username, live_username, state, generation, locked_until,
       algorithm_version, total_tracks, cursor, last_run_at, next_eligible_at,
       created_at, updated_at, credential_expires_at
     ) VALUES (?, ?, ?, ?, 0, ?, 1, ?, 0, ?, ?, ?, ?, ?)`,
    [
      id, row.username, row.live_username, row.state, row.locked_until,
      row.total_tracks, row.last_run_at, row.next_eligible_at,
      NOW, NOW, NOW + 60 * 86400,
    ],
  );
}

const mkHandoff = (id: string, username: string) => ({
  id,
  username,
  payloadDigest: 'digest',
  trackCount: 10,
  chunkCount: 1,
  declaredBytes: 100,
  algorithmVersion: 1,
});

async function main() {
  console.log('\n-- schema applies --');
  const sql = freshDb();
  const control = await readControl(sql);
  check('control row seeded exactly once', control.max_concurrent_jobs === 50);
  check('starts runnable', canRun(control, NOW));

  console.log('\n-- fencing: the property the whole design rests on --');
  await insertJob(sql, 'j1');

  const leaseA = await acquireJob(sql, 'j1', NOW, 60);
  check('first acquisition succeeds', leaseA !== null);
  check('generation bumped on acquire', leaseA!.generation === 1, leaseA?.generation);

  const contended = await acquireJob(sql, 'j1', NOW, 60);
  check('second tick cannot acquire a held job', contended === null);

  await fencedJobUpdate(sql, leaseA!, 'cursor = ?', [50]);
  let job = await sql.first<any>('SELECT * FROM jobs WHERE id = ?', ['j1']);
  check('holder can write', job.cursor === 50);

  // The scenario fencing exists for: tick A stalls past its lease, tick B takes
  // over, then A's in-flight write lands.
  const later = NOW + 120;
  const leaseB = await acquireJob(sql, 'j1', later, 60);
  check('expired lease can be re-acquired', leaseB !== null);
  check('generation bumped again', leaseB!.generation === 2, leaseB?.generation);

  let fenced = false;
  try {
    await fencedJobUpdate(sql, leaseA!, 'cursor = ?', [999]);
  } catch (e) {
    fenced = e instanceof FencedError;
  }
  check('superseded tick is fenced out', fenced);
  job = await sql.first<any>('SELECT * FROM jobs WHERE id = ?', ['j1']);
  check('superseded write did not land', job.cursor === 50, job.cursor);

  await fencedJobUpdate(sql, leaseB!, 'cursor = ?', [100]);
  job = await sql.first<any>('SELECT * FROM jobs WHERE id = ?', ['j1']);
  check('new holder can write', job.cursor === 100);

  console.log('\n-- lease lifecycle --');
  await renewLease(sql, leaseB!, later, 300);
  job = await sql.first<any>('SELECT * FROM jobs WHERE id = ?', ['j1']);
  check('renew extends the lease', job.locked_until === later + 300);
  check('renew does not bump generation', job.generation === 2);

  await releaseJob(sql, leaseB!, later, later + 10);
  job = await sql.first<any>('SELECT * FROM jobs WHERE id = ?', ['j1']);
  check('release clears the lock', job.locked_until === 0);
  check('release records last_run_at', job.last_run_at === later);
  check('release does not bump generation', job.generation === 2);

  let stale = false;
  try {
    await renewLease(sql, leaseA!, later, 60);
  } catch (e) {
    stale = e instanceof FencedError;
  }
  check('renewing a superseded lease is fenced', stale);

  console.log('\n-- round-robin fairness --');
  const rr = freshDb();
  await insertJob(rr, 'old', { last_run_at: 100 });
  await insertJob(rr, 'new', { last_run_at: 900 });
  await insertJob(rr, 'mid', { last_run_at: 500 });
  await insertJob(rr, 'future', { next_eligible_at: NOW + 5000 });
  await insertJob(rr, 'locked', { locked_until: NOW + 5000 });
  await insertJob(rr, 'done', { state: 'completed', live_username: null });
  const due = await selectDueJobs(rr, NOW, 10);
  check('orders by last_run_at ascending, not by insertion',
    due.map((j) => j.id).join() === 'old,mid,new', due.map((j) => j.id));
  check('excludes not-yet-eligible jobs', !due.some((j) => j.id === 'future'));
  check('excludes leased jobs', !due.some((j) => j.id === 'locked'));
  check('excludes terminal jobs', !due.some((j) => j.id === 'done'));

  console.log('\n-- global controls --');
  const c = freshDb();
  await tripBreaker(c, NOW, 300);
  let ctl = await readControl(c);
  check('breaker blocks running', !canRun(ctl, NOW));
  check('breaker expires', canRun(ctl, NOW + 301));
  check('trip count recorded', ctl.breaker_trip_count === 1);

  // A concurrent tick seeing a shorter backoff must not shorten a longer one.
  await tripBreaker(c, NOW, 60);
  ctl = await readControl(c);
  check('breaker backoff never shortens',
    ctl.breaker_open_until === NOW + 300, ctl.breaker_open_until);

  await haltGlobally(c, NOW, 'error 26');
  ctl = await readControl(c);
  check('halt blocks running regardless of breaker', !canRun(ctl, NOW + 100000));

  const k = freshDb();
  await k.run('UPDATE control SET paused = 1 WHERE id = 1');
  check('kill switch blocks running', !canRun(await readControl(k), NOW));

  console.log('\n-- slot accounting --');
  const s = freshDb();
  let r = await reserveSlot(s, mkHandoff('h1', 'alice'), NOW, 3600, 2);
  check('first reservation succeeds', r.ok);
  check('reserved handoff counts as a slot', (await countCommittedSlots(s)) === 1);

  r = await reserveSlot(s, mkHandoff('h2', 'alice'), NOW, 3600, 2);
  check('second tab for the same user is refused',
    !r.ok && (r as any).reason === 'already_live', r);

  r = await reserveSlot(s, mkHandoff('h3', 'bob'), NOW, 3600, 2);
  check('a different user gets the last slot', r.ok);
  r = await reserveSlot(s, mkHandoff('h4', 'carol'), NOW, 3600, 2);
  check('capacity is enforced', !r.ok && (r as any).reason === 'at_capacity', r);

  console.log('\n-- a handoff that produced a job is not counted twice --');
  await insertJob(s, 'jobA', { username: 'alice', live_username: 'alice', state: 'pending' });
  await s.run("UPDATE handoffs SET job_id = 'jobA', state = 'pending_upload' WHERE id = 'h1'");
  const committed = await countCommittedSlots(s);
  check('handoff with a job row counts once, not twice', committed === 2, committed);

  console.log('\n-- handoff transitions are CAS --');
  const h = freshDb();
  await reserveSlot(h, mkHandoff('hx', 'dave'), NOW, 3600, 10);
  check('issued -> exchanging', await transitionHandoff(h, 'hx', 'issued', 'exchanging', NOW));
  check('a duplicate callback loses the race',
    !(await transitionHandoff(h, 'hx', 'issued', 'exchanging', NOW)));
  check('cannot skip states',
    !(await transitionHandoff(h, 'hx', 'pending_upload', 'active', NOW)));

  check('exchanging -> pending_upload',
    await transitionHandoff(h, 'hx', 'exchanging', 'pending_upload', NOW, 'job_id = ?', ['jx']));
  let hrow = await h.first<any>("SELECT * FROM handoffs WHERE id = 'hx'");
  check('extra set clause applied', hrow.job_id === 'jx');
  check('slot still held mid-flow', hrow.live_username === 'dave');

  check('pending_upload -> finalizing',
    await transitionHandoff(h, 'hx', 'pending_upload', 'finalizing', NOW));
  check('finalizing -> active', await transitionHandoff(h, 'hx', 'finalizing', 'active', NOW));
  hrow = await h.first<any>("SELECT * FROM handoffs WHERE id = 'hx'");
  check('terminal handoff releases the username lock', hrow.live_username === null);

  const again = await reserveSlot(h, mkHandoff('hy', 'dave'), NOW, 3600, 10);
  check('username reusable once the handoff is terminal', again.ok);

  console.log('\n-- a live job blocks a new handoff --');
  const g = freshDb();
  await insertJob(g, 'jz', { username: 'erin', live_username: 'erin' });
  const blocked = await reserveSlot(g, mkHandoff('hz', 'erin'), NOW, 3600, 10);
  check('cannot hand off while a job is already live',
    !blocked.ok && (blocked as any).reason === 'already_live', blocked);

  console.log('\n-- unique indexes are enforced by the database, not just code --');
  const u = freshDb();
  await insertJob(u, 'ja', { username: 'frank', live_username: 'frank' });
  let threw = false;
  try {
    await insertJob(u, 'jb', { username: 'frank', live_username: 'frank' });
  } catch {
    threw = true;
  }
  check('two live jobs for one user are impossible', threw);
  await insertJob(u, 'jc', { username: 'frank', live_username: null, state: 'completed' });
  await insertJob(u, 'jd', { username: 'frank', live_username: null, state: 'cancelled' });
  const frankRows = await u.all('SELECT id FROM jobs WHERE username = ?', ['frank']);
  check('but terminal rows accumulate freely', frankRows.length === 3, frankRows.length);

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
