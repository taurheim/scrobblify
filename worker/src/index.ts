/**
 * Cloudflare Workers entry point.
 *
 * The only file that knows it is running on Cloudflare. Everything it does is
 * translate bindings into the plain interfaces the rest of the worker uses, so
 * moving to a VM means replacing this file and `d1.ts`, not the scheduler.
 */
import { D1Sql, D1Database } from './d1';
import { BlobStore } from './chunks';
import { LastFmClient } from './lastfm';
import { handleRequest, ApiEnv } from './api';
import { runTick } from './scheduler';
import { reapExpiredHandoffs } from './handoff';

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  LASTFM_API_KEY: string;
  LASTFM_SHARED_SECRET: string;
  /** HMAC key for handoff state and session tokens. */
  SIGNING_KEY: string;
  /** AES-GCM key for session keys at rest. Never stored in D1. */
  CREDENTIAL_SECRET: string;
  CALLBACK_URL: string;
  APP_URL: string;
}

/**
 * R2 behind a get/put-by-key interface, so it can become S3 or a filesystem
 * without touching anything above it.
 */
class R2Blobs implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, value: ArrayBuffer | Uint8Array): Promise<void> {
    await this.bucket.put(key, value as ArrayBuffer);
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    const object = await this.bucket.get(key);
    return object ? object.arrayBuffer() : null;
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.length > 0) {
      await this.bucket.delete(keys);
    }
  }
}

function buildEnv(env: Env): ApiEnv {
  return {
    sql: new D1Sql(env.DB),
    blobs: new R2Blobs(env.BLOBS),
    lastfm: new LastFmClient({
      apiKey: env.LASTFM_API_KEY,
      sharedSecret: env.LASTFM_SHARED_SECRET,
    }),
    signingKey: env.SIGNING_KEY,
    credentialSecret: env.CREDENTIAL_SECRET,
    callbackUrl: env.CALLBACK_URL,
    appUrl: env.APP_URL,
    lastfmApiKey: env.LASTFM_API_KEY,
    now: () => Math.floor(Date.now() / 1000),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const api = buildEnv(env);
    try {
      return await handleRequest(api, request);
    } catch (error) {
      // Never let an exception carry a stack trace or a query to the client:
      // this API handles credentials and listening history.
      console.error('request failed', error instanceof Error ? error.message : error);
      return new Response(JSON.stringify({ ok: false, reason: 'internal_error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const api = buildEnv(env);
    const nowSec = api.now();
    ctx.waitUntil((async () => {
      // Reaping first: an abandoned handoff holds both a concurrency slot and
      // a permanent write credential, and neither should outlive the tab that
      // created it.
      const reaped = await reapExpiredHandoffs(api.sql, nowSec);
      const report = await runTick(
        { sql: api.sql, blobs: api.blobs, lastfm: api.lastfm, credentialSecret: api.credentialSecret },
        nowSec,
      );
      console.log('tick', JSON.stringify({ reaped, ...report }));
    })());
  },
};
