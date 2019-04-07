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
      <v-checkbox color="primary" v-model="scrobbleOldPlays" :label="`Scrobble tracks older than 2 weeks (they will show as listened to today)`"></v-checkbox>
      <v-checkbox color="primary" v-model="removeInvalidListens" :label="`Follow last.fm scrobble rules (Recommended: If this is disabled, you could end up scrobbling tracks you didn't listen to)`"></v-checkbox>
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
import Bluebird,{ delay } from 'bluebird';
import Scrobblify from '@/scrobblify';
import SpotifyListen from '@/models/SpotifyListen';
import Scrobble from '@/models/Scrobble';

export default Vue.extend({
  data() {
    return {
      spotifyStreamingHistory: '',
      scrobbleOldPlays: false,
      removeInvalidListens: true,
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
    async smartMoveProgress() {
      // Without adding a delay every so often the page never renders and hangs
      this.stepProgress += 1;
      if (this.stepProgress % 100 === 0) {
        await delay(100);
      }
    },
    async parseSpotifyData() {
      // Parse & clean the data from the user
      const reTagDate = new Date();
      const parsedData: SpotifyListen[] = this.scrobblify.spotifyJsonToListens(this.spotifyStreamingHistory);
      this.logs.push(`Found ${parsedData.length} plays in your spotify listening history.`);

      let newData: SpotifyListen[] = [];
      if (this.scrobbleOldPlays) {
        newData = this.scrobblify.reTagOldListens(parsedData, reTagDate);
        this.logs.push(`No tracks removed - old listens have been moved to today (${reTagDate.toDateString()})`);
      } else {
        newData = this.scrobblify.removeOldListens(parsedData, this.scrobbleOldPlays);
        this.logs.push(`Found ${newData.length} tracks that were listened to in the last two weeks`);
      }

      this.stepProgress = 0;
      this.stepTotal = newData.length;
      this.logs.push(`Replaying the listens to find plays that are valid scrobbles...`);
      if (this.removeInvalidListens) {
        this.logs.push(`(Not Recommended) If you're impatient, this can be sped up by unchecking the "Follow last.fm rules" box.`);

        if (this.scrobbleOldPlays) {
          const EXPECTED_MS_PER_REQUEST = 150;
          const expectedTime = newData.length * EXPECTED_MS_PER_REQUEST / 60000;
          this.logs.push(`While we don't recommend this, it could save you approx. ${expectedTime} minutes`);
        }
      }

      await delay(500);

      let validData: SpotifyListen[] = [];
      try {
        validData = await this.scrobblify.removeInvalidListens(newData, this.smartMoveProgress, !this.removeInvalidListens);
      } catch (e) {
        this.logs.push(`Looks like we encountered an error. Please send an email to niko@savas.ca with your`);
        this.logs.push(`last.fm username and StreamingHistory.json and I'll take care of it as soon as possibele!`);
        return;
      }
      this.logs.push(`Found ${validData.length} valid scrobbles`);

      // Scrobble each of the songs
      this.stepProgress = 0;
      this.stepTotal = validData.length;
      this.logs.push(`Checking for songs that have already been scrobbled.`);
      let skippedFromError = 0;
      const toBeScrobbled = await Bluebird.filter(validData, async (listen) => {
        const scrobble = new Scrobble(listen.trackName, listen.artistName, listen.listenDate);
        try {
          let isAlreadyScrobbled: boolean = false;
          if (scrobble.timestamp.getTime() !== reTagDate.getTime()) {
            isAlreadyScrobbled = await this.scrobblify.isAlreadyScrobbled(scrobble);
          }
          await this.smartMoveProgress();

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
