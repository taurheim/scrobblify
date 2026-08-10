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
import StateManager, { ScrobbleState, FailedTrackDetail } from '@/services/StateManager';
import { trackEvent, trackError } from '@/services/Analytics';
import * as api from '@/services/BackgroundScrobbling';
import type { UploadTrack, HandoffOutcome } from '@/services/BackgroundScrobbling';
import { findFreeRange } from '@/shared/lastfm/retagRanges';

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
 * How long a second stays capable of colliding — 14 days, the full Last.fm
 * window — is deliberately *not* a question this file answers.
 *
 * Whether a pin is still live is a question about the present, and the
 * browser's clock is the one clock in the system nobody can trust: a machine
 * whose time has slipped would discard a second that is still collidable and
 * invent a fresh one for a track the worker may already have sent. The worker
 * re-asks it against its own clock at send time (`isPinUsable`), so a pin
 * travels unconditionally in both directions and is judged where the judging
 * is reliable. That also leaves `uploadListFromState` free of the clock
 * entirely, which the pre-redirect digest depends on.
 */

/**
 * Headroom left below the present. Matches the worker's own margin, so a
 * reservation cannot start so close to now that a slow send lands in the
 * future — which Last.fm rejects as ignore code 4.
 */
const PRESENT_MARGIN_SECONDS = 120;

// Re-exported so existing call sites and tests keep their import path.
export { findFreeRange };

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
    // Stated rather than left to be inferred from the zero above, because a
    // pinned retry second breaks that inference. See `UploadTrack.reTagged`.
    reTagged: !!scrobble.reTagged,
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
  const uploads = remaining.map(toUploadTrack);
  /*
    The head track may already be at Last.fm.

    A re-tagged send whose response was lost leaves the browser holding the
    exact second it used, and the whole point of keeping that second is that
    the retry must repeat the identical `(artist, track, timestamp)` tuple —
    Last.fm discards an identical repeat, but stores a *different* second as a
    second play the user never listened to.

    Handing the queue to the worker is a retry by another name, and the worker
    would otherwise be told to invent its own second for that track, since
    re-tagged tracks upload with `originalTimestampSec: 0`. Pinning it here is
    what carries the idempotency across the handover.

    Only while the second is still inside the window: an expired one would be
    rejected outright, and a visible rejection of one track is worse than
    letting the worker place it afresh when the original can no longer collide.
  */
  const pending = state.pendingReTagTimestampSec || 0;
  const pinned = pending > 0 && uploads.length > 0 && remaining[0].reTagged;
  if (pinned) {
    uploads[0] = { ...uploads[0], originalTimestampSec: pending };
    /*
      Sent first, ahead of the deadline order.

      Every other track is ordered by when its own timestamp expires. This one
      is ordered by when an *idempotency guarantee* expires, and that is a
      different and much nearer deadline: the pin is only worth anything while
      Last.fm would still recognise the repeat. `orderForDeadline` would read
      a 13-day-old pin as out-of-window and bury it behind the entire queue,
      which on a large job is days — long enough for the second to age out and
      the retry to become a phantom instead of a no-op.
    */
    return [uploads[0], ...orderForDeadline(uploads.slice(1), nowSec)];
  }
  return orderForDeadline(uploads, nowSec);
}

/**
 * Fills in a pending second the send loop journalled but never got to save.
 *
 * The journal exists because the queue on disk lags the send: a tab closed
 * between choosing a second and hearing an answer leaves a play Last.fm may
 * have stored, recorded nowhere but there. Resuming locally adopts it at the
 * top of the send loop — but a handover does not go through the send loop. It
 * takes the saved state directly, so without this the worker is told to invent
 * its own second for a track that may already be sitting under one, and the
 * two land side by side on a public profile.
 *
 * Applied before `uploadListFromState` *and* saved, because the upload bytes
 * are re-derived after the redirect from the reloaded state and both
 * derivations have to produce the digest the server committed to.
 *
 * Adopted only when the identity and the head track both match: the key is
 * origin-global, so a record left by a different queue names a different play.
 */
