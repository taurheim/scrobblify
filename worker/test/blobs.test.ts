/**
 * Blob storage tests: the D1-backed store, and the limits that keep it inside
 * D1's free tier.
 *
 * The limits are the point. R2 was replaced because it bills with no cap; D1
 * refuses instead. That only becomes a guarantee if a full blob database
 * degrades into "uploads refused" rather than into crashes, and if finished
 * jobs actually give their space back.
 */
import { DatabaseSync } from 'node:sqlite';
import { schemaSql, blobSchemaSql } from './schema';
import { Sql, SqlResult } from '../src/store';
import { SqlBlobs, MAX_KEYS_PER_DELETE } from '../src/blobs';
import {
  gzip,
  uploadChunk,
  readChunkFor,
  sweepTerminalJobBlobs,
  MAX_COMPRESSED_BYTES,
  MAX_JOB_COMPRESSED_BYTES,
} from '../src/chunks';
import { sha256Hex } from '../src/crypto';

const NOW = 1_800_000_000;

/**
 * node:sqlite behind the `Sql` interface, with D1's 100-parameter limit
 * imposed. SQLite itself allows 32,766, so without this a delete that would be
 * refused in production passes here.
 */
class D1LikeSql implements Sql {
  public statements = 0;

  public failWrites = false;

  constructor(private db: DatabaseSync) {}

  private check(query: string, params: unknown[]) {
    if (params.length > 100) {
      throw new Error(`too many SQL variables: ${params.length}`);
    }
    if (this.failWrites && /^\s*INSERT/i.test(query)) {
      throw new Error('D1_ERROR: database full');
    }
  }

  async all<T>(query: string, params: unknown[] = []): Promise<T[]> {
    this.check(query, params);
    return this.db.prepare(query).all(...(params as any[])) as T[];
  }

  async first<T>(query: string, params: unknown[] = []): Promise<T | null> {
    this.check(query, params);
    return (this.db.prepare(query).get(...(params as any[])) ?? null) as T | null;
  }

  async run(query: string, params: unknown[] = []): Promise<SqlResult> {
    this.check(query, params);
    this.statements += 1;
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

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

function mainDb(): D1LikeSql {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql());
  return new D1LikeSql(db);
}

function blobDb(): D1LikeSql {
  const db = new DatabaseSync(':memory:');
  db.exec(blobSchemaSql());
  return new D1LikeSql(db);
}

function bytesEqual(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.byteLength) {
    return false;
  }
  const view = new Uint8Array(a);
  return view.every((v, i) => v === b[i]);
}

function toBuf(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

async function chunkOf(count: number, offset = 0) {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(JSON.stringify({
      artist: `Artist ${offset + i}`,
      track: `Track ${offset + i}`,
      album: `Album ${offset + i}`,
      originalTimestampSec: 1_700_000_000 + offset + i,
    }));
  }
  const gz = await gzip(new TextEncoder().encode(lines.join('\n')));
  return { buf: toBuf(gz), digest: await sha256Hex(gz) };
}

async function seedJob(sql: Sql, id: string, state: string) {
  await sql.run(
    `INSERT INTO jobs (id, username, state, algorithm_version, total_tracks, created_at, updated_at,
        credential_expires_at)
     VALUES (?, ?, ?, 1, 10, ?, ?, ?)`,
    [id, `user-${id}`, state, NOW, NOW, NOW + 60 * 86400],
  );
}

async function uploadTo(sql: Sql, blobs: SqlBlobs, jobId: string, chunkIndex = 0) {
  const c = await chunkOf(10, chunkIndex * 10);
  return uploadChunk(sql, blobs, {
    jobId, chunkIndex, startIndex: chunkIndex * 10, digest: c.digest, entryCount: 10, compressed: c.buf,
  }, NOW);
}

