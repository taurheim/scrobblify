/**
 * API tests.
 *
 * The cases that matter here are authorisation ones: one authenticated user
 * must never be able to read, upload into, cancel or export another's job.
 */
import { DatabaseSync } from 'node:sqlite';
import { schemaSql } from './schema';
import { Sql, SqlResult, JobRow } from '../src/store';
import { BlobStore, gzip, uploadChunk, CHUNK_TRACKS } from '../src/chunks';
import { encryptCredential, sha256Hex, randomId, signPayload } from '../src/crypto';
import { issueSession, SESSION_TTL_SECONDS } from '../src/session';
import { ALGORITHM_VERSION } from '../src/handoff';
import { handleRequest, ApiEnv, MIN_TRACKS_FOR_BACKGROUND } from '../src/api';

const NOW = 1_800_000_000;
const SIGNING = 'signing-key-for-tests-0123456789';
const CRED = 'credential-secret-for-tests-01234';
const APP = 'https://savas.ca/scrobble';
const CB = 'https://api.savas.ca/scrobblify/auth/callback';

class NodeSql implements Sql {
  constructor(private db: DatabaseSync) {}

  async all<T>(q: string, p: unknown[] = []): Promise<T[]> {
    return this.db.prepare(q).all(...(p as any[])) as T[];
  }

  async first<T>(q: string, p: unknown[] = []): Promise<T | null> {
    return (this.db.prepare(q).get(...(p as any[])) ?? null) as T | null;
  }

  async run(q: string, p: unknown[] = []): Promise<SqlResult> {
    return { changes: Number(this.db.prepare(q).run(...(p as any[])).changes) };
  }

  async batch(s: { query: string; params?: unknown[] }[]): Promise<SqlResult[]> {
    const out: SqlResult[] = [];
    for (const x of s) {
      // eslint-disable-next-line no-await-in-loop
      out.push(await this.run(x.query, x.params ?? []));
    }
    return out;
  }
}

class MemoryBlobs implements BlobStore {
  public data = new Map<string, Uint8Array>();

  async put(k: string, v: ArrayBuffer | Uint8Array) {
    this.data.set(k, v instanceof Uint8Array ? v : new Uint8Array(v));
  }

  async get(k: string) {
    const v = this.data.get(k);
    return v ? (v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer) : null;
  }

  async delete(ks: string[]) {
    ks.forEach((k) => this.data.delete(k));
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

function makeEnv(sql: Sql, blobs: BlobStore, lastfm: any = {}): ApiEnv {
  return {
    sql,
    blobs,
    lastfm,
    signingKey: SIGNING,
    credentialSecret: CRED,
    callbackUrl: CB,
    appUrl: APP,
    lastfmApiKey: 'worker-api-key',
    now: () => NOW,
  };
}

function freshSql(): Sql {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql());
  return new NodeSql(db);
}

function req(path: string, init: RequestInit & { token?: string } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.token) {
    headers.set('Authorization', `Bearer ${init.token}`);
  }
  return new Request(`https://api.savas.ca${path}`, { ...init, headers });
}

function tracksNdjson(count: number): Uint8Array {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(JSON.stringify({
      artist: `Artist ${i}`,
      track: `Track ${i}`,
      album: 'Album',
      originalTimestampSec: 1_700_000_000 + i,
    }));
  }
  return new TextEncoder().encode(lines.join('\n'));
}

