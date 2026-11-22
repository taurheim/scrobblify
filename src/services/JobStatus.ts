/*
  What the status page shows for a background (server) job, worked out from
  whatever Home could learn about it: the job itself (with a worker session),
  the public import lookup (this browser handed it over), or only that the
  user has something running (another device). Pure, so the copy for every
  state lives in one place.

  Copy: docs/superpowers/specs/2026-11-20-guided-home-strings.md (`status.*`).
*/
import { DAY_FULL_REASON, importBudget } from '@/shared/lastfm/dailyCap';
import { ImportStatus, isJobDismissed, JobStatus } from '@/services/BackgroundScrobbling';

export type StatusAction =
  | 'pause' | 'resume' | 'reconnect' | 'signInAgain' | 'tryAgain'
  | 'signIn' | 'moveBack' | 'cancel' | 'checkItOut' | 'newImport';

/** A piece of the status line: text, a link, or a button running an action. */
export interface LinePart {
  text: string;
  href?: string;
  action?: StatusAction;
}

export interface StatusView {
  /** Progress over the whole import when known (handover record), else the job's. */
  bar: { done: number; total: number; pct: number } | null;
  /** One status line, as plain text. */
  line: string;
  /** The same line, with its links. */
  lineParts: LinePart[];
  /** Second line, may be ''. */
  sub: string;
  /** The server's reason, for needs_attention / failed. */
  tooltip: string;
  primary: StatusAction | null;
  primaryDisabled: boolean;
  /** Shown as buttons under the bar. */
  secondary: StatusAction[];
  /** Plays Last.fm rejected, for a completed job; 0 hides the note. */
  showRejected: number;
}

const SAFE_TO_CLOSE = 'Scrobbling remotely, it\'s safe to close this tab.';
const SIGN_IN_HINT = 'Sign in to manage it';
const MANAGE: StatusAction[] = ['moveBack', 'cancel'];
const DAY_SEC = 86400;

// ---- polling -------------------------------------------------------------

/*
  The status page refreshes itself while a job is active and the tab is
  visible, so the count moves without a reload. The worker only sends on its
  five-minute tick, so it asks once shortly after each tick rather than on a
  short fixed interval: `JOB_POLL_AFTER_RUN_SECONDS` past `nextRunAt` gives the
  tick time to reach this job and record its batches.
*/
const JOB_POLL_AFTER_RUN_SECONDS = 45;
// Never sooner, so a tick that runs late is not asked about every few seconds.
const JOB_POLL_MIN_SECONDS = 15;
// Never later, so a job waiting until tomorrow still notices a pause or cancel
// made from another device.
const JOB_POLL_MAX_SECONDS = 10 * 60;
// After a failed check, or from a worker that sends no `nextRunAt`.
export const JOB_POLL_FALLBACK_SECONDS = 60;
// How often the countdown and the poll deadline are re-evaluated.
export const JOB_CLOCK_TICK_MS = 15 * 1000;
// A job on hold for a full server asks this often whether a place opened up.
export const DORMANT_FULL_RECHECK_SECONDS = 5 * 60;

/** When to ask about an active job next: just after its next tick, within bounds. */
export function nextJobPollSec(job: JobStatus, nowSec: number): number {
  if (!job.nextRunAt) {
    return nowSec + JOB_POLL_FALLBACK_SECONDS;
  }
  return Math.min(
    nowSec + JOB_POLL_MAX_SECONDS,
    Math.max(nowSec + JOB_POLL_MIN_SECONDS, job.nextRunAt + JOB_POLL_AFTER_RUN_SECONDS),
  );
}

/** Whether the page should keep asking about this job, and when next. Null: don't. */
export function jobPollDueSec(job: JobStatus, nowSec: number): number | null {
  if (job.state === 'active' || job.state === 'pending') {
    return nextJobPollSec(job, nowSec);
  }
  if (job.state === 'dormant' && job.reconnectAvailable === false) {
    return nowSec + DORMANT_FULL_RECHECK_SECONDS;
  }
  return null;
}

