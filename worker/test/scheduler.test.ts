/**
 * Scheduler tests.
 *
 * The Last.fm client is faked so the hostile cases can actually be produced:
 * a batch that is half accepted and half daily-capped, a revoked credential,
 * an IP throttle, and — the one that matters most — a tick that dies between
 * sending a batch and recording that it sent it.
 */
import { DatabaseSync } from 'node:sqlite';
import { schemaSql } from './schema';
import { Sql, SqlResult, JobRow, readControl } from '../src/store';
import { BlobStore, gzip, uploadChunk } from '../src/chunks';
import { encryptCredential, sha256Hex, randomId } from '../src/crypto';
import { ALGORITHM_VERSION } from '../src/handoff';
import {
  runTick,
  SchedulerEnv,
  DAILY_CAP_BACKOFF_SECONDS,
  PROBE_BATCH_SIZE,
  MAX_BATCHES_PER_JOB_PER_TICK,
  MAX_RECORDED_FAILURES_PER_JOB,
  RECONCILE_GRACE_SECONDS,
  matchOutcomes,
} from '../src/scheduler';
import { BatchScrobbleResult, ScrobbleEntry } from '../../src/shared/lastfm/protocol';

const NOW = 1_800_000_000;
const SECRET = 'test-credential-secret-0123456789';

class NodeSql implements Sql {
  constructor(private db: DatabaseSync) {}

  async all<T>(query: string, params: unknown[] = []): Promise<T[]> {
    return this.db.prepare(query).all(...(params as any[])) as T[];
  }

  async first<T>(query: string, params: unknown[] = []): Promise<T | null> {
    return (this.db.prepare(query).get(...(params as any[])) ?? null) as T | null;
  }

