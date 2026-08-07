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
import { trackError, trackEvent } from '@/services/Analytics';

/**
 * Absent in local development, in which case background mode simply is not
 * offered. Set at build time; `undefined` is a valid, safe configuration.
 */
const API_BASE = process.env.VUE_APP_BACKGROUND_API || '';

const SESSION_STORAGE_KEY = 'scrobblify.background.session';
const HANDOFF_STORAGE_KEY = 'scrobblify.background.handoff';
/**
 * Set when we know a handoff happened but not whether the server took
 * ownership. Kept out of `clearSession` on purpose: losing the session token
 * makes the uncertainty worse, not better.
 */
const UNRESOLVED_STORAGE_KEY = 'scrobblify.background.unresolved';
const LINEAGE_STORAGE_KEY = 'scrobblify.background.lineage';
const SERVER_OWNS_STORAGE_KEY = 'scrobblify.background.serverOwns';
const OWNERSHIP_CHANNEL = 'scrobblify.ownership';

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

export function clearPendingHandoff(): void {
  try {
    window.localStorage.removeItem(HANDOFF_STORAGE_KEY);
  } catch {
    // Nothing to do.
  }
}

/**
 * Records that we could not establish whether the server owns the queue.
 *
 * Component state does not survive a reload, and the recovery we ask the user
 * to perform *is* a reload. Without a durable marker, a reload after an
 * unresolved finalise reads IndexedDB, finds a queue, and cheerfully offers
 * "Resume" — while a worker may be scrobbling the very same tracks.
 *
 * The kind is recorded alongside the id because the two ambiguous moments
 * produce different identifiers: a lost finalise leaves a *handoff* id, while
 * an unconfirmed cancel during take-back leaves a *job* id. They are separate
 * namespaces on separate endpoints, so resolving one as the other yields a
 * permanent 404 — an unresolvable marker that hides the user's queue forever.
 *
 * Absence of the marker means "resolved". Only a positive answer from the
 * server clears it.
 */
export interface OwnershipMarker {
  kind: 'handoff' | 'job';
  id: string;
}

export function setOwnershipUnresolved(kind: 'handoff' | 'job', id: string): void {
  try {
    window.localStorage.setItem(UNRESOLVED_STORAGE_KEY, JSON.stringify({ kind, id }));
  } catch {
    // Private browsing. Nothing better is available; the in-memory path still
    // refuses to resume for the life of this page.
  }
}

export function getOwnershipUnresolved(): OwnershipMarker | null {
  try {
    const raw = window.localStorage.getItem(UNRESOLVED_STORAGE_KEY);
    if (!raw) { return null; }
    // Markers written before the kind existed were always handoff ids.
    if (raw.charAt(0) !== '{') {
      return { kind: 'handoff', id: raw };
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.id !== 'string' || !parsed.id) { return null; }
    return { kind: parsed.kind === 'job' ? 'job' : 'handoff', id: parsed.id };
  } catch {
    return null;
  }
}

export function clearOwnershipUnresolved(): void {
  try {
    window.localStorage.removeItem(UNRESOLVED_STORAGE_KEY);
  } catch {
    // Nothing to do.
  }
}

/**
 * How far the import had already got when it was handed over.
 *
 * The progress bar counts against the size of the *original* import, not the
 * remainder. That lineage lives in the saved state, which is deliberately
 * destroyed once the server takes ownership, and the server is never told it —
 * it only ever receives the tracks still outstanding. Without a durable copy, a
 * take-back would restart the bar at "0 of 4,000" for a user who had already
 * scrobbled 20,000, which reads as lost work.
 *
 * Purely cosmetic: every consumer treats a missing record as "no lineage" and
 * falls back to the remaining count.
 *
 * The one exception is `reTagUsedRanges`, which is correctness-bearing — see
 * its own note.
 */