export function adoptJournalledSecond(state: ScrobbleState): ScrobbleState {
  // A second already on the queue is authoritative; the journal only ever
  // fills a gap.
  if (state.pendingReTagTimestampSec) { return state; }
  if (!state.importId) { return state; }
  const journal = api.inFlightSecond(state.importId);
  if (!journal) { return state; }
  let head: Scrobble | undefined;
  try {
    const all = StateManager.deserializeScrobbles(state.tracks);
    const completed = new Set(state.completedIndices);
    const failed = new Set(state.failedIndices);
    head = all.filter((_, i) => !completed.has(i) && !failed.has(i)).shift();
  } catch (e) {
    trackError('background.adoptJournalledSecond', e);
    return state;
  }
  if (!head || !head.reTagged) { return state; }
  const key = api.journalTrackKey(head.artist, head.track, head.timestamp.getTime());
  if (key !== journal.trackKey) { return state; }
  trackEvent('background_handoff_adopted_pin');
  return { ...state, pendingReTagTimestampSec: journal.sec };
}

export interface BeginResult {
  ok: boolean;
  reason?: string;
  /**
   * The identity the queue on disk now carries, when this call minted one.
   *
   * Returned so the caller can mirror it into the store: `buildState` reads
   * the store, so a later save from a tab that never learned about the mint
   * would write the queue back without it and undo the guarantee.
   */
  importId?: string;
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

  /*
    Every other tab is stopped *before* the queue is read, and the queue is
    then re-read from disk.

    Both halves matter. Freezing after the snapshot leaves a sibling free to
    scrobble tracks that the snapshot still lists as pending, which the worker
    then sends again. Re-reading is what incorporates the progress a sibling
    persisted while stopping — that progress exists only on disk, never in the
    `state` this was called with.

    From here on, every failure path must release the freeze, or the user is
    left unable to scrobble anywhere.
  */
  const attempt = api.newFreezeAttempt();
  const frozen = await api.freezeOtherTabs(attempt);
  if (!frozen) {
    /*
      A sibling is open and did not confirm it had stopped. Proceeding would
      upload a queue it is still sending from, and the worker would send those
      tracks again — invisibly, because Last.fm discards a repeated
      (artist, track, timestamp) while reporting it accepted.

      The release is conditional: the refusal may itself be because another
      tab's attempt holds the freeze, and clearing that one would release every
      sibling into the middle of its window.
    */
    api.releaseQueueOwner(attempt);
    trackEvent('background_handoff_freeze_failed');
    return { ok: false, reason: 'tabs_not_frozen' };
  }
  let frozenState = state;
  try {
    const reloaded = await stateManager.loadState();
    if (reloaded) {
      frozenState = reloaded;
    }
  } catch (e) {
    // Reading back is what makes a sibling's progress visible. Without it we
    // would upload tracks that may already have been sent.
    trackError('background.reloadAfterFreeze', e);
    api.releaseQueueOwner(attempt);
    return { ok: false, reason: 'reload_failed' };
  }

  /*
    An identity is minted here when the queue has none.

    Selection is where one is normally minted, but a queue restored from a
    progress file written before identities existed arrives without one — and
    it is exactly as capable of being handed over as any other. Handing it over
    id-less leaves nothing that can later answer "was this import given away",
    so a stale copy of it reads silence as permission and replays every track
    the worker sent. Minting before the upload is what makes the answer exist.
  */
  const importId = frozenState.importId || StateManager.newImportId();
  /*
    Done before the tracks are derived, not after.

    A second the send loop journalled but never saved has to be inside both the
    uploaded list and the state that is written to disk — the list is
    re-derived post-redirect from that state, and the two derivations must
    produce identical bytes for the digest to describe what the server got.
  */
  frozenState = adoptJournalledSecond({ ...frozenState, importId });

  // Pinned so the post-redirect derivation reproduces this exact ordering.
  // Without it the sort key would be re-evaluated minutes later against a
  // moved clock, and a track sitting on the window boundary could change
  // queues — producing different bytes than the digest we just committed to.
  const orderEpoch = Math.floor(Date.now() / 1000);
  const tracks = uploadListFromState(frozenState, orderEpoch);

  if (tracks.length < capacity.minTracks) {
    api.releaseQueueOwner(attempt);
    return { ok: false, reason: 'too_small' };
  }
  if (tracks.length > capacity.maxTracks) {
    api.releaseQueueOwner(attempt);
    return { ok: false, reason: 'too_large' };
  }

