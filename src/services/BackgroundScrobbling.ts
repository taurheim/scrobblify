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
import type { FailedTrackDetail } from '@/services/StateManager';

/**
 * Absent in local development, in which case background mode simply is not
 * offered. Set at build time; `undefined` is a valid, safe configuration.
 */
const API_BASE = process.env.VUE_APP_BACKGROUND_API || '';

const BETA_STORAGE_KEY = 'scrobblify.background.beta';
const SESSION_STORAGE_KEY = 'scrobblify.background.session';
const HANDOFF_STORAGE_KEY = 'scrobblify.background.handoff';
/**
 * Set when we know a handoff happened but not whether the server took
 * ownership. Kept out of `clearSession` on purpose: losing the session token
 * makes the uncertainty worse, not better.
 */
const UNRESOLVED_STORAGE_KEY = 'scrobblify.background.unresolved';
const LINEAGE_STORAGE_KEY = 'scrobblify.background.lineage';
const IN_FLIGHT_STORAGE_KEY = 'scrobblify.background.inflightSecond';
const SERVER_OWNS_STORAGE_KEY = 'scrobblify.background.serverOwns';
const STALE_SNAPSHOT_STORAGE_KEY = 'scrobblify.background.staleSnapshot';
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
  /**
   * For a job waiting on the user: when a parked job goes dormant, or when a
   * dormant one is cancelled. Null otherwise, and for jobs parked before the
   * worker started recording it.
   */
  inactivityDeadline?: number | null;
  /**
   * Sent only with a job that has no key (`needs_reauth`, `dormant`). False
   * when reconnecting would be refused because the service is full.
   */
  reconnectAvailable?: boolean;
}

