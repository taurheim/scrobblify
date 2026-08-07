/**
 * Free-space search over the seconds a lineage has already scrobbled into.
 *
 * Lives in `shared/` rather than beside its only caller so that the worker's
 * test suite can exercise it. It is pure arithmetic with no DOM or network
 * dependency, and it decides where re-tagged plays land — a mistake here does
 * not throw, it silently loses plays, because Last.fm discards a repeated
 * (artist, track, timestamp) while reporting it accepted.
 */

export interface UsedRange {
  from: number;
  to: number;
}

/**
 * Finds a contiguous span of `length` seconds that no used range covers.
 *
 * Searches downwards from `ceiling`, because the browser's allocator walks
 * *upwards* from whatever floor it is given, and the most recent seconds are
 * the least likely to have expired out of Last.fm's window by the time they
 * are actually sent.
 *
 * The earlier strategy — reserve below the global minimum of everything used —
 * degraded badly. A single preserved original near the 13-day boundary dragged
 * that minimum down to where no room was left, and each take-back cycle walked
 * it down another band. Searching for a gap instead reuses the space between
 * bands, which is where almost all of the window actually is.
 *
 * Returns null when the window is too congested to fit one. That is a real
 * outcome after enough take-back cycles: the caller then omits the reservation
 * and the allocator falls back to its default band. The fallback may collide,
 * so it is strictly worse — but it is exactly the behaviour that existed
 * before reservations, and there is nothing better available once the window
 * is genuinely full.
 */
export function findFreeRange(
  used: UsedRange[],
  ceiling: number,
  floorLimit: number,
  length: number,
): UsedRange | null {
  if (!Number.isFinite(ceiling) || !Number.isFinite(floorLimit) || length <= 0) {
    return null;
  }
  /*
    Descending by upper bound. This ordering is what makes an early return
    safe: the first range examined has the highest `to` of all of them, so
    nothing else can possibly cover the space above it.
  */
  const sorted = used
    .filter((r) => Number.isFinite(r.from) && Number.isFinite(r.to) && r.to >= r.from)
    .sort((a, b) => b.to - a.to);

  let cursor = ceiling;
  for (const range of sorted) {
    if (range.to < floorLimit) {
      // Everything from here down is outside the window entirely.
      break;
    }
    if (range.to >= cursor) {
      // Covers or touches the cursor. Step below it and keep descending.
      cursor = Math.min(cursor, range.from - 1);
      // eslint-disable-next-line no-continue
      continue;
    }
    if (cursor - range.to > length) {
      /*
        A gap between this range's top and the cursor. The span is taken at
        the *top* of the gap: higher seconds are fresher, and a reservation
        sitting just above an existing band would be the first thing a later
        cycle's search collided with.
      */
      return { from: cursor - length, to: cursor };
    }
    cursor = Math.min(cursor, range.from - 1);
  }
  if (cursor - floorLimit > length) {
    return { from: cursor - length, to: cursor };
  }
  return null;
}
