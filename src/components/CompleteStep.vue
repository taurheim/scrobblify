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
        Some scrobbles failed. This can happen due to temporary Last.fm issues.
        You may want to try again later for those tracks.
      </div>
    </div>
    <!--
      Tracks a background job rejected. They are not in the queue and no index
      describes them, so this is the last screen that can name them at all.
    -->
    <v-expansion-panels v-if="carriedFailures.length > 0" class="mt-4">
      <v-expansion-panel>
        <v-expansion-panel-header>
          {{ carriedFailures.length }} track(s) were rejected while scrobbling in the background
        </v-expansion-panel-header>
        <v-expansion-panel-content>
          <div v-for="(item, i) in carriedFailures" :key="i" class="mb-1">
            <strong>{{ item.artist ? `${item.track} - ${item.artist}` : item.track }}</strong>
            — {{ item.reason }}
          </div>
          <div v-if="carriedFailuresDropped > 0" class="mt-2">
            …and {{ carriedFailuresDropped }} more that couldn't be listed here.
          </div>
        </v-expansion-panel-content>
      </v-expansion-panel>
    </v-expansion-panels>
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
    userName(): string {
      return this.$store.state.lfmApi.userName;
    },
    /**
     * Failures reported by a background job this queue passed through.
     *
     * The tracks they name were removed from the queue on export, so nothing
     * else on this screen can describe them and no later screen exists.
     */
    carriedFailures(): Array<{ artist: string; track: string; reason: string }> {
      return this.$store.state.carriedFailures || [];
    },
    carriedFailuresDropped(): number {
      return this.$store.state.carriedFailuresDropped || 0;
    },
    lastwaveUrl(): string {
      const url = 'https://savas.ca/lastwave';
      return url;
    },
  },
});
</script>
