/**
 * Tests for the client's take-back path.
 *
 * The Vue app has no unit runner. Its only automated coverage is Playwright,
 * which drives a dev server with no `VUE_APP_BACKGROUND_API`, so the entire
 * background/handoff layer is inert there and cannot be exercised at all.
 * These run through the worker's esbuild runner instead, which resolves the
 * `@/` alias and stubs `posthog-js`, so the real module is under test.
 *
 * Scope is deliberately narrow: `stateFromExport` is the single function that
 * decides what a browser believes after the server hands its queue back, and
 * everything it drops is dropped permanently.
 */
import { stateFromExport } from '@/services/BackgroundHandoff';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

const NOW_MS = Date.now();

function exportPayload(over: Record<string, unknown> = {}) {
  return {
    usedRanges: [],
    usedRangesIncomplete: false,
    usedRangesFloorSec: 0,
    scrobbledByServer: 10,
    state: {
      totalTracks: 2,
      completedIndices: [],
      failedIndices: [],
      tracks: [
        {
          artist: 'Remaining', track: 'One', album: '', timestamp: NOW_MS, reTagged: true,
        },
        {
          artist: 'Remaining', track: 'Two', album: '', timestamp: NOW_MS, reTagged: true,
        },
      ],
    },
    failures: [],
    ...over,
  };
}

function main() {
  console.log('\n-- the worker\'s named failures survive take-back --');
  {
    /*
      Export removes failed tracks from the queue: they are neither remaining
      nor completed, so no index into `tracks` can describe them. They come
      back in a separate list, and dropping that list is how a user ends up
      being told "3 tracks were rejected" before take-back and nothing at all
      afterwards. A track they cannot name is a track they cannot re-add.
    */
    const state = stateFromExport(exportPayload({
      failures: [
        {
          artist: 'Gone', track: 'Forever', album: 'B', reason: 'Artist ignored', code: 1,
        },
        {
          artist: 'Also', track: 'Gone', album: '', reason: 'Timestamp too old', code: 3,
        },
      ],
    }), 'listener', 100);

    check('a state is returned at all', state !== null);
    const failed = (state && state.failedDetails) || [];
    check('both failures are carried', failed.length === 2, failed);
    check('with the track name', failed[0] && failed[0].track === 'Forever', failed[0]);
    check('with the artist', failed[0] && failed[0].artist === 'Gone', failed[0]);
    check('and with the reason, verbatim',
      failed[1] && failed[1].reason === 'Timestamp too old', failed[1]);
    check('the failed tracks are not put back in the queue',
      !!state && state.tracks.every((t) => t.track !== 'Forever'), state && state.tracks);
    check('and the returned queue is only the remaining tracks',
      !!state && state.tracks.length === 2, state && state.tracks.length);
  }

  console.log('\n-- a queue with nothing rejected carries no failure list --');
  {
    // Absent rather than empty: every save writes this, and an empty array on
    // every ordinary queue is noise in a file users are asked to send in.
    const state = stateFromExport(exportPayload(), 'listener', 100);
    check('no failedDetails key is added', !!state && state.failedDetails === undefined,
      state && state.failedDetails);
    check('failedIndices is still the empty list the importer requires',
      !!state && Array.isArray(state.failedIndices) && state.failedIndices.length === 0);
  }

  console.log('\n-- a worker too old to report failures is not an error --');
  {
    const state = stateFromExport(exportPayload({ failures: undefined }), 'listener', 100);
    check('the take-back still succeeds', state !== null);
    check('and claims no failures it cannot describe',
      !!state && state.failedDetails === undefined, state && state.failedDetails);
  }

  console.log('\n-- malformed failure entries are dropped, not trusted --');
  {
    const state = stateFromExport(exportPayload({
      failures: [
        { artist: '', track: '', reason: 'nothing to name' },
        { artist: 'Real', track: 'Enough' },
        null,
      ],
    }), 'listener', 100);
    const failed = (state && state.failedDetails) || [];
    check('the nameless entry is dropped', failed.length === 1, failed);
    check('the named one is kept', failed[0] && failed[0].track === 'Enough', failed[0]);
    check('and is given a reason rather than "undefined"',
      failed[0] && failed[0].reason === 'Rejected by Last.fm', failed[0]);
  }

  console.log('\n-- a pinned second comes back on the head of the queue --');
  {
    /*
      The pin is the one thing in an export that cannot be recovered from the
      timestamp alone: every re-tagged track carries a non-zero cosmetic
      placeholder too. Losing it hands the browser a track it may already have
      scrobbled with permission to invent a different second for it.
    */
    const pinMs = NOW_MS - 3 * 86400 * 1000;
    const state = stateFromExport(exportPayload({
      state: {
        totalTracks: 2,
        completedIndices: [],
        failedIndices: [],
        tracks: [
          {
            artist: 'Ordinary', track: 'Track', album: '', timestamp: NOW_MS, reTagged: true,
          },
          {
            artist: 'Pinned',
            track: 'Retry',
            album: '',
            timestamp: pinMs,
            reTagged: true,
            pendingRetry: true,
          },
        ],
      },
    }), 'listener', 100);

    check('the pin is reported as a pending second',
      !!state && state.pendingReTagTimestampSec === Math.floor(pinMs / 1000),
      state && state.pendingReTagTimestampSec);
    check('and its track is moved to the head, where the pin is applied',
      !!state && state.tracks[0].track === 'Retry', state && state.tracks.map((t) => t.track));
  }

  console.log('\n-- an export with no tracks left is not a queue --');
  {
    const state = stateFromExport(exportPayload({
      state: {
        totalTracks: 0, completedIndices: [], failedIndices: [], tracks: [],
      },
    }), 'listener', 100);
    check('nothing is restored', state === null, state);
  }

  if (failures > 0) {
    console.log(`\n${failures} FAILURES`);
    process.exit(1);
  }
  console.log('\nALL PASSED');
}

main();
