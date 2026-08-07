/**
 * Orchestrates handing a scrobble queue over to the background worker.
 *
 * The flow crosses a full-page redirect through Last.fm, so it cannot be a
 * single function. It is split into `beginHandoff` (before the redirect) and
 * `completeHandoff` (after it), with IndexedDB carrying the queue across.
 *
 * The ordering of side effects is the whole safety argument:
 *
 *   1. persist the queue locally
 *   2. preflight (server commits to the digest)
 *   3. redirect
 *   4. upload chunks
 *   5. finalise — the job becomes the owner of these tracks here, and only here
 *   6. *now* clear local state
 *
 * Clearing local state any earlier turns an upload failure into permanent data
 * loss, because the browser is the only place these tracks exist.
 */
import Scrobble from '@/models/Scrobble';
import StateManager, { ScrobbleState } from '@/services/StateManager';
import { trackEvent, trackError } from '@/services/Analytics';
import * as api from '@/services/BackgroundScrobbling';
import type { UploadTrack, HandoffOutcome } from '@/services/BackgroundScrobbling';

/**
 * Last.fm accepts scrobbles up to 14 days old. Ordering uses 13 to match the
 * worker's `WINDOW_SECONDS`, so both ends agree about which tracks still have
 * a real timestamp worth preserving.
 */
const WINDOW_SECONDS = 13 * 86400;

/**
 * Runway reserved for the browser's re-tag allocator below the server's range.
 * Matches `RETAG_BACKFILL_SECONDS` in `ScrobbleStep`, which is what the
 * allocator uses when it has the window to itself.
 */
const RETAG_BACKFILL_SECONDS = 6 * 60 * 60;

/**
 * How far back a re-tagged scrobble may be placed at all. Same 13-day bound as
 * `WINDOW_SECONDS`; named separately because it bounds the *reserved range*
 * rather than the preserve-or-restamp decision.
 */
const RETAG_WINDOW_LIMIT_SECONDS = WINDOW_SECONDS;

/**
 * Converts one `Scrobble` into the worker's wire format.
 *
 * A re-tagged track's `timestamp` is not a listen time — it is a placeholder
 * the client invented so the plays would land somewhere. Forwarding it would
 * make the worker "preserve" a fabricated date, and worse, that date expires:
 * a job that runs for five weeks would start getting ignore code 3 on tracks
 * whose placeholder had aged out. Sending 0 tells the worker to stamp them
 * against the clock at send time, which is always in-window.
 */
export function toUploadTrack(scrobble: Scrobble): UploadTrack {
  const originalTimestampSec = scrobble.reTagged
    ? 0
    : Math.floor(scrobble.timestamp.getTime() / 1000);
  return {
    artist: scrobble.artist,
    track: scrobble.track,
    album: scrobble.album || undefined,
    originalTimestampSec: Number.isFinite(originalTimestampSec) && originalTimestampSec > 0
      ? originalTimestampSec
      : 0,
  };
}

/**
 * Orders the queue earliest-deadline-first.
 *
 * A track played today has ~14 days of slack before its timestamp becomes
 * unscrobbleable; one played 13 days ago has a day. Sending recent tracks
 * first spends the slack of the tracks that need it least and lets the
 * nearly-expired ones expire, so the sort key is the deadline, not recency.
 *
 * Tracks already outside the window keep chronological order — there is
 * nothing left to preserve, so relative order is the only thing left to get
 * right.
 */
export function orderForDeadline(tracks: UploadTrack[], nowSec: number): UploadTrack[] {
  const inWindow: UploadTrack[] = [];
  const outOfWindow: UploadTrack[] = [];
  tracks.forEach((t) => {
    const usable = t.originalTimestampSec > 0
      && t.originalTimestampSec < nowSec
      && t.originalTimestampSec >= nowSec - WINDOW_SECONDS;
    (usable ? inWindow : outOfWindow).push(t);
  });
  inWindow.sort((a, b) => a.originalTimestampSec - b.originalTimestampSec);
  return inWindow.concat(outOfWindow);
}

