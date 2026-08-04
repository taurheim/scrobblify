/**
 * Feasibility spike for the background scrobbling worker.
 *
 * The spec (docs/superpowers/specs/2026-07-26-background-scrobbling-design.md)
 * makes this a design gate: no concurrency cap may be chosen until the free
 * tier's 10ms CPU limit, D1 write cost and subrequest budget are measured for a
 * realistic 50-track batch.
 *
 * This is a measurement harness, not production code. It never contacts
 * Last.fm: the network round trip is wall time, which does not count against
 * the CPU limit, so mocking it measures the part that actually matters.
 */
import md5 from './md5';

interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
}

interface Track {
  artist: string;
  track: string;
  album: string;
  timestamp: number;
  reTagged: boolean;
}

const BATCH_SIZE = 50;
const CHUNK_TRACKS = 1000;
const API_SECRET = 'spike-secret-not-real';

/** Counts D1/R2/fetch calls, all of which spend the 50-subrequest budget. */
class SubrequestCounter {
  public d1 = 0;

  public r2 = 0;

  public fetch = 0;

  public get total(): number {
    return this.d1 + this.r2 + this.fetch;
  }
}

function makeTracks(n: number): Track[] {
  const out: Track[] = [];
  // Deliberately non-uniform: real exports have wide artist/title length
  // spread, and JSON parse cost tracks total bytes rather than entry count.
  for (let i = 0; i < n; i += 1) {
    out.push({
      artist: `Artist Name Number ${i % 977} With Padding`,
      track: `A Reasonably Long Track Title ${i}`,
      album: `Album Title ${i % 411}`,
      timestamp: 1750000000 + i * 137,
      reTagged: i % 3 !== 0,
    });
  }
  return out;
}