export interface HandoffLineage {
  originalTotalTracks: number;
  originalSucceededCount: number;
  /**
   * The browser's own re-tag high-water mark at the moment of the handoff, and
   * the clock it was taken against.
   *
   * Needed because the browser's earlier band is invisible to the server: a
   * take-back that reserved a range using only the server's floor could land
   * back on seconds *this browser* used before handing over, which Last.fm
   * discards as silently as any other collision.
   */
  reTagCursorSec?: number;
  handedOverAtSec?: number;
  /**
   * Every re-tag range this browser has used across the whole lineage.
   *
   * A single inferred band was not enough: a queue resumed several times uses
   * a different six hours each time, and only the most recent was ever
   * reconstructable. Accumulating them is what stops a later reservation
   * landing on an earlier one.
   */
  reTagUsedRanges?: { from: number; to: number }[];
}

/**
 * How many re-tag ranges the lineage keeps.
 *
 * Only the *lowest* bound actually constrains the next reservation, so the
 * list is trimmed from the top. The rest are kept because they make a
 * misallocation diagnosable after the fact, which a single number would not.
 */
const MAX_LINEAGE_RANGES = 32;

/**
 * Last.fm's accepted-timestamp window. A range entirely older than this can no
 * longer collide with anything, because nothing may be scrobbled into it.
 */
const RETAG_WINDOW_LIMIT_SECONDS = 13 * 86400;

function sanitizeRanges(raw: unknown): { from: number; to: number }[] {
  if (!Array.isArray(raw)) { return []; }
  const cutoff = Math.floor(Date.now() / 1000) - RETAG_WINDOW_LIMIT_SECONDS;
  return raw
    .filter((r): r is { from: number; to: number } => !!r
      && Number.isFinite((r as any).from) && Number.isFinite((r as any).to)
      && (r as any).from > 0 && (r as any).to >= (r as any).from
      && (r as any).to > cutoff)
    .map((r) => ({ from: Math.floor(r.from), to: Math.floor(r.to) }))
    .sort((a, b) => a.from - b.from)
    .slice(0, MAX_LINEAGE_RANGES);
}

/**
 * Adds a range to a lineage's re-tag history.
 *
 * Exported so the handoff path and the take-back path record ranges the same
 * way; they run in different components and had no shared home for this.
 */
export function mergeReTagRange(
  existing: { from: number; to: number }[] | undefined,
  range: { from: number; to: number } | null,
): { from: number; to: number }[] {
  const all = sanitizeRanges(existing);
  if (range && Number.isFinite(range.from) && Number.isFinite(range.to)
    && range.from > 0 && range.to >= range.from) {
    all.push({ from: Math.floor(range.from), to: Math.floor(range.to) });
  }
  return sanitizeRanges(all);
}

export function setHandoffLineage(lineage: HandoffLineage): void {
  try {
    window.localStorage.setItem(LINEAGE_STORAGE_KEY, JSON.stringify(lineage));
  } catch {
    // Cosmetic only — the progress bar falls back to the remaining count.
  }
}

export function getHandoffLineage(): HandoffLineage | null {
  try {
    const raw = window.localStorage.getItem(LINEAGE_STORAGE_KEY);
    if (!raw) { return null; }
    const parsed = JSON.parse(raw);
    const total = Number(parsed.originalTotalTracks);
    const succeeded = Number(parsed.originalSucceededCount);
    if (!Number.isFinite(total) || !Number.isFinite(succeeded)) { return null; }
    return {
      originalTotalTracks: total,
      originalSucceededCount: succeeded,
      reTagCursorSec: Number.isFinite(parsed.reTagCursorSec) ? parsed.reTagCursorSec : 0,
      handedOverAtSec: Number.isFinite(parsed.handedOverAtSec) ? parsed.handedOverAtSec : 0,
      reTagUsedRanges: sanitizeRanges(parsed.reTagUsedRanges),
    };
  } catch {
    // Corrupt or unreadable. Cosmetic, so degrade rather than throw.
    return null;
  }
}

