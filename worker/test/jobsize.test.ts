/**
 * `MAX_TRACKS_PER_JOB`'s upload must fit `MAX_JOB_COMPRESSED_BYTES`, measured
 * worst case: every play distinct, so gzip finds no repeats to exploit. Real
 * histories are mostly repeat plays and compress far better. (The limit is set
 * lower than this would allow; see its comment.)
 *
 * Plays are encoded exactly as the client's `encodeChunk`
 * (src/services/BackgroundScrobbling.ts) and chunked by `CHUNK_TRACKS`. Each
 * chunk is gzipped with Node's `zlib.gzipSync` at its default level; the
 * browser uses `CompressionStream('gzip')`, which produces sizes close to it.
 */
import { gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { schemaSql } from './schema';
import { Sql, SqlResult } from '../src/store';
import { preflight, MAX_TRACKS_PER_JOB } from '../src/handoff';
import { CHUNK_TRACKS, MAX_JOB_COMPRESSED_BYTES } from '../src/chunks';

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

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

/** mulberry32: small, seeded, deterministic. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789 ';

interface Play {
  artist: string;
  track: string;
  album: string;
  originalTimestampSec: number;
  reTagged: boolean;
}

function* plays(n: number): Generator<Play> {
  const rand = prng(20261121);
  const text = (len: number) => {
    let s = '';
    for (let i = 0; i < len; i += 1) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
    return s;
  };
  let ts = 1_500_000_000;
  for (let i = 0; i < n; i += 1) {
    ts += 120 + Math.floor(rand() * 281);
    yield { artist: text(24), track: text(40), album: text(40), originalTimestampSec: ts, reTagged: true };
  }
}

/** Same encoding as the client's `encodeChunk`. */
function encodeChunk(tracks: Play[]): Uint8Array {
  return new TextEncoder().encode(tracks.map((t) => JSON.stringify({
    artist: t.artist,
    track: t.track,
    album: t.album ?? '',
    originalTimestampSec: t.originalTimestampSec,
    reTagged: t.reTagged === true,
  })).join('\n'));
}

/** Sum of the gzipped chunk sizes an upload of `n` distinct plays would store. */
function compressedBytes(n: number): number {
  let total = 0;
  let chunk: Play[] = [];
  for (const p of plays(n)) {
    chunk.push(p);
    if (chunk.length === CHUNK_TRACKS) {
      total += gzipSync(encodeChunk(chunk)).byteLength;
      chunk = [];
    }
  }
  if (chunk.length > 0) total += gzipSync(encodeChunk(chunk)).byteLength;
  return total;
}

function freshDb(): Sql {
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql());
  return new NodeSql(db);
}

const req = (username: string, trackCount: number) => ({
  username,
  payloadDigest: 'abc123',
  trackCount,
  chunkCount: Math.ceil(trackCount / CHUNK_TRACKS),
  declaredBytes: 5000,
  importId: 'import-id-0123456789abcdef',
});

async function main() {
  console.log('\n-- worst-case job size --');
  const perThousand = compressedBytes(1000);
  console.log(`  ${perThousand} bytes per 1,000 distinct plays`);
  const atMax = compressedBytes(MAX_TRACKS_PER_JOB);
  console.log(`  ${atMax} bytes for MAX_TRACKS_PER_JOB (${MAX_TRACKS_PER_JOB}) plays`
    + ` against a ${MAX_JOB_COMPRESSED_BYTES}-byte cap`);
  check('the largest job fits the storage cap with 10% headroom',
    atMax <= MAX_JOB_COMPRESSED_BYTES * 0.9, { atMax, cap: MAX_JOB_COMPRESSED_BYTES });

  console.log('\n-- preflight at the limit --');
  const atLimit = await preflight(freshDb(), req('alice', MAX_TRACKS_PER_JOB), 'k', 'https://x/cb', NOW);
  check('accepts MAX_TRACKS_PER_JOB', atLimit.ok, atLimit);
  const over = await preflight(freshDb(), req('alice', MAX_TRACKS_PER_JOB + 1), 'k', 'https://x/cb', NOW);
  check('rejects one more as too_large', !over.ok && (over as any).reason === 'too_large', over);

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