// ---- formatting ----------------------------------------------------------

export function clockTime(sec: number): string {
  return new Date(sec * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** "4:25 PM", "12:20 AM tomorrow" or "12:20 AM on Friday", in local time. */
export function runTimeLabel(sec: number, nowSec: number): string {
  const at = new Date(sec * 1000);
  const now = new Date(nowSec * 1000);
  if (at.toDateString() === now.toDateString()) {
    return clockTime(sec);
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (at.toDateString() === tomorrow.toDateString()) {
    return `${clockTime(sec)} tomorrow`;
  }
  return `${clockTime(sec)} on ${at.toLocaleDateString([], { weekday: 'long' })}`;
}

/** "November 22". */
export function longDate(sec: number): string {
  return new Date(sec * 1000).toLocaleDateString([], { month: 'long', day: 'numeric' });
}

// ---- which jobs are shown ------------------------------------------------

/**
 * A job is shown when it exists, is not cancelled, and is not a finished job
 * the user dismissed ("Start a new import").
 */
export function isJobShown(job: JobStatus | null | undefined): job is JobStatus {
  return !!job && job.state !== 'cancelled' && !isJobDismissed(job.id);
}

/**
 * Overall progress for an import partly scrobbled in this browser before it
 * was handed over: the worker counts only the tracks it was handed. Plays this
 * browser gave up on before the handover count as done here, unlike
 * `originalSucceededCount`. Other browsers have no `originalTotal` and get the
 * worker's own numbers.
 */
export function overallProgress(
  originalTotal: number,
  status: { totalTracks: number; scrobbledCount: number },
): { done: number; total: number } {
  if (originalTotal > 0 && originalTotal >= status.totalTracks) {
    const remaining = status.totalTracks - status.scrobbledCount;
    const done = Math.min(originalTotal, Math.max(0, originalTotal - remaining));
    return { done, total: originalTotal };
  }
  return { done: status.scrobbledCount, total: status.totalTracks };
}

function bar(originalTotal: number, totalTracks: number, scrobbledCount: number): StatusView['bar'] {
  const { done, total } = overallProgress(originalTotal, { totalTracks, scrobbledCount });
  if (total <= 0) {
    return null;
  }
  const shown = Math.min(done, total);
  return { done: shown, total, pct: Math.floor((100 * shown) / total) };
}

function view(fields: Partial<StatusView> & { line: string }): StatusView {
  return {
    bar: null,
    lineParts: [{ text: fields.line }],
    sub: '',
    tooltip: '',
    primary: null,
    primaryDisabled: false,
    secondary: [],
    showRejected: 0,
    ...fields,
  };
}

function plain(parts: LinePart[]): string {
  return parts.map((p) => p.text).join('');
}

// ---- the views -----------------------------------------------------------

/** For a job read with this browser's worker session. */
export function viewFromJob(
  job: JobStatus,
  opts: { nowSec: number; originalTotal?: number },
): StatusView {
  const progress = bar(opts.originalTotal || 0, job.totalTracks, job.scrobbled);
  const reason = job.reason || '';
  const deadline = job.inactivityDeadline ? longDate(job.inactivityDeadline) : '';

  switch (job.state) {
    case 'pending':
    case 'active': {
      let line = `This will finish around ${longDate(job.estimatedCompletionSec || opts.nowSec)}`;
      if (reason === DAY_FULL_REASON) {
        const at = job.nextRunAt || job.waitingUntil;
        line = at
          ? `Can't upload any more due to last.fm rules. Will continue at ${runTimeLabel(at, opts.nowSec)}`
          : 'Can\'t upload any more due to last.fm rules. Will continue tomorrow';
      }
      return view({
        bar: progress, line, sub: SAFE_TO_CLOSE, primary: 'pause', secondary: MANAGE,
      });
    }
    case 'paused':
      return view({
        bar: progress, line: 'Paused', primary: 'resume', secondary: MANAGE,
      });
    case 'needs_reauth':
      return view({
        bar: progress,
        line: 'Last.fm signed us out',
        primary: 'signInAgain',
        primaryDisabled: job.reconnectAvailable === false,
        secondary: MANAGE,
      });
    case 'needs_attention':
      return view({
        bar: progress,
        line: 'Scrobblify stopped after repeated errors.',
        tooltip: reason,
        primary: 'tryAgain',
        secondary: MANAGE,
      });
    case 'dormant': {
      if (job.reconnectAvailable === false) {
        const lineParts: LinePart[] = [
          { text: 'Paused by scrobblify. A lot of people are scrobbling! Feel free to ' },
          { text: 'buy me a coffee', href: 'https://buymeacoffee.com/nikosavas' },
          { text: ' so I can run more servers! You can ' },
          { text: 'scrobble locally', action: 'moveBack' },
          { text: ' or try again later.' },
        ];
        return view({
          bar: progress,
          line: plain(lineParts),
          lineParts,
          primary: 'reconnect',
          primaryDisabled: true,
          secondary: MANAGE,
        });
      }
      if (job.dormantFrom === 'needs_reauth') {
        const before = deadline ? `before ${deadline}` : 'soon';
        return view({
          bar: progress,
          line: `Your sign-in to scrobblify expired. If you don't sign in ${before} we'll delete your progress from our servers (any tracks already scrobbled will stay on last.fm).`,
          primary: 'reconnect',
          secondary: MANAGE,
        });
      }
      if (job.dormantFrom === 'needs_attention') {
        const lineParts: LinePart[] = [
          { text: 'Scrobblify stopped after repeated errors. Please let me know at ' },
          { text: 'niko@savas.ca', href: 'mailto:niko@savas.ca' },
        ];
        return view({
          bar: progress, line: plain(lineParts), lineParts, primary: 'reconnect', secondary: MANAGE,
        });
      }
      const after = deadline ? `after ${deadline}` : 'later';
      return view({
        bar: progress,
        line: `You paused your scrobbling. We'll delete your progress from our servers ${after} (any tracks you've scrobbled will stay on last.fm)`,
        primary: 'reconnect',
        secondary: MANAGE,
      });
    }
    case 'exporting':
      return view({ bar: progress, line: 'Downloading progress from scrobblify servers...' });
    case 'completed':
      return view({
        bar: progress,
        line: 'Done',
        primary: 'checkItOut',
        secondary: ['newImport'],
        showRejected: job.failed > 0 ? job.failed : 0,
      });
    case 'failed':
      return view({
        bar: progress, line: 'Scrobbling stopped.', tooltip: reason, primary: 'newImport',
      });
    default:
      // A state added to the worker later: nothing more specific to say, keep the exits.
      return view({
        bar: progress, line: 'Scrobblify is scrobbling for you!', tooltip: reason, secondary: MANAGE,
      });
  }
}

/**
 * No worker session, but this browser handed the import over, so the public
 * lookup has its numbers. The finish date assumes a day's budget a day.
 */
export function viewFromImport(
  status: ImportStatus,
  opts: { nowSec: number; originalTotal?: number },
): StatusView {
  const remaining = Math.max(0, status.totalTracks - status.scrobbledCount);
  const finishSec = opts.nowSec + Math.ceil(remaining / importBudget(0)) * DAY_SEC;
  return view({
    bar: bar(opts.originalTotal || 0, status.totalTracks, status.scrobbledCount),
    line: `Scrobblify is scrobbling for you, expecting to finish around ${longDate(finishSec)}`,
    sub: SIGN_IN_HINT,
    primary: 'signIn',
  });
}

/** No session and no record here; the worker only says this user has a job running. */
export function viewOtherDevice(): StatusView {
  return view({ line: 'Scrobblify is scrobbling for you!', sub: SIGN_IN_HINT, primary: 'signIn' });
}
