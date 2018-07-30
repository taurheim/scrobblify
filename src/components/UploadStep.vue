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
      <h2>Paste the contents of StreamingHistory.json here:</h2>
      <textarea v-model="spotifyStreamingHistory" placeholder="File contents go here">
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
  border: 1px solid #ed1c24;
  width: 100%;
}

.logs {
  text-align: left;
  flex-wrap: wrap;
}
</style>
<script lang="ts">
import Vue from 'vue';
import Bluebird from 'bluebird';
import Scrobblify from '@/scrobblify';
import SpotifyListen from '@/models/SpotifyListen';
import Scrobble from '@/models/Scrobble';

export default Vue.extend({
  data() {
    return {
      spotifyStreamingHistory: '',
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
      let failedValidCheckCount = 0;
      let validData: SpotifyListen[] = [];
      try {
        validData = await this.scrobblify.removeInvalidListens(newData, () => {
          this.stepProgress += 1;
        });
      } catch (e) {
        failedValidCheckCount += 1;
      }
      this.logs.push(`Found ${validData.length} valid scrobbles (${failedValidCheckCount} failed)`);

      // Scrobble each of the songs
      this.stepProgress = 0;
      this.stepTotal = validData.length;
      this.logs.push(`Checking for songs that have already been scrobbled.`);
      let skippedFromError = 0;
      const toBeScrobbled = await Bluebird.filter(validData, async (listen) => {
        const scrobble = new Scrobble(listen.trackName, listen.artistName, listen.time);
        try {
          const isAlreadyScrobbled: boolean = await this.scrobblify.isAlreadyScrobbled(scrobble);
          this.stepProgress += 1;

          return !isAlreadyScrobbled;
        } catch (e) {
          skippedFromError += 1;
          return false;
        }
      }, {
        concurrency: 1,
      });
      this.logs.push(`Found ${toBeScrobbled.length} songs that haven't been scrobbled yet`);
      if (skippedFromError > 0) {
        this.logs.push(`${skippedFromError} tracks skipped due to errors.
        If this number is really high, let me know at niko@savas.ca`);
      }
      this.logs.push(`Ready to scrobble ${toBeScrobbled.length} tracks.`);
      this.readyToScrobble = true;
      this.$store.commit('setValidScrobbles', toBeScrobbled);
    },
  },
});
</script>
