import Scrobble from '@/models/Scrobble';

export interface SerializedScrobble {
  track: string;
  artist: string;
  album: string;
  timestamp: number;
  /**
   * Absent in files written before re-tagged plays were given per-play
   * timestamps. deserializeScrobbles() infers it for those — see
   * hasCollapsedTimestamps().
   */
  reTagged?: boolean;
}

/**
 * A track written off permanently by whoever owned the queue at the time.
 *
 * Deliberately self-contained rather than an index: the track it names is no
 * longer in `tracks`, so there is nothing for an index to point at.
 */
export interface FailedTrackDetail {
  artist: string;
  track: string;
  album?: string;
  /** What Last.fm (or the worker) said. Shown to the user verbatim. */
  reason: string;
}

export interface ScrobbleState {
  userName: string;
  totalTracks: number;
  completedIndices: number[];
  failedIndices: number[];
  tracks: SerializedScrobble[];
  /**
   * Size of the user's *original* selection. `totalTracks` shrinks on every
   * resume (only the remaining tracks are re-saved), so it cannot be used as a
   * completion denominator. This one is carried forward untouched.
   */
  originalTotalTracks: number;
  /**
   * Cumulative count of tracks successfully scrobbled across every session of
   * this import, not just the most recent one.
   */
  originalSucceededCount: number;
  /**
   * Timestamps (ms) of recent successful scrobbles — the rolling window used by
   * RateLimitTracker. This is the authoritative rate-limit record.
   */
  sendTimestamps: number[];
  /**
   * High-water mark of the send-time timestamp allocator for re-tagged plays.
   * Optional: absent from files written before it existed, in which case the
   * allocator simply starts from the current clock.
   */
  lastReTagTimestampSec?: number;
  /**
   * Synthetic second already handed to Last.fm for the first remaining track,
   * whose outcome was never observed. Absent in the ordinary case.
   *
   * A re-tagged send that reaches Last.fm and loses its response must be
   * retried with the *identical* `(artist, track, timestamp)` tuple: Last.fm
   * deduplicates an identical resend, but stores a different second as a
   * second, phantom play that the user never listened to. The send loop keeps
   * this in memory across retries, which is enough until a halt persists and
   * hands the queue to another tab or to the worker between the send and its
   * outcome. Carrying it here is what makes that resumable rather than lossy.
   */
  pendingReTagTimestampSec?: number;
  /**
   * Tracks a *previous* owner of this queue wrote off permanently, kept so the
   * user can still be told which ones and why.
   *
   * The background worker reports its failures by name, but the queue it hands
   * back has those tracks removed — they are neither remaining nor completed,
   * so no index into `tracks` can describe them. Without this the user is told
   * only "3 rejected by Last.fm" before take-back and nothing at all
   * afterwards, which is the one thing they cannot recover from on their own:
   * a track they cannot name is a track they cannot re-add.
   *
   * Carried through saves untouched. Absent in files written before it
   * existed, and in any queue that has never been handed over.
   */
  failedDetails?: FailedTrackDetail[];
  /**
   * Start of a re-tag range reserved for this browser, when one is needed.
   *
   * Normally the allocator works in `(now - 6h, now]`. That is unsafe after a
   * background job hands work back, because the server allocates its own
   * synthetic seconds *downwards* from the present while this allocator walks
   * *upwards* — so the browser would march straight through seconds the server
   * already used, and Last.fm silently discards a repeat of
   * `(artist, track, timestamp)` while still reporting it accepted.
   *
   * When set, this replaces `now - 6h` as the lower bound, placing the walk
   * entirely below anything the server touched. Absent for every state that
   * never went through a handoff.
   */
  reTagFloorSec?: number;
  /**
   * Exclusive upper bound matching `reTagFloorSec` — the server's lowest used
   * second. The allocator stops honouring the reserved range if it ever gets
   * this far, since running out of room is better handled by falling back to
   * the normal window than by stamping everything the same.
   */
  reTagCeilingSec?: number;
  /**
   * Second after which re-tagging is safe again; absent or 0 when it always
   * was.
   *
   * Set when a take-back could not determine which seconds the job consumed.
   * Distinct from an absent reservation, which merely means "allocate the
   * usual way". This means no interval is known to be safe, so re-tagged
   * tracks are held back rather than sent — they are left in the queue for a
   * later run instead of being spent on timestamps that would collide.
   *
   * It expires because the unknown seconds are all in the past: once Last.fm's
   * thirteen-day window has slid entirely past them, nothing can be scrobbled
   * into them and the hazard is gone.
   */
  reTagBlockedUntilSec?: number;
  /**
   * Second at which a background handoff pinned its ordering.
   *
   * The upload digest is committed to the server *before* the redirect to
   * Last.fm, and the bytes are produced after it. Both derive the track order
   * from this state, so the sort key has to be pinned — re-evaluating it
   * against a moved clock could shift a boundary track between the in-window
   * and out-of-window queues and produce bytes the committed digest does not
   * describe.
   *
   * Optional, like every field added after the format shipped: files written
   * before this existed must still import, and files written now must still
   * import into an older cached client.
   */
  handoffOrderEpoch?: number;
  /**
   * Stable identity for this queue, minted at selection.
   *
   * Two distinct jobs depend on it:
   *
   * 1. Asking the worker whether *this* import was ever handed over. The
   *    per-user liveness check cannot answer that — a job that completed, or
   *    that stalled needing re-auth, reports nothing live while its tracks are
   *    still sitting in this browser's queue. Resuming then replays them, and
   *    Last.fm discards a repeat of `(artist, track, timestamp)` while
   *    reporting it accepted, so the plays are lost with no error anywhere.
   *
   * 2. Making `saveStateIfAhead`'s comparison meaningful. Progress counts from
   *    two different imports are not comparable, so without identity a tab
   *    holding an old selection can look "ahead" of the current one and
   *    overwrite it.
   *
   * Optional: absent from every file written before this existed. Absence
   * degrades to the previous behaviour rather than to a refusal, which is the
   * same posture taken when the server cannot be reached.
   */
  importId?: string;
  /**
   * Legacy count-based rate-limit fields. Kept so progress files written by
   * older versions still import, and so files written by this version remain
   * readable by them. RateLimitTracker.seedFromLegacyCounts() converts these
   * into a rolling window when sendTimestamps is absent.
   */
  burstCount: number;
  dailyCount: number;
  dailyCountDate: string;
  savedAt: string;
}