/**
 * The exact list that will be uploaded, derived from a saved state.
 *
 * This must be a pure function of `ScrobbleState`, because the digest is
 * computed before the redirect and the bytes are produced after it, from a
 * state reloaded out of IndexedDB. If the two derivations could differ, the
 * digest the server committed to would not describe what it received.
 *
 * `nowSec` is passed in rather than read from the clock so the caller can pin
 * it; see `HANDOFF_ORDER_EPOCH` on the saved state.
 */
export function uploadListFromState(state: ScrobbleState, nowSec: number): UploadTrack[] {
  const all = StateManager.deserializeScrobbles(state.tracks);
  const completed = new Set(state.completedIndices);
  const failed = new Set(state.failedIndices);
  const remaining = all.filter((_, i) => !completed.has(i) && !failed.has(i));
  return orderForDeadline(remaining.map(toUploadTrack), nowSec);
}

export interface BeginResult {
  ok: boolean;
  reason?: string;
}

/**
 * Everything up to and including the redirect.
 *
 * Returns only on failure: on success the tab navigates away.
 */
export async function beginHandoff(
  stateManager: StateManager,
  state: ScrobbleState,
  username: string,
  entryPoint: string,
): Promise<BeginResult> {
  const capacity = await api.fetchCapacity();
  if (!capacity || !capacity.available) {
    return { ok: false, reason: capacity ? 'at_capacity' : 'unavailable' };
  }

  // Pinned so the post-redirect derivation reproduces this exact ordering.
  // Without it the sort key would be re-evaluated minutes later against a
  // moved clock, and a track sitting on the window boundary could change
  // queues — producing different bytes than the digest we just committed to.
  const orderEpoch = Math.floor(Date.now() / 1000);
  const tracks = uploadListFromState(state, orderEpoch);

  if (tracks.length < capacity.minTracks) {
    return { ok: false, reason: 'too_small' };
  }
  if (tracks.length > capacity.maxTracks) {
    return { ok: false, reason: 'too_large' };
  }

  // Persisted *first*. If the tab dies between here and the upload, the queue
  // is still on disk and the user resumes locally as they always could.
  try {
    await stateManager.saveState({ ...state, handoffOrderEpoch: orderEpoch });
  } catch (e) {
    trackError('background.persistBeforeHandoff', e);
    return { ok: false, reason: 'save_failed' };
  }

  const pre = await api.preflight(username, tracks, capacity.chunkTracks);
  if (!pre) {
    return { ok: false, reason: 'preflight_failed' };
  }

  trackEvent('background_handoff_started', {
    entry_point: entryPoint,
    track_count: tracks.length,
  });

  window.location.href = pre.authoriseUrl;
  return { ok: true };
}

export interface CompleteResult {
  outcome: HandoffOutcome;
  /**
   * False when the client must not resume scrobbling these tracks — either the
   * worker owns them now, or we cannot prove that it doesn't.
   */
  safeToResumeLocally: boolean;
}

/**
 * Everything after the redirect: upload, finalise, and only then clean up.
 */
