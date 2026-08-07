/**
 * Timestamp assignment tests.
 *
 * The invariants here are the ones that silently corrupt a user's Last.fm
 * profile if they break: duplicate timestamps get deduped away, future ones
 * get ignore code 4, and stale ones get code 3.
 */
import {
  assignTimestamps,
  isWithinWindow,
  reconciliationWindow,
  normalizeForMatch,
  WINDOW_SECONDS,
  PRESENT_MARGIN_SECONDS,
} from '../src/timestamps';

const NOW = 1_800_000_000;

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

function tracks(timestamps: number[]) {
  return timestamps.map((ts, i) => ({
    artist: `Artist ${i}`,
    track: `Track ${i}`,
    originalTimestampSec: ts,
  }));
}

function main() {
  console.log('\n-- window membership --');
  check('a listen from an hour ago is in window', isWithinWindow(NOW - 3600, NOW));
  check('a listen from 20 days ago is not', !isWithinWindow(NOW - 20 * 86400, NOW));
  check('the far edge of the window is in', isWithinWindow(NOW - WINDOW_SECONDS, NOW));
  check('one second past the edge is out', !isWithinWindow(NOW - WINDOW_SECONDS - 1, NOW));
  check('a future listen is not in window', !isWithinWindow(NOW + 100, NOW));
  check('now itself is not in window', !isWithinWindow(NOW, NOW));
  check('zero is not a timestamp', !isWithinWindow(0, NOW));
  check('a negative is not a timestamp', !isWithinWindow(-5, NOW));
  check('NaN is not a timestamp', !isWithinWindow(NaN, NOW));
  check('1970 is not in window', !isWithinWindow(1, NOW));

  console.log('\n-- the case that motivates all of this --');
  // The client assigns one Date to every re-tagged listen, so this is what a
  // real import looks like: 50 identical, ancient timestamps.
  const shared = NOW - 400 * 86400;
  const r1 = assignTimestamps(tracks(new Array(50).fill(shared)), NOW, 0);
  const set1 = new Set(r1.assigned.map((a) => a.timestampSec));
  check('50 identical originals become 50 distinct timestamps', set1.size === 50, set1.size);
  check('none are preserved', r1.preservedCount === 0);
  check('all are in the past', r1.assigned.every((a) => a.timestampSec <= NOW - PRESENT_MARGIN_SECONDS));
  check('all are inside the window',
    r1.assigned.every((a) => a.timestampSec >= NOW - WINDOW_SECONDS));
  check('indices are batch-relative and ordered',
    r1.assigned.every((a, i) => a.index === i));

  console.log('\n-- preserving real timestamps --');
  const mixed = tracks([
    NOW - 3600,
    NOW - 500 * 86400,
    NOW - 2 * 86400,
    NOW - 500 * 86400,
  ]);
  const r2 = assignTimestamps(mixed, NOW, 0);
  check('recent listens keep their real time', r2.assigned[0].timestampSec === NOW - 3600);
  check('and are flagged as preserved', r2.assigned[0].preservedOriginal);
  check('old listens do not', r2.assigned[1].timestampSec !== NOW - 500 * 86400);
  check('and are flagged as not preserved', !r2.assigned[1].preservedOriginal);
  check('preserved count is right', r2.preservedCount === 2, r2.preservedCount);
  check('all four are distinct', new Set(r2.assigned.map((a) => a.timestampSec)).size === 4);

  console.log('\n-- a synthetic value must not steal a preserved one --');
  // Track 0 is old (synthetic); track 1's real timestamp is exactly the second
  // the naive allocator would hand track 0. Assigning as we go would collide.
  const ceiling = NOW - PRESENT_MARGIN_SECONDS;
  const collide = tracks([NOW - 900 * 86400, ceiling]);
  const r3 = assignTimestamps(collide, NOW, 0);
  check('the real timestamp is kept', r3.assigned[1].timestampSec === ceiling);
  check('the synthetic one moved out of the way', r3.assigned[0].timestampSec !== ceiling);
  check('both survive', new Set(r3.assigned.map((a) => a.timestampSec)).size === 2);

  console.log('\n-- duplicate reals --');
  const dupReal = NOW - 5 * 86400;
  const r4 = assignTimestamps(tracks([dupReal, dupReal, dupReal]), NOW, 0);
  check('the first keeps it', r4.assigned[0].timestampSec === dupReal);
  check('the rest do not', r4.assigned[1].timestampSec !== dupReal
    && r4.assigned[2].timestampSec !== dupReal);
  check('only one counts as preserved', r4.preservedCount === 1, r4.preservedCount);
  check('all distinct', new Set(r4.assigned.map((a) => a.timestampSec)).size === 3);

  console.log('\n-- the floor carries across batches --');
  // Two batches in the same second must not reuse seconds, or Last.fm may
  // dedupe the second batch away against the first.
  const b1 = assignTimestamps(tracks(new Array(50).fill(shared)), NOW, 0);
  const b2 = assignTimestamps(tracks(new Array(50).fill(shared)), NOW, b1.syntheticFloor);
  const all = new Set([
    ...b1.assigned.map((a) => a.timestampSec),
    ...b2.assigned.map((a) => a.timestampSec),
  ]);
  check('100 timestamps across two batches, no overlap', all.size === 100, all.size);
  check('the floor descends', b2.syntheticFloor < b1.syntheticFloor);
  check('batch two is strictly below batch one',
    Math.max(...b2.assigned.map((a) => a.timestampSec))
      < Math.min(...b1.assigned.map((a) => a.timestampSec)));

  console.log('\n-- the floor wraps rather than falling out of the window --');
  const staleFloor = NOW - WINDOW_SECONDS - 10_000;
  const r5 = assignTimestamps(tracks(new Array(50).fill(shared)), NOW, staleFloor);
  check('a stale floor is not continued from',
    r5.assigned.every((a) => a.timestampSec > staleFloor));
  check('wrapped values are still in window',
    r5.assigned.every((a) => a.timestampSec >= NOW - WINDOW_SECONDS));
  check('wrapped values are still in the past',
    r5.assigned.every((a) => a.timestampSec <= NOW - PRESENT_MARGIN_SECONDS));

  const futureFloor = NOW + 10_000;
  const r6 = assignTimestamps(tracks(new Array(5).fill(shared)), NOW, futureFloor);
  check('a floor in the future is ignored',
    r6.assigned.every((a) => a.timestampSec <= NOW - PRESENT_MARGIN_SECONDS));

  console.log('\n-- a full job never leaves the window --');
  // 162k tracks is the admission ceiling; simulate the floor marching that far.
  let floor = 0;
  let ok = true;
  for (let i = 0; i < 162_000 / 50; i += 1) {
    const r = assignTimestamps(tracks(new Array(50).fill(shared)), NOW, floor);
    if (!r.assigned.every((a) => a.timestampSec >= NOW - WINDOW_SECONDS
      && a.timestampSec <= NOW - PRESENT_MARGIN_SECONDS)) {
      ok = false;
      break;
    }
    floor = r.syntheticFloor;
  }
  check('162k synthetic timestamps all stay valid at a fixed now', ok);

  console.log('\n-- reconciliation window --');
  check('no timestamps, no window', reconciliationWindow([]) === null);
  const w = reconciliationWindow([100, 50, 75])!;
  // from/to are strictly exclusive on user.getRecentTracks; without widening,
  // the first and last scrobble of the batch are invisible and get re-sent.
  check('widened below', w.fromSec === 49, w);
  check('widened above', w.toSec === 101, w);

  console.log('\n-- match normalisation --');
  check('case folded', normalizeForMatch('The Beatles') === normalizeForMatch('the beatles'));
  check('whitespace collapsed', normalizeForMatch('A  B') === normalizeForMatch('A B'));
  check('trimmed', normalizeForMatch(' A ') === normalizeForMatch('A'));
  check('curly apostrophes folded',
    normalizeForMatch('Don\u2019t') === normalizeForMatch("Don't"));
  check('distinct tracks stay distinct',
    normalizeForMatch('Yesterday') !== normalizeForMatch('Yesterdays'));

  console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