  // Persisted *first*. If the tab dies between here and the upload, the queue
  // is still on disk and the user resumes locally as they always could.
  try {
    await stateManager.saveState({ ...frozenState, handoffOrderEpoch: orderEpoch, importId });
  } catch (e) {
    trackError('background.persistBeforeHandoff', e);
    api.releaseQueueOwner(attempt);
    return { ok: false, reason: 'save_failed' };
  }

  const pre = await api.preflight(username, tracks, capacity.chunkTracks, importId);
  if (!pre) {
    api.releaseQueueOwner(attempt);
    return { ok: false, reason: 'preflight_failed', importId };
  }

  // The freeze now names the handoff it is holding for, so a tab that finds a
  // stale record has something to resolve it against.
  api.setQueueOwner({ owner: 'freezing', id: pre.handoffId, attempt });

  trackEvent('background_handoff_started', {
    entry_point: entryPoint,
    track_count: tracks.length,
  });

  window.location.href = pre.authoriseUrl;
  return { ok: true, importId };
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
    // Either answer other than a definitive "no" leaves the queue owned
    // elsewhere, and a sibling tab that still holds it in memory has to be
    // told. This branch previously fell through without announcing anything.
    if (active !== false) {
      api.setQueueOwner({ owner: 'server', id: handoffId });
    } else {
      api.releaseQueueOwnerIfUnclaimed(handoffId);
    }
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
    // The freeze becomes an ownership record naming the job, so a later visit
    // can reconcile it against terminal job status rather than being blocked
    // by a flag nothing ever clears.
    api.setQueueOwner({ owner: 'server', id: outcome.jobId });
    try {
      await stateManager.clearState();
    } catch (e) {
      // The clear failing is not cosmetic: the queue is still on disk and a
      // reload would offer to resume it alongside the running job. Record the
      // uncertainty durably so startup refuses rather than offers.
      trackError('background.clearAfterHandoff', e);
      api.setOwnershipUnresolved('job', outcome.jobId);
    }
    api.clearPendingHandoff();
    trackEvent('background_handoff_completed', { track_count: tracks.length });
    return { outcome, safeToResumeLocally: false };
  }

  if (outcome.status === 'failed') {
    // Nothing is running anywhere, so the freeze must lift or every tab is
    // left unable to scrobble a queue that is entirely theirs.
    api.releaseQueueOwnerIfUnclaimed(handoffId);
    api.clearPendingHandoff();
    trackEvent('background_handoff_failed', { reason: outcome.reason });
    return { outcome, safeToResumeLocally: true };
  }

  // `unknown`: one more question to the server before deciding.
  const active = await api.isHandoffActive(handoffId);
  if (active === false) {
    api.releaseQueueOwnerIfUnclaimed(handoffId);
    api.clearPendingHandoff();
    trackEvent('background_handoff_failed', { reason: 'finalize_lost_but_inactive' });
    return { outcome: { status: 'failed', reason: 'finalize failed' }, safeToResumeLocally: true };
  }
  if (active === true) {
    /*
      Ownership is recorded against the *job*, not the handoff. `hasLiveJob`
      compares the stored id against the job the server reports, and a handoff
      id can never match one — the mismatch reads as "unknown", which would
      keep this tab blocked for the whole thirty days a finished job stays
      visible. An empty id degrades to "any live job", which is the old
      behaviour and still safe.
    */
    const jobId = await api.jobIdForHandoff(handoffId);
    api.setQueueOwner({ owner: 'server', id: jobId });
    try {
      await stateManager.clearState();
    } catch (e) {
      trackError('background.clearAfterHandoff', e);
      api.setOwnershipUnresolved(jobId ? 'job' : 'handoff', jobId || handoffId);
    }
    api.clearPendingHandoff();
    trackEvent('background_handoff_completed', { track_count: tracks.length, recovered: true });
    return { outcome: { status: 'active', jobId: jobId || handoffId }, safeToResumeLocally: false };
  }

  // Still unknown. Refusing to resume is the conservative choice: duplicates
  // are irreversible from the user's side at this scale, whereas a stalled
  // import can be retried the moment the server answers.
  //
  // Recorded durably because the recovery we ask for is a reload, and
  // component state does not survive one. Other tabs stay stopped too: an
  // unknown outcome may well be a live job, and a stopped tab is recoverable
  // where a duplicated import is not.
  //
  // The id here stays empty rather than being the handoff id: an unresolved
  // handoff has no job to name, and an id that can never match reads as
  // permanently unknown. The `handoff` marker alongside is what actually
  // resolves this case.
  api.setQueueOwner({ owner: 'server', id: '' });
  api.setOwnershipUnresolved('handoff', handoffId);
  trackEvent('background_handoff_unresolved');
  return { outcome, safeToResumeLocally: false };
}

