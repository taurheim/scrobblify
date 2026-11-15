<template>
  <div class="scrobblify-complete">
    <h1>Finished scrobbling.</h1>
    We scrobbled {{ this.$store.state.tracksScrobbled }} tracks ({{ this.$store.state.tracksFailed }} failed).<br>
    <div v-if="unconfirmed > 0" class="mt-2">
      {{ unconfirmed }} more were sent, but your Last.fm library couldn't be read to confirm them,
      so they aren't counted.
    </div>
    <div v-if="hasRemaining" class="mt-4">
      <v-alert type="warning" prominent>
        <strong>Some tracks haven't been scrobbled yet.</strong><br>
        Your progress has been saved automatically. You can come back later to scrobble the remaining tracks.
        A backup file has also been downloaded — you can use it to resume on any computer.
        <br><br>
        <strong>Tips:</strong>
        <ul>
          <li>Last.fm keeps at most 750 scrobbles a day (midnight to midnight UTC), your own listening included</li>
          <li>If you were rate limited, wait at least 10 minutes</li>
          <li>Use the same browser on this computer to auto-resume, or use the downloaded file on another device</li>
        </ul>
      </v-alert>
    </div>
    <div v-else>
      <div v-if="this.$store.state.tracksFailed > 0" class="mt-2">
        Some scrobbles failed. This can happen due to temporary Last.fm issues.
        You may want to try again later for those tracks.
      </div>
    </div>
    <br>
    <h1>Now go make pretty things!</h1>
    <img src="../assets/lastwave_example.png" alt="Example LastWave graph of recent listening history"><br>
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
    unconfirmed(): number {
      return this.$store.state.pendingVerification.length;
    },
    userName(): string {
      return this.$store.state.lfmApi.userName;
    },
    lastwaveUrl(): string {
      const url = 'https://savas.ca/lastwave';
      return url;
    },
  },
});
</script>
