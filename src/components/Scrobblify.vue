<template>
  <div class="scrobblify">
    <textarea v-model="spotifyStreamingHistory">
    </textarea>
    <br>
    <button @click="scrobbleData">
      Submit
    </button>
  </div>
</template>
<style>
.scrobblify textarea {
  height: 500px;
  width: 1000px;
}
</style>
<script lang="ts">
import Vue from 'vue';
import SpotifyListen from '@/models/SpotifyListen';
import Scrobble from '@/models/Scrobble';
import LastFmApi from '@/api/LastFm';
import Bluebird from 'bluebird';

export default Vue.extend({
  data() {
    return {
      lfmApi: new LastFmApi('27ca6b1a0750cf3fb3e1f0ec5b432b72'),
      spotifyStreamingHistory: 'Put your history here',
    };
  },
  methods: {
    async scrobbleData() {
      const parsedData: SpotifyListen[] = JSON.parse(this.spotifyStreamingHistory);
      await Bluebird.each(parsedData, async (listen) => {
        const listenDate = new Date(`${listen.time} UTC`);
        const scrobble = new Scrobble(listen.artistName, listen.trackName, listenDate);

        const isAlreadyScrobbled: boolean = await this.lfmApi.checkForConflict(scrobble);

        if (!isAlreadyScrobbled) {
          this.lfmApi.postScrobble(scrobble);
        }
      });
    },
  },
});
</script>