async function blobCount(sql: Sql): Promise<number> {
  const row = await sql.first<{ n: number }>('SELECT COUNT(*) AS n FROM blobs');
  return Number(row?.n ?? 0);
}

async function main() {
  console.log('\n-- round trip --');
  {
    const blobs = new SqlBlobs(blobDb(), () => NOW);
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    await blobs.put('a', bytes);
    check('a Uint8Array round-trips byte for byte', bytesEqual(await blobs.get('a'), bytes));
    await blobs.put('b', toBuf(bytes));
    check('an ArrayBuffer round-trips byte for byte', bytesEqual(await blobs.get('b'), bytes));
    check('a missing key is null, not an empty buffer', (await blobs.get('nope')) === null);
    await blobs.put('a', new Uint8Array([9]));
    check('put replaces rather than failing on an existing key',
      bytesEqual(await blobs.get('a'), new Uint8Array([9])));
  }

  console.log('\n-- the shapes D1 returns --');
  {
    // D1 hands BLOB columns back as a plain array of numbers.
    const fake = {
      first: async () => ({ data: [7, 8, 9] }),
    } as unknown as Sql;
    const got = await new SqlBlobs(fake).get('k');
    check('an array of numbers becomes the same bytes', bytesEqual(got, new Uint8Array([7, 8, 9])));
  }

  console.log('\n-- delete --');
  {
    const sql = blobDb();
    const blobs = new SqlBlobs(sql, () => NOW);
    const keys = Array.from({ length: 250 }, (_, i) => `jobs/x/chunks/${i}`);
    for (const k of keys) {
      // eslint-disable-next-line no-await-in-loop
      await blobs.put(k, new Uint8Array([1]));
    }
    let threw: unknown = null;
    try {
      await blobs.delete(keys.slice(0, 200));
    } catch (e) {
      threw = e;
    }
    check('deleting more keys than D1 allows parameters does not throw', threw === null,
      threw instanceof Error ? threw.message : threw);
    check('every requested key is gone and nothing else', (await blobCount(sql)) === 50);
    check('groups stay under the parameter limit', MAX_KEYS_PER_DELETE < 100);
    await blobs.delete([]);
    check('an empty delete is a no-op', (await blobCount(sql)) === 50);
  }

  console.log('\n-- upload, read back through the real store --');
  {
    const sql = mainDb();
    const store = blobDb();
    const blobs = new SqlBlobs(store, () => NOW);
    await seedJob(sql, 'j1', 'pending');
    const r = await uploadTo(sql, blobs, 'j1');
    check('a valid chunk is accepted', r.ok, r);
    check('its bytes are in the blob database', (await blobCount(store)) === 1);
    const found = await readChunkFor(sql, blobs, 'j1', 3);
    check('the scheduler can read it back and parse it',
      found !== null && found.tracks.length === 10 && found.tracks[3].artist === 'Artist 3');
  }

  console.log('\n-- size limits --');
  {
    const sql = mainDb();
    const blobs = new SqlBlobs(blobDb(), () => NOW);
    check('a chunk fits in one D1 row', MAX_COMPRESSED_BYTES < 2_000_000);
    check('fifty full jobs fit in one D1 database', 50 * MAX_JOB_COMPRESSED_BYTES <= 450_000_000);

    const huge = new Uint8Array(MAX_COMPRESSED_BYTES + 1);
    const r = await uploadChunk(sql, blobs, {
      jobId: 'j1', chunkIndex: 0, startIndex: 0, digest: await sha256Hex(huge), entryCount: 10,
      compressed: toBuf(huge),
    }, NOW);
    check('an oversized chunk is refused', !r.ok && r.reason === 'chunk too large', r);

    // A job that has almost used its budget.
    await seedJob(sql, 'j2', 'pending');
    await sql.run(
      `INSERT INTO chunks (job_id, chunk_index, r2_key, start_index, end_index, entry_count,
          digest, compressed_bytes, uncompressed_bytes, verified, created_at)
       VALUES ('j2', 0, 'jobs/j2/chunks/0', 0, 10, 10, 'd', ?, 1, 1, ?)`,
      [MAX_JOB_COMPRESSED_BYTES - 10, NOW],
    );
    const over = await uploadTo(sql, blobs, 'j2', 1);
    check('a chunk that would exceed the job budget is refused',
      !over.ok && over.reason === 'job too large', over);
    check('nothing is stored for the refused chunk',
      (await sql.all('SELECT 1 FROM chunks WHERE job_id = ?', ['j2'])).length === 1);

    // The budget is per job, so another job is unaffected.
    await seedJob(sql, 'j3', 'pending');
    const fine = await uploadTo(sql, blobs, 'j3', 0);
    check('another job still has its own budget', fine.ok, fine);

    // A retried upload of an already-stored chunk must not be charged twice.
    const again = await uploadTo(sql, blobs, 'j3', 0);
    check('re-uploading a stored chunk is still idempotent', again.ok, again);
  }

  console.log('\n-- a full blob database --');
  {
    const sql = mainDb();
    const store = blobDb();
    const blobs = new SqlBlobs(store, () => NOW);
    await seedJob(sql, 'j1', 'active');
    await uploadTo(sql, blobs, 'j1', 0);
    await seedJob(sql, 'j2', 'pending');

    store.failWrites = true;
    let result: Awaited<ReturnType<typeof uploadChunk>> | null = null;
    let threw = false;
    try {
      result = await uploadTo(sql, blobs, 'j2', 0);
    } catch {
      threw = true;
    }
    check('a refused write does not throw out of the upload', !threw);
    check('it is reported as storage being unavailable',
      result !== null && !result.ok && result.reason === 'storage_unavailable', result);
    check('no chunk row describes bytes that were never stored',
      (await sql.all('SELECT 1 FROM chunks WHERE job_id = ?', ['j2'])).length === 0);
    const running = await readChunkFor(sql, blobs, 'j1', 0);
    check('a running job can still read its chunks', running !== null && running.tracks.length === 10);
  }

  console.log('\n-- sweeping finished jobs --');
  {
    const sql = mainDb();
    const store = blobDb();
    const blobs = new SqlBlobs(store, () => NOW);
    const states: [string, string][] = [
      ['done', 'completed'], ['gone', 'cancelled'], ['dead', 'failed'],
      ['run', 'active'], ['wait', 'paused'], ['auth', 'needs_reauth'], ['help', 'needs_attention'],
      ['take', 'exporting'], ['new', 'pending'],
    ];
    for (const [id, state] of states) {
      // eslint-disable-next-line no-await-in-loop
      await seedJob(sql, id, state);
      // eslint-disable-next-line no-await-in-loop
      await uploadTo(sql, blobs, id, 0);
      // eslint-disable-next-line no-await-in-loop
      await uploadTo(sql, blobs, id, 1);
    }
    check('setup stored two chunks per job', (await blobCount(store)) === states.length * 2);

    const limited = await sweepTerminalJobBlobs(sql, blobs, 1);
    check('a sweep stops at its limit', limited === 1, limited);

    const swept = await sweepTerminalJobBlobs(sql, blobs);
    check('the rest of the terminal jobs are swept', swept === 2, swept);

    const left = await sql.all<{ job_id: string }>('SELECT DISTINCT job_id FROM chunks ORDER BY job_id');
    const leftIds = left.map((r) => r.job_id).join(',');
    check('only non-terminal jobs keep their manifest', leftIds === 'auth,help,new,run,take,wait', leftIds);
    check('and only their bytes remain', (await blobCount(store)) === 6 * 2);
    const readable = await readChunkFor(sql, blobs, 'take', 12);
    check('an export in progress can still read its chunks', readable !== null);

    check('a second sweep finds nothing', (await sweepTerminalJobBlobs(sql, blobs)) === 0);
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
