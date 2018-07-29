<template>
  <div class="scrobblify">
  <textarea v-model="spotifyStreamingHistory">
    </textarea>
    <br>
    <button @click="parseSpotifyData">
      Submit
    </button>
    <hr>
    Duplicates:
    <div v-for="(track, i) in duplicatesFound" :key="`duplicate${i}`">
      {{ track }}
    </div>
    <hr>
    New tracks:
    <div v-for="(track, i) in toBeScrobbled" :key="`new${i}`">
      {{ track }}
    </div>
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
import Bluebird from 'bluebird';
import Scrobblify from '@/scrobblify';

export default Vue.extend({
  data() {
    return {
      scrobblify: new Scrobblify(),
      spotifyStreamingHistory: JSON.stringify([{
        artistName : 'Everett Bird, Everett Morris, Everett Morris',
        trackName : 'Lizard',
        time : '2018-06-23 16:45:27',
      }]),
      toBeScrobbled: [] as Scrobble[],
      duplicatesFound: [] as Scrobble[],
    };
  },
  methods: {
    async parseSpotifyData() {
      const parsedData: SpotifyListen[] = this.scrobblify.spotifyJsonToListens(this.spotifyStreamingHistory);
      const newData = this.scrobblify.removeOldListens(parsedData);
      const validData: SpotifyListen[] = await this.scrobblify.removeInvalidListens(newData);

      await Bluebird.each(validData, async (listen) => {
        const scrobble = new Scrobble(listen.artistName, listen.trackName, listen.time);

        const isAlreadyScrobbled: boolean = await this.scrobblify.isAlreadyScrobbled(scrobble);

        if (!isAlreadyScrobbled) {
          this.toBeScrobbled.push(scrobble);
        } else {
          this.duplicatesFound.push(scrobble);
        }
      });
    },
  },
});
</script>

