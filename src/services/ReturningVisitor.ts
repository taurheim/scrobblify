import LastFm from '@/api/LastFm';
import StateManager from '@/services/StateManager';
import * as background from '@/services/BackgroundScrobbling';

/** Which Home page a visitor gets. */
export type ReturningState =
  | { kind: 'none' }
  | { kind: 'saved'; username: string | null; signedIn: boolean; done: number; total: number }
  | { kind: 'server_job'; username: string | null; done: number; total: number }
  | { kind: 'username_only'; username: string };

const ENDED_STATES = ['completed', 'failed', 'cancelled', 'expired', 'reaped'];

export function progressLabel(done: number, total: number): string {
  const pct = total > 0 ? Math.floor((100 * done) / total) : 0;
  return `${done.toLocaleString()} / ${total.toLocaleString()} · ${pct}%`;
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

  /*
    Only a *live* job (sending, paused or stopped by errors, all of which keep
    their place) is shown as running. One that is signed out or on hold falls
    through to the plain card; the status page on /scrobble explains it. A
    record the server doesn't know, or whose job has ended, is dropped.
  */
  const importId = background.handedOverImport(username);
  if (importId) {
    const status = await background.importStatus(importId);
    if (status && status.live) {
      return {
        kind: 'server_job', username, done: status.scrobbledCount, total: status.totalTracks,
      };
    }
    if (status && (!status.known || ENDED_STATES.includes(status.state || ''))) {
      background.clearHandedOverImport();
    }
  }

  let saved = null;
  try {
    saved = await stateManager.loadState();
  } catch {
    saved = null;
  }
  if (saved && saved.totalTracks > 0) {
    const total = saved.originalTotalTracks || saved.totalTracks;
    const done = typeof saved.originalSucceededCount === 'number'
      ? saved.originalSucceededCount
      : saved.completedIndices.length;
    return {
      kind: 'saved', username, signedIn: api.isAuthenticated(), done, total,
    };
  }

  if (username) {
    return { kind: 'username_only', username };
  }
  return { kind: 'none' };
}