/**
 * Normalises a name for comparison against what Last.fm stored.
 *
 * Kept identical to the worker's `normalizeForMatch` on purpose — the two
 * halves ask the same question of the same API, and a comparison that is loose
 * on one side and strict on the other reaches opposite conclusions about the
 * same play.
 */
function normalizeForMatch(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** How far apart two repeated seconds may be and still share one lookup. */
const REPEAT_CLUSTER_GAP_SECONDS = 900;

/**
 * Windows queried before the rest are left as they are.
 *
 * Generous enough that the cap is not what stops a realistic take-back: a
 * batch of fifty preserved originals scattered across a listening history is
 * fifty separate windows, and leaving the tail of that unasked would keep
 * exactly the expiring pins this exists to settle. The real brake is the
 * deadline below.
 */
export const MAX_REPEAT_LOOKUPS = 60;

/**
 * How long the whole reconciliation may take.
 *
 * This runs while the export claim is held, and that claim is what makes the
 * snapshot true: if it lapses, the sweep reverts the job to resumable and the
 * queue can move on underneath us. The cancel now refuses a lapsed claim, so
 * overrunning costs a retry rather than a duplicate — but a take-back that has
 * to be retried is a bad enough outcome to budget against. Well inside
 * `EXPORT_CLAIM_SECONDS` (600), leaving room for the export itself and the
 * cancel that follows.
 *
 * Checked between windows rather than enforced on one, because a single
 * request has its own retry behaviour and cutting it short mid-flight would
 * turn a slow answer into an unknown one.
 */
export const REPEAT_LOOKUP_BUDGET_MS = 90_000;

export interface RepeatResolution {
  /** Confirmed at Last.fm. Removed from the queue and counted as scrobbled. */
  settled: number;
  /** Provably absent. Freed to be re-timed like any other re-tagged track. */
  freed: number;
  /** Left pinned, exactly as an older client would have handled all of them. */
  unresolved: number;
}

/**
 * Settles the seconds the worker handed back pinned, against real history.
 *
 * A pinned second is a bet that a repeat is harmless: if the original send
 * landed, Last.fm discards the identical (artist, track, timestamp) tuple, and
 * if it did not, the repeat stores it. The bet is sound *while Last.fm still
 * accepts the second* — and the browser may not reach that track for days,
 * after which the play can be sent under no second at all and is reported as a
 * permanent failure. Asking now, while the user is present and the second is
 * still in window, replaces an expiring bet with an answer.
 *
 * Three outcomes, and only two of them are conclusions:
 *
 *  - **the exact tuple is there** — it landed. The track leaves the queue and
 *    is counted among the server's successes.
 *  - **that second is empty** — nothing was stored under it, so the send did
 *    not land. Last.fm records at the submitted timestamp, so there is nowhere
 *    else it could be. Freed to take a fresh second like any other re-tag.
 *  - **some other play occupies it** — ambiguous, because Last.fm rewrites
 *    names and the entry there may be this very play under a corrected title.
 *    Left pinned. This is the pre-existing behaviour for every entry, so the
 *    ambiguous case is never made worse than it already was.
 *
 * A window that could not be read completely is treated as ambiguous for all
 * of its entries: a truncated page and an empty one look alike, and reading a
 * truncation as "empty" would re-time a play that is already on the account.
 * So is a window never asked about, because the budget ran out.
 *
 * Everything still pinned at the end is moved to the front of the queue. The
 * question cannot be decided, but the tuple is idempotent while Last.fm will
 * still accept it, so the one thing that can still go wrong is waiting — and
 * waiting is the part that is under our control.
 *
 * Mutates `exported` in place; the caller passes it straight to
 * `stateFromExport`.
 */
export async function resolveExportedRepeats(
  exported: any,
  lookup: (fromSec: number, toSec: number) => Promise<{
    plays: { artist: string; track: string; timestampSec: number }[];
    complete: boolean;
  }>,
  budgetMs: number = REPEAT_LOOKUP_BUDGET_MS,
): Promise<RepeatResolution> {
  const result: RepeatResolution = { settled: 0, freed: 0, unresolved: 0 };
  const tracks = exported && exported.state && Array.isArray(exported.state.tracks)
    ? exported.state.tracks
    : null;
  if (!tracks || !Array.isArray(exported.repeats) || exported.repeats.length === 0) {
    return result;
  }

  const entries = exported.repeats
    .filter((r: any) => r
      && Number.isInteger(r.i) && r.i >= 0 && r.i < tracks.length
      && Number.isFinite(r.sec) && r.sec > 0)
    .map((r: any) => ({ i: r.i as number, sec: Math.floor(r.sec) as number }))
    .sort((a: any, b: any) => a.sec - b.sec);
  if (entries.length === 0) {
    return result;
  }

  // One request per cluster of nearby seconds. The worker allocates
  // descending and one per second, so a batch's worth of abandoned entries is
  // a contiguous run and costs a single lookup.
  const clusters: { i: number; sec: number }[][] = [];
  entries.forEach((e: { i: number; sec: number }) => {
    const last = clusters[clusters.length - 1];
    if (last && e.sec - last[last.length - 1].sec <= REPEAT_CLUSTER_GAP_SECONDS) {
      last.push(e);
    } else {
      clusters.push([e]);
    }
  });

  const settledPositions = new Set<number>();
  const stillPinned = new Set<number>();
  const deadline = Date.now() + budgetMs;
  for (let c = 0; c < clusters.length; c += 1) {
    const cluster = clusters[c];
    if (c >= MAX_REPEAT_LOOKUPS || Date.now() >= deadline) {
      result.unresolved += cluster.length;
      cluster.forEach((e) => stillPinned.add(e.i));
      // eslint-disable-next-line no-continue
      continue;
    }
    const from = cluster[0].sec - 1;
    const to = cluster[cluster.length - 1].sec + 1;
    let window: {
      plays: { artist: string; track: string; timestampSec: number }[];
      complete: boolean;
    } | null = null;
    try {
      // eslint-disable-next-line no-await-in-loop
      window = await lookup(from, to);
    } catch (e) {
      window = null;
    }
    if (!window || !window.complete) {
      result.unresolved += cluster.length;
      cluster.forEach((e) => stillPinned.add(e.i));
      // eslint-disable-next-line no-continue
      continue;
    }
    const bySecond = new Map<number, { artist: string; track: string }[]>();
    window.plays.forEach((p) => {
      const bucket = bySecond.get(p.timestampSec);
      if (bucket) { bucket.push(p); } else { bySecond.set(p.timestampSec, [p]); }
    });
    cluster.forEach((e) => {
      const t = tracks[e.i];
      const bucket = bySecond.get(e.sec);
      if (!bucket || bucket.length === 0) {
        /*
          Nothing at all under this second, so the send never reached Last.fm.
          Handed back to the ordinary re-tag path: `reTagged` is what makes the
          browser stamp it against its own clock, and the timestamp below is
          then cosmetic, matching what the worker emits for every other
          re-tagged track.
        */
        t.reTagged = true;
        t.timestamp = Date.now();
        result.freed += 1;
        return;
      }
      const hit = bucket.some((p) => normalizeForMatch(p.artist) === normalizeForMatch(t.artist)
        && normalizeForMatch(p.track) === normalizeForMatch(t.track));
      if (hit) {
        settledPositions.add(e.i);
        result.settled += 1;
      } else {
        result.unresolved += 1;
        stillPinned.add(e.i);
      }
    });
  }

  if (settledPositions.size > 0 || stillPinned.size > 0) {
    /*
      Settled entries are removed from the queue and added to the server's
      count in one step. The total the user sees is derived from the two
      together, so moving a track across without crediting it would report the
      import as having shrunk.

      Whatever is still pinned goes to the *front*.

      Those are the entries whose second could not be settled either way, and
      the only thing that can still go wrong with one is time: the tuple is
      idempotent while Last.fm will accept it, and unsendable afterwards.
      Nothing here can decide the question, but the queue can stop making it
      worse. At the back of a hundred-thousand-track queue a pin waits weeks;
      at the front it goes out with the first batch, and a repeat that lands
      inside the window is a no-op if the original arrived and a normal
      scrobble if it did not — no conclusion required.

      They are also `reTagged: false`, so they are not held back by a re-tag
      block, which is the other thing that can stall the head of a queue.

      Written back into the envelope the caller already holds, because that is
      what goes on to `stateFromExport`: returning a copy would leave a stale
      original one line away from being used by mistake. Nothing indexes into
      this array yet — `completedIndices` and `failedIndices` are empty and the
      positions above have already been consumed — so reordering it is free.
    */
    /* eslint-disable no-param-reassign */
    const kept = tracks
      .map((t: unknown, i: number) => ({ t, i }))
      .filter((e: { t: unknown; i: number }) => !settledPositions.has(e.i));
    exported.state.tracks = [
      ...kept.filter((e: { t: unknown; i: number }) => stillPinned.has(e.i)),
      ...kept.filter((e: { t: unknown; i: number }) => !stillPinned.has(e.i)),
    ].map((e: { t: unknown; i: number }) => e.t);
    exported.state.totalTracks = exported.state.tracks.length;
    exported.scrobbledByServer = (Number(exported.scrobbledByServer) || 0) + settledPositions.size;
    /* eslint-enable no-param-reassign */
  }
  return result;
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
  priorBlockedUntilSec = 0,
): ScrobbleState | null {
  const raw = exported && exported.state ? exported.state : null;
  const tracks = raw && Array.isArray(raw.tracks) ? raw.tracks : null;
  if (!tracks || tracks.length === 0) {
    return null;
  }

  // Read once, up front. Several decisions below are relative to "now", and
  // taking separate readings would let them disagree with each other.
  const nowSec = Math.floor(Date.now() / 1000);

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

  /*
    The worker's named failures come back with the queue, not in it.

    Export removes failed tracks from `state.tracks` — they are neither
    remaining nor completed — and reports them separately. Dropping them here
    is how the user ends up knowing only that "3 tracks were rejected" and
    never which three, with no way to re-add them. A refused pin makes that
    worse: that report may name a play Last.fm actually stored, and the user
    can only judge it if they know what it was.
  */
  const failedDetails: FailedTrackDetail[] = Array.isArray(exported.failures)
    ? exported.failures
      .filter((f: any) => f && (f.artist || f.track))
      .map((f: any) => ({
        artist: String(f.artist ?? ''),
        track: String(f.track ?? ''),
        album: String(f.album ?? ''),
        reason: String(f.reason || 'Rejected by Last.fm'),
      }))
    : [];

  /*
    A pinned retry survives the take-back, if the worker still had one.

    It cannot be recovered from the timestamp alone — the cosmetic placeholder
    every other re-tagged track carries is non-zero too — so the export says
    so outright, and this is the only place that reading is available. Losing
    it here would hand the browser a track it may already have scrobbled, with
    permission to invent a different second for it: a phantom play on a public
    profile, which is the single worst thing this codebase can do.

    Moved to the head because that is where the pin is addressed. Both the
    browser's own allocator and the handoff apply a pending second to the
    track at the front of the queue, and applying it to any other track would
    turn a deduplication into a fresh collision.
  */
  const pinnedIdxs: number[] = [];
  tracks.forEach((t: any, idx: number) => {
    if (t && t.pendingRetry === true && Number.isFinite(t.timestamp) && t.timestamp > 0) {
      pinnedIdxs.push(idx);
    }
  });
  let pendingReTagTimestampSec = 0;
  /*
    Exactly one, or none at all.

    Only the head track is ever pinned and it must be resolved before another
    second is allocated, so a second marker means the invariant this reads has
    already broken somewhere upstream. Guessing which of them the pin belongs
    to would apply a deduplicating second to the wrong track — turning the one
    thing that prevents a duplicate into the thing that causes one — so the
    ambiguous case keeps none and lets the allocator issue fresh seconds.
  */
  if (pinnedIdxs.length > 1) {
    trackEvent('background_export_multiple_pins', { count: pinnedIdxs.length });
  } else if (pinnedIdxs.length === 1) {
    const pinnedIdx = pinnedIdxs[0];
    const pinSec = Math.floor(tracks[pinnedIdx].timestamp / 1000);
    /*
      Kept whatever the clock here says.

      The obvious guard — drop it once it is too old to collide — has to ask
      "how old is it" of the one clock in the system that nobody can trust. A
      browser running fast discards a second that is still live and invents a
      different one for a track the worker may already have sent, which is a
      phantom play on a public profile; a browser running slow keeps one that
      has expired. Only the second of those is recoverable, and it is: the send
      loop puts the pin out unchanged, and if Last.fm refuses it as too old the
      track is reported as a failure rather than re-sent under a new second —
      because a refusal says the tuple can no longer be stored, not that it
      never was.

      So the trade settles the other way round from how it looks. Preserving
      unconditionally risks one visible, named failure; judging it against the
      local clock risks a silent duplicate.
    */
    if (pinSec > 0) {
      pendingReTagTimestampSec = pinSec;
      const [head] = serialized.splice(pinnedIdx, 1);
      serialized.unshift(head);
    }
  }

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
  const lineage = api.getHandoffLineage();
  const priorTotal = lineage ? lineage.originalTotalTracks : 0;
  const priorSucceeded = lineage ? lineage.originalSucceededCount : 0;

  const serverFloor = Number.isFinite(exported.syntheticFloorSec) && exported.syntheticFloorSec > 0
    ? exported.syntheticFloorSec
    : 0;

  /*
    The reservation has to clear *every* second either side has used, and it is
    chosen as a free gap rather than a range below the global minimum.

    Four histories matter:

      - the server's current descending band, bounded by `syntheticFloorSec`;
      - every second the server actually submitted, which `usedRanges` carries
        — this covers preserved originals and any band abandoned by a wrap,
        neither of which the floor describes;
      - this browser's own earlier bands, invisible to the server, accumulated
        across however many times the queue has been resumed;
      - the six hours before the handoff, for a lineage predating the ranges.

    Reserving strictly *below* the minimum was the obvious approach and does
    not survive contact with the data. A single preserved original near the
    thirteen-day boundary drags the minimum down there, leaving no room
    underneath — at which point the reservation is abandoned and the allocator
    falls back to its normal window, which is exactly where the other used
    ranges are. Each take-back also walked the minimum down another six hours,
    so the window drained cycle by cycle.

    Searching for a gap instead keeps every reservation inside the window and
    uses the space that repeated cycles free up rather than only the space
    below them.

    Truncation and unreadability are reported separately and are not equally
    bad. A truncated list drops only its lowest ranges, so everything above the
    lowest one that survived is still completely described and a gap found
    there is genuinely free — the search floor simply rises to meet it.
    Unreadable rows are fatal: their seconds could sit anywhere, including
    inside a gap that looks empty, so there is nothing left to trust and the
    reservation is abandoned.

    An older worker sends neither field. It also truncated from the wrong end,
    so its list cannot be bounded this way; `usedRangesTruncated` alone is
    therefore still read as fatal.
  */
  const browserBandStart = lineage && lineage.handedOverAtSec
    ? lineage.handedOverAtSec - RETAG_BACKFILL_SECONDS
    : 0;
  const exportedRanges: { from: number; to: number }[] = Array.isArray(exported.usedRanges)
    ? exported.usedRanges
      .filter((r: any) => r && Number.isFinite(r.from) && Number.isFinite(r.to) && r.from > 0)
      .map((r: any) => ({ from: Math.floor(r.from), to: Math.floor(r.to) }))
    : [];
  const priorRanges = (lineage && lineage.reTagUsedRanges) || [];
  const used: { from: number; to: number }[] = [...exportedRanges, ...priorRanges];
  if (serverFloor > 0) {
    // The floor is the lowest second of the server's current band; everything
    // from there up to the present margin may be occupied by it.
    used.push({ from: serverFloor, to: nowSec });
  }
  if (browserBandStart > 0) {
    used.push({ from: browserBandStart, to: lineage!.handedOverAtSec! });
  }

  const knowsFailureModes = typeof exported.usedRangesIncomplete === 'boolean';
  const truncatedFloor = Number.isFinite(exported.usedRangesFloorSec)
    && exported.usedRangesFloorSec > 0
    ? Math.floor(exported.usedRangesFloorSec)
    : 0;
  // Unusable only when the seconds could be anywhere. A worker too old to say
  // which failure it hit is assumed to have hit the fatal one.
  const unusable = knowsFailureModes
    ? !!exported.usedRangesIncomplete
    : !!exported.usedRangesTruncated;
  // Never below the window limit: a higher floor narrows the search, which is
  // the point, but a lower one would widen it into seconds Last.fm rejects.
  // The lineage carries its own floor from earlier cycles, and it binds here
  // too — the browser's history is as capable of being incomplete as the
  // worker's, and for the same reason.
  const searchFloor = Math.max(
    nowSec - RETAG_WINDOW_LIMIT_SECONDS,
    knowsFailureModes ? truncatedFloor : 0,
    (lineage && Number.isFinite(lineage.reTagKnownFromSec as any)
      ? Number(lineage.reTagKnownFromSec) : 0),
  );

  const reserved = unusable
    ? null
    : findFreeRange(
      used,
      nowSec - PRESENT_MARGIN_SECONDS,
      searchFloor,
      RETAG_BACKFILL_SECONDS,
    );

  /*
    No safe interval exists right now. The unknown or exhausted seconds are all
    in the past, so the block lifts once Last.fm's window has slid entirely
    past them — at which point nothing can be scrobbled into them at all.
  */
  const priorBlockedUntil = Number.isFinite(priorBlockedUntilSec)
    && priorBlockedUntilSec > 0
    ? Math.floor(priorBlockedUntilSec)
    : 0;
  const reTagBlockedUntilSec = Math.max(
    reserved ? 0 : nowSec + RETAG_WINDOW_LIMIT_SECONDS,
    priorBlockedUntil,
  );

  return {
    userName: username,
    totalTracks: serialized.length,
    completedIndices: [],
    failedIndices: [],
    ...(failedDetails.length > 0 ? { failedDetails } : {}),
    tracks: serialized,
    originalTotalTracks: Math.max(
      fallbackOriginalTotal,
      priorTotal,
      serialized.length + priorSucceeded + scrobbledByServer,
    ),
    originalSucceededCount: priorSucceeded + scrobbledByServer,
    sendTimestamps: [],
    lastReTagTimestampSec: 0,
    // Restored from the export's explicit marker; see the search above.
    ...(pendingReTagTimestampSec > 0 ? { pendingReTagTimestampSec } : {}),
    ...(reserved
      ? { reTagFloorSec: reserved.from, reTagCeilingSec: reserved.to }
      : {}),
    /*
      A missing reservation has two very different causes, and they must not
      look alike downstream. `findFreeRange` returning nothing means the
      window is full; `unusable` means we do not know what is in it. Either
      way there is no safe interval, so both block — with an unreadable or an
      exhausted history the default six-hour window is the *most* likely place
      for a collision, and a collision is a play Last.fm discards while
      reporting success.

      Carried forward from the previous cycle too. A later export being
      readable says nothing about the seconds an *earlier* one lost track of,
      and those seconds keep mattering until they age out of Last.fm's window.
      The later of the two deadlines wins.
    */
    ...(reTagBlockedUntilSec > 0 ? { reTagBlockedUntilSec } : {}),
    /*
      A returned queue gets a *fresh* identity, deliberately.

      The export carries no id, and reusing the old one would be worse than
      dropping it: the server still remembers that id as handed over, so the
      reconciled queue — the only copy that is now allowed to send — would
      answer its own authority check with "known" and block itself forever.

      Rotating gets both halves right. Stale copies on other devices keep the
      old, server-known id and stay blocked, which is exactly what take-back
      must not undo; this copy carries an id the server has never seen and is
      free to run. An empty string (no `crypto`) degrades to the legacy
      behaviour rather than pinning the wrong identity.
    */
    ...(() => {
      const rotated = StateManager.newImportId();
      return rotated ? { importId: rotated } : {};
    })(),
    burstCount: 0,
    dailyCount: 0,
    dailyCountDate: new Date().toISOString().slice(0, 10),
    savedAt: new Date().toISOString(),
  };
}
