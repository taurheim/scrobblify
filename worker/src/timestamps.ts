/**
 * Timestamp assignment.
 *
 * This is the part of the worker most able to quietly ruin someone's Last.fm
 * profile, so it is a separate, pure module with no I/O.
 *
 * Two facts force the worker to choose timestamps at send time rather than
 * carrying the client's:
 *
 *  - Re-tagged listens all share one timestamp. The client assigns a single
 *    `Date` to every listen, so a 90k-track import arrives with 90k identical
 *    timestamps.
 *  - A 37-day job outlives Last.fm's 14-day scrobble window. Any timestamp
 *    fixed at job creation starts getting rejected around day 15.
 *
 * So: a track whose original listen time is *still* inside the window when we
 * get to it keeps its real timestamp. Everything else is stamped near the
 * present, spread out so no two scrobbles collide.
 */

/**
 * Last.fm accepts scrobbles up to 14 days old. We treat the limit as 13 days
 * to leave room for a batch that sits in a retry queue overnight — a track
 * that was valid when we picked it must still be valid when it lands.
 */
export const WINDOW_SECONDS = 13 * 86400;

/**
 * How long a second stays capable of *colliding*, as opposed to being worth
 * preserving.
 *
 * The full 14 days Last.fm accepts, with no safety margin, and the difference
 * from `WINDOW_SECONDS` is deliberate: the two answer different questions. A
 * margin costs nothing when deciding whether a listen date is still worth
 * keeping — there is always a synthetic second to fall back on. It is the bug
 * when deciding whether a play might already be sitting at a given second,
 * because "probably expired" is not "cannot collide", and a second that
 * Last.fm still accepts is a second it may still hold.
 */
export const COLLISION_WINDOW_SECONDS = 14 * 86400;

/**
 * Synthetic timestamps are placed at least this far in the past. A scrobble
 * timestamped in the future earns ignore code 4, and clock skew between us and
 * Last.fm is not something we can measure.
 */
export const PRESENT_MARGIN_SECONDS = 120;

/**
 * How far back synthetic timestamps may march before we wrap.
 *
 * Each synthetic scrobble consumes one second. The ceiling is ~162k tracks and
 * the usable window is ~1.1M seconds, so a job cannot exhaust this — but a
 * *resumed* job whose floor was recorded weeks ago could, which is what the
 * wrap in `allocate` handles.
 */
export const SYNTHETIC_FLOOR_LIMIT_SECONDS = WINDOW_SECONDS - 3600;

export interface TrackForSend {
  artist: string;
  track: string;
  album?: string;
  originalTimestampSec: number;
  /**
   * True when the client invented this play's date rather than reading it.
   *
   * Only meaningful here in combination with a non-zero timestamp, which is
   * the signature of a *pinned retry*: see `isPinnedRetry`.
   */
  reTagged?: boolean;
}

export interface AssignedTrack {
  artist: string;
  track: string;
  album?: string;
  /** Index in the job's blob. Carried through so outcomes map back to tracks. */
  index: number;
  timestampSec: number;
  /** True when the track kept its real listen time. Reported to the user. */
  preservedOriginal: boolean;
  /**
   * True when this second is a browser's idempotency pin rather than a listen
   * date, and was kept as-is.
   *
   * Carried into the outcome so a rejection can be treated as final. Codes 3
   * and 4 are normally *our* assignment being wrong and are deliberately
   * non-terminal — the job stalls and a human looks at it — but a pin is the
   * only second that can ever be sent for this track, so there is nothing to
   * reassign and stalling would park the job forever.
   */
  pinnedRetry?: boolean;
}

export interface AssignmentResult {
  assigned: AssignedTrack[];
  /**
   * The new low-water mark for synthetic timestamps. Persisted on the job so
   * the next batch does not reuse seconds this one just consumed — Last.fm may
   * dedupe identical (artist, track, timestamp) tuples, and two batches landing
   * on the same second would make that ambiguity our problem.
   */
  syntheticFloor: number;
  preservedCount: number;
}

