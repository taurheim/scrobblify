/**
 * Re-tag range allocation tests.
 *
 * `findFreeRange` is client code, but it is pure arithmetic and it decides
 * where a browser's re-tagged plays land after a take-back. Getting it wrong
 * does not throw: the browser allocates into seconds the worker already used,
 * Last.fm discards the repeats while reporting them accepted, and the user
 * quietly loses plays. So it is tested here, where there is a test runner.
 */
import { findFreeRange } from '../../src/shared/lastfm/retagRanges';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

const CEILING = 1_000_000;
const FLOOR = 0;

/** Whether a candidate span touches any used range at all. */
function overlapsAny(span: { from: number; to: number }, used: { from: number; to: number }[]) {
  return used.some((r) => span.from <= r.to && r.from <= span.to);
}

console.log('\n-- an empty window allocates straight below the ceiling --');
{
  const got = findFreeRange([], CEILING, FLOOR, 100);
  check('a range is found', got !== null);
  check('it ends at the ceiling', got!.to === CEILING, got);
  check('and is exactly the length asked for', got!.to - got!.from === 100, got);
}

console.log('\n-- the result never overlaps anything already used --');
{
  const cases: { name: string; used: { from: number; to: number }[] }[] = [
    { name: 'one band well below the ceiling', used: [{ from: 500, to: 600 }] },
    { name: 'a band touching the ceiling', used: [{ from: CEILING - 50, to: CEILING }] },
    { name: 'a band straddling the ceiling', used: [{ from: CEILING - 50, to: CEILING + 500 }] },
    {
      name: 'several disjoint bands',
      used: [
        { from: 1000, to: 2000 },
        { from: 5000, to: 6000 },
        { from: 900_000, to: 950_000 },
      ],
    },
    {
      name: 'overlapping bands',
      used: [
        { from: 1000, to: 5000 },
        { from: 4000, to: 4500 },
        { from: 4900, to: 9000 },
      ],
    },
    {
      name: 'a band nested wholly inside another',
      used: [
        { from: 100, to: 900_000 },
        { from: 5000, to: 6000 },
      ],
    },
    {
      name: 'adjacent bands with no gap between them',
      used: [
        { from: 100, to: 200 },
        { from: 201, to: 300 },
        { from: 301, to: 400 },
      ],
    },
  ];
  for (const c of cases) {
    const got = findFreeRange(c.used, CEILING, FLOOR, 100);
    check(`${c.name}: a range is found`, got !== null, c.used);
    if (got) {
      check(`${c.name}: it overlaps nothing`, !overlapsAny(got, c.used), { got, used: c.used });
      check(`${c.name}: it stays inside the window`,
        got.from >= FLOOR && got.to <= CEILING, got);
      check(`${c.name}: it is the requested length`, got.to - got.from === 100, got);
    }
  }
}

console.log('\n-- a congested window refuses rather than overlapping --');
{
  /*
    The caller must be able to tell "no room" from "here is a range", because
    the fallback when there is no room is the pre-reservation behaviour. A
    range returned here that overlapped would be worse than returning null.
  */
  const full = [{ from: FLOOR, to: CEILING }];
  check('a fully used window yields nothing', findFreeRange(full, CEILING, FLOOR, 100) === null);

  const nearlyFull = [{ from: FLOOR, to: CEILING - 50 }];
  check('a gap smaller than the request yields nothing',
    findFreeRange(nearlyFull, CEILING, FLOOR, 100) === null);

  const exactly = [{ from: FLOOR, to: CEILING - 100 }];
  check('a gap exactly the size of the request is not taken',
    findFreeRange(exactly, CEILING, FLOOR, 100) === null,
    findFreeRange(exactly, CEILING, FLOOR, 100));

  const justEnough = [{ from: FLOOR, to: CEILING - 101 }];
  const got = findFreeRange(justEnough, CEILING, FLOOR, 100);
  check('one second more than the request is taken', got !== null, got);
  check('and it clears the used range', got !== null && got.from > CEILING - 101, got);
}

console.log('\n-- ranges below the window bound are irrelevant --');
{
  /*
    This is the case that broke the previous "reserve below the global
    minimum" strategy: one preserved original near the 13-day boundary held
    the minimum down at the bottom of the window, leaving no runway. A gap
    search has to ignore it, because the space above it is genuinely free.
  */
  const used = [{ from: 10, to: 20 }];
  const got = findFreeRange(used, CEILING, 500_000, 100);
  check('an out-of-window range does not block allocation', got !== null, got);
  check('and the range sits at the top of the window',
    got !== null && got.to === CEILING, got);
}

console.log('\n-- repeated cycles keep finding fresh space --');
{
  /*
    Each take-back reserves another band. The point of searching for a gap
    rather than descending is that the window survives many cycles; the old
    strategy walked six hours further down every time and ran out.
  */
  const used: { from: number; to: number }[] = [];
  let allocated = 0;
  for (let i = 0; i < 20; i += 1) {
    const got = findFreeRange(used, CEILING, FLOOR, 1000);
    if (!got) { break; }
    check(`cycle ${i} overlaps nothing`, !overlapsAny(got, used), { got, used });
    used.push(got);
    allocated += 1;
  }
  check('twenty consecutive cycles all found room', allocated === 20, allocated);
}

console.log('\n-- malformed input is ignored rather than trusted --');
{
  const used = [
    { from: NaN, to: 5000 },
    { from: 1000, to: NaN },
    // Inverted: `to` below `from`. Treating this as a real range would let it
    // mask arbitrary space, or worse, be returned as an allocation.
    { from: 9000, to: 100 },
    { from: 500, to: 600 },
  ];
  const got = findFreeRange(used, CEILING, FLOOR, 100);
  check('a range is still found', got !== null, got);
  check('and it avoids the one well-formed range',
    got !== null && !overlapsAny(got, [{ from: 500, to: 600 }]), got);

  check('a non-finite ceiling yields nothing',
    findFreeRange([], NaN, FLOOR, 100) === null);
  check('a non-finite floor yields nothing',
    findFreeRange([], CEILING, NaN, 100) === null);
  check('a zero length yields nothing', findFreeRange([], CEILING, FLOOR, 0) === null);
  check('a negative length yields nothing', findFreeRange([], CEILING, FLOOR, -5) === null);
}

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILURES`);
if (failures > 0) {
  process.exit(1);
}
