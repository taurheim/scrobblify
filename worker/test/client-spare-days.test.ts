/**
 * A take-back after a job placed plays on several UTC days.
 *
 * Named `client-*` so the client type-check includes it: it feeds the worker's
 * real export into the browser's real `stateFromExport`, which is where the
 * two halves of "who has spent which second" meet. A reservation that overlaps
 * a second the job spent loses plays silently (Last.fm discards the repeat and
 * reports it accepted), and an export that blocks the reservation strands the
 * user's resume.
 */
import { DatabaseSync } from 'node:sqlite';
import { schemaSql } from './schema';
import { Sql, SqlResult } from '../src/store';
import { BlobStore, gzip, uploadChunk } from '../src/chunks';
import {
  encryptCredential, sha256Hex, randomId,
} from '../src/crypto';
import { issueSession } from '../src/session';
import { ALGORITHM_VERSION } from '../src/handoff';
import { handleRequest, ApiEnv } from '../src/api';
import { assignTimestamps } from '../src/timestamps';
import { utcDayStartSec } from '../../src/shared/lastfm/dailyCap';
import { stateFromExport } from '@/services/BackgroundHandoff';

const SIGNING = 'signing-key-for-tests-0123456789';
const CRED = 'credential-secret-for-tests-01234';
const EXPORT_CLAIM = 'export-claim-token-for-tests';
const DAY = 86400;

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

  async getMany(ks: string[]) {
    const out = new Map<string, ArrayBuffer>();
    for (const k of ks) {
      // eslint-disable-next-line no-await-in-loop
      const v = await this.get(k);
      if (v) { out.set(k, v); }
    }
    return out;
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

async function main() {
  console.log('\n-- the export of a job that placed plays on several days --');
  /*
    The worker reports every second it spent exactly (`usedRanges`), and a
    floor that is only today's band. A lowest-of-all floor reads to the client
    as "everything from here to now may be ours", so its reservation could only
    land below the oldest band, where it expires within days.
  */
  const realNow = Math.floor(Date.now() / 1000);
  const today = utcDayStartSec(realNow);
  const db = new DatabaseSync(':memory:');
  db.exec(schemaSql());
  const sql = new NodeSql(db);
  const blobs = new MemoryBlobs();
  const env: ApiEnv = {
    sql,
    blobs,
    lastfm: {} as any,
    signingKey: SIGNING,
    credentialSecret: CRED,
    callbackUrl: 'https://api.savas.ca/scrobblify/auth/callback',
    appUrl: 'https://savas.ca/scrobblify/scrobble',
    lastfmApiKey: 'worker-api-key',
    now: () => realNow,
  };

  const total = 400;
  const id = randomId();
  const cred = await encryptCredential('sk', CRED, id);
  await sql.run(
    `INSERT INTO jobs (id, username, live_username, state, algorithm_version, total_tracks,
        cursor, session_key_ct, session_key_iv, created_at, updated_at, credential_expires_at)
     VALUES (?, 'listener', 'listener', 'paused', ?, ?, 120, ?, ?, ?, ?, ?)`,
    [id, ALGORITHM_VERSION, total, cred.ciphertext, cred.iv, realNow, realNow, realNow + 60 * DAY],
  );
  const raw = new TextEncoder().encode(Array.from({ length: total }, (_v, i) => JSON.stringify({
    artist: `Artist ${i}`, track: `Track ${i}`, album: 'Album', originalTimestampSec: 0, reTagged: true,
  })).join('\n'));
  const gz = await gzip(raw);
  await uploadChunk(sql, blobs, {
    jobId: id,
    chunkIndex: 0,
    startIndex: 0,
    digest: await sha256Hex(gz),
    entryCount: total,
    compressed: gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength) as ArrayBuffer,
  }, realNow);

  const floors: Record<string, number> = {};
  const spent: number[] = [];
  const offsets = [0, 2, 9];
  for (const [k, dayOffset] of offsets.entries()) {
    const daySec = today - dayOffset * DAY;
    const batch = assignTimestamps(
      Array.from({ length: 40 }, (_v, i) => ({
        artist: `A${i}`, track: `T${i}`, originalTimestampSec: 0,
      })),
      realNow,
      0,
      Number.NEGATIVE_INFINITY,
      {
        daySec,
        startSec: dayOffset === 0 ? realNow - 120 : daySec + DAY - 1,
        bottomSec: daySec,
        capacity: 40,
        occupied: new Set<number>(),
      },
    );
    const withIndex = batch.assigned.map((a) => ({ ...a, index: k * 40 + a.index }));
    spent.push(...withIndex.map((a) => a.timestampSec));
    floors[String(daySec)] = Math.min(...withIndex.map((a) => a.timestampSec));
    // eslint-disable-next-line no-await-in-loop
    await sql.run(
      `INSERT INTO batches (id, job_id, generation, start_index, entry_count, state,
          assigned_timestamps, created_at)
       VALUES (?, ?, 0, ?, 40, 'settled', ?, ?)`,
      [randomId(), id, k * 40, JSON.stringify(withIndex), realNow],
    );
  }
  await sql.run('UPDATE jobs SET day_bands = ? WHERE id = ?', [JSON.stringify({ floors, full: [] }), id]);

  const token = await issueSession('listener', SIGNING, realNow);
  const exportJob = async (): Promise<any> => (await handleRequest(env, new Request(
    `https://api.savas.ca/scrobblify/job/${id}/export`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ claim: EXPORT_CLAIM }),
    },
  ))).json();
  const body = await exportJob();

  const covered = (ts: number) => body.usedRanges.some((r: any) => ts >= r.from && ts <= r.to);
  check('every second on every day is reported', spent.every(covered), body.usedRanges);
  check('as separate ranges, one per band', body.usedRanges.length === 3, body.usedRanges);
  check('the floor is today\'s band, not the lowest of all',
    body.syntheticFloorSec === floors[String(today)],
    { floor: body.syntheticFloorSec, today: floors[String(today)] });
  check('and the list is complete', body.usedRangesIncomplete === false && body.usedRangesTruncated === false);

  const state: any = stateFromExport(body, 'listener', total);
  const reserved = !!state && state.reTagFloorSec !== undefined;
  check('the browser can reserve a range for the rest',
    reserved && state.reTagBlockedUntilSec === undefined, state && [state.reTagFloorSec, state.reTagBlockedUntilSec]);
  check('which touches none of the spent seconds',
    reserved && !body.usedRanges.some((r: any) => state.reTagFloorSec <= r.to && r.from <= state.reTagCeilingSec),
    { got: state && [state.reTagFloorSec, state.reTagCeilingSec], used: body.usedRanges });
  check('and is recent, not the oldest part of the window',
    reserved && state.reTagCeilingSec > realNow - 2 * DAY, state && state.reTagCeilingSec - realNow);
  const blanket: any = stateFromExport(
    { ...body, syntheticFloorSec: Math.min(...Object.values(floors)) }, 'listener', total,
  );
  check('whereas a lowest-of-all floor pushes it past the oldest band',
    !!blanket && blanket.reTagCeilingSec < realNow - 8 * DAY, blanket && blanket.reTagCeilingSec - realNow);

  await sql.run(
    "UPDATE jobs SET day_bands = '{garbage', export_claim = NULL, state = 'paused', locked_until = 0 WHERE id = ?",
    [id],
  );
  const unreadable = await exportJob();
  check('bands that cannot be read make the history incomplete',
    unreadable.usedRangesIncomplete === true && unreadable.usedRangesTruncated === true,
    { ok: unreadable.ok, reason: unreadable.reason, incomplete: unreadable.usedRangesIncomplete });
  const blocked: any = stateFromExport(unreadable, 'listener', total);
  check('so the browser holds the plays back rather than guess',
    !!blocked && blocked.reTagFloorSec === undefined && blocked.reTagBlockedUntilSec > 0, blocked);

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
