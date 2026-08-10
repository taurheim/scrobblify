/**
 * Tests for settling the worker's repeated seconds against real history.
 *
 * A pinned second is only harmless while Last.fm still accepts it. The queue
 * comes home and may not reach that track for days, so `resolveExportedRepeats`
 * turns the bet into an answer at take-back time. The two conclusions it is
 * allowed to draw are narrow, and the third case must stay unresolved: reading
 * "some other play sits on that second" as absence re-times a play that is
 * already on the account, and reading a truncated lookup as absence does the
 * same.
 */
import './stubs/dom';
import { resolveExportedRepeats, MAX_REPEAT_LOOKUPS } from '@/services/BackgroundHandoff';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}`, detail === undefined ? '' : JSON.stringify(detail));
  }
}

const BASE = 1_700_000_000;

function payload(tracks: any[], repeats: { i: number; sec: number }[]) {
  return {
    scrobbledByServer: 10,
    repeats,
    state: {
      totalTracks: tracks.length, completedIndices: [], failedIndices: [], tracks,
    },
  } as any;
}

function track(artist: string, name: string, sec: number) {
  return {
    artist, track: name, album: '', timestamp: sec * 1000, reTagged: false,
  };
}

function windowOf(plays: { artist: string; track: string; timestampSec: number }[]) {
  return async () => ({ plays, complete: true });
}

async function main() {
  console.log('\n-- a confirmed repeat leaves the queue --');
  {
    const e = payload(
      [track('A', 'One', BASE), track('B', 'Two', BASE + 1)],
      [{ i: 0, sec: BASE }],
    );
    const r = await resolveExportedRepeats(e, windowOf([
      { artist: 'a', track: 'one', timestampSec: BASE },
    ]));
    check('settled once', r.settled === 1 && r.freed === 0 && r.unresolved === 0, r);
    check('removed from the queue', e.state.tracks.length === 1
      && e.state.tracks[0].track === 'Two', e.state.tracks);
    /*
      The user's total is derived from what is left plus what the server got
      through. Moving a track out without crediting it reports the import as
      having shrunk, which is exactly the "where did my tracks go" the whole
      take-back path exists to avoid.
    */
    check('credited to the server', e.scrobbledByServer === 11, e.scrobbledByServer);
    check('totalTracks follows', e.state.totalTracks === 1, e.state.totalTracks);
  }

  console.log('\n-- an empty second frees the track to be re-timed --');
  {
    /*
      Last.fm stores at the timestamp submitted, so a second with nothing on it
      is proof this send never landed. That is the one case where minting a
      fresh second cannot duplicate anything.
    */
    const e = payload([track('A', 'One', BASE)], [{ i: 0, sec: BASE }]);
    const r = await resolveExportedRepeats(e, windowOf([]));
    check('freed', r.freed === 1 && r.settled === 0 && r.unresolved === 0, r);
    check('still in the queue', e.state.tracks.length === 1, e.state.tracks);
    check('now a re-tag', e.state.tracks[0].reTagged === true, e.state.tracks[0]);
    check('no credit given', e.scrobbledByServer === 10, e.scrobbledByServer);
  }

  console.log('\n-- a different play on the second is ambiguous, not absence --');
  {
    /*
      Last.fm rewrites names, so the entry sitting there may be this very play
      under a corrected title. Re-timing it would put a second copy on a public
      profile; leaving the pin is what an older client did for every entry, so
      the ambiguous case is never made worse than it already was.
    */
    const e = payload([track('A', 'One', BASE)], [{ i: 0, sec: BASE }]);
    const r = await resolveExportedRepeats(e, windowOf([
      { artist: 'Someone Else', track: 'Different', timestampSec: BASE },
    ]));
    check('unresolved', r.unresolved === 1 && r.freed === 0 && r.settled === 0, r);
    check('pin untouched', e.state.tracks[0].reTagged === false
      && e.state.tracks[0].timestamp === BASE * 1000, e.state.tracks[0]);
  }

  console.log('\n-- a truncated window is not an empty one --');
  {
    const e = payload([track('A', 'One', BASE)], [{ i: 0, sec: BASE }]);
    const r = await resolveExportedRepeats(e, async () => ({ plays: [], complete: false }));
    check('unresolved', r.unresolved === 1 && r.freed === 0, r);
    check('pin untouched', e.state.tracks[0].reTagged === false, e.state.tracks[0]);
  }

  console.log('\n-- a failed lookup leaves everything as it was --');
  {
    const e = payload([track('A', 'One', BASE)], [{ i: 0, sec: BASE }]);
    const r = await resolveExportedRepeats(e, async () => { throw new Error('offline'); });
    check('unresolved', r.unresolved === 1, r);
    check('pin untouched', e.state.tracks[0].reTagged === false, e.state.tracks[0]);
  }

  console.log('\n-- nearby seconds share one lookup, distant ones do not --');
  {
    const tracks = [track('A', 'One', BASE), track('B', 'Two', BASE + 5),
      track('C', 'Three', BASE + 100_000)];
    const e = payload(tracks, [
      { i: 0, sec: BASE }, { i: 1, sec: BASE + 5 }, { i: 2, sec: BASE + 100_000 },
    ]);
    const windows: number[][] = [];
    await resolveExportedRepeats(e, async (from, to) => {
      windows.push([from, to]);
      return { plays: [], complete: true };
    });
    check('two windows', windows.length === 2, windows);
    check('the near pair is one window', windows[0][0] === BASE - 1
      && windows[0][1] === BASE + 6, windows[0]);
  }

  console.log('\n-- lookups are capped, and the remainder is left alone --');
  {
    const tracks: any[] = [];
    const repeats: { i: number; sec: number }[] = [];
    for (let i = 0; i < MAX_REPEAT_LOOKUPS + 3; i += 1) {
      tracks.push(track('A', `T${i}`, BASE + i * 100_000));
      repeats.push({ i, sec: BASE + i * 100_000 });
    }
    const e = payload(tracks, repeats);
    let calls = 0;
    const r = await resolveExportedRepeats(e, async () => {
      calls += 1;
      return { plays: [], complete: true };
    });
    check('capped', calls === MAX_REPEAT_LOOKUPS, calls);
    check('the rest stay pinned', r.unresolved === 3, r);
    check('the rest keep their timestamps',
      e.state.tracks[MAX_REPEAT_LOOKUPS].reTagged === false, e.state.tracks[MAX_REPEAT_LOOKUPS]);
  }

  console.log('\n-- the budget stops the walk, and what it did not reach stays pinned --');
  {
    /*
      This runs while the export claim is held, and the claim is what makes the
      snapshot true. Overrunning it means the queue can move on underneath the
      answers being collected. A budget that expires leaves the remaining
      entries exactly as an older client would have had them.
    */
    const tracks: any[] = [];
    const repeats: { i: number; sec: number }[] = [];
    for (let i = 0; i < 4; i += 1) {
      tracks.push(track('A', `T${i}`, BASE + i * 100_000));
      repeats.push({ i, sec: BASE + i * 100_000 });
    }
    const e = payload(tracks, repeats);
    let calls = 0;
    const r = await resolveExportedRepeats(e, async () => {
      calls += 1;
      // Spend the whole budget inside the first window.
      const until = Date.now() + 30;
      while (Date.now() < until) { /* burn */ }
      return { plays: [], complete: true };
    }, 20);
    check('stopped after the first window', calls === 1, calls);
    check('the rest are unresolved, not concluded', r.unresolved === 3 && r.freed === 1, r);
    check('and keep their pinned seconds',
      e.state.tracks[3].reTagged === false
        && e.state.tracks[3].timestamp === (BASE + 3 * 100_000) * 1000,
      e.state.tracks[3]);
  }

  console.log('\n-- a malformed or absent list does nothing --');
  {
    const e = payload([track('A', 'One', BASE)], []);
    let called = false;
    const r = await resolveExportedRepeats(e, async () => {
      called = true;
      return { plays: [], complete: true };
    });
    check('no lookup', !called && r.settled === 0 && r.freed === 0, r);

    const bad = payload([track('A', 'One', BASE)], [{ i: 9, sec: BASE } as any]);
    const r2 = await resolveExportedRepeats(bad, windowOf([]));
    check('out-of-range position ignored', r2.freed === 0 && r2.unresolved === 0, r2);
  }

  if (failures > 0) {
    console.log(`\n${failures} FAILURES`);
    process.exit(1);
  }
  console.log('\nALL PASSED');
}

main();
