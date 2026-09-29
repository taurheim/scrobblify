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
import {
  encryptCredential, sha256Hex, randomId, signPayload, signHandoffState,
} from '../src/crypto';
import { issueSession, SESSION_TTL_SECONDS } from '../src/session';
import { ALGORITHM_VERSION } from '../src/handoff';
import { handleRequest, ApiEnv, MIN_TRACKS_FOR_BACKGROUND, collapseToRanges } from '../src/api';
import { assignTimestamps } from '../src/timestamps';

const NOW = 1_800_000_000;
const SIGNING = 'signing-key-for-tests-0123456789';
const CRED = 'credential-secret-for-tests-01234';
/** Export claim token. The endpoint requires one of at least 16 characters. */
const EXPORT_CLAIM = 'export-claim-token-for-tests';
const APP = 'https://savas.ca/scrobblify/scrobble';
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

function tracksNdjson(count: number, reTagged = false, pinFirstSec = 0): Uint8Array {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(JSON.stringify({
      artist: `Artist ${i}`,
      track: `Track ${i}`,
      album: 'Album',
      // 0 is how the client asks for send-time assignment; see toUploadTrack.
      originalTimestampSec: reTagged
        ? (i === 0 ? pinFirstSec : 0)
        : 1_700_000_000 + i,
      // Stated explicitly by any client new enough to pin a second, because a
      // pin makes the zero-timestamp inference wrong for that one track.
      ...(reTagged ? { reTagged: true } : {}),
    }));
  }
  return new TextEncoder().encode(lines.join('\n'));
}

