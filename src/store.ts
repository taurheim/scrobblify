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
  },
  mutations: {
    setValidScrobbles(state: any, tracks: SpotifyListen[]) {
      Vue.set(state, 'validScrobbles', tracks);
    },
    setSelectedScrobbles(state: any, tracks: Scrobble[]) {
      Vue.set(state, 'selectedScrobbles', tracks);
    },
    trackScrobbled(state: any) {
      state.tracksScrobbled += 1;
    },
    trackFailed(state: any) {
      state.tracksFailed += 1;
    }
  },
  actions: {
  },
});
