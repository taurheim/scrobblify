/**
 * A take-back reads the whole queue out of D1 in one invocation, and Workers
 * Free allows 50 queries per invocation (a batch counts each statement). The
 * export used to spend two per remaining chunk, so past ~21 chunks (~21,000
 * tracks) it failed every time (#158). Node's SQLite never refuses a query, so
 * this counts them the way D1 would.
 */
import { DatabaseSync } from 'node:sqlite';
import { schemaSql, blobSchemaSql } from './schema';
import { Sql, SqlResult } from '../src/store';
import { gzip, uploadChunk } from '../src/chunks';
import { SqlBlobs } from '../src/blobs';
import { encryptCredential, sha256Hex, randomId } from '../src/crypto';
import { issueSession } from '../src/session';
import { ALGORITHM_VERSION } from '../src/handoff';
import { handleRequest, ApiEnv } from '../src/api';

const NOW = 1_800_000_000;
const SIGNING = 'signing-key-for-tests-0123456789';
const CRED = 'credential-secret-for-tests-01234';
const CLAIM = 'export-claim-token-for-tests';
const PER_CHUNK = 5;
const CHUNKS = 120;

class CountingSql implements Sql {
  public statements = 0;

  constructor(private db: DatabaseSync) {}

  private count(params: unknown[]) {
    if (params.length > 100) {
      throw new Error(`too many SQL variables: ${params.length}`);
    }
    this.statements += 1;
  }

  async all<T>(q: string, p: unknown[] = []): Promise<T[]> {
    this.count(p);
    return this.db.prepare(q).all(...(p as any[])) as T[];
  }

  async first<T>(q: string, p: unknown[] = []): Promise<T | null> {
    this.count(p);
    return (this.db.prepare(q).get(...(p as any[])) ?? null) as T | null;
  }

  async run(q: string, p: unknown[] = []): Promise<SqlResult> {
    this.count(p);
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

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

async function main() {
  console.log('\n-- exporting a large job stays inside the Free plan\'s 50 queries --');
  const mainDb = new DatabaseSync(':memory:');
  mainDb.exec(schemaSql());
  const blobDb = new DatabaseSync(':memory:');
  blobDb.exec(blobSchemaSql());
  const sql = new CountingSql(mainDb);
  const blobSql = new CountingSql(blobDb);
  const blobs = new SqlBlobs(blobSql);

  const total = CHUNKS * PER_CHUNK;
  const cursor = 7;
  const id = randomId();
  const cred = await encryptCredential('sk', CRED, id);
  await sql.run(
    `INSERT INTO jobs (id, username, live_username, state, algorithm_version, total_tracks,
        cursor, scrobbled_count, session_key_ct, session_key_iv,
        created_at, updated_at, credential_expires_at)
     VALUES (?, 'listener', 'listener', 'paused', ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    [id, ALGORITHM_VERSION, total, cursor, cred.ciphertext, cred.iv, NOW, NOW, NOW + 86400],
  );
  for (let c = 0; c < CHUNKS; c += 1) {
    const lines: string[] = [];
    for (let i = 0; i < PER_CHUNK; i += 1) {
      const n = c * PER_CHUNK + i;
      lines.push(JSON.stringify({
        artist: `Artist ${n}`, track: `Track ${n}`, album: 'Album', originalTimestampSec: 1_700_000_000 + n,
      }));
    }
    // eslint-disable-next-line no-await-in-loop
    const gz = await gzip(new TextEncoder().encode(lines.join('\n')));
    const buf = gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) as ArrayBuffer;
    // eslint-disable-next-line no-await-in-loop
    const up = await uploadChunk(sql, blobs, {
      jobId: id,
      chunkIndex: c,
      startIndex: c * PER_CHUNK,
      // eslint-disable-next-line no-await-in-loop
      digest: await sha256Hex(gz),
      entryCount: PER_CHUNK,
      compressed: buf,
    }, NOW);
    if (!up.ok) { throw new Error(`seed failed: ${up.reason}`); }
  }
  await sql.run(
    `INSERT INTO failures (job_id, track_index, artist, track, album, reason, ignore_code, created_at)
     VALUES (?, 55, 'Artist 55', 'Track 55', 'Album', 'Artist ignored', 1, ?)`,
    [id, NOW],
  );

  const env: ApiEnv = {
    sql,
    blobs,
    lastfm: {} as any,
    signingKey: SIGNING,
    credentialSecret: CRED,
    callbackUrl: 'https://api.savas.ca/scrobblify/auth/callback',
    appUrl: 'https://savas.ca/scrobblify/scrobble',
    lastfmApiKey: 'worker-api-key',
    now: () => NOW,
  };
  const token = await issueSession('listener', SIGNING, NOW);
  sql.statements = 0;
  blobSql.statements = 0;
  const res = await handleRequest(env, new Request(`https://api.savas.ca/scrobblify/job/${id}/export`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ claim: CLAIM }),
  }));
  const used = sql.statements + blobSql.statements;
  const body: any = await res.json();

  check('the export succeeds', res.status === 200, res.status);
  check('it returns everything after the cursor, minus the failed track',
    body.state.tracks.length === total - cursor - 1, body.state?.tracks?.length);
  check('starting at the cursor', body.state.tracks[0].track === `Track ${cursor}`);
  check('in order, with the failed one left out',
    body.state.tracks[47].track === 'Track 54' && body.state.tracks[48].track === 'Track 56');
  check(`${CHUNKS} chunks take at most 30 queries (used ${used})`, used <= 30, used);

  console.log('\n-- a missing blob still refuses the export --');
  await blobSql.run('DELETE FROM blobs WHERE key = ?', [`jobs/${id}/chunks/60`]);
  const broken = await handleRequest(env, new Request(`https://api.savas.ca/scrobblify/job/${id}/export`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ claim: CLAIM }),
  }));
  check('503 rather than a partial queue', broken.status === 503, broken.status);

  if (failures > 0) {
    console.log(`\n${failures} failed`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