async function seedJob(sql: Sql, blobs: BlobStore, username: string, opts: {
  total?: number; cursor?: number; live?: boolean; state?: string; reTagged?: boolean;
  importId?: string; scrobbled?: number; pinFirstSec?: number;
} = {}): Promise<string> {
  const total = opts.total ?? 100;
  const id = randomId();
  const cred = await encryptCredential('sk', CRED, id);
  await sql.run(
    `INSERT INTO jobs (id, username, live_username, state, algorithm_version, total_tracks,
        cursor, scrobbled_count, import_id, session_key_ct, session_key_iv,
        created_at, updated_at, credential_expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, username, opts.live === false ? null : username, opts.state ?? 'active',
      ALGORITHM_VERSION, total, opts.cursor ?? 0, opts.scrobbled ?? 0,
      opts.importId ?? null, cred.ciphertext, cred.iv,
      NOW, NOW, NOW + 60 * 86400,
    ],
  );
  const raw = tracksNdjson(total, opts.reTagged, opts.pinFirstSec ?? 0);
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

  console.log('\n-- the unauthenticated live-job lookup --');
  {
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);

    const none = await handleRequest(env, req('/scrobblify/job/live?username=listener'));
    const noneBody: any = await none.json();
    check('answers without a session', none.status === 200, none.status);
    check('reports an unknown user as idle', noneBody.live === false, noneBody);

    check('a missing username is rejected',
      (await handleRequest(env, req('/scrobblify/job/live'))).status === 400);

    const jobId = await seedJob(sql, blobs, 'listener');
    const live: any = await (await handleRequest(env, req('/scrobblify/job/live?username=listener'))).json();
    check('reports a running job as live', live.live === true, live);

    // The whole point of answering without a session: this is the browser that
    // lost its storage. A stale or junk token must not turn into a 401 here,
    // or the browser it was built for is the one browser it cannot answer.
    const stale = await handleRequest(
      env, req('/scrobblify/job/live?username=listener', { token: 'expired-nonsense' }),
    );
    const staleBody: any = await stale.json();
    check('a junk session token does not gate the answer', stale.status === 200, stale.status);
    check('and it still reports the job', staleBody.live === true, staleBody);

    check('is case- and whitespace-insensitive like every other username path',
      ((await (await handleRequest(env, req('/scrobblify/job/live?username=%20LISTENER%20'))).json()) as any)
        .live === true);

    check('says nothing beyond the boolean',
      Object.keys(live).sort().join(',') === 'live,ok', Object.keys(live));

    // A paused job is resumable, so it is still the server's queue.
    await sql.run("UPDATE jobs SET state = 'paused' WHERE id = ?", [jobId]);
    check('a paused job still counts as live',
      ((await (await handleRequest(env, req('/scrobblify/job/live?username=listener'))).json()) as any)
        .live === true);

    // `needs_reauth` clears the credential, so the worker cannot send: the
    // browser is free to scrobble again, and must be told so.
    await sql.run(
      "UPDATE jobs SET state = 'needs_reauth', live_username = NULL WHERE id = ?", [jobId],
    );
    check('a job stalled on re-auth does not block the browser',
      ((await (await handleRequest(env, req('/scrobblify/job/live?username=listener'))).json()) as any)
        .live === false);

    await sql.run(
      "UPDATE jobs SET state = 'active', live_username = 'listener' WHERE id = ?", [jobId],
    );
    await sql.run(
      "UPDATE jobs SET state = 'cancelled', live_username = NULL WHERE id = ?", [jobId],
    );
    check('a cancelled job releases the browser',
      ((await (await handleRequest(env, req('/scrobblify/job/live?username=listener'))).json()) as any)
        .live === false);

    // A handover part-way through owns no job row yet, but the worker is about
    // to start: reporting it idle reopens the window the check exists to close.
    await sql.run(
      `INSERT INTO handoffs (id, state, username, live_username, payload_digest,
          track_count, chunk_count, declared_bytes, algorithm_version,
          created_at, updated_at, expires_at)
       VALUES ('h-live', 'issued', 'pending-user', 'pending-user', 'd', 5000, 1, 10, ?, ?, ?, ?)`,
      [ALGORITHM_VERSION, NOW, NOW, NOW + 3600],
    );
    check('an in-flight handoff counts as live',
      ((await (await handleRequest(env, req('/scrobblify/job/live?username=pending-user'))).json()) as any)
        .live === true);
  }

  console.log('\n-- the unauthenticated import lookup --');
  {
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const IMPORT = 'import-id-0123456789abcdef';

    const unknown = await handleRequest(env, req(`/scrobblify/import/${IMPORT}`));
    const unknownBody: any = await unknown.json();
    check('answers without a session', unknown.status === 200, unknown.status);
    check('an unhanded queue is not known', unknownBody.known === false, unknownBody);
    check('and is reported idle', unknownBody.live === false, unknownBody);

    check('a short id is refused rather than answered',
      (await handleRequest(env, req('/scrobblify/import/short'))).status === 400);

    const jobId = await seedJob(sql, blobs, 'listener', {
      importId: IMPORT, total: 5000, cursor: 1200, scrobbled: 1190,
    });
    const live: any = await (await handleRequest(env, req(`/scrobblify/import/${IMPORT}`))).json();
    check('a handed-over queue is known', live.known === true, live);
    check('and reported live while it can send', live.live === true, live);
    check('reports the contiguous prefix, not the progress count',
      live.cursor === 1200 && live.scrobbledCount === 1190, live);

    /*
      The case this endpoint exists for, and the one `/job/live` gets wrong.
      A completed job clears live_username, so the user-scoped question says
      "nothing is running" — which is true, and which a browser still holding
      the queue would read as permission to send all 5,000 again.
    */
    await sql.run(
      "UPDATE jobs SET state = 'completed', live_username = NULL, cursor = 5000 WHERE id = ?",
      [jobId],
    );
    const userScoped: any = await (await handleRequest(
      env, req('/scrobblify/job/live?username=listener'),
    )).json();
    check('the user-scoped question reports idle once the job completes',
      userScoped.live === false, userScoped);
    const done: any = await (await handleRequest(env, req(`/scrobblify/import/${IMPORT}`))).json();
    check('but the queue is still known to have been handed over',
      done.known === true, done);
    check('with the finished cursor, so the browser can skip what was sent',
      done.cursor === 5000 && done.state === 'completed', done);

    // A second handover of the same queue: the current attempt decides.
    await seedJob(sql, blobs, 'listener', { importId: IMPORT, total: 3800, cursor: 40 });
    const again: any = await (await handleRequest(env, req(`/scrobblify/import/${IMPORT}`))).json();
    check('a live re-handover wins over the finished one',
      again.live === true && again.cursor === 40, again);

    // A handoff that has not produced a job yet is still a handover.
    await sql.run(
      `INSERT INTO handoffs (id, state, username, live_username, payload_digest,
          track_count, chunk_count, declared_bytes, algorithm_version, import_id,
          created_at, updated_at, expires_at)
       VALUES ('h-imp', 'issued', 'other', 'other', 'd', 5000, 1, 10, ?, ?, ?, ?, ?)`,
      [ALGORITHM_VERSION, 'pending-import-0123456789', NOW, NOW, NOW + 3600],
    );
    const pending: any = await (await handleRequest(
      env, req('/scrobblify/import/pending-import-0123456789'),
    )).json();
    check('an in-flight handoff with no job yet is known and live',
      pending.known === true && pending.live === true, pending);

    check('the id is the credential, so it says nothing about who owns it',
      pending.username === undefined && pending.jobId === undefined, Object.keys(pending));
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

  console.log('\n-- the import id survives preflight --');
  {
    const sql = freshSql();
    const env = makeEnv(sql, new MemoryBlobs());
    const send = (importId: unknown) => handleRequest(env, req('/scrobblify/handoff/preflight', {
      method: 'POST',
      body: JSON.stringify({
        username: randomId(),
        payloadDigest: 'abc',
        trackCount: 40000,
        chunkCount: 40,
        declaredBytes: 1000,
        importId,
      }),
    }));

    const ok: any = await (await send('import-id-0123456789abcdef')).json();
    check('a well-formed id is stored on the handoff',
      (await sql.first<any>('SELECT import_id FROM handoffs WHERE id = ?', [ok.handoffId]))
        .import_id === 'import-id-0123456789abcdef');

    // Nothing here may refuse the handoff: a cached bundle predating this
    // field must still be able to hand over, and a client sending rubbish
    // should degrade to "no identity" rather than lose the whole feature.
    const none: any = await (await send(undefined)).json();
    check('an absent id is accepted and left null',
      none.ok === true
      && (await sql.first<any>('SELECT import_id FROM handoffs WHERE id = ?', [none.handoffId]))
        .import_id === null, none);

    const short: any = await (await send('tooshort')).json();
    check('an id too short to be a capability is dropped, not stored',
      short.ok === true
      && (await sql.first<any>('SELECT import_id FROM handoffs WHERE id = ?', [short.handoffId]))
        .import_id === null, short);

    // The route matches [\w-]+, so anything else could be stored and then be
    // permanently unreadable through the endpoint that exists to read it.
    const bad: any = await (await send('has/slash and spaces')).json();
    check('an id the lookup route could not match is dropped',
      bad.ok === true
      && (await sql.first<any>('SELECT import_id FROM handoffs WHERE id = ?', [bad.handoffId]))
        .import_id === null, bad);

    const wrongType: any = await (await send(12345)).json();
    check('a non-string id is dropped rather than coerced',
      wrongType.ok === true
      && (await sql.first<any>('SELECT import_id FROM handoffs WHERE id = ?', [wrongType.handoffId]))
        .import_id === null, wrongType);
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

    for (const [action, method] of [['pause', 'POST'], ['resume', 'POST'], ['cancel', 'POST'], ['export', 'POST']] as const) {
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
    const id = await seedJob(sql, blobs, 'listener', { total: 100, cursor: 40, state: 'paused' });
    await sql.run(
      `INSERT INTO failures (job_id, track_index, artist, track, album, reason, ignore_code, created_at)
       VALUES (?, 55, 'Artist 55', 'Track 55', 'Album', 'Artist ignored', 1, ?)`,
      [id, NOW],
    );
    const token = await issueSession('listener', SIGNING, NOW);
    const body: any = await (await handleRequest(env,
      req(`/scrobblify/job/${id}/export`, { method: 'POST', token, body: JSON.stringify({ claim: EXPORT_CLAIM }) }))).json();

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
    check('tracks with a real listen date are not marked re-tagged',
      body.state.tracks.every((t: any) => t.reTagged === false));
  }

  console.log('\n-- a re-tagged job survives the round trip --');
  {
    /*
      Re-tagged plays are stored with originalTimestampSec 0, meaning "assign
      one at send time". Exporting that literally would hand back a queue
      stamped 1970 with reTagged false, which the client preserves verbatim
      (an explicit false suppresses its own inference) and Last.fm rejects
      wholesale as older than 14 days — a silent total loss of the export.
    */
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const id = await seedJob(sql, blobs, 'listener', {
      total: 100, cursor: 40, reTagged: true, state: 'paused',
    });
    const token = await issueSession('listener', SIGNING, NOW);
    const body: any = await (await handleRequest(env,
      req(`/scrobblify/job/${id}/export`, { method: 'POST', token, body: JSON.stringify({ claim: EXPORT_CLAIM }) }))).json();

    check('re-tagged tracks come back flagged',
      body.state.tracks.every((t: any) => t.reTagged === true), body.state.tracks[0]);
    check('and never with a 1970 timestamp',
      body.state.tracks.every((t: any) => t.timestamp > 1e12), body.state.tracks[0]);
  }

  console.log('\n-- a pinned second survives the export as a re-tagged track --');
  {
    /*
      The head of a handed-over queue may carry a *pinned* second: the client
      sent that exact (artist, track, second) and never learned whether it
      landed, so it hands the second over rather than letting the worker mint
      a new one and create a phantom play.

      A pin is non-zero, so the old `originalTimestampSec === 0` inference
      called that track a genuine listen. The export then said `reTagged:
      false`, the browser preserved the date verbatim, and Last.fm rejected it
      once the second aged past fourteen days — a play lost outright. The
      explicit flag is what stops that.
    */
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const pin = 1_700_000_500;
    const id = await seedJob(sql, blobs, 'listener', {
      total: 10, cursor: 0, reTagged: true, state: 'paused', pinFirstSec: pin,
    });
    const token = await issueSession('listener', SIGNING, NOW);
    const body: any = await (await handleRequest(env,
      req(`/scrobblify/job/${id}/export`, { method: 'POST', token, body: JSON.stringify({ claim: EXPORT_CLAIM }) }))).json();

    check('the pinned track is still flagged re-tagged despite its real second',
      body.state.tracks[0].reTagged === true, body.state.tracks[0]);
    check('and the pinned second itself comes back, not a placeholder',
      body.state.tracks[0].timestamp === pin * 1000, body.state.tracks[0]);
    check('every other re-tagged track is still flagged',
      body.state.tracks.slice(1).every((t: any) => t.reTagged === true));
    check('the pin is called out explicitly, since a timestamp alone cannot say so',
      body.state.tracks[0].pendingRetry === true, body.state.tracks[0]);
    check('and no other track claims to be one',
      body.state.tracks.slice(1).every((t: any) => t.pendingRetry === undefined));
  }

  console.log('\n-- the export claims quiescence rather than observing it --');
  {
    /*
      Checking quiescence and then reading was a time-of-check/time-of-use
      hole: a second tab pressing "resume on the server" in between makes the
      job active, a tick sends a batch, and the export the first tab saved
      still lists those tracks as pending. It cancels, the browser resumes
      them, and they are scrobbled twice.
    */
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const token = await issueSession('listener', SIGNING, NOW);
    const exportReq = (jobId: string, claim: string) => req(`/scrobblify/job/${jobId}/export`, {
      method: 'POST', token, body: JSON.stringify({ claim }),
    });

    const active = await seedJob(sql, blobs, 'listener', { total: 100, state: 'active' });
    const activeRes = await handleRequest(env, exportReq(active, EXPORT_CLAIM));
    check('an active job cannot be exported', activeRes.status === 409, activeRes.status);
    check('and it is left active',
      (await sql.first<JobRow>('SELECT * FROM jobs WHERE id = ?', [active]))!.state === 'active');

    const sql2 = freshSql();
    const blobs2 = new MemoryBlobs();
    const env2 = makeEnv(sql2, blobs2);
    const id = await seedJob(sql2, blobs2, 'listener', { total: 100, state: 'paused' });

    const unclaimed = await handleRequest(env2, req(`/scrobblify/job/${id}/export`, {
      method: 'POST', token, body: JSON.stringify({}),
    }));
    check('an export without a claim is refused', unclaimed.status === 400, unclaimed.status);

    const first = await handleRequest(env2, exportReq(id, EXPORT_CLAIM));
    check('a paused job exports', first.status === 200, first.status);
    const claimed = await sql2.first<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]);
    check('and is claimed into exporting', claimed!.state === 'exporting', claimed!.state);
    check('with a claim deadline that expires',
      claimed!.locked_until > NOW, claimed!.locked_until);
    check('recording where to go back to', claimed!.export_prev_state === 'paused',
      claimed!.export_prev_state);

    // The client retries this endpoint on a 409, and a retry is the same
    // take-back continuing — refusing it would strand the user.
    const second = await handleRequest(env2, exportReq(id, EXPORT_CLAIM));
    check('re-exporting with the same claim is allowed', second.status === 200, second.status);

    /*
      A second tab must not read concurrently. It could otherwise save and
      cancel — deleting the blobs — while the first was still reading chunks,
      and the first would return a silently partial queue that overwrites the
      complete local save.
    */
    const other = await handleRequest(env2, exportReq(id, `${EXPORT_CLAIM}-other`));
    check('but another claim cannot barge in', other.status === 409, other.status);

    const resumed = await handleRequest(env2,
      req(`/scrobblify/job/${id}/resume`, { method: 'POST', token }));
    check('and it cannot be resumed out from under the export',
      resumed.status === 409, resumed.status);

    // Cancel is the take-back *completing*, so it must still work — but only
    // for the claimant, since cancelling deletes the blobs the export reads.
    const cancelled = await handleRequest(env2, req(`/scrobblify/job/${id}/cancel`,
      { method: 'POST', token, body: JSON.stringify({ claim: EXPORT_CLAIM }) }));
    check('cancel still works from exporting', cancelled.status === 200, cancelled.status);
  }

  console.log('\n-- an abandoned export claim reverts to where it came from --');
  {
    /*
      `exporting` is neither schedulable nor resumable, so a client that closed
      its tab midway would park the job permanently. Reverting to `paused`
      unconditionally would instead clear a `needs_attention` the user still
      has to act on, turning a job waiting for them into one that looks idle.
    */
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const token = await issueSession('listener', SIGNING, NOW);
    const id = await seedJob(sql, blobs, 'listener', { total: 100, state: 'needs_attention' });
    await handleRequest(env, req(`/scrobblify/job/${id}/export`, {
      method: 'POST', token, body: JSON.stringify({ claim: EXPORT_CLAIM }),
    }));
    const held = await sql.first<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]);
    check('claimed from needs_attention', held!.state === 'exporting', held!.state);
    check('remembering where to return it to',
      held!.export_prev_state === 'needs_attention', held!.export_prev_state);
  }

  console.log('\n-- the export reports every second it used --');
  {
    /*
      `synthetic_floor` describes only the current descending band. Preserved
      original timestamps are not in it, and neither is a band abandoned by a
      wrap. The browser's re-tag allocator reserves below everything it is
      told about, so anything omitted here is a second it may reuse — and
      Last.fm discards a repeat of (artist, track, timestamp) while reporting
      it accepted.
    */
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const id = await seedJob(sql, blobs, 'listener', { total: 100, cursor: 40, state: 'paused' });
    /*
      Seeded through `assignTimestamps` rather than by hand. An earlier version
      of this test inserted bare number arrays, which is not the shape the
      scheduler writes — it stores serialised `AssignedTrack` objects. The
      export's parser was reading numbers, matched nothing, and returned an
      empty `usedRanges`; the test passed anyway, because the fixture was the
      only place that shape existed. Anything that asserts on this column has
      to be built the way production builds it.
    */
    const forSend = (starts: number[]) => starts.map((ts, i) => ({
      artist: 'A', track: `T${ts}`, index: i, originalTimestampSec: ts,
    }));
    const first = assignTimestamps(forSend([1000, 1001, 1002]), NOW, 0);
    const second = assignTimestamps(forSend([5000, 1003]), NOW, 0);
    await sql.run(
      `INSERT INTO batches (id, job_id, generation, start_index, entry_count, state,
          assigned_timestamps, created_at)
       VALUES (?, ?, 0, 0, 3, 'settled', ?, ?)`,
      [randomId(), id, JSON.stringify(first.assigned), NOW],
    );
    await sql.run(
      `INSERT INTO batches (id, job_id, generation, start_index, entry_count, state,
          assigned_timestamps, created_at)
       VALUES (?, ?, 0, 3, 2, 'settled', ?, ?)`,
      [randomId(), id, JSON.stringify(second.assigned), NOW],
    );
    const token = await issueSession('listener', SIGNING, NOW);
    const body: any = await (await handleRequest(env,
      req(`/scrobblify/job/${id}/export`, { method: 'POST', token, body: JSON.stringify({ claim: EXPORT_CLAIM }) }))).json();

    const expected = [...first.assigned, ...second.assigned]
      .map((a) => a.timestampSec)
      .sort((a, b) => a - b);
    const covered = (ts: number) => body.usedRanges
      .some((r: any) => ts >= r.from && ts <= r.to);
    check('every second the worker actually assigned is reported',
      expected.every(covered), { expected, got: body.usedRanges });
    check('and something was reported at all — an empty list is the H5 bug',
      Array.isArray(body.usedRanges) && body.usedRanges.length > 0, body.usedRanges);
    check('contiguous seconds collapse into one range',
      body.usedRanges.length < expected.length, body.usedRanges);
    check('ranges are well formed and ascending',
      body.usedRanges.every((r: any, i: number) => r.from <= r.to
        && (i === 0 || r.from > body.usedRanges[i - 1].to)), body.usedRanges);
    check('a complete list is not reported as truncated',
      body.usedRangesTruncated === false, body.usedRangesTruncated);
    check('a complete list is not reported as incomplete',
      body.usedRangesIncomplete === false, body.usedRangesIncomplete);
    check('a complete list needs no floor',
      body.usedRangesFloorSec === 0, body.usedRangesFloorSec);
  }

  console.log('\n-- truncation drops the oldest ranges, not the newest --');
  {
    /*
      The client searches for a free gap walking *down* from the present, so
      the ranges it collides with first are the highest. Truncating from the
      top removed exactly the entries that constrain it — the same
      direction-of-retention bug that `sanitizeRanges` had on the client.

      Keeping the top instead also makes truncation survivable: everything
      dropped lies below the lowest surviving range, so the region above it is
      completely described and the client can bound its search there rather
      than abandoning the reservation.
    */
    const spaced: number[] = [];
    for (let i = 0; i < 40; i += 1) {
      // Deliberately non-adjacent so every second becomes its own range.
      spaced.push(1_700_000_000 + i * 10);
    }
    const collapsed = collapseToRanges(spaced, 8);
    check('reports truncation', collapsed.truncated === true);
    check('keeps exactly the limit', collapsed.ranges.length === 8, collapsed.ranges.length);
    check('keeps the highest ranges',
      collapsed.ranges[collapsed.ranges.length - 1].to === 1_700_000_000 + 39 * 10,
      collapsed.ranges);
    check('drops the lowest ranges',
      collapsed.ranges[0].from === 1_700_000_000 + 32 * 10, collapsed.ranges);
    check('everything dropped lies below everything kept',
      spaced.filter((s) => s < collapsed.ranges[0].from).length === 32);

    const whole = collapseToRanges(spaced, 100);
    check('an untruncated list is returned in full', whole.ranges.length === 40);
    check('and is not flagged', whole.truncated === false);
    check('an empty list is not truncation', collapseToRanges([], 8).truncated === false);
  }

  console.log('\n-- cancelling during an export needs that export\'s claim --');
  {
    /*
      Cancel deletes the blobs and the export reads them, so a second
      authorised caller cancelling mid-read would destroy the queue at the one
      moment it exists nowhere else. The session is a bearer token, so "the UI
      would not do that" is not an argument.
    */
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const id = await seedJob(sql, blobs, 'listener', { total: 100, cursor: 0, state: 'paused' });
    const token = await issueSession('listener', SIGNING, NOW);

    await handleRequest(env, req(`/scrobblify/job/${id}/export`,
      { method: 'POST', token, body: JSON.stringify({ claim: EXPORT_CLAIM }) }));
    check('the export left the job claimed',
      (await sql.first<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]))!.state === 'exporting');

    const noClaim = await handleRequest(env,
      req(`/scrobblify/job/${id}/cancel`, { method: 'POST', token }));
    check('a cancel with no claim is refused', noClaim.status === 409, noClaim.status);

    const wrongClaim = await handleRequest(env, req(`/scrobblify/job/${id}/cancel`,
      { method: 'POST', token, body: JSON.stringify({ claim: 'some-other-claim-token' }) }));
    check('a cancel with a foreign claim is refused',
      wrongClaim.status === 409, wrongClaim.status);
    check('and the job is still exporting, not cancelled',
      (await sql.first<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]))!.state === 'exporting');

    const ok = await handleRequest(env, req(`/scrobblify/job/${id}/cancel`,
      { method: 'POST', token, body: JSON.stringify({ claim: EXPORT_CLAIM }) }));
    check('the claimant may cancel', ok.status === 200, ok.status);
    check('and the job is cancelled', (await sql.first<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]))!.state === 'cancelled');
  }

  console.log('\n-- a cancel that read a stale state cannot delete a live export --');
  {
    /*
      The handler loads the job once, at the top, and every action below works
      from that snapshot. A cancel can therefore read `paused`, be descheduled
      while another request claims the export, and resume holding a view of the
      row that is no longer true — sailing past a guard written as an `if` and
      deleting the blobs the live export is still reading.

      Reproduced by mutating the row *between* the handler's read and its
      write, which is exactly what the real interleaving does. The claim
      condition lives in the UPDATE, so the database rejects it on the row as
      it actually is rather than as the handler last saw it.
    */
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const id = await seedJob(sql, blobs, 'listener', { total: 100, cursor: 0, state: 'paused' });
    const token = await issueSession('listener', SIGNING, NOW);

    let armed = true;
    const racingSql: Sql = {
      all: (q, p) => sql.all(q, p),
      run: (q, p) => sql.run(q, p),
      batch: (s) => sql.batch(s),
      async first<T>(q: string, p?: unknown[]): Promise<T | null> {
        const row = await sql.first<T>(q, p);
        // The handler's own dispatch read is the one that must go stale.
        if (armed && q.includes('SELECT * FROM jobs WHERE id = ?')) {
          armed = false;
          await sql.run(
            "UPDATE jobs SET state = 'exporting', export_claim = ? WHERE id = ?",
            ['a-live-export-claim', id],
          );
        }
        return row;
      },
    };
    const env = makeEnv(racingSql, blobs);

    const blobsBefore = blobs.data.size;
    check('the job has blobs to lose', blobsBefore > 0, blobsBefore);

    const raced = await handleRequest(env, req(`/scrobblify/job/${id}/cancel`,
      { method: 'POST', token, body: JSON.stringify({ claim: EXPORT_CLAIM }) }));
    check('the racing cancel is refused', raced.status === 409, raced.status);
    check('the job is left exporting',
      (await sql.first<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]))!.state === 'exporting');
    check('and the export still has its blobs to read',
      blobs.data.size === blobsBefore, { before: blobsBefore, after: blobs.data.size });
  }

  console.log('\n-- a cancel whose claim has lapsed is refused, not honoured --');
  {
    /*
      The claim is what makes an exported snapshot true. It expires, and the
      sweep then reverts the row to `paused` — at which point the job can be
      resumed and can send tracks the snapshot still lists as remaining. A
      cancel accepted after that reports success for a queue that has moved on,
      and the client goes on to send its stale copy: everything the worker got
      through in the meantime is scrobbled a second time.

      The old condition only checked the claim while the row still said
      `exporting`, so a lapse turned the guard off exactly when it was needed.
    */
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const id = await seedJob(sql, blobs, 'listener', { total: 100, cursor: 0, state: 'paused' });
    const token = await issueSession('listener', SIGNING, NOW);
    const blobsBefore = blobs.data.size;

    const stale = await handleRequest(env, req(`/scrobblify/job/${id}/cancel`,
      { method: 'POST', token, body: JSON.stringify({ claim: EXPORT_CLAIM }) }));
    check('a claim the job does not hold cannot cancel it',
      stale.status === 409, stale.status);
    check('the job is still resumable',
      (await sql.first<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]))!.state === 'paused');
    check('and its queue is intact for the retry',
      blobs.data.size === blobsBefore, { before: blobsBefore, after: blobs.data.size });

    // The same claim, once the job really is exporting under it, still works.
    await sql.run("UPDATE jobs SET state = 'exporting', export_claim = ? WHERE id = ?",
      [EXPORT_CLAIM, id]);
    const good = await handleRequest(env, req(`/scrobblify/job/${id}/cancel`,
      { method: 'POST', token, body: JSON.stringify({ claim: EXPORT_CLAIM }) }));
    check('the holder of a live claim can still cancel', good.status === 200, good.status);
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

  console.log('\n-- signing in gives a re-auth job its credential back --');
  {
    /*
      `needs_reauth` clears `live_username` and the stored key, so the job
      cannot send and is not resumable. Nothing else in the system can supply a
      new key — the sign-in flow deliberately discarded the one it proves — so
      the status card's "reconnect Last.fm" promised a recovery that did not
      exist. The user's only exits were take-back, which abandons any batch
      still in flight and risks duplicating it, or cancel, which discards the
      queue.
    */
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs, {
      getSession: async () => ({ sessionKey: 'fresh-session-key', username: 'listener' }),
    });
    const jobId = await seedJob(sql, blobs, 'listener', { state: 'needs_reauth', live: false });
    await sql.run(
      'UPDATE jobs SET session_key_ct = NULL, session_key_iv = NULL WHERE id = ?', [jobId],
    );
    const state = await signHandoffState(
      {
        h: '', exp: NOW + 600, k: 'signin', u: 'listener', n: 'nonce-that-is-long-enough',
      },
      SIGNING,
    );
    const res = await handleRequest(
      env, req(`/scrobblify/auth/callback?state=${encodeURIComponent(state)}&token=tok`),
    );
    check('the sign-in still succeeds', res.status === 302, res.status);
    const job = await sql.first<any>('SELECT * FROM jobs WHERE id = ?', [jobId]);
    check('the job can send again', job.state === 'paused', job.state);
    check('it has a credential', !!job.session_key_ct, job.session_key_ct);
    check('and it holds the account slot', job.live_username === 'listener', job.live_username);
    const logged = await sql.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM audit WHERE job_id = ? AND event = 'credential_reattached'",
      [jobId],
    );
    check('and it is recorded', logged!.n === 1, logged!.n);
  }

  console.log('\n-- but never over a job that already holds the slot --');
  {
    /*
      `live_username` carries a unique index. A job started since this one was
      parked already owns the account, and giving the parked one a live
      credential too would mean two jobs sending the same user's history at
      once — every track in the overlap duplicated.
    */
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs, {
      getSession: async () => ({ sessionKey: 'fresh-session-key', username: 'listener' }),
    });
    const parked = await seedJob(sql, blobs, 'listener', { state: 'needs_reauth', live: false });
    await sql.run(
      'UPDATE jobs SET session_key_ct = NULL, session_key_iv = NULL WHERE id = ?', [parked],
    );
    await seedJob(sql, blobs, 'listener', { live: true });
    const state = await signHandoffState(
      {
        h: '', exp: NOW + 600, k: 'signin', u: 'listener', n: 'nonce-that-is-long-enough',
      },
      SIGNING,
    );
    const res = await handleRequest(
      env, req(`/scrobblify/auth/callback?state=${encodeURIComponent(state)}&token=tok`),
    );
    check('the sign-in still succeeds', res.status === 302, res.status);
    const job = await sql.first<any>('SELECT * FROM jobs WHERE id = ?', [parked]);
    check('the parked job is left parked', job.state === 'needs_reauth', job.state);
    check('and is given no credential', job.session_key_ct === null, job.session_key_ct);
  }

  console.log('\n-- a re-attached credential gets a fresh lifetime too --');
  {
    /*
      The commonest way into `needs_reauth` is the 60-day deadline passing. A
      fresh key under the *expired* deadline is re-parked by the very next
      tick, so the user reconnects, resumes, is parked again, and no track is
      ever sent — a loop with no exit but cancelling. The key really is new,
      so its clock really does start again.
    */
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs, {
      getSession: async () => ({ sessionKey: 'fresh-session-key', username: 'listener' }),
    });
    const jobId = await seedJob(sql, blobs, 'listener', { state: 'needs_reauth', live: false });
    await sql.run(
      `UPDATE jobs SET session_key_ct = NULL, session_key_iv = NULL,
         credential_expires_at = ? WHERE id = ?`,
      [NOW - 3600, jobId],
    );
    const state = await signHandoffState(
      {
        h: '', exp: NOW + 600, k: 'signin', u: 'listener', n: 'nonce-that-is-long-enough',
      },
      SIGNING,
    );
    await handleRequest(
      env, req(`/scrobblify/auth/callback?state=${encodeURIComponent(state)}&token=tok`),
    );
    const job = await sql.first<any>('SELECT * FROM jobs WHERE id = ?', [jobId]);
    check('the expired deadline is not inherited',
      job.credential_expires_at > NOW, job.credential_expires_at);
    check('and the next tick would not re-park it',
      job.state === 'paused' && job.credential_expires_at > NOW, job);
  }

  const signInAs = async (env: ApiEnv, username: string) => {
    const state = await signHandoffState(
      {
        h: '', exp: NOW + 600, k: 'signin', u: username, n: 'nonce-that-is-long-enough',
      },
      SIGNING,
    );
    return handleRequest(
      env, req(`/scrobblify/auth/callback?state=${encodeURIComponent(state)}&token=tok`),
    );
  };
  const seedDormant = async (sql: Sql, blobs: BlobStore, username: string) => {
    const id = await seedJob(sql, blobs, username, { state: 'dormant', live: false });
    await sql.run(
      'UPDATE jobs SET session_key_ct = NULL, session_key_iv = NULL WHERE id = ?', [id],
    );
    return id;
  };

  console.log('\n-- signing in brings a dormant job back while there is room --');
  {
    /*
      Housekeeping deletes the key of a job left parked for two weeks and gives
      its slot to someone else. The tracks are kept precisely so a user who
      comes back can carry on, and reconnecting is how they say so.
    */
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs, {
      getSession: async () => ({ sessionKey: 'fresh-session-key', username: 'listener' }),
    });
    const jobId = await seedDormant(sql, blobs, 'listener');
    const res = await signInAs(env, 'listener');
    check('the sign-in succeeds', res.status === 302, res.status);
    const job = await sql.first<any>('SELECT * FROM jobs WHERE id = ?', [jobId]);
    check('the job is paused, ready to resume', job.state === 'paused', job.state);
    check('with a credential', !!job.session_key_ct);
    check('holding the account slot', job.live_username === 'listener', job.live_username);
    check('its inactivity clock restarted', job.inactivity_deadline > NOW, job.inactivity_deadline);
    const logged = await sql.first<{ detail: string }>(
      "SELECT detail FROM audit WHERE job_id = ? AND event = 'credential_reattached'",
      [jobId],
    );
    check('recorded as coming back from dormant',
      JSON.parse(logged?.detail ?? '{}').from === 'dormant', logged);
  }

  console.log('\n-- but not into a slot that is not there --');
  {
    /*
      A dormant job gave its slot up. Taking one back past capacity would
      overcommit the worker for every other user, so it waits. A job in
      `needs_reauth` never gave its slot up and is not held to this.
    */
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs, {
      getSession: async () => ({ sessionKey: 'fresh-session-key', username: 'listener' }),
    });
    await sql.run('UPDATE control SET max_concurrent_jobs = 1 WHERE id = 1');
    await seedJob(sql, blobs, 'someone-else');
    const dormant = await seedDormant(sql, blobs, 'listener');

    const status: any = await (await handleRequest(env, req('/scrobblify/job', {
      token: await issueSession('listener', SIGNING, NOW),
    }))).json();
    check('the status says reconnecting will not help yet',
      status.job?.state === 'dormant' && status.job.reconnectAvailable === false, status);

    const res = await signInAs(env, 'listener');
    check('the sign-in still succeeds', res.status === 302, res.status);
    const job = await sql.first<any>('SELECT * FROM jobs WHERE id = ?', [dormant]);
    check('the job stays dormant', job.state === 'dormant', job.state);
    check('with no credential', job.session_key_ct === null);

    const sql2 = freshSql();
    const blobs2 = new MemoryBlobs();
    const env2 = makeEnv(sql2, blobs2, {
      getSession: async () => ({ sessionKey: 'fresh-session-key', username: 'listener' }),
    });
    await sql2.run('UPDATE control SET max_concurrent_jobs = 1 WHERE id = 1');
    const reauth = await seedJob(sql2, blobs2, 'listener', { state: 'needs_reauth', live: false });
    await signInAs(env2, 'listener');
    const kept = await sql2.first<any>('SELECT state FROM jobs WHERE id = ?', [reauth]);
    check('a re-auth job at full capacity is still restored: it held its slot',
      kept.state === 'paused', kept.state);
  }

  console.log('\n-- a job waiting on the user is reported even without a live slot --');
  {
    /*
      `needs_reauth` and `dormant` both clear `live_username`, so looking the
      job up by it found nothing and the user was shown their last finished
      job, or none, instead of the one holding their tracks.
    */
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const token = await issueSession('listener', SIGNING, NOW);
    const done = await seedJob(sql, blobs, 'listener', { state: 'completed', live: false });
    await sql.run('UPDATE jobs SET updated_at = ? WHERE id = ?', [NOW + 10, done]);
    const dormant = await seedDormant(sql, blobs, 'listener');
    await sql.run('UPDATE jobs SET inactivity_deadline = ? WHERE id = ?', [NOW + 30 * 86400, dormant]);

    const body: any = await (await handleRequest(env, req('/scrobblify/job', { token }))).json();
    check('the dormant job is reported over a newer finished one',
      body.job?.id === dormant, body.job);
    check('with the date it will be cancelled',
      body.job?.inactivityDeadline === NOW + 30 * 86400, body.job);
    check('and that reconnecting would bring it back', body.job?.reconnectAvailable === true, body.job);

    await sql.run("UPDATE jobs SET state = 'needs_reauth' WHERE id = ?", [dormant]);
    const reauth: any = await (await handleRequest(env, req('/scrobblify/job', { token }))).json();
    check('a re-auth job is reported too', reauth.job?.state === 'needs_reauth', reauth.job);
  }

  console.log('\n-- a dormant job can still be taken back --');
  {
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const token = await issueSession('listener', SIGNING, NOW);
    const id = await seedDormant(sql, blobs, 'listener');
    const res = await handleRequest(env, req(`/scrobblify/job/${id}/export`, {
      method: 'POST', token, body: JSON.stringify({ claim: EXPORT_CLAIM }),
    }));
    const body: any = await res.json();
    check('the export succeeds without a credential', res.status === 200, body);
    check('with every track', body.state?.tracks?.length === 100, body.state?.tracks?.length);
    const held = await sql.first<JobRow>('SELECT * FROM jobs WHERE id = ?', [id]);
    check('remembering to go back to dormant if abandoned',
      held!.export_prev_state === 'dormant', held!.export_prev_state);
  }

  console.log('\n-- an unconfirmed send comes back pinned to the second it rode on --');
  {
    /*
      A batch row is written before the POST, so an abandoned batch may already
      be on the account. Handing those tracks back as ordinary re-tags lets the
      browser mint *new* seconds for them, and Last.fm deduplicates on the whole
      (artist, track, timestamp) tuple — a new second is a new play. Repeating
      the identical second makes the re-send a no-op if it landed and a normal
      scrobble if it did not.
    */
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const id = await seedJob(sql, blobs, 'listener', {
      total: 10, cursor: 4, state: 'paused', reTagged: true,
    });
    /*
      Seeded at a non-zero offset and rebased the way `runJob` rebases.
      `assignTimestamps` mints *batch-relative* indices and the scheduler maps
      them onto the blob before the row is written; a fixture that starts at
      zero cannot tell the two apart, and would pass just as happily against a
      version that pinned every second to the wrong track.
    */
    const startIndex = 4;
    const forSend = [0, 1, 2].map((i) => ({
      artist: `Artist ${startIndex + i}`,
      track: `Track ${startIndex + i}`,
      index: i,
      originalTimestampSec: 0,
    }));
    const minted = assignTimestamps(forSend, NOW, 0);
    const lostAssigned = minted.assigned.map((a: any) => ({
      ...a, index: startIndex + a.index,
    }));
    await sql.run(
      `INSERT INTO batches (id, job_id, generation, start_index, entry_count, state,
          assigned_timestamps, created_at)
       VALUES (?, ?, 0, ?, 3, 'abandoned', ?, ?)`,
      [randomId(), id, startIndex, JSON.stringify(lostAssigned), NOW],
    );
    const token = await issueSession('listener', SIGNING, NOW);
    const body: any = await (await handleRequest(env,
      req(`/scrobblify/job/${id}/export`, { method: 'POST', token, body: JSON.stringify({ claim: EXPORT_CLAIM }) }))).json();
    const bySec = new Map(lostAssigned.map((a: any) => [a.index, a.timestampSec]));
    const head = body.state.tracks.slice(0, 3);
    check('each unconfirmed track carries the exact second it was sent with',
      head.every((t: any, i: number) => t.timestamp === (bySec.get(startIndex + i) as number) * 1000),
      head.map((t: any) => t.timestamp));
    check('and they are the tracks the batch actually named',
      head.every((t: any, i: number) => t.artist === `Artist ${startIndex + i}`),
      head.map((t: any) => t.artist));
    check('and is not offered for re-tagging, which is what would mint a new one',
      head.every((t: any) => t.reTagged === false), head);
    check('a track behind them is still an ordinary re-tag',
      body.state.tracks[3].reTagged === true, body.state.tracks[3]);
    check('so nothing needs to be confessed to the user',
      body.uncertainCount === 0, body.uncertainCount);
    /*
      Named by position so the client can settle them against Last.fm while
      the user is still here. A pin only stays harmless while the second is
      inside the acceptance window, and this queue may not reach these tracks
      for days.
    */
    check('and each one is named in `repeats`',
      Array.isArray(body.repeats) && body.repeats.length === 3,
      body.repeats);
    check('by position in the returned queue, with the second it holds',
      body.repeats.every((r: any, i: number) => r.i === i
        && r.sec === bySec.get(startIndex + i)),
      body.repeats);
  }

  console.log('\n-- a second whose track does not match is not pinned to it --');
  {
    /*
      The map is keyed by an index rebased from batch-relative to absolute
      before it is stored. If that rebase ever regresses, every second lands on
      the wrong track — plays the user never had, under times that look
      deliberate, which is worse than the duplicate this exists to prevent. The
      batch row carries the names it sent, so the alignment is checkable.
    */
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const id = await seedJob(sql, blobs, 'listener', {
      total: 10, cursor: 0, state: 'paused', reTagged: true,
    });
    const forSend = [0, 1].map((i) => ({
      artist: 'Someone Else', track: `Not Track ${i}`, index: i, originalTimestampSec: 0,
    }));
    const misaligned = assignTimestamps(forSend, NOW, 0);
    await sql.run(
      `INSERT INTO batches (id, job_id, generation, start_index, entry_count, state,
          assigned_timestamps, created_at)
       VALUES (?, ?, 0, 0, 2, 'abandoned', ?, ?)`,
      [randomId(), id, JSON.stringify(misaligned.assigned), NOW],
    );
    const token = await issueSession('listener', SIGNING, NOW);
    const body: any = await (await handleRequest(env,
      req(`/scrobblify/job/${id}/export`, { method: 'POST', token, body: JSON.stringify({ claim: EXPORT_CLAIM }) }))).json();
    check('a second belonging to another track is refused',
      body.state.tracks.slice(0, 2).every((t: any) => t.reTagged === true),
      body.state.tracks.slice(0, 2));
    check('and the fallback is confessed rather than hidden',
      body.uncertainCount === 2, body.uncertainCount);
  }

  console.log('\n-- unless its second is too old for Last.fm to still take --');
  {
    /*
      Once the second ages out, a repeat cannot be stored at all — pinning a
      play that never landed to it would be the one unrecoverable outcome. Those
      fall back to a fresh second, which may duplicate, and the user is told how
      many. The age is judged against the worker's clock, which is the only one
      here that can be trusted to say how old anything is.
    */
    const sql = freshSql();
    const blobs = new MemoryBlobs();
    const env = makeEnv(sql, blobs);
    const id = await seedJob(sql, blobs, 'listener', {
      total: 10, cursor: 0, state: 'paused', reTagged: true,
    });
    const forSend = [0, 1].map((i) => ({
      artist: `Artist ${i}`, track: `Track ${i}`, index: i, originalTimestampSec: 0,
    }));
    const stale = assignTimestamps(forSend, NOW - 20 * 86400, 0);
    await sql.run(
      `INSERT INTO batches (id, job_id, generation, start_index, entry_count, state,
          assigned_timestamps, created_at)
       VALUES (?, ?, 0, 0, 2, 'abandoned', ?, ?)`,
      [randomId(), id, JSON.stringify(stale.assigned), NOW - 20 * 86400],
    );
    const token = await issueSession('listener', SIGNING, NOW);
    const body: any = await (await handleRequest(env,
      req(`/scrobblify/job/${id}/export`, { method: 'POST', token, body: JSON.stringify({ claim: EXPORT_CLAIM }) }))).json();
    check('an unrepeatable second is not pinned',
      body.state.tracks.slice(0, 2).every((t: any) => t.reTagged === true),
      body.state.tracks.slice(0, 2));
    check('and the user is told how many may show up twice',
      body.uncertainCount === 2, body.uncertainCount);
    check('and nothing is offered for settling that has no second to settle',
      Array.isArray(body.repeats) && body.repeats.length === 0, body.repeats);
  }

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