export function clearHandoffLineage(): void {
  try {
    /*
      The re-tag history outlives the lineage that carried it.

      Every caller clears this because the queue has come *back* to the
      browser, which is precisely when it is about to allocate re-tags again —
      and the ranges are the only record of which seconds earlier cycles
      consumed. Dropping them would let the next reservation land on them, and
      Last.fm discards those plays without reporting an error.

      The counts really are cosmetic and are dropped. If nothing is left worth
      keeping the key goes too.
    */
    const existing = getHandoffLineage();
    const ranges = existing ? sanitizeRanges(existing.reTagUsedRanges) : [];
    if (ranges.length === 0) {
      window.localStorage.removeItem(LINEAGE_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(LINEAGE_STORAGE_KEY, JSON.stringify({
      originalTotalTracks: 0,
      originalSucceededCount: 0,
      reTagUsedRanges: ranges,
    }));
  } catch {
    // Nothing to do.
  }
}

/**
 * Origin-wide queue ownership.
 *
 * Handing over is a decision made in one tab that binds every tab. Another tab
 * opened earlier still holds the queue in memory and, before this existed,
 * would happily keep scrobbling — or offer a Resume — against a job that may
 * run unattended for weeks. Clearing IndexedDB does not reach it.
 *
 * Two owners, and the distinction is load-bearing:
 *
 *   `freezing` — a tab is *preparing* a handoff. Set before the snapshot is
 *     taken, because everything from the snapshot to activation is a window in
 *     which another tab's sends would be captured into the upload and then
 *     scrobbled a second time by the worker. Released if the handoff fails.
 *
 *   `server` — the worker owns it. `id` is the job id where known, so startup
 *     can reconcile against terminal job status instead of blocking forever.
 *
 * localStorage is the coordination point rather than `BroadcastChannel` alone,
 * because it is also read on startup: a tab opened *after* the handover has no
 * message to receive. The channel is layered on top so that tabs already open
 * react immediately rather than at their next send.
 *
 * Deliberately conservative and origin-wide: this is a stop signal, and a
 * false stop costs a delay while a missed one costs duplicate scrobbles.
 */
export interface QueueOwner {
  owner: 'freezing' | 'server';
  /** Job id where known; handoff id during a freeze; '' for legacy records. */
  id: string;
}

export function setQueueOwner(record: QueueOwner | null): void {
  try {
    if (record) {
      window.localStorage.setItem(SERVER_OWNS_STORAGE_KEY, JSON.stringify(record));
    } else {
      window.localStorage.removeItem(SERVER_OWNS_STORAGE_KEY);
    }
  } catch {
    // Private browsing. `canCoordinateTabs` refuses to offer the feature at
    // all in that case, so this is a lost stop signal for a handoff that
    // should never have been possible rather than a silent duplicate path.
  }
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(OWNERSHIP_CHANNEL);
      channel.postMessage({ queueOwner: record });
      channel.close();
    }
  } catch {
    // Unsupported. `storage` events still reach other tabs.
  }
}

export function queueOwner(): QueueOwner | null {
  try {
    const raw = window.localStorage.getItem(SERVER_OWNS_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    // A record written before this carried an id. Treated as server-owned with
    // an unknown job, which reconciles through `hasLiveJob` instead.
    if (raw === '1') {
      return { owner: 'server', id: '' };
    }
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.owner === 'server' || parsed.owner === 'freezing')) {
      return { owner: parsed.owner, id: typeof parsed.id === 'string' ? parsed.id : '' };
    }
    // Unparseable. Treated as owned, because the alternative reading of a
    // corrupt stop signal is "carry on scrobbling".
    return { owner: 'server', id: '' };
  } catch {
    return null;
  }
}

export function serverOwnsQueue(): boolean {
  return queueOwner() !== null;
}

/**
 * Whether an origin-wide stop can actually be made durable.
 *
 * A `BroadcastChannel` message only reaches contexts that are listening right
 * now. Without localStorage a tab opened later, or restored from the bfcache
 * after the message went out, reads the queue as unowned and scrobbles a queue
 * the worker is already sending. That is a silent duplicate generator, so the
 * feature is not offered at all rather than offered without a working stop.
 */
export function canCoordinateTabs(): boolean {
  try {
    const probe = `${SERVER_OWNS_STORAGE_KEY}.probe`;
    window.localStorage.setItem(probe, '1');
    const ok = window.localStorage.getItem(probe) === '1';
    window.localStorage.removeItem(probe);
    return ok;
  } catch {
    return false;
  }
}

const FREEZE_CHANNEL = 'scrobblify.freeze';