/**
 * True if `originalTimestampSec` is a usable scrobble time right now.
 *
 * Rejects zero, negative and absurd values as well as out-of-window ones: the
 * client's parser has produced `NaN`-ish dates before, and a 1970 timestamp is
 * indistinguishable from "field was missing".
 */
export function isWithinWindow(originalTimestampSec: number, nowSec: number): boolean {
  if (!Number.isFinite(originalTimestampSec) || originalTimestampSec <= 0) {
    return false;
  }
  if (originalTimestampSec > nowSec - 1) {
    return false;
  }
  return originalTimestampSec >= nowSec - WINDOW_SECONDS;
}

/**
 * True when a track carries a second the browser may already have spent.
 *
 * A re-tagged play has no real listen date — the client sends 0 and asks for
 * one at send time — so a re-tagged track arriving with a timestamp is not a
 * listen date at all. It is the exact second a browser used on a send whose
 * response it never saw, handed over so this worker can repeat the identical
 * `(artist, track, second)` tuple. Last.fm discards an identical repeat but
 * stores a different second as a play the user never listened to, so the pin
 * is the difference between a no-op and a phantom.
 */
export function isPinnedRetry(t: TrackForSend): boolean {
  return t.reTagged === true
    && Number.isFinite(t.originalTimestampSec)
    && t.originalTimestampSec > 0;
}

/**
 * Whether a pinned second is still worth repeating.
 *
 * Judged against the *collision* window, not the preservation one. The extra
 * day is the whole point: between day 13 and day 14 Last.fm still accepts the
 * tuple, so it may still hold the original, and minting a fresh second there
 * is precisely what creates the phantom the pin exists to prevent.
 *
 * Past 14 days the repeat will be refused — but that is a statement about what
 * can be *submitted* now, not about what was stored then. See
 * `isPinReplaceable`, which is the question this worker actually acts on.
 */
export function isPinUsable(pinnedSec: number, nowSec: number): boolean {
  if (!Number.isFinite(pinnedSec) || pinnedSec <= 0) {
    return false;
  }
  // A future second earns ignore code 4 whoever sends it, so the browser's
  // original cannot have landed either. Nothing to be idempotent about.
  if (pinnedSec > nowSec - 1) {
    return false;
  }
  return pinnedSec >= nowSec - COLLISION_WINDOW_SECONDS;
}

/**
 * Whether a pinned second may be swapped for one this worker chooses.
 *
 * Only when the pin cannot describe a stored play at all. A second in the
 * future is refused by Last.fm whoever submits it, so the browser's original
 * was refused too and there is nothing to repeat; a malformed one names
 * nothing. Everything else — including a pin so old that repeating it will be
 * rejected — **must not be replaced**.
 *
 * That last case is the one worth stating plainly, because the intuitive
 * answer is wrong. "Too old to submit" is not "was never stored". If the
 * browser's send did land, a fresh second puts a second copy of that play on
 * the user's profile, and there is no way for them to tell which is which.
 * Repeating the doomed pin instead costs at most one **reported** failure,
 * which is the same trade the browser makes for an inherited pin.
 */
export function isPinReplaceable(pinnedSec: number, nowSec: number): boolean {
  if (!Number.isFinite(pinnedSec) || pinnedSec <= 0) {
    return true;
  }
  return pinnedSec > nowSec - 1;
}

/**
 * Assigns a send-time timestamp to each track in a batch.
 *
 * `syntheticFloor` is the lowest synthetic second used by previous batches of
 * this job (0 for a fresh job). Synthetic timestamps march *downwards* from
 * there, because upwards is the future and the future is ignore code 4.
 *
 * Guarantees the caller depends on:
 *  - every timestamp in the returned batch is unique
 *  - every timestamp is inside Last.fm's window and not in the future, with
 *    one deliberate exception: a pinned retry keeps its second even when that
 *    second is too old to be accepted, because replacing it is how a play that
 *    was already stored gets duplicated. Such an entry is flagged
 *    `pinnedRetry` so its rejection can be treated as final rather than as a
 *    reason to stall the job
 *  - a preserved original is never overwritten by a synthetic value, and a
 *    synthetic value never collides with a preserved one in the same batch
 */