async function gzip(input: string): Promise<Uint8Array> {
  const stream = new Blob([input]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(input: ArrayBuffer): Promise<string> {
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

/**
 * Last.fm's api_sig is an MD5 of the sorted parameter string plus the shared
 * secret. WebCrypto exposes SHA-1/256/384/512 but *not* MD5, so this cannot be
 * offloaded to the platform — it is pure JS on the CPU budget. Measuring it is
 * the main reason this spike exists.
 */
function signature(params: Record<string, string>): string {
  const keys = Object.keys(params).sort();
  let acc = '';
  for (const k of keys) {
    acc += k + params[k];
  }
  return md5(acc + API_SECRET);
}

function buildBatchParams(batch: Track[], sendTimes: number[]): Record<string, string> {
  const params: Record<string, string> = {
    method: 'track.scrobble',
    api_key: 'spike-api-key',
    sk: 'spike-session-key',
  };
  batch.forEach((t, i) => {
    params[`artist[${i}]`] = t.artist;
    params[`track[${i}]`] = t.track;
    params[`album[${i}]`] = t.album;
    params[`timestamp[${i}]`] = String(sendTimes[i]);
  });
  params.api_sig = signature(params);
  return params;
}

/** Shape-accurate mock of a 50-scrobble track.scrobble response. */
function mockResponse(batch: Track[]): string {
  return JSON.stringify({
    scrobbles: {
      '@attr': { accepted: batch.length - 2, ignored: 2 },
      scrobble: batch.map((t, i) => ({
        artist: { '#text': t.artist, corrected: i % 7 === 0 ? '1' : '0' },
        album: { '#text': t.album, corrected: '0' },
        track: { '#text': t.track, corrected: '0' },
        timestamp: String(t.timestamp),
        ignoredMessage: { code: i % 25 === 0 ? '1' : '0', '#text': i % 25 === 0 ? 'Artist ignored' : '' },
      })),
    },
  });
}

function parseResponse(body: string) {
  const parsed = JSON.parse(body);
  const list = parsed.scrobbles.scrobble;
  return list.map((e: any) => ({
    artist: e.artist['#text'],
    corrected: e.artist.corrected === '1',
    code: Number(e.ignoredMessage.code),
  }));
}

async function migrate(env: Env, sub: SubrequestCounter) {
  const stmts = [
    'DROP TABLE IF EXISTS jobs',
    'DROP TABLE IF EXISTS batch_mappings',
    'DROP TABLE IF EXISTS entry_outcomes',
    `CREATE TABLE jobs (
       id TEXT PRIMARY KEY, username TEXT NOT NULL,
       generation INTEGER NOT NULL DEFAULT 0, cursor INTEGER NOT NULL DEFAULT 0,
       locked_until INTEGER NOT NULL DEFAULT 0, last_run_at INTEGER NOT NULL DEFAULT 0,
       state TEXT NOT NULL DEFAULT 'active')`,
    'CREATE INDEX idx_jobs_due ON jobs(state, last_run_at)',
    `CREATE TABLE batch_mappings (
       job_id TEXT NOT NULL, generation INTEGER NOT NULL, batch_start INTEGER NOT NULL,
       batch_len INTEGER NOT NULL, timestamps TEXT NOT NULL, outcomes TEXT,
       PRIMARY KEY (job_id, batch_start))`,
    `CREATE TABLE entry_outcomes (
       job_id TEXT NOT NULL, idx INTEGER NOT NULL, generation INTEGER NOT NULL,
       ts INTEGER NOT NULL, status TEXT,
       PRIMARY KEY (job_id, idx))`,
    'CREATE INDEX idx_entry_status ON entry_outcomes(job_id, status)',
  ];
  for (const s of stmts) {
    // eslint-disable-next-line no-await-in-loop
    await env.DB.prepare(s).run();
    sub.d1 += 1;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/spike') {
      return new Response('POST /spike', { status: 404 });
    }

    const sub = new SubrequestCounter();
    const cpu: Record<string, number> = {};
    const t = (label: string, fn: () => void) => {
      const start = performance.now();
      fn();
      cpu[label] = Number((performance.now() - start).toFixed(3));
    };

    // Workers coarsen performance.now() to ~1ms to blunt timing attacks, so a
    // single pass cannot resolve sub-millisecond work. Amortise over many
    // iterations instead and divide.
    if (url.searchParams.get('bench') === '1') {
      const tracks = makeTracks(CHUNK_TRACKS);
      const ndjson = tracks.map((x) => JSON.stringify(x)).join('\n');
      const packed = await gzip(ndjson);
      const batch = tracks.slice(0, BATCH_SIZE);
      const nowSec = Math.floor(Date.now() / 1000);
      const sendTimes = batch.map((_, i) => nowSec - (BATCH_SIZE - i));
      const body = mockResponse(batch);

      const bench = async (label: string, iters: number, fn: () => void) => {
        fn();
        const start = performance.now();
        for (let i = 0; i < iters; i += 1) fn();
        const total = performance.now() - start;
        return { label, iters, totalMs: Number(total.toFixed(1)), perOpMs: Number((total / iters).toFixed(4)) };
      };

      const results = [];
      results.push(await bench('sign_batch_of_50', 2000, () => { buildBatchParams(batch, sendTimes); }));
      results.push(await bench('json_parse_1000_track_chunk', 500, () => {
        const src = ndjson.split('\n');
        for (const l of src) JSON.parse(l);
      }));
      results.push(await bench('parse_scrobble_response_50', 5000, () => { parseResponse(body); }));

      const gunzipStart = performance.now();
      const GUNZIPS = 200;
      for (let i = 0; i < GUNZIPS; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await gunzip(packed.buffer.slice(0) as ArrayBuffer);
      }
      const gunzipTotal = performance.now() - gunzipStart;

      const perTick = results[0].perOpMs + results[2].perOpMs;
      return Response.json({
        note: 'Amortised microbenchmarks. gunzip/parse are per 1000-track chunk; signing and response parsing are per 50-track batch.',
        results,
        gunzip_1000_track_chunk: {
          iters: GUNZIPS,
          totalMs: Number(gunzipTotal.toFixed(1)),
          perOpMs: Number((gunzipTotal / GUNZIPS).toFixed(4)),
        },
        cpuLimitMs: 10,
        perBatchComputeMs: Number(perTick.toFixed(4)),
        note2: 'A tick amortises chunk decode across the 20 batches in a chunk; signing and response parsing are paid per batch.',
      });
    }

    await migrate(env, sub);

    // --- Setup: write a realistic gzipped chunk to R2 -----------------------
    const tracks = makeTracks(CHUNK_TRACKS);
    const ndjson = tracks.map((x) => JSON.stringify(x)).join('\n');
    const packed = await gzip(ndjson);
    await env.BLOBS.put('spike/chunk-0.ndjson.gz', packed);
    sub.r2 += 1;

    await env.DB.prepare(
      'INSERT INTO jobs (id, username, generation, cursor, locked_until, last_run_at) VALUES (?,?,?,?,?,?)',
    ).bind('job-1', 'spikeuser', 0, 0, 0, 0).run();
    sub.d1 += 1;

    // ===== A tick begins here ==============================================
    const tickStart = performance.now();

    // 1. Acquire the job: single atomic CAS that bumps the fencing generation.
    const acquired = await env.DB.prepare(
      `UPDATE jobs SET generation = generation + 1, locked_until = ?, last_run_at = ?
       WHERE id = ? AND locked_until < ? RETURNING generation, cursor`,
    ).bind(Date.now() + 60000, Date.now(), 'job-1', Date.now()).first<{ generation: number; cursor: number }>();
    sub.d1 += 1;
    const generation = acquired?.generation ?? 0;
    const cursor = acquired?.cursor ?? 0;

    // 2. Read + decompress the chunk the cursor points into.
    const obj = await env.BLOBS.get('spike/chunk-0.ndjson.gz');
    sub.r2 += 1;
    const raw = await obj!.arrayBuffer();
    const decompressStart = performance.now();
    const text = await gunzip(raw);
    cpu.gunzip = Number((performance.now() - decompressStart).toFixed(3));

    let chunk: Track[] = [];
    t('json_parse_chunk', () => {
      chunk = text.split('\n').map((l) => JSON.parse(l));
    });

    // 3. Assign send timestamps and build the signed batch.
    const batch = chunk.slice(cursor, cursor + BATCH_SIZE);
    const nowSec = Math.floor(Date.now() / 1000);
    const sendTimes = batch.map((_, i) => nowSec - (BATCH_SIZE - i));

    let params: Record<string, string> = {};
    t('build_and_sign_batch', () => {
      params = buildBatchParams(batch, sendTimes);
    });

    t('signature_only_x1', () => { signature(params); });

    // 4. Persist the index -> timestamp mapping BEFORE sending.
    //    Representation A: one row per batch.
    const aStart = performance.now();
    await env.DB.prepare(
      `INSERT INTO batch_mappings (job_id, generation, batch_start, batch_len, timestamps)
       VALUES (?,?,?,?,?)`,
    ).bind('job-1', generation, cursor, batch.length, JSON.stringify(sendTimes)).run();
    sub.d1 += 1;
    const repA = { ms: Number((performance.now() - aStart).toFixed(3)), d1Calls: 1, rows: 1 };

    //    Representation B: one row per entry, sent as a single batched call.
    const bStart = performance.now();
    const inserts = batch.map((_, i) => env.DB.prepare(
      'INSERT INTO entry_outcomes (job_id, idx, generation, ts, status) VALUES (?,?,?,?,?)',
    ).bind('job-1', cursor + i, generation, sendTimes[i], 'sent'));
    await env.DB.batch(inserts);
    sub.d1 += 1;
    const repB = {
      ms: Number((performance.now() - bStart).toFixed(3)),
      d1Calls: 1,
      rows: batch.length,
      indexes: 2,
    };

    // 5. Send. Mocked: the network round trip is wall time, not CPU.
    const body = mockResponse(batch);
    sub.fetch += 1;

    let outcomes: any[] = [];
    t('parse_response', () => { outcomes = parseResponse(body); });

    // 6. Record per-entry outcomes, fenced on the generation.
    const commitStart = performance.now();
    const updates = outcomes.map((o, i) => env.DB.prepare(
      `UPDATE entry_outcomes SET status = ? WHERE job_id = ? AND idx = ? AND generation = ?`,
    ).bind(o.code === 0 ? 'accepted' : `ignored:${o.code}`, 'job-1', cursor + i, generation));
    await env.DB.batch(updates);
    sub.d1 += 1;

    // 7. Advance the cursor over the terminal prefix only, fenced.
    let terminal = 0;
    while (terminal < outcomes.length && outcomes[terminal].code !== 5) terminal += 1;
    await env.DB.prepare(
      'UPDATE jobs SET cursor = ?, locked_until = 0 WHERE id = ? AND generation = ?',
    ).bind(cursor + terminal, 'job-1', generation).run();
    sub.d1 += 1;
    const commitMs = Number((performance.now() - commitStart).toFixed(3));

    const tickTotal = Number((performance.now() - tickStart).toFixed(3));
    const cpuOnly = Object.entries(cpu)
      .filter(([k]) => k !== 'signature_only_x1')
      .reduce((a, [, v]) => a + v, 0);

    return Response.json({
      note: 'Local miniflare run. Wall time includes local D1/R2 I/O, which in production is network wall time and does NOT count against the CPU limit.',
      batchSize: BATCH_SIZE,
      chunkTracks: CHUNK_TRACKS,
      chunkBytes: { raw: ndjson.length, gzipped: packed.byteLength },
      subrequests: {
        d1: sub.d1, r2: sub.r2, fetch: sub.fetch, total: sub.total, limit: 50,
      },
      cpuMs: cpu,
      pureComputeMsPerTick: Number(cpuOnly.toFixed(3)),
      cpuLimitMs: 10,
      representations: { A_onePerBatch: repA, B_onePerEntry: repB },
      commitPhaseMs: commitMs,
      tickWallMs: tickTotal,
    });
  },
};
