/**
 * Client for the background scrobbling worker.
 *
 * Every method here is allowed to fail. Background mode is an *offer*: if the
 * worker is unreachable, at capacity, or misbehaving, the user must still be
 * able to scrobble client-side exactly as before. Nothing in this file may
 * throw into a code path that would otherwise have worked.
 *
 * The one exception is `finalizeHandoff`, whose failure mode is genuinely
 * dangerous — see `HandoffOutcome`.
 */
import { trackError } from '@/services/Analytics';

/**
 * Absent in local development, in which case background mode simply is not
 * offered. Set at build time; `undefined` is a valid, safe configuration.
 */
const API_BASE = process.env.VUE_APP_BACKGROUND_API || '';

const SESSION_STORAGE_KEY = 'scrobblify.background.session';
const HANDOFF_STORAGE_KEY = 'scrobblify.background.handoff';

export interface Capacity {
  available: boolean;
  used: number;
  capacity: number;
  minTracks: number;
  maxTracks: number;
  chunkTracks: number;
}

export interface JobStatus {
  id: string;
  state: string;
  reason: string | null;
  totalTracks: number;
  scrobbled: number;
  failed: number;
  remaining: number;
  waitingUntil: number | null;
  estimatedCompletionSec: number;
  createdAt: number;
  completedAt: number | null;
  credentialExpiresAt: number;
}

export interface UploadTrack {
  artist: string;
  track: string;
  album?: string;
  originalTimestampSec: number;
}

export type HandoffOutcome =
  | { status: 'active'; jobId: string }
  /**
   * The upload demonstrably did not happen. Safe to carry on client-side; no
   * job exists, so nothing else is scrobbling these tracks.
   */
  | { status: 'failed'; reason: string }
  /**
   * We could not determine whether the job went live. **The caller must not
   * resume scrobbling.** If the job did activate, a client that resumes would
   * scrobble the same tracks the worker is scrobbling — the single largest
   * duplicate source in the design. Ask the server again instead.
   */
  | { status: 'unknown'; handoffId: string };

export function isBackgroundConfigured(): boolean {
  return API_BASE.length > 0;
}

