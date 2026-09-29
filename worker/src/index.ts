/**
 * Cloudflare Workers entry point.
 *
 * The only file that knows it is running on Cloudflare. Everything it does is
 * translate bindings into the plain interfaces the rest of the worker uses, so
 * moving to a VM means replacing this file and `d1.ts`, not the scheduler.
 */
import { D1Sql, D1Database } from './d1';
import { runHousekeeping } from './housekeeping';
import { SqlBlobs } from './blobs';
import { LastFmClient } from './lastfm';
import { handleRequest, ApiEnv } from './api';
import { runTick } from './scheduler';
import { reapExpiredHandoffs } from './handoff';

export interface Env {
  DB: D1Database;
  /** A second D1 database holding only chunk bytes. See `blobs.ts`. */
  BLOB_DB: D1Database;
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
 * Must match the second entry of `[triggers] crons` in wrangler.toml. Any
 * other trigger runs the scheduler.
 */
const BLOB_SWEEP_CRON = '17 * * * *';

/**
 * Secrets that must be present and non-trivial for the worker to be safe.
 *
 * An unset Cloudflare secret arrives as `undefined`, and every consumer here
 * feeds it to `TextEncoder.encode()`, which happily turns that into the bytes
 * of the literal string "undefined". Nothing would throw: session tokens would
 * be signed with a key an attacker can guess, and stored Last.fm credentials
 * would be encrypted with one. The failure is silent and total, so it is
 * checked explicitly rather than left to be noticed.
 *
 * The names below are the ones this file reads. `src/spike.ts` uses different
 * names for the same two keys and is not deployed.
 */
const REQUIRED_SECRETS: (keyof Env)[] = [
  'LASTFM_API_KEY',
  'LASTFM_SHARED_SECRET',
  'SIGNING_KEY',
  'CREDENTIAL_SECRET',
];

/** The names of any missing secrets. Never their values. */
function missingSecrets(env: Env): string[] {
  return REQUIRED_SECRETS.filter((name) => {
    const value = env[name];
    return typeof value !== 'string' || value.trim().length < 16;
  }) as string[];
}

function buildEnv(env: Env): ApiEnv {
  return {
    sql: new D1Sql(env.DB),
    blobs: new SqlBlobs(new D1Sql(env.BLOB_DB)),
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
    const missing = missingSecrets(env);
    if (missing.length > 0) {
      // Refusing every request is the point. Serving them would mint session
      // tokens signed with a guessable key and encrypt users' Last.fm
      // credentials with one, and both are unrecoverable after the fact.
      console.error('refusing to serve; unset or too-short secrets:', missing.join(', '));
      return new Response(JSON.stringify({ ok: false, reason: 'misconfigured' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
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

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const missing = missingSecrets(env);
    if (missing.length > 0) {
      // A tick with the wrong credential secret cannot decrypt anything, so
      // every job would record a failure and eventually park itself for a
      // human. Doing nothing leaves them recoverable.
      console.error('skipping tick; unset or too-short secrets:', missing.join(', '));
      return;
    }
    const api = buildEnv(env);
    const nowSec = api.now();
    if (event.cron === BLOB_SWEEP_CRON) {
      // Its own trigger, so its subrequests never come out of a scrobbling
      // tick's budget.
      ctx.waitUntil((async () => {
        const report = await runHousekeeping(api.sql, api.blobs, nowSec);
        console.log('housekeeping', JSON.stringify(report));
      })());
      return;
    }
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
