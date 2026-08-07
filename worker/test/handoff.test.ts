/**
 * Handoff tests, including the failure modes that matter more than the happy
 * path: replayed callbacks, a username that does not match, an expired state,
 * a forged state, and an upload with a gap in it.
 */
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Sql, SqlResult } from '../src/store';
import {
  preflight,
  handleCallback,
  finalize,
  failHandoff,
  reapExpiredHandoffs,
  MAX_TRACKS_PER_JOB,
} from '../src/handoff';
import {
  signHandoffState,
  verifyHandoffState,
  encryptCredential,
  decryptCredential,
  sha256Hex,
  normalizeUsername,
} from '../src/crypto';

const SCHEMA_PATH = join(__dirname, '..', 'schema', '001_init.sql');
const SIGNING_KEY = 'test-signing-key';
const CRED_KEY = 'test-credential-key';
const CALLBACK = 'https://api.savas.ca/scrobblify/auth/callback';
const NOW = 1_800_000_000;

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

/** Stands in for LastFmClient; counts calls so replay protection is provable. */
class FakeLastFm {
  public getSessionCalls = 0;

  constructor(
    private username: string,
    private behaviour: 'ok' | 'throw' = 'ok',
  ) {}

  async getSession(token: string) {
    this.getSessionCalls += 1;
    if (this.behaviour === 'throw') {
      throw new Error('Last.fm API error 4 (HTTP 200): Invalid token');
    }
    return { sessionKey: `sk-for-${this.username}-${token}`, username: this.username };
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
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  return new NodeSql(db);
}

const req = (username: string, trackCount = 10_000) => ({
  username,
  payloadDigest: 'abc123',
  trackCount,
  chunkCount: 2,
  declaredBytes: 5000,
});

async function addChunks(
  sql: Sql,
  jobId: string,
  ranges: [number, number][],
  opts: { verified?: boolean } = {},
) {
  for (let i = 0; i < ranges.length; i += 1) {
    const [start, end] = ranges[i];
    // eslint-disable-next-line no-await-in-loop
    await sql.run(
      `INSERT INTO chunks (job_id, chunk_index, r2_key, start_index, end_index,
                           entry_count, digest, compressed_bytes, uncompressed_bytes,
                           verified, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'd', 10, 20, ?, ?)`,
      [jobId, i, `${jobId}/${i}`, start, end, end - start, opts.verified === false ? 0 : 1, NOW],
    );
  }
}

async function main() {
  console.log('\n-- state signing --');
  const state = await signHandoffState({ h: 'abc', exp: NOW + 600 }, SIGNING_KEY);
  check('round-trips', (await verifyHandoffState(state, SIGNING_KEY, NOW))?.h === 'abc');
  check('rejects a wrong key', (await verifyHandoffState(state, 'other', NOW)) === null);
  check('rejects when expired', (await verifyHandoffState(state, SIGNING_KEY, NOW + 601)) === null);
  check('rejects a tampered body',
    (await verifyHandoffState(`x${state}`, SIGNING_KEY, NOW)) === null);
  check('rejects a truncated value', (await verifyHandoffState('nodot', SIGNING_KEY, NOW)) === null);
  check('rejects an empty signature',
    (await verifyHandoffState('body.', SIGNING_KEY, NOW)) === null);

  // A client-generated state must not be accepted: that is the entire point of
  // the server preflight.
  const forged = `${Buffer.from(JSON.stringify({ h: 'abc', exp: NOW + 600 })).toString('base64url')}.AAAA`;
  check('rejects an unsigned forgery', (await verifyHandoffState(forged, SIGNING_KEY, NOW)) === null);

  console.log('\n-- credential encryption --');
  const encrypted = await encryptCredential('session-key-value', CRED_KEY, 'job-1');
  check('ciphertext is not the plaintext', !encrypted.ciphertext.includes('session-key-value'));
  check('decrypts with the right job', await decryptCredential(encrypted, CRED_KEY, 'job-1') === 'session-key-value');
  check('a credential moved to another job will not decrypt',
    (await decryptCredential(encrypted, CRED_KEY, 'job-2')) === null);
  check('wrong secret fails closed',
    (await decryptCredential(encrypted, 'wrong', 'job-1')) === null);
  const again = await encryptCredential('session-key-value', CRED_KEY, 'job-1');
  check('iv is random per encryption', again.ciphertext !== encrypted.ciphertext);

  console.log('\n-- preflight --');
  const sql = freshDb();
  const pre = await preflight(sql, req('Alice'), SIGNING_KEY, CALLBACK, NOW);
  check('succeeds', pre.ok);
  check('callback carries an encoded state',
    (pre as any).callbackUrl.startsWith(`${CALLBACK}?state=`));
  check('state is url-encoded so Last.fm cannot swallow it',
    !(pre as any).callbackUrl.slice(CALLBACK.length + 7).includes('&'));

  const stored = await sql.first<any>('SELECT * FROM handoffs WHERE id = ?', [(pre as any).handoffId]);
  check('username is normalised at rest', stored.username === 'alice', stored.username);
  check('starts in issued', stored.state === 'issued');

  const dup = await preflight(sql, req('alice'), SIGNING_KEY, CALLBACK, NOW);
  check('a second tab is refused', !dup.ok && (dup as any).reason === 'already_live', dup);

  const huge = await preflight(sql, req('bob', MAX_TRACKS_PER_JOB + 1), SIGNING_KEY, CALLBACK, NOW);
  check('admission control rejects unfinishable jobs',
    !huge.ok && (huge as any).reason === 'too_large', huge);
  const empty = await preflight(sql, req('bob', 0), SIGNING_KEY, CALLBACK, NOW);
  check('rejects an empty job', !empty.ok);

  const paused = freshDb();
  await paused.run('UPDATE control SET paused = 1 WHERE id = 1');
  const whilePaused = await preflight(paused, req('carol'), SIGNING_KEY, CALLBACK, NOW);
  check('kill switch blocks new handoffs',
    !whilePaused.ok && (whilePaused as any).reason === 'paused');

  console.log('\n-- callback: the username check --');
  const db2 = freshDb();
  const p2 = await preflight(db2, req('alice'), SIGNING_KEY, CALLBACK, NOW) as any;
  const attacker = new FakeLastFm('mallory');
  const mismatch = await handleCallback(
    db2, attacker as any, { state: p2.state, token: 'tok' }, SIGNING_KEY, CRED_KEY, NOW,
  );
  check('a different account is refused',
    !mismatch.ok && (mismatch as any).reason === 'username_mismatch', mismatch);
  let hrow = await db2.first<any>('SELECT * FROM handoffs WHERE id = ?', [p2.handoffId]);
  check('handoff failed', hrow.state === 'failed' && hrow.failure_reason === 'username_mismatch');
  check('no job was created', hrow.job_id === null);
  check('slot released', hrow.live_username === null);
  const anyJob = await db2.all('SELECT id FROM jobs');
  check('mismatched credential is never persisted', anyJob.length === 0, anyJob);

  console.log('\n-- callback: happy path --');
  const db3 = freshDb();
  const p3 = await preflight(db3, req('alice'), SIGNING_KEY, CALLBACK, NOW) as any;
  const lastfm = new FakeLastFm('Alice');
  const cb = await handleCallback(
    db3, lastfm as any, { state: p3.state, token: 'tok' }, SIGNING_KEY, CRED_KEY, NOW,
  );
  check('exchange succeeds', cb.ok);
  check('case difference in username is tolerated', cb.ok);
  const job = await db3.first<any>('SELECT * FROM jobs WHERE id = ?', [(cb as any).jobId]);
  check('job created in pending, not active', job.state === 'pending');
  check('credential stored encrypted', job.session_key_ct && !job.session_key_ct.includes('sk-for'));
  check('credential decrypts under the job id',
    (await decryptCredential(
      { ciphertext: job.session_key_ct, iv: job.session_key_iv }, CRED_KEY, job.id,
    )) === 'sk-for-Alice-tok');
  check('credential TTL recorded', job.credential_expires_at > NOW);
  check('algorithm version pinned', job.algorithm_version === 1);

  console.log('\n-- callback: replay --');
  const replay = await handleCallback(
    db3, lastfm as any, { state: p3.state, token: 'tok' }, SIGNING_KEY, CRED_KEY, NOW,
  );
  check('replay returns the winner outcome', replay.ok && (replay as any).alreadyDone === true, replay);
  check('replay does not call auth.getSession again', lastfm.getSessionCalls === 1, lastfm.getSessionCalls);
  check('replay returns the same job', (replay as any).jobId === (cb as any).jobId);
  const jobCount = await db3.all('SELECT id FROM jobs');
  check('replay did not create a second job', jobCount.length === 1, jobCount.length);

  console.log('\n-- callback: rejections --');
  const db4 = freshDb();
  const p4 = await preflight(db4, req('alice'), SIGNING_KEY, CALLBACK, NOW) as any;
  const bad = await handleCallback(
    db4, new FakeLastFm('alice') as any,
    { state: 'garbage', token: 'tok' }, SIGNING_KEY, CRED_KEY, NOW,
  );
  check('forged state refused', !bad.ok && (bad as any).reason === 'bad_state');
  const noToken = await handleCallback(
    db4, new FakeLastFm('alice') as any,
    { state: p4.state, token: '' }, SIGNING_KEY, CRED_KEY, NOW,
  );
  check('missing token refused', !noToken.ok);

  const expiredCb = await handleCallback(
    db4, new FakeLastFm('alice') as any,
    { state: p4.state, token: 'tok' }, SIGNING_KEY, CRED_KEY, NOW + 7200,
  );
  check('expired state refused', !expiredCb.ok, expiredCb);

  const db5 = freshDb();
  const p5 = await preflight(db5, req('alice'), SIGNING_KEY, CALLBACK, NOW) as any;
  const failing = new FakeLastFm('alice', 'throw');
  const failed = await handleCallback(
    db5, failing as any, { state: p5.state, token: 'tok' }, SIGNING_KEY, CRED_KEY, NOW,
  );
  check('a failed exchange is reported', !failed.ok && (failed as any).reason === 'exchange_failed');
  hrow = await db5.first<any>('SELECT * FROM handoffs WHERE id = ?', [p5.handoffId]);
  check('failed exchange releases the slot', hrow.live_username === null);
  check('failed exchange is not left mid-flight', hrow.state === 'failed');

  console.log('\n-- finalize --');
  const db6 = freshDb();
  const p6 = await preflight(db6, req('alice', 100), SIGNING_KEY, CALLBACK, NOW) as any;
  const cb6 = await handleCallback(
    db6, new FakeLastFm('alice') as any,
    { state: p6.state, token: 'tok' }, SIGNING_KEY, CRED_KEY, NOW,
  ) as any;

  let fin = await finalize(db6, p6.handoffId, 'k', 'd', NOW);
  check('refuses to activate with no chunks',
    !fin.ok && (fin as any).reason === 'incomplete_upload', fin);

  await addChunks(db6, cb6.jobId, [[0, 50], [60, 100]]);
  fin = await finalize(db6, p6.handoffId, 'k', 'd', NOW);
  check('refuses a gap between chunks',
    !fin.ok && (fin as any).reason === 'incomplete_upload', fin);

  await db6.run('DELETE FROM chunks WHERE job_id = ?', [cb6.jobId]);
  await addChunks(db6, cb6.jobId, [[0, 60], [50, 100]]);
  fin = await finalize(db6, p6.handoffId, 'k', 'd', NOW);
  check('refuses overlapping chunks', !fin.ok, fin);

  await db6.run('DELETE FROM chunks WHERE job_id = ?', [cb6.jobId]);
  await addChunks(db6, cb6.jobId, [[0, 50], [50, 100]], { verified: false });
  fin = await finalize(db6, p6.handoffId, 'k', 'd', NOW);
  check('refuses unverified chunks', !fin.ok, fin);

  await db6.run('DELETE FROM chunks WHERE job_id = ?', [cb6.jobId]);
  await addChunks(db6, cb6.jobId, [[0, 50], [50, 90]]);
  fin = await finalize(db6, p6.handoffId, 'k', 'd', NOW);
  check('refuses when chunks do not cover every track', !fin.ok, fin);

  await db6.run('DELETE FROM chunks WHERE job_id = ?', [cb6.jobId]);
  await addChunks(db6, cb6.jobId, [[0, 50], [50, 100]]);
  fin = await finalize(db6, p6.handoffId, 'manifest-key', 'manifest-digest', NOW);
  check('activates on a complete contiguous upload', fin.ok, fin);
  const activeJob = await db6.first<any>('SELECT * FROM jobs WHERE id = ?', [cb6.jobId]);
  check('job is now active', activeJob.state === 'active');
  check('manifest recorded', activeJob.manifest_key === 'manifest-key');
  check('job is immediately schedulable', activeJob.next_eligible_at <= NOW);
  hrow = await db6.first<any>('SELECT * FROM handoffs WHERE id = ?', [p6.handoffId]);
  check('handoff terminal', hrow.state === 'active');
  check('handoff released its username lock', hrow.live_username === null);
  check('job holds the username lock instead', activeJob.live_username === 'alice');

  const refin = await finalize(db6, p6.handoffId, 'manifest-key', 'manifest-digest', NOW);
  check('finalize is idempotent when the response was lost',
    refin.ok && (refin as any).alreadyActive === true, refin);

  console.log('\n-- reaping --');
  const db7 = freshDb();
  const p7 = await preflight(db7, req('alice'), SIGNING_KEY, CALLBACK, NOW) as any;
  const cb7 = await handleCallback(
    db7, new FakeLastFm('alice') as any,
    { state: p7.state, token: 'tok' }, SIGNING_KEY, CRED_KEY, NOW,
  ) as any;
  check('nothing reaped before expiry', (await reapExpiredHandoffs(db7, NOW)) === 0);
  const reaped = await reapExpiredHandoffs(db7, NOW + 7200);
  check('expired handoff reaped', reaped === 1, reaped);
  const abandoned = await db7.first<any>('SELECT * FROM jobs WHERE id = ?', [cb7.jobId]);
  check('abandoned job cancelled', abandoned.state === 'cancelled');
  check('abandoned credential destroyed', abandoned.session_key_ct === null);
  check('abandoned job released its slot', abandoned.live_username === null);

  // A reaper firing while a finalize commits must not undo a live job.
  const db8 = freshDb();
  const p8 = await preflight(db8, req('alice', 10), SIGNING_KEY, CALLBACK, NOW) as any;
  const cb8 = await handleCallback(
    db8, new FakeLastFm('alice') as any,
    { state: p8.state, token: 'tok' }, SIGNING_KEY, CRED_KEY, NOW,
  ) as any;
  await addChunks(db8, cb8.jobId, [[0, 10]]);
  await db8.run('UPDATE handoffs SET chunk_count = 1 WHERE id = ?', [p8.handoffId]);
  await finalize(db8, p8.handoffId, 'k', 'd', NOW);
  await failHandoff(db8, p8.handoffId, 'reaped', NOW + 7200);
  const survivor = await db8.first<any>('SELECT * FROM jobs WHERE id = ?', [cb8.jobId]);
  check('a late reaper cannot kill an active job', survivor.state === 'active', survivor.state);
  check('a late reaper cannot destroy a live credential', survivor.session_key_ct !== null);

  console.log('\n-- misc --');
  check('sha256 is stable', (await sha256Hex(new TextEncoder().encode('abc')))
    === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  check('username normalisation folds case only',
    normalizeUsername('  MixedCase  ') === 'mixedcase');

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
