/*
  Last.fm stores at most LASTFM_DAILY_CAP scrobbles per UTC calendar day, and the
  day is the one the *scrobble's timestamp* falls on, not the day it was sent.
  Everything past the cap is answered exactly like a stored play (accepted=1,
  ignored=0, no ignoredMessage) and then discarded, so nothing in the
  track.scrobble reply reveals it.

  Undocumented; measured from production telemetry against what users' Last.fm
  libraries actually hold (2026-11): every heavy import day stored exactly 750,
  the user's own listening on that day included, and a run whose re-tagged
  timestamps straddled UTC midnight stored 750 on each side. Last.fm announced
  the lower cap on 2026-06-24 without giving a number. Before that the app paced
  to ~2,700 per rolling 24h, so roughly 1,950 plays per heavy user per day were
  counted as scrobbled and never stored.

  Shared by the SPA and the background worker: both budget against the same
  day, so they must agree on its size and headroom.
*/

export const LASTFM_DAILY_CAP = 750;

// Left free on each day an import writes to, for the user's own listening. Their
// normal scrobbler (Spotify's integration, a desktop app) counts against the
// same cap, and anything it sends after the cap is full is silently lost too —
// so filling the day to 750 would cost them the rest of that day's real plays.
export const OWN_LISTENING_HEADROOM = 50;

const SECONDS_PER_DAY = 24 * 60 * 60;

/** Unix seconds of the UTC midnight that starts the day containing `sec`. */
export function utcDayStartSec(sec: number): number {
  return Math.floor(sec / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

/** Unix seconds of the next UTC midnight after `sec`. */
export function nextUtcDayStartSec(sec: number): number {
  return utcDayStartSec(sec) + SECONDS_PER_DAY;
}

/**
 * How many more scrobbles an import may send into a day that already holds
 * `storedThatDay`. Never negative.
 */
export function importBudget(storedThatDay: number): number {
  return Math.max(0, LASTFM_DAILY_CAP - OWN_LISTENING_HEADROOM - storedThatDay);
}
