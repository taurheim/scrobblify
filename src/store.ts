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
    // Size of the user's original selection. Unlike `selectedScrobbles.length`
    // this does NOT shrink on resume, so it is the only stable denominator for
    // "how much of my import is done" — both in the UI and in analytics.
    originalTotalTracks: 0,
    // High-water mark of the re-tagged-play timestamp allocator, carried across
    // a resume so a later run cannot reuse seconds an earlier one already sent.
    reTagCursorSec: 0,
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
    setOriginalTotalTracks(state: any, count: number) {
      state.originalTotalTracks = count;
    },
    setReTagCursorSec(state: any, seconds: number) {
      state.reTagCursorSec = seconds;
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
