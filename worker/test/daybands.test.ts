/**
 * Per-day band bookkeeping.
 *
 * What these guard is the rule that a spent second is never handed out again:
 * Last.fm discards a repeated (artist, track, second) while reporting it
 * accepted, so a floor that moved up, a day wrongly treated as unspent or
 * bands read as empty are plays lost with nothing to detect.
 */
import {
  DayBandsUnreadableError,
  afterSend,
  dayBounds,
  emptyDayBandsJson,
  ladderDays,
  parseDayBands,
  serializeDayBands,
} from '../src/daybands';
import { SPARE_DAY_WINDOW_SECONDS, PRESENT_MARGIN_SECONDS } from '../src/timestamps';
import { importBudget, utcDayStartSec } from '../../src/shared/lastfm/dailyCap';

const NOW = 1_800_000_000;
const TODAY = utcDayStartSec(NOW);
const DAY = 86400;

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

function unreadable(raw: string): boolean {
  try {
    parseDayBands(raw);
    return false;
  } catch (error) {
    return error instanceof DayBandsUnreadableError;
  }
}

console.log('\n-- reading the stored bands --');
{
  check('a job from before spare days has none', parseDayBands(null) === null);
  const fresh = parseDayBands(emptyDayBandsJson());
  check('a new job starts with nothing spent', !!fresh && Object.keys(fresh.floors).length === 0
    && fresh.full.length === 0, fresh);
  const round = parseDayBands(serializeDayBands({ floors: { [String(TODAY)]: NOW - 500 }, full: [TODAY - DAY] }));
  check('bands survive a round trip',
    !!round && round.floors[String(TODAY)] === NOW - 500 && round.full[0] === TODAY - DAY, round);
  check('invalid JSON is refused, not read as empty', unreadable('{nope'));
  check('so is a value of the wrong shape', unreadable('[]') && unreadable('{"floors":[],"full":[]}')
    && unreadable('{"floors":{},"full":"x"}'));
  check('and a floor that is not a second', unreadable('{"floors":{"1":"x"},"full":[]}')
    && unreadable('{"floors":{"1":0},"full":[]}') && unreadable('{"floors":{"x":5},"full":[]}'));
}

console.log('\n-- which days a placement may use --');
{
  const days = ladderDays(NOW);
  check('today first, then each earlier day', days[0] === TODAY && days[1] === TODAY - DAY, days.slice(0, 2));
  check('down to the day holding the edge of the window',
    days[days.length - 1] === utcDayStartSec(NOW - SPARE_DAY_WINDOW_SECONDS), days);
  check('and not a day beyond it', days.length === 11, days.length);
}

console.log('\n-- where a day\'s next second comes from --');
{
  const past = dayBounds(TODAY - 2 * DAY, NOW, undefined);
  check('a past day with nothing spent starts at its last second',
    past.startSec === TODAY - 2 * DAY + DAY - 1 && past.bottomSec === TODAY - 2 * DAY
    && !past.exhausted && !past.notYetOpen, past);
  const spent = dayBounds(TODAY - 2 * DAY, NOW, TODAY - 2 * DAY + 70000);
  check('once spent it continues below the floor, never at it', spent.startSec === TODAY - 2 * DAY + 69999, spent);
  const open = dayBounds(TODAY, NOW, undefined);
  check('today hangs from the present margin', open.startSec === NOW - PRESENT_MARGIN_SECONDS && !open.notYetOpen, open);
  const early = dayBounds(TODAY, TODAY + 60, undefined);
  check('just after midnight today is not opened: it has no room for a budget', early.notYetOpen && !early.exhausted, early);
  const justOpen = dayBounds(TODAY, TODAY + 1200, undefined);
  check('and opens once it can hold one', !justOpen.notYetOpen && justOpen.seconds >= importBudget(0), justOpen);
  const used = dayBounds(TODAY, TODAY + 60, TODAY + 10);
  check('but a band already started there carries on', !used.notYetOpen, used);
  const done = dayBounds(TODAY - DAY, NOW, TODAY - DAY);
  check('a day whose band reached midnight is exhausted for good', done.exhausted, done);
  const edge = dayBounds(utcDayStartSec(NOW - SPARE_DAY_WINDOW_SECONDS), NOW, undefined);
  check('the oldest day starts at the window\'s edge, not its midnight',
    edge.bottomSec === NOW - SPARE_DAY_WINDOW_SECONDS, edge);
}

console.log('\n-- recording what a batch spent --');
{
  const bands = parseDayBands(emptyDayBandsJson())!;
  const one = afterSend(bands, TODAY - DAY, TODAY - 1000, [TODAY], NOW);
  check('the day\'s floor is the lowest second spent', one.floors[String(TODAY - DAY)] === TODAY - 1000, one);
  check('full days are remembered', one.full.includes(TODAY), one);
  const two = afterSend(one, TODAY - DAY, TODAY - 1500, [], NOW);
  check('a later batch lowers it', two.floors[String(TODAY - DAY)] === TODAY - 1500, two);
  const never = afterSend(two, TODAY - DAY, TODAY - 900, [], NOW);
  check('and a floor never rises, whatever it is told', never.floors[String(TODAY - DAY)] === TODAY - 1500, never);
  const none = afterSend(two, TODAY - DAY, null, [], NOW);
  check('a batch that spent nothing leaves it alone', none.floors[String(TODAY - DAY)] === TODAY - 1500, none);
  const gone = afterSend(
    { floors: { [String(TODAY - 12 * DAY)]: 5 }, full: [TODAY - 12 * DAY] }, TODAY, null, [], NOW,
  );
  check('days that have left the window are dropped',
    Object.keys(gone.floors).length === 0 && gone.full.length === 0, gone);
  check('the input is not changed', Object.keys(bands.floors).length === 0 && bands.full.length === 0);
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
