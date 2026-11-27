/**
 * Per-UTC-day bands for spare-day placement (#175).
 *
 * Pure bookkeeping with no I/O, in its own module so the rules that keep a
 * spent second from being handed out twice can be tested without a scheduler.
 * That is the failure that matters here: Last.fm discards a repeated
 * (artist, track, second) while reporting it accepted, so a reused second is a
 * play lost without any error to detect, and the play it replaces cannot be
 * brought back by the user.
 *
 * Each UTC day inside `SPARE_DAY_WINDOW_SECONDS` has its own descending band.
 * A day's floor is the lowest second the job has spent there; the next second
 * handed out on that day is strictly below it, and nothing ever raises it. A
 * day with no floor has spent nothing, because every job that carries these
 * bands was created with them and has recorded every send since. (A job from
 * before them has no bands at all and does not come here; see
 * `008_day_bands.sql`.)
 */
import { importBudget, utcDayStartSec } from '../../src/shared/lastfm/dailyCap';
import { PRESENT_MARGIN_SECONDS, SPARE_DAY_WINDOW_SECONDS } from './timestamps';

const SECONDS_PER_DAY = 24 * 60 * 60;

export interface DayBands {
  /** UTC midnight -> lowest second spent that day. */
  floors: Record<string, number>;
  /** UTC midnights known to hold no more room for this import. */
  full: number[];
}

/**
 * The stored bands cannot be read. Never guessed at: treating unreadable bands
 * as empty is how a spent second gets reused.
 */
export class DayBandsUnreadableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DayBandsUnreadableError';
  }
}

/** The bands a new job starts with: nothing spent anywhere. */
export function emptyDayBandsJson(): string {
  return JSON.stringify({ floors: {}, full: [] });
}

/**
 * Reads `jobs.day_bands`. Null for a job from before spare days, which keeps
 * the old behaviour; throws for a value that should be bands and is not.
 */
export function parseDayBands(raw: string | null | undefined): DayBands | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DayBandsUnreadableError('Day bands are not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object'
    || !parsed.floors || typeof parsed.floors !== 'object' || Array.isArray(parsed.floors)
    || !Array.isArray(parsed.full)) {
    throw new DayBandsUnreadableError('Day bands have an unexpected shape');
  }
  const floors: Record<string, number> = {};
  Object.keys(parsed.floors).forEach((day) => {
    const floor = parsed.floors[day];
    if (!Number.isInteger(Number(day)) || !Number.isFinite(floor) || floor <= 0) {
      throw new DayBandsUnreadableError('Day bands hold an invalid floor');
    }
    floors[day] = floor;
  });
  const full: number[] = parsed.full.map((day: unknown) => {
    if (!Number.isInteger(day)) {
      throw new DayBandsUnreadableError('Day bands hold an invalid full day');
    }
    return day as number;
  });
  return { floors, full };
}

export function serializeDayBands(bands: DayBands): string {
  return JSON.stringify(bands);
}

/** UTC midnights of the days a spare-day placement may use, newest first. */
export function ladderDays(nowSec: number): number[] {
  const oldest = nowSec - SPARE_DAY_WINDOW_SECONDS;
  const days: number[] = [];
  for (let day = utcDayStartSec(nowSec); day + SECONDS_PER_DAY - 1 >= oldest; day -= SECONDS_PER_DAY) {
    days.push(day);
  }
  return days;
}

export interface DayBounds {
  /** Highest second the day may hand out next. */
  startSec: number;
  /** Lowest second it may ever hand out: its midnight, or the window's edge. */
  bottomSec: number;
  /** How many seconds lie between them. */
  seconds: number;
  /** The day has nothing left, for good. */
  exhausted: boolean;
  /** Today, before it has enough seconds to hold a whole import budget. */
  notYetOpen: boolean;
}

/**
 * Where a day's next second comes from.
 *
 * Today's band hangs from the present margin, so just after midnight it has
 * only a few seconds. Starting it then would walk the band to midnight and
 * leave most of the day's budget with no seconds to spend, for good, since a
 * band never goes back up. So today is not opened until it can hold a whole
 * budget; the other days always can. (This is what `DAY_RESUME_OFFSET_SECONDS`
 * waits for on the one-day path.)
 */
export function dayBounds(daySec: number, nowSec: number, floorSec: number | undefined): DayBounds {
  const top = Math.min(daySec + SECONDS_PER_DAY - 1, nowSec - PRESENT_MARGIN_SECONDS);
  const startSec = floorSec === undefined ? top : Math.min(top, floorSec - 1);
  const bottomSec = Math.max(daySec, nowSec - SPARE_DAY_WINDOW_SECONDS);
  const seconds = startSec - bottomSec + 1;
  const unopenedToday = daySec === utcDayStartSec(nowSec) && floorSec === undefined;
  if (seconds <= 0) {
    return {
      startSec, bottomSec, seconds, exhausted: !unopenedToday, notYetOpen: unopenedToday,
    };
  }
  return {
    startSec,
    bottomSec,
    seconds,
    exhausted: false,
    notYetOpen: unopenedToday && seconds < importBudget(0),
  };
}

/**
 * The bands after a batch spent seconds down to `lowestSec` on `daySec` (null
 * when it spent none), and learned that `fullDays` have no room left. Floors
 * only ever move down, and days that have left the window are dropped.
 */
export function afterSend(
  bands: DayBands,
  daySec: number,
  lowestSec: number | null,
  fullDays: number[],
  nowSec: number,
): DayBands {
  const oldestDay = utcDayStartSec(nowSec - SPARE_DAY_WINDOW_SECONDS);
  const floors: Record<string, number> = {};
  Object.keys(bands.floors).forEach((day) => {
    if (Number(day) >= oldestDay) {
      floors[day] = bands.floors[day];
    }
  });
  if (lowestSec !== null) {
    const key = String(daySec);
    floors[key] = floors[key] === undefined ? lowestSec : Math.min(floors[key], lowestSec);
  }
  const full = Array.from(new Set([...bands.full, ...fullDays]))
    .filter((day) => day >= oldestDay)
    .sort((a, b) => a - b);
  return { floors, full };
}