export interface UploadTrack {
  artist: string;
  track: string;
  album?: string;
  originalTimestampSec: number;
  /**
   * Whether this play's date was invented by the client rather than listened
   * at, sent explicitly instead of being inferred from a zero timestamp.
   *
   * The worker used to derive it — zero meant "stamp this at send time" — and
   * that held right up until the client needed to pin a *specific* second on a
   * re-tagged track it may already have sent. A pinned second is non-zero, so
   * the inference would export that track as a genuine listen; the browser
   * would then faithfully preserve a date that eventually ages out, and
   * Last.fm would reject the play outright.
   */
  reTagged?: boolean;
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

/**
 * Whether this build can talk to a worker at all.
 *
 * Deliberately separate from `isBackgroundEnabled`. This is the question the
 * *recovery* paths ask — the live-job authority check, finishing a handoff on
 * return from Last.fm, and rendering an existing job — and they must not be
 * gated on the beta opt-in. A browser whose storage was cleared has lost the
 * opt-in but may still have a job running on the server, and that browser is
 * exactly the one `enforceServerAuthority` exists to stop from scrobbling
 * underneath it.
 */
export function isBackgroundConfigured(): boolean {
  return API_BASE.length > 0;
}

export function isBetaOptedIn(): boolean {
  try {
    return window.localStorage.getItem(BETA_STORAGE_KEY) === '1';
  } catch {
    // Private browsing. The offer additionally requires `canCoordinateTabs`,
    // which fails here too, so this only agrees with a decision already made.
    return false;
  }
}

/**
 * Whether to *offer* the handoff to this user.
 *
 * The opt-in is sticky rather than read from the URL on each load, because
 * the URL does not survive the flow: `stripQuery` discards the whole query
 * string on a handoff return, and the trip out to Last.fm and back arrives on
 * a callback URL that never carried the parameter. A per-load flag would
 * therefore switch itself off precisely when a handoff came back, stranding a
 * user whose tracks are already uploaded.
 */
export function isBackgroundEnabled(): boolean {
  return isBackgroundConfigured() && isBetaOptedIn();
}

export function setBetaOptIn(on: boolean): void {
  try {
    if (on) {
      window.localStorage.setItem(BETA_STORAGE_KEY, '1');
    } else {
      window.localStorage.removeItem(BETA_STORAGE_KEY);
    }
  } catch {
    // Nothing to do; `isBetaOptedIn` will keep answering false.
  }
}

/**
 * Applies `?beta=1` / `?beta=0` from the current URL, and reports whether the
 * opt-in is now on.
 *
 * Reads the hash as well as the query string: outside production the router
 * runs in hash mode, so an invite link is `/?beta=1#/scrobble` but a link
 * someone assembles by hand is just as likely to be `/#/scrobble?beta=1`.
 *
 * The parameter is **not** stripped afterwards. Stripping would mean a second
 * URL rewrite racing the one `AuthenticateStep` already performs to remove a
 * consumed Last.fm token, and the two use different mechanisms
 * (`history.replaceState` against `$router.replace`), so whichever lands last
 * silently reinstates what the other removed. Re-applying the same value on a
 * later load is idempotent, and leaving it visible keeps the invite link
 * shareable and the opt-out link honest.
 */
export function consumeBetaParam(): boolean {
  let raw: string | null = null;
  try {
    raw = new URLSearchParams(window.location.search).get('beta');
    if (raw === null) {
      const hash = window.location.hash.replace(/^#/, '');
      const qIndex = hash.indexOf('?');
      if (qIndex !== -1) {
        raw = new URLSearchParams(hash.slice(qIndex + 1)).get('beta');
      }
    }
  } catch {
    raw = null;
  }
  if (raw !== null) {
    setBetaOptIn(raw !== '0' && raw !== 'false');
  }
  return isBetaOptedIn();
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
 * Records that the queue saved on this device is a snapshot that has been
 * overtaken, and must never be resumed.
 *
 * Take-back saves the exported queue *before* it cancels the job, because
 * cancelling first and then failing to save would destroy the only copy. When
 * the cancel is then refused — which now happens whenever the export claim has
 * lapsed — the server still holds the real queue and has been free to carry on
 * scrobbling it. What is on disk here is a photograph of where the import used
 * to be.
 *
 * Without this record, "unresolved ownership" is the only thing standing in the
 * way, and that resolves itself the moment the job stops being live: both
 * release paths then read the saved queue back and offer Resume. Everything the
 * server sent after the snapshot would be scrobbled a second time.
 *
 * So the two conditions are recorded separately, because they are different
 * questions. Ownership asks "does the server still own this queue"; this asks
 * "is this copy of it still true". A job that has finished answers the first
 * and says nothing about the second.
 *
 * Deliberately not cleared by resolving ownership. Only replacing the queue —
 * a take-back that completes, or discarding it — can clear it.
 *
 * The record names the queue as well as the job, because it outlives both. A
 * discard that fails leaves it on disk indefinitely, and by the time the next
 * release path reads it the browser may be holding an entirely different
 * import that nothing is wrong with. A record that cannot say *which* queue it
 * condemns would take that one with it.
 */
export interface StaleSnapshotRecord {
  jobId: string;
  /** The rotated identity the exported queue was saved under. */
  importId: string;
}

export function setStaleSnapshot(jobId: string, importId: string): void {
  try {
    window.localStorage.setItem(
      STALE_SNAPSHOT_STORAGE_KEY,
      JSON.stringify({ jobId, importId }),
    );
  } catch {
    // Private browsing. The in-memory path still refuses for this page's life.
  }
}

export function staleSnapshotRecord(): StaleSnapshotRecord | null {
  try {
    const raw = window.localStorage.getItem(STALE_SNAPSHOT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      jobId: typeof parsed.jobId === 'string' ? parsed.jobId : '',
      importId: typeof parsed.importId === 'string' ? parsed.importId : '',
    };
  } catch {
    /*
      Unparseable is not absent. A record written by an older build, or
      truncated by a quota failure mid-write, still says a photograph was
      taken — and the queue it names is the one on disk, since nothing else
      writes there. Reported as a record with no identity, which the
      comparison below treats as matching only an equally unnamed queue.
    */
    return null;
  }
}

/**
 * Whether the queue on disk is the photograph the record condemns.
 *
 * `savedImportId` is the identity of the state currently on disk, or `null`
 * when there is nothing there at all.
 *
 * Identity is what makes this decision safe in both directions. A matching id
 * is proof this is the same copy the refused cancel left behind. A *different*
 * id is proof it is not — the disk has been rewritten by a later import, and
 * discarding that would destroy progress the server never had.
 *
 * Two unnamed queues compare equal, and that is the intended fail-safe
 * direction: identities only come out empty when `crypto.getRandomValues` is
 * unavailable, and in that browser a wrongly kept photograph duplicates plays
 * on a public profile while a wrongly discarded queue costs a re-import.
 */
export function savedQueueIsStale(
  record: StaleSnapshotRecord | null,
  savedImportId: string | null,
): boolean {
  if (!record) return false;
  if (savedImportId === null) return false;
  return record.importId === savedImportId;
}

/**
 * Clears the record only if it is still the one the caller decided about.
 *
 * There is deliberately no unconditional version. The queue this record names
 * is deleted under a compare-and-set, and the record has to be retracted the
 * same way for the pair to mean anything. Every caller reads the record, does
 * asynchronous work, and then clears it; in that gap another tab can condemn
 * its *own* photograph and write a different record over this one. A blind
 * `removeItem` then retracts a condemnation nobody made, and the queue it was
 * protecting is offered back.
 *
 * localStorage is synchronous, so read-compare-remove needs no transaction:
 * nothing else on this thread can run in between.
 *
 * An unreadable record is left alone. It condemns nothing either way — every
 * decision goes through `staleSnapshotRecord`, which reports it as absent —
 * and removing what cannot be identified is the mistake this exists to stop.
 */
export function clearStaleSnapshotIf(
  matches: (record: StaleSnapshotRecord) => boolean,
): void {
  try {
    const current = staleSnapshotRecord();
    if (!current || !matches(current)) return;
    window.localStorage.removeItem(STALE_SNAPSHOT_STORAGE_KEY);
  } catch {
    // Nothing to do.
  }
}

/** Whether two records describe the same condemned queue. */
export function sameStaleSnapshot(
  a: StaleSnapshotRecord | null,
  b: StaleSnapshotRecord | null,
): boolean {
  if (!a || !b) return false;
  return a.jobId === b.jobId && a.importId === b.importId;
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
 * its own note. `carriedFailures` is a second exception of a different kind:
 * losing it does not risk a wrong scrobble, but it is the only record that a
 * given play was written off, and nothing else can reconstruct it.
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
  /**
   * The second below which `reTagUsedRanges` is *not* known to be complete.
   *
   * The ranges are consumed by a gap search, and a gap search is the one use
   * that a missing entry actively breaks: an omitted range turns an occupied
   * stretch into an apparently free one, and allocating there loses plays
   * silently. Two things legitimately drop entries — the cap below, and a
   * worker export that had more ranges than it could send — and both drop the
   * *lowest* ones, so what is lost is always describable as "everything under
   * this second".
   *
   * Recording it keeps truncation survivable instead of fatal: the region
   * above the floor is still completely described, so the search simply starts
   * there rather than being abandoned. Zero means no knowledge is missing.
   */
  reTagKnownFromSec?: number;
  /**
   * Tracks earlier owners of this queue wrote off permanently.
   *
   * Kept here rather than in the saved state because the saved state does not
   * survive a handoff — `beginHandoff` clears it once the worker owns the
   * queue, so a second handover would otherwise reduce this list to whatever
   * the *latest* job happened to reject and silently drop everything reported
   * by the ones before it. The lineage is the only thing that spans the whole
   * chain of owners, which is exactly the lifetime this list needs.
   */
  carriedFailures?: FailedTrackDetail[];
  /**
   * How many failures were dropped to stay inside the cap below.
   *
   * A count is a poor substitute for a name, but it is far better than
   * silently shortening the list: the user can at least tell that what they
   * are reading is incomplete.
   */
  carriedFailuresDropped?: number;
}

/**
 * How many named failures the lineage keeps.
 *
 * Generous, because each record is a few dozen bytes and the alternative to
 * keeping one is the user never learning that a play was lost. Unlike the
 * ranges above, the *oldest* are the ones worth keeping — they are the ones
 * the user has had least opportunity to see — so the cap trims the newest
 * only after the list is already implausibly long.
 */
const MAX_LINEAGE_FAILURES = 500;

/**
 * How many re-tag ranges the lineage keeps.
 *
 * Which ones are kept matters more than how many. The old allocator reserved
 * below the *lowest* used second, so the lowest ranges were the only ones that
 * constrained it and trimming the high end was free. The gap search inverted
 * that: it walks down from the present, so the ranges it collides with first
 * are the *highest* ones, and dropping those is what causes a reused second.
 * The low end is the safe end to lose — those ranges age out of Last.fm's
 * window on their own, at which point nothing can be scrobbled into them.
 *
 * Raised alongside the change of policy, because the gap search genuinely
 * consults every range rather than reducing them to one bound.
 */
const MAX_LINEAGE_RANGES = 128;

/**
 * Last.fm's accepted-timestamp window. A range entirely older than this can no
 * longer collide with anything, because nothing may be scrobbled into it.
 */
const RETAG_WINDOW_LIMIT_SECONDS = 13 * 86400;

/**
 * Applies the retention rules, reporting what the cap cost.
 *
 * `droppedBelowSec` is the lowest second still described when the cap had to
 * discard something, and 0 when nothing correctness-bearing was lost. Ageing a
 * range out past Last.fm's window is not a loss and never sets it: nothing can
 * be scrobbled into those seconds any more, so their absence cannot mislead a
 * gap search.
 */
function validRanges(raw: unknown): { from: number; to: number }[] {
  if (!Array.isArray(raw)) { return []; }
  const cutoff = Math.floor(Date.now() / 1000) - RETAG_WINDOW_LIMIT_SECONDS;
  return raw
    .filter((r): r is { from: number; to: number } => !!r
      && Number.isFinite((r as any).from) && Number.isFinite((r as any).to)
      && (r as any).from > 0 && (r as any).to >= (r as any).from
      && (r as any).to > cutoff)
    .map((r) => ({ from: Math.floor(r.from), to: Math.floor(r.to) }))
    // Highest first, so the cap drops the oldest rather than the newest.
    .sort((a, b) => b.to - a.to);
}

function capRanges(raw: unknown): {
  ranges: { from: number; to: number }[]; droppedBelowSec: number;
} {
  const valid = validRanges(raw);
  const kept = valid.slice(0, MAX_LINEAGE_RANGES);
  // Stored ascending, which is how every consumer expects to read them.
  kept.sort((a, b) => a.from - b.from);
  return {
    ranges: kept,
    droppedBelowSec: valid.length > kept.length && kept.length > 0 ? kept[0].from : 0,
  };
}

/**
 * Combines two incompleteness floors. Higher wins: it is the more pessimistic
 * claim, and the one that keeps a gap search inside describable ground.
 */
export function combineKnownFrom(a: unknown, b: unknown): number {
  const left = Number.isFinite(a) && Number(a) > 0 ? Math.floor(Number(a)) : 0;
  const right = Number.isFinite(b) && Number(b) > 0 ? Math.floor(Number(b)) : 0;
  return Math.max(left, right);
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
  existingKnownFromSec: unknown = 0,
): { ranges: { from: number; to: number }[]; knownFromSec: number } {
  const all = validRanges(existing);
  if (range && Number.isFinite(range.from) && Number.isFinite(range.to)
    && range.from > 0 && range.to >= range.from) {
    all.push({ from: Math.floor(range.from), to: Math.floor(range.to) });
  }
  const capped = capRanges(all);
  return {
    ranges: capped.ranges,
    knownFromSec: combineKnownFrom(existingKnownFromSec, capped.droppedBelowSec),
  };
}

/**
 * Folds the seconds a worker job actually used back into the lineage.
 *
 * A take-back consults the exported ranges when it picks the browser's next
 * band, but consulting them is not remembering them. Once the job is cancelled
 * those ranges exist nowhere else, so a *second* handover-and-take-back cycle
 * would allocate as though the first job's scrobbles had never happened — and
 * Last.fm discards a repeat of (artist, track, timestamp) while reporting it
 * accepted, so the loss is invisible from both ends.
 *
 * An incomplete list is merged rather than refused, which is the opposite of
 * how the *reservation* treats one. The two uses are not symmetrical: a
 * reservation reads the gaps between ranges and a missing range turns an
 * occupied gap into an apparently free one, whereas the lineage is only ever a
 * lower bound on what has been used. Every range here is real even when the
 * set is partial, so keeping them can only widen what a later cycle avoids.
 * Discarding the whole list because part of it was missing threw away true
 * information and made the next allocation worse, not safer.
 *
 * The incompleteness itself is not discarded, though — it is what
 * `knownFromSec` carries forward, so a later gap search knows where its
 * knowledge stops instead of assuming the set is exhaustive.
 */
export function mergeExportedRanges(
  existing: { from: number; to: number }[] | undefined,
  exported: unknown,
  existingKnownFromSec: unknown = 0,
  exportedFloorSec: unknown = 0,
): { ranges: { from: number; to: number }[]; knownFromSec: number } {
  /*
    Validated but *not* capped on the way in. Capping each side separately and
    then capping the union discards the intermediate losses silently: 200
    exported ranges would be cut to 128 before the union ever saw them, and the
    outer cap — seeing only 128 — would report nothing dropped and mark a
    partial history complete. One cap, at the end, is the only one whose floor
    describes the whole set.
  */
  const capped = capRanges([...validRanges(existing), ...validRanges(exported)]);
  return {
    ranges: capped.ranges,
    knownFromSec: combineKnownFrom(
      combineKnownFrom(existingKnownFromSec, exportedFloorSec),
      capped.droppedBelowSec,
    ),
  };
}

/**
 * Keeps only entries that actually name a track.
 *
 * An entry with neither an artist nor a title tells the user nothing, and
 * showing it would imply a play was lost that this list cannot describe.
 */
function validFailures(raw: unknown): FailedTrackDetail[] {
  if (!Array.isArray(raw)) { return []; }
  return raw
    .filter((f: any) => f && (typeof f.artist === 'string' || typeof f.track === 'string')
      && (f.artist || f.track))
    .map((f: any) => ({
      artist: String(f.artist || ''),
      track: String(f.track || ''),
      album: String(f.album || ''),
      reason: String(f.reason || 'Rejected by Last.fm'),
    }));
}

/**
 * Combines the failures already known to this lineage with a newly returned
 * set, newest last, de-duplicated.
 *
 * Exported because the take-back path and the resume path both have to do it
 * and must agree: a queue can pass through the server more than once, and each
 * pass reports only what *that* job rejected.
 */
export function mergeCarriedFailures(
  existing: FailedTrackDetail[] | undefined,
  incoming: FailedTrackDetail[] | undefined,
  priorDropped = 0,
): { failures: FailedTrackDetail[]; dropped: number } {
  const all = [...validFailures(existing), ...validFailures(incoming)];
  const seen = new Set<string>();
  const unique: FailedTrackDetail[] = [];
  for (const f of all) {
    /*
      The same job's failures come back on every export, and a user may take
      back more than once, so an identical record arriving twice is ordinary
      rather than suspicious. Keyed on what the user reads, since that is what
      a repeat would duplicate on screen.
    */
    const key = `${f.artist}\u0000${f.track}\u0000${f.reason}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(f);
    }
  }
  const kept = unique.slice(0, MAX_LINEAGE_FAILURES);
  const dropped = (Number.isFinite(priorDropped) && priorDropped > 0 ? Math.floor(priorDropped) : 0)
    + (unique.length - kept.length);
  return { failures: kept, dropped };
}

/**
 * Writes the lineage, preserving the named failures the caller did not mention.
 *
 * Every other field here is one the caller recomputes in full, so a whole-record
 * write is the right shape for them. The failure list is not: it is accumulated
 * over the *whole chain of owners* and no caller that is updating a cursor or
 * starting a handover has any business restating it. Both such callers omitted
 * it and silently destroyed it, which is precisely the loss the list exists to
 * prevent — so the omission is read as "leave it alone" rather than "clear it".
 *
 * Clearing is available, deliberately and only, through `clearCarriedFailures`.
 */
export function setHandoffLineage(lineage: HandoffLineage): void {
  try {
    // Read raw rather than through `getHandoffLineage`, which refuses a record
    // whose totals are not numbers — a record this very function may be about
    // to give valid totals to. The failure list must survive that repair.
    const raw = window.localStorage.getItem(LINEAGE_STORAGE_KEY);
    const existing = raw ? JSON.parse(raw) : null;
    const stated = lineage.carriedFailures !== undefined;
    const failures = stated
      ? validFailures(lineage.carriedFailures)
      : validFailures(existing && existing.carriedFailures);
    const rawDropped = stated
      ? lineage.carriedFailuresDropped
      : (existing && existing.carriedFailuresDropped);
    const dropped = Number.isFinite(rawDropped) && Number(rawDropped) > 0
      ? Math.floor(Number(rawDropped))
      : 0;
    window.localStorage.setItem(LINEAGE_STORAGE_KEY, JSON.stringify({
      ...lineage,
      ...(failures.length > 0 ? { carriedFailures: failures } : {}),
      ...(dropped > 0 ? { carriedFailuresDropped: dropped } : {}),
    }));
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
    // Re-capping on read can itself drop ranges, so the stored floor is raised
    // by whatever that cost rather than trusted as-is.
    const capped = capRanges(parsed.reTagUsedRanges);
    return {
      originalTotalTracks: total,
      originalSucceededCount: succeeded,
      reTagCursorSec: Number.isFinite(parsed.reTagCursorSec) ? parsed.reTagCursorSec : 0,
      handedOverAtSec: Number.isFinite(parsed.handedOverAtSec) ? parsed.handedOverAtSec : 0,
      reTagUsedRanges: capped.ranges,
      reTagKnownFromSec: combineKnownFrom(parsed.reTagKnownFromSec, capped.droppedBelowSec),
      carriedFailures: validFailures(parsed.carriedFailures),
      carriedFailuresDropped: Number.isFinite(parsed.carriedFailuresDropped)
        && Number(parsed.carriedFailuresDropped) > 0
        ? Math.floor(Number(parsed.carriedFailuresDropped))
        : 0,
    };
  } catch {
    // Corrupt or unreadable. Cosmetic, so degrade rather than throw.
    return null;
  }
}

/**
 * Folds a newly returned set of named failures into the lineage.
 *
 * Called on the take-back path, which is the only moment the browser learns
 * what a job wrote off — and the last moment before that job is cancelled and
 * its record of them destroyed. Returns the merged list so the caller can put
 * the same set into the queue it is about to save.
 */
export function recordCarriedFailures(
  incoming: FailedTrackDetail[] | undefined,
): { failures: FailedTrackDetail[]; dropped: number } {
  const existing = getHandoffLineage();
  const merged = mergeCarriedFailures(
    existing ? existing.carriedFailures : [],
    incoming,
    existing ? existing.carriedFailuresDropped : 0,
  );
  if (merged.failures.length === 0 && merged.dropped === 0) {
    return merged;
  }
  try {
    const raw = window.localStorage.getItem(LINEAGE_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    window.localStorage.setItem(LINEAGE_STORAGE_KEY, JSON.stringify({
      // Defaulted rather than assumed: a lineage may not exist yet, and
      // `getHandoffLineage` refuses to read one whose totals are not numbers.
      originalTotalTracks: 0,
      originalSucceededCount: 0,
      ...(parsed && typeof parsed === 'object' ? parsed : {}),
      carriedFailures: merged.failures,
      carriedFailuresDropped: merged.dropped,
    }));
  } catch {
    /*
      Not fail-closed, deliberately. This list only ever *describes* plays that
      have already been written off; losing it costs the user a name, where
      refusing to continue would cost them the rest of their import.
    */
    trackError('background.recordCarriedFailures', new Error('lineage write failed'));
  }
  return merged;
}

/**
 * Drops the named failures a previous import left in the lineage.
 *
 * Unlike the rest of the lineage — which describes seconds on the account's
 * timeline and outlives any one import — this list is about a particular
 * selection's tracks, so a new selection is the point at which it stops being
 * true.
 */
export function clearCarriedFailures(): void {
  try {
    const raw = window.localStorage.getItem(LINEAGE_STORAGE_KEY);
    if (!raw) { return; }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') { return; }
    delete parsed.carriedFailures;
    delete parsed.carriedFailuresDropped;
    window.localStorage.setItem(LINEAGE_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // Cosmetic; a stale name shown against a new import is not a lost play.
  }
}

/**
 * Records the browser's own re-tag high-water mark somewhere that outlives the
 * import.
 *
 * The cursor used to live only in the Vuex store and the saved state, and both
 * of those end with the import: a completed run clears IndexedDB, and a reload
 * starts the store at zero. The next import then begins allocating from the
 * top of the six-hour window again — straight back over the seconds the
 * previous one just used. If the two selections share a track, Last.fm
 * discards the repeat while reporting it accepted, and the play is gone with
 * no error anywhere.
 *
 * The seconds it describes belong to the *account's* timeline, not to any one
 * import, so this is the right lifetime for it. It is bounded in time rather
 * than by import: once the cursor falls out of Last.fm's window it constrains
 * nothing, because nothing can be scrobbled there any more.
 *
 * Monotonic, and never lowered — a lower value would re-open seconds already
 * spent.
 */
export function recordReTagCursor(sec: number): void {
  if (!Number.isFinite(sec) || sec <= 0) { return; }
  try {
    const existing = getHandoffLineage();
    if (existing && (existing.reTagCursorSec || 0) >= sec) { return; }
    setHandoffLineage({
      originalTotalTracks: (existing && existing.originalTotalTracks) || 0,
      originalSucceededCount: (existing && existing.originalSucceededCount) || 0,
      handedOverAtSec: (existing && existing.handedOverAtSec) || 0,
      reTagUsedRanges: (existing && existing.reTagUsedRanges) || [],
      reTagKnownFromSec: (existing && existing.reTagKnownFromSec) || 0,
      reTagCursorSec: sec,
    });
  } catch {
    // Best effort. A lost cursor costs a possible collision, not a crash.
  }
}

/** The persisted high-water mark, or 0 when this browser has none. */
export function persistedReTagCursorSec(): number {
  const lineage = getHandoffLineage();
  return (lineage && lineage.reTagCursorSec) || 0;
}

/**
 * The second a send is *currently* riding on, written before the request
 * leaves and cleared once its track is done with.
 *
 * The saved queue already carries `pendingReTagTimestampSec`, but it only
 * reaches the disk on the next save — and the interval this exists for is
 * shorter than that. Between choosing a second and hearing an answer the tab
 * can be closed, and Last.fm may have stored the play regardless. A reload
 * that knows nothing about that second allocates a different one, and the
 * re-send lands beside the first as a phantom duplicate instead of being
 * deduplicated away.
 *
 * Separate from the queue because it has to be written *synchronously*, in the
 * moment between the choice and the request. It is deliberately not part of
 * `HandoffLineage`: that record is rewritten wholesale by several callers with
 * their own rules about what survives, and this must not inherit any of them.
 *
 * Bound to a track rather than a queue position. Positions are relative to
 * whatever remainder was last saved, so the same index names a different track
 * after a reload, and a second applied to the wrong track is a fresh collision
 * rather than the deduplication it exists to produce.
 */
export interface InFlightSecond {
  importId: string;
  trackKey: string;
  sec: number;
  /** When the record was written. Used only to order eviction. */
  at: number;
}

/**
 * A handful of records, not one.
 *
 * A single slot means the next queue to send overwrites the record an earlier
 * one's crash recovery depends on — and that earlier queue is exactly the one
 * that cannot be asked, because it is not running. Its play stays at Last.fm
 * under a second nothing remembers, and its resume invents another.
 *
 * Capped, because this is unbounded otherwise. Records are **not** expired on
 * a timer: an unresolved record is evidence about a play that may be sitting
 * at Last.fm, and this browser's clock is not entitled to decide that evidence
 * has gone stale. A clock that jumps forward — a correction, a resumed laptop,
 * a timezone-confused device — would otherwise hide a record written minutes
 * ago, after which the next allocation overwrites it for good and the play it
 * described is duplicated. Eviction is by insertion order instead, which needs
 * no clock at all; `at` is kept for diagnosis and is deliberately never read
 * as an ordering key.
 *
 * The cap is set far above anything reachable rather than merely above the one
 * queue a browser can hold on disk. Failing closed when it fills was
 * considered and rejected: records for abandoned imports are never cleaned up,
 * so a browser that had accumulated that many would have re-tagged scrobbling
 * permanently broken, which is worse than the eviction it prevents. But an
 * eviction still forgets a play, and each one forgets another — the damage is
 * bounded per record, not overall. A record is a few dozen bytes against a
 * multi-megabyte quota, so the honest response is to make eviction
 * unreachable in practice rather than to ration it: this many *concurrently
 * unresolved* imports in one browser does not happen.
 */
const IN_FLIGHT_MAX_RECORDS = 64;

function readJournal(): InFlightSecond[] {
  try {
    const raw = window.localStorage.getItem(IN_FLIGHT_STORAGE_KEY);
    if (!raw) { return []; }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) { return []; }
    return parsed.filter((r) => (
      r
      && typeof r.importId === 'string' && r.importId
      && typeof r.trackKey === 'string' && r.trackKey
      && Number.isFinite(Number(r.sec)) && Number(r.sec) > 0
    )).map((r) => ({
      importId: r.importId as string,
      trackKey: r.trackKey as string,
      sec: Number(r.sec),
      at: Number(r.at) || 0,
    }));
  } catch {
    return [];
  }
}

/**
 * A short, grouping-friendly name for a failed storage write, for telemetry.
 *
 * The browser's exception name where there is one (`QuotaExceededError`: the
 * storage is full; `SecurityError`: the browser refuses this site storage at
 * all), since that is the difference between "free some space" and "change a
 * setting". Never the message, which can quote the value being written.
 */
export function storageErrorName(e: unknown): string {
  try {
    const name = e && typeof (e as { name?: unknown }).name === 'string'
      ? (e as { name: string }).name
      : '';
    return name || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The outcome of a journal write. `failure` says why it can't be relied on:
 * `invalid_record` (nothing to bind it to), `not_persisted` (the browser
 * accepted the write and then stored nothing), or `storageErrorName`'s answer.
 */
export type InFlightWrite = { ok: true } | { ok: false; failure: string };

export function recordInFlightSecond(importId: string, trackKey: string, sec: number): InFlightWrite {
  /*
    An empty identity is refused rather than stored.

    Two id-less queues would both match `''`, and if their heads happened to
    share a key one could adopt the other's second — which is not a lost
    dedup but an invented collision. The caller is expected to have minted an
    identity by now; refusing here is what makes that a requirement rather
    than a hope.
  */
  if (!importId || !trackKey || !Number.isFinite(sec) || sec <= 0) {
    return { ok: false, failure: 'invalid_record' };
  }
  try {
    // Only this queue's own previous record is displaced: a queue has one send
    // in flight at a time, so its earlier second is either resolved or has
    // been superseded by this one.
    const kept = readJournal().filter((r) => r.importId !== importId);
    const record: InFlightSecond = {
      importId, trackKey, sec, at: Date.now(),
    };
    const next = [record, ...kept].slice(0, IN_FLIGHT_MAX_RECORDS);
    const encoded = JSON.stringify(next);
    window.localStorage.setItem(IN_FLIGHT_STORAGE_KEY, encoded);
    // Read back, because the caller is about to decide whether it is safe to
    // send on the strength of this. A quota failure that throws is caught
    // below; one that silently stores nothing is not, and private-mode
    // storage has historically done both.
    return window.localStorage.getItem(IN_FLIGHT_STORAGE_KEY) === encoded
      ? { ok: true }
      : { ok: false, failure: 'not_persisted' };
  } catch (e) {
    return { ok: false, failure: storageErrorName(e) };
  }
}

/**
 * The record this queue left behind, if any.
 *
 * Takes the identity rather than returning "whatever is there", because a
 * record belonging to another queue names a different play, and adopting it
 * would put this queue's next track under a second that queue may still be
 * waiting on.
 */
export function inFlightSecond(importId: string): InFlightSecond | null {
  if (!importId) { return null; }
  return readJournal().find((r) => r.importId === importId) || null;
}

/**
 * Forgets the record, but only when it is the caller's own.
 *
 * The store is origin-global while each record belongs to one queue, so an
 * unconditional clear lets any part of the app delete a second another queue's
 * send is riding on — after which a crash mid-send can no longer be recovered
 * from, and the retry invents a duplicate. The send lock keeps two *senders*
 * apart, but selecting a new import happens outside it.
 */
export function clearInFlightSecond(importId: string, trackKey: string): void {
  if (!importId || !trackKey) { return; }
  try {
    const existing = readJournal();
    const kept = existing.filter((r) => r.importId !== importId || r.trackKey !== trackKey);
    if (kept.length === existing.length) { return; }
    if (kept.length === 0) {
      window.localStorage.removeItem(IN_FLIGHT_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(IN_FLIGHT_STORAGE_KEY, JSON.stringify(kept));
  } catch {
    // Nothing to do.
  }
}

/**
 * The stable name a journalled second is bound to.
 *
 * Shared rather than duplicated: the send loop writes these keys and the
 * handoff reads them, and a key derived two slightly different ways is a key
 * that never matches — which fails silently, as a missing pin rather than an
 * error.
 */
export function journalTrackKey(artist: string, track: string, timestampMs: number): string {
  return `${artist}\u0000${track}\u0000${timestampMs}`;
}

export function clearHandoffLineage(
  keepRanges?: { from: number; to: number }[],
  keepKnownFromSec: unknown = 0,
): void {
  try {
    /*
      The re-tag history outlives the lineage that carried it.

      Every caller clears this because the queue has come *back* to the
      browser, which is precisely when it is about to allocate re-tags again —
      and the ranges are the only record of which seconds earlier cycles
      consumed. Dropping them would let the next reservation land on them, and
      Last.fm discards those plays without reporting an error.

      `keepRanges` lets a take-back hand in the seconds the *worker* used,
      which are not in the stored lineage — the job that owned them is about
      to be cancelled, so this is the last moment they can be recorded.

      The counts really are cosmetic and are dropped. The key goes only when
      there is nothing correctness-bearing left at all — which means no ranges
      *and* no floor. A job whose assigned-timestamp rows were all unreadable
      produces exactly that combination: no ranges, but a floor that says the
      seconds below it are unknown rather than free. Deleting on the range
      count alone would throw that away and let the next cycle treat an
      unknown history as an empty one.
    */
    const existing = getHandoffLineage();
    const capped = keepRanges
      ? capRanges(keepRanges)
      : capRanges(existing ? existing.reTagUsedRanges : []);
    const knownFrom = combineKnownFrom(
      keepRanges ? keepKnownFromSec : (existing && existing.reTagKnownFromSec),
      capped.droppedBelowSec,
    );
    // The cursor is not part of the lineage's cosmetic half and survives it
    // being cleared: it names seconds already written to the account's
    // timeline, which no take-back undoes.
    const cursor = (existing && existing.reTagCursorSec) || 0;
    /*
      Named failures survive too, and for a stronger reason than the cursor:
      they describe plays that were written off, the queue that could have
      re-listed them has been handed back and rebuilt, and no other copy
      exists anywhere. Clearing the lineage happens on exactly the path where
      that matters — the queue returning to the browser.
    */
    const failures = validFailures(existing && existing.carriedFailures);
    const failuresDropped = (existing && existing.carriedFailuresDropped) || 0;
    if (capped.ranges.length === 0 && knownFrom === 0 && cursor === 0
      && failures.length === 0 && failuresDropped === 0) {
      window.localStorage.removeItem(LINEAGE_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(LINEAGE_STORAGE_KEY, JSON.stringify({
      originalTotalTracks: 0,
      originalSucceededCount: 0,
      reTagUsedRanges: capped.ranges,
      reTagKnownFromSec: knownFrom,
      reTagCursorSec: cursor,
      ...(failures.length > 0 ? { carriedFailures: failures } : {}),
      ...(failuresDropped > 0 ? { carriedFailuresDropped: failuresDropped } : {}),
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
  /**
   * Identifies the handoff attempt that wrote a `freezing` record.
   *
   * Releasing is otherwise unconditional, and two tabs can be attempting a
   * handoff at once — the second one's freeze does not stop the first one's
   * *orchestration*, only its send loop. Whichever failed first would then
   * clear the other's freeze, unblocking every sibling in the middle of the
   * window the freeze exists to protect. Absent on `server` records, which are
   * never released speculatively.
   */
  attempt?: string;
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
      return {
        owner: parsed.owner,
        id: typeof parsed.id === 'string' ? parsed.id : '',
        ...(typeof parsed.attempt === 'string' ? { attempt: parsed.attempt } : {}),
      };
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

/** Identifies one handoff attempt, for the compare-and-clear below. */
export function newFreezeAttempt(): string {
  return `${Date.now()}.${Math.random().toString(36).slice(2)}`;
}

/**
 * How long a `freezing` record is assumed to belong to a tab still working.
 *
 * Covers the freeze wait plus a preflight, with room to spare. Beyond it the
 * attempting tab has either redirected — in which case the record names a
 * handoff and resolves against the server — or died.
 */
const FREEZE_ATTEMPT_FRESH_MS = 180000;

/**
 * Whether a `freezing` record may still belong to a tab that is mid-attempt.
 *
 * Startup reconciliation exists to clear freezes left by tabs that died, but
 * it runs in *every* tab, including one opened while another tab is partway
 * through a handover. Clearing that record would release every sibling into
 * exactly the window the freeze protects. The attempt token carries the
 * millisecond it was minted, so recency is decidable without extra state; a
 * fresh record is left alone and reconciled on a later load instead.
 *
 * Records written before attempt tokens existed have no timestamp and are
 * treated as stale, which is the behaviour they had.
 */
export function freezeAttemptIsFresh(record: QueueOwner, nowMs = Date.now()): boolean {
  if (!record.attempt) {
    return false;
  }
  const mintedAt = Number(record.attempt.split('.')[0]);
  if (!Number.isFinite(mintedAt)) {
    return false;
  }
  // A token from the future means a clock change; treated as fresh, since the
  // conservative reading of an unusable timestamp is "someone is working".
  return mintedAt > nowMs || nowMs - mintedAt < FREEZE_ATTEMPT_FRESH_MS;
}

/**
 * Clears ownership only if it is still exactly the record the caller examined.
 *
 * Every release here follows an `await` on a network round-trip, and the
 * record can change underneath it: a status request about an old job can be
 * in flight while another tab establishes a *new* freeze, and the reply —
 * "that job is finished" — is then true but no longer about the record being
 * cleared. Releasing on it lets every sibling resume into the middle of the
 * new handover.
 *
 * Comparing the whole identity rather than the id alone matters because the
 * two fields move independently: the same handoff id appears first under
 * `freezing` and then under `server`, and those are different situations.
 *
 * Returns whether the record was cleared.
 */
export function releaseQueueOwnerIfSame(expected: QueueOwner): boolean {
  const current = queueOwner();
  if (!current) {
    return false;
  }
  if (current.owner !== expected.owner || current.id !== expected.id
    || current.attempt !== expected.attempt) {
    return false;
  }
  setQueueOwner(null);
  return true;
}

/**
 * Releases ownership once a handoff is known not to be running.
 *
 * Same hazard as `releaseQueueOwner`, from the other side of the redirect: the
 * attempt token was minted in a page that no longer exists, so the match is on
 * the handoff instead. A `server` record is always ours to clear here — we have
 * just established that nothing is running — but a `freezing` record belonging
 * to another tab that is mid-attempt right now must survive, or clearing it
 * releases every sibling into the middle of that tab's window. A record naming
 * a different handoff is unambiguously someone else's; one naming no handoff
 * has not reached preflight yet, so recency is the only evidence available.
 *
 * Returns whether the record was cleared.
 */
export function releaseQueueOwnerIfUnclaimed(ownId: string): boolean {
  const current = queueOwner();
  if (!current) {
    return false;
  }
  if (current.owner === 'freezing' && current.id !== ownId
      && (current.id !== '' || freezeAttemptIsFresh(current))) {
    return false;
  }
  setQueueOwner(null);
  return true;
}

/**
 * The one coordination primitive the browser itself keeps honest.
 *
 * Every other mechanism here is advisory: a roster entry is a timestamp a tab
 * writes about itself, an acknowledgement is a message a tab chooses to send.
 * Both assume the sibling is running normally, and a backgrounded tab is not —
 * its timers are throttled to roughly once a minute, so its heartbeat goes
 * stale within `TAB_STALE_MS` while its send loop keeps issuing `fetch`es,
 * which are not throttled. That tab is invisible to the roster and still
 * scrobbling, which is precisely the tab a freeze must not step over.
 *
 * A lock has none of that. It is held by the browser on the tab's behalf, so
 * throttling cannot make it lapse, and it is released automatically if the tab
 * crashes — no liveness heuristic, no staleness window.
 */
const SEND_LOCK_NAME = 'scrobblify.sending';

type LockManagerLike = {
  request: (
    name: string,
    options: { mode: 'shared' | 'exclusive'; signal?: AbortSignal; ifAvailable?: boolean },
    body: (lock: unknown) => Promise<void>,
  ) => Promise<void>;
};

function lockManager(): LockManagerLike | null {
  try {
    const { locks } = navigator as unknown as { locks?: LockManagerLike };
    return locks && typeof locks.request === 'function' ? locks : null;
  } catch {
    return null;
  }
}

/** Nothing was taken, so nothing has to be given back. */
function noRelease(): void {
  // Intentionally empty.
}

/**
 * Held by a tab for as long as it is inside its send loop.
 *
 * Exclusive, not shared. Shared would have gated the freeze correctly while
 * leaving a duplicate source untouched: two tabs restoring the same saved
 * import and sending from it at once. They allocate synthetic seconds
 * independently, so their re-tagged plays collide — and Last.fm discards a
 * repeat of (artist, track, timestamp) while reporting it accepted. One sender
 * per origin removes that whole class, and costs nothing, because a second tab
 * scrobbling the same queue was never useful.
 *
 * Taken with `ifAvailable`, so a tab that loses the race is told immediately
 * rather than left waiting behind a loop that may run for weeks.
 *
 * Resolves to a release function, or null when another tab is already sending.
 * When the API is missing it resolves to a no-op release:
 * `canCoordinateTabs()` already refuses to offer the handoff in that browser,
 * and local scrobbling must carry on working exactly as it always did.
 */
export async function acquireSendLock(): Promise<(() => void) | null> {
  const locks = lockManager();
  if (!locks) {
    return noRelease;
  }
  return new Promise<(() => void) | null>((granted) => {
    let released = false;
    locks.request(
      SEND_LOCK_NAME,
      { mode: 'exclusive', ifAvailable: true },
      (lock) => {
        if (!lock) {
          // Another tab holds it. Reported rather than queued.
          granted(null);
          return Promise.resolve();
        }
        return new Promise<void>((done) => {
          granted(() => {
            if (released) { return; }
            released = true;
            done();
          });
        });
      },
    ).catch(() => {
      // Nothing to release, and nothing to gate: report success so the send
      // loop is never blocked by a coordination failure.
      granted(noRelease);
    });
  });
}

/** Exclusive holds, keyed by the attempt that took them. */
let sendExclusive: { attempt: string; release: () => void } | null = null;

/**
 * Waits until no tab is inside its send loop, and keeps it that way.
 *
 * The grant *is* the proof that every sibling released — there is no roster to
 * consult and no acknowledgement to time out. Requests for the shared mode
 * made while this one is pending queue *behind* it, so a tab that starts
 * scrobbling mid-freeze waits rather than slipping in.
 *
 * The hold is kept until `releaseQueueOwner`, which covers the snapshot and
 * the upload. A redirect ends it the moment the page unloads, which is the
 * right boundary: from there the durable ownership record is what stops
 * siblings, and it outlives any tab.
 *
 * Resolves false if the lock could not be taken within `timeoutMs`, which the
 * caller must treat as a refusal — a sibling that never let go is a sibling
 * that may still be sending.
 */
export async function acquireSendExclusive(
  attempt: string,
  timeoutMs: number,
): Promise<boolean> {
  const locks = lockManager();
  if (!locks) {
    // Unsupported browsers never reach here: `canCoordinateTabs()` withholds
    // the feature. Refuse rather than assume, so a future caller that forgets
    // that gate fails closed.
    return false;
  }
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  return new Promise<boolean>((settle) => {
    let decided = false;
    locks.request(
      SEND_LOCK_NAME,
      { mode: 'exclusive', signal: controller.signal },
      () => new Promise<void>((done) => {
        window.clearTimeout(timer);
        decided = true;
        let released = false;
        sendExclusive = {
          attempt,
          release: () => {
            if (released) { return; }
            released = true;
            done();
          },
        };
        settle(true);
      }),
    ).catch(() => {
      window.clearTimeout(timer);
      if (!decided) {
        settle(false);
      }
    });
  });
}

/**
 * Drops an exclusive hold, and only one this attempt owns.
 *
 * Same reasoning as the ownership record it travels with: releasing another
 * tab's hold would let siblings back into the middle of that tab's window.
 */
export function releaseSendExclusive(attempt: string): void {
  if (sendExclusive && sendExclusive.attempt === attempt) {
    const held = sendExclusive;
    sendExclusive = null;
    held.release();
  }
}

/**
 * Releases a freeze this attempt owns, and only one this attempt owns.
 *
 * Every failure path in a handoff has to lift the freeze — a freeze nobody
 * lifts leaves the user unable to scrobble anywhere, in any tab, until they
 * clear site data. But an unconditional release is worse than no release,
 * because by the time one attempt fails the record may belong to something
 * else:
 *
 *   - a *second* handoff attempt, in another tab, now mid-window; or
 *   - a `server` record, meaning a handoff already succeeded.
 *
 * Clearing either lets every sibling resume against a queue that is about to
 * be, or already is, in the worker's hands — the duplicate this protocol
 * exists to prevent. So the release matches on the attempt token and otherwise
 * leaves the record alone; whoever owns it will release it on its own failure
 * path, or it resolves through `hasLiveJob` on the next load.
 *
 * The exclusive hold goes with it. Dropping the record while still holding the
 * lock would leave every sibling unable to start a send loop with nothing
 * left to tell them why.
 *
 * Returns whether the record was actually cleared.
 */
export function releaseQueueOwner(attempt: string): boolean {
  releaseSendExclusive(attempt);
  const current = queueOwner();
  if (!current) {
    return false;
  }
  if (current.owner !== 'freezing' || current.attempt !== attempt) {
    return false;
  }
  setQueueOwner(null);
  return true;
}

/**
 * Whether an origin-wide stop can actually be made durable.
 *
 * A `BroadcastChannel` message only reaches contexts that are listening right
 * now. Without localStorage a tab opened later, or restored from the bfcache
 * after the message went out, reads the queue as unowned and scrobbles a queue
 * the worker is already sending. That is a silent duplicate generator, so the
 * feature is not offered at all rather than offered without a working stop.
 *
 * The Web Locks API is required for the same reason from the other direction:
 * without it a freeze cannot establish that no sibling is mid-send, only that
 * no sibling *said* it was, and a throttled background tab says nothing while
 * continuing to scrobble.
 */
export function canCoordinateTabs(): boolean {
  if (!lockManager()) {
    return false;
  }
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
 * Roster of tabs that have this origin open.
 *
 * Without it, "every sibling has stopped" is not an observable state: a
 * freezing tab could only wait a fixed period and hope. That is not good
 * enough here, because a sibling sitting in an in-flight Last.fm request —
 * which has no timeout and can run for tens of seconds — would not have
 * stopped or persisted when the window elapsed, and its tracks would be
 * captured into the upload and sent a second time by the worker.
 *
 * Each tab writes a heartbeat under its own id and removes itself on unload.
 * Entries older than `TAB_STALE_MS` are treated as gone, so a crashed or
 * force-closed tab cannot block a handoff forever.
 */
const TAB_ROSTER_KEY = 'scrobblify.background.tabs';
const TAB_HEARTBEAT_MS = 2000;
const TAB_STALE_MS = 8000;

/**
 * How long a freezing tab waits for its siblings to stop and persist.
 *
 * Only an upper bound now: the wait ends as soon as every rostered sibling has
 * answered. It is generous because the thing being waited for is an in-flight
 * Last.fm request, and abandoning that wait is what produces duplicates.
 */
const FREEZE_WAIT_MS = 45000;

/**
 * Pause between claiming the freeze and confirming the claim held.
 *
 * Long enough for a simultaneous write from another tab to have landed in
 * localStorage, short enough to be invisible. It does not need to cover the
 * other tab's whole attempt — only the gap between its write and ours.
 */
const FREEZE_CLAIM_SETTLE_MS = 150;

function readRoster(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(TAB_ROSTER_KEY);
    if (!raw) { return {}; }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeRoster(roster: Record<string, number>): void {
  try {
    window.localStorage.setItem(TAB_ROSTER_KEY, JSON.stringify(roster));
  } catch {
    // A tab that cannot register is a tab a freezing sibling cannot wait for.
    // `canCoordinateTabs()` gates the whole feature on localStorage working,
    // so this is the already-refused case rather than a new one.
  }
}

/** Rostered tabs other than this one that have checked in recently. */
function liveSiblings(selfId: string): string[] {
  const now = Date.now();
  return Object.entries(readRoster())
    .filter(([id, seen]) => id !== selfId && Number.isFinite(seen) && now - seen < TAB_STALE_MS)
    .map(([id]) => id);
}

let tabId = '';

/** This tab's roster identity, generated once. */
export function thisTabId(): string {
  if (!tabId) {
    tabId = `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
  }
  return tabId;
}

/**
 * Joins the roster and keeps this tab's heartbeat current.
 *
 * Returns a teardown function that removes this tab, so a normal close does
 * not leave a phantom sibling that every future handoff has to wait out.
 */
export function joinTabRoster(): () => void {
  const id = thisTabId();
  const beat = () => {
    const roster = readRoster();
    const now = Date.now();
    roster[id] = now;
    Object.keys(roster).forEach((k) => {
      if (now - roster[k] >= TAB_STALE_MS) {
        delete roster[k];
      }
    });
    writeRoster(roster);
  };
  beat();
  const timer = window.setInterval(beat, TAB_HEARTBEAT_MS);

  const leave = () => {
    const roster = readRoster();
    delete roster[id];
    writeRoster(roster);
  };
  window.addEventListener('pagehide', leave);

  return () => {
    window.clearInterval(timer);
    window.removeEventListener('pagehide', leave);
    leave();
  };
}

/**
 * Registers this tab as a participant in the freeze protocol.
 *
 * `onFreeze` must stop scrobbling *and persist progress* before it resolves —
 * the freezing tab re-reads the queue from IndexedDB afterwards, and anything
 * this tab sent but did not record would be uploaded and sent a second time.
 * It must resolve `false` if it could not stop, which aborts the handoff.
 *
 * Returns a teardown function.
 */
export function respondToFreezeRequests(onFreeze: () => Promise<boolean>): () => void {
  let channel: BroadcastChannel | null = null;
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(FREEZE_CHANNEL);
      channel.onmessage = async (event: MessageEvent) => {
        if (!event.data || event.data.type !== 'freeze') {
          return;
        }
        let stopped = false;
        try {
          stopped = await onFreeze();
        } catch (e) {
          trackError('background.freezeResponder', e);
          stopped = false;
        }
        try {
          const reply = new BroadcastChannel(FREEZE_CHANNEL);
          // Answered either way, and the answer is honest. A silent failure
          // would be indistinguishable from a tab that had closed, and the
          // freezing tab would proceed against a sibling that is still
          // sending.
          reply.postMessage({
            type: stopped ? 'frozen' : 'freeze_failed',
            id: event.data.id,
            tab: thisTabId(),
          });
          reply.close();
        } catch {
          // The freezing tab waits out its window and refuses on the missing
          // acknowledgement.
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
 * Returns whether every sibling that is actually open confirmed it had stopped
 * *and persisted*. A fixed wait was not enough: an in-flight Last.fm request
 * has no timeout, so a sibling can still be sending when any chosen window
 * elapses. The roster makes "everyone has answered" observable, and anything
 * short of a full set of acknowledgements is a refusal — proceeding while a
 * sibling may still be sending is the duplicate this whole protocol exists to
 * prevent.
 *
 * Callers must re-read the queue from IndexedDB afterwards regardless: a
 * sibling persists its progress before acking, and that progress is only
 * visible on disk.
 *
 * `attempt` identifies the caller so that only it can release the freeze, and
 * so that a second attempt running concurrently in another tab is refused
 * outright rather than allowed to interleave with this one.
 */
export async function freezeOtherTabs(attempt: string): Promise<boolean> {
  /*
    Mutual exclusion between handoff attempts.

    Freezing siblings stops their *send loops*; it does not stop another tab's
    handoff orchestration, which does not scrobble. So two tabs can reach here
    together, each freeze the other's loop, and both proceed to snapshot and
    upload the same queue — two jobs, every track sent twice.

    localStorage has no atomic compare-and-set, so this is the usual
    write-then-verify: refuse if someone else already holds it, claim it, let
    any simultaneous write land, then confirm the record is still ours. A tab
    that loses the race sees the winner's token and backs out.
  */
  const existing = queueOwner();
  if (existing && existing.attempt !== attempt) {
    return false;
  }
  setQueueOwner({ owner: 'freezing', id: '', attempt });
  await new Promise<void>((resolve) => { window.setTimeout(resolve, FREEZE_CLAIM_SETTLE_MS); });
  const claimed = queueOwner();
  if (!claimed || claimed.owner !== 'freezing' || claimed.attempt !== attempt) {
    return false;
  }

  const expected = new Set(liveSiblings(thisTabId()));
  if (expected.size === 0) {
    /*
      No sibling *that we can see*. That is not the same as no sibling: a
      backgrounded tab's heartbeat is throttled to about once a minute, so it
      goes stale inside `TAB_STALE_MS` while its send loop keeps issuing
      un-throttled `fetch`es. The roster reports it gone at exactly the moment
      it is most dangerous.

      So an empty roster still has to be proven, by taking the lock every
      sending tab holds. The grant is the proof; a timeout is a refusal.
    */
    return acquireSendExclusive(attempt, FREEZE_WAIT_MS);
  }

  const requestId = `${Date.now()}.${Math.random().toString(36).slice(2)}`;
  let channel: BroadcastChannel | null = null;
  let failed = false;
  const acked = new Set<string>();
  let settle: (() => void) | null = null;

  try {
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(FREEZE_CHANNEL);
      channel.onmessage = (event: MessageEvent) => {
        const { data } = event;
        if (!data || data.id !== requestId) {
          return;
        }
        if (data.type === 'freeze_failed') {
          failed = true;
          if (settle) { settle(); }
          return;
        }
        if (data.type === 'frozen' && typeof data.tab === 'string') {
          acked.add(data.tab);
          // A tab that joined after the roster was read still counts: it
          // answered, so it stopped.
          if (Array.from(expected).every((id) => acked.has(id)) && settle) {
            settle();
          }
        }
      };
      channel.postMessage({ type: 'freeze', id: requestId });
    }
  } catch {
    channel = null;
  }

  if (!channel) {
    // No way to ask, and siblings are known to exist. Refuse rather than
    // guess.
    return false;
  }

  await new Promise<void>((resolve) => {
    let done = false;
    let timer = 0;
    const finish = () => {
      if (done) { return; }
      done = true;
      window.clearTimeout(timer);
      resolve();
    };
    settle = finish;
    timer = window.setTimeout(finish, FREEZE_WAIT_MS);
  });
  channel.close();

  if (failed) {
    return false;
  }
  /*
    A sibling that never answered may simply have closed. Its roster entry is
    the only evidence either way, so it is re-read: an entry that has gone
    stale means the tab is gone, while a fresh one means it is open and did not
    stop.
  */
  const stillLive = new Set(liveSiblings(thisTabId()));
  if (!Array.from(expected).every((id) => acked.has(id) || !stillLive.has(id))) {
    return false;
  }

  /*
    The acknowledgements say every sibling stopped *and persisted*. The lock
    says no tab is inside a send loop at all — including one that never
    answered because it was throttled, and one that was opened after the
    roster was read. Both are needed: the ack carries the persistence
    guarantee, the lock carries the liveness one.
  */
  return acquireSendExclusive(attempt, FREEZE_WAIT_MS);
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

/**
 * How long a browser that never opted in to the beta waits for the authority
 * check before carrying on without it. Short because that browser falls
 * through to ordinary scrobbling on no answer, so the wait is the whole cost
 * of a worker outage for almost every user of the site.
 */
export const FALLTHROUGH_TIMEOUT_MS = 3000;

/** Wider than a status check: an export carries the whole remaining queue. */
const EXPORT_TIMEOUT_MS = 30000;

async function getWithTimeout(
  path: string,
  authorised: boolean,
  timeoutMs = STATUS_TIMEOUT_MS,
): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
 * Whether the server is running, or about to run, anything at all for this
 * Last.fm user. Tri-state: `null` means we could not find out.
 *
 * This is the only ownership question that survives losing local storage, and
 * it is deliberately keyed on the username rather than on a session token,
 * because a browser that has lost its session — or never had one, being a
 * different device or profile — is exactly the case that a local record cannot
 * answer for. Those browsers can still reach a saved import through IndexedDB
 * and scrobble it underneath a running job.
 *
 * Unauthenticated for the same reason. Re-establishing a session means a
 * Last.fm redirect, which is far too heavy to impose on every user at every
 * load just to learn that they have no job; the client asks this first and
 * only signs in when the answer is yes.
 *
 * The response carries a boolean and nothing else, so a `true` here cannot
 * render a status card — `fetchJob` does that, once the user has signed in.
 */
export async function liveJobForUsername(
  username: string,
  timeoutMs = STATUS_TIMEOUT_MS,
): Promise<boolean | null> {
  if (!isBackgroundConfigured() || !username.trim()) {
    return null;
  }
  try {
    const res = await getWithTimeout(
      `/scrobblify/job/live?username=${encodeURIComponent(username.trim())}`,
      false,
      timeoutMs,
    );
    if (!res || !res.ok) {
      return null;
    }
    const body = await res.json();
    // Only an explicit boolean counts. A malformed or partial body must not
    // read as "nothing is running", which is the answer that unblocks
    // scrobbling.
    if (typeof body.live !== 'boolean') {
      return null;
    }
    return body.live;
  } catch {
    return null;
  }
}

/**
 * What the server knows about one specific queue.
 *
 * `known` is the field that matters: it says this exact selection was handed
 * over at some point, by some device, whether or not anything is running now.
 */
export interface ImportStatus {
  known: boolean;
  live: boolean;
  state?: string;
  /** Contiguous terminal prefix the worker reached. Safe to skip; nothing else is. */
  cursor: number;
  scrobbledCount: number;
  totalTracks: number;
}

/**
 * Asks whether this queue has ever been handed to the background service.
 *
 * `liveJobForUsername` answers a question about the *user*, and a `false` from
 * it is weaker than it looks. A job that has completed — or stalled on
 * re-auth — clears `live_username`, so a browser still holding the same import
 * reads "nothing is running" as permission and replays everything the worker
 * already sent. Last.fm discards a repeat of (artist, track, timestamp)
 * silently while reporting it accepted, so those plays are simply lost.
 *
 * The import id is the credential here, which is why this needs no session:
 * only a browser that already holds the queue knows it.
 *
 * Returns null on any failure, and null is *not* permission — callers must
 * treat it the same way they treat an unresolved ownership check.
 */
export async function importStatus(
  importId: string,
  timeoutMs = STATUS_TIMEOUT_MS,
): Promise<ImportStatus | null> {
  if (!isBackgroundConfigured() || !importId) {
    return null;
  }
  try {
    const res = await getWithTimeout(
      `/scrobblify/import/${encodeURIComponent(importId)}`,
      false,
      timeoutMs,
    );
    if (!res || !res.ok) {
      return null;
    }
    const body = await res.json();
    // Only an explicit boolean counts, for the same reason as `live` above: a
    // malformed body must not read as "never handed over", which is the answer
    // that unblocks scrobbling.
    if (typeof body.known !== 'boolean') {
      return null;
    }
    return {
      known: body.known,
      live: body.live === true,
      state: typeof body.state === 'string' ? body.state : undefined,
      cursor: Number(body.cursor) || 0,
      scrobbledCount: Number(body.scrobbledCount) || 0,
      totalTracks: Number(body.totalTracks) || 0,
    };
  } catch {
    return null;
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
 *
 * `dormant` is deliberately absent. The job cannot send, but it still holds
 * the queue and can be reconnected, so a browser copy must stay blocked.
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
    reTagged: t.reTagged === true,
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
  importId = '',
): Promise<{ handoffId: string; authoriseUrl: string } | null> {
  // `isBackgroundEnabled`, not `isBackgroundConfigured`: this is where a new
  // handoff begins, and it is the only server call in the offer path that a
  // caller could reach without having gone through `probeBackgroundAvailability`.
  if (!isBackgroundEnabled()) {
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
        // What lets any device later ask whether *this queue* was handed over,
        // rather than only whether this user has something running now. The
        // worker drops it if it is missing or malformed rather than refusing
        // the handoff, so an older client still works.
        ...(importId ? { importId } : {}),
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
 * The job id a handoff produced, or an empty string if it has none yet.
 *
 * Kept separate from `isHandoffActive` so its two-valued answer stays simple.
 * The distinction matters because ownership records are later resolved with
 * `hasLiveJob(id)`, which compares the id against the *job* the server reports
 * — storing a handoff id there guarantees a permanent mismatch, and the
 * mismatch is deliberately read as "unknown", so the tab would stay blocked
 * for the thirty days a finished job is reported.
 */
export async function jobIdForHandoff(handoffId: string): Promise<string> {
  const res = await getWithTimeout(`/scrobblify/handoff/${handoffId}`, true);
  if (!res || !res.ok) {
    return '';
  }
  try {
    const body = await res.json();
    return typeof body.jobId === 'string' ? body.jobId : '';
  } catch {
    return '';
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

export async function jobAction(
  jobId: string,
  action: 'pause' | 'resume' | 'cancel',
  claim?: string,
): Promise<boolean> {
  try {
    // The claim is only meaningful for a cancel that follows this client's own
    // export; the server demands it to stop a second caller deleting the blobs
    // while an export is still reading them.
    const res = await request(`/scrobblify/job/${jobId}/${action}`, {
      method: 'POST',
      ...(claim ? { body: JSON.stringify({ claim }) } : {}),
    });
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
export async function exportJob(jobId: string, claim: string): Promise<any | null> {
  // An export is retried in a loop behind a spinner, so an unbounded request
  // does not merely delay one attempt — it stalls the whole retry budget and
  // the user waits forever. The window is wider than `STATUS_TIMEOUT_MS`
  // because an export carries the whole remaining queue.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS);
  try {
    // The claim identifies this take-back. The server allows a retry only from
    // the tab that made the original claim; without it, two tabs could read
    // the queue at once and one could cancel — deleting the blobs — while the
    // other was still reading.
    const res = await request(`/scrobblify/job/${jobId}/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ claim }),
      signal: controller.signal,
    });
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
 * A fresh export claim token.
 *
 * One per take-back, held for the life of the retry loop so every retry
 * presents the same value.
 */
export function newExportClaim(): string {
  const bytes = new Uint8Array(16);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
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
