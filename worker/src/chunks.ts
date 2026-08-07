/**
 * Chunked blob storage.
 *
 * A single gzipped blob cannot be randomly accessed at a cursor, so fetching
 * and decompressing the whole thing every tick for every job would exhaust both
 * CPU and memory. Chunks are independently compressed and sized so a tick reads
 * exactly the one its cursor points into.
 *
 * The upload path is hostile input. An authenticated user supplies arbitrary
 * compressed bytes, and the decompression happens on the *scheduler's* tick —
 * so a compression bomb does not merely break the attacker's own job, it takes
 * down every job sharing that tick.
 */
import { sha256Hex } from './crypto';
import type { Sql } from './store';

/**
 * Minimal blob interface, so R2 can become S3 or a filesystem without touching
 * the scheduler (spec "Portability requirements").
 */
export interface BlobStore {
  put(key: string, value: ArrayBuffer | Uint8Array): Promise<void>;
  get(key: string): Promise<ArrayBuffer | null>;
  delete(keys: string[]): Promise<void>;
}

/** Tracks per chunk. Chosen so a chunk decompresses well inside a tick. */
export const CHUNK_TRACKS = 1000;

/** Refuses a chunk whose compressed form is implausible for CHUNK_TRACKS. */
export const MAX_COMPRESSED_BYTES = 2 * 1024 * 1024;

/**
 * The bomb defence. Decompression stops at this many bytes rather than
 * allocating whatever the archive claims, so a 2MB upload cannot expand into
 * gigabytes of Worker memory.
 */
export const MAX_UNCOMPRESSED_BYTES = 16 * 1024 * 1024;

/** Field caps, so one absurd string cannot blow the batch or the D1 row. */
export const MAX_FIELD_LENGTH = 1000;

export interface JobTrack {
  artist: string;
  track: string;
  album?: string;
  /**
   * The original listen time, as metadata only. The worker assigns the actual
   * scrobble timestamp at send time, because a job outlives Last.fm's 14-day
   * window and any timestamp fixed at creation is rejected from ~day 15.
   */
  originalTimestampSec: number;
}

export interface ChunkRow {
  job_id: string;
  chunk_index: number;
  r2_key: string;
  start_index: number;
  end_index: number;
  entry_count: number;
  digest: string;
  compressed_bytes: number;
  uncompressed_bytes: number;
  verified: number;
}

export class ChunkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChunkValidationError';
  }
}

/**
 * Decompresses gzip with a hard output ceiling.
 *
 * `DecompressionStream` is a web standard present in both Workers and Node 18+.
 * The ceiling is enforced while reading rather than after, because "decompress
 * it all then check the size" is exactly the failure a bomb exploits.
 */
export async function gunzipBounded(
  compressed: ArrayBuffer | Uint8Array,
  maxBytes: number,
): Promise<Uint8Array> {
  const stream = new Blob([compressed as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();

  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ChunkValidationError(
        `chunk expands beyond ${maxBytes} bytes; refusing to decompress further`,
      );
    }
    parts.push(value);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  parts.forEach((part) => {
    out.set(part, offset);
    offset += part.length;
  });
  return out;
}

export async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart])
    .stream()
    .pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Parses and validates NDJSON chunk contents.
 *
 * Every field is checked because these values are later interpolated into a
 * Last.fm request and stored in D1. Rejecting the whole chunk rather than
 * skipping bad lines is deliberate: a chunk with fewer entries than declared
 * would shift every subsequent index, silently scrobbling the wrong tracks.
 */
export function parseChunk(bytes: Uint8Array, expectedCount: number): JobTrack[] {
  const text = new TextDecoder().decode(bytes);
  const lines = text.split('\n').filter((l) => l.trim().length > 0);

  if (lines.length !== expectedCount) {
    throw new ChunkValidationError(
      `chunk declares ${expectedCount} entries but contains ${lines.length}`,
    );
  }

  return lines.map((line, i) => {
    let parsed: any;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new ChunkValidationError(`entry ${i} is not valid JSON`);
    }
    const artist = parsed && parsed.artist;
    const track = parsed && parsed.track;
    if (typeof artist !== 'string' || artist.length === 0) {
      throw new ChunkValidationError(`entry ${i} has no artist`);
    }
    if (typeof track !== 'string' || track.length === 0) {
      throw new ChunkValidationError(`entry ${i} has no track`);
    }
    if (artist.length > MAX_FIELD_LENGTH || track.length > MAX_FIELD_LENGTH) {
      throw new ChunkValidationError(`entry ${i} exceeds the field length limit`);
    }
    const album = typeof parsed.album === 'string' ? parsed.album.slice(0, MAX_FIELD_LENGTH) : undefined;
    const ts = Number(parsed.originalTimestampSec);
    if (!Number.isFinite(ts)) {
      throw new ChunkValidationError(`entry ${i} has no usable timestamp`);
    }
    return { artist, track, album, originalTimestampSec: Math.floor(ts) };
  });
}

