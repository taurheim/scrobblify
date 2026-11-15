/**
 * Tests for the stale-snapshot record.
 *
 * Take-back saves the exported queue *before* it cancels the job, because
 * cancelling first and then failing to save would destroy the only copy. When
 * the cancel is refused — which is exactly what happens once the export claim
 * has lapsed — the server still holds the real queue and is free to carry on
 * sending it. What is on disk is then a photograph of where the import used to
 * be, and restoring it scrobbles everything that happened since a second time.
 *
 * "Unresolved ownership" does not cover this: it asks whether the server still
 * owns the queue, and answers itself the moment the job finishes. That is the
 * moment both release paths read the saved queue back and offer Resume.
 *
 * The record therefore names the queue as well as the job. A discard that
 * fails leaves it on disk indefinitely, and by then the browser may be holding
 * a later import that nothing is wrong with.
 */
import { storage } from './stubs/dom';
import {
  setStaleSnapshot,
  staleSnapshotRecord,
  clearStaleSnapshotIf,
  sameStaleSnapshot,
  savedQueueIsStale,
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

function main() {
  console.log('\n-- the photograph is condemned --');
  {
    storage.clear();
    setStaleSnapshot('job-1', 'import-abc');
    const record = staleSnapshotRecord();
    check('the record survives a write and read', !!record, record);
    check('it names the job', !!record && record.jobId === 'job-1', record);
    check('the copy it was written about is stale',
      savedQueueIsStale(record, 'import-abc'));
  }

  console.log('\n-- a later import is not --');
  {
    storage.clear();
    /*
      The discard can fail — the record exists precisely so that a failure to
      clear the disk is caught later. By then the user may have started again
      and saved real local progress the server has never seen. Condemning that
      because a record happens to be lying around destroys the only copy.
    */
    setStaleSnapshot('job-1', 'import-abc');
    check('a different queue on disk is left alone',
      !savedQueueIsStale(staleSnapshotRecord(), 'import-xyz'));
  }

  console.log('\n-- an empty disk condemns nothing --');
  {
    storage.clear();
    setStaleSnapshot('job-1', 'import-abc');
    check('nothing on disk is not a stale queue',
      !savedQueueIsStale(staleSnapshotRecord(), null));
  }

  console.log('\n-- no record means no interference --');
  {
    storage.clear();
    check('an unrecorded queue is never stale', !savedQueueIsStale(null, 'import-abc'));
    check('and there is nothing to read', staleSnapshotRecord() === null);
  }

  console.log('\n-- two unnamed queues compare equal --');
  {
    storage.clear();
    /*
      Identities only come out empty when `crypto.getRandomValues` is missing.
      In that browser a photograph wrongly kept duplicates plays on a public
      profile, which cannot be undone, while a queue wrongly discarded costs a
      re-import. The fail-safe direction is to discard.
    */
    setStaleSnapshot('job-1', '');
    check('an unnamed photograph condemns an unnamed queue',
      savedQueueIsStale(staleSnapshotRecord(), ''));
  }

  console.log('\n-- a confirmed take-back clears it --');
  {
    storage.clear();
    setStaleSnapshot('job-1', 'import-abc');
    const seen = staleSnapshotRecord();
    clearStaleSnapshotIf((current) => sameStaleSnapshot(current, seen));
    check('the record is gone', staleSnapshotRecord() === null);
    check('and the queue is no longer condemned',
      !savedQueueIsStale(staleSnapshotRecord(), 'import-abc'));
  }

  console.log('\n-- but not one a sibling wrote in the meantime --');
  {
    storage.clear();
    /*
      Every caller reads the record, does asynchronous work, and only then
      retracts it. A second tab condemning its own photograph in that gap
      replaces the record; retracting blindly would clear a condemnation
      nobody made and offer that tab's live photograph back.
    */
    setStaleSnapshot('job-1', 'import-abc');
    const seen = staleSnapshotRecord();
    setStaleSnapshot('job-2', 'import-xyz');
    clearStaleSnapshotIf((current) => sameStaleSnapshot(current, seen));
    const after = staleSnapshotRecord();
    check('the sibling record survives', !!after && after.importId === 'import-xyz', after);
    check('and still condemns its own queue',
      savedQueueIsStale(staleSnapshotRecord(), 'import-xyz'));
  }

  console.log('\n-- the same job under a new identity is a different record --');
  {
    storage.clear();
    /*
      A take-back can be retried, and each attempt saves a queue under a
      freshly rotated identity. The record from the first attempt does not
      describe the second attempt's copy.
    */
    setStaleSnapshot('job-1', 'import-abc');
    const seen = staleSnapshotRecord();
    setStaleSnapshot('job-1', 'import-def');
    clearStaleSnapshotIf((current) => sameStaleSnapshot(current, seen));
    const after = staleSnapshotRecord();
    check('the newer record survives', !!after && after.importId === 'import-def', after);
  }

  console.log('\n-- a record that cannot be read is not a record --');
  {
    storage.clear();
    /*
      An older build wrote the bare job id, and a quota failure can truncate a
      write. Neither can say which queue it was about, so neither is allowed to
      condemn one: the disk here may be a fresh import.
    */
    storage.setItem('scrobblify.background.staleSnapshot', 'job-1');
    check('a bare job id is ignored', staleSnapshotRecord() === null);
    check('so nothing is condemned by it',
      !savedQueueIsStale(staleSnapshotRecord(), 'import-abc'));
  }

  if (failures > 0) {
    console.log(`\n${failures} FAILURES`);
    process.exit(1);
  }
  console.log('\nALL PASSED');
}

main();
