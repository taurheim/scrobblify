/**
 * Tests for the carried-failure lifecycle.
 *
 * A background job reports the tracks it wrote off only in its export, and
 * export *removes* those tracks from the queue — they are neither remaining
 * nor completed, so no index into the restored queue can describe them. Once
 * the job is cancelled the server's copy is gone. This list is therefore the
 * only surviving description of what happened to those plays, and every place
 * it can be dropped is a place where a user is told a track failed and then
 * never told which one.
 *
 * It lives in the localStorage lineage rather than the saved state because
 * `beginHandoff` clears the saved state once the worker owns the queue, so
 * after a second handover the previous job's failures exist nowhere on disk.
 * The lineage is the only structure that spans the whole chain of owners.
 */
import { storage } from './stubs/dom';
import {
  mergeCarriedFailures,
  recordCarriedFailures,
  getHandoffLineage,
  setHandoffLineage,
  clearHandoffLineage,
  clearCarriedFailures,
} from '@/services/BackgroundScrobbling';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

function fail(artist: string, track: string, reason = 'Rejected by Last.fm') {
  return {
    artist, track, album: '', reason,
  };
}

function main() {
  console.log('\n-- a second handover merges rather than replaces --');
  {
    storage.clear();
    /*
      Each export reports only what *that* job rejected. A queue can pass
      through the server more than once, and `beginHandoff` clears the saved
      state on the way out, so the earlier job's list survives only here.
      Replacing rather than merging silently discards the first pass.
    */
    recordCarriedFailures([fail('First', 'Pass')]);
    const merged = recordCarriedFailures([fail('Second', 'Pass')]);
    check('both passes are kept', merged.failures.length === 2, merged.failures);
    check('the earlier pass comes first',
      merged.failures[0].track === 'Pass' && merged.failures[0].artist === 'First',
      merged.failures);
    const lineage = getHandoffLineage();
    check('and they are on disk, not just returned',
      !!lineage && (lineage.carriedFailures || []).length === 2,
      lineage);
  }

  console.log('\n-- the same failure arriving twice is not duplicated --');
  {
    storage.clear();
    /*
      A take-back can be retried, and a retried export re-reports the same
      rejections. Showing a user the same track twice implies two plays were
      lost where one was.
    */
    recordCarriedFailures([fail('Same', 'Track', 'Artist ignored')]);
    const merged = recordCarriedFailures([fail('Same', 'Track', 'Artist ignored')]);
    check('the repeat is collapsed', merged.failures.length === 1, merged.failures);
  }

  console.log('\n-- a different reason for the same track is kept --');
  {
    storage.clear();
    /*
      The reason is what tells the user whether to re-add the track. Two
      different verdicts on one track are two different things to say.
    */
    const merged = mergeCarriedFailures(
      [fail('One', 'Track', 'Artist ignored')],
      [fail('One', 'Track', 'Timestamp too old')],
    );
    check('both reasons survive', merged.failures.length === 2, merged.failures);
  }

  console.log('\n-- the cap trims the newest and says how many --');
  {
    /*
      Trimmed from the *end*, unlike the range cap which keeps the highest.
      The oldest entries are the ones the user has had least opportunity to
      see, and an incomplete list that does not admit it reads as exhaustive:
      a user shown five names when twelve were rejected re-adds five and
      believes they are done.
    */
    const many = Array.from({ length: 520 }, (_, i) => fail(`A${i}`, `T${i}`));
    const merged = mergeCarriedFailures([], many);
    check('the list is capped', merged.failures.length === 500, merged.failures.length);
    check('the oldest are the ones kept', merged.failures[0].track === 'T0', merged.failures[0]);
    check('and the shortfall is reported', merged.dropped === 20, merged.dropped);
    const again = mergeCarriedFailures(merged.failures, [fail('New', 'One')], merged.dropped);
    check('a prior shortfall accumulates', again.dropped === 21, again.dropped);
  }

  console.log('\n-- entries that name nothing are refused --');
  {
    /*
      An entry with neither an artist nor a title tells the user a play was
      lost while being unable to say which, which is worse than silence.
    */
    const merged = mergeCarriedFailures([], [
      { artist: '', track: '', album: '', reason: 'Rejected' },
      fail('Real', 'Track'),
    ]);
    check('only the nameable one survives', merged.failures.length === 1, merged.failures);
  }

  console.log('\n-- clearing the lineage preserves the failures --');
  {
    storage.clear();
    /*
      `clearHandoffLineage` runs on the take-back path — the *same* path that
      produces this list. If the clear dropped it, the list could never
      survive the moment it was created.
    */
    recordCarriedFailures([fail('Kept', 'Across')]);
    clearHandoffLineage();
    const lineage = getHandoffLineage();
    check('the record still exists', lineage !== null, lineage);
    check('and still names the track',
      !!lineage && (lineage.carriedFailures || []).length === 1
      && (lineage.carriedFailures || [])[0].track === 'Across',
      lineage);
  }

  console.log('\n-- clearing still removes an empty lineage --');
  {
    storage.clear();
    setHandoffLineage({
      originalTotalTracks: 5,
      originalSucceededCount: 1,
      reTagUsedRanges: [],
      reTagKnownFromSec: 0,
      reTagCursorSec: 0,
    });
    clearHandoffLineage();
    check('nothing is left behind',
      window.localStorage.getItem('scrobblify.background.lineage') === null);
  }

  console.log('\n-- a fresh import drops them, and only them --');
  {
    storage.clear();
    /*
      Unlike the rest of the lineage, this list is about a particular
      selection's tracks rather than seconds on the account's timeline. The
      cursor must survive — walking back over used seconds loses plays
      silently — while a previous import's rejections must not be reported
      against a run that never had them.
    */
    setHandoffLineage({
      originalTotalTracks: 5,
      originalSucceededCount: 1,
      reTagUsedRanges: [],
      reTagKnownFromSec: 0,
      reTagCursorSec: 1700000000,
    });
    recordCarriedFailures([fail('Old', 'Import')]);
    clearCarriedFailures();
    const lineage = getHandoffLineage();
    check('the failures are gone',
      !!lineage && (lineage.carriedFailures || []).length === 0, lineage);
    check('the cursor is not',
      !!lineage && lineage.reTagCursorSec === 1700000000, lineage);
  }

  console.log('\n-- an unwritable lineage does not throw --');
  {
    storage.clear();
    /*
      Not fail-closed, deliberately. This list only ever describes plays that
      have already been written off; losing it costs a name, where refusing to
      continue would cost the rest of the import.
    */
    storage.failWrites = true;
    let threw = false;
    let merged;
    try {
      merged = recordCarriedFailures([fail('Unwritable', 'Track')]);
    } catch {
      threw = true;
    }
    storage.failWrites = false;
    check('the caller is not broken', !threw);
    check('and still gets the list for this session',
      !!merged && merged.failures.length === 1, merged);
  }

  if (failures > 0) {
    console.log(`\n${failures} FAILURES`);
    process.exit(1);
  }
  console.log('\nALL PASSED');
}

main();