const DB_NAME = 'scrobblify';
const STORE_NAME = 'scrobbleState';
const STATE_KEY = 'current';

export default class StateManager {
  /**
   * Mints a queue identity.
   *
   * 128 bits, hex, so it satisfies the worker's `[\w-]{16,128}` shape and is
   * far too large to guess. That matters because the id *is* the credential
   * for `GET /scrobblify/import/:id` — that route is deliberately public,
   * since a browser that has lost its worker session is one of the cases it
   * exists to answer, and gating it on a session would demand something
   * strictly weaker than knowing the id already proves.
   *
   * `crypto.getRandomValues` is required rather than preferred; falling back
   * to `Math.random` would quietly turn a capability into an enumerable one.
   * Every consumer already treats an absent id as "cannot prove anything".
   */
  static newImportId(): string {
    const c = typeof crypto !== 'undefined' ? crypto : undefined;
    if (!c || typeof c.getRandomValues !== 'function') {
      return '';
    }
    const bytes = new Uint8Array(16);
    c.getRandomValues(bytes);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  static serializeScrobbles(scrobbles: Scrobble[]): SerializedScrobble[] {
    return scrobbles.map((s) => ({
      track: s.track,
      artist: s.artist,
      album: s.album,
      timestamp: s.timestamp.getTime(),
      reTagged: s.reTagged,
    }));
  }

  /**
   * Older versions stamped every re-tagged play with the same Date object, so a
   * saved queue from one of those is recognisable by essentially *all* of its
   * timestamps being identical — real listening history never looks like that.
   *
   * Without this, someone mid-import from an older build would resume into a
   * queue that Last.fm collapses into a single scrobble, and (once the saved
   * date ages past 14 days) rejects outright.
   *
   * The thresholds are deliberately strict. A saved file holds only the
   * *remaining* queue, so a near-finished import can be down to a handful of
   * tracks, and Spotify exports do contain occasional genuinely-identical
   * second-precision timestamps. A loose test would re-stamp those real listen
   * dates — corrupting good data to rescue bad. The bug being migrated produced
   * identical timestamps for 100% of entries, so demanding 90% costs nothing.
   */
  static hasCollapsedTimestamps(data: SerializedScrobble[]): boolean {
    const MIN_SAMPLE = 20;
    const MIN_SHARE = 0.9;
    if (data.length < MIN_SAMPLE) {
      return false;
    }
    const counts = new Map<number, number>();
    let mostCommon = 0;
    for (const d of data) {
      const next = (counts.get(d.timestamp) || 0) + 1;
      counts.set(d.timestamp, next);
      if (next > mostCommon) {
        mostCommon = next;
      }
    }
    return mostCommon >= data.length * MIN_SHARE;
  }

  static deserializeScrobbles(data: SerializedScrobble[]): Scrobble[] {
    const inferReTagged = data.some((d) => d.reTagged === undefined)
      && StateManager.hasCollapsedTimestamps(data);
    return data.map((d) => new Scrobble(
      d.track,
      d.artist,
      new Date(d.timestamp),
      d.album,
      d.reTagged ?? inferReTagged,
    ));
  }

  public async saveState(state: ScrobbleState): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(state, STATE_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  /**
   * Saves only if the incoming state is at least as far along as the stored one.
   *
   * The record is shared by every tab on the origin, and a plain `put` is
   * last-writer-wins. During a freeze, several tabs persist at once and the
   * slowest commit lands last — so a tab that had scrobbled 110 tracks could
   * overwrite one that had scrobbled 130, and the handoff would then upload
   * twenty tracks that were already sent. The same happens with a single tab
   * whenever a stale auto-save resolves late.
   *
   * `originalSucceededCount` is the cumulative total across every session of
   * the import, so it is monotonic by construction and is the right ordering
   * key. Ties fall back to the shorter remaining queue.
   *
   * That comparison is only meaningful *within one import*. Two tabs holding
   * different selections have unrelated counts, so the one with the bigger
   * number wins regardless of which record the user is actually working on —
   * a stale tab can silently replace a live import with its own queue. When
   * both records carry an identity and the identities differ, this therefore
   * throws rather than returning false: "a write I correctly dropped because
   * better progress is already on disk" and "a write I could not place at all"
   * must not look the same to the halt path, which uses a successful persist
   * as its evidence that the queue on disk is safe to hand over.
   *
   * A missing identity on either side means the question cannot be asked —
   * states written before this existed have none — and falls back to the
   * count comparison, the same degradation used everywhere else here.
   *
   * Read and write share one `readwrite` transaction, which IndexedDB runs to
   * completion against the store before starting another — so this is a real
   * compare-and-set rather than a racy read-then-write.
   *
   * Returns whether the write happened.
   */
  public async saveStateIfAhead(state: ScrobbleState): Promise<boolean> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(STATE_KEY);
      let wrote = false;
      let mismatch = false;
      req.onsuccess = () => {
        const existing = req.result as ScrobbleState | undefined;
        if (existing && existing.importId && state.importId
          && existing.importId !== state.importId) {
          mismatch = true;
          return;
        }
        const ahead = !existing
          || (state.originalSucceededCount || 0) > (existing.originalSucceededCount || 0)
          || ((state.originalSucceededCount || 0) === (existing.originalSucceededCount || 0)
            && state.tracks.length <= existing.tracks.length);
        /*
          Equal progress is not equal knowledge.

          Two tabs on the same import can hold identical counts and identical
          queues while only one of them has a send in flight, and only that one
          carries the second it was sent under. The counts make the other tab
          look equally far along, so it qualifies as "ahead" and overwrites —
          taking the pinned second with it. The retry then mints a fresh one,
          and Last.fm stores that as a second, phantom play of a track the user
          heard once.

          Losing that field is therefore a step backwards even when nothing
          else is, so a write that would drop it is refused. A write that
          *changes* it is fine: that tab is the one doing the sending.
        */
        const dropsPendingSecond = !!existing
          && !!existing.pendingReTagTimestampSec
          && !state.pendingReTagTimestampSec
          && (state.originalSucceededCount || 0) === (existing.originalSucceededCount || 0)
          && state.tracks.length === existing.tracks.length;
        if (ahead && !dropsPendingSecond) {
          /*
            Named failures are carried forward rather than being allowed to
            decide the write.

            They describe tracks that are no longer in the queue, so no index
            reconstructs them and only the tab that performed the take-back
            has ever seen the list. A sibling that is genuinely further along
            legitimately wins this comparison while knowing nothing about
            them, and would erase the only record of what a background job
            rejected.

            Preserved rather than refused, deliberately: refusing would fail a
            persist the halt path reads as "the queue on disk is not safe to
            hand over", trading a lost *list* for a blocked handover. Within
            one import this list only ever grows — a fresh selection mints a
            new identity, which is rejected above — so keeping the longer side
            cannot resurrect anything a user cleared.
          */
          const existingFailures = existing && Array.isArray(existing.failedDetails)
            ? existing.failedDetails
            : [];
          const incomingFailures = Array.isArray(state.failedDetails)
            ? state.failedDetails
            : [];
          const toWrite = existingFailures.length > incomingFailures.length
            ? { ...state, failedDetails: existingFailures }
            : state;
          store.put(toWrite, STATE_KEY);
          wrote = true;
        }
      };
      tx.oncomplete = () => {
        db.close();
        if (mismatch) {
          reject(new Error('saved state belongs to a different import'));
          return;
        }
        resolve(wrote);
      };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  public async loadState(): Promise<ScrobbleState | null> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(STATE_KEY);
      req.onsuccess = () => { db.close(); resolve(req.result ?? null); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  }

  public async clearState(): Promise<void> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(STATE_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  /**
   * Deletes the saved state only if it is still the one the caller decided
   * about.
   *
   * `clearState` deletes whatever is there. That is right for a user pressing
   * "start over", and wrong for anything that first *reads* the state, decides
   * it should go, and then deletes it: the disk is shared with every other tab
   * on this origin, and between the read and the delete a sibling can save a
   * completely different import over it. The delete does not know that and
   * takes the new queue with it — a queue that may exist nowhere else.
   *
   * So the read and the delete share one `readwrite` transaction, which
   * IndexedDB runs to completion against the store before starting another.
   * The same compare-and-set `saveStateIfAhead` relies on.
   *
   * `matches` is given the state as it exists at delete time, or `null` when
   * there is none, and decides whether it is the one to remove. It must be
   * synchronous: an `await` inside it would end the transaction.
   *
   * Returns what the disk holds afterwards, so a caller can tell "the queue I
   * condemned is gone" from "something else is there now, leave it alone".
   */
  public async clearStateIfMatching(
    matches: (saved: ScrobbleState | null) => boolean,
  ): Promise<{ removed: boolean; remaining: ScrobbleState | null }> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(STATE_KEY);
      let removed = false;
      let remaining: ScrobbleState | null = null;
      let thrown: unknown = null;
      req.onsuccess = () => {
        const existing = (req.result as ScrobbleState | undefined) ?? null;
        try {
          if (matches(existing)) {
            store.delete(STATE_KEY);
            removed = true;
            return;
          }
        } catch (e) {
          /*
            A predicate that throws has not decided anything, so nothing is
            deleted and the caller is told rather than left reading a "no
            match" that never happened.
          */
          thrown = e;
          return;
        }
        remaining = existing;
      };
      tx.oncomplete = () => {
        db.close();
        if (thrown) {
          reject(thrown);
          return;
        }
        resolve({ removed, remaining });
      };
      tx.onerror = () => { db.close(); reject(tx.error); };
    });
  }

