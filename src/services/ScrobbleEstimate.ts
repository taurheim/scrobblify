import { BURST_WINDOW_MS } from '@/services/RateLimitTracker';
import { LASTFM_DAILY_CAP, importBudget, nextUtcDayStartSec } from '@/shared/lastfm/dailyCap';

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;

/*
  Rough cost of one send: LastFm's enforced 250ms buffer, the request round
  trip and the bookkeeping between tracks. Only the same-day duration depends
  on it; the number of days is set by the daily cap alone.
*/
export const ESTIMATED_MS_PER_SCROBBLE = MS_PER_SECOND;

/** Most an import sends into one UTC day that holds nothing else. */
export const IMPORT_DAILY_BUDGET = importBudget(0);

/*
  Whether the background offer would take a queue this size: big enough to be
  offered (MIN_TRACKS_FOR_BACKGROUND) and small enough for the worker to
  accept. `trackLimit` is 0 when the offer is off for this browser.
*/
export function backgroundCanFinish(trackCount: number, trackLimit: number): boolean {
  return trackLimit > 0 && trackCount >= LASTFM_DAILY_CAP && trackCount <= trackLimit;
}

export interface ScrobbleEstimate {
  /** Tracks this sitting can send before today's budget runs out. */
  todayCount: number;
  /** Roughly how long sending `todayCount` takes, burst pacing included. */
  todayMs: number;
  /** Further UTC days needed for the rest. */
  laterDays: number;
  /** When the next UTC day, and with it a fresh budget, begins. */
  nextDayStartsMs: number;
}

export interface EstimateInput {
  trackCount: number;
  /** Plays stamped at send time, which all land on today's UTC day. */
  reTaggedCount: number;
  /** Scrobbles Last.fm already holds for today's UTC day. */
  storedToday: number;
  burstLimit: number;
  nowMs: number;
}

function sendDurationMs(count: number, burstLimit: number): number {
  if (count <= 0) { return 0; }
  const burst = Math.max(1, burstLimit);
  const fullBursts = Math.ceil(count / burst) - 1;
  // A burst cannot restart before the window that holds it has rolled over.
  const burstMs = Math.max(BURST_WINDOW_MS, burst * ESTIMATED_MS_PER_SCROBBLE);
  return fullBursts * burstMs + (count - fullBursts * burst) * ESTIMATED_MS_PER_SCROBBLE;
}

/*
  Only re-tagged plays are limited by today's budget (see DailyCap.ts): each
  is stamped "now", so they all count against today's UTC day, and once that
  is spent the run stops until midnight UTC. Real-dated plays land on their own
  past days and go out in the same sitting. The queue is chronological, so the
  re-tagged plays come first: with no budget left today, nothing is sent.
*/
export function estimateScrobbleTime(input: EstimateInput): ScrobbleEstimate {
  const realDated = input.trackCount - input.reTaggedCount;
  const todayReTagged = Math.min(input.reTaggedCount, importBudget(input.storedToday));
  const laterReTagged = input.reTaggedCount - todayReTagged;
  const blocked = input.reTaggedCount > 0 && todayReTagged === 0;
  const todayCount = blocked ? 0 : realDated + todayReTagged;
  return {
    todayCount,
    todayMs: sendDurationMs(todayCount, input.burstLimit),
    laterDays: Math.ceil(laterReTagged / IMPORT_DAILY_BUDGET),
    nextDayStartsMs: nextUtcDayStartSec(Math.floor(input.nowMs / MS_PER_SECOND)) * MS_PER_SECOND,
  };
}

export function formatDuration(ms: number): string {
  const totalMinutes = Math.round(ms / MS_PER_MINUTE);
  if (totalMinutes < 1) {
    const seconds = Math.max(1, Math.ceil(ms / MS_PER_SECOND));
    return `${seconds} second${seconds === 1 ? '' : 's'}`;
  }
  if (totalMinutes < 60) {
    return `${totalMinutes} minute${totalMinutes === 1 ? '' : 's'}`;
  }
  const hours = Math.round(totalMinutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}
