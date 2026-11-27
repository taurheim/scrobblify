/**
 * Chunk bytes stored as rows in a dedicated SQL database.
 *
 * Replaces R2 for one reason: R2 has no spending cap, so a bug or an abusive
 * uploader could run up a bill, whereas D1 on the Workers Free plan simply
 * refuses writes once it is full. See `schema-blobs/001_blobs.sql`.
 *
 * Written against the `Sql` interface rather than D1 directly, so the same
 * class runs over the real SQLite the tests use.
 */
import type { Sql } from './store';
import type { BlobStore } from './chunks';

/**
 * D1 allows at most 100 bound parameters per statement. A job has up to ~163
 * chunks, so a single `IN (...)` over all of them would be refused outright.
 */
export const MAX_KEYS_PER_DELETE = 90;

/**
 * Normalises whatever the driver hands back for a BLOB column.
 *
 * D1 returns an array of numbers, not an ArrayBuffer; node:sqlite returns a
 * Uint8Array. Both are copied into a fresh ArrayBuffer so the caller never
 * holds a view into a buffer it does not own.
 */
function toArrayBuffer(value: unknown): ArrayBuffer | null {
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice().buffer;
  }
  if (Array.isArray(value)) {
    return Uint8Array.from(value as number[]).buffer;
  }
  return null;
}

/**
 * Keys per read. A job holds at most 8 MB of chunks (`MAX_JOB_COMPRESSED_BYTES`),
 * so this bounds a read at ~163 chunks to 5 queries and each response well
 * below D1's limits, while staying far under the 100-parameter cap.
 */
export const MAX_KEYS_PER_READ = 40;

export class SqlBlobs implements BlobStore {
  constructor(
    private readonly sql: Sql,
    private readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async put(key: string, value: ArrayBuffer | Uint8Array): Promise<void> {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    await this.sql.run(
      'INSERT OR REPLACE INTO blobs (key, data, created_at) VALUES (?, ?, ?)',
      [key, bytes, this.now()],
    );
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    const row = await this.sql.first<{ data: unknown }>(
      'SELECT data FROM blobs WHERE key = ?',
      [key],
    );
    return row ? toArrayBuffer(row.data) : null;
  }

  async getMany(keys: string[]): Promise<Map<string, ArrayBuffer>> {
    const out = new Map<string, ArrayBuffer>();
    for (let i = 0; i < keys.length; i += MAX_KEYS_PER_READ) {
      const group = keys.slice(i, i + MAX_KEYS_PER_READ);
      // eslint-disable-next-line no-await-in-loop
      const rows = await this.sql.all<{ key: string; data: unknown }>(
        `SELECT key, data FROM blobs WHERE key IN (${group.map(() => '?').join(', ')})`,
        group,
      );
      rows.forEach((row) => {
        const bytes = toArrayBuffer(row.data);
        if (bytes) {
          out.set(row.key, bytes);
        }
      });
    }
    return out;
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    const statements: { query: string; params: unknown[] }[] = [];
    for (let i = 0; i < keys.length; i += MAX_KEYS_PER_DELETE) {
      const group = keys.slice(i, i + MAX_KEYS_PER_DELETE);
      statements.push({
        query: `DELETE FROM blobs WHERE key IN (${group.map(() => '?').join(', ')})`,
        params: group,
      });
    }
    // One batch is one subrequest, however many groups it holds.
    await this.sql.batch(statements);
  }
}