export async function completeHandoff(
  stateManager: StateManager,
  handoffId: string,
  onProgress?: (uploaded: number, total: number) => void,
): Promise<CompleteResult> {
  const state = await stateManager.loadState();
  if (!state) {
    // The queue is gone but the handoff exists, so we cannot upload and cannot
    // prove the job is inactive either. Ask the server rather than guess.
    const active = await api.isHandoffActive(handoffId);
    return {
      outcome: active ? { status: 'active', jobId: handoffId } : { status: 'unknown', handoffId },
      safeToResumeLocally: false,
    };
  }

  const capacity = await api.fetchCapacity();
  const chunkTracks = capacity ? capacity.chunkTracks : 1000;
  const orderEpoch = state.handoffOrderEpoch || Math.floor(Date.now() / 1000);
  const tracks = uploadListFromState(state, orderEpoch);

  const outcome = await api.uploadAndFinalize(handoffId, tracks, chunkTracks, onProgress);

  if (outcome.status === 'active') {
    // The worker owns these tracks now. Local state must go, or the next visit
    // offers a "Resume" that would scrobble everything a second time.
    //
    // Announced origin-wide *before* the clear, because other tabs are holding
    // this queue in memory and clearing IndexedDB says nothing to them.
    api.setServerOwnsQueue(true);
    try {
      await stateManager.clearState();
    } catch (e) {
      // The clear failing is not cosmetic: the queue is still on disk and a
      // reload would offer to resume it alongside the running job. Record the
      // uncertainty durably so startup refuses rather than offers.
      trackError('background.clearAfterHandoff', e);
      api.setOwnershipUnresolved('handoff', handoffId);
    }
    api.clearPendingHandoff();
    trackEvent('background_handoff_completed', { track_count: tracks.length });
    return { outcome, safeToResumeLocally: false };
  }

  if (outcome.status === 'failed') {
    api.clearPendingHandoff();
    trackEvent('background_handoff_failed', { reason: outcome.reason });
    return { outcome, safeToResumeLocally: true };
  }

  // `unknown`: one more question to the server before deciding.
  const active = await api.isHandoffActive(handoffId);
  if (active === false) {
    api.clearPendingHandoff();
    trackEvent('background_handoff_failed', { reason: 'finalize_lost_but_inactive' });
    return { outcome: { status: 'failed', reason: 'finalize failed' }, safeToResumeLocally: true };
  }
  if (active === true) {
    api.setServerOwnsQueue(true);
    try {
      await stateManager.clearState();
    } catch (e) {
      trackError('background.clearAfterHandoff', e);
      api.setOwnershipUnresolved('handoff', handoffId);
    }
    api.clearPendingHandoff();
    trackEvent('background_handoff_completed', { track_count: tracks.length, recovered: true });
    return { outcome: { status: 'active', jobId: handoffId }, safeToResumeLocally: false };
  }

  // Still unknown. Refusing to resume is the conservative choice: duplicates
  // are irreversible from the user's side at this scale, whereas a stalled
  // import can be retried the moment the server answers.
  //
  // Recorded durably because the recovery we ask for is a reload, and
  // component state does not survive one. Other tabs are stopped too: an
  // unknown outcome may well be a live job, and a stopped tab is recoverable
  // where a duplicated import is not.
  api.setServerOwnsQueue(true);
  api.setOwnershipUnresolved('handoff', handoffId);
  trackEvent('background_handoff_unresolved');
  return { outcome, safeToResumeLocally: false };
}

/**
 * Rebuilds a local `ScrobbleState` from a job export.
 *
 * The server deliberately returns only tracks and counts, not a `ScrobbleState`.
 * The saved-file format is the *client's*, and it has already been extended
 * twice; a worker that emitted it directly would silently become a second
 * implementation of it, free to drift. So the client assembles the shape here,
 * and a missing or renamed server field can only ever produce a conservative
 * default rather than a structurally invalid save.
 *
 * Everything the server cannot know is reconstructed conservatively: the
 * rate-limit window starts empty (the server's sends were made from a different
 * IP, and the browser's own budget has had days to recover), while the re-tag
 * allocator resumes *above* every second the server can have used.
 */
