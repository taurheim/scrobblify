<template>
  <div class="scrobblify-complete">
    <h1>Finished scrobbling.</h1>
    We scrobbled {{ this.$store.state.tracksScrobbled }} tracks ({{ this.$store.state.tracksFailed }} failed).<br>
    If a significant number of scrobbles failed, please let me know at niko@savas.ca.
    <br><br>
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

