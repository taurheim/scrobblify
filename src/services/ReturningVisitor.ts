import LastFm from '@/api/LastFm';
import StateManager from '@/services/StateManager';
import * as background from '@/services/BackgroundScrobbling';
import { isJobShown } from '@/services/JobStatus';

/**
 * A background job Home shows as its status page, by where it was learned:
 * the job itself (worker session), the public import lookup (this browser
 * handed it over), or only that the user has one running (another device).
 * `originalTotal` is the whole import's size when this browser handed it over
 * and the record matches, else 0.
 */
export type ServerJobState =
  | { kind: 'job'; source: 'job'; username: string | null; job: background.JobStatus; originalTotal: number }
  | { kind: 'job'; source: 'import'; username: string | null; status: background.ImportStatus; originalTotal: number }
  | { kind: 'job'; source: 'other'; username: string | null };

/** Which Home page a visitor gets. `checking`: a worker session, but the job lookup went unanswered. */
export type ReturningState =
  | { kind: 'none' }
  | { kind: 'checking' }
  | { kind: 'saved'; username: string | null; signedIn: boolean; done: number; total: number }
  | ServerJobState
  | { kind: 'username_only'; username: string };

// Per tab, so a dismissed card stays dismissed when the visitor comes back to Home.
export const HOME_DISMISSED_KEY = 'scrobblify.home.dismissedReturning';

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
 * Decides the Home state, most specific first: a background job (the status
 * page), then saved progress, then a remembered username.
 *
 * The job comes from the worker session if this browser has one; else from
 * the public lookup of the import this browser handed over; else, with
 * neither, from whether the worker says this username has a job running.
 *
 * Never throws: an unreadable IndexedDB or an unreachable worker just means
 * less is known, and the visitor gets a simpler page. Except with a worker
 * session whose job lookup went unanswered: that browser most likely has a
 * job, and the start page would send it to /scrobble, which may find the job
 * with its longer budget and send it straight back. It gets `checking`.
 *
 * `knownJob` is a job just fetched elsewhere (/scrobble, as it sent the user
 * here), used instead of asking again. `timeoutMs` is the lookups' budget.
 */
export async function detectReturning(
  api: LastFm,
  stateManager: StateManager,
  opts: { knownJob?: background.JobStatus | null; timeoutMs?: number } = {},
): Promise<ReturningState> {
  const username = api.getUserName();
  const timeoutMs = opts.timeoutMs || RETURNING_STATUS_TIMEOUT_MS;
  // Started now so the IndexedDB read overlaps the worker checks.
  const savedLoad = stateManager.loadState().catch(() => null);

  const handedOver = background.handedOverImport(username);
  /*
    Who else is scrobbling is only asked by a browser with neither a worker
    session nor a record, and alongside the other lookups, so a stalled worker
    costs one timeout rather than two. A browser with a session never asks: an
    unanswered job lookup there must not read as "another device".
  */
  const askLive = (): Promise<boolean | null> => (!handedOver && username
    ? background.liveJobForUsername(username, timeoutMs)
    : Promise.resolve(null));
  const hadSession = !!background.getSession();
  const liveLoad = hadSession ? null : askLive();
  const [jobAnswer, recordStatus] = await Promise.all([
    opts.knownJob
      ? Promise.resolve({ answered: true, job: opts.knownJob })
      : background.fetchJobAnswer(timeoutMs),
    handedOver
      ? background.importStatus(handedOver.importId, timeoutMs)
      : Promise.resolve(null),
  ]);
  const { job } = jobAnswer;
  // A record the server doesn't know, or whose job has ended, is dropped.
  const recordEnded = !!recordStatus
    && (!recordStatus.known || ENDED_STATES.includes(recordStatus.state || ''));
  if (recordEnded) {
    background.clearHandedOverImport();
  }
  // Not a handoff still on its way: the record is only written once one is live.
  const record = handedOver && recordStatus && !recordEnded && !recordStatus.pending
    ? { ...handedOver, status: recordStatus }
    : null;

  if (isJobShown(job)) {
    /*
      The job doesn't name its import, so the record is taken to be this job's
      when the lookup of its import describes a job the same size. Otherwise
      its whole-import total would be applied to someone else's job.
    */
    const matches = !!record && record.status.totalTracks === job.totalTracks;
    /*
      A handover this browser made for another account than the one it
      remembers (a signed-out handover approved as someone else): the job is
      most likely theirs, so it is titled with no one rather than the wrong one.
    */
    const recordUser = background.handedOverImportUser();
    const titleUser = recordUser && !sameUser(recordUser, username) ? null : username;
    return {
      kind: 'job', source: 'job', username: titleUser, job, originalTotal: record && matches ? record.originalTotal : 0,
    };
  }
  if (!jobAnswer.answered && background.getSession()) {
    return { kind: 'checking' };
  }
  if (record) {
    return {
      kind: 'job', source: 'import', username, status: record.status, originalTotal: record.originalTotal,
    };
  }
  // A session the worker refused (401) was cleared by the job lookup, which
  // answers quickly, so the browser is asked about like one that never had it.
  const live = liveLoad || (hadSession && !background.getSession() ? askLive() : null);
  if (live && await live === true) {
    return { kind: 'job', source: 'other', username };
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
