import { createStore } from 'vuex';
import LastFm from '@/api/LastFm';
import SpotifyListen from '@/models/SpotifyListen';
import Scrobble from '@/models/Scrobble';

export interface RootState {
  lfmApi: LastFm;
  validScrobbles: SpotifyListen[];
  selectedScrobbles: Scrobble[];
  tracksScrobbled: number;
  tracksFailed: number;
  resumedScrobbleCount: number;
  originalTotalTracks: number;
  reTagCursorSec: number;
  scrobbleRunActive: boolean;
}

export default createStore<RootState>({
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
    // True while the scrobble loop is sending (or waiting to resume by itself).
    // Reloading then would drop everything since the last checkpoint, so the
    // "new version available" banner stays hidden until the run stops.
    scrobbleRunActive: false,
  },
  mutations: {
    setValidScrobbles(state, tracks: SpotifyListen[]) {
      state.validScrobbles = tracks;
    },
    setSelectedScrobbles(state, tracks: Scrobble[]) {
      state.selectedScrobbles = tracks;
    },
    setResumedScrobbleCount(state, count: number) {
      state.resumedScrobbleCount = count;
    },
    setOriginalTotalTracks(state, count: number) {
      state.originalTotalTracks = count;
    },
    setReTagCursorSec(state, seconds: number) {
      state.reTagCursorSec = seconds;
    },
    setScrobbleRunActive(state, active: boolean) {
      state.scrobbleRunActive = active;
    },
    trackScrobbled(state) {
      state.tracksScrobbled += 1;
    },
    trackFailed(state) {
      state.tracksFailed += 1;
    },
  },
  actions: {
  },
});
