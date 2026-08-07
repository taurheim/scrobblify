/**
 * Chunk upload tests. The interesting cases are hostile: a real compression
 * bomb, a digest that does not match, a chunk swapped after validation, and a
 * short chunk that would shift every subsequent index.
 */
import { DatabaseSync } from 'node:sqlite';
import { schemaSql } from './schema';
import { Sql, SqlResult } from '../src/store';
import {
  BlobStore,
  gzip,
  gunzipBounded,
  parseChunk,
  uploadChunk,
  readChunkFor,
  deleteJobBlobs,
  ChunkValidationError,
  MAX_UNCOMPRESSED_BYTES,
  MAX_FIELD_LENGTH,
} from '../src/chunks';
import { sha256Hex } from '../src/crypto';

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

function ndjson(count: number, offset = 0): Uint8Array {
  const lines: string[] = [];
  for (let i = 0; i < count; i += 1) {
    lines.push(JSON.stringify({
      artist: `Artist ${offset + i}`,
      track: `Track ${offset + i}`,
      album: `Album ${offset + i}`,
      originalTimestampSec: 1_700_000_000 + offset + i,
    }));
  }
  return new TextEncoder().encode(lines.join('\n'));
}

async function main() {
  console.log('\n-- gzip round trip --');
  const raw = ndjson(100);
  const compressed = await gzip(raw);
  const back = await gunzipBounded(compressed, MAX_UNCOMPRESSED_BYTES);
  check('round-trips', new TextDecoder().decode(back) === new TextDecoder().decode(raw));
  check('compression actually helps', compressed.length < raw.length);

  console.log('\n-- compression bomb --');
  // 64MB of zeroes compresses to a few tens of KB. Without a bounded read this
  // allocates 64MB on the scheduler's tick, taking down every job on it.
  const bomb = await gzip(new Uint8Array(64 * 1024 * 1024));
  check('bomb is small compressed', bomb.length < 200 * 1024, bomb.length);
  let bombRejected = false;
  try {
    await gunzipBounded(bomb, 1024 * 1024);
  } catch (e) {
    bombRejected = e instanceof ChunkValidationError;
  }
  check('decompression stops at the ceiling', bombRejected);

  console.log('\n-- chunk parsing --');
  const tracks = parseChunk(raw, 100);
  check('parses every entry', tracks.length === 100);
  check('preserves fields', tracks[0].artist === 'Artist 0' && tracks[0].track === 'Track 0');
  check('keeps the original timestamp as metadata',
    tracks[0].originalTimestampSec === 1_700_000_000);

  const shortCases: [string, () => void][] = [
    ['a short chunk is rejected outright', () => parseChunk(ndjson(99), 100)],
    ['a long chunk is rejected outright', () => parseChunk(ndjson(101), 100)],
    ['malformed JSON is rejected', () => parseChunk(new TextEncoder().encode('{nope'), 1)],
    ['a missing artist is rejected',
      () => parseChunk(new TextEncoder().encode('{"track":"t","originalTimestampSec":1}'), 1)],
    ['a missing track is rejected',
      () => parseChunk(new TextEncoder().encode('{"artist":"a","originalTimestampSec":1}'), 1)],
    ['an empty artist is rejected',
      () => parseChunk(new TextEncoder().encode('{"artist":"","track":"t","originalTimestampSec":1}'), 1)],
    ['a non-numeric timestamp is rejected',
      () => parseChunk(new TextEncoder().encode('{"artist":"a","track":"t","originalTimestampSec":"x"}'), 1)],
    ['an over-long field is rejected', () => parseChunk(
      new TextEncoder().encode(JSON.stringify({
        artist: 'x'.repeat(MAX_FIELD_LENGTH + 1), track: 't', originalTimestampSec: 1,
      })), 1,
    )],
  ];
  for (const [name, fn] of shortCases) {
    let threw = false;
    try { fn(); } catch (e) { threw = e instanceof ChunkValidationError; }
    check(name, threw);
  }

  console.log('\n-- upload --');
  const sql = freshDb();
  const blobs = new MemoryBlobs();
  const bytes = await gzip(ndjson(500));
  const digest = await sha256Hex(bytes);
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

  let r = await uploadChunk(sql, blobs, {
    jobId: 'j1', chunkIndex: 0, startIndex: 0, digest, entryCount: 500, compressed: buf,
  }, NOW);
  check('valid chunk accepted', r.ok, r);
  check('blob written', blobs.data.size === 1);
  const row = await sql.first<any>('SELECT * FROM chunks WHERE job_id = ?', ['j1']);
  check('row records the range', row.start_index === 0 && row.end_index === 500);
  check('row is verified', row.verified === 1);
  check('row records both sizes', row.compressed_bytes > 0 && row.uncompressed_bytes > 0);

  r = await uploadChunk(sql, blobs, {
    jobId: 'j1', chunkIndex: 0, startIndex: 0, digest, entryCount: 500, compressed: buf,
  }, NOW);
  check('re-uploading identical bytes is idempotent', r.ok, r);
  check('no duplicate row',
    (await sql.all('SELECT 1 FROM chunks WHERE job_id = ?', ['j1'])).length === 1);

  console.log('\n-- upload rejections --');
  const other = await gzip(ndjson(500, 9999));
  const otherBuf = other.buffer.slice(other.byteOffset, other.byteOffset + other.byteLength) as ArrayBuffer;
  r = await uploadChunk(sql, blobs, {
    jobId: 'j1',
    chunkIndex: 0,
    startIndex: 0,
    digest: await sha256Hex(other),
    entryCount: 500,
    compressed: otherBuf,
  }, NOW);
  check('a chunk cannot be swapped after validation', !r.ok, r);

  r = await uploadChunk(sql, blobs, {
    jobId: 'j2', chunkIndex: 0, startIndex: 0, digest: 'wrong', entryCount: 500, compressed: buf,
  }, NOW);
  check('digest mismatch rejected', !r.ok && (r as any).reason === 'digest mismatch', r);

  const declaredWrong = await uploadChunk(sql, blobs, {
    jobId: 'j3', chunkIndex: 0, startIndex: 0, digest, entryCount: 499, compressed: buf,
  }, NOW);
  check('a miscounted chunk is rejected before it shifts every later index',
    !declaredWrong.ok, declaredWrong);

  const bombBuf = bomb.buffer.slice(bomb.byteOffset, bomb.byteOffset + bomb.byteLength) as ArrayBuffer;
  const bombUpload = await uploadChunk(sql, blobs, {
    jobId: 'j4',
    chunkIndex: 0,
    startIndex: 0,
    digest: await sha256Hex(bomb),
    entryCount: 500,
    compressed: bombBuf,
  }, NOW);
  check('a compression bomb is rejected at upload', !bombUpload.ok, bombUpload);
  check('a rejected chunk leaves no blob behind', blobs.data.size === 1, blobs.data.size);
  check('a rejected chunk leaves no row behind',
    (await sql.all('SELECT 1 FROM chunks WHERE job_id = ?', ['j4'])).length === 0);

  const tooBig = await uploadChunk(sql, blobs, {
    jobId: 'j5',
    chunkIndex: 0,
    startIndex: 0,
    digest,
    entryCount: 5000,
    compressed: buf,
  }, NOW);
  check('an implausible entry count is rejected', !tooBig.ok, tooBig);

  console.log('\n-- reading back --');
  const found = await readChunkFor(sql, blobs, 'j1', 250);
  check('finds the chunk containing an index', found !== null);
  check('returns its entries', found!.tracks.length === 500);
  check('entries are the ones uploaded', found!.tracks[0].artist === 'Artist 0');
  check('an index past the end has no chunk', (await readChunkFor(sql, blobs, 'j1', 900)) === null);
  check('boundary: last index of the chunk resolves',
    (await readChunkFor(sql, blobs, 'j1', 499)) !== null);
  check('boundary: end_index is exclusive',
    (await readChunkFor(sql, blobs, 'j1', 500)) === null);

  console.log('\n-- deletion --');
  await deleteJobBlobs(sql, blobs, 'j1');
  check('blobs deleted', blobs.data.size === 0);
  check('rows deleted',
    (await sql.all('SELECT 1 FROM chunks WHERE job_id = ?', ['j1'])).length === 0);

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