/**
 * How long a freezing tab waits for its siblings to stop and persist.
 *
 * Sized against one in-flight Last.fm batch plus an IndexedDB write. Too short
 * and a sibling's just-sent tracks are captured into the upload and scrobbled
 * again by the worker; too long and the offer dialog appears to hang.
 */
const FREEZE_WAIT_MS = 4000;

/**
 * Registers this tab as a participant in the freeze protocol.
 *
 * `onFreeze` must stop scrobbling *and persist progress* before it resolves —
 * the freezing tab re-reads the queue from IndexedDB afterwards, and anything
 * this tab sent but did not record would be uploaded and sent a second time.
 *
 * Returns a teardown function.
 */
export function respondToFreezeRequests(onFreeze: () => Promise<void>): () => void {
  let channel: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(FREEZE_CHANNEL);
      channel.onmessage = async (event: MessageEvent) => {
        if (!event.data || event.data.type !== 'freeze') {
          return;
        }
        try {
          await onFreeze();
        } catch (e) {
          trackError('background.freezeResponder', e);
          // Deliberately not acknowledged. A freezing sibling that receives no
          // ack still waits out its full window, which is the safe outcome;
          // acking a failed halt would tell it this tab had stopped when it
          // had not.
          return;
        }
        try {
          const reply = new BroadcastChannel(FREEZE_CHANNEL);
          reply.postMessage({ type: 'frozen', id: event.data.id });
          reply.close();
        } catch {
          // The freezing tab falls back to waiting out its window.
        }
      };
    }
  } catch {
    channel = null;
  }

  return () => {
    if (channel) {
      channel.close();
    }
  };
}

/**
 * Stops every other tab before a snapshot is taken.
 *
 * This is the ordering the whole cross-tab argument rests on. Announcing the
 * handover *after* activation leaves the entire snapshot → redirect → upload →
 * finalise window — minutes, including a trip through Last.fm — during which a
 * sibling tab keeps scrobbling. Its tracks are captured in the upload and then
 * sent again by the worker, and because Last.fm silently discards a repeated
 * (artist, track, timestamp) the loss is invisible on both ends.
 *
 * The durable `freezing` record is written first, so tabs that are not
 * listening — opened later, or restored from the bfcache after the broadcast —
 * still stop at their next send. The broadcast is what makes tabs that *are*
 * listening stop now rather than one batch later.
 *
 * Returns the number of siblings that acknowledged. Callers must re-read the
 * queue from IndexedDB afterwards regardless: a sibling persists its progress
 * before acking, and that progress is only visible on disk.
 */
export async function freezeOtherTabs(): Promise<number> {
  setQueueOwner({ owner: 'freezing', id: '' });

  const requestId = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
  let acks = 0;
  let channel: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(FREEZE_CHANNEL);
      channel.onmessage = (event: MessageEvent) => {
        if (event.data && event.data.type === 'frozen' && event.data.id === requestId) {
          acks += 1;
        }
      };
      channel.postMessage({ type: 'freeze', id: requestId });
    }
  } catch {
    channel = null;
  }

  // The window is waited out in full rather than returning on the first ack:
  // there is no way to know how many tabs are open, so "everyone has answered"
  // is not a state that can be observed.
  await new Promise((resolve) => { window.setTimeout(resolve, FREEZE_WAIT_MS); });
  if (channel) {
    channel.close();
  }
  return acks;
}

/**
 * Calls back when another tab takes or releases the queue, so a loop already
 * running here stops before its next send rather than at its next reload.
 *
 * Returns a teardown function.
 */
export function onServerOwnershipChange(handler: (owner: QueueOwner | null) => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SERVER_OWNS_STORAGE_KEY) {
      handler(queueOwner());
    }
  };
  window.addEventListener('storage', onStorage);

  let channel: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(OWNERSHIP_CHANNEL);
      channel.onmessage = (event: MessageEvent) => {
        if (event.data && 'queueOwner' in event.data) {
          handler(event.data.queueOwner || null);
        }
      };
    }
  } catch {
    channel = null;
  }

  return () => {
    window.removeEventListener('storage', onStorage);
    if (channel) {
      channel.close();
    }
  };
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

