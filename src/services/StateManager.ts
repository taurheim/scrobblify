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
      req.onsuccess = () => {
        const existing = req.result as ScrobbleState | undefined;
        const ahead = !existing
          || (state.originalSucceededCount || 0) > (existing.originalSucceededCount || 0)
          || ((state.originalSucceededCount || 0) === (existing.originalSucceededCount || 0)
            && state.tracks.length <= existing.tracks.length);
        if (ahead) {
          store.put(state, STATE_KEY);
          wrote = true;
        }
      };
      tx.oncomplete = () => { db.close(); resolve(wrote); };
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