export interface UploadChunkRequest {
  jobId: string;
  chunkIndex: number;
  startIndex: number;
  /** Client-declared digest of the *compressed* bytes. */
  digest: string;
  entryCount: number;
  compressed: ArrayBuffer;
}

/**
 * Validates and stores one chunk.
 *
 * Order matters: validate before writing. Storing first and checking later
 * leaves attacker-controlled bytes in the bucket, and a crash between the two
 * leaves a chunk that no row describes.
 *
 * Chunks are write-once — a chunk already recorded is never overwritten, so it
 * cannot be swapped for different content after validation.
 */
export async function uploadChunk(
  sql: Sql,
  blobs: BlobStore,
  req: UploadChunkRequest,
  nowSec: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (req.compressed.byteLength > MAX_COMPRESSED_BYTES) {
    return { ok: false, reason: 'chunk too large' };
  }
  if (req.entryCount <= 0 || req.entryCount > CHUNK_TRACKS) {
    return { ok: false, reason: 'implausible entry count' };
  }

  const existing = await sql.first<ChunkRow>(
    'SELECT * FROM chunks WHERE job_id = ? AND chunk_index = ?',
    [req.jobId, req.chunkIndex],
  );
  if (existing) {
    // Idempotent for a retried upload of identical bytes; a conflict otherwise.
    return existing.digest === req.digest
      ? { ok: true }
      : { ok: false, reason: 'chunk already uploaded with different content' };
  }

  const actualDigest = await sha256Hex(req.compressed);
  if (actualDigest !== req.digest) {
    return { ok: false, reason: 'digest mismatch' };
  }

  let decompressed: Uint8Array;
  try {
    decompressed = await gunzipBounded(req.compressed, MAX_UNCOMPRESSED_BYTES);
    parseChunk(decompressed, req.entryCount);
  } catch (e) {
    return {
      ok: false,
      reason: e instanceof ChunkValidationError ? e.message : 'chunk could not be decompressed',
    };
  }

  const key = `jobs/${req.jobId}/chunks/${req.chunkIndex}`;
  await blobs.put(key, req.compressed);

  try {
    await sql.run(
      `INSERT INTO chunks (job_id, chunk_index, r2_key, start_index, end_index,
                           entry_count, digest, compressed_bytes, uncompressed_bytes,
                           verified, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [
        req.jobId,
        req.chunkIndex,
        key,
        req.startIndex,
        req.startIndex + req.entryCount,
        req.entryCount,
        req.digest,
        req.compressed.byteLength,
        decompressed.length,
        nowSec,
      ],
    );
  } catch {
    // Lost a race with a concurrent upload of the same chunk. The bytes are
    // identical by digest, so the winner's row is equally correct.
    return { ok: true };
  }
  return { ok: true };
}

/**
 * Reads the chunk containing a track index and returns its entries.
 *
 * Re-validates on read rather than trusting the upload-time check: the bytes
 * have been sitting in a bucket, and the cost is a few hundred microseconds
 * against the risk of feeding corrupt data to Last.fm.
 */
export async function readChunkFor(
  sql: Sql,
  blobs: BlobStore,
  jobId: string,
  trackIndex: number,
): Promise<{ chunk: ChunkRow; tracks: JobTrack[] } | null> {
  const chunk = await sql.first<ChunkRow>(
    `SELECT * FROM chunks
      WHERE job_id = ? AND start_index <= ? AND end_index > ?`,
    [jobId, trackIndex, trackIndex],
  );
  if (!chunk) {
    return null;
  }
  const bytes = await blobs.get(chunk.r2_key);
  if (!bytes) {
    return null;
  }
  const decompressed = await gunzipBounded(bytes, MAX_UNCOMPRESSED_BYTES);
  return { chunk, tracks: parseChunk(decompressed, chunk.entry_count) };
}

/**
 * Deletes a job's blobs.
 *
 * Called on completion, cancellation, permanent failure and TTL expiry. On
 * cancellation the caller must generate the user's export *before* this runs,
 * or the data needed to build it is already gone.
 */
export async function deleteJobBlobs(
  sql: Sql,
  blobs: BlobStore,
  jobId: string,
): Promise<void> {
  const chunks = await sql.all<{ r2_key: string }>(
    'SELECT r2_key FROM chunks WHERE job_id = ?',
    [jobId],
  );
  if (chunks.length > 0) {
    await blobs.delete(chunks.map((c) => c.r2_key));
  }
  await sql.run('DELETE FROM chunks WHERE job_id = ?', [jobId]);
}