export function assignTimestamps(
  tracks: TrackForSend[],
  nowSec: number,
  syntheticFloor: number,
): AssignmentResult {
  const ceiling = nowSec - PRESENT_MARGIN_SECONDS;
  const hardFloor = nowSec - SYNTHETIC_FLOOR_LIMIT_SECONDS;

  // Wrap when the recorded floor is unusable: either unset (new job) or so old
  // that continuing downwards would fall out of the window. Because `nowSec`
  // advances as the job runs, wrapping lands well clear of anything in flight.
  let next = syntheticFloor > hardFloor && syntheticFloor <= ceiling
    ? syntheticFloor - 1
    : ceiling;

  // Originals we are preserving are reserved up front. Assigning them as we go
  // would let a synthetic value for track 3 take the second that track 40's
  // real timestamp needs, and the collision would only show up as a silently
  // dropped scrobble.
  const taken = new Set<number>();
  const preserved: (number | null)[] = tracks.map((t) => {
    /*
      A pinned retry is reserved on the *collision* window rather than the
      preservation one. It is not a listen date being kept for its own sake;
      it is an idempotency guarantee, and it holds for as long as Last.fm
      would still recognise the repeat — a day longer than dates we merely
      prefer to keep.
    */
    const pinned = isPinnedRetry(t);
    /*
      A pinned retry keeps its second unless that second cannot describe a
      stored play at all.

      Not judged on the collision window, which asks whether the repeat will
      still be *accepted*. Being refused is the acceptable outcome here: the
      alternative is a fresh second beside a play that may already exist, and
      a duplicate on a public profile has no user-side recovery where a
      reported failure does. `isPinUsable` still describes the accept/refuse
      boundary and is used where that is genuinely the question.
    */
    const keep = pinned
      ? !isPinReplaceable(t.originalTimestampSec, nowSec)
      : isWithinWindow(t.originalTimestampSec, nowSec);
    if (keep) {
      const ts = Math.floor(t.originalTimestampSec);
      if (!taken.has(ts)) {
        taken.add(ts);
        return ts;
      }
      // Duplicate real timestamps happen constantly — the client's re-tagging
      // gives every listen the same instant. Only the first keeps it.
    }
    return null;
  });

  const assigned: AssignedTrack[] = [];
  let preservedCount = 0;

  for (let i = 0; i < tracks.length; i += 1) {
    const t = tracks[i];
    let ts = preserved[i];
    const keptPin = preserved[i] !== null && isPinnedRetry(t);
    if (ts === null) {
      while (taken.has(next) || next > ceiling) {
        next -= 1;
      }
      ts = next;
      taken.add(ts);
      next -= 1;
    } else {
      preservedCount += 1;
    }
    assigned.push({
      artist: t.artist,
      track: t.track,
      album: t.album,
      index: i,
      timestampSec: ts,
      preservedOriginal: preserved[i] !== null,
      pinnedRetry: keptPin,
    });
  }

  return {
    assigned,
    // `next` is already one below the last value handed out.
    syntheticFloor: Math.min(next, ceiling - 1),
    preservedCount,
  };
}

/**
 * The window to query when reconciling a batch whose fate is unknown.
 *
 * `from`/`to` on `user.getRecentTracks` are strictly exclusive, so both ends
 * are widened by a second. Without that the first and last scrobble of the
 * batch are invisible and get sent twice.
 */
export function reconciliationWindow(
  timestamps: number[],
): { fromSec: number; toSec: number } | null {
  if (timestamps.length === 0) {
    return null;
  }
  return {
    fromSec: Math.min(...timestamps) - 1,
    toSec: Math.max(...timestamps) + 1,
  };
}

/**
 * Normalises a name for reconciliation comparison.
 *
 * Last.fm rewrites what it stores — casing, whitespace, occasionally the artist
 * itself — so an exact match against what we *sent* finds nothing and we
 * conclude the batch was lost. Deliberately loose: a false match costs one
 * missing scrobble in a batch we already know is ambiguous, while a false
 * miss costs a duplicate for every track in it.
 */
export function normalizeForMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}