  public async hasSavedState(): Promise<boolean> {
    const db = await this.openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).count(STATE_KEY);
      req.onsuccess = () => { db.close(); resolve(req.result > 0); };
      req.onerror = () => { db.close(); reject(req.error); };
    });
  }

  public exportToFile(state: ScrobbleState): void {
    const date = new Date().toISOString().slice(0, 10);
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `scrobblify-progress-${date}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  public async importFromFile(file: File): Promise<ScrobbleState> {
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file);
    });
    const data = JSON.parse(text);

    // Only the fields needed to actually restore scrobbles are required.
    // Everything else is optional metadata that is defaulted below, so an
    // older or partial progress file (e.g. one without "userName") can still
    // be imported successfully.
    const requiredFields: Array<keyof ScrobbleState> = [
      'totalTracks', 'completedIndices', 'failedIndices', 'tracks',
    ];

    for (const field of requiredFields) {
      if (!(field in data)) {
        throw new Error(`Invalid state file: missing required field "${field}"`);
      }
    }

    return {
      userName: '',
      sendTimestamps: [],
      lastReTagTimestampSec: 0,
      burstCount: 0,
      dailyCount: 0,
      dailyCountDate: new Date().toISOString().split('T')[0],
      savedAt: new Date().toISOString(),
      ...data,
      // Files written before these existed have no lineage information, so the
      // best available approximation is this file's own totals. Applied after
      // the spread so a genuinely absent field is filled rather than kept as
      // undefined.
      originalTotalTracks: data.originalTotalTracks || data.totalTracks,
      originalSucceededCount: data.originalSucceededCount
        ?? (Array.isArray(data.completedIndices) ? data.completedIndices.length : 0),
    } as ScrobbleState;
  }

  private openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
}
