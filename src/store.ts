import Vue from 'vue';
import Vuex from 'vuex';
import LastFm from '@/api/LastFm';
import SpotifyListen from '@/models/SpotifyListen';
import Scrobble, { PendingScrobble } from '@/models/Scrobble';

Vue.use(Vuex);

export default new Vuex.Store({
  state: {
    // Yeah it's a singleton, come at me bro
    lfmApi: new LastFm('2bf354b70b4a9a8a4420b2c48333d23e', '440dad9dd54b0e2081b272513401e8df'),
    validScrobbles: [],
    selectedScrobbles: [],
    // Plays confirmed as stored in the user's Last.fm library, and plays given
    // up on. A play Last.fm merely *accepted* is in neither: see DailyCap.ts.
    tracksScrobbled: 0,
    tracksFailed: 0,
    // Sent but not yet confirmed. Carries a restored session's unchecked plays
    // into the scrobble step, and what was still unchecked at completion out.
    pendingVerification: [] as PendingScrobble[],
    // Number of tracks already scrobbled in a previously saved session that is
    // being resumed. `selectedScrobbles` only ever holds the *remaining* tracks,
    // so this is the only way the scrobble step can tell a resume from a fresh
    // start (without it, `scrobble_resumed` could never fire).
    resumedScrobbleCount: 0,
    // Size of the user's original selection. Unlike `selectedScrobbles.length`
    // this does NOT shrink on resume, so it is the only stable denominator for
    // "how much of my import is done" — both in the UI and in analytics.
    originalTotalTracks: 0,
    // High-water mark of the re-tagged-play timestamp allocator, carried across
    // a resume so a later run cannot reuse seconds an earlier one already sent.
    reTagCursorSec: 0,
    // True while the scrobble loop is sending (or waiting to resume by itself).
    // Reloading then would drop everything since the last checkpoint, so the
    // "new version available" banner stays hidden until the run stops.
    scrobbleRunActive: false,
  },
  mutations: {
    setValidScrobbles(state: any, tracks: SpotifyListen[]) {
      Vue.set(state, 'validScrobbles', tracks);
    },
    setSelectedScrobbles(state: any, tracks: Scrobble[]) {
      Vue.set(state, 'selectedScrobbles', tracks);
    },
    // A play Last.fm accepted but did not keep goes back on the end of the
    // queue. Everything before it stays index-addressed, so saving and resuming
    // need no other changes.
    requeueScrobble(state: { selectedScrobbles: Scrobble[] }, scrobble: Scrobble) {
      state.selectedScrobbles.push(scrobble);
    },
    setPendingVerification(state: { pendingVerification: PendingScrobble[] }, pending: PendingScrobble[]) {
      Vue.set(state, 'pendingVerification', pending);
    },
    setResumedScrobbleCount(state: any, count: number) {
      state.resumedScrobbleCount = count;
    },
    setOriginalTotalTracks(state: any, count: number) {
      state.originalTotalTracks = count;
    },
    setReTagCursorSec(state: any, seconds: number) {
      state.reTagCursorSec = seconds;
    },
    setScrobbleRunActive(state: any, active: boolean) {
      state.scrobbleRunActive = active;
    },
    trackScrobbled(state: { tracksScrobbled: number }, count = 1) {
      state.tracksScrobbled += count;
    },
    trackFailed(state: any) {
      state.tracksFailed += 1;
    },
  },
  actions: {
  },
});
