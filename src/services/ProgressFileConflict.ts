import { ScrobbleState } from '@/services/StateManager';

/*
  Importing a progress file replaces this browser's single saved-progress slot
  and sends everything the file has not marked done. A file that is older than
  the saved progress, or one for an import that already finished, therefore
  re-sends plays Last.fm already has (#124). These checks find those cases so
  the user is asked first; they never refuse a file outright.
*/

export type ConflictReason = 'saved_newer' | 'other_import' | 'completed';

export interface ProgressCount {
  succeeded: number;
  total: number;
}

export interface CompletedImport {
  importId: string;
  originalTotalTracks: number;
  userName: string;
  completedAt: string;
}

const COMPLETED_KEY = 'scrobblify.completedImports';
const COMPLETED_MAX = 20;

export function progressOf(state: ScrobbleState): ProgressCount {
  return {
    succeeded: typeof state.originalSucceededCount === 'number'
      ? state.originalSucceededCount
      : (state.completedIndices || []).length,
    total: state.originalTotalTracks || state.totalTracks,
  };
}

interface Identity {
  importId?: string;
  originalTotalTracks: number;
  userName: string;
}

/*
  Same import: equal ids when both have one. Files from before ids existed
  fall back to the same size for the same (or an unknown) user.
*/
function sameImport(a: Identity, b: Identity): boolean {
  if (a.importId && b.importId) {
    return a.importId === b.importId;
  }
  const usersMatch = !a.userName || !b.userName || a.userName === b.userName;
  return usersMatch && a.originalTotalTracks === b.originalTotalTracks;
}

function identityOf(state: ScrobbleState): Identity {
  return {
    importId: state.importId,
    originalTotalTracks: progressOf(state).total,
    userName: state.userName || '',
  };
}

export function isSameImport(a: ScrobbleState, b: ScrobbleState): boolean {
  return sameImport(identityOf(a), identityOf(b));
}

/**
 * Why importing `file` over `saved` would lose progress, or null if it would
 * not. A file at or ahead of the saved progress for the same import is safe.
 */
export function savedProgressConflict(saved: ScrobbleState, file: ScrobbleState): ConflictReason | null {
  const savedCount = progressOf(saved);
  if (sameImport(identityOf(saved), identityOf(file))) {
    return savedCount.succeeded > progressOf(file).succeeded ? 'saved_newer' : null;
  }
  // Nothing scrobbled yet means nothing to lose by replacing it.
  return savedCount.succeeded > 0 ? 'other_import' : null;
}

function readCompleted(): CompletedImport[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(COMPLETED_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Remembers a finished import, so re-importing an old file for it can warn. */
export function recordCompletedImport(entry: CompletedImport): void {
  try {
    const kept = readCompleted().filter((c) => !(entry.importId && c.importId === entry.importId));
    kept.push(entry);
    localStorage.setItem(COMPLETED_KEY, JSON.stringify(kept.slice(-COMPLETED_MAX)));
  } catch {
    // Storage unavailable: the warning is a convenience, not a guarantee.
  }
}

/**
 * The finished import this file belongs to, if this browser finished one.
 * Without ids on both sides, only a file saved before that import finished
 * counts, since a later one cannot be a leftover of it.
 */
export function findCompletedImport(file: ScrobbleState): CompletedImport | null {
  const fileIdentity = identityOf(file);
  const savedAtMs = Date.parse(file.savedAt);
  return readCompleted().reverse().find((c) => {
    if (!sameImport(c, fileIdentity)) return false;
    if (c.importId && file.importId) return true;
    return Number.isNaN(savedAtMs) || savedAtMs < Date.parse(c.completedAt);
  }) || null;
}