  async run(query: string, params: unknown[] = []): Promise<SqlResult> {
    return { changes: Number(this.db.prepare(query).run(...(params as any[])).changes) };
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

class MemoryBlobs implements BlobStore {
  public data = new Map<string, Uint8Array>();

  async put(key: string, value: ArrayBuffer | Uint8Array) {
    this.data.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
  }

  async get(key: string) {
    const v = this.data.get(key);
    return v ? (v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer) : null;
  }

  async delete(keys: string[]) {
    keys.forEach((k) => this.data.delete(k));
  }
}

interface SentBatch {
  entries: ScrobbleEntry[];
  sessionKey: string;
}

/**
 * Scriptable Last.fm. Each element of `script` decides what the next
 * `scrobbleBatch` call does.
 */
type Script =
  | { kind: 'accept' }
  | { kind: 'ignore'; from: number; code: number; message: string }
  /** Last.fm returns fewer entries than we submitted. */
  | { kind: 'truncate'; entries: number }
  | { kind: 'throw'; message: string };

class FakeLastFm {
  public sent: SentBatch[] = [];

  public recent: { artist: string; track: string; timestampSec: number }[] = [];

  public recentThrows = false;

  public recentCalls = 0;

  constructor(public script: Script[] = []) {}

  async scrobbleBatch(entries: ScrobbleEntry[], sessionKey: string): Promise<BatchScrobbleResult> {
    this.sent.push({ entries, sessionKey });
    const step = this.script.shift() ?? { kind: 'accept' as const };
    if (step.kind === 'throw') {
      throw new Error(step.message);
    }
    const outcomes = entries.map((e, i) => {
      const ignored = step.kind === 'ignore' && i >= step.from;
      // A truncated response has no entry at this position, so the parser's
      // "accepted" is a guess, not an observation.
      const present = step.kind !== 'truncate' || i < step.entries;
      return {
        index: i,
        accepted: !ignored,
        ignoredCode: ignored ? step.code : 0,
        ignoredMessage: ignored ? step.message : '',
        present,
      };
    });
    return {
      accepted: outcomes.filter((o) => o.accepted).length,
      ignored: outcomes.filter((o) => !o.accepted).length,
      outcomes,
    };
  }

  async getRecentTracks() {
    this.recentCalls += 1;
    if (this.recentThrows) {
      throw new Error('Last.fm API error 8 (HTTP 200)');
    }
    return this.recent;
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

function freshSql(): Sql {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql());
  return new NodeSql(db);
}

function trackLines(count: number, originalTimestampSec: number): Uint8Array {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(JSON.stringify({
      artist: `Artist ${i}`,
      track: `Track ${i}`,
      album: 'An Album',
      originalTimestampSec,
    }));
  }
  return new TextEncoder().encode(lines.join('\n'));
}

interface Harness {
  env: SchedulerEnv;
  sql: Sql;
  fake: FakeLastFm;
  jobId: string;
  job(): Promise<any>;
}

async function harness(options: {
  total?: number;
  script?: Script[];
  /** Days ago the listens happened. Large values force synthetic timestamps. */
  originalDaysAgo?: number;
  job?: Partial<Record<string, unknown>>;
} = {}): Promise<Harness> {
  const total = options.total ?? 120;
  const sql = freshSql();
  const blobs = new MemoryBlobs();
  const fake = new FakeLastFm(options.script ?? []);
  const jobId = randomId();

  const cred = await encryptCredential('sk-abc', SECRET, jobId);
  const columns: Record<string, unknown> = {
    id: jobId,
    username: 'listener',
    live_username: 'listener',
    state: 'active',
    algorithm_version: ALGORITHM_VERSION,
    total_tracks: total,
    session_key_ct: cred.ciphertext,
    session_key_iv: cred.iv,
    created_at: NOW,
    updated_at: NOW,
    credential_expires_at: NOW + 60 * 86400,
    ...(options.job ?? {}),
  };
  const names = Object.keys(columns);
  await sql.run(
    `INSERT INTO jobs (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    names.map((n) => columns[n]),
  );

  const raw = trackLines(total, NOW - (options.originalDaysAgo ?? 400) * 86400);
  const compressed = await gzip(raw);
  const buf = compressed.buffer.slice(
    compressed.byteOffset,
    compressed.byteOffset + compressed.byteLength,
  ) as ArrayBuffer;
  const up = await uploadChunk(sql, blobs, {
    jobId,
    chunkIndex: 0,
    startIndex: 0,
    digest: await sha256Hex(compressed),
    entryCount: total,
    compressed: buf,
  }, NOW);
  if (!up.ok) {
    throw new Error(`seed upload failed: ${JSON.stringify(up)}`);
  }

  const env: SchedulerEnv = {
    sql, blobs, lastfm: fake as any, credentialSecret: SECRET,
  };
  return {
    env,
    sql,
    fake,
    jobId,
    job: async () => sql.first<JobRow>('SELECT * FROM jobs WHERE id = ?', [jobId]),
  };
}

async function main() {
  console.log('\n-- happy path --');
  {
    const h = await harness({ total: 120 });
    const report = await runTick(h.env, NOW);
    check('a tick runs the job', report.jobsRun === 1, report);
    check('it sends 50, 50 then the remaining 20',
      h.fake.sent.length === 3, h.fake.sent.length);
    check('batches are 50 wide', h.fake.sent[0].entries.length === 50);
    const job = await h.job();
    check('cursor advanced over everything accepted', job.cursor === 120, job.cursor);
    check('scrobbled count matches', job.scrobbled_count === 120, job.scrobbled_count);
    check('job completed', job.state === 'completed', job.state);
    check('credential deleted on completion', job.session_key_ct === null);
    check('live_username released', job.live_username === null);
    check('a purge date is set', job.purge_after > NOW);
    check('the correct session key was used', h.fake.sent[0].sessionKey === 'sk-abc');
    const stamps = h.fake.sent.flatMap((s) => s.entries.map((e) => e.timestampSec));
    check('every timestamp across the job is unique',
      new Set(stamps).size === stamps.length, stamps.length - new Set(stamps).size);
    check('no timestamp is in the future', stamps.every((t) => t < NOW));
    const batches = await h.sql.all<any>('SELECT * FROM batches WHERE job_id = ?', [h.jobId]);
    check('every batch settled', batches.every((b) => b.state === 'settled'), batches.length);
  }

  console.log('\n-- the mapping is durable before the send --');
  {
    // If this ordering is wrong, a crash mid-send leaves scrobbles on Last.fm
    // that nothing in D1 can identify, and they get sent again.
    const h = await harness({ total: 50 });
    let stateAtSendTime: string | null = null;
    const realSend = h.fake.scrobbleBatch.bind(h.fake);
    (h.fake as any).scrobbleBatch = async (e: ScrobbleEntry[], k: string) => {
      const row = await h.sql.first<any>('SELECT state FROM batches WHERE job_id = ?', [h.jobId]);
      stateAtSendTime = row ? row.state : null;
      return realSend(e, k);
    };
    await runTick(h.env, NOW);
    check('the batch row exists before the request goes out', stateAtSendTime === 'sending',
      stateAtSendTime);
  }

  console.log('\n-- daily cap part-way through a batch --');
  {
    const h = await harness({
      total: 120,
      script: [{ kind: 'ignore', from: 20, code: 5, message: 'Daily scrobble limit exceeded' }],
    });
    const report = await runTick(h.env, NOW);
    const job = await h.job();
    check('only the accepted prefix advances the cursor', job.cursor === 20, job.cursor);
    check('the capped tail is not counted as scrobbled', job.scrobbled_count === 20, job.scrobbled_count);
    check('the capped tail is not counted as failed', job.failed_count === 0, job.failed_count);
    check('no capped track is recorded as a permanent failure',
      (await h.sql.all('SELECT 1 FROM failures WHERE job_id = ?', [h.jobId])).length === 0);
    check('the job stays active', job.state === 'active', job.state);
    check('it backs off a day, not to the next tick',
      job.next_eligible_at === NOW + DAILY_CAP_BACKOFF_SECONDS, job.next_eligible_at);
    check('it will probe before resuming full rate', job.probing === 1);
    check('the tick stopped sending for that job', h.fake.sent.length === 1, h.fake.sent.length);
    check('the reason is surfaced', /daily/i.test(job.state_reason || ''), job.state_reason);
    check('report counts only what was accepted', report.scrobbled === 20, report);

    // The point of recording this is to answer whether the cap resets on a
    // clock or a rolling window — which decides whether the blind 24h wait is
    // correct or is costing every capped user most of a day.
    const hit = await h.sql.all<any>(
      "SELECT * FROM audit WHERE job_id = ? AND event = 'daily_cap_hit'", [h.jobId],
    );
    check('the cap is recorded for measurement', hit.length === 1, hit.length);
    check('with the time it happened', hit[0].created_at === NOW, hit[0].created_at);
    check('and what had been sent by then',
      JSON.parse(hit[0].detail).scrobbledBeforeCap === 20, hit[0].detail);
  }

  console.log('\n-- probing --');
  {
    const capAt = NOW - 30 * 3600;
    const h = await harness({
      total: 120,
      job: { probing: 1, daily_window_start: capAt },
    });
    await runTick(h.env, NOW);
    check('a probe is small', h.fake.sent[0].entries.length === PROBE_BATCH_SIZE,
      h.fake.sent[0].entries.length);
    check('a probe is a single batch', h.fake.sent.length === 1, h.fake.sent.length);
    const job = await h.job();
    check('a successful probe clears the flag', job.probing === 0);
    check('and clears the stale reason', job.state_reason === null);

    // Paired with `daily_cap_hit`, this bounds the real reset interval: the
    // cap lifted somewhere between the previous failed probe and here.
    const lifted = await h.sql.all<any>(
      "SELECT * FROM audit WHERE job_id = ? AND event = 'daily_cap_lifted'", [h.jobId],
    );
    check('the recovery is recorded', lifted.length === 1, lifted.length);
    check('with how long the cap lasted',
      JSON.parse(lifted[0].detail).cappedForSeconds === NOW - capAt, lifted[0].detail);
  }
  {
    const h = await harness({
      total: 120,
      job: { probing: 1 },
      script: [{ kind: 'ignore', from: 0, code: 5, message: 'Daily scrobble limit exceeded' }],
    });
    await runTick(h.env, NOW);
    const job = await h.job();
    check('a failed probe stays probing', job.probing === 1);
    check('a failed probe advances nothing', job.cursor === 0, job.cursor);
    check('a failed probe backs off again',
      job.next_eligible_at === NOW + DAILY_CAP_BACKOFF_SECONDS);
  }

  console.log('\n-- permanent per-track rejection --');
  {
    const h = await harness({
      total: 50,
      script: [{ kind: 'ignore', from: 48, code: 1, message: 'Artist ignored' }],
    });
    await runTick(h.env, NOW);
    const job = await h.job();
    check('the cursor advances past permanent failures too', job.cursor === 50, job.cursor);
    check('they are counted as failed', job.failed_count === 2, job.failed_count);
    check('they are not counted as scrobbled', job.scrobbled_count === 48, job.scrobbled_count);
    const rows = await h.sql.all<any>('SELECT * FROM failures WHERE job_id = ? ORDER BY track_index', [h.jobId]);
    check('the rejected tracks are recorded for the user', rows.length === 2, rows.length);
    check('with their real names', rows[0].artist === 'Artist 48', rows[0]);
    check('with the reason', rows[0].reason === 'Artist ignored', rows[0].reason);
    check('with the code', rows[0].ignore_code === 1);
    check('the job still completes', job.state === 'completed', job.state);
  }

  console.log('\n-- our own timestamp bug is surfaced, not swallowed --');
  {
    const h = await harness({
      total: 50,
      script: [{ kind: 'ignore', from: 0, code: 3, message: 'Timestamp too old' }],
    });
    await runTick(h.env, NOW);
    const audits = await h.sql.all<any>(
      "SELECT * FROM audit WHERE job_id = ? AND event = 'timestamp_rejected'", [h.jobId],
    );
    check('a timestamp rejection raises an audit entry', audits.length === 1, audits.length);
  }

  console.log('\n-- revoked credential --');
  {
    const h = await harness({
      total: 120,
      script: [{ kind: 'throw', message: 'Last.fm API error 9 (HTTP 403)' }],
    });
    await runTick(h.env, NOW);
    const job = await h.job();
    check('the job parks for re-auth', job.state === 'needs_reauth', job.state);
    check('the dead credential is deleted', job.session_key_ct === null && job.session_key_iv === null);
    check('the slot is released', job.live_username === null);
    check('it does not keep retrying', h.fake.sent.length === 1, h.fake.sent.length);
    check('the breaker was not tripped', (await readControl(h.sql)).breaker_open_until === 0);
  }

  console.log('\n-- IP rate limit is global --');
  {
    const h = await harness({
      total: 120,
      script: [{ kind: 'throw', message: 'Last.fm API error 29 (HTTP 429)' }],
    });
    await runTick(h.env, NOW);
    const control = await readControl(h.sql);
    check('the breaker opens', control.breaker_open_until > NOW, control);
    check('the trip is counted', control.breaker_trip_count === 1);
    const job = await h.job();
    check('the job itself is not blamed', job.state === 'active', job.state);
    check('and is not marked as failing', job.consecutive_failures === 0);
    const audits = await h.sql.all<any>("SELECT * FROM audit WHERE event = 'breaker_tripped'");
    check('the active job count is recorded, since that is the unknown',
      audits.length === 1 && JSON.parse(audits[0].detail).activeJobs === 1, audits[0]);

    const second = await runTick(h.env, NOW);
    check('the next tick does nothing while the breaker is open',
      second.jobsRun === 0 && /breaker/i.test(second.skipped || ''), second);
  }

  console.log('\n-- suspended API key halts everything --');
  {
    const h = await harness({
      total: 120,
      script: [{ kind: 'throw', message: 'Last.fm API error 26 (HTTP 403)' }],
    });
    await runTick(h.env, NOW);
    const control = await readControl(h.sql);
    check('the worker halts globally', control.halted === 1, control);
    const second = await runTick(h.env, NOW);
    check('and stays halted', second.jobsRun === 0 && /halted/i.test(second.skipped || ''), second);
  }

  console.log('\n-- network failure --');
  {
    const h = await harness({
      total: 120,
      script: [{ kind: 'throw', message: 'Network request failed' }],
    });
    await runTick(h.env, NOW);
    const job = await h.job();
    check('the job is retried, not parked', job.state === 'active', job.state);
    check('the failure is counted', job.consecutive_failures === 1, job.consecutive_failures);
    check('it backs off', job.next_eligible_at > NOW, job.next_eligible_at);
    check('the cursor does not move', job.cursor === 0, job.cursor);
    const batch = await h.sql.first<any>('SELECT * FROM batches WHERE job_id = ?', [h.jobId]);
    check('the batch stays in flight, because we cannot tell what happened',
      batch.state === 'sending', batch.state);
  }

  console.log('\n-- repeated failure parks the job --');
  {
    const h = await harness({
      total: 120,
      job: { consecutive_failures: 9 },
      script: [{ kind: 'throw', message: 'Network request failed' }],
    });
    await runTick(h.env, NOW);
    const job = await h.job();
    check('ten consecutive failures needs a human', job.state === 'needs_attention', job.state);
  }

  console.log('\n-- reconciling a tick that died mid-send --');
  {
    const h = await harness({
      total: 120,
      script: [{ kind: 'throw', message: 'Network request failed' }],
    });
    await runTick(h.env, NOW);
    const inFlight = await h.sql.first<any>('SELECT * FROM batches WHERE job_id = ?', [h.jobId]);
    const assigned = JSON.parse(inFlight.assigned_timestamps);
    check('the mapping survived the crash', assigned.length === 50);

    // Last.fm actually stored them: the request landed, the response did not.
    h.fake.recent = assigned.map((a: any) => ({
      artist: a.artist, track: a.track, timestampSec: a.timestampSec,
    }));
    const later = NOW + 7200;
    const report = await runTick(h.env, later);
    check('reconciliation ran', h.fake.recentCalls === 1, h.fake.recentCalls);
    const job = await h.job();
    check('the recovered batch advances the cursor', job.cursor >= 50, job.cursor);
    check('it is counted as scrobbled', job.scrobbled_count >= 50, job.scrobbled_count);
    const first = h.fake.sent[1];
    check('the recovered tracks are not sent again',
      first.entries[0].track === 'Track 50', first.entries[0].track);
    const settled = await h.sql.first<any>('SELECT * FROM batches WHERE id = ?', [inFlight.id]);
    check('the batch is marked reconciled', settled.state === 'reconciled', settled.state);
    check('a reconciliation audit entry exists',
      (await h.sql.all("SELECT 1 FROM audit WHERE event = 'reconciled'")).length === 1);
    check('the tick still did useful work afterwards', report.scrobbled > 0, report);
  }

  console.log('\n-- reconciliation finds nothing --');
  {
    const h = await harness({
      total: 120,
      script: [{ kind: 'throw', message: 'Network request failed' }],
    });
    await runTick(h.env, NOW);
    h.fake.recent = [];
    await runTick(h.env, NOW + 7200);
    const job = await h.job();
    // At-least-once: an unconfirmed track is re-sent. A duplicate is visible
    // and removable; a dropped track is neither.
    check('unconfirmed tracks are re-sent from the same cursor',
      h.fake.sent[1].entries[0].track === 'Track 0', h.fake.sent[1].entries[0].track);
    check('every track is counted exactly once despite the re-send',
      job.scrobbled_count === 120, job.scrobbled_count);
    check('the job still finishes', job.state === 'completed', job.state);
  }

  console.log('\n-- reconciliation lookup itself fails --');
  {
    const h = await harness({
      total: 120,
      script: [{ kind: 'throw', message: 'Network request failed' }],
    });
    await runTick(h.env, NOW);
    h.fake.recentThrows = true;
    const before = h.fake.sent.length;
    await runTick(h.env, NOW + 7200);
    const batch = await h.sql.first<any>('SELECT * FROM batches WHERE job_id = ?', [h.jobId]);
    check('an inconclusive lookup leaves the batch in flight', batch.state === 'sending',
      batch.state);
    check('it is not read as "nothing was stored"', batch.accepted_count === null);
    check('the job keeps working rather than stalling', h.fake.sent.length > before);
  }

  console.log('\n-- corrected names still reconcile --');
  {
    const h = await harness({
      total: 60,
      script: [{ kind: 'throw', message: 'Network request failed' }],
    });
    await runTick(h.env, NOW);
    const inFlight = await h.sql.first<any>('SELECT * FROM batches WHERE job_id = ?', [h.jobId]);
    const assigned = JSON.parse(inFlight.assigned_timestamps);
    // Last.fm rewrites what it stores. An exact-match reconciliation would
    // conclude the batch was lost and send all 50 again.
    h.fake.recent = assigned.map((a: any) => ({
      artist: a.artist.toUpperCase(),
      track: `  ${a.track.toUpperCase()}  `,
      timestampSec: a.timestampSec,
    }));
    await runTick(h.env, NOW + 7200);
    const job = await h.job();
    check('normalised names are recognised as our own writes', job.cursor >= 50, job.cursor);
  }

  console.log('\n-- refusing work we no longer understand --');
  {
    const h = await harness({ total: 50, job: { algorithm_version: ALGORITHM_VERSION + 7 } });
    await runTick(h.env, NOW);
    const job = await h.job();
    check('a job pinned to unknown semantics is refused', job.state === 'needs_attention', job.state);
    check('not reinterpreted', h.fake.sent.length === 0);
  }

  console.log('\n-- credential lifetime --');
  {
    const h = await harness({ total: 50, job: { credential_expires_at: NOW - 1 } });
    await runTick(h.env, NOW);
    const job = await h.job();
    check('an expired credential parks the job', job.state === 'needs_reauth', job.state);
    check('and is deleted', job.session_key_ct === null);
    check('nothing was sent with it', h.fake.sent.length === 0);
  }
  {
    const h = await harness({ total: 50 });
    // Simulates a rotated secret or a tampered row.
    await h.sql.run('UPDATE jobs SET session_key_ct = ? WHERE id = ?', ['bogus', h.jobId]);
    await runTick(h.env, NOW);
    const job = await h.job();
    check('an undecryptable credential needs a human', job.state === 'needs_attention', job.state);
    check('and is not retried', h.fake.sent.length === 0);
    check('and is audited',
      (await h.sql.all("SELECT 1 FROM audit WHERE event = 'credential_undecryptable'")).length === 1);
  }

  console.log('\n-- control switches --');
  {
    const h = await harness({ total: 50 });
    await h.sql.run("UPDATE control SET paused = 1, paused_reason = 'maintenance' WHERE id = 1");
    const report = await runTick(h.env, NOW);
    check('a paused worker sends nothing', h.fake.sent.length === 0);
    check('and says why', /maintenance/.test(report.skipped || ''), report.skipped);
  }

  console.log('\n-- leases --');
  {
    const h = await harness({ total: 50 });
    await h.sql.run('UPDATE jobs SET locked_until = ? WHERE id = ?', [NOW + 300, h.jobId]);
    const report = await runTick(h.env, NOW);
    check('a job held by another tick is skipped', report.jobsRun === 0, report);
    check('and nothing is sent for it', h.fake.sent.length === 0);
  }
  {
    const h = await harness({ total: 50 });
    const before = await h.job();
    await runTick(h.env, NOW);
    const after = await h.job();
    check('acquiring bumps the fencing token', after.generation > before.generation,
      { before: before.generation, after: after.generation });
    check('the lease is released when the tick finishes', after.locked_until === 0);
  }

  console.log('\n-- missing chunk --');
  {
    const h = await harness({ total: 50 });
    await h.sql.run('DELETE FROM chunks WHERE job_id = ?', [h.jobId]);
    await runTick(h.env, NOW);
    const job = await h.job();
    check('a job whose data vanished is parked, not spun on',
      job.state === 'needs_attention', job.state);
    check('nothing is sent', h.fake.sent.length === 0);
  }

  console.log('\n-- recent listens keep their real timestamps --');
  {
    const h = await harness({ total: 50, originalDaysAgo: 2 });
    await runTick(h.env, NOW);
    const stamps = h.fake.sent[0].entries.map((e) => e.timestampSec);
    check('at least one keeps the true listen time',
      stamps.includes(NOW - 2 * 86400), stamps.slice(0, 3));
    check('the rest are still unique', new Set(stamps).size === stamps.length);
  }

  console.log('\n-- fairness --');
  {
    const h = await harness({ total: 1000 });
    const cred = await encryptCredential('sk-two', SECRET, 'job-two');
    await h.sql.run(
      `INSERT INTO jobs (id, username, state, algorithm_version, total_tracks,
         session_key_ct, session_key_iv, created_at, updated_at, credential_expires_at, last_run_at)
       VALUES ('job-two', 'other', 'active', ?, 1000, ?, ?, ?, ?, ?, 0)`,
      [ALGORITHM_VERSION, cred.ciphertext, cred.iv, NOW, NOW, NOW + 60 * 86400],
    );
    const raw = trackLines(1000, NOW - 400 * 86400);
    const compressed = await gzip(raw);
    const buf = compressed.buffer.slice(
      compressed.byteOffset, compressed.byteOffset + compressed.byteLength,
    ) as ArrayBuffer;
    await uploadChunk(h.env.sql, h.env.blobs, {
      jobId: 'job-two',
      chunkIndex: 0,
      startIndex: 0,
      digest: await sha256Hex(compressed),
      entryCount: 1000,
      compressed: buf,
    }, NOW);

    await runTick(h.env, NOW);
    const keys = new Set(h.fake.sent.map((s) => s.sessionKey));
    check('a long job does not starve the one behind it', keys.size === 2, [...keys]);
    check('each got an equal slice',
      h.fake.sent.filter((s) => s.sessionKey === 'sk-abc').length
        === h.fake.sent.filter((s) => s.sessionKey === 'sk-two').length);
    check('and neither exceeded its per-tick budget',
      h.fake.sent.filter((s) => s.sessionKey === 'sk-abc').length
        === MAX_BATCHES_PER_JOB_PER_TICK, h.fake.sent.length);
  }

  console.log('\n-- a truncated response is not evidence of acceptance --');
  {
    // Last.fm returns HTTP 200 with only 10 of 50 entries. The parser fills
    // the gap with "accepted" so an interactive client does not report false
    // failures — but the worker advances a durable cursor, so believing it
    // would mark 40 never-stored tracks as scrobbled and skip them forever.
    const h = await harness({ total: 50, script: [{ kind: 'truncate', entries: 10 }] });
    await runTick(h.env, NOW);
    check('the first batch commits only what was observed',
      h.fake.sent.length === 2, h.fake.sent.length);
    const resent = h.fake.sent[1].entries;
    check('the unobserved entries are sent again rather than skipped',
      resent.length === 40, resent.length);
    check('and they resume exactly where observation stopped',
      resent[0].track === 'Track 10', resent[0].track);
    const job = await h.job();
    check('every track ends up accounted for', job.cursor === 50, job.cursor);
    check('and none is double-counted',
      job.scrobbled_count === 50, job.scrobbled_count);
  }

  console.log('\n-- a rejected timestamp is our bug, not a dropped track --');
  {
    // Codes 3 and 4 mean our own assignment is wrong. Recording them as
    // permanent failures would let a broken clock silently discard an entire
    // import while reporting it finished.
    const h = await harness({
      total: 100,
      script: [{ kind: 'ignore', from: 0, code: 3, message: 'Timestamp too old' }],
    });
    await runTick(h.env, NOW);
    const job = await h.job();
    check('nothing is discarded', job.cursor === 0, job.cursor);
    check('nothing is counted as failed', job.failed_count === 0, job.failed_count);
    check('no track is written off permanently',
      (await h.sql.all<any>('SELECT * FROM failures WHERE job_id = ?', [h.jobId])).length === 0);
    check('the job is parked for a human',
      job.state === 'needs_attention', job.state);
    check('it does not keep resending', h.fake.sent.length === 1, h.fake.sent.length);
    const audits = await h.sql.all<any>(
      "SELECT * FROM audit WHERE job_id = ? AND event = 'timestamp_rejected'", [h.jobId],
    );
    check('and the bug is surfaced in the audit log', audits.length === 1, audits.length);
  }

  console.log('\n-- an unrecognised ignore code is not terminal --');
  {
    const h = await harness({
      total: 100,
      script: [{ kind: 'ignore', from: 20, code: 99, message: 'Something new' }],
    });
    await runTick(h.env, NOW);
    const job = await h.job();
    check('nothing is written off on a code we do not understand',
      job.failed_count === 0, job.failed_count);
    check('the unknown entries are retried rather than skipped',
      h.fake.sent[1] && h.fake.sent[1].entries[0].track === 'Track 20',
      h.fake.sent[1] && h.fake.sent[1].entries[0].track);
  }

  console.log('\n-- outcomes and the cursor commit together --');
  {
    // The worst bug this file guards: a batch marked settled while the cursor
    // still points at its first entry is invisible to reconciliation (which
    // only looks at `sending`), so every later tick re-sends all 50.
    const h = await harness({ total: 50 });
    const realBatch = h.env.sql.batch.bind(h.env.sql);
    let failNext = true;
    (h.env.sql as any).batch = async (statements: any[]) => {
      // Fail the commit that carries the cursor, i.e. the one after the send.
      if (failNext && statements.some((s) => String(s.query).includes("state = ?"))) {
        failNext = false;
        throw new Error('D1 write quota exceeded');
      }
      return realBatch(statements);
    };
    await runTick(h.env, NOW);
    (h.env.sql as any).batch = realBatch;

    const batches = await h.sql.all<any>('SELECT * FROM batches WHERE job_id = ?', [h.jobId]);
    const job = await h.job();
    check('the batch is left reconcilable rather than settled',
      batches.every((b) => b.state === 'sending'), batches.map((b) => b.state));
    check('the cursor did not move', job.cursor === 0, job.cursor);

    // The next tick must reconcile, not blindly resend.
    h.fake.recent = h.fake.sent[0].entries.map((e) => ({
      artist: e.artist, track: e.track, timestampSec: e.timestampSec,
    }));
    const before = h.fake.sent.length;
    await runTick(h.env, NOW + RECONCILE_GRACE_SECONDS + 600);
    check('the recovered batch is not sent again',
      h.fake.sent.length === before, h.fake.sent.length - before);
    check('and the cursor catches up from reconciliation',
      (await h.job()).cursor === 50, (await h.job()).cursor);
  }

  console.log('\n-- reconciliation never rewinds the cursor --');
  {
    // A batch stuck in `sending` can be reconciled long after later batches
    // moved the cursor past it. Writing `start_index + advance` there would
    // rewind it and re-send everything in between.
    const h = await harness({ total: 200 });
    await runTick(h.env, NOW);
    const job = await h.job();
    check('the job made progress first', job.cursor === 200, job.cursor);

    // Re-arm the first batch as if its outcome had never been recorded.
    const first = await h.sql.first<any>(
      'SELECT * FROM batches WHERE job_id = ? ORDER BY start_index ASC', [h.jobId],
    );
    await h.sql.run(
      "UPDATE jobs SET state = 'active', cursor = 200, locked_until = 0, next_eligible_at = 0 WHERE id = ?",
      [h.jobId],
    );
    await h.sql.run("UPDATE batches SET state = 'sending' WHERE id = ?", [first.id]);
    h.fake.recent = JSON.parse(first.assigned_timestamps).map((a: any) => ({
      artist: a.artist, track: a.track, timestampSec: a.timestampSec,
    }));

    await runTick(h.env, NOW + RECONCILE_GRACE_SECONDS + 600);
    const after = await h.job();
    check('the cursor is not rewound', after.cursor >= 200, after.cursor);
    check('and the count does not exceed the track total',
      after.scrobbled_count <= after.total_tracks,
      [after.scrobbled_count, after.total_tracks]);
  }

  console.log('\n-- reconciliation waits for Last.fm to catch up --');
  {
    const h = await harness({ total: 50 });
    await h.sql.run(
      `INSERT INTO batches (id, job_id, generation, start_index, entry_count, state,
         assigned_timestamps, sent_at, created_at)
       VALUES ('b-fresh', ?, 1, 0, 50, 'sending', '[]', ?, ?)`,
      [h.jobId, NOW, NOW],
    );
    await runTick(h.env, NOW + 5);
    check('a batch sent seconds ago is not reconciled yet',
      h.fake.recentCalls === 0, h.fake.recentCalls);
  }

  console.log('\n-- reconciliation matches artist as well as track --');
  {
    // Two different artists routinely share a track name, and the user's own
    // listening lands in the same window. Matching on track alone marks a
    // genuinely unsent track as accepted and skips it forever.
    const assigned = [
      { artist: 'Artist A', track: 'Intro', index: 0, timestampSec: 100, preservedOriginal: false },
    ];
    const outcomes = matchOutcomes(assigned as any, [
      { artist: 'Artist B', track: 'Intro', timestampSec: 100 },
    ]);
    check('a same-timestamp, same-title, different-artist scrobble is not a match',
      outcomes[0].s === 'unknown', outcomes[0]);
    const rewritten = matchOutcomes(assigned as any, [
      { artist: 'artist  a', track: 'INTRO', timestampSec: 100 },
    ]);
    check('but Last.fm rewriting case and spacing still matches',
      rewritten[0].s === 'accepted', rewritten[0]);
  }

  console.log('\n-- one stored scrobble cannot satisfy two entries --');
  {
    const assigned = [
      { artist: 'A', track: 'T', index: 0, timestampSec: 100, preservedOriginal: true },
      { artist: 'A', track: 'T', index: 1, timestampSec: 100, preservedOriginal: true },
    ];
    const outcomes = matchOutcomes(assigned as any, [
      { artist: 'A', track: 'T', timestampSec: 100 },
    ]);
    check('the first entry matches', outcomes[0].s === 'accepted', outcomes[0]);
    check('the second stays unknown rather than claiming the same scrobble',
      outcomes[1].s === 'unknown', outcomes[1]);
  }

  console.log('\n-- a cancelled job stops immediately --');
  {
    // Cancelling does not bump the generation, so fencing alone does not see
    // it. Without an explicit check the tick keeps scrobbling for three more
    // batches after the user pressed stop.
    const h = await harness({ total: 1000 });
    const realSend = h.fake.scrobbleBatch.bind(h.fake);
    (h.fake as any).scrobbleBatch = async (e: ScrobbleEntry[], k: string) => {
      const out = await realSend(e, k);
      await h.sql.run("UPDATE jobs SET state = 'cancelled' WHERE id = ?", [h.jobId]);
      return out;
    };
    await runTick(h.env, NOW);
    check('only the in-flight batch was sent', h.fake.sent.length === 1, h.fake.sent.length);
    const job = await h.job();
    check('and the cancellation was not overwritten',
      job.state === 'cancelled', job.state);
  }

  console.log('\n-- an unexpected throw does not wedge the job --');
  {
    const h = await harness({ total: 100 });
    (h.env.blobs as any).get = async () => { throw new Error('R2 exploded'); };
    const report = await runTick(h.env, NOW);
    check('the tick survives', report.errors.length === 1, report.errors);
    const job = await h.job();
    check('the lease is released', job.locked_until === 0, job.locked_until);
    check('the failure is counted', job.consecutive_failures === 1, job.consecutive_failures);
    check('and it backs off instead of retrying immediately',
      job.next_eligible_at > NOW, job.next_eligible_at);
  }

  console.log('\n-- recorded failures are capped --');
  {
    const h = await harness({
      total: 100,
      script: [{ kind: 'ignore', from: 0, code: 1, message: 'Artist ignored' }],
      job: { failed_count: MAX_RECORDED_FAILURES_PER_JOB },
    });
    await runTick(h.env, NOW);
    const rows = await h.sql.all<any>('SELECT * FROM failures WHERE job_id = ?', [h.jobId]);
    check('no detail rows are written past the cap', rows.length === 0, rows.length);
    const job = await h.job();
    check('but the count is still exact',
      job.failed_count === MAX_RECORDED_FAILURES_PER_JOB + 50, job.failed_count);
  }

  console.log('\n-- a lapsed export claim is reverted, not stranded --');
  {
    /*
      `exporting` is deliberately neither schedulable nor resumable. A client
      that closed its tab midway through a take-back would therefore park the
      job forever, so the sweep reverts a claim whose deadline has passed —
      and reverts it to the state it was claimed from, because sending a
      `needs_attention` job to `paused` would quietly clear something the user
      still has to act on.
    */
    const h = await harness({ total: 10 });
    await h.sql.run(
      `UPDATE jobs SET state = 'exporting', export_claim = 'abandoned-claim',
          export_prev_state = 'needs_attention', locked_until = ? WHERE id = ?`,
      [NOW - 1, h.jobId],
    );
    await runTick(h.env, NOW);
    const job = await h.job();
    check('reverted to the state it was claimed from',
      job.state === 'needs_attention', job.state);
    check('the claim is cleared', job.export_claim === null, job.export_claim);
    check('and so is its deadline', job.locked_until === 0, job.locked_until);

    // A claim that has not lapsed is left alone: the take-back is still going.
    const live = await harness({ total: 10 });
    await live.sql.run(
      `UPDATE jobs SET state = 'exporting', export_claim = 'live-claim',
          export_prev_state = 'paused', locked_until = ? WHERE id = ?`,
      [NOW + 300, live.jobId],
    );
    await runTick(live.env, NOW);
    check('a claim still inside its deadline is untouched',
      (await live.job()).state === 'exporting');
  }

  console.log('\n-- a parked job with a stale batch can still be drained --');
  {
    /*
      Drain selection used to require `paused`. A batch left `sending` while
      failure escalation moved the job to `needs_attention` could then never
      be reconciled, so the take-back's export sat at 409 `batch_in_flight`
      forever. Reconciling is read-only against Last.fm, so it is safe from
      any parked state.
    */
    const h = await harness({ total: 10 });
    await h.sql.run(
      `INSERT INTO batches (id, job_id, generation, start_index, entry_count, state,
          assigned_timestamps, sent_at, created_at)
       VALUES (?, ?, (SELECT generation FROM jobs WHERE id = ?), 0, 2, 'sending', ?, ?, ?)`,
      [randomId(), h.jobId, h.jobId, JSON.stringify([]), NOW - 10_000, NOW - 10_000],
    );
    await h.sql.run(
      "UPDATE jobs SET state = 'needs_attention', locked_until = 0 WHERE id = ?",
      [h.jobId],
    );
    await runTick(h.env, NOW);
    const stillSending = await h.sql.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM batches WHERE job_id = ? AND state = 'sending'",
      [h.jobId],
    );
    check('the stale batch was settled', stillSending!.n === 0, stillSending!.n);
    check('and the job stayed parked where it was',
      (await h.job()).state === 'needs_attention');
  }

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