/** Wider than a status check: an export carries the whole remaining queue. */
const EXPORT_TIMEOUT_MS = 30000;

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

/**
 * Whether the server currently owns the queue identified by `jobId`.
 *
 * Tri-state, like `isHandoffActive`. `false` means the server answered about
 * *this* job and it is finished; `null` means we could not establish that and
 * the caller must assume the server might own it.
 *
 * Distinct from `fetchJob`, which folds every failure into `null` because its
 * only job is to render a status card. Ownership decisions cannot use that.
 */
/**
 * Set when the worker rejects our session token. Sessions last 14 days, and an
 * unresolved handoff outlives one easily; without surfacing this the user would
 * see an endless "couldn't check" message with no way to act on it.
 */
let sessionExpired = false;

export function isSessionExpired(): boolean {
  return sessionExpired;
}

/**
 * Job states in which the server has definitively stopped scrobbling. Anything
 * else — including states added later — counts as live, so an unknown state
 * errs towards withholding Resume rather than towards duplicates.
 */
const TERMINAL_JOB_STATES = ['completed', 'failed', 'cancelled'];

/**
 * `jobId` may be empty for a legacy record that predates ids being stored. In
 * that case any live job counts, which is the conservative reading.
 *
 * A missing session returns `null`, never `false`. It used to return `false`
 * on the reasoning that a browser with no session never handed anything over —
 * but `fetchJob` clears the session on a 401, so an expired session became a
 * definitive "no job" and unblocked a queue the worker was still sending.
 */
