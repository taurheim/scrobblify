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