export function stateFromExport(
  exported: any,
  username: string,
  fallbackOriginalTotal: number,
): ScrobbleState | null {
  const raw = exported && exported.state ? exported.state : null;
  const tracks = raw && Array.isArray(raw.tracks) ? raw.tracks : null;
  if (!tracks || tracks.length === 0) {
    return null;
  }

  const serialized = tracks.map((t: any) => ({
    track: String(t.track ?? ''),
    artist: String(t.artist ?? ''),
    album: String(t.album ?? ''),
    timestamp: Number.isFinite(t.timestamp) && t.timestamp > 0 ? t.timestamp : Date.now(),
    /*
      Explicit, never inferred. StateManager only guesses `reTagged` when the
      flag is absent *and* the timestamps look collapsed; a re-tagged queue
      coming back from the server has neither property, so an omission here
      would resume as a queue of real dates that Last.fm rejects as too old.
    */
    reTagged: !!t.reTagged,
  }));

  const scrobbledByServer = Number.isFinite(exported.scrobbledByServer)
    ? exported.scrobbledByServer
    : 0;

  /*
    The browser's re-tag allocator and the server's run in opposite
    directions. The server marches synthetic seconds *downwards* from just
    below its clock; the browser marches *upwards*. A browser that resumed with
    its usual `(now - 6h, now]` window would therefore walk straight through
    the seconds the server just used, and Last.fm silently discards a repeat of
    (artist, track, timestamp) while still reporting it accepted — so a
    repeated song would vanish with no error anywhere.

    `syntheticFloorSec` is the lowest second the server used. Reserving the six
    hours immediately below it gives the browser a range that is both disjoint
    from the server's and as roomy as the one it normally gets.

    Seeding the high-water mark to the server's clock instead — the obvious
    move — would be worse than doing nothing: it starts the cursor at `now`,
    where the `min(nowSec, …)` clamp pins every subsequent track to the same
    second and collides repeats deliberately.
  */
  const nowSec = Math.floor(Date.now() / 1000);
  const lineage = api.getHandoffLineage();
  const priorTotal = lineage ? lineage.originalTotalTracks : 0;
  const priorSucceeded = lineage ? lineage.originalSucceededCount : 0;

  const serverFloor = Number.isFinite(exported.syntheticFloorSec) && exported.syntheticFloorSec > 0
    ? exported.syntheticFloorSec
    : 0;

  /*
    The reservation has to clear *two* used ranges, not one.

    The server's is bounded below by `syntheticFloorSec`. This browser's own
    earlier band is invisible to the server, though, and it sits wherever the
    six hours before the handoff were — so a reservation derived from the
    server's floor alone can land straight back on seconds this browser
    already used. Last.fm discards those exactly as silently.

    So the reservation is placed below the lower of the two, and the browser's
    band is bounded conservatively: it can never have started earlier than six
    hours before the handoff.
  */
  const browserBandStart = lineage && lineage.handedOverAtSec
    ? lineage.handedOverAtSec - RETAG_BACKFILL_SECONDS
    : 0;
  const usedFrom = [serverFloor, browserBandStart].filter((v) => v > 0);
  const lowestUsed = usedFrom.length ? Math.min(...usedFrom) : 0;

  const reservedCeiling = lowestUsed ? lowestUsed - 1 : 0;
  const reservedFloor = reservedCeiling ? reservedCeiling - RETAG_BACKFILL_SECONDS : 0;
  // Only usable if the whole reserved range is still inside Last.fm's window;
  // a long-running job can push its floor close enough to the limit that there
  // is no room beneath it, and an out-of-window timestamp is rejected outright.
  const reservedUsable = reservedFloor > nowSec - RETAG_WINDOW_LIMIT_SECONDS;

  return {
    userName: username,
    totalTracks: serialized.length,
    completedIndices: [],
    failedIndices: [],
    tracks: serialized,
    originalTotalTracks: Math.max(
      fallbackOriginalTotal,
      priorTotal,
      serialized.length + priorSucceeded + scrobbledByServer,
    ),
    originalSucceededCount: priorSucceeded + scrobbledByServer,
    sendTimestamps: [],
    lastReTagTimestampSec: 0,
    ...(reservedUsable
      ? { reTagFloorSec: reservedFloor, reTagCeilingSec: reservedCeiling }
      : {}),
    burstCount: 0,
    dailyCount: 0,
    dailyCountDate: new Date().toISOString().slice(0, 10),
    savedAt: new Date().toISOString(),
  };
}
