import Scrobble from '@/models/Scrobble';

export interface SerializedScrobble {
  track: string;
  artist: string;
  album: string;
  timestamp: number;
}

export interface ScrobbleState {
  userName: string;
  totalTracks: number;
  completedIndices: number[];
  failedIndices: number[];
  tracks: SerializedScrobble[];
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
    }));
  }

  static deserializeScrobbles(data: SerializedScrobble[]): Scrobble[] {
    return data.map((d) => new Scrobble(d.track, d.artist, new Date(d.timestamp), d.album));
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

    const requiredFields: Array<keyof ScrobbleState> = [
      'userName', 'totalTracks', 'completedIndices', 'failedIndices',
      'tracks', 'burstCount', 'dailyCount', 'dailyCountDate', 'savedAt',
    ];

    for (const field of requiredFields) {
      if (!(field in data)) {
        throw new Error(`Invalid state file: missing required field "${field}"`);
      }
    }

    return data as ScrobbleState;
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
