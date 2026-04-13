<template>
  <div class="scrobblify-complete">
    <h1>Finished scrobbling.</h1>
    We scrobbled {{ this.$store.state.tracksScrobbled }} tracks ({{ this.$store.state.tracksFailed }} failed).<br>
    <div v-if="hasRemaining" class="mt-4">
      <v-alert type="warning" prominent>
        <strong>Some tracks couldn't be scrobbled due to rate limits.</strong><br>
        Your progress has been saved automatically. You can come back later to scrobble the remaining tracks.
        A backup file has also been downloaded — you can use it to resume on any computer.
        <br><br>
        <strong>Tips:</strong>
        <ul>
          <li>If you hit the daily limit (~2,800), come back tomorrow</li>
          <li>If you hit the burst limit (~1,000), wait at least 10 minutes</li>
          <li>Use the same browser on this computer to auto-resume, or use the downloaded file on another device</li>
        </ul>
      </v-alert>
    </div>
    <div v-else>
      <div v-if="this.$store.state.tracksFailed > 0" class="mt-2">
        Some scrobbles failed. This can happen due to temporary Last.fm issues. You may want to try again later for those tracks.
      </div>
    </div>
    <br>
    <h1>Now go make pretty things!</h1>
    <img src="../assets/lastwave_example.png"><br>
    Now that you have some listening history, you should make yourself a wave graph for your last two weeks.
    <br><br>
    <h2><a :href="lastwaveUrl" target="_blank">Make me a LastWave!</a></h2>
  </div>
</template>
<style>
.scrobblify-complete img {
  max-width: 800px;
  width: 100%;
}
</style>
<script lang="ts">
import Vue from 'vue';
import LastFm from '@/api/LastFm';
export default Vue.extend({
  props: {
    hasRemaining: {
      type: Boolean,
      default: false,
    },
  },
  computed: {
    userName(): string {
      return this.$store.state.lfmApi.userName;
    },
    lastwaveUrl(): string {
      const url = `https://savas.ca/lastwave#/?customrange=Last%202%20weeks&username=${this.userName}`;
      return url;
    },
  },
});
</script>

