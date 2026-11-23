import { createStore } from 'vuex';
import LastFm from '@/api/LastFm';
import SpotifyListen from '@/models/SpotifyListen';
import Scrobble, { PendingScrobble } from '@/models/Scrobble';
import type { JobStatus } from '@/services/BackgroundScrobbling';

export interface CarriedFailure {
  artist: string;
  track: string;
  album?: string;
  reason: string;
}

/**
 * What /scrobble hands Home as a shown server job sends it there: the job as
 * fetched at `atMs`, so Home needn't ask again with a shorter budget and
 * disagree, and a notice to show beside the status card.
 */
export interface StatusHandover {
  job: JobStatus;
  atMs: number;
  notice: string;
}

export interface RootState {
  lfmApi: LastFm;
  validScrobbles: SpotifyListen[];
  selectedScrobbles: Scrobble[];
  tracksScrobbled: number;
  tracksFailed: number;
  pendingVerification: PendingScrobble[];
  resumedScrobbleCount: number;
  carriedFailures: CarriedFailure[];
  carriedFailuresDropped: number;
  originalTotalTracks: number;
  reTagCursorSec: number;
  reTagFloorSec: number;
  reTagCeilingSec: number;
  reTagBlockedUntilSec: number;
  pendingReTagSec: number;
  importId: string;
  scrobbleRunActive: boolean;
  showingServerJob: boolean;
  statusHandover: StatusHandover | null;
  deferredDuplicateCheck: boolean;
}