async function seedJob(sql: Sql, blobs: BlobStore, username: string, opts: {
  total?: number; cursor?: number; live?: boolean; state?: string;
} = {}): Promise<string> {
  const total = opts.total ?? 100;
  const id = randomId();
  const cred = await encryptCredential('sk', CRED, id);
  await sql.run(
    `INSERT INTO jobs (id, username, live_username, state, algorithm_version, total_tracks,
        cursor, session_key_ct, session_key_iv, created_at, updated_at, credential_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, username, opts.live === false ? null : username, opts.state ?? 'active',
      ALGORITHM_VERSION, total, opts.cursor ?? 0, cred.ciphertext, cred.iv,
      NOW, NOW, NOW + 60 * 86400,
    ],
  );
  const raw = tracksNdjson(total);
  const gz = await gzip(raw);
  const buf = gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) as ArrayBuffer;
  await uploadChunk(sql, blobs, {
    jobId: id,
    chunkIndex: 0,
    startIndex: 0,
    digest: await sha256Hex(gz),
    entryCount: total,
    compressed: buf,
  }, NOW);
  return id;
}

async function main() {
  console.log('\n-- capacity --');
  {
    const sql = freshSql();
    const env = makeEnv(sql, new MemoryBlobs());
    const res = await handleRequest(env, req('/scrobblify/capacity'));
    const body: any = await res.json();
    check('capacity is public', res.status === 200);
    check('reports availability', body.available === true, body);
    check('advertises the threshold the SPA must apply',
      body.minTracks === MIN_TRACKS_FOR_BACKGROUND, body);
    check('advertises the chunk size the SPA must use',
      body.chunkTracks === CHUNK_TRACKS, body);
    check('is not cacheable', res.headers.get('Cache-Control') === 'no-store');
    check('allows only the app origin',
      res.headers.get('Access-Control-Allow-Origin') === 'https://savas.ca',
      res.headers.get('Access-Control-Allow-Origin'));
    check('does not enable cookie credentials',
      res.headers.get('Access-Control-Allow-Credentials') === null);

    await sql.run("UPDATE control SET paused = 1 WHERE id = 1");
    const paused: any = await (await handleRequest(env, req('/scrobblify/capacity'))).json();
    check('a paused worker advertises itself as unavailable', paused.available === false);
  }

  console.log('\n-- preflight --');
  {
    const sql = freshSql();
    const env = makeEnv(sql, new MemoryBlobs());
    const small = await handleRequest(env, req('/scrobblify/handoff/preflight', {
      method: 'POST',
      body: JSON.stringify({
        username: 'listener', payloadDigest: 'd', trackCount: 100, chunkCount: 1, declaredBytes: 10,
      }),
    }));
    check('a small import is refused background mode', small.status === 400);

    const res = await handleRequest(env, req('/scrobblify/handoff/preflight', {
      method: 'POST',
      body: JSON.stringify({
        username: 'Listener',
        payloadDigest: 'abc',
        trackCount: 40000,
        chunkCount: 40,
        declaredBytes: 1000,
      }),
    }));
    const body: any = await res.json();
    check('a large import is accepted', body.ok === true, body);
    check('a handoff row is committed before the redirect',
      (await sql.all('SELECT 1 FROM handoffs')).length === 1);
    check('the username is normalised on the row',
      (await sql.first<any>('SELECT username FROM handoffs')).username === 'listener');

    const authorise = new URL(body.authoriseUrl);
    check('the redirect points at Last.fm',
      authorise.origin === 'https://www.last.fm', authorise.origin);
    check('it uses the worker api key', authorise.searchParams.get('api_key') === 'worker-api-key');
    // An unencoded `&` would let our state bind to Last.fm's URL and vanish,
    // and the callback would arrive with no state at all.
    const cb = authorise.searchParams.get('cb')!;
    check('the callback is fully URL-encoded', new URL(cb).searchParams.get('state') !== null, cb);
    check('the callback points at the worker, not the SPA',
      new URL(cb).origin === 'https://api.savas.ca', cb);

    const badBody = await handleRequest(env, req('/scrobblify/handoff/preflight', {
      method: 'POST', body: 'not json',
    }));
    check('malformed JSON is a 400, not a 500', badBody.status === 400);
  }

  console.log('\n-- authentication --');
  {
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    await seedJob(sql, blobs, 'listener');

    check('no token is a 401',
      (await handleRequest(env, req('/scrobblify/job'))).status === 401);
    check('a garbage token is a 401',
      (await handleRequest(env, req('/scrobblify/job', { token: 'nonsense' }))).status === 401);

    // A token signed with the wrong key must fail closed, not merely fail to
    // parse: this is the whole basis of authorisation.
    const forged = await signPayload({ u: 'listener', iat: NOW, exp: NOW + 3600 }, 'wrong-key');
    check('a forged token is a 401',
      (await handleRequest(env, req('/scrobblify/job', { token: forged }))).status === 401);

    const expired = await issueSession('listener', SIGNING, NOW - SESSION_TTL_SECONDS - 10);
    check('an expired token is a 401',
      (await handleRequest(env, req('/scrobblify/job', { token: expired }))).status === 401);

    const good = await issueSession('listener', SIGNING, NOW);
    check('a valid token works',
      (await handleRequest(env, req('/scrobblify/job', { token: good }))).status === 200);
    check('username case does not matter',
      (await handleRequest(env, req('/scrobblify/job', {
        token: await issueSession('LISTENER', SIGNING, NOW),
      }))).status === 200);
  }

  console.log('\n-- one user must not reach another user\'s job --');
  {
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const victimJob = await seedJob(sql, blobs, 'victim');
    const attacker = await issueSession('attacker', SIGNING, NOW);

    for (const [action, method] of [['pause', 'POST'], ['resume', 'POST'], ['cancel', 'POST'], ['export', 'GET']] as const) {
      // eslint-disable-next-line no-await-in-loop
      const res = await handleRequest(env, req(
        `/scrobblify/job/${victimJob}/${action}`, { method, token: attacker },
      ));
      check(`${action} on someone else's job is a 404`, res.status === 404, res.status);
    }
    const still = await sql.first<JobRow>('SELECT * FROM jobs WHERE id = ?', [victimJob]);
    check('the victim job is untouched', still!.state === 'active', still!.state);
    check('and its credential is intact', still!.session_key_ct !== null);

    const status = await handleRequest(env, req('/scrobblify/job', { token: attacker }));
    const body: any = await status.json();
    check('the attacker sees no job of their own', body.job === null, body);
  }

  console.log('\n-- one user must not upload into another user\'s job --');
  {
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const handoffId = randomId();
    await sql.run(
      `INSERT INTO handoffs (id, state, username, live_username, payload_digest, track_count,
          chunk_count, declared_bytes, algorithm_version, job_id, created_at, updated_at, expires_at)
       VALUES (?, 'pending_upload', 'victim', 'victim', 'd', 5000, 5, 100, ?, 'victim-job', ?, ?, ?)`,
      [handoffId, ALGORITHM_VERSION, NOW, NOW, NOW + 3600],
    );
    const gz = await gzip(tracksNdjson(10));
    const res = await handleRequest(env, req(`/scrobblify/handoff/${handoffId}/chunk/0`, {
      method: 'PUT',
      token: await issueSession('attacker', SIGNING, NOW),
      headers: { 'X-Chunk-Digest': await sha256Hex(gz) },
      body: gz as any,
    }));
    check('uploading into another user\'s handoff is a 404', res.status === 404, res.status);
    check('nothing was stored', blobs.data.size === 0);

    const finalizeRes = await handleRequest(env, req(`/scrobblify/handoff/${handoffId}/finalize`, {
      method: 'POST', token: await issueSession('attacker', SIGNING, NOW),
    }));
    check('finalising another user\'s handoff is a 404', finalizeRes.status === 404);

    const statusRes = await handleRequest(env, req(`/scrobblify/handoff/${handoffId}`, {
      token: await issueSession('attacker', SIGNING, NOW),
    }));
    check('reading another user\'s handoff is a 404', statusRes.status === 404);
  }

  console.log('\n-- upload --');
  {
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const handoffId = randomId();
    await sql.run(
      `INSERT INTO handoffs (id, state, username, live_username, payload_digest, track_count,
          chunk_count, declared_bytes, algorithm_version, job_id, created_at, updated_at, expires_at)
       VALUES (?, 'pending_upload', 'listener', 'listener', 'd', 10, 1, 100, ?, 'job-1', ?, ?, ?)`,
      [handoffId, ALGORITHM_VERSION, NOW, NOW, NOW + 3600],
    );
    const token = await issueSession('listener', SIGNING, NOW);
    const gz = await gzip(tracksNdjson(10));

    const noDigest = await handleRequest(env, req(`/scrobblify/handoff/${handoffId}/chunk/0?count=10`, {
      method: 'PUT', token, body: gz as any,
    }));
    check('an unhashed chunk is refused', noDigest.status === 400, noDigest.status);

    const ok = await handleRequest(env, req(`/scrobblify/handoff/${handoffId}/chunk/0?count=10`, {
      method: 'PUT', token, headers: { 'X-Chunk-Digest': await sha256Hex(gz) }, body: gz as any,
    }));
    check('a hashed chunk is accepted', ok.status === 200, await ok.clone().text());
    check('it is stored', blobs.data.size === 1);

    const wrongDigest = await handleRequest(env, req(`/scrobblify/handoff/${handoffId}/chunk/1?count=10`, {
      method: 'PUT', token, headers: { 'X-Chunk-Digest': 'deadbeef' }, body: gz as any,
    }));
    check('a mis-hashed chunk is refused', wrongDigest.status === 400);
  }

  console.log('\n-- uploading into a handoff that is not expecting data --');
  {
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const handoffId = randomId();
    await sql.run(
      `INSERT INTO handoffs (id, state, username, live_username, payload_digest, track_count,
          chunk_count, declared_bytes, algorithm_version, job_id, created_at, updated_at, expires_at)
       VALUES (?, 'active', 'listener', NULL, 'd', 10, 1, 100, ?, 'job-1', ?, ?, ?)`,
      [handoffId, ALGORITHM_VERSION, NOW, NOW, NOW + 3600],
    );
    const gz = await gzip(tracksNdjson(10));
    const res = await handleRequest(env, req(`/scrobblify/handoff/${handoffId}/chunk/0?count=10`, {
      method: 'PUT',
      token: await issueSession('listener', SIGNING, NOW),
      headers: { 'X-Chunk-Digest': await sha256Hex(gz) },
      body: gz as any,
    }));
    // Accepting this would rewrite the payload of a job that is already
    // running, which the write-once rule exists to prevent.
    check('a live job cannot have data pushed into it', res.status === 409, res.status);
    check('nothing was stored', blobs.data.size === 0);
  }

  console.log('\n-- job status --');
  {
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const id = await seedJob(sql, blobs, 'listener', { total: 90000, cursor: 9000 });
    await sql.run('UPDATE jobs SET scrobbled_count = 8900, failed_count = 100 WHERE id = ?', [id]);
    const body: any = await (await handleRequest(env, req('/scrobblify/job', {
      token: await issueSession('listener', SIGNING, NOW),
    }))).json();

    check('progress is reported', body.job.scrobbled === 8900, body.job);
    check('failures are reported', body.job.failed === 100);
    check('remaining is reported', body.job.remaining === 81000, body.job.remaining);
    // Without a date, a user watching a 30-day job concludes it is broken and
    // re-imports, which is the duplicate source this feature exists to remove.
    check('an estimated completion date is given',
      body.job.estimatedCompletionSec > NOW, body.job.estimatedCompletionSec);
    check('the estimate is roughly 30 days out',
      Math.abs((body.job.estimatedCompletionSec - NOW) / 86400 - 30) < 1,
      (body.job.estimatedCompletionSec - NOW) / 86400);
    check('no credential material is exposed',
      !JSON.stringify(body).includes('session_key')
      && (body.job as any).session_key_ct === undefined, Object.keys(body.job));
  }

  console.log('\n-- a finished job is still reported --');
  {
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const id = await seedJob(sql, blobs, 'listener', { live: false, state: 'completed' });
    await sql.run(
      'UPDATE jobs SET scrobbled_count = 94203, failed_count = 112, completed_at = ? WHERE id = ?',
      [NOW - 86400, id],
    );
    const body: any = await (await handleRequest(env, req('/scrobblify/job', {
      token: await issueSession('listener', SIGNING, NOW),
    }))).json();
    // "no job found" after a month of work is the wrong answer.
    check('a returning user sees the result, not nothing', body.job !== null, body);
    check('with the totals', body.job.scrobbled === 94203, body.job);
    check('marked completed', body.job.state === 'completed');
  }

  console.log('\n-- controls --');
  {
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const id = await seedJob(sql, blobs, 'listener');
    const token = await issueSession('listener', SIGNING, NOW);

    await handleRequest(env, req(`/scrobblify/job/${id}/pause`, { method: 'POST', token }));
    check('pause works', (await sql.first<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]))!.state === 'paused');

    await handleRequest(env, req(`/scrobblify/job/${id}/resume`, { method: 'POST', token }));
    const resumed = await sql.first<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]);
    check('resume works', resumed!.state === 'active');
    check('resume clears accumulated strikes', resumed!.consecutive_failures === 0);

    check('a GET on a POST action is refused',
      (await handleRequest(env, req(`/scrobblify/job/${id}/pause`, { token }))).status === 405);
  }

  console.log('\n-- cancel deletes the credential and the data --');
  {
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const id = await seedJob(sql, blobs, 'listener');
    const token = await issueSession('listener', SIGNING, NOW);
    check('data exists first', blobs.data.size === 1);

    await handleRequest(env, req(`/scrobblify/job/${id}/cancel`, { method: 'POST', token }));
    const job = await sql.first<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]);
    check('the job is cancelled', job!.state === 'cancelled', job!.state);
    check('the credential is deleted immediately', job!.session_key_ct === null);
    check('the slot is released', job!.live_username === null);
    check('the listening history is deleted', blobs.data.size === 0);
    check('and its rows with it',
      (await sql.all('SELECT 1 FROM chunks WHERE job_id = ?', [id])).length === 0);
    check('a purge date is set for the summary', job!.purge_after! > NOW);
  }

  console.log('\n-- export escape hatch --');
  {
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const id = await seedJob(sql, blobs, 'listener', { total: 100, cursor: 40 });
    await sql.run(
      `INSERT INTO failures (job_id, track_index, artist, track, album, reason, ignore_code, created_at)
       VALUES (?, 55, 'Artist 55', 'Track 55', 'Album', 'Artist ignored', 1, ?)`,
      [id, NOW],
    );
    const token = await issueSession('listener', SIGNING, NOW);
    const body: any = await (await handleRequest(env,
      req(`/scrobblify/job/${id}/export`, { token }))).json();

    // The export exists so a user can finish client-side. Without the tracks
    // it is unusable, which would defeat the whole escape hatch.
    check('the remaining tracks are included', body.state.tracks.length === 59,
      body.state.tracks.length);
    check('it starts at the cursor, not the beginning',
      body.state.tracks[0].track === 'Track 40', body.state.tracks[0]);
    check('already-scrobbled tracks are not re-sent',
      !body.state.tracks.some((t: any) => t.track === 'Track 39'));
    check('permanently rejected tracks are not re-sent either',
      !body.state.tracks.some((t: any) => t.track === 'Track 55'));
    check('but they are reported', body.failures.length === 1, body.failures);

    // StateManager.importFromFile requires exactly these four.
    for (const field of ['totalTracks', 'completedIndices', 'failedIndices', 'tracks']) {
      check(`the importer's required field "${field}" is present`, field in body.state);
    }
    check('completedIndices is an array, as the importer expects',
      Array.isArray(body.state.completedIndices), body.state.completedIndices);
    check('totalTracks matches the list it ships with',
      body.state.totalTracks === body.state.tracks.length);
    check('tracks carry the fields the importer reads',
      ['artist', 'track', 'album', 'timestamp'].every((k) => k in body.state.tracks[0]),
      body.state.tracks[0]);
    check('timestamps are milliseconds, as the client uses',
      body.state.tracks[0].timestamp > 1e12, body.state.tracks[0].timestamp);
  }

  console.log('\n-- unknown routes --');
  {
    const sql = freshSql();
    const env = makeEnv(sql, new MemoryBlobs());
    check('unknown authenticated route is a 404',
      (await handleRequest(env, req('/scrobblify/nope', {
        token: await issueSession('listener', SIGNING, NOW),
      }))).status === 404);
    // There is deliberately no generic Last.fm proxy: nothing here can
    // scrobble a track that is not already in a job's write-once blob.
    check('there is no scrobble passthrough',
      (await handleRequest(env, req('/scrobblify/scrobble', {
        method: 'POST',
        token: await issueSession('listener', SIGNING, NOW),
        body: '{}',
      }))).status === 404);
    const preflightCors = await handleRequest(env, req('/scrobblify/job', { method: 'OPTIONS' }));
    check('preflight OPTIONS is answered without a token', preflightCors.status === 204);
  }

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
