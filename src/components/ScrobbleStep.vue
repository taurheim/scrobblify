<template>
  <div>
    <div v-if="!scrobbling">
      These are the tracks that will be scrobbled. Please review them and then click Scrobble to begin scrobbling.
      <div class="final-list">
        <span v-for="(track, i) in tracksToScrobble" :key="i">
          {{ track.track }} - {{ track.artist }} @ {{ track.timestamp.toString() }}<br>
        </span>
      </div>
      <v-btn class="primary" @click="scrobble">Scrobble</v-btn>
    </div>
    <div v-else>
      Scrobbling...
      <b>{{ currentTrackName }}</b>
      <v-progress-linear v-model="progress">
      </v-progress-linear>
    </div>
  </div>
</template>
<style>
.final-list {
  text-align:left;
  margin-top: 20px;
}
</style>
<script lang="ts">
import Vue from 'vue';
import Scrobble from '@/models/Scrobble';
import Bluebird from 'bluebird';
import LastFm from '@/api/LastFm';

export default Vue.extend({
  data() {
    return {
      scrobbling: false,
      currentTrackName: '',
      scrobbledTracks: 0,
    };
  },
  computed: {
    tracksToScrobble(): Scrobble[] {
      return this.$store.state.selectedScrobbles;
    },
    progress(): number {
      return 100 * this.scrobbledTracks / this.tracksToScrobble.length;
    },
  },
  methods: {
    async scrobble() {
      this.scrobbling = true;
      const api = this.$store.state.lfmApi as LastFm;
      await Bluebird.map(this.tracksToScrobble, async (track: Scrobble) => {
        this.currentTrackName = track.toString();
        try {
          await api.scrobblePlay(track);
          this.$store.commit('trackScrobbled');
        } catch(e) {
          this.$store.commit('trackFailed');
        }
        this.scrobbledTracks += 1;
      }, {
        concurrency: 1,
      });

      this.$emit('complete');
    },
  },
});
</script>