export default createStore<RootState>({
  state: {
    // Yeah it's a singleton, come at me bro
    lfmApi: new LastFm('2bf354b70b4a9a8a4420b2c48333d23e', '440dad9dd54b0e2081b272513401e8df'),
    validScrobbles: [],
    selectedScrobbles: [],
    // Plays confirmed as stored in the user's Last.fm library, and plays given
    // up on. A play Last.fm merely *accepted* is in neither: see shared/lastfm/dailyCap.ts.
    tracksScrobbled: 0,
    tracksFailed: 0,
    // Sent but not yet confirmed. Carries a restored session's unchecked plays
    // into the scrobble step, and what was still unchecked at completion out.
    pendingVerification: [],
    // Number of tracks already scrobbled in a previously saved session that is
    // being resumed. `selectedScrobbles` only ever holds the *remaining* tracks,
    // so this is the only way the scrobble step can tell a resume from a fresh
    // start (without it, `scrobble_resumed` could never fire).
    resumedScrobbleCount: 0,
    /*
      Tracks a previous owner of this queue wrote off permanently, carried so
      the scrobble step can still name them.

      The background worker removes its failures from the queue it hands back,
      so nothing in `selectedScrobbles` describes them. Without this the user
      is told a count before take-back and nothing afterwards — and a track
      they cannot name is a track they cannot re-add.
    */
    carriedFailures: [],
    /*
      How many named failures could not be kept. Shown alongside the list so an
      incomplete list is visibly incomplete: a user reading five names when
      twelve tracks were rejected would otherwise re-add five and believe they
      were done.
    */
    carriedFailuresDropped: 0,
    // Size of the user's original selection. Unlike `selectedScrobbles.length`
    // this does NOT shrink on resume, so it is the only stable denominator for
    // "how much of my import is done" — both in the UI and in analytics.
    originalTotalTracks: 0,
    // High-water mark of the re-tagged-play timestamp allocator, carried across
    // a resume so a later run cannot reuse seconds an earlier one already sent.
    reTagCursorSec: 0,
    /*
      A re-tag range reserved below a background job's own allocations, set only
      when resuming work handed back by the server. The server allocates
      synthetic seconds downwards from the present while this browser allocates
      upwards, so without a reserved range the two would overlap — and Last.fm
      discards a repeat of (artist, track, timestamp) silently, reporting it as
      accepted. Zero means "no reservation, use the usual six-hour window".
    */
    reTagFloorSec: 0,
    reTagCeilingSec: 0,
    /*
      Second after which re-tagging is safe again, or 0 when it always was.

      Set when a take-back could not establish *any* safe interval — the job's
      assigned timestamps were unreadable, so the seconds it consumed could be
      anywhere. A reservation of zero is indistinguishable from "no handoff
      happened", which sends the allocator back to its usual six-hour window,
      and that window is exactly where those unknown seconds are most likely to
      be. So the impossibility is carried explicitly instead.

      A second rather than a boolean because the condition really does end. The
      unknown seconds are all in the past, so once Last.fm's thirteen-day
      window has slid entirely past them nothing can collide with them any
      more. A boolean would have blocked those tracks forever.
    */
    reTagBlockedUntilSec: 0,
    /*
      Synthetic second already handed to Last.fm for the track at the head of
      the queue, when its outcome is not yet known. 0 when nothing is pending.

      A re-tagged send that reaches Last.fm but loses its response has to be
      retried with the *identical* (artist, track, timestamp) tuple: an
      identical resend is deduplicated, whereas a fresh second is stored as a
      second, phantom play the user never listened to. The loop already keeps
      this across retries in memory — but a halt can persist and hand the queue
      away between the send and its outcome, and then the memory is gone. So it
      travels with the saved state.
    */
    pendingReTagSec: 0,
    /*
      Stable identity for *this queue of tracks*, minted when the user selects
      them and carried through every save, export and handoff.

      Two questions need it and neither can be answered without it. The first
      is whether the background service was ever given this import: asking
      "does this user have something running?" is a different question, and a
      job that finished — or stalled on re-auth — answers no while its tracks
      remain in this browser's queue, so the browser replays them and Last.fm
      discards every one of them silently. The second is whether two tabs are
      looking at the same import at all, which is what makes a
      furthest-progress comparison between their saves meaningful.
    */
    importId: '',
    // True while the scrobble loop is sending (or waiting to resume by itself).
    // Reloading then would drop everything since the last checkpoint, so the
    // "new version available" banner stays hidden until the run stops.
    scrobbleRunActive: false,
    // True while a page is showing this user's background job, so the header
    // shows the BETA tag even without the opt-in or flag.
    showingServerJob: false,
    // Left by /scrobble as it sends the user to Home's status page; Home takes it.
    statusHandover: null,
    // True when "Check for duplicates" was ticked while signed out, so the
    // check runs on the chosen queue after sign-in instead.
    deferredDuplicateCheck: false,
  },
  mutations: {
    setValidScrobbles(state, tracks: SpotifyListen[]) {
      state.validScrobbles = tracks;
    },
    setSelectedScrobbles(state, tracks: Scrobble[]) {
      state.selectedScrobbles = tracks;
    },
    // A play Last.fm accepted but did not keep goes back on the end of the
    // queue. Everything before it stays index-addressed, so saving and resuming
    // need no other changes.
    requeueScrobble(state, scrobble: Scrobble) {
      state.selectedScrobbles.push(scrobble);
    },
    setPendingVerification(state, pending: PendingScrobble[]) {
      state.pendingVerification = pending;
    },
    setResumedScrobbleCount(state, count: number) {
      state.resumedScrobbleCount = count;
    },
    setCarriedFailures(state, failures: CarriedFailure[]) {
      state.carriedFailures = Array.isArray(failures) ? failures : [];
    },
    setCarriedFailuresDropped(state, dropped: number) {
      state.carriedFailuresDropped = Number.isFinite(dropped) && dropped > 0
        ? Math.floor(dropped)
        : 0;
    },
    setOriginalTotalTracks(state, count: number) {
      state.originalTotalTracks = count;
    },
    setReTagCursorSec(state, seconds: number) {
      state.reTagCursorSec = seconds;
    },
    setReTagReservedRange(state, range: { floorSec: number; ceilingSec: number }) {
      state.reTagFloorSec = range.floorSec;
      state.reTagCeilingSec = range.ceilingSec;
    },
    setReTagBlocked(state, blockedUntilSec: number) {
      state.reTagBlockedUntilSec = blockedUntilSec;
    },
    setPendingReTagSec(state, seconds: number) {
      state.pendingReTagSec = seconds;
    },
    setImportId(state, id: string) {
      state.importId = id;
    },
    setScrobbleRunActive(state, active: boolean) {
      state.scrobbleRunActive = active;
    },
    setShowingServerJob(state, on: boolean) {
      state.showingServerJob = on;
    },
    setStatusHandover(state, handover: StatusHandover | null) {
      state.statusHandover = handover;
    },
    setDeferredDuplicateCheck(state, on: boolean) {
      state.deferredDuplicateCheck = on;
    },
    trackScrobbled(state, count = 1) {
      state.tracksScrobbled += count;
    },
    trackFailed(state) {
      state.tracksFailed += 1;
    },
  },
  actions: {
  },
});
