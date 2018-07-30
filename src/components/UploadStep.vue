<template>
  <div class="upload-step">
    <div v-if="logs.length > 0" class="logs">
      <pre>
        <template v-for="log in logs">
          {{ log }}</template>
      </pre>
      <v-progress-linear v-if="!readyToScrobble" v-model="progress">
      </v-progress-linear>
      <v-btn class="primary" @click="finishStep" v-if="readyToScrobble">Choose which tracks to scrobble</v-btn>
    </div>
    <div v-else>
      <textarea v-model="spotifyStreamingHistory">
      </textarea>
      <br>
      <v-btn color="primary" @click="parseSpotifyData">
        Find tracks
      </v-btn>
    </div>
  </div>
</template>
<style>
.upload-step textarea {
  height: 500px;
  width: 1000px;
}

.logs {
  text-align: left;
}
</style>
<script lang="ts">
import Vue from 'vue';
import Bluebird from 'bluebird';
import Scrobblify from '@/scrobblify';
import SpotifyListen from '@/models/SpotifyListen';
import Scrobble from '@/models/Scrobble';
import StreamingHistory from '@/assets/StreamingHistory.json';

export default Vue.extend({
  data() {
    return {
      spotifyStreamingHistory: JSON.stringify(StreamingHistory),
      scrobblify: new Scrobblify(this.$store.state.lfmApi),
      logs: [] as string[],
      stepProgress: 0,
      stepTotal: 1,
      readyToScrobble: false,
    };
  },
  computed: {
    progress(): number {
      return 100 * this.stepProgress / this.stepTotal;
    },
  },
  methods: {
    finishStep() {
      this.$emit('complete');
    },
    async parseSpotifyData() {
      // Parse & clean the data from the user
      const parsedData: SpotifyListen[] = this.scrobblify.spotifyJsonToListens(this.spotifyStreamingHistory);
      this.logs.push(`Found ${parsedData.length} plays in your spotify listening history.`);
      const newData = this.scrobblify.removeOldListens(parsedData);
      this.logs.push(`Found ${newData.length} tracks that were listened to in the last two weeks`);

      this.stepProgress = 0;
      this.stepTotal = newData.length;
      this.logs.push(`Replaying the listens to find plays that are valid scrobbles...`);
      const validData: SpotifyListen[] = await this.scrobblify.removeInvalidListens(newData, () => {
        this.stepProgress += 1;
      });
      this.logs.push(`Found ${validData.length} valid scrobbles`);

      // Scrobble each of the songs
      this.stepProgress = 0;
      this.stepTotal = validData.length;
      this.logs.push(`Checking for songs that have already been scrobbled.`);
      const toBeScrobbled = await Bluebird.filter(validData, async (listen) => {
        const scrobble = new Scrobble(listen.trackName, listen.artistName, listen.time);
        const isAlreadyScrobbled: boolean = await this.scrobblify.isAlreadyScrobbled(scrobble);
        this.stepProgress += 1;

        return !isAlreadyScrobbled;
      });
      this.logs.push(`Found ${toBeScrobbled.length} songs that haven't been scrobbled yet`);
      this.logs.push(`Ready to scrobble ${toBeScrobbled.length} tracks.`);
      this.readyToScrobble = true;
      this.$store.commit('setValidScrobbles', toBeScrobbled);
    },
  },
});
</script>
