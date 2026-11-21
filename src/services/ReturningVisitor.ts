import LastFm from '@/api/LastFm';
import StateManager from '@/services/StateManager';
import * as background from '@/services/BackgroundScrobbling';

/** Which Home page a visitor gets. */
export type ReturningState =
  | { kind: 'none' }
  | { kind: 'saved'; username: string | null; signedIn: boolean; done: number; total: number }
  | { kind: 'server_job'; username: string | null; done: number; total: number }
  | { kind: 'username_only'; username: string };

// Job end states plus handoff end states (the import route can return a handoff row).
const ENDED_STATES = ['completed', 'failed', 'cancelled', 'expired', 'reaped'];

// Home waits on this before rendering, so it gets less time than the scrobble step.
const RETURNING_STATUS_TIMEOUT_MS = 3000;

export function progressLabel(done: number, total: number): string {
  const shown = total > 0 ? Math.min(done, total) : done;
  const pct = total > 0 ? Math.floor((100 * shown) / total) : 0;
  return `${shown.toLocaleString()} / ${total.toLocaleString()} · ${pct}%`;
}

/** Whether two Last.fm usernames are the same account (case-insensitive). */
export function sameUser(a: string | null | undefined, b: string | null | undefined): boolean {
  return typeof a === 'string' && typeof b === 'string' && a.trim() !== '' && b.trim() !== ''
    && a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function progressPct(done: number, total: number): number {
  return total > 0 ? Math.min(100, (100 * done) / total) : 0;
}

/**
 * Decides the Home state, most specific first: a job this browser handed to
 * the worker, then saved progress, then a remembered username.
 *
 * Never throws: an unreadable IndexedDB or an unreachable worker just means
 * less is known, and the visitor gets a simpler page.
 */
export async function detectReturning(
  api: LastFm,
  stateManager: StateManager,
): Promise<ReturningState> {
  const username = api.getUserName();
  // Started now so the IndexedDB read overlaps the worker check.
  const savedLoad = stateManager.loadState().catch(() => null);

  /*
    Only a *live* job (sending, paused or stopped by errors, all of which keep
    their place) is shown as running. One that is signed out or on hold falls
    through to the plain card; the status page on /scrobble explains it. A
    record the server doesn't know, or whose job has ended, is dropped.
  */
  const importId = background.handedOverImport(username);
  if (importId) {
    const status = await background.importStatus(importId, RETURNING_STATUS_TIMEOUT_MS);
    if (status && status.live) {
      return {
        kind: 'server_job', username, done: status.scrobbledCount, total: status.totalTracks,
      };
    }
    if (status && (!status.known || ENDED_STATES.includes(status.state || ''))) {
      background.clearHandedOverImport();
    }
  }

  const saved = await savedLoad;
  if (saved && saved.totalTracks > 0) {
    const total = saved.originalTotalTracks || saved.totalTracks;
    const indexCount = Array.isArray(saved.completedIndices) ? saved.completedIndices.length : 0;
    const done = typeof saved.originalSucceededCount === 'number'
      ? saved.originalSucceededCount
      : indexCount;
    const savedUser = typeof saved.userName === 'string' && saved.userName ? saved.userName : null;
    const owner = savedUser || username;
    const ownerSignedIn = sameUser(savedUser, username) && api.isAuthenticated();
    return {
      kind: 'saved', username: owner, signedIn: ownerSignedIn, done, total,
    };
  }

  if (username) {
    return { kind: 'username_only', username };
  }
  return { kind: 'none' };
}