export function getSession(): string | null {
  try {
    return window.localStorage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setSession(token: string): void {
  try {
    window.localStorage.setItem(SESSION_STORAGE_KEY, token);
  } catch {
    // Private browsing. The user can still re-authenticate to see status.
  }
}

export function clearSession(): void {
  try {
    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    window.localStorage.removeItem(HANDOFF_STORAGE_KEY);
  } catch {
    // Nothing to do.
  }
}

export function getPendingHandoff(): string | null {
  try {
    return window.localStorage.getItem(HANDOFF_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setPendingHandoff(id: string): void {
  try {
    window.localStorage.setItem(HANDOFF_STORAGE_KEY, id);
  } catch {
    // Nothing to do.
  }
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const session = getSession();
  if (session) {
    headers.set('Authorization', `Bearer ${session}`);
  }
  return fetch(`${API_BASE}${path}`, { ...init, headers });
}

/**
 * How long a read-only status call may take before it is abandoned.
 *
 * These run during page load, and one of them gates the Resume button. `fetch`
 * has no timeout of its own, so without this a worker that accepts a
 * connection and then stalls would leave the promise pending indefinitely and
 * the user staring at a page that never offers to resume their import.
 *
 * Uploads deliberately do not use this: abandoning one mid-flight tells us
 * nothing about whether the server received it, which is exactly the state the
 * design works hardest to avoid.
 */
const STATUS_TIMEOUT_MS = 8000;

async function getWithTimeout(path: string, authorised: boolean): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATUS_TIMEOUT_MS);
  try {
    return authorised
      ? await request(path, { signal: controller.signal })
      : await fetch(`${API_BASE}${path}`, { signal: controller.signal });
  } catch {
    // Includes the abort. Every caller treats null as "don't offer it".
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether background mode can be offered at all.
 *
 * Returns null rather than throwing on any failure, so the caller's only
 * decision is "offer it or don't".
 */
export async function fetchCapacity(): Promise<Capacity | null> {
  if (!isBackgroundConfigured()) {
    return null;
  }
  try {
    const res = await getWithTimeout('/scrobblify/capacity', false);
    if (!res || !res.ok) {
      return null;
    }
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchJob(): Promise<JobStatus | null> {
  if (!isBackgroundConfigured() || !getSession()) {
    return null;
  }
  try {
    const res = await getWithTimeout('/scrobblify/job', true);
    if (!res) {
      return null;
    }
    if (res.status === 401) {
      clearSession();
      return null;
    }
    if (!res.ok) {
      return null;
    }
    const body = await res.json();
    return body.job ?? null;
  } catch {
    return null;
  }
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  return crypto.subtle.digest('SHA-256', bytes as BufferSource).then((buf) => Array
    .from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(''));
}

function encodeChunk(tracks: UploadTrack[]): Uint8Array {
  return new TextEncoder().encode(tracks.map((t) => JSON.stringify({
    artist: t.artist,
    track: t.track,
    album: t.album ?? '',
    originalTimestampSec: t.originalTimestampSec,
  })).join('\n'));
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream()
    .pipeThrough(new (window as any).CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * True when the browser can produce the gzip the worker requires.
 *
 * `CompressionStream` is missing on older Safari. Checking here means the
 * offer is never shown to a browser that would fail at the upload step, after
 * the user has already been redirected through Last.fm.
 */
export function canCompress(): boolean {
  return typeof (window as any).CompressionStream === 'function';
}

/**
 * Step 0: ask the worker to commit the handoff before we redirect.
 *
 * Returns the URL to send the user to, or null if the worker declined. The
 * digest binds the payload we are about to upload; the worker records it and
 * can verify what arrives.
 */
export async function preflight(
  username: string,
  tracks: UploadTrack[],
  chunkTracks: number,
): Promise<{ handoffId: string; authoriseUrl: string } | null> {
  if (!isBackgroundConfigured()) {
    return null;
  }
  try {
    const payload = encodeChunk(tracks);
    const digest = await sha256Hex(payload);
    const res = await fetch(`${API_BASE}/scrobblify/handoff/preflight`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username,
        payloadDigest: digest,
        trackCount: tracks.length,
        chunkCount: Math.ceil(tracks.length / chunkTracks),
        declaredBytes: payload.byteLength,
      }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) {
      return null;
    }
    return { handoffId: body.handoffId, authoriseUrl: body.authoriseUrl };
  } catch (e) {
    trackError('background.preflight', e);
    return null;
  }
}

/**
 * Steps 4 and 5: upload every chunk, then finalise.
 *
 * The `unknown` outcome is the important one. A finalise whose response is
 * lost may well have activated the job, and a client that treats that as
 * failure and resumes scrobbling will duplicate everything the worker sends.
 */
export async function uploadAndFinalize(
  handoffId: string,
  tracks: UploadTrack[],
  chunkTracks: number,
  onProgress?: (uploaded: number, total: number) => void,
): Promise<HandoffOutcome> {
  const chunkCount = Math.ceil(tracks.length / chunkTracks);
  for (let i = 0; i < chunkCount; i += 1) {
    const slice = tracks.slice(i * chunkTracks, (i + 1) * chunkTracks);
    try {
      /* eslint-disable no-await-in-loop */
      const compressed = await gzip(encodeChunk(slice));
      const digest = await sha256Hex(compressed);
      const res = await request(
        `/scrobblify/handoff/${handoffId}/chunk/${i}?count=${slice.length}`,
        {
          method: 'PUT',
          headers: { 'X-Chunk-Digest': digest, 'Content-Type': 'application/octet-stream' },
          body: compressed as BodyInit,
        },
      );
      /* eslint-enable no-await-in-loop */
      if (!res.ok) {
        // Nothing is live yet: the job only activates at finalise, so failing
        // here is unambiguously safe to fall back from.
        return { status: 'failed', reason: `chunk ${i} rejected` };
      }
    } catch (e) {
      trackError('background.uploadChunk', e);
      return { status: 'failed', reason: 'upload failed' };
    }
    if (onProgress) {
      onProgress(i + 1, chunkCount);
    }
  }

  try {
    const res = await request(`/scrobblify/handoff/${handoffId}/finalize`, { method: 'POST' });
    const body = await res.json();
    if (res.ok && body.ok) {
      return { status: 'active', jobId: body.jobId };
    }
    // A definite, server-stated refusal. The job is not running.
    return { status: 'failed', reason: body.reason || 'finalize refused' };
  } catch (e) {
    // A network failure here tells us nothing about whether the job activated.
    trackError('background.finalize', e);
    return { status: 'unknown', handoffId };
  }
}

/**
 * Resolves an `unknown` outcome by asking the server what actually happened.
 *
 * The client may only resume locally when this returns `false`.
 */
export async function isHandoffActive(handoffId: string): Promise<boolean | null> {
  try {
    const res = await request(`/scrobblify/handoff/${handoffId}`);
    if (!res.ok) {
      return null;
    }
    const body = await res.json();
    return body.active === true;
  } catch {
    return null;
  }
}

export async function jobAction(jobId: string, action: 'pause' | 'resume' | 'cancel'): Promise<boolean> {
  try {
    const res = await request(`/scrobblify/job/${jobId}/${action}`, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function exportJob(jobId: string): Promise<any | null> {
  try {
    const res = await request(`/scrobblify/job/${jobId}/export`);
    if (!res.ok) {
      return null;
    }
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Reads the session and handoff id the worker put in the redirect fragment,
 * then strips it from the URL.
 *
 * The fragment is used rather than the query string because it is never sent
 * to a server or written to an access log — and this token authorises reading
 * a complete listening history. Stripping it stops the token surviving in
 * browser history or being copied out of the address bar.
 */
export function consumeRedirectFragment(): { session: string; handoffId: string } | null {
  try {
    const hash = window.location.hash.replace(/^#/, '');
    if (!hash) {
      return null;
    }
    const params = new URLSearchParams(hash);
    const session = params.get('session');
    const handoffId = params.get('handoff');
    if (!session || !handoffId) {
      return null;
    }
    setSession(session);
    setPendingHandoff(handoffId);
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    return { session, handoffId };
  } catch (e) {
    trackError('background.consumeRedirectFragment', e);
    return null;
  }
}
