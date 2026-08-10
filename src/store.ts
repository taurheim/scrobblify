import Vue from 'vue';
import Vuex from 'vuex';
import LastFm from '@/api/LastFm';
import SpotifyListen from '@/models/SpotifyListen';
import Scrobble from '@/models/Scrobble';

Vue.use(Vuex);

export default new Vuex.Store({
  state: {
    // Yeah it's a singleton, come at me bro
    lfmApi: new LastFm('2bf354b70b4a9a8a4420b2c48333d23e', '440dad9dd54b0e2081b272513401e8df'),
    validScrobbles: [],
    selectedScrobbles: [],
    tracksScrobbled: 0,
    tracksFailed: 0,
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
    carriedFailures: [] as Array<{
      artist: string; track: string; album?: string; reason: string;
    }>,
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
  },
  mutations: {
    setValidScrobbles(state: any, tracks: SpotifyListen[]) {
      Vue.set(state, 'validScrobbles', tracks);
    },
    setSelectedScrobbles(state: any, tracks: Scrobble[]) {
      Vue.set(state, 'selectedScrobbles', tracks);
    },
    setResumedScrobbleCount(state: any, count: number) {
      state.resumedScrobbleCount = count;
    },
    setCarriedFailures(state: any, failures: any[]) {
      Vue.set(state, 'carriedFailures', Array.isArray(failures) ? failures : []);
    },
    setOriginalTotalTracks(state: any, count: number) {
      state.originalTotalTracks = count;
    },
    setReTagCursorSec(state: any, seconds: number) {
      state.reTagCursorSec = seconds;
    },
    setReTagReservedRange(state: any, range: { floorSec: number; ceilingSec: number }) {
      state.reTagFloorSec = range.floorSec;
      state.reTagCeilingSec = range.ceilingSec;
    },
    setReTagBlocked(state: any, blockedUntilSec: number) {
      state.reTagBlockedUntilSec = blockedUntilSec;
    },
    setPendingReTagSec(state: any, seconds: number) {
      state.pendingReTagSec = seconds;
    },
    setImportId(state: any, id: string) {
      state.importId = id;
    },
    trackScrobbled(state: any) {
      state.tracksScrobbled += 1;
    },
    trackFailed(state: any) {
      state.tracksFailed += 1;
    },
  },
  actions: {
  },
});