export async function hasLiveJob(jobId = ''): Promise<boolean | null> {
  if (!isBackgroundConfigured()) {
    return false;
  }
  if (!getSession()) {
    sessionExpired = true;
    return null;
  }
  const res = await getWithTimeout('/scrobblify/job', true);
  if (!res) {
    return null;
  }
  if (res.status === 401) {
    sessionExpired = true;
    return null;
  }
  if (!res.ok) {
    return null;
  }
  try {
    const body = await res.json();
    const job = body.job ?? null;
    if (!job) {
      // The endpoint reports this user's jobs, so "none at all" answers for
      // any id. It reports finished jobs for 30 days, so a genuinely recent
      // job cannot hide behind this.
      return false;
    }
    // Answering about a *different* job says nothing about the marked one.
    // The endpoint returns one job per user, so this is a mismatched or
    // superseded id rather than a lookup failure — and guessing "finished"
    // here is what exposes a live queue.
    if (jobId && job.id !== jobId) {
      return null;
    }
    return !TERMINAL_JOB_STATES.includes(job.state);
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
      // Recorded before the token is dropped. Without this the ownership
      // resolution that follows sees no session, cannot tell why, and the UI
      // has no re-authentication button to offer.
      sessionExpired = true;
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
 * Tri-state on purpose:
 *   true  — the worker owns these tracks
 *   false — it definitively does not, and never will for this handoff
 *   null  — we cannot tell yet
 *
 * The client may only resume locally on `false`. An in-flight state such as
 * `finalizing` is `null`, not `false`: the finalise whose response we lost may
 * be a moment away from activating the job, and reading that as "inactive" is
 * exactly how the tab and the worker end up scrobbling the same tracks.
 *
 * Older workers do not send `resolved`. They are treated as unresolved unless
 * they say `active`, because their `false` cannot be trusted to be terminal.
 *
 * A timeout is applied because this gates the Resume button, and an unbounded
 * request would leave the user stuck on a spinner. A 401 is reported through
 * `sessionExpired` rather than folded into `null`: it is permanent until the
 * user re-authenticates, so retrying cannot help and the UI needs to offer a
 * different remedy.
 */
export async function isHandoffActive(
  handoffId: string,
): Promise<boolean | null> {
  const res = await getWithTimeout(`/scrobblify/handoff/${handoffId}`, true);
  if (!res) {
    return null;
  }
  if (res.status === 401) {
    sessionExpired = true;
    return null;
  }
  if (!res.ok) {
    return null;
  }
  try {
    const body = await res.json();
    if (body.active === true) {
      return true;
    }
    return body.resolved === true ? false : null;
  } catch {
    return null;
  }
}

/**
 * Resolves an ownership marker of either kind.
 *
 * The two ambiguous moments leave different identifiers on different
 * endpoints, so the marker carries its own kind and this dispatches on it.
 */
export async function resolveOwnershipMarker(
  marker: OwnershipMarker,
): Promise<boolean | null> {
  if (marker.kind === 'job') {
    return hasLiveJob(marker.id);
  }
  return isHandoffActive(marker.id);
}

export async function jobAction(jobId: string, action: 'pause' | 'resume' | 'cancel'): Promise<boolean> {
  try {
    const res = await request(`/scrobblify/job/${jobId}/${action}`, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Fetches a job export.
 *
 * A 409 is a routine, retryable answer rather than an error: the server
 * refuses to export while a batch is still in flight, because those tracks
 * would be handed back *and* scrobbled. Its body carries the reason, so it is
 * returned to the caller instead of being flattened into `null`.
 *
 * `null` means the request itself failed, and callers must never read that as
 * "the job is not running".
 */
export async function exportJob(jobId: string): Promise<any | null> {
  // An export is retried in a loop behind a spinner, so an unbounded request
  // does not merely delay one attempt — it stalls the whole retry budget and
  // the user waits forever. The window is wider than `STATUS_TIMEOUT_MS`
  // because an export carries the whole remaining queue.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
  try {
    const res = await request(`/scrobblify/job/${jobId}/export`, { signal: controller.signal });
    if (!res.ok && res.status !== 409) {
      return null;
    }
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
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

/**
 * Starts a re-authentication so an expired browser session can be replaced.
 *
 * This creates no job and reserves no capacity — it exists purely so that a
 * user whose token aged out can answer the ownership question again. Without
 * it the client's refusal to resume on an unanswered question is permanent.
 *
 * A single-use nonce is generated here and kept locally. Without it the
 * returned URL is a bearer credential that works in *any* browser: an attacker
 * could complete a signin for their own account and send the resulting link to
 * a victim, whose client would then store the attacker's session and ask the
 * ownership question against the attacker's jobs.
 *
 * Returns the URL to send the browser to, or null if the service is
 * unreachable or not configured.
 */
const REAUTH_NONCE_KEY = 'scrobblify.background.reauthNonce';

export async function startReauth(username: string): Promise<string | null> {
  if (!isBackgroundConfigured()) {
    return null;
  }
  let nonce: string;
  try {
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    nonce = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    window.sessionStorage.setItem(REAUTH_NONCE_KEY, nonce);
  } catch (e) {
    // Without somewhere to keep the nonce the return cannot be bound to this
    // browser, and an unbound return is the attack above. Refuse.
    trackError('background.startReauthNonce', e);
    return null;
  }
  try {
    const res = await fetch(`${API_BASE}/scrobblify/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, nonce }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) {
      return null;
    }
    return body.authoriseUrl as string;
  } catch (e) {
    trackError('background.startReauth', e);
    return null;
  }
}

/**
 * Consumes a re-authentication redirect.
 *
 * Separate from `consumeRedirectFragment` because that one also expects a
 * handoff id and stores it as pending — doing so here would make the client
 * try to finalise an upload that was never started.
 *
 * The nonce is compared before the session is stored, and cleared either way:
 * a return this browser did not initiate is discarded, and a replayed one
 * cannot be used twice.
 */
export function consumeReauthFragment(): boolean {
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('signin') !== 'ok') {
      return false;
    }
    const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const session = hash.get('session');
    const returned = hash.get('nonce');
    let expected: string | null = null;
    try {
      expected = window.sessionStorage.getItem(REAUTH_NONCE_KEY);
      window.sessionStorage.removeItem(REAUTH_NONCE_KEY);
    } catch {
      expected = null;
    }
    window.history.replaceState(null, '', window.location.pathname);
    if (!session || !returned || !expected || returned !== expected) {
      trackEvent('background_reauth_rejected');
      return false;
    }
    setSession(session);
    sessionExpired = false;
    return true;
  } catch (e) {
    trackError('background.consumeReauthFragment', e);
    return false;
  }
}
